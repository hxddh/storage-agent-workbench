import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";

const composer = (page: Page) => page.getByPlaceholder(/Ask Storage Agent/i);

async function setup(page: Page) {
  const model = await startFakeModel([
    toolTurn("head_bucket", { bucket: "acme-logs" }),
    textTurn("The bucket is reachable. I verified it with a read-only HEAD request."),
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
  await composer(page).fill("Can you verify whether acme-logs is reachable?");
  await composer(page).press("Enter");
  await expect(page.getByTestId("turn-footer-toggle")).toBeVisible({ timeout: 60_000 });
}

test.describe("workspace-first investigation UI", () => {
  test("Inspect promotes evidence to the full work area instead of a narrow drawer", async ({ page }) => {
    const cleanup = await setup(page);
    try {
      await completeTurn(page);
      await page.getByRole("button", { name: /inspect/i }).click();

      const inspector = page.getByTestId("session-inspector");
      await expect(inspector).toBeVisible();
      const box = await inspector.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width / 1440).toBeGreaterThanOrEqual(0.98);
      expect(box!.height / 900).toBeGreaterThanOrEqual(0.98);
      expect(box!.x).toBeLessThanOrEqual(2);
    } finally {
      await cleanup();
    }
  });

  test("the review body keeps a bounded readable measure inside the full workspace", async ({ page }) => {
    const cleanup = await setup(page);
    try {
      await completeTurn(page);
      await page.getByRole("button", { name: /inspect/i }).click();
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
      expect(geometry!.x).toBeLessThanOrEqual(2);
      expect(geometry!.y).toBeLessThanOrEqual(2);
      expect(geometry!.width / geometry!.viewportWidth).toBeGreaterThanOrEqual(0.98);
      expect(geometry!.height / geometry!.viewportHeight).toBeGreaterThanOrEqual(0.98);
    } finally {
      await cleanup();
    }
  });
});
