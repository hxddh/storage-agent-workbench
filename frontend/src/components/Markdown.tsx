/**
 * Public Answer Document boundary.
 *
 * Parsing, syntax safety, tables, charts and code rendering live behind this
 * module so the conversation layer depends on a document contract rather than a
 * 36 KB parser implementation. v0.91 intentionally keeps the proven renderer
 * byte-for-byte while making future renderer replacement local to this surface.
 */
export * from "./MarkdownImplementation";
