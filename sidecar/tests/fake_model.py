"""A local OpenAI-compatible endpoint, so a real agent turn can be driven.

Every existing session test either stubs `SESSION_LOOP` or asserts on pieces of
the turn in isolation. Nothing ever ran the actual loop — SDK, tool dispatch,
contract parsing, persistence, and then a read of the session — because that
needed a model, and a model needed an API key.

It does not. `agent_service.build_agent` puts the provider's `base_url` on a
per-session `AsyncOpenAI` client and talks `/chat/completions`, so a socket that
speaks that protocol is a model as far as this app is concerned. This one serves
a scripted conversation: whatever turns you hand it, in order.

This is a TEST DOUBLE and deliberately minimal — it validates nothing, and it
speaks only the subset the SDK actually sends for a streamed chat completion.
What it buys is the seam no unit test can reach: the row `session_tools.note()`
really writes, persisted by the real writer, read back through the real
response model.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _chunk(delta: dict, finish: str | None = None) -> bytes:
    payload = {
        "id": "chatcmpl-fake", "object": "chat.completion.chunk", "created": 0,
        "model": "fake-model",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    return b"data: " + json.dumps(payload).encode() + b"\n\n"


def text_turn(text: str) -> list[bytes]:
    """A final answer, streamed in two deltas so the split is exercised."""
    half = len(text) // 2
    return [
        _chunk({"role": "assistant", "content": text[:half]}),
        _chunk({"content": text[half:]}),
        _chunk({}, "stop"),
    ]


def tool_turn(name: str, arguments: dict) -> list[bytes]:
    """A single function call."""
    return [
        _chunk({"role": "assistant", "tool_calls": [{
            "index": 0, "id": "call_fake_1", "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)},
        }]}),
        _chunk({}, "tool_calls"),
    ]


class FakeModel:
    """Serves `turns` one per request; the last one repeats if asked again."""

    def __init__(self, turns: list[list[bytes]]):
        self.turns = turns
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
                    fake.requests.append(json.loads(body or b"{}"))
                except ValueError:
                    fake.requests.append({})
                with fake._lock:
                    i = min(fake._i, len(fake.turns) - 1)
                    fake._i += 1
                chunks = fake.turns[i]
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                for c in chunks:
                    self.wfile.write(hex(len(c))[2:].encode() + b"\r\n" + c + b"\r\n")
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
