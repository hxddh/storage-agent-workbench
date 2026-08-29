import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { STATE_FILE } from "./global-setup";
import { seedSession } from "./seed";

/** Real-browser layout gates for Agent Work Results. Object keys, ARNs and URLs
 * must not drag the task sideways; wide data must use the wider result track. */
const PY = `
import sqlite3, sys, uuid
db = sys.argv[1]
conn = sqlite3.connect(db)
sid = "ly-" + uuid.uuid4().hex[:12]
conn.execute("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)",
             (sid, "layout " + sid, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"))
WIDE = ("| bucket | region | objects | size | class | versioned | encrypted | lifecycle | logging | replication | public |\\n"
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\\n"
        + "\\n".join("| acme-production-logs-%02d | us-east-1 | 1204993 | 812 GiB | STANDARD_IA | yes | SSE-KMS | 3 rules | enabled | cross-region | no |" % i for i in range(6)))
ARN = "arn:aws:s3:::acme-production-logs-archive-bucket/very/deep/prefix/path/that/never/breaks/object-name-0001.json.gz"
ANSWER = ("## Wide table\\n\\n" + WIDE
          + "\\n\\n## A key with no break opportunity\\n\\nThe object is at " + ARN + " and the policy denies it."
          + "\\n\\n## A 300-character token\\n\\n" + ("A" * 300)
          + "\\n\\n## A presigned URL\\n\\nhttps://acme-logs.s3.us-east-1.amazonaws.com/deep/prefix/object.json.gz?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-SignedHeaders=host"
          + "\\n\\n- a list item mentioning " + ARN + "\\n\\nThat is the whole account.")
for role, body in (("user", "why is acme-logs denying list?"), ("assistant", ANSWER)):
    conn.execute("INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES (?,?,?,?,?)",
                 ("m-%s-%s" % (sid, uuid.uuid4().hex[:8]), sid, role, body, "2026-01-01T00:00:00Z"))
conn.commit()
print(sid)
`;

function seed(): string {
  const { dataDir } = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { dataDir: string };
  return execFileSync(process.env.E2E_PYTHON || "python3", ["-c", PY, `${dataDir}/app.db`], { encoding: "utf8" }).trim();
}

const navigation = (page: Page) => page.getByTestId("agent-task-navigation");

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(page.getByTestId("agent-composer").getByRole("textbox")).toBeVisible({ timeout: 20_000 });
}

