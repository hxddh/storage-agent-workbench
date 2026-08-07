"""A local S3-compatible endpoint, so the read-only tools can be driven for real.

The S3 layer is tested with a botocore ``Stubber``, which replaces the client's
response *after* the request is built. That covers response handling and nothing
else: it never serializes a request, never signs one, never sees a URL, and
cannot tell path-style from virtual-host addressing — the two things this product
exists to diagnose. Nothing here has ever spoken HTTP.

This is a socket that answers S3 XML. It does not verify signatures (a test
double that re-implemented SigV4 would be testing botocore, not this app) and
implements only the read-only operations the whitelist actually uses. What it
buys is the request half: the URL boto3 builds, the addressing style it picks,
the headers it sends, and how a real error status maps into this app's own
sanitized result shape.

`fail_with` turns any operation into a real S3 error response, which is how the
error-mapping paths — `AccessDenied`, `NoSuchBucket`, `301` redirect,
`NotImplemented` → provider_unsupported — get exercised end to end instead of
being asserted against a hand-written exception.
"""
from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

_LIST_BUCKETS = """<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner><ID>acme-owner-id</ID><DisplayName>acme</DisplayName></Owner>
  <Buckets>{buckets}</Buckets>
</ListAllMyBucketsResult>"""

_BUCKET = "<Bucket><Name>{name}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>"

_LIST_OBJECTS = """<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>{bucket}</Name><Prefix>{prefix}</Prefix><KeyCount>{count}</KeyCount>
  <MaxKeys>{max_keys}</MaxKeys><IsTruncated>false</IsTruncated>
  {contents}
</ListBucketResult>"""

_CONTENT = ("<Contents><Key>{key}</Key><LastModified>2026-06-01T00:00:00.000Z</LastModified>"
            "<ETag>&quot;{etag}&quot;</ETag><Size>{size}</Size>"
            "<StorageClass>{sc}</StorageClass></Contents>")

_ERROR = """<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>{code}</Code><Message>{message}</Message>
<RequestId>FAKEREQ0001</RequestId><HostId>fakehost</HostId></Error>"""

_LOCATION = ('<?xml version="1.0" encoding="UTF-8"?>'
             '<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
             "{region}</LocationConstraint>")


class FakeS3:
    """Serve a handful of read-only S3 operations over plain HTTP.

    ``buckets`` maps a bucket name to its object keys. ``fail_with`` is
    ``(status, code, message)`` applied to every request while set, so a test can
    turn the whole endpoint into one specific S3 failure.
    """

    def __init__(self, buckets: dict[str, list[str]] | None = None,
                 region: str = "us-east-1"):
        self.buckets = buckets if buckets is not None else {"acme-logs": ["logs/a.parquet"]}
        self.region = region
        self.fail_with: tuple[int, str, str] | None = None
        # Every request line seen, so a test can assert on the URL boto3 BUILT —
        # which is where addressing style actually shows up.
        self.requests: list[tuple[str, str, dict[str, str]]] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def _send(self, status: int, body: str) -> None:
                raw = body.encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/xml")
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("x-amz-request-id", "FAKEREQ0001")
                self.end_headers()
                self.wfile.write(raw)

            def _record(self) -> tuple[str, dict[str, list[str]]]:
                parsed = urlparse(self.path)
                fake.requests.append((self.command, self.path, dict(self.headers)))
                # keep_blank_values: S3 sub-resources are VALUELESS flags
                # (`?location`, `?versions`, `?uploads`), and parse_qs drops
                # those by default — so every sub-resource request silently
                # looked like a plain object listing.
                return parsed.path, parse_qs(parsed.query, keep_blank_values=True)

            def _bucket_and_key(self, path: str) -> tuple[str | None, str]:
                """Resolve the target from EITHER addressing style.

                Virtual-host puts the bucket in Host; path-style puts it first in
                the path. Answering both is what lets a test assert which one
                boto3 chose, rather than assuming.
                """
                host = (self.headers.get("host") or "").split(":")[0]
                for name in fake.buckets:
                    if host.startswith(f"{name}."):
                        return name, path.lstrip("/")
                parts = path.lstrip("/").split("/", 1)
                if parts[0]:
                    return parts[0], (parts[1] if len(parts) > 1 else "")
                return None, ""

            def do_GET(self):  # noqa: N802
                path, query = self._record()
                if fake.fail_with:
                    status, code, msg = fake.fail_with
                    return self._send(status, _ERROR.format(code=code, message=msg))
                bucket, key = self._bucket_and_key(path)
                if bucket is None:
                    listed = "".join(_BUCKET.format(name=n) for n in fake.buckets)
                    return self._send(200, _LIST_BUCKETS.format(buckets=listed))
                if bucket not in fake.buckets:
                    return self._send(404, _ERROR.format(
                        code="NoSuchBucket", message="The specified bucket does not exist"))
                if "location" in query:
                    return self._send(200, _LOCATION.format(region=fake.region))
                prefix = (query.get("prefix") or [""])[0]
                max_keys = int((query.get("max-keys") or ["1000"])[0])
                keys = [k for k in fake.buckets[bucket] if k.startswith(prefix)][:max_keys]
                contents = "".join(
                    _CONTENT.format(key=k, etag=f"{i:032x}", size=1024 * (i + 1), sc="STANDARD")
                    for i, k in enumerate(keys)
                )
                return self._send(200, _LIST_OBJECTS.format(
                    bucket=bucket, prefix=prefix, count=len(keys),
                    max_keys=max_keys, contents=contents))

            def do_HEAD(self):  # noqa: N802
                path, _ = self._record()
                if fake.fail_with:
                    status, _code, _msg = fake.fail_with
                    self.send_response(status)
                    self.send_header("Content-Length", "0")
                    self.send_header("x-amz-request-id", "FAKEREQ0001")
                    self.end_headers()
                    return
                bucket, key = self._bucket_and_key(path)
                found = bucket in fake.buckets and (not key or key in fake.buckets[bucket])
                self.send_response(200 if found else 404)
                self.send_header("Content-Length", "0")
                self.send_header("x-amz-request-id", "FAKEREQ0001")
                if found and key:
                    self.send_header("ETag", '"0123456789abcdef"')
                self.end_headers()

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def endpoint_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def paths(self) -> list[str]:
        """Just the request paths, for asserting on addressing style."""
        return [p for _m, p, _h in self.requests]

    def __enter__(self) -> FakeS3:
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)
