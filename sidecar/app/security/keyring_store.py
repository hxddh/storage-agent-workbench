"""Thin wrapper around the system keyring for secret storage.

Secrets (model API keys, cloud access/secret keys, session tokens) are stored
ONLY here, in the OS Keychain. The rest of the app persists only opaque
references of the form ``keyring://<scope>/<name>`` — never the plaintext.

Storage layout — one keychain item for everything
--------------------------------------------------
All secrets live in a *single* keychain item:

    service  = "storage-agent-workbench"
    username = "secrets-v1"

whose password is a JSON object mapping ``"<scope>/<name>"`` to the secret
value. The opaque reference (``keyring://<scope>/<name>``) and the public API
are unchanged; consolidation is purely an internal storage detail.

Why one item instead of one-item-per-secret?
    On macOS every keychain item carries its own ACL, and an ad-hoc-signed
    build (whose code identity changes every version) is not on that ACL — so
    the OS shows an authorization prompt the *first* time each item is read.
    With a separate item per secret, a user with a model key + cloud
    access/secret keys + a session token faces a *burst* of prompts, and the
    "Always Allow" choice only covers the one item it was shown for. Collapsing
    everything into one item means the user is prompted **once**; "Always Allow"
    then covers every secret the app will ever read. This removes the keychain
    friction that made "secrets only in the Keychain" painful in practice —
    without weakening the guarantee: secrets still never leave the Keychain, are
    never written to SQLite/logs/reports/model prompts, and are still resolved
    only server-side.

    (The remaining once-per-app-version prompt is inherent to ad-hoc signing;
    only a stable Developer ID signature / notarization removes it entirely.)

Legacy migration
-----------------
Earlier versions stored each secret as its own item
(``service="storage-agent-workbench:<scope>"``, ``username="<name>"``). When a
secret is missing from the consolidated item, we fall back to its legacy item
and, if found, copy it forward into the consolidated item — so existing keys
keep working with no re-entry. (The legacy item is left untouched on read;
``delete_secret`` removes both layouts.)

In-process cache
----------------
The consolidated JSON is read from the keychain at most once per sidecar launch
and then served from memory, so neither the model API key (re-read on every
agent run) nor any cloud secret triggers repeat prompts. The cache lives only in
memory; it is never written to disk, logs, or the model context, and is updated
in place on every save/delete so a rotated key takes effect immediately.
"""

from __future__ import annotations

import json
import threading

import keyring

SERVICE_PREFIX = "storage-agent-workbench"

# The single consolidated keychain item holding every secret.
_INDEX_SERVICE = SERVICE_PREFIX
_INDEX_USERNAME = "secrets-v1"

# In-memory mirror of the consolidated secret map, loaded lazily on first
# access. ``None`` means "not yet read from the keychain"; a dict (possibly
# empty) means "loaded". ``_negative`` records ``"<scope>/<name>"`` keys already
# confirmed absent (including after a legacy-fallback miss) so we never re-probe
# the keychain for them. A single re-entrant lock serialises the read-modify-
# write cycle against concurrent agent runs.
_blob: dict[str, str] | None = None
_negative: set[str] = set()
_lock = threading.RLock()


def _service(scope: str) -> str:
    """Legacy per-scope service name (read-only, for migration)."""
    return f"{SERVICE_PREFIX}:{scope}"


def _blob_key(scope: str, name: str) -> str:
    return f"{scope}/{name}"


def _ensure_loaded() -> dict[str, str]:
    """Load the consolidated map from the keychain once. Caller holds ``_lock``."""
    global _blob
    if _blob is None:
        raw = keyring.get_password(_INDEX_SERVICE, _INDEX_USERNAME)
        if raw:
            try:
                parsed = json.loads(raw)
            except (ValueError, TypeError):
                parsed = {}
            _blob = parsed if isinstance(parsed, dict) else {}
        else:
            _blob = {}
    return _blob


def _persist() -> None:
    """Write the consolidated map back to the keychain. Caller holds ``_lock``."""
    assert _blob is not None
    keyring.set_password(
        _INDEX_SERVICE, _INDEX_USERNAME, json.dumps(_blob, separators=(",", ":"))
    )


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
    key = _blob_key(scope, name)
    with _lock:
        blob = _ensure_loaded()
        blob[key] = value
        _persist()
        _negative.discard(key)
    return make_ref(scope, name)


def get_secret(scope: str, name: str) -> str | None:
    """Fetch a stored secret, or ``None`` if it does not exist.

    Served from the in-process mirror after the first keychain read (see the
    module docstring). On a miss, falls back to the legacy per-secret item and
    migrates it forward so existing keys keep working without re-entry.
    """
    key = _blob_key(scope, name)
    with _lock:
        blob = _ensure_loaded()
        if key in blob:
            return blob[key]
        if key in _negative:
            return None
        # Fall back to the pre-consolidation layout and migrate forward.
        legacy = keyring.get_password(_service(scope), name)
        if legacy is not None:
            blob[key] = legacy
            try:
                _persist()
            except Exception:
                # Keep the in-memory copy even if the keychain write fails; the
                # secret is still usable this session and we won't re-probe.
                pass
            return legacy
        _negative.add(key)
        return None


def delete_secret(scope: str, name: str) -> None:
    """Delete a stored secret from both the consolidated and legacy layouts."""
    key = _blob_key(scope, name)
    with _lock:
        blob = _ensure_loaded()
        if blob.pop(key, None) is not None:
            _persist()
        _negative.add(key)
        # Remove any leftover legacy item so it can't resurrect on a later read.
        try:
            keyring.delete_password(_service(scope), name)
        except keyring.errors.PasswordDeleteError:
            pass


def _reset_for_tests() -> None:
    """Drop the in-process cache. Used by the test harness between cases."""
    global _blob
    with _lock:
        _blob = None
        _negative.clear()
