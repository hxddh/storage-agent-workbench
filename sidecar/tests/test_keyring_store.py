"""Tests for the keyring wrapper."""

import json

import pytest

from app.security import keyring_store


def test_save_get_delete_roundtrip():
    ref = keyring_store.save_secret("model_provider", "abc/api_key", "sk-123")
    assert ref == "keyring://model_provider/abc/api_key"
    assert keyring_store.get_secret("model_provider", "abc/api_key") == "sk-123"

    keyring_store.delete_secret("model_provider", "abc/api_key")
    assert keyring_store.get_secret("model_provider", "abc/api_key") is None


def test_delete_missing_is_idempotent():
    # Should not raise even though nothing is stored.
    keyring_store.delete_secret("model_provider", "does/not-exist")


def test_get_secret_is_cached(_in_memory_keyring):
    """After the first read, get_secret serves from the in-process cache so the
    OS keychain (and its auth prompt) is hit at most once per secret per launch."""
    backend = _in_memory_keyring
    keyring_store.save_secret("model_provider", "p/api_key", "sk-1")

    # Prime the cache, then mutate the consolidated item behind its back.
    assert keyring_store.get_secret("model_provider", "p/api_key") == "sk-1"
    backend._store[("storage-agent-workbench", "secrets-v1")] = json.dumps(
        {"model_provider/p/api_key": "sk-CHANGED"}
    )
    # Cache wins — no second backend read (and so no second prompt in real life).
    assert keyring_store.get_secret("model_provider", "p/api_key") == "sk-1"


def test_all_secrets_share_one_keychain_item(_in_memory_keyring):
    """Every secret lives in a single consolidated item, so macOS prompts once
    ("Always Allow" then covers them all) instead of once per secret."""
    backend = _in_memory_keyring
    keyring_store.save_secret("model_provider", "p/api_key", "sk-1")
    keyring_store.save_secret("cloud_provider", "c/access_key", "AKIA")
    keyring_store.save_secret("cloud_provider", "c/secret_key", "shh")

    # Exactly one keychain item backs all three secrets.
    assert list(backend._store.keys()) == [("storage-agent-workbench", "secrets-v1")]
    stored = json.loads(backend._store[("storage-agent-workbench", "secrets-v1")])
    assert stored == {
        "model_provider/p/api_key": "sk-1",
        "cloud_provider/c/access_key": "AKIA",
        "cloud_provider/c/secret_key": "shh",
    }


def test_legacy_per_item_secret_is_migrated_on_read(_in_memory_keyring):
    """A secret left by an older version (one item per secret) is read and
    copied forward into the consolidated item, so existing keys keep working."""
    backend = _in_memory_keyring
    # Simulate the pre-consolidation layout written by an earlier build.
    backend._store[("storage-agent-workbench:model_provider", "old/api_key")] = "sk-legacy"
    keyring_store._reset_for_tests()

    assert keyring_store.get_secret("model_provider", "old/api_key") == "sk-legacy"
    # It now lives in the consolidated item too.
    stored = json.loads(backend._store[("storage-agent-workbench", "secrets-v1")])
    assert stored["model_provider/old/api_key"] == "sk-legacy"


def test_save_and_delete_invalidate_cache(_in_memory_keyring):
    keyring_store.save_secret("model_provider", "p/api_key", "sk-1")
    assert keyring_store.get_secret("model_provider", "p/api_key") == "sk-1"

    # Re-saving (e.g. rotating the key) must be visible immediately.
    keyring_store.save_secret("model_provider", "p/api_key", "sk-2")
    assert keyring_store.get_secret("model_provider", "p/api_key") == "sk-2"

    # Deleting must invalidate the cache too.
    keyring_store.delete_secret("model_provider", "p/api_key")
    assert keyring_store.get_secret("model_provider", "p/api_key") is None


def test_make_and_parse_ref():
    ref = keyring_store.make_ref("cloud_provider", "id1/access_key")
    assert ref == "keyring://cloud_provider/id1/access_key"
    scope, name = keyring_store.parse_ref(ref)
    assert scope == "cloud_provider"
    assert name == "id1/access_key"


def test_parse_ref_rejects_non_keyring():
    with pytest.raises(ValueError):
        keyring_store.parse_ref("https://example.com/x")
