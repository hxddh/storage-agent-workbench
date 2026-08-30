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
type Theme = (typeof THEMES)[number];
type Shot = { name: string; theme: string; file: string };
const taken: Shot[] = [];

const LIVE_RESULT =
  "## Finding\n\n" +
  Array.from(
    { length: 16 },
    (_, i) => `Evidence ${i + 1}: the bucket policy does not grant s3:ListBucket to the caller principal.`,
  ).join("\n\n");

async function openAgent(page: Page, theme: Theme = "dark", lang: "en" | "zh" = "en") {
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

async function shoot(page: Page, name: string, theme: Theme) {
  const file = `${name}--${theme}.png`;
  await page.screenshot({ path: path.join(OUT, file), fullPage: false });
  taken.push({ name, theme, file });
}

function seedDecisionTask(): string {
  const title = "Review bounded evidence import";
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
  test.describe(`${theme} Agent surfaces`, () => {
    test("Delegate — fresh Agent task", async ({ page }) => {
      await openAgent(page, theme);
      await expect(page.getByRole("heading", { level: 1, name: /Delegate a goal to the Agent/i })).toBeVisible();
      await expect(composer(page)).toHaveAttribute("placeholder", /Give the Agent a goal/);
      await shoot(page, "01-delegate", theme);
    });

    test("Work Result — durable technical output", async ({ page }) => {
      const title = `Lifecycle diagnosis ${theme}`;
      seedTask(3, title, "tall");
      await openAgent(page, theme);
      await openTask(page, title);
      await expect(page.getByTestId("direction-event").first()).toBeVisible();
      await expect(page.getByTestId("work-result").first()).toBeVisible();
      await shoot(page, "02-work-result", theme);
    });

    test("Execution — real tool activity attached to a Work Result", async ({ page }) => {
      const title = `Execution review ${theme}`;
      seedTask(2, title, "tall");
      await openAgent(page, theme);
      await openTask(page, title);
      const toggle = page.getByTestId("execution-summary-toggle").last();
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(page.getByTestId("execution-summary").last()).toBeVisible();
      await shoot(page, "03-execution", theme);
    });

    test("Review — contextual artifacts beside the active task", async ({ page }) => {
      const title = `Artifact review ${theme}`;
      seedTask(2, title, "tall");
      await openAgent(page, theme);
      await openTask(page, title);
      await page.getByTestId("agent-task-review").click();
      await expect(page.getByTestId("agent-review-panel")).toBeVisible();
      await expect(page.getByTestId("agent-composer")).toBeVisible();
      await shoot(page, "04-review", theme);
    });

    test("Task navigation — compact command center, not history chrome", async ({ page }) => {
      const title = `Active storage task ${theme}`;
      seedTask(2, title, "short");
      await openAgent(page, theme);
      await openTask(page, title);
      await page.getByTestId("task-navigation-toggle").click();
      await expect(navigation(page)).toHaveAttribute("data-collapsed", "true");
      await shoot(page, "05-task-navigation-collapsed", theme);
    });
  });
}

test.describe("Agent runtime states", () => {
  test("Working + Steer — execution remains controllable and promoted in the command center", async ({ page }) => {
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
      await expect(page.getByTestId("agent-live-status")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("agent-composer")).toHaveAttribute("data-agent-state", "working");
      await expect(composer(page)).toHaveAttribute("placeholder", /Steer the Agent/);
      await expect(navigation(page).getByTestId("task-queue-running")).toBeVisible({ timeout: 20_000 });
      await shoot(page, "10-working-steer", "dark");
    } finally {
      await dropModelProvider(providerId);
      await model.close();
    }
  });

  test("Decision — Agent blocks and the task is promoted to Needs you", async ({ page }) => {
    const title = seedDecisionTask();
    await openAgent(page, "dark");
    await openTask(page, title);
    await expect(page.getByTestId("agent-decision-required")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("decision-impact")).toBeVisible();
    await expect(page.getByTestId("agent-decline-action")).toBeVisible();
    await expect(page.getByTestId("agent-task-header")).toContainText(/Needs decision/i);
    await expect(navigation(page).getByTestId("task-queue-needs-you")).toContainText(title);
    await shoot(page, "11-decision-required", "dark");
    await page.getByTestId("agent-task-review").click();
    await expect(page.getByTestId("decision-history")).toBeVisible();
    await shoot(page, "11b-decision-history", "dark");
  });

  test("Needs attention — interrupted execution offers Resume", async ({ page }) => {
    const { title } = seedInterruptedTask("Interrupted lifecycle diagnosis");
    await openAgent(page, "dark");
    await navigation(page).getByText(title, { exact: true }).first().click();
    await expect(page.getByTestId("task-resume")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("task-resume-action")).toBeVisible();
    await shoot(page, "11c-resume", "dark");
  });

  test("Runtime attention — unavailable execution is explicit", async ({ page }) => {
    await openAgent(page, "dark");
    await page.route("**/health", (route) => route.abort());
    await expect(page.getByTestId("offline-banner")).toBeVisible({ timeout: 15_000 });
    await shoot(page, "12-runtime-unavailable", "dark");
  });

  test("Narrow workspace — task remains primary", async ({ page }) => {
    const title = "Narrow active task";
    seedTask(2, title, "tall");
    await openAgent(page, "dark");
    await openTask(page, title);
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(navigation(page)).toHaveAttribute("data-collapsed", "true");
    await expect(page.getByTestId("work-result").last()).toBeVisible();
    await shoot(page, "13-narrow-task", "dark");
  });

  test("Chinese — the same Agent product, not a translated legacy shell", async ({ page }) => {
    const title = "对象存储生命周期诊断";
    seedTask(2, title, "short");
    await openAgent(page, "dark", "zh");
    await navigation(page).getByText(title, { exact: true }).first().click();
    await expect(page.getByTestId("work-result").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("agent-task-navigation").getByRole("button", { name: /新任务/ })).toBeVisible();
    await shoot(page, "14-chinese-agent", "dark");
  });

  test("Settings — providers and safety remain secondary configuration", async ({ page }) => {
    await openAgent(page, "dark");
    await page.getByTestId("task-navigation-settings").click();
    await expect(page.getByRole("dialog", { name: /Settings/i })).toBeVisible();
    await expect(page.getByTestId("settings-price-table")).toBeVisible();
    await expect(page.getByTestId("price-table-example")).toBeVisible();
    await shoot(page, "15-settings", "dark");
  });

  test("Remediation plan and Verify live on the Task, not a new destination", async ({ page }) => {
    const title = "Remediation plan review";
    seedOptimizationTask(title, "review");
    await openAgent(page, "dark");
    await openTask(page, title);
    await expect(page.getByTestId("task-verify")).toBeVisible({ timeout: 20_000 });
    await shoot(page, "16-remediation-verify", "dark");
    await page.getByTestId("agent-task-review").click();
    await expect(page.getByTestId("remediation-plan-status")).toBeVisible();
    await expect(page.getByTestId("task-baselines")).toBeVisible();
    await expect(page.getByTestId("task-drift")).toBeVisible();
    await expect(page.getByTestId("task-revisit")).toBeVisible();
    await shoot(page, "16b-plan-baseline-review", "dark");
  });

  test("Catch-up revisit state is labelled in Review", async ({ page }) => {
    const title = "Catch-up revisit caretaker";
    seedOptimizationTask(title, "catchup");
    await openAgent(page, "dark");
    await navigation(page).getByText(title, { exact: true }).first().click();
    await page.getByTestId("agent-task-review").click();
    await expect(page.getByTestId("task-revisit")).toContainText(/Catch-up/i);
    await shoot(page, "17-revisit-catchup", "dark");
  });
});

