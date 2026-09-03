import { expect, test, type Page } from "@playwright/test";

/**
 * v1.12 — Settings → Safety carries the approval policy the runtime enforces.
 *
 * Three options (Ask every time · Allow for this session · Always allow), one
 * consequence line each, the list of gated tools from the Sidecar. The choice
 * is persisted through `PUT /settings/approval-policy` and read back on the
 * next open; the read-only floor paragraph stays above it. No policy can
 * approve a tool that does not exist.
 */

const SIDECAR = `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || 8799}`;

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(page.getByTestId("agent-composer").getByRole("textbox")).toBeVisible({ timeout: 20_000 });
}

async function openSafety(page: Page) {
  await page.getByTestId("task-navigation-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await page.getByRole("button", { name: /^Safety$/ }).first().click();
  await expect(page.getByTestId("approval-policy")).toBeVisible({ timeout: 15_000 });
}

test.describe("approval policy in Settings → Safety", () => {
  test.afterAll(async ({ request }) => {
    // Leave the shared E2E data directory on the default.
    await request.put(`${SIDECAR}/settings/approval-policy`, { data: { policy: "ask" } }).catch(() => undefined);
  });

  test("the policy is chosen in the pane, survives a reload, and returns to Ask", async ({ page }) => {
    await boot(page);
    await openSafety(page);

    const group = page.getByTestId("approval-policy");
    await expect(group).toHaveAttribute("data-policy", "ask");
    await expect(page.getByTestId("approval-policy-ask")).toBeChecked();
    for (const value of ["ask", "allow_session", "allow_always"]) {
      await expect(page.getByTestId(`approval-policy-${value}`)).toBeVisible();
    }
    await expect(group).toContainText("Ask every time");
    await expect(group).toContainText("Allow for this session");
    await expect(group).toContainText("Always allow");
    // The runtime's gated tools are listed from the endpoint, never invented.
    await expect(page.getByTestId("approval-gated-tools")).toContainText("import_evidence");

    await page.getByTestId("approval-policy-allow_session").check();
    await expect(group).toHaveAttribute("data-policy", "allow_session", { timeout: 10_000 });
    const stored = await (await fetch(`${SIDECAR}/settings/approval-policy`)).json() as { policy: string };
    expect(stored.policy).toBe("allow_session");

    await page.reload();
    await openSafety(page);
    await expect(page.getByTestId("approval-policy-allow_session")).toBeChecked();
    await expect(page.getByTestId("approval-policy")).toHaveAttribute("data-policy", "allow_session");

    await page.getByTestId("approval-policy-ask").check();
    await expect(page.getByTestId("approval-policy")).toHaveAttribute("data-policy", "ask", { timeout: 10_000 });
    const restored = await (await fetch(`${SIDECAR}/settings/approval-policy`)).json() as { policy: string };
    expect(restored.policy).toBe("ask");
  });
});
