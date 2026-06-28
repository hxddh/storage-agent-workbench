"""Thin wrapper around the system keyring for secret storage.

Secrets (model API keys, cloud access/secret keys, session tokens) are stored
ONLY here, in the OS Keychain. The rest of the app persists only opaque
references of the form ``keyring://<scope>/<name>`` — never the plaintext.

A ``(scope, name)`` pair maps to a keyring ``(service, username)`` pair:

    service  = "storage-agent-workbench:<scope>"
    username = "<name>"
"""

from __future__ import annotations

import threading

import keyring

SERVICE_PREFIX = "storage-agent-workbench"

# In-process cache of resolved secrets, keyed by (scope, name).
#
# Why: every keyring read can trigger an OS keychain authorization prompt when
# the requesting binary is not (yet) trusted by the item's ACL — which is the
# norm for ad-hoc-signed builds, whose code identity changes between versions.
# Without caching, the model API key is re-read on *every* agent run (i.e. every
# message in a session), so the user is re-prompted again and again. Reading each
# secret from the keychain at most once per process collapses that to a single
# prompt per secret per launch (and none at all once the user picks "Always
# Allow", or with a stable Developer ID signature).
#
# The cache lives only in memory for the sidecar's lifetime; it is never written
# to disk, logs, or the model context. It is invalidated whenever a secret is
# saved or deleted, so an updated key takes effect immediately.
_cache: dict[tuple[str, str], str | None] = {}
_cache_lock = threading.Lock()


def _service(scope: str) -> str:
    return f"{SERVICE_PREFIX}:{scope}"


def make_ref(scope: str, name: str) -> str:
    """Build the opaque reference stored in SQLite."""
    return f"keyring://{scope}/{name}"


def parse_ref(ref: str) -> tuple[str, str]:
    """Parse ``keyring://<scope>/<name>`` into ``(scope, name)``."""
    if not ref.startswith("keyring://"):
        raise ValueError(f"not a keyring reference: {ref!r}")
    body = ref[len("keyring://") :]
    scope, sep, name = body.partition("/")
    if not sep:
        raise ValueError(f"malformed keyring reference: {ref!r}")
    return scope, name


def save_secret(scope: str, name: str, value: str) -> str:
    """Store ``value`` and return its ``keyring://`` reference."""
    keyring.set_password(_service(scope), name, value)
    with _cache_lock:
        _cache[(scope, name)] = value
    return make_ref(scope, name)


def get_secret(scope: str, name: str) -> str | None:
    """Fetch a stored secret, or ``None`` if it does not exist.

    Cached in-process after the first read (see the module-level note) so the OS
    keychain — and any authorization prompt — is hit at most once per secret per
    sidecar launch.
    """
    key = (scope, name)
    with _cache_lock:
        if key in _cache:
            return _cache[key]
    value = keyring.get_password(_service(scope), name)
    with _cache_lock:
        _cache[key] = value
    return value


def delete_secret(scope: str, name: str) -> None:
    """Delete a stored secret. No error if it does not exist."""
    try:
        keyring.delete_password(_service(scope), name)
    except keyring.errors.PasswordDeleteError:
        # Already absent — deletion is idempotent for our purposes.
        pass
    finally:
        with _cache_lock:
            _cache.pop((scope, name), None)