test.afterAll(() => {
  const names = [...new Set(taken.map((shot) => shot.name))].sort();
  const rows = names.map((name) => {
    const cells = THEMES.map((theme) => {
      const shot = taken.find((item) => item.name === name && item.theme === theme);
      return shot
        ? `<figure><figcaption>${theme}</figcaption><a href="${shot.file}"><img src="${shot.file}" alt="${name} ${theme}" /></a></figure>`
        : "<figure class=missing><figcaption>not captured</figcaption></figure>";
    }).join("");
    return `<section><h2>${name}</h2><div class=pair>${cells}</div></section>`;
  }).join("\n");

  fs.writeFileSync(
    path.join(OUT, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Storage Agent visual review</title><style>
body{margin:0;padding:32px;background:#111318;color:#eef0f5;font:14px Inter,system-ui,sans-serif}h1{font-size:26px;margin:0 0 8px}p{color:#9ca3af;margin:0 0 32px;max-width:760px;line-height:1.6}section{margin:0 0 42px}h2{font-size:15px;font-weight:600;margin:0 0 12px;color:#c9ced8}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{margin:0;background:#191c22;border:1px solid #2a2f39;border-radius:12px;overflow:hidden}figcaption{padding:8px 12px;color:#8f98a8;border-bottom:1px solid #2a2f39}img{display:block;width:100%;height:auto}.missing{min-height:80px}@media(max-width:900px){.pair{grid-template-columns:1fr}}
</style><h1>Storage Agent — Agent-native visual review</h1><p>Real Sidecar states used for human review: delegation, execution, steering, decisions, work results, artifacts and live task queues. No legacy Chat-era surfaces are represented.</p>${rows}`,
  );
});