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

/** A single function call. */
export function toolTurn(name: string, args: Record<string, unknown>): string[] {
  return [
    chunk({
      role: "assistant",
      tool_calls: [
        { index: 0, id: "call_fake_1", type: "function", function: { name, arguments: JSON.stringify(args) } },
      ],
    }),
    chunk({}, "tool_calls"),
  ];
}

export interface FakeModel {
  baseUrl: string;
  requests: unknown[];
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
export async function startFakeModel(
  turns: string[][],
  opts: { deltaDelayMs?: number } = {},
): Promise<FakeModel> {
  const requests: unknown[] = [];
  const delay = opts.deltaDelayMs ?? 0;
  let i = 0;

  const server = http.createServer((req, res) => {
    const body: Buffer[] = [];
    req.on("data", (c: Buffer) => body.push(c));
    req.on("end", async () => {
      try {
        requests.push(JSON.parse(Buffer.concat(body).toString() || "{}"));
      } catch {
        requests.push({});
      }
      const take = turns[Math.min(i, turns.length - 1)];
      i += 1;
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
