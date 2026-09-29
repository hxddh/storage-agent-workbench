import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addStorage, api, delegate, reset, settled } from "../app";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "../fake-model";
import { startFakeS3 } from "../fake-s3";

/**
 * Human visual-review contact sheet (v5). No pixel baselines — CI, local
 * Chromium and font stacks are not raster-identical. Every capture first
 * reaches a real, asserted state against the real Sidecar, then writes a PNG.
 *
 * The states are the product: the home and the estate, live work, the Result,
 * the Work log with a forked Direction, the side pane, Settings, the palette —
 * in both themes and both languages.
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
  await page.addInitScript(([t, l]) => { localStorage.setItem("saw.theme", t); localStorage.setItem("saw.lang", l); }, [theme, lang]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
}

const conclusion = {
  answer: "Two of three buckets have no default encryption; acme-www also has no public access block.",
  findings: [
    { title: "acme-www has no public access block", severity: "high", detail: "Nothing stops a future policy from making it public." },
    { title: "acme-www and acme-data have no default encryption", severity: "medium", detail: "New objects are stored unencrypted." },
    { title: "No lifecycle rules", severity: "low", detail: "Incomplete multipart uploads are never cleaned up." },
    { title: "acme-logs is encrypted by default", severity: "info", detail: "" },
  ],
  next_steps: ["Show me the fix for acme-www", "Watch this account daily", "Review acme-data lifecycle"],
};

test("the v6 contact sheet", async ({ page }) => {
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
    textTurn("I surveyed **acme-prod** and reviewed `acme-www`.\n\n| Bucket | Public access block | Default encryption |\n|---|---|---|\n| acme-www | missing | none |\n| acme-logs | missing | SSE-S3 |\n| acme-data | missing | none |"),
    textTurn("Default encryption applies to new objects only; existing ones keep their encryption until rewritten."),
    textTurn("It covers objects written after you enable it."),
  ], { title: "Account survey · acme-prod", deltaDelayMs: 25 });
  const modelId = await useFakeModel(model.baseUrl);
  try {
    await open(page, "dark", "en");
    await shot(page, "home-dark-en");
    await delegate(page, "Survey my storage account and tell me what needs care, most severe first.");
    await expect(page.getByTestId("work-in-progress")).toBeVisible({ timeout: 30_000 });
    await shot(page, "live-work-dark-en");
    await expect(page.getByTestId("result-answer")).toBeVisible({ timeout: 60_000 });
    await settled(page, 60_000);
    await shot(page, "result-dark-en");
    await page.getByTestId("outputs").getByRole("button", { name: /Evidence/ }).click();
    await shot(page, "side-pane-evidence-dark-en");
    await page.getByRole("tab", { name: /Report/ }).click();
    await expect(page.getByTestId("report")).toContainText("Safety");
    await shot(page, "side-pane-report-dark-en");
    await page.getByRole("tab", { name: /Activity/ }).click();
    await shot(page, "side-pane-activity-dark-en");
    await page.keyboard.press("Escape");

    await delegate(page, "Does default encryption fix the existing objects too?");
    await expect(page.getByTestId("result")).toContainText("new objects only", { timeout: 30_000 });
    await settled(page);
    const second = page.locator(".direction", { hasText: "existing objects" });
    await second.hover();
    await second.getByTestId("edit-direction").click();
    await page.getByTestId("composer-input").fill("Which objects does default encryption cover?");
    await page.getByTestId("composer-send").click();
    await expect(page.getByText("2 of 2")).toBeVisible({ timeout: 30_000 });
    await settled(page);
    await shot(page, "work-log-fork-dark-en");

    await page.getByTestId("nav-home").click();
    await expect(page.getByTestId("needs-care")).toBeVisible();
    await page.getByTestId("issue").first().locator(".issue-head").click();
    await shot(page, "home-estate-dark-en");
    await page.getByTestId("nav-estate").click();
    await page.getByTestId("estate-account").first().click();
    await expect(page.getByTestId("bucket-row").first()).toBeVisible();
    await shot(page, "estate-account-dark-en");
    await page.getByTestId("bucket-row").filter({ hasText: "acme-www" }).click();
    await expect(page.getByTestId("timeline")).toBeVisible();
    await page.getByTestId("note-input").fill("Serves the marketing site; owned by the growth team.");
    await page.getByTestId("note-add").click();
    await shot(page, "estate-bucket-dark-en");
    const bucketIssue = page.getByTestId("bucket-page").getByTestId("issue").first();
    await bucketIssue.locator(".issue-head").click();
    const showFix = bucketIssue.getByRole("button", { name: "Show the fix" });
    if (await showFix.count()) await showFix.click();
    await expect(bucketIssue.getByTestId("impact")).toHaveAttribute("data-verdict", /./);
    await bucketIssue.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shot(page, "fix-pack-dark-en");
    await page.keyboard.press("Control+k");
    await shot(page, "palette-dark-en");
    await page.keyboard.press("Escape");
    await page.getByTestId("open-settings").click();
    await shot(page, "settings-general-dark-en");
    await page.getByTestId("settings-storage").click();
    await page.locator(".provider-item").first().click();
    await shot(page, "settings-storage-dark-en");

    await open(page, "light", "en");
    await shot(page, "home-light-en");
    await page.getByTestId("task-list").getByText("Account survey · acme-prod").click();
    await expect(page.getByTestId("result")).toBeVisible();
    await shot(page, "task-light-en");

    await page.getByTestId("nav-estate").click();
    await page.getByTestId("estate-account").first().click();
    await page.getByTestId("bucket-row").filter({ hasText: "acme-www" }).click();
    await expect(page.getByTestId("timeline")).toBeVisible();
    await shot(page, "estate-bucket-light-en");

    await open(page, "dark", "zh");
    await shot(page, "home-dark-zh");
    await page.getByTestId("task-list").getByText("Account survey · acme-prod").click();
    await expect(page.getByTestId("result")).toBeVisible();
    await shot(page, "task-dark-zh");
    await page.getByTestId("nav-estate").click();
    await page.getByTestId("estate-account").first().click();
    await page.getByTestId("bucket-row").filter({ hasText: "acme-www" }).click();
    await expect(page.getByTestId("timeline")).toBeVisible();
    await shot(page, "estate-bucket-dark-zh");
  } finally {
    await api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", theme: "dark" }) });
    await dropModelProvider(modelId);
    await model.close();
    await s3.close();
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(taken, null, 2));
  }
});
