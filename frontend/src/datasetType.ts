/**
 * Which engine an attached file should be parsed by.
 *
 * Two shapes ship: an S3 inventory (a row per object) and access logs (a row
 * per request). They are analysed by different engines, so guessing wrong is not
 * a cosmetic mistake — the file is read as the wrong thing.
 *
 * The name hint has to run BEFORE the extension rule: `access-logs.parquet` and
 * `s3_access_log.csv` are columnar ACCESS-LOG exports that the extension rule
 * alone chipped as "inventory". But the hint used a raw substring test, and
 * `"catalog".includes("log")` is true — so `catalog.csv`, `logistics.csv`,
 * `backlog.csv`, `dialog.csv` and even `logical-inventory.parquet` (a filename
 * that says *inventory*) were all routed to the access-log engine. `access` had
 * the same problem: `accessories.csv`.
 *
 * Matching is now on word-ish boundaries, with the common run-together spellings
 * (`accesslog`, `accesslogs`) named explicitly rather than reached by accident.
 */

/** `access` / `log` / `logs` / `accesslog(s)` as a whole word, not as a syllable. */
const ACCESS_LOG_NAME = /(^|[^a-z])(accesslogs?|access|logs?)([^a-z]|$)/;

const INVENTORY_EXT = /\.(csv|parquet|tsv)(\.gz)?$/;
// JSONL is a fully-supported access-log shape (the backend parses it).
const ACCESS_LOG_EXT = /\.(log|txt|json|jsonl)(\.gz)?$/;

/**
 * `null` = genuinely ambiguous; the composer then asks instead of guessing.
 */
export function inferDatasetType(name: string): "inventory" | "access_log" | null {
  const n = name.toLowerCase();
  if (ACCESS_LOG_NAME.test(n)) return "access_log";
  if (INVENTORY_EXT.test(n)) return "inventory";
  if (ACCESS_LOG_EXT.test(n)) return "access_log";
  return null;
}
