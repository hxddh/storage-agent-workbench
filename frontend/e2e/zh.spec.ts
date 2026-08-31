import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";

/** Simplified Chinese must cover the actual Agent-task product, never a legacy conversation shell. */
const composerZh = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");

async function bootZh(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "zh");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composerZh(page)).toBeVisible({ timeout: 20_000 });
}

const ENGLISH_LEAK =
  /\b(Settings|Providers|Cancel|Close|Copy|Delete|Rename|Retry|Reload|Send|Loading|Failed|Error|Untitled|New task|Show more|Show less)\b/;

test.describe("Agent product in Chinese", () => {
  test("the task start surface is Chinese, not a half-translated legacy screen", async ({ page }) => {
    await bootZh(page);
    await expect(composerZh(page)).toHaveAttribute("placeholder", /给 Agent 一个目标/);
    const shell = await page.locator("body").evaluate((el) => el.textContent ?? "");
    expect(shell).toContain("新任务");
    expect(shell).not.toContain("新对话");
    expect(shell).not.toContain("新调查");
    expect(shell).not.toMatch(/\b(thread|rail|common|menu|keys|inspector)\.[a-zA-Z]+\b/);
  });

  test("Agent task navigation and its task menu are Chinese", async ({ page }) => {
    await bootZh(page);
    await composerZh(page).fill("HTTP 403 Forbidden on GetObject");
    await composerZh(page).press("Enter");
    await expect(page.getByText(/错误诊断|error triage/i).first()).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: /更多操作/ }).first().click({ force: true });
    const menu = await page.locator("body").evaluate((el) => el.textContent ?? "");
    expect(menu).toContain("重命名");
    expect(menu).toContain("删除");
  });

  test("the settings drawer is Chinese down to the provider form", async ({ page }) => {
    await bootZh(page);
    await page.getByTestId("task-navigation-settings").click();
    await page.getByRole("button", { name: /^云存储提供商$/ }).first().click();
    await page.getByRole("button", { name: /添加云存储提供商/ }).first().click();

    const form = await page.locator("body").evaluate((el) => el.textContent ?? "");
    expect(form).toContain("提供商");
    expect(form).toContain("区域");
    expect(form).toContain("Access Key ID");
    expect(form).toContain("Secret Access Key");
  });

  test("a durable Work Result and its Execution disclosure are Chinese", async ({ page }) => {
    const model = await startFakeModel([
      toolTurn("read_skill", { name: "storageops-security-iam-policy" }),
      textTurn("acme-logs 的桶策略缺少 s3:ListBucket，因此每次 list 都返回 403。"),
    ]);
    const modelId = await useFakeModel(model.baseUrl);
    try {
      await bootZh(page);
      await composerZh(page).fill("为什么 acme-logs 每次 list 都 403？");
      await composerZh(page).press("Enter");
      await expect(page.getByTestId("live-trace")).toBeVisible({ timeout: 60_000 });

      const task = await page.getByTestId("task-scroll").evaluate((el) => el.textContent ?? "");
      expect(task).toMatch(/桶策略|s3:ListBucket|403/);
      await expect(page.getByTestId("live-trace").last()).toBeVisible();
      expect(task).not.toMatch(ENGLISH_LEAK);
    } finally {
      await dropModelProvider(modelId);
      await model.close();
    }
  });

  test("switching language applies instantly and is remembered", async ({ page }) => {
    // Seed English only on the first load. An init script that unconditionally
    // writes English also runs on reload and would erase the user's saved choice,
    // making the persistence test test its own reset hook instead of the product.
    await page.addInitScript(() => {
      localStorage.setItem("saw.onboarded", "1");
      if (!localStorage.getItem("saw.lang")) localStorage.setItem("saw.lang", "en");
    });
    await page.goto("/");
    await expect(page.getByTestId("agent-composer").getByRole("textbox")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("task-navigation-settings").click();
    await page.getByRole("button", { name: /^简体中文$/ }).first().click();
    await expect(composerZh(page)).toHaveAttribute("placeholder", /给 Agent 一个目标/);
    await expect(page.getByTestId("agent-task-navigation").getByRole("button", { name: /新任务/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("saw.lang"))).toBe("zh");

    await page.reload();
    await expect(composerZh(page)).toBeVisible({ timeout: 20_000 });
    await expect(composerZh(page)).toHaveAttribute("placeholder", /给 Agent 一个目标/);
    await expect(page.getByTestId("agent-task-navigation").getByRole("button", { name: /新任务/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("saw.lang"))).toBe("zh");

    await page.getByTestId("task-navigation-settings").click();
    await page.getByRole("button", { name: /^English$/ }).first().click();
  });
});
