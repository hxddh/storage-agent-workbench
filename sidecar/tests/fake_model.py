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
                 title: str | None = None, compaction: str | None = None, finalize: str = "Final answer."):
        self.turns = turns
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

            def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler's contract
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                try:
                    parsed = json.loads(body or b"{}")
                except ValueError:
                    parsed = {}
                text_body = (body or b"").decode("utf-8", "replace")
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
