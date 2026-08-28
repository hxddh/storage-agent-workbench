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

/**
 * The app recognises its own domain's objects.
 *
 * An S3 error body is the signature input here — it is what a person is looking
 * at when they open the app at all — and the thread rendered it as a wall of
 * angle brackets in a grey bubble. A storage tool that cannot read a storage
 * error is asking the person to be the parser.
 */
test.describe("a pasted storage error", () => {
  const BODY =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    "<Error><Code>AccessDenied</Code><Message>Access Denied</Message>" +
    "<RequestId>ABC123</RequestId><BucketName>acme-logs</BucketName></Error>";

  test("is read back as the error it is, with the raw body one click away", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = composer(page);
    await box.click();
    await box.fill(BODY);
    await box.press("Enter");

    const card = page.getByTestId("s3-error-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("s3-error-code")).toHaveText("AccessDenied");
    // The identifiers support asks for are not swallowed by the card.
    await expect(card).toContainText("ABC123");
    await expect(card).toContainText("acme-logs");

    // Let the turn settle first: the optimistic message is replaced by the
    // persisted one when the turn ends, which remounts this card. Clicking into
    // that swap detaches the button mid-click.
    await expect(page.getByText(/Thinking/)).toHaveCount(0, { timeout: 30_000 });
    await page.waitForTimeout(500);

    // The raw body is still there, and still exact.
    await expect(card.locator("pre")).toHaveCount(0);
    await page.getByTestId("s3-error-raw-toggle").click();
    await expect(card.locator("pre")).toContainText("<?xml version");
  });

  test("a question that merely quotes one stays prose", async ({ page }) => {
    // Replacing a paragraph with a card because it contains an error body would
    // be the tool overruling the person.
    await seedFreshApp(page);
    await page.goto("/");
    const box = composer(page);
    await box.click();
    await box.fill(
      "I have been chasing this for two days across three roles and two regions and I still " +
        "cannot tell whether it is the policy or the ACL. It only happens from the analytics " +
        "role, never from my laptop: An error occurred (AccessDenied) when calling the " +
        "ListObjectsV2 operation: Denied",
    );
    await box.press("Enter");
    await expect(page.getByText(/chasing this for two days/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("s3-error-card")).toHaveCount(0);
  });
});

/**
 * A failed first turn leaves nothing behind.
 *
 * The session is created before the turn is attempted, because the stream needs
 * an id to attach to. When that first attempt failed — no model key, a rejected
 * provider, a network error — the session survived with zero messages, and the
 * rail collected one dead conversation per attempt. On a fresh install, where
 * "no model key" is the expected outcome until you add one, that is a rail full
 * of identical empty rows before the product has done anything at all.
 *
 * Asserted against the sidecar rather than the rail: the rail is a view, and
 * what was wrong was the record.
 */
test("a send that fails for want of a model does not leave an empty session", async ({ page }) => {
  const api = `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || "8799"}`;
  const count = async () => {
    const j = await (await page.request.get(`${api}/sessions`)).json();
    return (Array.isArray(j) ? j : (j.sessions ?? j.items ?? [])).length;
  };

  await seedFreshApp(page);
  await page.goto("/");
  const before = await count();

  const box = composer(page);
  await box.click();
  await box.fill("why does my bucket deny list calls");
  await box.press("Enter");
  await expect(page.getByText(/Add a model API key/i).first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2500);

  expect(await count()).toBe(before);
  // …and the message is not lost with it: it goes back into the composer.
  await expect(box).toHaveValue(/why does my bucket deny list calls/);
});

/**
 * When the backend is gone, the interface says so and stops offering.
 *
 * Measured before this: with `/health` failing, the ONLY signal anywhere on
 * screen was an 8px dot at the bottom of the rail reading "Disconnected". The
 * composer still invited a question, the six starting points still invited a
 * click, and the send button was still the accent colour. Every one of those
 * actions goes through the sidecar; every one of them would have failed. An
 * interface that keeps inviting actions it cannot perform is not "quiet", it is
 * wrong.
 */
test("the thread stops inviting actions it cannot perform", async ({ page }) => {
  await seedFreshApp(page);
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  // Healthy first, so this cannot pass by accident on a page that never loaded.
  await expect(page.getByTestId("offline-banner")).toHaveCount(0);
  const start = page.getByRole("button", { name: /diagnose an error/i });
  await expect(start).toBeEnabled();

  await page.route("**/health", (r) => r.abort());
  await expect(page.getByTestId("offline-banner")).toBeVisible({ timeout: 20_000 });
  await expect(start).toBeDisabled();

  // The field stays typable: losing what someone was writing because a service
  // blinked would be a worse failure than the one being reported.
  await composer(page).click();
  await composer(page).fill("this must not be thrown away");
  await expect(composer(page)).toHaveValue("this must not be thrown away");
});
