import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, useFakeModel } from "./fake-model";

/**
 * v1.10.0 — the runtime names the task after its first Work Result.
 *
 * The title comes from one bounded model request (Direction + Work Result
 * text only), lands on the durable task, and reaches the sidebar through the
 * ordinary settle refresh. A user rename wins forever: the runtime never
 * titles a renamed task again.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const rows = (page: Page) => page.getByTestId("agent-task-navigation").getByTestId("task-row");

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
}

async function delegate(page: Page, direction: string) {
  await composer(page).click();
  await composer(page).fill(direction);
  await composer(page).press("Enter");
  await expect(page.getByTestId("work-result").last()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("agent-composer")).not.toHaveAttribute("data-agent-state", "working", { timeout: 60_000 });
}

test.describe("runtime task titles", () => {
  test.describe.configure({ timeout: 90_000 });

  test("the first Work Result names the task; a rename wins over the next one", async ({ page }) => {
    const model = await startFakeModel(
      [textTurn("The policy omits s3:ListBucket."), textTurn("The second bucket is fine.")],
      { title: "Acme logs 403 on ListBucket" },
    );
    const modelId = await useFakeModel(model.baseUrl);
    try {
      await boot(page);
      await delegate(page, "why does acme-logs return 403 on list?");

      // The sidebar shows the runtime's title, not the truncated Direction.
      const row = rows(page).filter({ hasText: "Acme logs 403 on ListBucket" }).first();
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("header.native-titlebar")).toContainText("Acme logs 403 on ListBucket");
      expect(model.titleRequests.length).toBe(1);
      // The title request carried the Direction and nothing from any tool.
      expect(JSON.stringify(model.titleRequests[0])).toContain("why does acme-logs return 403");
      // One scripted turn was consumed by the answer; the title never touched the script.
      expect(model.requests.length).toBe(1);

      // The user renames; the second Work Result must not retitle.
      await row.hover();
      await page.getByRole("button", { name: /more actions/i }).first().click({ force: true });
      await page.getByRole("button", { name: /^Rename$/ }).first().click();
      const input = page.locator("input:focus");
      await input.fill("my own name");
      await input.press("Enter");
      await expect(rows(page).filter({ hasText: "my own name" }).first()).toBeVisible();

      await delegate(page, "and the second bucket?");
      await expect(rows(page).filter({ hasText: "my own name" }).first()).toBeVisible();
      expect(model.titleRequests.length).toBe(1);

      await page.reload();
      await expect(rows(page).filter({ hasText: "my own name" }).first()).toBeVisible({ timeout: 20_000 });
    } finally {
      await dropModelProvider(modelId);
      await model.close();
    }
  });

  test("an empty title answer keeps the deterministic seed title", async ({ page }) => {
    const model = await startFakeModel([textTurn("Nothing to report.")]);
    const modelId = await useFakeModel(model.baseUrl);
    try {
      await boot(page);
      await delegate(page, "inventory review for acme-backups");
      await expect(rows(page).filter({ hasText: "inventory review for acme-backups" }).first()).toBeVisible({ timeout: 20_000 });
      expect(model.titleRequests.length).toBe(1);
    } finally {
      await dropModelProvider(modelId);
      await model.close();
    }
  });
});
