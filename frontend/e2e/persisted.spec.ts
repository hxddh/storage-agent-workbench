import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, useFakeModel } from "./fake-model";

/**
 * What streamed is what stays. These checks deliberately wait for the durable
 * Work Result boundary, then verify the persisted result rather than the live
 * execution stream that preceded it.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const task = (page: Page) => page.getByTestId("task-scroll");

async function ask(page: Page, turns: string[][], question: string) {
  const model = await startFakeModel(turns);
  const modelId = await useFakeModel(model.baseUrl);
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
  await composer(page).click();
  await composer(page).fill(question);
  await composer(page).press("Enter");
  return {
    cleanup: async () => {
      await dropModelProvider(modelId);
      await model.close();
    },
  };
}

/** Composer leaving Working means the persisted Work Result replaced the stream. */
async function settledText(page: Page): Promise<string> {
  await expect(page.getByTestId("work-result").last()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("agent-composer")).not.toHaveAttribute("data-agent-state", "working", {
    timeout: 60_000,
  });
  return await task(page).evaluate((el) => el.textContent ?? "");
}

test.describe("the Work Result that streamed is the Work Result that stays", () => {
  test.describe.configure({ timeout: 90_000 });
  test("a reasoning model's result survives execution settling", async ({ page }) => {
    const { cleanup } = await ask(
      page,
      [textTurn("<think>Check the policy first.</think>\n\nThe policy omits s3:ListBucket.")],
      "why does acme-logs return 403?",
    );
    try {
      const settled = await settledText(page);
      expect(settled).toContain("The policy omits s3:ListBucket");
      expect(settled).not.toContain("Check the policy first");
      expect(settled).not.toContain("<think>");
    } finally { await cleanup(); }
  });

  test("an execution that ends mid-thought does not surface hidden reasoning in the durable result", async ({ page }) => {
    const { cleanup } = await ask(
      page,
      [textTurn("The policy omits s3:ListBucket.\n<think>now let me double-check the ACL")],
      "why does acme-logs return 403?",
    );
    try {
      const settled = await settledText(page);
      expect(settled).toContain("The policy omits s3:ListBucket");
      expect(settled).not.toContain("<think>");
      expect(settled).not.toContain("double-check the ACL");
    } finally { await cleanup(); }
  });

  test("a result with no usable text still exposes an explicit durable outcome", async ({ page }) => {
    const { cleanup } = await ask(
      page,
      [textTurn("<think>The policy omits s3:ListBucket, so list returns 403.</think>")],
      "why does acme-logs return 403?",
    );
    try {
      await settledText(page);
      await expect
        .poll(async () => await task(page).evaluate((el) => el.textContent ?? ""), {
          timeout: 20_000,
          message: "a Work Result with no usable model text must still expose an outcome",
        })
        .toMatch(/no readable Work Result/i);
      const settled = await task(page).evaluate((el) => el.textContent ?? "");
      expect(settled).not.toContain("<think>");
      expect(settled).not.toContain("so list returns 403");
    } finally { await cleanup(); }
  });

  test("the durable Work Result is still there after a reload", async ({ page }) => {
    const { cleanup } = await ask(
      page,
      [textTurn("<think>Check the policy.</think>\n\nThe policy omits s3:ListBucket.")],
      "why does acme-logs return 403?",
    );
    try {
      await settledText(page);
      await page.reload();
      await expect(composer(page)).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(async () => await task(page).evaluate((el) => el.textContent ?? ""), {
          timeout: 20_000,
          message: "the Work Result must survive a reload, not just live execution",
        })
        .toContain("The policy omits s3:ListBucket");
    } finally { await cleanup(); }
  });
});
