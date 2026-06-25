"""Local analysis engine (Phase 05).

DuckDB / PyArrow / pandas back the ``access_log_analysis`` and
``inventory_analysis`` run types. SQLite still holds only app metadata; the
analytical tables live in a per-run DuckDB file under
``data/runs/{run_id}/analysis.duckdb``. No object bodies are ever downloaded —
input comes only from user-uploaded local files.
"""
