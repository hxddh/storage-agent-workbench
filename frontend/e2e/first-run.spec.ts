import { expect, test } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, toolTurn } from "./fake-model";

const SIDECAR = `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || 8799}`;

async function dropAllModels() {
  const providers = await fetch(`${SIDECAR}/model-providers`).then((r) => r.json()) as Array<{ id: string }>;
  for (const p of providers) await dropModelProvider(p.id);
}

test.describe("first-run 60s path", () => {
  test("welcome → model → skip storage → checkup produces a real Work Result", async ({ page }) => {
    test.setTimeout(120_000);
    const model = await startFakeModel([
      toolTurn("list_buckets", {}),
      textTurn("## Storage checkup\n\nNo storage provider is connected. That is an explicit gap — not a fabricated finding."),
    ]);
    try {
      await page.addInitScript(() => {
        localStorage.setItem("saw.lang", "en");
        localStorage.removeItem("saw.onboarded");
        localStorage.removeItem("saw.firstRunStep");
      });
      await page.goto("/");
      const flow = page.getByTestId("agent-first-run");
      await expect(flow).toBeVisible({ timeout: 20_000 });
      await expect(flow).toHaveAttribute("data-step", "welcome");
      await flow.getByRole("button", { name: "Continue" }).click();
      await expect(flow).toHaveAttribute("data-step", "model");

      await page.getByTestId("first-run-model-name").fill("fake");
      await page.getByTestId("first-run-model-type").fill("openai-compatible");
      await page.getByTestId("first-run-model-url").fill(model.baseUrl);
      await page.getByTestId("first-run-model-id").fill("fake-model");
      await page.getByTestId("first-run-model-key").fill("not-a-real-key");
      await flow.getByRole("button", { name: "Test and continue" }).click();
      await expect(flow).toHaveAttribute("data-step", "storage", { timeout: 20_000 });

      await page.getByTestId("first-run-skip-storage").click();
      await expect(flow).toHaveAttribute("data-step", "checkup");
      await expect(page.getByTestId("first-run-storage-skipped")).toBeVisible();

      await page.getByTestId("first-run-checkup").click();
      await expect(page.getByTestId("agent-first-run")).toHaveCount(0);
      await expect(page.getByTestId("work-result").first()).toBeVisible({ timeout: 90_000 });
    } finally {
      await dropAllModels();
      await model.close();
    }
  });

  test("a failing model test stays on the step with a designed error", async ({ page }) => {
    try {
      await page.addInitScript(() => {
        localStorage.setItem("saw.lang", "en");
        localStorage.removeItem("saw.onboarded");
        localStorage.setItem("saw.firstRunStep", "model");
      });
      await page.goto("/");
      const flow = page.getByTestId("agent-first-run");
      await expect(flow).toHaveAttribute("data-step", "model", { timeout: 15_000 });
      await page.getByTestId("first-run-model-name").fill("broken");
      await page.getByTestId("first-run-model-type").fill("openai-compatible");
      await page.getByTestId("first-run-model-url").fill("http://127.0.0.1:1");
      await page.getByTestId("first-run-model-id").fill("missing");
      await page.getByTestId("first-run-model-key").fill("nope");
      await flow.getByRole("button", { name: "Test and continue" }).click();
      await expect(page.getByTestId("first-run-model-fail")).toBeVisible({ timeout: 20_000 });
      await expect(flow).toHaveAttribute("data-step", "model");
    } finally {
      await dropAllModels();
    }
  });

  test("skipping a step leaves a resume entry on the empty start", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("saw.lang", "en");
      localStorage.removeItem("saw.onboarded");
    });
    await page.goto("/");
    const flow = page.getByTestId("agent-first-run");
    await expect(flow).toBeVisible({ timeout: 15_000 });
    await flow.getByRole("button", { name: "Configure later" }).click();
    await expect(page.getByTestId("agent-first-run")).toHaveCount(0);
    await expect(page.getByTestId("first-run-resume")).toBeVisible();
    await page.getByTestId("first-run-resume").click();
    await expect(page.getByTestId("agent-first-run")).toBeVisible();
  });
});
