import { expect, test, type Page } from "@playwright/test";

/**
 * End-to-end smoke: the thread-first workbench against a live sidecar.
 *
 * Everything here runs WITHOUT a model provider or cloud credentials — that is
 * the point. The offline paths (deterministic error triage, session CRUD,
 * settings) are what a user hits on a fresh install, they need no LLM, and they
 * are the integration seam that unit tests can't reach: composer → HTTP →
 * SQLite → render. A model-backed turn is deliberately out of scope; it would
 * need a live provider key and would make the gate flaky.
 */

/** Pin locale and skip the first-run wizard for the tests that aren't about it.
 * `saw.lang` keeps text assertions stable regardless of the runner's
 * `navigator.language`; `saw.onboarded` is the same flag the wizard sets when
 * dismissed. */
async function seedFreshApp(page: Page, opts: { onboarded?: boolean } = {}) {
  await page.addInitScript(
    ([onboarded]) => {
      localStorage.setItem("saw.lang", "en");
      if (onboarded) localStorage.setItem("saw.onboarded", "1");
      else localStorage.removeItem("saw.onboarded");
    },
    [opts.onboarded ?? true],
  );
}

/** The composer's textarea, identified the way a user finds it. */
const composer = (page: Page) => page.getByPlaceholder(/Ask Storage Agent/i);

test.describe("workbench smoke", () => {
  test("app boots and reaches the sidecar", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");

    // The composer only renders once the app has a live sidecar connection, so
    // its presence IS the connectivity assertion.
    await expect(composer(page)).toBeVisible();
    await expect(page.getByRole("button", { name: /new chat/i })).toBeVisible();
    // A failed sidecar handshake renders a blocking status banner instead.
    await expect(page.getByText(/sidecar (not|un)/i)).toHaveCount(0);
  });

  test("pasting an S3 error triages it offline, with no model provider", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");

    const box = composer(page);
    await box.click();
    // A real AccessDenied body: the turn attempt 422s (no provider), and the
    // client falls back to the deterministic triage engine — the documented
    // "works on a fresh install with no credentials" path.
    await box.fill(
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
        "<Error><Code>AccessDenied</Code><Message>Access Denied</Message>" +
        "<RequestId>ABC123</RequestId></Error>",
    );
    await box.press("Enter");

    // The triage case renders as an inline card in the thread.
    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });
    // And it is GROUNDED: the deterministic engine names the code it parsed,
    // not a generic "something went wrong".
    await expect(page.getByText(/AccessDenied/).first()).toBeVisible();
  });

  test("a session created by that turn survives a reload", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");

    const box = composer(page);
    await box.click();
    await box.fill("HTTP 403 Forbidden from the bucket endpoint");
    await box.press("Enter");
    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });

    // Reload: the rail must rebuild from SQLite through /sessions, so at least
    // one chat entry is listed and the empty-state copy is gone.
    await page.reload();
    await expect(composer(page)).toBeVisible();
    await expect(page.getByText(/no chats yet/i)).toHaveCount(0);
  });

  test("settings drawer opens and offers provider management", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    await expect(composer(page)).toBeVisible();

    await page.getByRole("button", { name: /settings/i }).first().click();
    await expect(page.getByText(/settings & providers/i)).toBeVisible();
  });

  test("first-run wizard appears on a truly fresh install and dismisses", async ({ page }) => {
    await seedFreshApp(page, { onboarded: false });
    await page.goto("/");

    // No providers configured + never onboarded → the wizard takes over.
    const wizard = page.getByRole("dialog").or(page.getByText(/get started|welcome/i)).first();
    await expect(wizard).toBeVisible({ timeout: 15_000 });

    // Dismissing it must reveal the thread and STAY dismissed across a reload
    // (the flag is persisted, not component state).
    await page.getByRole("button", { name: /skip|later|close|done|finish/i }).first().click();
    await expect(composer(page)).toBeVisible();

    await page.reload();
    await expect(composer(page)).toBeVisible();
  });
});
