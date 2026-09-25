import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "../fake-model";
import { seedExecutionLog, seedInterruptedTask, seedOptimizationTask, seedSession as seedTask } from "../seed";

/**
 * Human visual-review contact sheet for the Agent product.
 *
 * This deliberately does not use pixel baselines: CI, local Chromium and OS font
 * stacks are not raster-identical. Every capture first reaches a real, asserted
 * Agent state against the real Sidecar, then writes PNG evidence for human review.
 *
 * The states are the product model: Delegate, live work + Steer, the Result,
 * the Work log, Execution detail and Settings. There are intentionally no
 * screenshots for deleted Chat-era navigation, transcript pages or inspector UI.
 */

const OUT = path.resolve("shots");
const THEMES = ["dark", "light"] as const;
const LANGS = ["en", "zh"] as const;
type Theme = (typeof THEMES)[number];
type Lang = (typeof LANGS)[number];
type Shot = { name: string; theme: string; lang: string; file: string };
const taken: Shot[] = [];

const LIVE_RESULT =
  "## Finding\n\n" +
  Array.from(
    { length: 16 },
    (_, i) => `Evidence ${i + 1}: the bucket policy does not grant s3:ListBucket to the caller principal.`,
  ).join("\n\n");

async function openAgent(page: Page, theme: Theme = "dark", lang: Lang = "en") {
  await page.addInitScript(
    ([nextTheme, nextLang]) => {
      localStorage.setItem("saw.lang", nextLang as string);
      localStorage.setItem("saw.onboarded", "1");
      localStorage.setItem("saw.theme", nextTheme as string);
    },
    [theme, lang] as const,
  );
  await page.goto("/");
  await expect(page.getByTestId("agent-shell")).toBeVisible({ timeout: 20_000 });
}

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const navigation = (page: Page) => page.getByTestId("agent-task-navigation");

async function openTask(page: Page, title: string) {
  await navigation(page).getByText(title, { exact: true }).first().click();
  await expect(page.getByTestId("work-result").first()).toBeVisible({ timeout: 20_000 });
}

async function shoot(page: Page, name: string, theme: Theme, lang: Lang = "en") {
  const file = `${name}--${theme}--${lang}.png`;
  await page.screenshot({ path: path.join(OUT, file), fullPage: false });
  taken.push({ name, theme, lang, file });
}

test.beforeAll(() => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
});

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: "serial" });

