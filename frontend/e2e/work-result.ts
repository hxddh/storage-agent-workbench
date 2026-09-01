import { expect, type Page } from "@playwright/test";

/**
 * Durable Work Result only. Live streaming uses the same test id with
 * data-streaming="true" and a different aria-label; waiting on any copy of
 * the answer in `main` fails strict-mode when both are still on screen.
 */
export function durableWorkResult(page: Page) {
  return page.locator('[data-testid="work-result"][data-streaming="false"]');
}

export async function waitForDurableAnswer(
  page: Page,
  pattern: string | RegExp,
  timeout = 120_000,
) {
  await expect(durableWorkResult(page).filter({ hasText: pattern }).last()).toBeVisible({
    timeout,
  });
  await expect(page.getByTestId("agent-composer")).not.toHaveAttribute(
    "data-agent-state",
    "working",
    { timeout: 30_000 },
  );
}
