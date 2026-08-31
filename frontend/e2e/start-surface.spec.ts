import { expect, test } from "@playwright/test";

/**
 * The empty Agent task is a place to type in the Composer, not a poster
 * floating in a wall of empty space. Assert rendered geometry rather than
 * styling utilities.
 */
test("the task start surface begins in the upper reading band", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const main = page.getByRole("main", { name: /^Agent task$/i });
  const composer = main.getByTestId("agent-composer");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await expect(composer.getByRole("textbox")).toHaveAttribute("placeholder", /Give the Agent a goal/);
  await expect(main.getByRole("heading", { level: 1 })).toHaveCount(0);
  await expect(page.getByTestId("delegate-suggestion-checkup")).toHaveCount(0);

  const geometry = await main.evaluate((root) => {
    const box = root.querySelector('[data-testid="agent-composer"]') as HTMLElement;
    const area = root.getBoundingClientRect();
    const head = box.getBoundingClientRect();
    return { height: Math.round(area.height), top: Math.round(head.top - area.top) };
  });

  expect(geometry.top).toBeGreaterThanOrEqual(48);
  expect(
    geometry.top / geometry.height,
    `task start composer is ${geometry.top}px into a ${geometry.height}px work area`,
  ).toBeLessThanOrEqual(0.18);
});
