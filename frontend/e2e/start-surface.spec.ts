import { expect, test } from "@playwright/test";

/**
 * The empty Agent task is a place to delegate work, not a poster floating in a
 * wall of empty space. Assert rendered geometry rather than styling utilities.
 */
test("the task start surface begins in the upper reading band", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const main = page.getByRole("main", { name: /^Agent task$/i });
  const heading = main.getByRole("heading", { level: 1, name: /Delegate a goal to the Agent/i });
  await expect(heading).toBeVisible({ timeout: 30_000 });

  const geometry = await main.evaluate((root) => {
    const h1 = root.querySelector("h1") as HTMLElement;
    const area = root.getBoundingClientRect();
    const head = h1.getBoundingClientRect();
    return { height: Math.round(area.height), top: Math.round(head.top - area.top) };
  });

  expect(geometry.top).toBeGreaterThanOrEqual(48);
  expect(
    geometry.top / geometry.height,
    `task start heading is ${geometry.top}px into a ${geometry.height}px work area`,
  ).toBeLessThanOrEqual(0.18);
});
