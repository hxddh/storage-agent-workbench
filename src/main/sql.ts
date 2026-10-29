/** One statement that starts by reading. The dataset opens read-only too. */
export function checkSql(sql: string): void {
  const text = sql.trim().replace(/;\s*$/, '')
  if (!/^(select|with)\b/i.test(text)) throw new Error('sql must be one SELECT (or WITH … SELECT).')
  if (text.includes(';')) throw new Error('sql must be one statement.')
  if (/\bload_extension\b/i.test(text)) throw new Error('sql may not load extensions.')
}
