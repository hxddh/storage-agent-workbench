# Data model

## SQLite

SQLite stores app metadata only.

Planned tables:

- model_providers
- cloud_providers
- runs
- messages
- tool_calls
- approval_events
- audit_logs
- datasets
- reports

## model_providers

Fields:

- id
- name
- provider_type
- base_url
- model
- api_key_ref
- created_at
- updated_at

## cloud_providers

Fields:

- id
- name
- provider_type
- endpoint_url
- region
- addressing_style
- signature_version
- access_key_ref
- secret_key_ref
- session_token_ref
- mode
- allowed_buckets_json
- allowed_prefixes_json
- created_at
- updated_at

## runs

Fields:

- id
- run_type
- title
- status
- provider_id
- bucket
- user_prompt
- final_summary
- report_path
- created_at
- updated_at

## tool_calls

Fields:

- id
- run_id
- tool_name
- input_json_sanitized
- output_json_sanitized
- status
- duration_ms
- created_at

## audit_logs

Fields:

- id
- run_id
- event_type
- payload_json_sanitized
- created_at

## Secret references

A reference is an opaque `keyring://scope/name` string; the secret itself lives
in the encrypted local vault (`security/keyring_store`), never in SQLite.

SQLite may store:

- api_key_ref
- access_key_ref
- secret_key_ref
- session_token_ref

SQLite must not store:

- plaintext API keys
- plaintext access keys
- plaintext secret keys
- plaintext session tokens

## DuckDB

DuckDB stores analytical data:

- Access logs
- Inventory files
- Sampled object metadata
- Derived metrics

## Local files

Planned run artifact layout:

```text
data/runs/{run_id}/raw/
data/runs/{run_id}/analysis.duckdb
data/runs/{run_id}/report.md
```
