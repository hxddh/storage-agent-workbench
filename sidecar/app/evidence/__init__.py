"""Managed evidence import.

Bounded, confirmation-gated retrieval of evidence files (inventory reports /
server access logs) from sources DISCOVERED by account_discovery, fed into the
existing DuckDB analysis path. Never scans business buckets, never downloads
business object bodies, never mutates anything.
"""
