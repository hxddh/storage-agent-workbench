import type { Table } from '@shared/contract'

function escapeCell(value: string | number | null): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(table: Table): string {
  return [table.columns, ...table.rows].map((row) => row.map(escapeCell).join(',')).join('\n')
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function safeFileName(value: string, extension: string): string {
  const base = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 60)
  return `${base || 'storage-agent'}.${extension}`
}
