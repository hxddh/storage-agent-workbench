import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { screen } from 'electron'

export interface WindowBounds {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

const FALLBACK: WindowBounds = { width: 1180, height: 800 }

export function loadWindowBounds(userData: string): WindowBounds {
  try {
    const raw = JSON.parse(readFileSync(join(userData, 'window.json'), 'utf8')) as WindowBounds
    if (typeof raw?.width !== 'number' || typeof raw?.height !== 'number') return FALLBACK
    const width = Math.max(760, Math.min(Math.round(raw.width), 4000))
    const height = Math.max(520, Math.min(Math.round(raw.height), 3000))
    if (typeof raw.x === 'number' && typeof raw.y === 'number') {
      const visible = screen.getAllDisplays().some((display) => {
        const area = display.workArea
        return (
          raw.x! >= area.x - 40 &&
          raw.x! < area.x + area.width - 40 &&
          raw.y! >= area.y - 20 &&
          raw.y! < area.y + area.height - 20
        )
      })
      if (visible) {
        return {
          width,
          height,
          x: Math.round(raw.x),
          y: Math.round(raw.y),
          maximized: Boolean(raw.maximized),
        }
      }
    }
    return { width, height, maximized: Boolean(raw.maximized) }
  } catch {
    return FALLBACK
  }
}

export function saveWindowBounds(userData: string, bounds: WindowBounds): void {
  try {
    writeFileSync(join(userData, 'window.json'), JSON.stringify(bounds), { mode: 0o600 })
  } catch {
    // Losing the window size is not worth surfacing.
  }
}
