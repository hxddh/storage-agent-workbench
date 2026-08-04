import { expect, test, type Page } from "@playwright/test";

/**
 * The session inspector (v0.45.0) against a live sidecar, with no model provider.
 *
 * These paths are exactly the ones unit tests can't reach: the inspector reads
 * three real endpoints backed by real SQLite rows. What is asserted is the
 * product's honesty contract — an endpoint that reported no token usage must
 * surface as "not reported", never as a confident zero — plus that one timeline
 * with additive filters is what actually renders (not a set of tabs).
 */

async function seedFreshApp(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
}

const composer = (page: Page) => page.getByPlaceholder(/Ask Storage Agent/i);
const inspector = (page: Page) => page.getByTestId("session-inspector");

/** Create a session by sending anything — offline triage answers without a model. */
async function startSession(page: Page) {
  await seedFreshApp(page);
  await page.goto("/");
  const box = composer(page);
  await box.click();
  await box.fill("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>");
  await box.press("Enter");
  await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });
}

test.describe("session inspector", () => {
  test("opens from the thread header and reports honestly on an empty session", async ({ page }) => {
    await startSession(page);

    await page.getByTestId("open-inspector").click();
    await expect(inspector(page)).toBeVisible();

    // The overview band renders its four stats.
    await expect(inspector(page).getByText("Tool calls")).toBeVisible();
    await expect(inspector(page).getByText("Audit events")).toBeVisible();

    // No model provider ran, so no turn ever reported tokens. That must read as
    // an absence, not as zero spend.
    await expect(inspector(page).getByText(/not reported by the provider/i)).toBeVisible();
  });

  test("filters are additive chips over ONE timeline, not tabs", async ({ page }) => {
    await startSession(page);
    await page.getByTestId("open-inspector").click();
    await expect(inspector(page)).toBeVisible();

    const tools = inspector(page).getByRole("button", { name: /^Tools/ });
    const audit = inspector(page).getByRole("button", { name: /^Audit/ });
    // Both are ON at once — a tabbed design could never show that state, and
    // the interleaved ordering is what explains what led to what.
    await expect(tools).toHaveAttribute("aria-pressed", "true");
    await expect(audit).toHaveAttribute("aria-pressed", "true");

    await tools.click();
    await expect(tools).toHaveAttribute("aria-pressed", "false");
    await expect(audit).toHaveAttribute("aria-pressed", "true");
  });

  test("closes with Escape", async ({ page }) => {
    await startSession(page);
    await page.getByTestId("open-inspector").click();
    await expect(inspector(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(inspector(page)).toHaveCount(0);
  });
});
