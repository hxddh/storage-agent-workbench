import { expect, test, type Page } from "@playwright/test";

/**
 * End-to-end smoke: the investigation workbench against a live sidecar.
 *
 * Everything here runs WITHOUT a model provider or cloud credentials — that is
 * the point. The offline paths (deterministic error triage, session CRUD,
 * settings) are what a user hits on a fresh install, they need no LLM, and they
 * are the integration seam that unit tests can't reach: composer → HTTP →
 * SQLite → render. A model-backed turn is deliberately out of scope; it would
 * need a live provider key and would make the gate flaky.
 */

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

const composer = (page: Page) => page.getByPlaceholder(/Ask Storage Agent/i);

test.describe("workbench smoke", () => {
  test("app boots and reaches the sidecar", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");

    await expect(composer(page)).toBeVisible();
    await expect(page.getByRole("button", { name: /new investigation/i })).toBeVisible();
    await expect(page.getByText(/sidecar (not|un)/i)).toHaveCount(0);
  });

  test("pasting an S3 error triages it offline, with no model provider", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");

    const box = composer(page);
    await box.click();
    await box.fill(
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
        "<Error><Code>AccessDenied</Code><Message>Access Denied</Message>" +
        "<RequestId>ABC123</RequestId></Error>",
    );
    await box.press("Enter");

    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });
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

    await page.reload();
    await expect(composer(page)).toBeVisible();
    await expect(page.getByText(/no investigations yet/i)).toHaveCount(0);
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

    const wizard = page.getByRole("dialog").or(page.getByText(/get started|welcome/i)).first();
    await expect(wizard).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /skip|later|close|done|finish/i }).first().click();
    await expect(composer(page)).toBeVisible();

    await page.reload();
    await expect(composer(page)).toBeVisible();
  });
});

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
    await expect(card).toContainText("ABC123");
    await expect(card).toContainText("acme-logs");

    await expect(page.getByText(/Thinking/)).toHaveCount(0, { timeout: 30_000 });
    await page.waitForTimeout(500);

    await expect(card.locator("pre")).toHaveCount(0);
    await page.getByTestId("s3-error-raw-toggle").click();
    await expect(card.locator("pre")).toContainText("<?xml version");
  });

  test("a question that merely quotes one stays prose", async ({ page }) => {
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
  await expect(box).toHaveValue(/why does my bucket deny list calls/);
});

test("the thread stops inviting actions it cannot perform", async ({ page }) => {
  await seedFreshApp(page);
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("offline-banner")).toHaveCount(0);
  const start = page.getByRole("button", { name: /diagnose an error/i });
  await expect(start).toBeEnabled();

  await page.route("**/health", (r) => r.abort());
  await expect(page.getByTestId("offline-banner")).toBeVisible({ timeout: 20_000 });
  await expect(start).toBeDisabled();

  await composer(page).click();
  await composer(page).fill("this must not be thrown away");
  await expect(composer(page)).toHaveValue("this must not be thrown away");
});

test("an unrecognised failure is framed, not dumped", async ({ page }) => {
  await seedFreshApp(page);
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await page.route("**/messages**", (r) => r.fulfill({ status: 500, body: '{"detail":"boom"}' }));

  await composer(page).click();
  await composer(page).fill("why does acme-logs deny list");
  await composer(page).press("Enter");

  await expect(page.getByText(/Couldn’t send your message/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/boom/)).toBeVisible();
  await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();
});
