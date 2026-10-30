import { open } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { agentTool, PIECE, resultPath, type ToolDeps, Type } from './policy'

const IMAGES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * Where a name points in the task: a call's evidence id (its kept result), an
 * object body (`objects/<id>.bin`) or an attached file (`attachment:<name>`).
 */
export function locate(
  deps: ToolDeps,
  conversationId: string,
  name: string,
): { path: string; unit: 'bytes' | 'characters'; mime: string | null } {
  if (/^objects\/[A-Za-z0-9._-]+$/.test(name))
    return { path: join(deps.taskDir(conversationId), name), unit: 'bytes', mime: null }
  const attachment = /^attachment:([^/\\]+)$/.exec(name)?.[1]
  if (attachment)
    return {
      path: join(deps.uploadsDir(conversationId), attachment),
      unit: 'bytes',
      mime: IMAGES[extname(attachment).toLowerCase()] ?? null,
    }
  return { path: resultPath(deps, conversationId, name), unit: 'characters', mime: null }
}

/** One stretch of a kept result, object body or attachment, read without loading the rest. */
export async function readPart(
  deps: ToolDeps,
  conversationId: string,
  name: string,
  offset: number,
  length: number,
): Promise<{
  text: string
  base64?: string
  mime: string | null
  start: number
  end: number
  total: number
  unit: 'bytes' | 'characters'
}> {
  const where = locate(deps, conversationId, name)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(where.path, 'r')
  } catch {
    throw new Error(
      `Nothing named "${name}" in this task: give a call's evidence id, an object ref (objects/…) or attachment:<file name>.`,
    )
  }
  try {
    if (where.unit === 'characters') {
      const kept = (await handle.readFile()).toString('utf8')
      const start = Math.min(offset, kept.length)
      const text = kept.slice(start, start + length)
      return {
        text,
        mime: null,
        start,
        end: start + text.length,
        total: kept.length,
        unit: 'characters',
      }
    }
    const size = (await handle.stat()).size
    const start = Math.min(offset, size)
    const buffer = Buffer.alloc(Math.min(length, size - start))
    await handle.read(buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    const binary =
      text.includes('\u0000') || (text.match(/�/g)?.length ?? 0) > Math.max(4, text.length / 50)
    return {
      text: binary ? '' : text,
      ...(binary ? { base64: buffer.toString('base64') } : {}),
      mime: where.mime,
      start,
      end: start + buffer.length,
      total: size,
      unit: 'bytes',
    }
  } finally {
    await handle.close()
  }
}

/** Read any stretch of what the task holds: a call's result, an object body, an attachment. */
export function moreTool(deps: ToolDeps) {
  return agentTool(deps, {
    name: 'more',
    description: `Read what this task holds, from any offset: a call's whole result again by its evidence id (every result is kept, so this works after the conversation was compacted too), an object body by its ref (objects/…), or a file the user attached as attachment:<file name>. An attached image comes back as an image the model can see. length defaults to one piece (${PIECE.toLocaleString('en-US')}).`,
    parameters: Type.Object({
      evidence: Type.String({
        description: "A call's evidence id, an object ref (objects/…) or attachment:<file name>.",
      }),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: 'Where to start: characters for a result, bytes for a body or file.',
        }),
      ),
      length: Type.Optional(Type.Integer({ minimum: 1, description: 'How much to read.' })),
    }),
    target: (args) => `${args.evidence} @ ${args.offset ?? 0}`,
    run: async (args, run) => {
      const offset = args.offset ?? 0
      const where = locate(deps, run.conversationId, args.evidence)
      // An image is read whole and shown to the model; its bytes are not text.
      if (where.mime && offset === 0) {
        const part = await readPart(
          deps,
          run.conversationId,
          args.evidence,
          0,
          Number.MAX_SAFE_INTEGER,
        )
        const data = part.base64 ?? Buffer.from(part.text, 'utf8').toString('base64')
        return {
          model: `${args.evidence}: an image (${where.mime}, ${part.total.toLocaleString('en-US')} bytes), attached below.`,
          note: `image · ${part.total.toLocaleString('en-US')} bytes`,
          view: { kind: 'note' as const, text: `Image ${args.evidence}` },
          images: [{ data, mimeType: where.mime }],
        }
      }
      const part = await readPart(
        deps,
        run.conversationId,
        args.evidence,
        offset,
        args.length ?? PIECE,
      )
      const rest = part.total - part.end
      const body = part.base64 !== undefined ? `base64:${part.base64}` : part.text
      return {
        model: `${body}${rest > 0 ? `\n… ${rest} more ${part.unit} (offset ${part.end}).` : '\n(end)'}`,
        note: `${part.start.toLocaleString('en-US')}–${part.end.toLocaleString('en-US')} of ${part.total.toLocaleString('en-US')} ${part.unit}`,
        view: {
          kind: 'note' as const,
          text: `${part.unit === 'bytes' ? 'Bytes' : 'Characters'} ${part.start}–${part.end} of ${part.total}.`,
        },
      }
    },
  })
}
