import { expect, test } from "@playwright/test";

/**
 * The empty thread is a place to begin, not a poster in the middle of a wall.
 *
 * At 1440×900 the whole start block was vertically centred. The content itself
 * is only a few hundred pixels high, so centring it leaves two large, equally
 * empty regions around the one control the user came here to use. That is the
 * remaining "start surface floats in a large void" finding from the v0.90 pass.
 *
 * Assert the rendered geometry, not a utility class: the first painted content
 * belongs in the upper reading band, while retaining deliberate breathing room
 * above it. The ratio makes the check independent of titlebar/host differences.
 */
test("the start surface begins in the upper reading band", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const main = page.getByRole("main", { name: /conversation/i });
  const heading = main.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible({ timeout: 30_000 });

  const geometry = await page.evaluate(() => {
    const root = document.querySelector("main") as HTMLElement;
    const h1 = root.querySelector("h1") as HTMLElement;
    const area = root.getBoundingClientRect();
    const head = h1.getBoundingClientRect();
    return {
      height: Math.round(area.height),
      top: Math.round(head.top - area.top),
    };
  });

  // Enough air to read as a start surface, but not enough to make it float in
  // the middle of an otherwise empty screen. On a 900px reading area this upper
  // band ends at 162px.
  expect(geometry.top).toBeGreaterThanOrEqual(48);
  expect(
    geometry.top / geometry.height,
    `start heading is ${geometry.top}px into a ${geometry.height}px reading area`,
  ).toBeLessThanOrEqual(0.18);
});
