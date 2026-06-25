"""Whitelisted, READ-ONLY S3-compatible tool layer (Phase 03).

This package exposes ONLY non-destructive, read-only operations. There is no
PutObject, DeleteObject, DeleteObjects, DeleteBucket, PutBucketPolicy,
PutBucketAcl, or PutLifecycleConfiguration here, and no generic shell or
subprocess access. Cloud credentials are read from the system keyring and are
never returned, logged, or persisted.
"""
