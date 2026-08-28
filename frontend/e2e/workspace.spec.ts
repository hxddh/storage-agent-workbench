import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";

const composer = (page: Page) => page.getByPlaceholder(/Ask Storage Agent/i);
const SKILL = "storageops-security-iam-policy";

async function setup(page: Page) {
  // Use the same fully supported, credential-free tool path as agent.spec.
  // `head_bucket` needs a configured storage provider; using it here meant the
  // geometry tests timed out before an investigation ever reached its finished
  // state, so they were not testing workspace geometry at all.
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

test.describe("workspace-first investigation UI", () => {
  test("Inspect promotes evidence to the full work area instead of a narrow drawer", async ({ page }) => {
    const cleanup = await setup(page);
    try {
      await completeTurn(page);
      await page.getByTestId("open-inspector").click();

      const inspector = page.getByTestId("session-inspector");
      await expect(inspector).toBeVisible();
      const box = await inspector.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width / 1440).toBeGreaterThanOrEqual(0.98);
      expect(box!.height / 900).toBeGreaterThanOrEqual(0.98);
      expect(Math.abs(box!.x)).toBeLessThanOrEqual(3);
    } finally {
      await cleanup();
    }
  });

  test("the review body keeps a bounded readable measure inside the full workspace", async ({ page }) => {
    const cleanup = await setup(page);
    try {
      await completeTurn(page);
      await page.getByTestId("open-inspector").click();
      const inspector = page.getByTestId("session-inspector");
      await expect(inspector).toBeVisible();

      const geometry = await inspector.evaluate((root) => {
        const body = root.querySelector(":scope > div:last-child") as HTMLElement;
        const r = body.getBoundingClientRect();
        return { width: r.width, left: r.left, right: window.innerWidth - r.right };
      });
      expect(geometry.width).toBeLessThanOrEqual(1182);
      expect(Math.abs(geometry.left - geometry.right)).toBeLessThanOrEqual(4);
    } finally {
      await cleanup();
    }
  });

  test("the prompt remains visually subordinate to the answer surface", async ({ page }) => {
    const cleanup = await setup(page);
    try {
      await completeTurn(page);
      const field = composer(page);
      const parent = field.locator("..");
      const box = await parent.boundingBox();
      expect(box).not.toBeNull();
      // A resting prompt bar should not reclaim the ~95px card height of the old
      // composer. This is a geometry contract, not an implementation-class test.
      expect(box!.height).toBeLessThan(90);
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
      const field = steering.getByRole("textbox");
      await field.fill("Summarize the evidence again from this review surface.");
      await field.press("Enter");

      // The question is sent through the SAME Timeline-owned runner while the
      // Timeline is hidden. Returning to Timeline must reveal a second persisted
      // exchange, proving this is real Agent control rather than a navigation
      // shortcut or decorative prompt.
      await page.getByRole("tab", { name: "Timeline" }).click();
      await expect(page.getByTestId("turn-footer-toggle")).toHaveCount(2, { timeout: 20_000 });
    } finally {
      await cleanup();
    }
  });

  test("a durable report opens as a full review workspace, not the old centered modal", async ({ page }) => {
    const cleanup = await setup(page);
    try {
      await completeTurn(page);
      await composer(page).fill("/report");
      await composer(page).press("Enter");
      await expect(page.getByText(/Session Report|Executive summary/).first()).toBeVisible({ timeout: 30_000 });

      const geometry = await page.evaluate(() => {
        const main = document.querySelector("[data-testid='agent-workspace'] main") as HTMLElement;
        const overlay = main.querySelector(":scope > .fixed.inset-0.z-floating") as HTMLElement;
        const shell = overlay?.firstElementChild as HTMLElement | null;
        if (!overlay || !shell) return null;
        const r = shell.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        };
      });
      expect(geometry).not.toBeNull();
      // Fractional device-pixel layout can report ~2.03px here on Chromium.
      // The 3px tolerance absorbs rounding only; the 98% width/height contract
      // below is what rejects the old centered 900px / 88vh modal.
      expect(Math.abs(geometry!.x)).toBeLessThanOrEqual(3);
      expect(Math.abs(geometry!.y)).toBeLessThanOrEqual(3);
      expect(geometry!.width / geometry!.viewportWidth).toBeGreaterThanOrEqual(0.98);
      expect(geometry!.height / geometry!.viewportHeight).toBeGreaterThanOrEqual(0.98);
    } finally {
      await cleanup();
    }
  });
});
