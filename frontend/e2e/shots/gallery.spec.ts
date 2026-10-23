import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addStorage, api, delegate, reset, settled } from "../app";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "../fake-model";
import { startFakeS3 } from "../fake-s3";

/**
 * Human visual-review contact sheet (v14). No pixel baselines — CI, local
 * Chromium and font stacks are not raster-identical. Every capture first
 * reaches a real, asserted state against the real Sidecar, then writes a PNG.
 *
 * The states are the agent workspace: Home, live work, the result, the
 * Evidence record, a follow-up, an edited version, Settings and mobile.
 * There is no storage/bucket page to photograph.
 */

const OUT = path.resolve("shots");
const taken: Array<{ name: string; file: string }> = [];

async function shot(page: Page, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = `${String(taken.length + 1).padStart(2, "0")}-${name}.png`;
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, file), fullPage: false });
  taken.push({ name, file });
}

async function open(page: Page, theme: "dark" | "light", lang: "en" | "zh") {
  await api("/settings", { method: "PATCH", body: JSON.stringify({ language: lang, theme }) });
  await page.addInitScript(([t, l]) => {
    localStorage.setItem("saw.theme", t);
    localStorage.setItem("saw.lang", l);
    localStorage.removeItem("sa.pane.w");
  }, [theme, lang]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
}

const conclusion = {
  findings: [
    { title: "Public access is not blocked", severity: "high", detail: "Nothing stops a future policy from making it public." },
    { title: "Two buckets have no default encryption", severity: "medium", detail: "New objects are stored unencrypted." },
    { title: "Incomplete multipart uploads are never cleaned up", severity: "low", detail: "" },
  ],
};

test("the v14 contact sheet", async ({ page }) => {
  test.setTimeout(240_000);
  fs.rmSync(OUT, { recursive: true, force: true });
  await reset();
  const s3 = await startFakeS3({ "acme-www": ["index.html"], "acme-logs": ["2026/09/01/a.log"], "acme-data": ["p/x.parquet"] },
    { config: { "acme-logs": { encrypted: true } } });
  const storage = await addStorage(s3.endpointUrl);
  const model = await startFakeModel([
    toolTurn("survey_account", { provider_id: storage }),
    toolTurn("review_bucket_config", { provider_id: storage, bucket: "acme-www" }),
    toolTurn("record_conclusion", conclusion),
    textTurn("Public exposure is the main issue. Two buckets also lack default encryption."),
    textTurn("Default encryption applies to new objects only; existing objects keep their encryption."),
    textTurn("It covers objects written after you enable it."),
  ], { title: "Estate review", deltaDelayMs: 25 });
  const modelId = await useFakeModel(model.baseUrl);
  try {
    await open(page, "dark", "en");
    await shot(page, "home-empty-dark-en");
    await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
    await delegate(page, "Survey my storage account and tell me what needs care, most severe first.");
    await expect(page.getByTestId("run-trace")).toBeVisible({ timeout: 30_000 });
    await shot(page, "live-dark-en");
    await expect(page.getByTestId("answer")).toBeVisible({ timeout: 60_000 });
    await settled(page, 60_000);
    await shot(page, "conversation-dark-en");
    await page.getByTestId("run-result").first().locator("summary").click();
    await shot(page, "data-dark-en");

    await delegate(page, "Does default encryption fix the existing objects too?");
    await expect(page.getByTestId("turn").last()).toContainText("new objects only", { timeout: 30_000 });
    await settled(page);
    await shot(page, "follow-up-dark-en");
    await page.getByTestId("titlebar-sidepane").click();
    await shot(page, "evidence-dark-en");
    await page.getByTestId("inspector").getByTestId("evidence-call").first().click();
    await shot(page, "evidence-open-dark-en");
    await page.keyboard.press("Escape");

    const second = page.getByTestId("message").filter({ hasText: "existing objects" });
    await second.hover();
    await second.getByTestId("edit-message").click();
    await page.getByTestId("composer-input").fill("Which objects does default encryption cover?");
    await page.getByTestId("composer-send").click();
    await expect(page.getByText("2 / 2")).toBeVisible({ timeout: 30_000 });
    await settled(page);
    await shot(page, "edited-version-dark-en");

    await page.getByTestId("new-task").click();
    await shot(page, "home-dark-en");
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, "home-mobile-dark-en");
    await page.getByRole("button", { name: "Show sidebar" }).click();
    await page.getByTestId("open-settings").click();
    await shot(page, "settings-mobile-dark-en");
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByTestId("task-list").getByText("Estate review").click();
    await expect(page.getByTestId("answer").first()).toBeVisible();
    await shot(page, "conversation-mobile-dark-en");
    await page.setViewportSize({ width: 1440, height: 900 });
    // Choosing a task in the overlay closed the sidebar; a desktop shot needs it back.
    if (await page.getByTestId("show-sidebar").isVisible()) await page.getByTestId("show-sidebar").click();
    await page.getByTestId("new-task").click();
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-connections").click();
    await shot(page, "settings-connections-dark-en");
    await page.getByTestId("settings-general").click();
    await shot(page, "settings-general-dark-en");
    await page.getByTestId("settings-models").click();
    await shot(page, "settings-models-dark-en");
    await page.getByRole("button", { name: "Close" }).click();

    await open(page, "light", "en");
    await shot(page, "home-light-en");
    await page.getByTestId("task-list").getByText("Estate review").click();
    await expect(page.getByTestId("answer").first()).toBeVisible();
    await shot(page, "conversation-light-en");

    await open(page, "dark", "zh");
    await shot(page, "home-dark-zh");
    await page.getByTestId("task-list").getByText("Estate review").click();
    await expect(page.getByTestId("answer").first()).toBeVisible();
    await shot(page, "conversation-dark-zh");
  } finally {
    await api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", theme: "dark" }) });
    await dropModelProvider(modelId);
    await model.close();
    await s3.close();
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(taken, null, 2));
  }
});