for (const theme of THEMES) {
  for (const lang of LANGS) {
  test.describe(`${theme} ${lang} Agent surfaces`, () => {
    test("Delegate — fresh Agent task", async ({ page }) => {
      await openAgent(page, theme, lang);
      const placeholder = lang === "zh" ? /描述要委派的存储工作/ : /Describe the storage work to delegate/;
      await expect(composer(page)).toHaveAttribute("placeholder", placeholder);
      await expect(page.getByTestId("agent-composer")).toBeVisible();
      await expect(page.getByTestId("delegate-suggestion-checkup")).toHaveCount(0);
      await shoot(page, "01-delegate", theme, lang);
    });

    test("Result — the conclusion first, the work log below", async ({ page }) => {
      const title = `Lifecycle diagnosis ${theme} ${lang}`;
      seedTask(3, title, "tall", true);
      await openAgent(page, theme, lang);
      await openTask(page, title);
      await expect(page.getByTestId("result-conclusion")).toBeVisible();
      await expect(page.getByTestId("result-finding")).toHaveCount(4);
      await expect(page.getByTestId("task-scroll")).toHaveJSProperty("scrollTop", 0);
      await shoot(page, "02-work-result", theme, lang);
    });

    test("Execution — real tool activity attached to a Work Result", async ({ page }) => {
      const title = `Execution review ${theme} ${lang}`;
      seedTask(2, title, "tall");
      await openAgent(page, theme, lang);
      await openTask(page, title);
      await expect(page.getByTestId("live-trace").last()).toBeVisible();
      // A finished Worked group is collapsed; open it for the capture.
      const group = page.getByTestId("worked-group").last();
      if ((await group.getAttribute("data-expanded")) === "false") await group.getByTestId("execution-head").click();
      await expect(page.locator('[data-testid="worked-row"][data-tool="head_bucket"]').last()).toBeVisible();
      await shoot(page, "03-execution", theme, lang);
    });

    test("Details open in the inspector beside the Result", async ({ page }) => {
      const title = `Artifact review ${theme} ${lang}`;
      seedTask(2, title, "short", true);
      await openAgent(page, theme, lang);
      await openTask(page, title);
      await page.getByTestId("task-detail-toggle-report").click();
      await expect(page.getByTestId("task-sidepane")).toHaveAttribute("data-kind", "report");
      await expect(page.getByTestId("task-detail-report")).toBeVisible();
      await expect(page.getByTestId("agent-composer")).toBeVisible();
      await shoot(page, "04-artifacts", theme, lang);
    });

    test("Task navigation — task list, not a console", async ({ page }) => {
      const title = `Active storage task ${theme} ${lang}`;
      seedTask(2, title, "short");
      await openAgent(page, theme, lang);
      await openTask(page, title);
      await page.getByTestId("task-navigation-toggle").click();
      await expect(navigation(page)).toHaveAttribute("data-collapsed", "true");
      await shoot(page, "05-task-navigation-collapsed", theme, lang);
    });

    test("Needs attention — interrupted execution offers Resume", async ({ page }) => {
      const { title } = seedInterruptedTask(`Interrupted ${theme} ${lang}`);
      await openAgent(page, theme, lang);
      await navigation(page).getByText(title, { exact: true }).first().click();
      await expect(page.getByTestId("task-resume")).toBeVisible({ timeout: 20_000 });
      await shoot(page, "11c-resume", theme, lang);
    });

    test("Settings — model, storage, language, theme", async ({ page }) => {
      await openAgent(page, theme, lang);
      await page.getByTestId("task-navigation-settings").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByTestId("settings-price-table")).toHaveCount(0);
      await expect(page.getByTestId("settings-safety")).toBeVisible();
      await shoot(page, "15-settings", theme, lang);
    });

    test("Settings — model providers as a native pane with presets", async ({ page }) => {
      await openAgent(page, theme, lang);
      await page.getByTestId("task-navigation-settings").click();
      await page.getByRole("button", { name: lang === "zh" ? /^模型提供商$/ : /^Model Providers$/ }).first().click();
      await expect(page.getByTestId("settings-model-providers")).toBeVisible();
      await page.getByTestId("model-add").click();
      await expect(page.getByTestId("model-presets")).toBeVisible();
      await shoot(page, "16-settings-model-presets", theme, lang);
      await page.getByRole("menuitem", { name: "Ollama" }).click();
      await expect(page.getByTestId("model-editor")).toBeVisible();
      await shoot(page, "17-settings-model-editor", theme, lang);
    });

    test("Execution detail — one durable Execution read from its event log", async ({ page }) => {
      const title = `Execution detail ${theme} ${lang}`;
      const { id } = seedTask(2, title, "tall");
      seedExecutionLog(id);
      await openAgent(page, theme, lang);
      await openTask(page, title);
      await page.getByTestId("task-detail-toggle-execution").click();
      await page.getByTestId("execution-row").first().click();
      await expect(page.getByTestId("execution-detail")).toBeVisible();
      await expect(page.getByTestId("execution-status")).toBeVisible();
      await expect(page.getByTestId("execution-detail-body").getByTestId("worked-group")).toBeVisible();
      await shoot(page, "18-execution-detail", theme, lang);
    });

    test("Analysis figures — cost and drift from real artifacts", async ({ page }) => {
      const title = `Cost and drift ${theme} ${lang}`;
      seedOptimizationTask(title, "review");
      await openAgent(page, theme, lang);
      await openTask(page, title);
      await expect(page.getByTestId("viz-cost")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("viz-drift")).toBeVisible();
      await expect(page.getByTestId("task-analysis-figures")).toBeVisible();
      await shoot(page, "20-analysis-figures", theme, lang);
    });
  });
  }
}

