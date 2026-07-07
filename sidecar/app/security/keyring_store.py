"""Cross-platform, zero-prompt secret store (encrypted local vault).

Secrets (model API keys, cloud access/secret keys, session tokens) are stored
ONLY here. The rest of the app persists only opaque references of the form
``keyring://<scope>/<name>`` — never the plaintext. (The ``keyring://`` scheme
is kept for backward compatibility; storage is now a local encrypted file, not
the OS keyring — see below.)

Why not the OS keychain
-----------------------
The app is ad-hoc-signed and cross-platform. The macOS Keychain binds trust to
a program's code identity, which changes on every ad-hoc build, so it re-prompts
for authorization on every update (and the Linux Secret Service may prompt or be
absent on headless installs). To give a frictionless, prompt-free experience on
macOS, Windows, and Linux alike, secrets live in a single AES-256-GCM file that
no per-launch prompt ever guards.

Layout (both files in ``config.data_dir()``)
---------------------------------------------
- ``secrets.enc`` — AES-256-GCM ciphertext (12-byte nonce ‖ ciphertext) of a
  JSON object mapping ``"<scope>/<name>"`` to the secret value.
- ``secrets.key`` — the 32-byte master key, protected by the strongest
  *non-prompting* mechanism on the platform:
    * Windows → DPAPI (``CryptProtectData``, current-user scope): the OS
      encrypts the key to the logged-in user; only that user can decrypt it.
    * macOS / Linux → a raw key file created ``O_EXCL`` with ``0600`` perms
      (owner-only).

Security posture (honest)
-------------------------
On Windows the master key is genuinely protected at rest by the OS (DPAPI). On
macOS/Linux the key file sits beside the vault with owner-only perms, so a
process running as the same user can decrypt it — practically the same exposure
as the keychain while unlocked, but weaker at rest than a *locked* keychain.
This is the standard local-first tradeoff and the only way to be prompt-free
cross-platform without a stable (Developer ID) code signature. Secrets are still
never written to SQLite, logs, reports, traces, or model prompts.

In-process cache
----------------
The decrypted map is held in memory for the sidecar's lifetime and updated in
place on every save/delete; the file is re-read at most once per launch.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .. import config

SERVICE_PREFIX = "storage-agent-workbench"  # retained for ref back-compat

_VAULT_FILENAME = "secrets.enc"
_KEY_FILENAME = "secrets.key"
_NONCE_LEN = 12

# In-memory mirror of the decrypted secret map (None = not yet loaded), the
# loaded master key, and one lock serialising the read-modify-write cycle
# against concurrent agent runs.
_blob: dict[str, str] | None = None
_master_key: bytes | None = None
_lock = threading.RLock()
# Set when an existing vault file could not be decrypted (key lost / data dir
# copied without the key). Surfaced to the UI so the user knows to recover the
# .unreadable backup or re-enter keys, instead of silently seeing "not set".
_unreadable: bool = False


def _vault_path() -> Path:
    return config.data_dir() / _VAULT_FILENAME


def _key_path() -> Path:
    return config.data_dir() / _KEY_FILENAME


def _blob_key(scope: str, name: str) -> str:
    return f"{scope}/{name}"


# --- master key (per-OS, non-prompting) -------------------------------------


def _dpapi_protect(data: bytes) -> bytes:  # pragma: no cover - Windows only
    import ctypes
    from ctypes import wintypes

    class _BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = _BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = _BLOB()
    if not ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    ):
        raise OSError("CryptProtectData failed")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def _dpapi_unprotect(data: bytes) -> bytes:  # pragma: no cover - Windows only
    import ctypes
    from ctypes import wintypes

    class _BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = _BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = _BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    ):
        raise OSError("CryptUnprotectData failed")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def _is_windows() -> bool:
    return sys.platform == "win32"


def _fsync_dir(directory: Path) -> None:
    """Best-effort fsync of a directory so a create/rename is durable."""
    try:
        dfd = os.open(str(directory), os.O_RDONLY)
    except OSError:  # e.g. Windows can't open a dir for fsync
        return
    try:
        os.fsync(dfd)
    except OSError:
        pass
    finally:
        os.close(dfd)


def _write_key_file(path: Path, raw_key: bytes) -> None:
    """Persist the master key, owner-only, never world-readable.

    Creates the file ``O_EXCL`` so a concurrent creator can't be clobbered (the
    loser gets ``FileExistsError``), and ``fsync``s the data before closing so a
    racing reader on the loser path never observes a partially-written key.
    """
    payload = _dpapi_protect(raw_key) if _is_windows() else raw_key
    config.ensure_secure_dir(path.parent)
    # O_EXCL so a concurrent creator can't be clobbered; 0600 perms.
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, payload)
        os.fsync(fd)  # durable before any loser reads it
    finally:
        os.close(fd)
    _fsync_dir(path.parent)


def _read_existing_key(path: Path) -> bytes:
    """Read + unprotect an already-created key file, tolerating a racing writer.

    ``O_EXCL`` creation is not atomic with the subsequent write, so a process
    that lost the creation race can momentarily see an empty/partial file. Retry
    briefly until the file yields a complete key (32 raw bytes on POSIX; any
    DPAPI-decryptable blob on Windows); raise if it never does.
    """
    last_exc: Exception | None = None
    for _ in range(200):
        try:
            raw = path.read_bytes()
            key = _dpapi_unprotect(raw) if _is_windows() else raw
        except Exception as exc:  # noqa: BLE001 - partial DPAPI blob mid-write
            last_exc = exc
        else:
            # POSIX keys are exactly 32 bytes; on Windows the DPAPI blob just
            # needs to decrypt to a non-empty key.
            if (_is_windows() and key) or (not _is_windows() and len(key) == 32):
                return key
        time.sleep(0.005)
    if last_exc is not None:
        raise last_exc
    raise OSError(f"master key at {path} never became fully readable")


def _load_master_key() -> bytes:
    """Load the master key, creating it (once) if absent. Caller holds ``_lock``."""
    global _master_key
    if _master_key is not None:
        return _master_key
    path = _key_path()
    if path.exists():
        _master_key = _read_existing_key(path)
        return _master_key
    key = os.urandom(32)
    try:
        _write_key_file(path, key)
    except FileExistsError:
        # Lost a creation race; read what the winner wrote (retrying until the
        # winner's write is complete, so we never adopt a partial/empty key).
        _master_key = _read_existing_key(path)
        return _master_key
    _master_key = key
    return _master_key


# --- vault load / persist ---------------------------------------------------


def _ensure_loaded() -> dict[str, str]:
    """Decrypt the vault into memory once. Caller holds ``_lock``."""
    global _blob
    if _blob is not None:
        return _blob
    path = _vault_path()
    if not path.exists():
        _blob = {}
        return _blob
    try:
        token = path.read_bytes()
        key = _load_master_key()
        plaintext = AESGCM(key).decrypt(token[:_NONCE_LEN], token[_NONCE_LEN:], None)
        parsed = json.loads(plaintext.decode("utf-8"))
        _blob = parsed if isinstance(parsed, dict) else {}
    except Exception as exc:  # noqa: BLE001
        # The vault exists but can't be decrypted/parsed (e.g. the key file was
        # lost/regenerated, or the data dir was copied without it). Don't silently
        # treat it as empty and then overwrite it on the next save — preserve the
        # original ciphertext for manual recovery and make the failure visible.
        global _unreadable
        _unreadable = True
        try:
            backup = path.with_suffix(path.suffix + ".unreadable")
            if not backup.exists():
                # 0600 like the vault itself — this backup IS the vault ciphertext;
                # write_bytes would create it 0644 (world-readable) under the
                # default umask.
                data = path.read_bytes()
                fd = os.open(str(backup), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    os.write(fd, data)
                finally:
                    os.close(fd)
        except Exception:  # noqa: BLE001
            pass
        logging.getLogger(__name__).warning(
            "Secret vault at %s could not be decrypted (%s); treating it as a new "
            "blank vault. The original is preserved at %s.unreadable — re-enter "
            "your keys.",
            path, type(exc).__name__, path,
        )
        _blob = {}
    return _blob


def _persist(blob: dict[str, str]) -> None:
    """Encrypt ``blob`` and atomically write the vault. Caller holds ``_lock``.

    Takes the map explicitly so writers can persist FIRST and only then swap the
    in-memory blob — a failed write leaves memory and disk consistent.
    """
    key = _load_master_key()
    nonce = os.urandom(_NONCE_LEN)
    plaintext = json.dumps(blob, separators=(",", ":")).encode("utf-8")
    token = nonce + AESGCM(key).encrypt(nonce, plaintext, None)
    path = _vault_path()
    config.ensure_secure_dir(path.parent)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, token)
        os.fsync(fd)  # ciphertext durable before the atomic swap
    finally:
        os.close(fd)
    os.replace(tmp, path)  # atomic
    _fsync_dir(path.parent)  # make the rename itself durable


# --- public API (unchanged) -------------------------------------------------


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
    """Store ``value`` and return its ``keyring://`` reference.

    Persists to disk FIRST and only mutates the in-memory blob on success, so a
    failed write can't leave memory claiming a secret the vault never got.
    """
    global _blob
    key = _blob_key(scope, name)
    with _lock:
        updated = dict(_ensure_loaded())
        updated[key] = value
        _persist(updated)
        _blob = updated
    return make_ref(scope, name)


def get_secret(scope: str, name: str) -> str | None:
    """Fetch a stored secret, or ``None`` if it does not exist."""
    key = _blob_key(scope, name)
    with _lock:
        return _ensure_loaded().get(key)


def delete_secret(scope: str, name: str) -> None:
    """Delete a stored secret. No error if it does not exist.

    Same persist-first ordering as :func:`save_secret`.
    """
    global _blob
    key = _blob_key(scope, name)
    with _lock:
        current = _ensure_loaded()
        if key not in current:
            return
        updated = {k: v for k, v in current.items() if k != key}
        _persist(updated)
        _blob = updated


def secret_exists(ref: str | None) -> bool:
    """Whether the secret behind a ``keyring://`` ref is actually present.

    Use this (not merely ``bool(ref)``) for ``has_*_key`` flags: a ref can linger
    in SQLite while the secret is gone from the vault (e.g. after the keychain→
    vault migration, where secrets are not carried over and must be re-entered).
    """
    if not ref:
        return False
    try:
        scope, name = parse_ref(ref)
    except ValueError:
        return False
    return get_secret(scope, name) is not None


def vault_status() -> dict[str, Any]:
    """Whether the on-disk vault could not be decrypted this session.

    ``unreadable`` is True when an existing vault file failed to decrypt (the
    original was preserved as ``<vault>.unreadable``); the UI surfaces this so a
    user doesn't mistake it for "no keys set".
    """
    with _lock:
        _ensure_loaded()  # trigger a load attempt if not yet done
        backup = _vault_path().with_suffix(_vault_path().suffix + ".unreadable")
        return {
            "unreadable": _unreadable,
            "backup_present": _unreadable and backup.exists(),
        }


def _reset_for_tests() -> None:
    """Drop the in-process cache + master key. Used by the test harness."""
    global _blob, _master_key, _unreadable
    with _lock:
        _blob = None
        _master_key = None
        _unreadable = False


__all__ = ["SERVICE_PREFIX", "make_ref", "parse_ref", "save_secret", "get_secret",
           "delete_secret", "secret_exists"]
