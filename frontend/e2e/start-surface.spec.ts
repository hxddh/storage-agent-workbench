import { expect, test } from "@playwright/test";

/**
 * The empty Agent task is a greeting and the Composer in the middle band of
 * the work area — not a poster in the top corner, not a wizard. Assert
 * rendered geometry rather than styling utilities.
 */
test("the task start surface sits in the middle band with the Composer", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const main = page.getByRole("main", { name: /^Agent task$/i });
  const composer = main.getByTestId("agent-composer");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await expect(composer.getByRole("textbox")).toHaveAttribute("placeholder", /Describe the storage work to delegate/);
  await expect(main.getByRole("heading", { level: 1 })).toHaveCount(0);
  await expect(main.getByTestId("task-start")).toBeVisible();
  // The greeting rotates by hour of day; every variant is one question line.
  await expect(main.locator(".native-start-greeting")).toBeVisible();
  await expect(main.locator(".native-start-greeting")).toHaveText(/Agent/);
  await expect(page.getByTestId("delegate-suggestion-checkup")).toHaveCount(0);
  await expect(page.getByTestId("model-chip")).toBeVisible();

  const geometry = await main.evaluate((root) => {
    const box = root.querySelector('[data-testid="agent-composer"]') as HTMLElement;
    const area = root.getBoundingClientRect();
    const head = box.getBoundingClientRect();
    return { height: Math.round(area.height), top: Math.round(head.top - area.top), bottom: Math.round(head.bottom - area.top) };
  });

  const centre = (geometry.top + geometry.bottom) / 2 / geometry.height;
  expect(centre, `composer centre is ${Math.round(centre * 100)}% down a ${geometry.height}px work area`).toBeGreaterThanOrEqual(0.28);
  expect(centre).toBeLessThanOrEqual(0.62);
});
