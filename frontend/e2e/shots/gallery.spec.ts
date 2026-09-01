import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "../fake-model";
import { STATE_FILE } from "../global-setup";
import { seedInterruptedTask, seedOptimizationTask, seedSession as seedTask } from "../seed";

/**
 * Human visual-review contact sheet for the Agent product.
 *
 * This deliberately does not use pixel baselines: CI, local Chromium and OS font
 * stacks are not raster-identical. Every capture first reaches a real, asserted
 * Agent state against the real Sidecar, then writes PNG evidence for human review.
 *
 * The states are the product model: Delegate, Running + Steer, Decision,
 * Work Result, Execution and contextual Review. There are intentionally no
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

function seedDecisionTask(title = "Review bounded evidence import"): string {
  const { id } = seedTask(1, title, "short");
  const raw = fs.readFileSync(STATE_FILE, "utf8");
  const { dataDir } = JSON.parse(raw) as { dataDir: string };
  // A blocking Decision is DURABLE state since v0.94: a pending task_decisions
  // row for a confirmation-gated (data-moving) action, exactly as the runtime
  // records it when a Work Result proposes an import. The message's
  // proposed_actions carries the same proposal so the in-task card renders.
  const proposal = JSON.stringify([
    {
      title: "Import discovered access logs",
      reason: "This downloads bounded evidence from the discovered logging target.",
      action_type: "plan_access_log_import",
      requires_confirmation: true,
      confidence: "high",
      source_run_ids: [],
      prefill: { bucket_name: "acme-logs", prefix: "logs/2026/", source_type: "access_log" },
    },
  ]);
  const py = `
import json, sqlite3, sys, uuid
conn = sqlite3.connect(sys.argv[1])
sid, proposals = sys.argv[2], sys.argv[3]
conn.execute(
  "UPDATE session_messages SET proposed_actions=? WHERE id=(SELECT id FROM session_messages WHERE session_id=? AND role='assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1)",
  (proposals, sid),
)
item = json.loads(proposals)[0]
conn.execute(
  "INSERT INTO agent_tasks (id, title, status, created_at, updated_at)"
  " VALUES (?, ?, 'needs_decision', datetime('now'), datetime('now'))"
  " ON CONFLICT(id) DO UPDATE SET status='needs_decision'",
  (sid, "seeded"),
)
conn.execute(
  "INSERT INTO task_decisions (id, task_id, action_type, title, reason,"
  " proposal_json_sanitized, status, created_at)"
  " VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))",
  (uuid.uuid4().hex, sid, item["action_type"], item["title"], item["reason"],
   json.dumps(item)),
)
conn.commit()
`;
  execFileSync(process.env.E2E_PYTHON || "python3", ["-c", py, `${dataDir}/app.db`, id, proposal]);
  return title;
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
      const placeholder = lang === "zh" ? /给 Agent 一个目标/ : /Give the Agent a goal/;
      await expect(composer(page)).toHaveAttribute("placeholder", placeholder);
      await expect(page.getByTestId("agent-composer")).toBeVisible();
      await expect(page.getByTestId("delegate-suggestion-checkup")).toHaveCount(0);
      await shoot(page, "01-delegate", theme, lang);
    });

    test("Work Result — durable technical output", async ({ page }) => {
      const title = `Lifecycle diagnosis ${theme} ${lang}`;
      seedTask(3, title, "tall");
      await openAgent(page, theme, lang);
      await openTask(page, title);
      await expect(page.getByTestId("direction-event").first()).toBeVisible();
      await expect(page.getByTestId("work-result").first()).toBeVisible();
      await shoot(page, "02-work-result", theme, lang);
    });

    test("Execution — real tool activity attached to a Work Result", async ({ page }) => {
      const title = `Execution review ${theme} ${lang}`;
      seedTask(2, title, "tall");
      await openAgent(page, theme, lang);
      await openTask(page, title);
      await expect(page.getByTestId("live-trace").last()).toBeVisible();
      await expect(page.getByText("head_bucket").last()).toBeVisible();
      await shoot(page, "03-execution", theme, lang);
    });

    test("Evidence artifact opens from the document", async ({ page }) => {
      const title = `Artifact review ${theme} ${lang}`;
      seedTask(2, title, "tall");
      await openAgent(page, theme, lang);
      await openTask(page, title);
      await page.keyboard.press("Control+i");
      await expect(page.getByTestId("agent-review-panel")).toBeVisible();
      await expect(page.getByTestId("evidence-review")).toBeVisible();
      await expect(page.getByTestId("agent-composer")).toBeVisible();
      await shoot(page, "04-review", theme, lang);
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

    test("Decision — Agent blocks and the task is promoted to Needs you", async ({ page }) => {
      const title = seedDecisionTask(`Review bounded evidence import ${theme} ${lang}`);
      await openAgent(page, theme, lang);
      await openTask(page, title);
      await expect(page.getByTestId("agent-decision-required")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("decision-impact")).toBeVisible();
      await shoot(page, "11-decision-required", theme, lang);
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
      await shoot(page, "15-settings", theme, lang);
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
      [toolTurn("head_bucket", { bucket: "acme-logs" }), textTurn(LIVE_RESULT)],
      { deltaDelayMs: 55 },
    );
    const providerId = await useFakeModel(model.baseUrl);
    try {
      await openAgent(page, "dark");
      await composer(page).fill("Diagnose why acme-logs rejects list operations and keep the evidence auditable.");
      await composer(page).press("Enter");
      await expect(page.getByTestId("agent-composer")).toHaveAttribute("data-agent-state", "working", { timeout: 20_000 });
      await expect(composer(page)).toHaveAttribute("placeholder", /Add direction or constraints|补充方向/);
      await expect(navigation(page).locator('[data-testid="task-row"][data-state="working"]').first()).toBeVisible({ timeout: 20_000 });
      await shoot(page, "10-working-steer", "dark", "en");
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
</style><h1>Storage Agent — v1.04.1 visual review</h1><p>Native Agent: empty start is the Composer, the center is one work record, tools appear in that record, the sidebar is quiet titles. No chat transcript chrome. Core states × dark/light × EN/ZH against the real Sidecar. Missing cells are extra states captured in one locale.</p>${rows}`,
  );
});