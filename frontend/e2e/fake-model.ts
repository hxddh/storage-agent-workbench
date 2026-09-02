import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local OpenAI-compatible endpoint, so the E2E can run a REAL agent turn.
 *
 * Every spec in this suite runs with no model provider, which is deliberate —
 * the offline paths must work on a fresh install. But it also means the app's
 * MAIN path had never been driven through a browser at all: ask a question,
 * watch tools run, watch the answer stream, then see it become a persisted turn
 * with a footer and actions under it. That last step is exactly where the
 * shipped v0.63.0 bug was felt, and no browser test could reach it.
 *
 * The sidecar puts the provider's `base_url` on its own client and speaks
 * `/chat/completions`, so a socket that speaks that is a model as far as the app
 * is concerned. This one serves a scripted conversation.
 *
 * It is a TEST DOUBLE: it validates nothing and speaks only the subset the SDK
 * sends for a streamed chat completion.
 */

function chunk(delta: unknown, finish: string | null = null): string {
  return (
    "data: " +
    JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
    }) +
    "\n\n"
  );
}

/** A final answer, streamed in several deltas so the UI's assembly is exercised. */
export function textTurn(text: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += 24) parts.push(text.slice(i, i + 24));
  return [
    chunk({ role: "assistant", content: parts[0] ?? "" }),
    ...parts.slice(1).map((p) => chunk({ content: p })),
    chunk({}, "stop"),
  ];
}

/**
 * A tool call ID has to be unique per invocation, the way a real model's is.
 *
 * This was a constant `"call_fake_1"`, which no real model would ever send: a
 * two-step turn then reused one completed call's ID for a different tool.
 * openai-agents 0.20.0 added a check for exactly that and refuses the turn with
 * "Model reused a completed tool call ID for a different invocation", which is
 * the SDK being right about a broken double — the app was never involved. It
 * cost the 0.20.0 upgrade a release (see CHANGELOG 0.77.0) because the symptom
 * read as "the turn never starts": the error renders as a banner on the start
 * surface with the question still in the composer.
 */
let callSeq = 0;

/** A single function call. */
export function toolTurn(name: string, args: Record<string, unknown>): string[] {
  return [
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `call_fake_${++callSeq}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }),
    chunk({}, "tool_calls"),
  ];
}

/** A scripted turn, or one computed from the request the model just received.
 *
 * Reactive turns exist because some tools take an id the script cannot know:
 * `analyze_uploaded_file(dataset_id)` needs the id that `list_uploaded_files`
 * just returned. A real model reads it out of the tool result, so the double
 * has to be able to as well — otherwise the only testable shape is a tool call
 * with constant arguments, which is not what the agent does.
 */
export type Turn = string[] | ((req: ChatRequest) => string[]);

export interface ChatRequest {
  messages?: Array<{ role?: string; content?: unknown }>;
}

/** The text of every tool result in the request, concatenated. */
export function toolResults(req: ChatRequest): string {
  return (req.messages ?? [])
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

export interface FakeModel {
  baseUrl: string;
  requests: unknown[];
  /** The title-step requests (see TITLE_MARKER), kept apart from `requests`. */
  titleRequests: unknown[];
  close: () => Promise<void>;
}

/**
 * Serve `turns` one per request; the last repeats if asked again.
 *
 * `deltaDelayMs` spaces the chunks out. A model that answers instantly leaves no
 * window to press Stop in, so cancellation could not be tested at all — this is
 * the knob that makes a turn last long enough to interrupt, the way a real one
 * does.
 */
function requestSignature(body: unknown): string {
  const req = (body ?? {}) as ChatRequest;
  const messages = req.messages ?? [];
  return messages
    .map((m) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      return `${m.role ?? ""}:${content.length}:${content.slice(0, 96)}`;
    })
    .join("|");
}

/** The runtime's title step marks its one bounded request with this token
 * (sidecar `task_runtime/titling.py`). The fake answers it out of band —
 * never consuming a scripted turn, never appearing in `requests` — so every
 * existing script keeps its turn order. `opts.title` is what it answers; an
 * empty answer keeps the deterministic seed title. */
const TITLE_MARKER = "[[storage-agent:title]]";

export async function startFakeModel(
  turns: Turn[],
  opts: { deltaDelayMs?: number; title?: string } = {},
): Promise<FakeModel> {
  const requests: unknown[] = [];
  const titleRequests: unknown[] = [];
  const delay = opts.deltaDelayMs ?? 0;
  let i = 0;
  // Playwright retries and SDK reconnects re-POST the same completion. Replay
  // by request signature so a retry cannot consume the next scripted turn.
  const replay = new Map<string, string[]>();

  const server = http.createServer((req, res) => {
    const body: Buffer[] = [];
    req.on("data", (c: Buffer) => body.push(c));
    req.on("end", async () => {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(Buffer.concat(body).toString() || "{}");
      } catch {
        parsed = {};
      }
      if (JSON.stringify(parsed).includes(TITLE_MARKER)) {
        titleRequests.push(parsed);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        for (const c of textTurn(opts.title ?? "")) res.write(c);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      requests.push(parsed);
      const signature = requestSignature(parsed);
      let take = replay.get(signature);
      if (!take) {
        const chosen = turns[Math.min(i, turns.length - 1)];
        take =
          typeof chosen === "function"
            ? chosen(parsed as ChatRequest)
            : chosen;
        replay.set(signature, take);
        if (i < turns.length) i += 1;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      for (const c of take) {
        if (res.writableEnded || res.destroyed) return; // the client hung up: stop
        res.write(c);
        if (delay) await new Promise((r) => setTimeout(r, delay));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    titleRequests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const SIDECAR = `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || 8799}`;

/** Point the app at the fake model; returns the created provider id. */
export async function useFakeModel(baseUrl: string): Promise<string> {
  const res = await fetch(`${SIDECAR}/model-providers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "fake",
      provider_type: "openai-compatible",
      base_url: baseUrl,
      model: "fake-model",
      api_key: "not-a-real-key",
    }),
  });
  if (!res.ok) throw new Error(`could not configure the fake model: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

/** Remove it again, so the other specs keep their no-model fresh install. */
export async function dropModelProvider(id: string): Promise<void> {
  await fetch(`${SIDECAR}/model-providers/${id}`, { method: "DELETE" }).catch(() => undefined);
}
