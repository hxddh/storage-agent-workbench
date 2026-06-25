"""Thin wrapper around the system keyring for secret storage.

Secrets (model API keys, cloud access/secret keys, session tokens) are stored
ONLY here, in the OS Keychain. The rest of the app persists only opaque
references of the form ``keyring://<scope>/<name>`` — never the plaintext.

A ``(scope, name)`` pair maps to a keyring ``(service, username)`` pair:

    service  = "storage-agent-workbench:<scope>"
    username = "<name>"
"""

from __future__ import annotations

import keyring

SERVICE_PREFIX = "storage-agent-workbench"


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
    return make_ref(scope, name)


def get_secret(scope: str, name: str) -> str | None:
    """Fetch a stored secret, or ``None`` if it does not exist."""
    return keyring.get_password(_service(scope), name)


def delete_secret(scope: str, name: str) -> None:
    """Delete a stored secret. No error if it does not exist."""
    try:
        keyring.delete_password(_service(scope), name)
    except keyring.errors.PasswordDeleteError:
        # Already absent — deletion is idempotent for our purposes.
        pass
