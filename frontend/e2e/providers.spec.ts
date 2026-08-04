import { expect, test, type Page } from "@playwright/test";

/**
 * Provider management, the session rail, and the command palette — all against
 * a live sidecar, all still credential-free.
 *
 * The provider specs are the security-relevant half: they create a real
 * provider (with a fake key that never leaves the machine) and then assert the
 * plaintext secret is nowhere in the rendered page OR in the API response.
 * That is rule 2/4 — SQLite holds only a `keyring://` ref — checked end to end
 * rather than by unit-testing the vault in isolation.
 */

const SECRET = "e2e-secret-value-not-real";
const SIDECAR = `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || 8799}`;

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(page.getByPlaceholder(/Ask Storage Agent/i)).toBeVisible();
}

async function openCloudProviders(page: Page) {
  await page.getByRole("button", { name: /settings/i }).first().click();
  await expect(page.getByText(/settings & providers/i)).toBeVisible();
  await page.getByRole("button", { name: /^Cloud Providers$/ }).first().click();
}

test.describe("cloud provider management", () => {
  // These specs mutate SERVER state, and the whole suite shares one sidecar and
  // one data dir. A leftover provider silently invalidates any test that asserts
  // first-install behaviour (the first-run wizard only appears when no provider
  // is configured), so this file cleans up after itself rather than leaving the
  // next file to guess why it failed.
  test.afterAll(async ({ request }) => {
    const res = await request.get(`${SIDECAR}/cloud-providers`);
    for (const p of (await res.json()) as Array<{ id: string; name: string }>) {
      if (p.name === "e2e-test-provider") {
        await request.delete(`${SIDECAR}/cloud-providers/${p.id}`);
      }
    }
  });

  test("a provider is created and its secret never reaches the client", async ({ page }) => {
    await boot(page);
    await openCloudProviders(page);

    await page.getByRole("button", { name: /Add cloud provider/i }).first().click();
    // "Advanced" reveals the free-text name; the default preset supplies the
    // rest, so no real endpoint or account is involved.
    await page.getByRole("button", { name: /^Advanced$/ }).first().click();
    await page.getByLabel("Name").first().fill("e2e-test-provider");
    await page.getByLabel("Access key ID").first().fill("AKIAE2ETESTKEY000000");
    await page.getByLabel("Secret access key").first().fill(SECRET);
    await page.getByRole("button", { name: /^Add provider$/ }).click();

    await expect(page.getByText("e2e-test-provider")).toBeVisible({ timeout: 15_000 });

    // Rule 2/4 end to end: the plaintext must not be in the DOM…
    expect(await page.locator("body").innerText()).not.toContain(SECRET);
    // …nor in what the API hands back (the row should carry only a ref).
    const listed = await page.evaluate(async (base) => {
      const res = await fetch(`${base}/cloud-providers`);
      return await res.text();
    }, SIDECAR);
    expect(listed).toContain("e2e-test-provider");
    expect(listed).not.toContain(SECRET);
  });

  test("the provider survives a reload (persisted, not component state)", async ({ page }) => {
    await boot(page);
    await openCloudProviders(page);
    await expect(page.getByText("e2e-test-provider")).toBeVisible({ timeout: 15_000 });
    expect(await page.locator("body").innerText()).not.toContain(SECRET);
  });
});

test.describe("session rail", () => {
  test("a chat can be renamed and the title persists across reload", async ({ page }) => {
    await boot(page);
    const box = page.getByPlaceholder(/Ask Storage Agent/i);
    await box.click();
    await box.fill("HTTP 403 Forbidden on GetObject");
    await box.press("Enter");
    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });

    // The ⋯ menu only exists once a chat is listed, and only on hover — force
    // the click rather than simulating the pointer dance.
    await page.getByRole("button", { name: /more actions/i }).first().click({ force: true });
    await page.getByRole("button", { name: /^Rename$/ }).first().click();
    const input = page.locator("input:focus");
    await input.fill("renamed-by-e2e");
    await input.press("Enter");
    // The title renders in BOTH the rail and the thread header, so scope to the
    // first match rather than tripping strict mode.
    await expect(page.getByText("renamed-by-e2e").first()).toBeVisible();

    // Must come back from SQLite, not from component state.
    await page.reload();
    await expect(page.getByText("renamed-by-e2e").first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("command palette", () => {
  test("opens with the keyboard shortcut and closes on Escape", async ({ page }) => {
    await boot(page);
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByPlaceholder(/Search chats or run a command/i);
    await expect(palette).toBeVisible();

    // Escape is handled by the palette's own onKeyDown (App's global handler
    // deliberately ignores keys typed inside an input).
    await palette.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect(page.getByPlaceholder(/Ask Storage Agent/i)).toBeVisible();
  });
});
