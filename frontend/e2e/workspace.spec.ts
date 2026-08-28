import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";

const composer = (page: Page) => page.getByPlaceholder(/Ask Storage Agent/i);
const SKILL = "storageops-security-iam-policy";

async function setup(page: Page) {
  const model = await startFakeModel([
    toolTurn("read_skill", { name: SKILL }),
    textTurn("The investigation is ready for review. The persisted skill evidence is available below."),
  ]);
  const providerId = await useFakeModel(model.baseUrl);
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
    localStorage.setItem("saw.activityDensity", "balanced");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
  return async () => {
    await dropModelProvider(providerId);
    await model.close();
  };
}

async function completeTurn(page: Page) {
  await composer(page).fill("Review the IAM-policy diagnostic method and keep the evidence available for inspection.");
  await composer(page).press("Enter");
  await expect(page.getByTestId("turn-footer-toggle")).toBeVisible({ timeout: 20_000 });
}

test.describe("Agent OS workbench", () => {
  test("Evidence is a native replaceable work surface, never a legacy Inspector overlay", async ({ page }) => {
    const cleanup = await setup(page);
    try {
      await completeTurn(page);
      await page.getByRole("tab", { name: "Evidence" }).click();

      const shell = page.getByTestId("workbench-shell");
      await expect(shell).toHaveAttribute("data-surface", "evidence");
      const evidence = page.getByTestId("evidence-workspace");
      await expect(evidence).toBeVisible();
      await expect(page.getByTestId("session-inspector")).toHaveCount(0);

      const geometry = await evidence.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const stage = node.closest(".agent-os-stage")!.getBoundingClientRect();
        return {
          width: rect.width,
          leftInset: rect.left - stage.left,
          rightInset: stage.right - rect.right,
        };
      });
      expect(geometry.width).toBeLessThanOrEqual(1082);
      expect(Math.abs(geometry.leftInset - geometry.rightInset)).toBeLessThanOrEqual(4);
    } finally {
      await cleanup();
    }
  });

  test("Focus mode removes global navigation without changing the selected document identity", async ({ page }) => {
    const cleanup = await setup(page);
    try {
      await completeTurn(page);
      await page.getByRole("tab", { name: "Evidence" }).click();
      await expect(page.getByTestId("evidence-workspace")).toBeVisible();

      await page.getByRole("button", { name: "Focus work surface" }).click();
      await expect(page.getByTestId("workbench-shell")).toHaveAttribute("data-mode", "focus");
      await expect(page.getByTestId("session-rail")).not.toBeVisible();
      await expect(page.getByTestId("evidence-workspace")).toBeVisible();

      await page.getByRole("button", { name: "Exit focus mode" }).click();
      await expect(page.getByTestId("session-rail")).toBeVisible();
      await expect(page.getByTestId("evidence-workspace")).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test("the resting Timeline prompt remains subordinate to the answer document", async ({ page }) => {
    const cleanup = await setup(page);
    try {
      await completeTurn(page);
      const field = composer(page);
      const parent = field.locator("..");
      const box = await parent.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeLessThan(90);
      await expect(page.getByTestId("answer-document").first()).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test("Evidence keeps the real Agent steering controller reachable", async ({ page }) => {
    const cleanup = await setup(page);
    try {
      await completeTurn(page);
      await page.getByRole("tab", { name: "Evidence" }).click();

      const steering = page.getByTestId("workbench-steering");
      await expect(steering).toBeVisible();
      // The footer appears before the session run necessarily publishes its
      // final idle state. Wait for the controller to say Send rather than
      // accidentally testing redirect-in-flight semantics.
      await expect(steering.getByRole("button", { name: /^send$/i })).toBeVisible({ timeout: 20_000 });
      const field = steering.getByRole("textbox");
      await field.fill("Summarize the evidence again from this review surface.");
      await field.press("Enter");

      await page.getByRole("tab", { name: "Timeline" }).click();
      await expect(page.getByTestId("turn-footer-toggle")).toHaveCount(2, { timeout: 20_000 });
    } finally {
      await cleanup();
    }
  });

  test("Report is a native durable-output surface with no centered modal path", async ({ page }) => {
    const cleanup = await setup(page);
    try {
      await completeTurn(page);
      await composer(page).fill("/report");
      await composer(page).press("Enter");

      const shell = page.getByTestId("workbench-shell");
      await expect(shell).toHaveAttribute("data-surface", "report");
      await expect(page.getByRole("tab", { name: "Report" })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("report-workspace")).toBeVisible();
      await expect(page.locator(".fixed.inset-0.z-floating")).toHaveCount(0);
      await expect(page.getByTestId("report-copy")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("report-save")).toBeVisible();
    } finally {
      await cleanup();
    }
  });
});
