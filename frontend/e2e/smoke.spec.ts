import { expect, test, type Page } from "@playwright/test";

/**
 * End-to-end smoke for the Agent task lifecycle against a real Sidecar. These
 * paths intentionally need no cloud or model credentials: start surface,
 * deterministic storage-error triage, durable task creation and local settings.
 */
async function seedFreshApp(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
  });
}

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const navigation = (page: Page) => page.getByTestId("agent-task-navigation");

test.describe("Agent task smoke", () => {
  test("app boots, reaches the Sidecar, and exposes task delegation", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    await expect(composer(page)).toBeVisible();
    await expect(navigation(page).getByRole("button", { name: /New task/i })).toBeVisible();
    await expect(page.getByText(/sidecar (not|un)/i)).toHaveCount(0);
  });

  test("pasting an S3 error creates deterministic offline triage without a model", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = composer(page);
    await box.fill(
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
        "<Error><Code>AccessDenied</Code><Message>Access Denied</Message>" +
        "<RequestId>ABC123</RequestId></Error>",
    );
    await box.press("Enter");
    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/AccessDenied/).first()).toBeVisible();
  });

  test("a task created by deterministic triage survives a reload", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = composer(page);
    await box.fill("HTTP 403 Forbidden from the bucket endpoint");
    await box.press("Enter");
    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect(composer(page)).toBeVisible();
    await expect(navigation(page).getByText(/No Agent tasks yet/i)).toHaveCount(0);
  });

  test("settings drawer opens and offers provider management", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    await expect(composer(page)).toBeVisible();
    await page.getByTestId("task-navigation-settings").click();
    await expect(page.getByText(/settings & providers/i)).toBeVisible();
  });

  test("empty start is the Composer, not a first-run wizard", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    await expect(composer(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("agent-first-run")).toHaveCount(0);
    await expect(page.getByTestId("first-run-resume")).toHaveCount(0);
  });
});

test.describe("a pasted storage error Direction", () => {
  const BODY =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    "<Error><Code>AccessDenied</Code><Message>Access Denied</Message>" +
    "<RequestId>ABC123</RequestId><BucketName>acme-logs</BucketName></Error>";

  test("is read back as the error artifact it is, with raw evidence one click away", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = composer(page);
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

  test("a Direction that merely quotes an error stays prose", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = composer(page);
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

test("a task that needs a model stops for configuration without creating empty durable history", async ({ page }) => {
  const api = `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || "8799"}`;
  const count = async () => {
    const j = await (await page.request.get(`${api}/sessions`)).json();
    return (Array.isArray(j) ? j : (j.sessions ?? j.items ?? [])).length;
  };

  await seedFreshApp(page);
  await page.goto("/");
  const before = await count();
  const box = composer(page);
  await box.fill("why does my bucket deny list calls");
  await box.press("Enter");
  await expect(page.getByText(/Configure a Model Provider before the Agent can continue this task/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Configure Model Provider" })).toBeVisible();
  await page.waitForTimeout(2500);
  expect(await count()).toBe(before);
  await expect(box).toHaveValue(/why does my bucket deny list calls/);
});

test("the Agent start surface stops inviting execution it cannot perform", async ({ page }) => {
  await seedFreshApp(page);
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("offline-banner")).toHaveCount(0);
  await composer(page).fill("/");
  await expect(page.getByRole("button", { name: "/diagnose Diagnose an error" })).toBeVisible();
  await composer(page).fill("");

  await page.route("**/health", (route) => route.abort());
  await expect(page.getByTestId("offline-banner")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Delegate task" })).toBeDisabled();
  await composer(page).fill("this must not be thrown away");
  await expect(composer(page)).toHaveValue("this must not be thrown away");
});

test("an unrecognised execution failure is framed as task failure, not dumped", async ({ page }) => {
  await seedFreshApp(page);
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await page.route("**/agent-tasks/**/executions", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({ status: 500, body: '{"detail":"boom"}' });
    }
    return route.continue();
  });

  await composer(page).fill("why does acme-logs deny list");
  await composer(page).press("Enter");

  await expect(page.getByText(/The Agent couldn't continue this task/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/boom/)).toBeVisible();
  await expect(page.getByRole("button", { name: /retry task/i })).toBeVisible();
});
