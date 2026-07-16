"""Health + packaged-bundle self-check endpoints."""

from __future__ import annotations

from fastapi import APIRouter

from .. import __version__ as APP_VERSION

SERVICE_NAME = "storage-agent-sidecar"

router = APIRouter()


@router.get("/health")
def health() -> dict[str, str]:
    """Liveness probe used by the frontend to show connected/disconnected.

    ``version`` is the running service version (from installed package metadata);
    exposing it lets the release smoke test confirm a bundle reports the stamped
    version rather than a stale one or the ``0.0.0+source`` fallback."""
    return {"status": "ok", "service": SERVICE_NAME, "version": APP_VERSION}


def _run_selfcheck() -> dict[str, object]:
    """Exercise the packaging-critical runtime that a bare /health never touches.

    A PyInstaller bundle can pass ``/health`` while silently missing a lazily
    imported native dependency — the OpenAI Agents SDK, a botocore service model,
    the DuckDB/PyArrow engines, or the ``cryptography`` binding the secret vault
    decrypts with. Each of those only loads on a real code path, so this check
    imports/instantiates them offline (no network, no credentials, no secrets
    persisted) and reports per-component ``ok``/``error``. The release smoke test
    asserts ``status == "ok"`` so a broken bundle fails the build instead of
    shipping and only breaking in a user's hands.
    """
    checks: dict[str, str] = {}

    def _check(name: str, fn) -> None:
        try:
            fn()
            checks[name] = "ok"
        except Exception as exc:  # noqa: BLE001 - report, don't crash the probe
            # Import/build errors carry no secrets; keep the class + short text.
            checks[name] = f"error: {type(exc).__name__}: {str(exc)[:160]}"

    def _agents_sdk() -> None:
        import agents  # noqa: F401  (SDK imports submodules at package import)
        import openai  # noqa: F401

    def _s3_client() -> None:
        # Building a client forces botocore to load its S3 service data model
        # (the large lazily-loaded JSON tree). No network call is made.
        import boto3

        boto3.client(
            "s3",
            region_name="us-east-1",
            aws_access_key_id="selfcheck",
            aws_secret_access_key="selfcheck",
        )

    def _analysis_engine() -> None:
        import duckdb
        import pyarrow as pa

        con = duckdb.connect(":memory:")
        try:
            con.register("selfcheck_tbl", pa.table({"n": [1, 2, 3]}))
            got = con.execute("SELECT sum(n) FROM selfcheck_tbl").fetchone()
            if not got or got[0] != 6:
                raise RuntimeError("duckdb/pyarrow round-trip returned wrong result")
        finally:
            con.close()

    def _vault_crypto() -> None:
        # The secret vault (security/keyring_store) decrypts with AES-256-GCM from
        # `cryptography`, whose compiled `_rust` binding loads lazily. A bundle
        # missing it can't open the vault — round-trip to prove it's present.
        import os

        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        key = AESGCM.generate_key(bit_length=256)
        aes = AESGCM(key)
        nonce = os.urandom(12)
        token = aes.encrypt(nonce, b"selfcheck", None)
        if aes.decrypt(nonce, token, None) != b"selfcheck":
            raise RuntimeError("AES-GCM round-trip mismatch")

    _check("agents_sdk", _agents_sdk)
    _check("s3_client", _s3_client)
    _check("analysis_engine", _analysis_engine)
    _check("vault_crypto", _vault_crypto)

    ok = all(v == "ok" for v in checks.values())
    return {"status": "ok" if ok else "degraded", "service": SERVICE_NAME, "checks": checks}


@router.get("/health/selfcheck")
def selfcheck() -> dict[str, object]:
    """Deep bundle self-check (see ``_run_selfcheck``). Token-gated in production."""
    return _run_selfcheck()
