import { expect, test, type Page } from "@playwright/test";

/** Provider management, Agent task navigation, and command palette against a
 * live Sidecar. Security assertions remain end-to-end and credential-free. */
const SECRET = "e2e-secret-value-not-real";
const SIDECAR = `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || 8799}`;

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(page.getByTestId("agent-composer").getByRole("textbox")).toBeVisible();
}

async function openCloudProviders(page: Page) {
  await page.getByTestId("task-navigation-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await page.getByRole("button", { name: /^Cloud Providers$/ }).first().click();
}

test.describe("cloud provider management", () => {
  test.afterAll(async ({ request }) => {
    const res = await request.get(`${SIDECAR}/cloud-providers`);
    for (const provider of (await res.json()) as Array<{ id: string; name: string }>) {
      if (provider.name === "e2e-test-provider") await request.delete(`${SIDECAR}/cloud-providers/${provider.id}`);
    }
  });

  test("a provider is created and its secret never reaches the client", async ({ page }) => {
    await boot(page);
    await openCloudProviders(page);
    await page.getByRole("button", { name: /Add cloud provider/i }).first().click();
    await page.getByRole("button", { name: /^Advanced$/ }).first().click();
    await page.getByLabel("Name").first().fill("e2e-test-provider");
    await page.getByLabel("Access key ID").first().fill("AKIAE2ETESTKEY000000");
    await page.getByLabel("Secret access key").first().fill(SECRET);
    await page.getByRole("button", { name: /^Add provider$/ }).click();
    await expect(page.getByText("e2e-test-provider")).toBeVisible({ timeout: 15_000 });
    expect(await page.locator("body").innerText()).not.toContain(SECRET);
    const listed = await page.evaluate(async (base) => await (await fetch(`${base}/cloud-providers`)).text(), SIDECAR);
    expect(listed).toContain("e2e-test-provider");
    expect(listed).not.toContain(SECRET);
  });

  test("the provider survives a reload", async ({ page }) => {
    await boot(page);
    await openCloudProviders(page);
    await expect(page.getByText("e2e-test-provider")).toBeVisible({ timeout: 15_000 });
    expect(await page.locator("body").innerText()).not.toContain(SECRET);
  });
});

test.describe("Agent task navigation", () => {
  test("a task can be renamed and the title persists across reload", async ({ page }) => {
    await boot(page);
    const box = page.getByTestId("agent-composer").getByRole("textbox");
    await box.fill("HTTP 403 Forbidden on GetObject");
    await box.press("Enter");
    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /more actions/i }).first().click({ force: true });
    await page.getByRole("button", { name: /^Rename$/ }).first().click();
    const input = page.locator("input:focus");
    await input.fill("renamed-by-e2e");
    await input.press("Enter");
    await expect(page.getByText("renamed-by-e2e").first()).toBeVisible();
    await page.reload();
    await expect(page.getByText("renamed-by-e2e").first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("command palette", () => {
  test("opens with the keyboard shortcut and closes on Escape", async ({ page }) => {
    await boot(page);
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog");
    const field = palette.getByRole("textbox");
    await expect(field).toBeVisible();
    await field.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect(page.getByTestId("agent-composer").getByRole("textbox")).toBeVisible();
  });
});

test.describe("Escape inside the settings drawer", () => {
  test("does not close the drawer out from under a half-typed field", async ({ page }) => {
    await boot(page);
    await openCloudProviders(page);
    await page.getByRole("button", { name: /Add cloud provider/i }).first().click();
    await page.getByRole("button", { name: /^Advanced$/ }).first().click();
    const field = page.getByLabel("Access key ID").first();
    await field.fill("AKIAE2EHALFTYPED0000");
    await field.press("Escape");
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await expect(field).toHaveValue("AKIAE2EHALFTYPED0000");
  });

  test("still closes it from outside a field", async ({ page }) => {
    await boot(page);
    await page.getByTestId("task-navigation-settings").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.getByRole("dialog").click({ position: { x: 300, y: 12 } });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  });
});
