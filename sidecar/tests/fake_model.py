"""A local OpenAI-compatible endpoint, so a real agent turn can be driven.

A provider of kind ``openai-compatible`` talks ``/chat/completions`` to its
``base_url``, so a socket that speaks that protocol is a model as far as the
runtime is concerned. This one serves a scripted conversation: whatever turns
you hand it, in order — through the real SDK loop, tool dispatch, recorder,
items and API.

The runtime's tool-less side steps (title, compaction, finalize) are recognised
by their instructions and answered without consuming a scripted turn. Streamed
requests get SSE chunks; non-streamed ones (``Runner.run``) a JSON completion
assembled from the same chunks.
"""
from __future__ import annotations

import itertools
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from app.agent.prompt import COMPACT_INSTRUCTIONS, FINALIZE_INSTRUCTIONS, TITLE_INSTRUCTIONS

TITLE_MARKER = TITLE_INSTRUCTIONS[:40]
COMPACT_MARKER = COMPACT_INSTRUCTIONS[:40]
FINALIZE_MARKER = FINALIZE_INSTRUCTIONS[:60]


def _chunk(delta: dict, finish: str | None = None) -> bytes:
    payload = {
        "id": "chatcmpl-fake", "object": "chat.completion.chunk", "created": 0,
        "model": "fake-model",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    return b"data: " + json.dumps(payload).encode() + b"\n\n"


def text_turn(text: str, chunk_size: int = 24) -> list[bytes]:
    """A final answer, streamed in many small deltas.

    Small on purpose: two halves left nothing for ``delay_s`` to spread out, so a
    "slow" model still finished in milliseconds and a cancellation test raced a
    turn that was already over.
    """
    # Bounded chunk COUNT, not just size. Fine granularity matters for a normal
    # answer (it is what `delay_s` spreads out), but a test that streams a
    # deliberately enormous answer would otherwise become 12,500 HTTP chunks and
    # take minutes — measured: it turned a 110 s suite into 13 minutes.
    size = max(chunk_size, -(-len(text) // 200))
    parts = [text[i:i + size] for i in range(0, len(text), size)] or [""]
    return [
        _chunk({"role": "assistant", "content": parts[0]}),
        *[_chunk({"content": p}) for p in parts[1:]],
        _chunk({}, "stop"),
    ]


_CALL_IDS = itertools.count(1)


def tool_turn(name: str, arguments: dict) -> list[bytes]:
    """A single function call. Each scripted call gets its own id: the SDK
    refuses a completed call id reused for a different invocation (v2.2 —
    scripts with several tool turns hit that)."""
    call_id = f"call_fake_{next(_CALL_IDS)}"
    return [
        _chunk({"role": "assistant", "tool_calls": [{
            "index": 0, "id": call_id, "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)},
        }]}),
        _chunk({}, "tool_calls"),
    ]


def raw_tool_turn(name: str, raw_arguments: str) -> list[bytes]:
    """A function call whose arguments are exactly ``raw_arguments`` — a small
    model's invalid JSON, a string where a list belongs."""
    call_id = f"call_fake_{next(_CALL_IDS)}"
    return [
        _chunk({"role": "assistant", "tool_calls": [{
            "index": 0, "id": call_id, "type": "function",
            "function": {"name": name, "arguments": raw_arguments},
        }]}),
        _chunk({}, "tool_calls"),
    ]


def commentary_tool_turn(text: str, name: str, arguments: dict) -> list[bytes]:
    """Commentary the model writes, then a function call, in ONE response."""
    call_id = f"call_fake_{next(_CALL_IDS)}"
    return [
        _chunk({"role": "assistant", "content": text}),
        _chunk({"tool_calls": [{
            "index": 0, "id": call_id, "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)},
        }]}),
        _chunk({}, "tool_calls"),
    ]


def parallel_turn(calls: list[tuple[str, dict]], text: str = "") -> list[bytes]:
    """Several function calls in ONE response (optionally after commentary)."""
    chunks = [_chunk({"role": "assistant", "content": text})] if text else []
    tool_calls = [{"index": i, "id": f"call_fake_{next(_CALL_IDS)}", "type": "function",
                   "function": {"name": n, "arguments": json.dumps(a)}} for i, (n, a) in enumerate(calls)]
    chunks.append(_chunk({"role": "assistant", "tool_calls": tool_calls} if not text else {"tool_calls": tool_calls}))
    chunks.append(_chunk({}, "tool_calls"))
    return chunks


def chat_violations(messages: list[dict]) -> list[str]:
    """What a strict Chat Completions endpoint (OpenAI, strict local chat
    templates) would reject in a request's messages."""
    out: list[str] = []
    pending: set[str] = set()
    prev_role = None
    for n, m in enumerate(messages):
        role = m.get("role")
        if role == "tool":
            if m.get("tool_call_id") not in pending:
                out.append(f"#{n}: tool output {m.get('tool_call_id')} does not answer the preceding tool calls")
            pending.discard(m.get("tool_call_id"))
        else:
            if pending:
                out.append(f"#{n}: {role} message before every tool call was answered: {sorted(pending)}")
                pending = set()
            if role == "assistant" and prev_role == "assistant":
                out.append(f"#{n}: two assistant messages in a row")
            if role == "assistant":
                pending = {tc["id"] for tc in m.get("tool_calls") or []}
        prev_role = role
    if pending:
        out.append(f"end: unanswered tool calls {sorted(pending)}")
    return out


def _assemble(chunks: list[bytes]) -> dict:
    """A non-streamed chat.completion equivalent to a scripted stream."""
    content, calls, finish = "", {}, "stop"
    for c in chunks:
        choice = json.loads(c[len(b"data: "):])["choices"][0]
        d = choice["delta"]
        content += d.get("content") or ""
        for tc in d.get("tool_calls") or []:
            calls[tc["index"]] = {"id": tc["id"], "type": "function", "function": tc["function"]}
        finish = choice.get("finish_reason") or finish
    msg = {"role": "assistant", "content": content or None}
    if calls:
        msg["tool_calls"] = [calls[i] for i in sorted(calls)]
    return {"id": "chatcmpl-fake", "object": "chat.completion", "created": 0, "model": "fake-model",
            "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}


class FakeModel:
    """Serves `turns` one per request; the last one repeats if asked again.

    ``delay_s`` spaces the chunks out. A model that answers instantly leaves no
    window to cancel in, so cancellation could not be tested at all.
    """

    def __init__(self, turns: list[list[bytes]], delay_s: float = 0.0,
                 title: str | None = None, compaction: str | None = None, finalize: str = "Final answer.",
                 fail: list[tuple[int, str]] | None = None, finalize_status: int = 200,
                 show: dict | None = None, fail_at: int = 0):
        self.turns = turns
        # v10: ``fail`` — each entry fails one main request (status, message) before
        # the script resumes; ``finalize_status`` != 200 fails every finalize step;
        # ``show`` is what Ollama's /api/show answers (None: 404).
        self.fail = list(fail or [])
        self.fail_at = fail_at  # failures start once this many scripted turns were served
        self.finalize_status = finalize_status
        self.show = show
        self.show_requests: list[dict] = []
        self.delay_s = delay_s
        # v1.10.0 — the runtime's title step is a separate bounded request
        # marked with TITLE_MARKER. It is answered here without consuming a
        # scripted turn (and without appearing in ``requests``), so every
        # existing script keeps its turn order. ``title`` is what it answers;
        # None answers nothing, which keeps the deterministic seed title.
        self.title = title
        self.title_requests: list[dict] = []
        # v1.12 — the compaction step is another marked, tool-less request.
        self.compaction = compaction
        self.compaction_requests: list[dict] = []
        self.finalize = finalize
        self.finalize_requests: list[dict] = []
        self.requests: list[dict] = []
        self._i = 0
        self._lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):  # keep pytest output readable
                pass

            def _json(self, status: int, payload: dict) -> None:
                out = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            def do_GET(self):  # noqa: N802
                if self.path.rstrip("/").endswith("/models"):
                    return self._json(200, {"object": "list", "data": [{"id": "fake-model", "object": "model"}]})
                return self._json(404, {"error": {"message": "not found"}})

            def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler's contract
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                try:
                    parsed = json.loads(body or b"{}")
                except ValueError:
                    parsed = {}
                text_body = (body or b"").decode("utf-8", "replace")
                if self.path.rstrip("/").endswith("/api/show"):
                    fake.show_requests.append(parsed)
                    return self._json(200, fake.show) if fake.show is not None else \
                        self._json(404, {"error": "model not found"})
                if FINALIZE_MARKER in text_body and fake.finalize_status != 200:
                    fake.finalize_requests.append(parsed)
                    return self._json(fake.finalize_status, {"error": {"message": "finalize failed", "type": "x"}})
                if not any(m in text_body for m in (TITLE_MARKER, COMPACT_MARKER, FINALIZE_MARKER)):
                    with fake._lock:
                        failure = fake.fail.pop(0) if fake.fail and fake._i >= fake.fail_at else None
                    if failure is not None:
                        fake.requests.append(parsed)
                        return self._json(failure[0], {"error": {"message": failure[1], "type": "invalid_request_error",
                                                                 "code": None}})
                if TITLE_MARKER in text_body:
                    fake.title_requests.append(parsed)
                    chunks = text_turn(fake.title or "")
                elif COMPACT_MARKER in text_body:
                    fake.compaction_requests.append(parsed)
                    chunks = text_turn(fake.compaction or "")
                elif FINALIZE_MARKER in text_body:
                    fake.finalize_requests.append(parsed)
                    chunks = text_turn(fake.finalize)
                else:
                    fake.requests.append(parsed)
                    with fake._lock:
                        i = min(fake._i, len(fake.turns) - 1)
                        fake._i += 1
                    chunks = fake.turns[i]
                if not parsed.get("stream"):
                    out = json.dumps(_assemble(chunks)).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(out)))
                    self.end_headers()
                    self.wfile.write(out)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                for c in chunks:
                    try:
                        self.wfile.write(hex(len(c))[2:].encode() + b"\r\n" + c + b"\r\n")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        return  # the client hung up: stop generating
                    if fake.delay_s:
                        time.sleep(fake.delay_s)
                done = b"data: [DONE]\n\n"
                self.wfile.write(hex(len(done))[2:].encode() + b"\r\n" + done + b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}/v1"

    def __enter__(self) -> FakeModel:
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)
