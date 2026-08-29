import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";

/**
 * The app in Chinese.
 *
 * English-heavy E2E keeps most copy assertions stable, so this suite proves the
 * actual Simplified Chinese product paths render through the full application.
 */

const composerZh = (page: Page) => page.getByPlaceholder(/向云存储 Agent 提问/);

async function bootZh(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "zh");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composerZh(page)).toBeVisible({ timeout: 20_000 });
}

const ENGLISH_LEAK =
  /\b(Settings|Providers|Cancel|Close|Copy|Delete|Rename|Archive|Retry|Reload|Send|Search|Loading|Failed|Error|Untitled|Yesterday|Today|Older|New chat|Show more|Show less)\b/;

test.describe("the app in Chinese", () => {
  test("the start surface is Chinese, not a half-translated screen", async ({ page }) => {
    await bootZh(page);
    const shell = await page.locator("body").evaluate((el) => el.textContent ?? "");
    expect(shell).toContain("我能为你的存储做些什么？");
    expect(shell).toContain("新调查");
    expect(shell).not.toMatch(/\b(thread|rail|common|menu|keys|inspector)\.[a-zA-Z]+\b/);
  });

  test("the investigation navigation and its menu are Chinese", async ({ page }) => {
    await bootZh(page);
    await composerZh(page).click();
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
    await page.getByRole("button", { name: /设置与提供商/ }).first().click();
    await page.getByRole("button", { name: /^云存储提供商$/ }).first().click();
    await page.getByRole("button", { name: /添加云存储提供商/ }).first().click();

    const form = await page.locator("body").evaluate((el) => el.textContent ?? "");
    expect(form).toContain("提供商");
    expect(form).toContain("区域");
    expect(form).toContain("Access Key ID");
    expect(form).toContain("Secret Access Key");
  });

  test("a finished turn's own furniture is Chinese", async ({ page }) => {
    const model = await startFakeModel([
      toolTurn("read_skill", { name: "storageops-security-iam-policy" }),
      textTurn("acme-logs 的桶策略缺少 s3:ListBucket，因此每次 list 都返回 403。"),
    ]);
    const modelId = await useFakeModel(model.baseUrl);
    try {
      await bootZh(page);
      await composerZh(page).click();
      await composerZh(page).fill("为什么 acme-logs 每次 list 都 403？");
      await composerZh(page).press("Enter");
      await expect(page.getByTestId("turn-footer-toggle")).toBeVisible({ timeout: 60_000 });
      await page.getByTestId("turn-footer-toggle").click();

      const thread = await page.locator("main").evaluate((el) => el.textContent ?? "");
      expect(thread).toMatch(/项检查|执行过程|查看详情/);
      expect(thread).not.toMatch(ENGLISH_LEAK);
    } finally {
      await dropModelProvider(modelId);
      await model.close();
    }
  });

  test("switching language applies instantly and is remembered", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("saw.onboarded", "1"));
    await page.goto("/");
    await expect(page.getByTestId("agent-composer").getByRole("textbox")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: /settings/i }).first().click();
    await page.getByRole("button", { name: /^简体中文$/ }).first().click();
    await expect(composerZh(page)).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(composerZh(page)).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: /设置与提供商/ }).first().click();
    await page.getByRole("button", { name: /^English$/ }).first().click();
  });
});
