import { expect, test } from "@playwright/test";

/**
 * The deterministic engines are discoverable in the command palette —
 * not in painted hints, not in model prose. Each engine entry fills the
 * Composer with a full-sentence draft (reviewed before sending) instead of
 * navigating anywhere.
 */
test("palette engine entries prefill the Composer with a reviewable draft", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");

  const composer = page.getByTestId("agent-composer").getByRole("textbox");
  await expect(composer).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("titlebar-palette").click();
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await expect(page.getByTestId("command-palette-engines")).toBeVisible();

  await page.getByText("Analyze storage costs", { exact: true }).click();
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  await expect(composer).toHaveValue(/which buckets cost the most/);
  // A prefill is a draft, never a send: nothing executes by itself.
  await expect(page.getByTestId("task-start")).toBeVisible();
});
