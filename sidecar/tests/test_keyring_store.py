"""Tests for the encrypted, cross-platform, zero-prompt secret vault.

Secrets live in a single AES-256-GCM file (`secrets.enc`) whose master key is
held in `secrets.key`; nothing prompts. These verify the round-trip + caching
behaviour and the at-rest invariants (one encrypted file, plaintext never on
disk, owner-only key file, survives a process restart).
"""

import stat
import sys

import pytest

from app import config
from app.security import keyring_store

SECRET = "sk-DO-NOT-LEAK-PLAINTEXT-1234567890"


def test_save_get_delete_roundtrip():
    ref = keyring_store.save_secret("model_provider", "abc/api_key", "sk-123")
    assert ref == "keyring://model_provider/abc/api_key"
    assert keyring_store.get_secret("model_provider", "abc/api_key") == "sk-123"

    keyring_store.delete_secret("model_provider", "abc/api_key")
    assert keyring_store.get_secret("model_provider", "abc/api_key") is None


def test_delete_missing_is_idempotent():
    keyring_store.delete_secret("model_provider", "does/not-exist")


def test_get_secret_is_cached():
    """After the first read the decrypted map is served from memory; tampering
    with the file on disk is not seen until the cache is reset."""
    keyring_store.save_secret("model_provider", "p/api_key", "sk-1")
    assert keyring_store.get_secret("model_provider", "p/api_key") == "sk-1"

    config.data_dir().joinpath("secrets.enc").write_bytes(b"garbage-not-a-vault")
    # Cache wins — no re-read from the (now corrupt) file.
    assert keyring_store.get_secret("model_provider", "p/api_key") == "sk-1"


def test_save_and_delete_invalidate_cache():
    keyring_store.save_secret("model_provider", "p/api_key", "sk-1")
    assert keyring_store.get_secret("model_provider", "p/api_key") == "sk-1"
    keyring_store.save_secret("model_provider", "p/api_key", "sk-2")  # rotate
    assert keyring_store.get_secret("model_provider", "p/api_key") == "sk-2"
    keyring_store.delete_secret("model_provider", "p/api_key")
    assert keyring_store.get_secret("model_provider", "p/api_key") is None


def test_all_secrets_share_one_encrypted_file():
    keyring_store.save_secret("model_provider", "p/api_key", "sk-1")
    keyring_store.save_secret("cloud_provider", "c/access_key", "AKIA")
    keyring_store.save_secret("cloud_provider", "c/secret_key", "shh")
    data = config.data_dir()
    assert data.joinpath("secrets.enc").exists()
    # Only the vault + its key file — no per-secret artifacts.
    names = {p.name for p in data.iterdir() if p.is_file()}
    assert names == {"secrets.enc", "secrets.key"}


def test_plaintext_never_on_disk():
    keyring_store.save_secret("model_provider", "p/api_key", SECRET)
    blob = config.data_dir().joinpath("secrets.enc").read_bytes()
    assert SECRET.encode() not in blob          # value is encrypted
    assert b"model_provider" not in blob        # keys are encrypted too


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX perms (Windows uses DPAPI)")
def test_key_file_is_owner_only():
    keyring_store.save_secret("model_provider", "p/api_key", "sk-1")
    mode = stat.S_IMODE(config.data_dir().joinpath("secrets.key").stat().st_mode)
    assert mode == 0o600


def test_secret_survives_process_restart():
    keyring_store.save_secret("model_provider", "p/api_key", "persisted")
    keyring_store._reset_for_tests()  # simulate a fresh sidecar launch
    assert keyring_store.get_secret("model_provider", "p/api_key") == "persisted"


def test_secret_exists_reflects_vault_not_just_ref():
    """has_*_key flags must check the vault, not just a lingering ref string —
    otherwise a stale ref (e.g. after the keychain→vault migration) falsely
    reports a key as present."""
    ref = keyring_store.save_secret("model_provider", "p/api_key", "sk-1")
    assert keyring_store.secret_exists(ref) is True
    keyring_store.delete_secret("model_provider", "p/api_key")
    assert keyring_store.secret_exists(ref) is False  # ref alone is not enough
    assert keyring_store.secret_exists(None) is False
    assert keyring_store.secret_exists("not-a-ref") is False


def test_unreadable_vault_is_backed_up_not_silently_lost():
    """If the vault can't be decrypted (e.g. key file lost), the original is
    preserved as .unreadable rather than silently overwritten."""
    keyring_store.save_secret("model_provider", "p/api_key", "sk-1")
    vault = config.data_dir() / "secrets.enc"
    vault.write_bytes(b"not-a-valid-aesgcm-token")  # corrupt it
    keyring_store._reset_for_tests()

    assert keyring_store.get_secret("model_provider", "p/api_key") is None
    assert (config.data_dir() / "secrets.enc.unreadable").exists()


def test_make_and_parse_ref():
    ref = keyring_store.make_ref("cloud_provider", "id1/access_key")
    assert ref == "keyring://cloud_provider/id1/access_key"
    scope, name = keyring_store.parse_ref(ref)
    assert scope == "cloud_provider"
    assert name == "id1/access_key"


def test_parse_ref_rejects_non_keyring():
    with pytest.raises(ValueError):
        keyring_store.parse_ref("https://example.com/x")
