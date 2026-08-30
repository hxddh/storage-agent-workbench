import type { Page } from "@playwright/test";

export const sidecarOrigin = () =>
  `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || 8799}`;

/** Capture live `/agent-tasks` traffic so specs can assert the durable surface. */
export function watchAgentTaskSurface(page: Page) {
  const hits: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    const i = url.indexOf("/agent-tasks/");
    if (i >= 0) hits.push(`${req.method()} ${url.slice(i)}`);
    else if (url.includes("/agent-tasks")) hits.push(`${req.method()} ${new URL(url).pathname}${new URL(url).search}`);
  });
  return {
    hits,
    saw: (pattern: RegExp) => hits.some((hit) => pattern.test(hit)),
    taskId: () => {
      for (const hit of hits) {
        const match = hit.match(/\/agent-tasks\/([^/?]+)/);
        if (match && match[1] !== "") return match[1];
      }
      return null;
    },
  };
}
