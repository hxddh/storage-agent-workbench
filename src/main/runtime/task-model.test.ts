import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectLocalModels, isLoopback } from '../local-models'
import { Settings, type StoredModel } from '../settings'
import { PIECE, pieceFor } from '../tools/policy'
import { resolveTaskModel } from './engine'

const anthropic: StoredModel = {
  provider: 'anthropic',
  modelId: 'claude-opus-5-5',
  baseUrl: '',
  contextWindow: 200_000,
  thinking: 'medium',
  keyRef: 'aes:anthropic',
}
const openai: StoredModel = {
  provider: 'openai',
  modelId: 'gpt-6-sol',
  baseUrl: '',
  contextWindow: 400_000,
  thinking: 'low',
  keyRef: 'aes:openai',
}

describe('a task model', () => {
  it('runs with the key and window saved for that model, whatever the default is', () => {
    const settings = new Settings(mkdtempSync(join(tmpdir(), 'settings-')))
    settings.setModel(openai)
    settings.setModel(anthropic)
    expect(settings.get().model?.provider).toBe('anthropic')
    const { model, directKey } = resolveTaskModel(
      anthropic,
      { provider: 'openai', modelId: 'gpt-6-sol', baseUrl: null, thinking: 'high' },
      (ref) => settings.saved(ref),
    )
    expect(model).toMatchObject({ keyRef: 'aes:openai', contextWindow: 400_000, thinking: 'high' })
    expect(directKey).toBeUndefined()
  })

  it('keeps every saved model across a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-'))
    const first = new Settings(dir)
    first.setModel(openai)
    first.setModel(anthropic)
    expect(
      new Settings(dir)
        .get()
        .models.map((item) => item.provider)
        .sort(),
    ).toEqual(['anthropic', 'openai'])
  })

  it('runs a model on this machine without a key, with a window its server keeps', () => {
    const { model, directKey } = resolveTaskModel(
      anthropic,
      {
        provider: 'compatible',
        modelId: 'qwen3:8b',
        baseUrl: 'http://127.0.0.1:11434/v1',
        thinking: 'off',
      },
      () => null,
    )
    expect(directKey).toBe('local')
    expect(model.contextWindow).toBe(4096)
  })

  it('says what to do for a model of another provider that has no saved key', () => {
    expect(() =>
      resolveTaskModel(
        anthropic,
        { provider: 'openai', modelId: 'gpt-6-sol', baseUrl: null, thinking: 'off' },
        () => null,
      ),
    ).toThrow(/Save it in Settings/)
  })

  it("uses the default's key for another model of the same provider", () => {
    const { model } = resolveTaskModel(
      anthropic,
      { provider: 'anthropic', modelId: 'claude-haiku-5-5', baseUrl: null, thinking: 'off' },
      () => null,
    )
    expect(model).toMatchObject({ keyRef: 'aes:anthropic', modelId: 'claude-haiku-5-5' })
  })
})

describe('pieces that fit the model', () => {
  it('gives a small window small pieces and caps a large one', () => {
    expect(pieceFor(4096)).toBe(3276)
    expect(pieceFor(200_000)).toBe(PIECE)
    expect(pieceFor(undefined)).toBe(PIECE)
  })
})

describe('local models', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reports the window a loaded Ollama model runs with, and the server default otherwise', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const body: Record<string, unknown> = {
        'http://127.0.0.1:11434/api/tags': { models: [{ name: 'qwen3:8b' }, { name: 'llama4' }] },
        'http://127.0.0.1:11434/api/ps': { models: [{ name: 'qwen3:8b', context_length: 32768 }] },
      }
      return url in body
        ? new Response(JSON.stringify(body[url]))
        : new Response('no', { status: 404 })
    })
    expect(await detectLocalModels()).toEqual([
      expect.objectContaining({ modelId: 'qwen3:8b', contextWindow: 32768 }),
      expect.objectContaining({ modelId: 'llama4', contextWindow: 4096 }),
    ])
  })

  it('knows a loopback endpoint', () => {
    expect(isLoopback('http://localhost:1234/v1')).toBe(true)
    expect(isLoopback('https://api.example.com/v1')).toBe(false)
  })
})
