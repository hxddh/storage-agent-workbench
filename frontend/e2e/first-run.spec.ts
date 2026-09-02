import { expect, test } from "@playwright/test";

/**
 * Empty start is the Composer. Missing model is a banner + Settings, not a
 * first-run wizard, SKU menu, or stacked card.
 */
test.describe("empty Agent start", () => {
  test("a fresh window is the Composer, not a configuration wizard", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("saw.lang", "en");
      localStorage.removeItem("saw.onboarded");
    });
    await page.goto("/");
    await expect(page.getByTestId("agent-composer")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("agent-first-run")).toHaveCount(0);
    await expect(page.getByTestId("first-run-resume")).toHaveCount(0);
    await expect(page.getByTestId("agent-composer").getByRole("textbox")).toHaveAttribute(
      "placeholder",
      /Ask about your storage/,
    );
  });
});
