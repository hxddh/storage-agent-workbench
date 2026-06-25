"""Tests for the keyring wrapper."""

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


def test_make_and_parse_ref():
    ref = keyring_store.make_ref("cloud_provider", "id1/access_key")
    assert ref == "keyring://cloud_provider/id1/access_key"
    scope, name = keyring_store.parse_ref(ref)
    assert scope == "cloud_provider"
    assert name == "id1/access_key"


def test_parse_ref_rejects_non_keyring():
    with pytest.raises(ValueError):
        keyring_store.parse_ref("https://example.com/x")
