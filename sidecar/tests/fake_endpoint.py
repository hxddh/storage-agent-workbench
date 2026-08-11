"""A real socket that answers the way a hostile-but-real endpoint answers.

The Stubber fixture in `test_s3_tools.py` is the right tool for "given error
code X, does the tool say Y". It cannot produce the shapes that actually break
this product, because it constructs botocore's parsed error dict directly and
therefore always hands the tool a well-formed `<Code>`.

The shapes below all come from real deployments, and each one has already cost
this product a defect:

- an nginx / CDN / API gateway in front of an S3-compatible service answers
  `501` or `405` with an **HTML** body, so botocore parses no code at all
  (v0.74.0: `get_object_lock_status` called that a hard failure, and reported an
  object it never reached as having no retention — "cleanly deletable");
- a `403` with no code, where auth failure and permission denial are genuinely
  indistinguishable and the tool must not guess;
- a plain web server at the wrong URL answering `200` with an empty body, which
  parses as a valid-but-empty response for nearly every operation;
- a truncated / non-XML `200`, which surfaces as a botocore ParseError rather
  than a ClientError, on a code path most tools never exercise;
- a connection reset, which is not a `ClientError` at all.

Used by `test_v076_endpoint_matrix.py`, which runs EVERY read-only tool against
EVERY shape and asserts the invariants rather than per-tool expectations — so a
tool added later inherits the whole matrix without anyone remembering to add it.
"""
from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Literal

Behaviour = Literal[
    "codeless_501",
    "codeless_405",
    "codeless_403",
    "empty_200",
    "truncated_xml",
    "html_500",
    "reset",
]

ALL_BEHAVIOURS: tuple[Behaviour, ...] = (
    "codeless_501",
    "codeless_405",
    "codeless_403",
    "empty_200",
    "truncated_xml",
    "html_500",
    "reset",
)

#: The shapes that mean "this endpoint does not implement the operation".
CAPABILITY_GAPS: frozenset[str] = frozenset({"codeless_501", "codeless_405"})

_HTML = b"<html><head><title>Error</title></head><body>Error</body></html>"
# A response that begins as S3 XML and stops mid-element: a proxy that truncated
# the body, or a range-limited gateway. botocore raises ParseError, not
# ClientError, which is a different except-branch in every tool.
_TRUNCATED = b'<?xml version="1.0"?><ListBucketResult><Name>bucket</Na'


class FakeEndpoint:
    """A real HTTP server answering every request the same hostile way.

    Deliberately not a partial S3 implementation: the point is the FAILURE
    shape, and a partial implementation would make each test depend on which
    operations happened to be modelled.
    """

    def __init__(self, behaviour: Behaviour) -> None:
        self.behaviour = behaviour
        self.requests: list[str] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            # HTTP/1.1 so the connection is KEPT ALIVE, which is what botocore's
            # pooled client actually does — an endpoint that closed after every
            # response would not exercise the same code. It requires the
            # THREADING server below: on a single-threaded `HTTPServer` the
            # handler loops on its open connection and never returns to
            # `serve_forever`, so the second connection blocks forever. That is
            # not hypothetical — the first draft of this file did exactly that
            # and every test in the matrix hung.
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):  # keep pytest output clean
                pass

            def _answer(self):
                outer.requests.append(f"{self.command} {self.path}")
                b = outer.behaviour
                if b == "reset":
                    # Close without a response: not a ClientError at all.
                    self.close_connection = True
                    try:
                        self.connection.close()
                    except OSError:
                        pass
                    return
                if b == "empty_200":
                    status, body, ctype = 200, b"", "application/xml"
                elif b == "truncated_xml":
                    status, body, ctype = 200, _TRUNCATED, "application/xml"
                elif b == "html_500":
                    status, body, ctype = 500, _HTML, "text/html"
                elif b == "codeless_403":
                    status, body, ctype = 403, _HTML, "text/html"
                elif b == "codeless_405":
                    status, body, ctype = 405, _HTML, "text/html"
                else:  # codeless_501
                    status, body, ctype = 501, _HTML, "text/html"
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = _answer

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def endpoint_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_port}"

    def __enter__(self) -> FakeEndpoint:
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self._server.shutdown()
        self._server.server_close()
