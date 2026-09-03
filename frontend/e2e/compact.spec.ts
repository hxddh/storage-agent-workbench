import { expect, test, type Page } from "@playwright/test";
import { watchAgentTaskSurface } from "./agent-tasks-surface";
import { dropModelProvider, startFakeModel, textTurn, useFakeModel } from "./fake-model";
import { waitForDurableAnswer } from "./work-result";

/**
 * v1.12 — context compaction on demand.
 *
 * The palette's "Compact context" runs the runtime's one tool-less
 * compaction step for an idle task (`POST /agent-tasks/{id}/compact`): the
 * model answers the marked request with a bounded summary, the Sidecar
 * appends `context.compacted` to the task's log, the client toasts the
 * figures, and the next turn opens with the quiet marker. Never a second
 * Agent, never a scripted turn consumed.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");

const FIRST = Array.from(
  { length: 24 },
  (_, i) => `Observation ${i}: the acme bucket policy grants s3:GetObject to every principal.`,
).join(" ");
const SECOND = "After compaction: the policy is still public; nothing else changed.";
const SUMMARY = "Summary: checked acme bucket; policy is public.";

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
}

async function delegate(page: Page, direction: string, answer: RegExp) {
  await composer(page).fill(direction);
  await composer(page).press("Enter");
  await waitForDurableAnswer(page, answer);
  await expect(page.getByTestId("agent-composer")).not.toHaveAttribute("data-agent-state", "working", { timeout: 60_000 });
}

test.describe("Compact context", () => {
  test.describe.configure({ timeout: 120_000 });

  test("the palette compacts an idle task, toasts the figures, and the next turn carries the marker", async ({ page }) => {
    const model = await startFakeModel([textTurn(FIRST), textTurn(SECOND)], { compaction: SUMMARY });
    const providerId = await useFakeModel(model.baseUrl);
    const surface = watchAgentTaskSurface(page);
    try {
      await boot(page);
      await delegate(page, "check the acme bucket policy", /every principal/);
      expect(model.compactionRequests.length).toBe(0);

      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByTestId("command-palette");
      await expect(palette).toBeVisible();
      await palette.getByRole("button", { name: /Compact context/ }).click();

      await expect.poll(() => surface.saw(/POST \/agent-tasks\/.+\/compact/), {
        timeout: 20_000,
        message: "Compact context must call POST /agent-tasks/{id}/compact",
      }).toBe(true);
      await expect(page.getByTestId("toast-viewport")).toContainText(/Context compacted/, { timeout: 30_000 });
      // The compaction step was its own marked request; no scripted turn was used.
      await expect.poll(() => model.compactionRequests.length, { timeout: 20_000 }).toBe(1);
      expect(model.requests.length).toBe(1);
      expect(JSON.stringify(model.compactionRequests[0])).toContain("[[storage-agent:compact]]");

      // The next execution opens on the compacted context: one muted line
      // between segments, never a card, and it persists on the durable turn.
      await delegate(page, "and now?", /nothing else changed/);
      const marker = page.getByTestId("context-compacted");
      await expect(marker.last()).toBeVisible({ timeout: 30_000 });
      await expect(marker.last()).toContainText(/Context compacted/);
      await page.reload();
      await expect(page.getByTestId("context-compacted").last()).toBeVisible({ timeout: 30_000 });
    } finally {
      await dropModelProvider(providerId);
      await model.close();
    }
  });

  test("the palette offers no compaction without a task", async ({ page }) => {
    await boot(page);
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible();
    await expect(palette.getByRole("button", { name: /Compact context/ })).toHaveCount(0);
  });
});
