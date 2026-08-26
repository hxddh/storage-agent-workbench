"""The row cap has to bound the READ, not just the result.

`_load_dataframe` caps CSV at read time with `nrows`, so a multi-GB export never
materializes only to be thrown away. Parquet was read WHOLE and trimmed after,
justified by the columnar form being far smaller than per-row Python structures.
True, but relative: the upload limit is 2 GiB and a compressed columnar file
that size expands to many times it in Arrow. DuckDB's `memory_limit` does not
apply — this is pandas/pyarrow, outside the engine — so the ceiling that bounded
the CSV path bounded nothing on the parquet one.

These tests pin the behaviour that fixes it: the row count comes from the
footer (so truncation is known, not inferred), and only the kept rows are ever
materialized.
"""
from __future__ import annotations

from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from app.analysis import inventory


def _write(path: Path, rows: int) -> None:
    pq.write_table(
        pa.table({"bucket": ["b"] * rows,
                  "key": [f"logs/obj-{i:08d}.json" for i in range(rows)],
                  "size": list(range(rows))}),
        path, compression="zstd", row_group_size=1_000)


def test_a_file_under_the_cap_is_read_whole_and_not_flagged(tmp_path):
    p = tmp_path / "small.parquet"
    _write(p, 500)
    df, truncated, fmt = inventory._load_dataframe(str(p))
    assert fmt == "parquet" and truncated is False
    assert len(df) == 500
    assert list(df.columns) == ["bucket", "key", "size"]


def test_a_file_over_the_cap_is_capped_and_flagged(tmp_path, monkeypatch):
    monkeypatch.setattr(inventory, "MAX_INGEST_ROWS", 1_000)
    monkeypatch.setattr(inventory, "_PARQUET_BATCH_ROWS", 250)
    p = tmp_path / "big.parquet"
    _write(p, 5_000)
    df, truncated, _ = inventory._load_dataframe(str(p))
    assert truncated is True
    assert len(df) == 1_000, len(df)
    # …and the rows kept are the first ones, not an arbitrary slice.
    assert df["key"].iloc[0] == "logs/obj-00000000.json"
    assert df["key"].iloc[-1] == "logs/obj-00000999.json"


def test_only_the_kept_rows_are_ever_materialized(tmp_path, monkeypatch):
    """The point of the change. Counting the rows handed out by `iter_batches`
    is what separates "capped the result" from "capped the read" — the old code
    passes every assertion above while reading all 50,000 rows."""
    monkeypatch.setattr(inventory, "MAX_INGEST_ROWS", 1_000)
    monkeypatch.setattr(inventory, "_PARQUET_BATCH_ROWS", 250)
    p = tmp_path / "huge.parquet"
    _write(p, 50_000)

    seen = {"rows": 0}
    real_iter = pq.ParquetFile.iter_batches

    def counting_iter(self, *a, **k):
        for batch in real_iter(self, *a, **k):
            seen["rows"] += batch.num_rows
            yield batch

    monkeypatch.setattr(pq.ParquetFile, "iter_batches", counting_iter)
    df, truncated, _ = inventory._load_dataframe(str(p))

    assert truncated is True and len(df) == 1_000
    # One batch of slack past the cap is the loop's granularity; 50,000 is not.
    assert seen["rows"] <= 1_000 + 250, seen["rows"]


def test_truncation_is_read_from_the_footer_not_inferred(tmp_path, monkeypatch):
    """A guard, and it passed before this change too — recorded as a guard.

    `read_metadata` reads the exact row count from the footer without touching
    the data. The old `len(df) > cap` comparison reached the same verdict here,
    by a worse route (it had already read the whole file). What changed is the
    cost of the answer, not the answer, so this test pins the answer and the two
    above pin the cost."""
    monkeypatch.setattr(inventory, "MAX_INGEST_ROWS", 1_000)
    p = tmp_path / "exact.parquet"
    _write(p, 1_000)
    df, truncated, _ = inventory._load_dataframe(str(p))
    assert len(df) == 1_000
    assert truncated is False, "a file exactly at the cap is complete, not truncated"


def test_an_empty_parquet_keeps_its_schema(tmp_path):
    """Zero rows is an empty inventory, not an unrecognised export: the column
    names must survive so the mapper reports the right thing."""
    p = tmp_path / "empty.parquet"
    _write(p, 0)
    df, truncated, _ = inventory._load_dataframe(str(p))
    assert truncated is False and len(df) == 0
    assert list(df.columns) == ["bucket", "key", "size"]