test.describe("Agent runtime states", () => {
  test("Working + Steer — execution remains controllable", async ({ page }) => {
    test.setTimeout(120_000);
    const model = await startFakeModel(
      [toolTurn("read_skill", { name: "storageops-security-iam-policy" }), textTurn(LIVE_RESULT)],
      { deltaDelayMs: 120 },
    );
    const providerId = await useFakeModel(model.baseUrl);
    try {
      await openAgent(page, "dark");
      await composer(page).fill("Diagnose why acme-logs rejects list operations and keep the evidence auditable.");
      await composer(page).press("Enter");
      await expect(page.getByTestId("agent-composer")).toHaveAttribute("data-agent-state", "working", { timeout: 20_000 });
      await expect(composer(page)).toHaveAttribute("placeholder", /Steer this execution|补充这次执行的方向/);
      await expect(navigation(page).locator('[data-testid="task-row"][data-state="working"]').first()).toBeVisible({ timeout: 20_000 });
      // v2.1 — live work is visible as it happens: the commentary and the
      // tool rows the Agent is running, not a bare "Working" line.
      await expect(page.getByTestId("task-live").getByTestId("worked-row").first()).toBeVisible({ timeout: 30_000 });
      await shoot(page, "10-working-steer", "dark", "en");
    } finally {
      await dropModelProvider(providerId);
      await model.close();
    }
  });

  test("Compaction marker — the runtime compacted the context before this turn", async ({ page }) => {
    test.setTimeout(150_000);
    const model = await startFakeModel(
      [textTurn("The acme bucket policy grants s3:GetObject to every principal."), textTurn("After compaction: the policy is still public.")],
      { compaction: "Summary: checked acme bucket; policy is public." },
    );
    const providerId = await useFakeModel(model.baseUrl);
    try {
      await openAgent(page, "dark");
      await composer(page).fill("check the acme bucket policy");
      await composer(page).press("Enter");
      await expect(page.locator('[data-testid="work-result"][data-streaming="false"]').filter({ hasText: /every principal/ }).last()).toBeVisible({ timeout: 90_000 });
      await expect(page.getByTestId("agent-composer")).not.toHaveAttribute("data-agent-state", "working", { timeout: 60_000 });
      await page.keyboard.press("Control+k");
      await page.getByTestId("command-palette").getByRole("button", { name: /Compact context/ }).click();
      await expect(page.getByTestId("toast-viewport")).toContainText(/Context compacted/, { timeout: 30_000 });
      await composer(page).fill("and now?");
      await composer(page).press("Enter");
      await expect(page.locator('[data-testid="work-result"][data-streaming="false"]').filter({ hasText: /still public/ }).last()).toBeVisible({ timeout: 90_000 });
      await expect(page.getByTestId("context-compacted").last()).toBeVisible({ timeout: 30_000 });
      await shoot(page, "23-context-compacted", "dark", "en");
    } finally {
      await dropModelProvider(providerId);
      await model.close();
    }
  });

  test("Runtime attention — unavailable execution is explicit", async ({ page }) => {
    await openAgent(page, "dark");
    await page.route("**/health", (route) => route.abort());
    await expect(page.getByTestId("offline-banner")).toBeVisible({ timeout: 15_000 });
    await shoot(page, "12-runtime-unavailable", "dark", "en");
  });

  test("Command palette overlay", async ({ page }) => {
    await openAgent(page, "dark");
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await shoot(page, "18-command-palette", "dark", "en");
  });

  test("Provenance preview on a finding", async ({ page }) => {
    const { title, id } = seedOptimizationTask("Provenance preview", "review");
    await openAgent(page, "dark");
    await openTask(page, title);
    const mark = page.getByTestId(`finding-provenance-fnd-${id.slice(-8)}`).first();
    await expect(mark).toBeVisible({ timeout: 20_000 });
    await mark.hover();
    await expect(page.getByTestId("provenance-preview").first()).toBeVisible();
    await shoot(page, "21-provenance-preview", "dark", "en");
  });

  test("Narrow workspace — task remains primary", async ({ page }) => {
    const title = "Narrow active task";
    seedTask(2, title, "tall");
    await openAgent(page, "dark");
    await openTask(page, title);
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(navigation(page)).toHaveAttribute("data-collapsed", "true");
    await expect(page.getByTestId("work-result").last()).toBeVisible();
    await shoot(page, "13-narrow-task", "dark", "en");
  });
});

test.afterAll(() => {
  const names = [...new Set(taken.map((shot) => shot.name))].sort();
  const cellsOf = (name: string) =>
    THEMES.flatMap((theme) => LANGS.map((lang) => {
      const shot = taken.find((item) => item.name === name && item.theme === theme && item.lang === lang);
      return shot
        ? `<figure><figcaption>${theme} · ${lang}</figcaption><a href="${shot.file}"><img src="${shot.file}" alt="${name} ${theme} ${lang}" /></a></figure>`
        : `<figure class=missing><figcaption>${theme} · ${lang} missing</figcaption></figure>`;
    })).join("");
  const rows = names.map((name) => `<section><h2>${name}</h2><div class=pair>${cellsOf(name)}</div></section>`).join("\n");

  fs.writeFileSync(
    path.join(OUT, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Storage Agent visual review</title><style>
body{margin:0;padding:32px;background:#111318;color:#eef0f5;font:14px Inter,system-ui,sans-serif}h1{font-size:26px;margin:0 0 8px}p{color:#9ca3af;margin:0 0 32px;max-width:760px;line-height:1.6}section{margin:0 0 42px}h2{font-size:15px;font-weight:600;margin:0 0 12px;color:#c9ced8}.pair{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}figure{margin:0;background:#191c22;border:1px solid #2a2f39;border-radius:12px;overflow:hidden}figcaption{padding:8px 12px;color:#8f98a8;border-bottom:1px solid #2a2f39;font-size:12px}img{display:block;width:100%;height:auto}.missing{min-height:80px}@media(max-width:1100px){.pair{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style><h1>Storage Agent — v2.1.0 visual review</h1><p>Native agent, result-first window: sidebar · title bar (name and state as one group) · one Task document · one Composer. Work in progress streams at the top — commentary and the tool rows the Agent is running, each row a verb with its target. A Task opens on its Result: one meta line (when · evidence · gaps · tool calls), the recorded conclusion (answer, findings by severity, next steps as asks), the full answer, figures, and detail rows (Evidence · Report · Execution) that expand in place. The Work log sits below. Nothing waits for approval and there is no plan card; Settings states the read-only floor in General. Core states × dark/light × EN/ZH against the real Sidecar. Missing cells are extra states captured in one locale.</p>${rows}`,
  );
});