async function openSeeded(page: Page, sid: string) {
  await boot(page);
  await navigation(page).getByText(new RegExp(`layout ${sid}`)).first().click();
  await expect(page.getByTestId("work-result").locator("table").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
}

const measure = (page: Page) => page.getByTestId("task-scroll").evaluate((scroll) => {
  const doc = document.documentElement;
  const table = document.querySelector(".agent-result-prose table") as HTMLElement | null;
  const tableBox = table?.parentElement as HTMLElement | undefined;
  return {
    taskScrollW: scroll.scrollWidth,
    taskClientW: scroll.clientWidth,
    pageScrollW: doc.scrollWidth,
    pageClientW: doc.clientWidth,
    tableExists: !!table,
    tableScrolls: tableBox ? tableBox.scrollWidth > tableBox.clientWidth + 1 : false,
    leaks: (Array.from(document.querySelectorAll(".agent-result-prose p, .agent-result-prose li, .agent-result-prose h1, .agent-result-prose h2, .agent-result-prose h3")) as HTMLElement[])
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${el.tagName.toLowerCase()}:${el.scrollWidth}/${el.clientWidth}`),
  };
});

test.describe("Work Result layout with unbreakable storage identifiers", () => {
  test("does not make the Agent task or page scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSeeded(page, seed());
    const m = await measure(page);
    expect(m.taskScrollW).toBeLessThanOrEqual(m.taskClientW + 1);
    expect(m.pageScrollW).toBeLessThanOrEqual(m.pageClientW + 1);
  });

  test("no prose element overflows its own reading column", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSeeded(page, seed());
    expect((await measure(page)).leaks).toEqual([]);
  });

  test("wide tables scroll inside their own data box", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSeeded(page, seed());
    const m = await measure(page);
    expect(m.tableExists).toBe(true);
    expect(m.tableScrolls).toBe(true);
  });

  test("the same guarantees hold after task navigation folds", async ({ page }) => {
    await openSeeded(page, seed());
    await page.setViewportSize({ width: 820, height: 700 });
    await page.waitForTimeout(400);
    const m = await measure(page);
    expect(m.taskScrollW).toBeLessThanOrEqual(m.taskClientW + 1);
    expect(m.leaks).toEqual([]);
  });
});

test("a capped table fades only while more rows remain below", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { title } = seedSession(2, `fade ${Date.now()}`, "tall");
  await boot(page);
  await navigation(page).getByText(title, { exact: true }).first().click();
  const table = page.getByTestId("work-result").locator("table").first();
  await expect(table).toBeVisible({ timeout: 20_000 });
  const box = table.locator("xpath=..");
  const maskAt = async (top: number | "end") => {
    await box.evaluate((el, value) => { el.scrollTop = value === "end" ? el.scrollHeight : value as number; }, top);
    await page.waitForTimeout(250);
    return box.evaluate((el) => getComputedStyle(el).maskImage || "none");
  };
  expect(await maskAt(0)).not.toBe("none");
  expect(await maskAt("end")).toBe("none");
});

test("data-rich Work Results use a wider track than prose without changing the left edge", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { title } = seedSession(2, `widths ${Date.now()}`, "tall");
  await boot(page);
  await navigation(page).getByText(title, { exact: true }).first().click();
  await expect(page.locator(".agent-result-prose table").first()).toBeVisible({ timeout: 20_000 });
  const w = await page.evaluate(() => {
    const prose = document.querySelector(".agent-result-prose li, .agent-result-prose p") as HTMLElement;
    const wide = document.querySelector(".agent-result-prose .agent-result-wide") as HTMLElement;
    const column = prose.closest(".agent-result-prose") as HTMLElement;
    return {
      prose: Math.round(prose.getBoundingClientRect().width),
      proseLeft: Math.round(prose.getBoundingClientRect().left),
      wide: Math.round(wide.getBoundingClientRect().width),
      wideLeft: Math.round(wide.getBoundingClientRect().left),
      column: Math.round(column.getBoundingClientRect().width),
      font: Math.round(parseFloat(getComputedStyle(prose).fontSize)),
    };
  });
  expect(w.wide).toBeGreaterThan(w.prose + 100);
  expect(w.wide).toBeGreaterThanOrEqual(w.column - 2);
  expect(w.prose).toBeLessThanOrEqual(46 * 16 + 2);
  expect(Math.abs(w.proseLeft - w.wideLeft)).toBeLessThanOrEqual(1);
  expect(w.font).toBeGreaterThanOrEqual(15);
});

test.describe("task navigation at a small window", () => {
  test("folds below 1000px and returns above it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page);
    await expect(navigation(page)).toHaveAttribute("data-collapsed", "false");
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(navigation(page)).toHaveAttribute("data-collapsed", "true");
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(navigation(page)).toHaveAttribute("data-collapsed", "false");
  });

  test("folded navigation can still switch to an existing Agent task", async ({ page }) => {
    const { title } = seedSession(3, `folded ${Date.now()}`);
    await page.addInitScript(() => {
      localStorage.setItem("saw.lang", "en");
      localStorage.setItem("saw.onboarded", "1");
      localStorage.setItem("saw.taskNavigationCollapsed", "1");
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(navigation(page)).toHaveAttribute("data-collapsed", "true");
    await page.getByTestId("task-navigation-palette").click();
    const palette = page.getByRole("dialog");
    const box = palette.getByRole("textbox");
    await expect(box).toBeVisible();
    await box.fill(title.slice(0, 18));
    await palette.getByText(title).first().click();
    await expect(page.locator(".task-item").first()).toBeVisible({ timeout: 20_000 });
  });
});
