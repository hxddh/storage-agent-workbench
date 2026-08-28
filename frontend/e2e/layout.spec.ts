import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { STATE_FILE } from "./global-setup";
import { seedSession } from "./seed";

/**
 * An answer must not drag the thread sideways.
 *
 * Reported from the shipped app: *"输出格式不优雅了…表格没有了，内容很杂乱"*.
 *
 * This product's prose is full of tokens with no break opportunity — object
 * keys, `arn:aws:s3:::…/very/deep/prefix/name.json.gz`, endpoint URLs,
 * presigned URLs, checksums. The prose container declared no `overflow-wrap`,
 * so one of them set the paragraph's content width and the whole thread became
 * horizontally scrollable. Measured at a 1280px viewport: a single 300-character
 * token pushed the thread's `scrollWidth` to **2881px in a 1036px column**. Every
 * answer then had to be read by scrolling right, and wide tables were carried
 * off-screen with it — which is what "tables are gone, content is a mess" is.
 *
 * It was masked until v0.73.0: `.thread-item` carried `content-visibility: auto`,
 * which implies `contain: paint`, so the overflow was being CLIPPED rather than
 * fixed — the text was silently unreachable instead of visibly misplaced.
 * Removing that (on its own measurements) exposed the defect underneath.
 *
 * jsdom cannot see any of this — it has no layout — which is why the unit suite
 * was green throughout. This runs in a real browser.
 */

const PY = `
import sqlite3, sys, uuid
db = sys.argv[1]
conn = sqlite3.connect(db)
sid = "ly-" + uuid.uuid4().hex[:12]
conn.execute("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)",
             (sid, "layout " + sid, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"))
WIDE = ("| bucket | region | objects | size | class | versioned | encrypted | lifecycle | logging | replication | public |\\n"
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\\n"
        + "\\n".join("| acme-production-logs-%02d | us-east-1 | 1204993 | 812 GiB | STANDARD_IA | yes | SSE-KMS | 3 rules | enabled | cross-region | no |" % i
                    for i in range(6)))
ARN = "arn:aws:s3:::acme-production-logs-archive-bucket/very/deep/prefix/path/that/never/breaks/object-name-0001.json.gz"
ANSWER = ("## Wide table\\n\\n" + WIDE
          + "\\n\\n## A key with no break opportunity\\n\\nThe object is at " + ARN + " and the policy denies it."
          + "\\n\\n## A 300-character token\\n\\n" + ("A" * 300)
          + "\\n\\n## A presigned URL\\n\\nhttps://acme-logs.s3.us-east-1.amazonaws.com/deep/prefix/object.json.gz?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-SignedHeaders=host"
          + "\\n\\n- a list item mentioning " + ARN + "\\n\\nThat is the whole account.")
for role, body in (("user", "why is acme-logs denying list?"), ("assistant", ANSWER)):
    conn.execute("INSERT INTO session_messages (id, session_id, role, content, created_at)"
                 " VALUES (?,?,?,?,?)",
                 ("m-%s-%s" % (sid, uuid.uuid4().hex[:8]), sid, role, body, "2026-01-01T00:00:00Z"))
conn.commit()
print(sid)
`;

function seed(): string {
  const { dataDir } = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { dataDir: string };
  return execFileSync(process.env.E2E_PYTHON || "python3", ["-c", PY, `${dataDir}/app.db`], {
    encoding: "utf8",
  }).trim();
}

async function openSeeded(page: Page, sid: string) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(page.getByPlaceholder(/Ask Storage Agent/i)).toBeVisible({ timeout: 20_000 });
  await page.getByText(new RegExp(`layout ${sid}`)).first().click();
  await expect(page.locator("main table").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(600);
}

const measure = (page: Page) =>
  page.evaluate(() => {
    const sc = document.querySelector("main .overflow-auto") as HTMLElement;
    const doc = document.documentElement;
    const table = document.querySelector("main table") as HTMLElement | null;
    const wrap = table?.parentElement as HTMLElement | undefined;
    return {
      threadScrollW: sc.scrollWidth,
      threadClientW: sc.clientWidth,
      pageScrollW: doc.scrollWidth,
      pageClientW: doc.clientWidth,
      tableExists: !!table,
      tableScrolls: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : false,
      // Any element whose own content overflows it horizontally, excluding the
      // ones that are SUPPOSED to scroll (a table wrapper, a code block).
      leaks: (Array.from(document.querySelectorAll("main p, main li, main h1, main h2, main h3")) as HTMLElement[])
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => `${el.tagName.toLowerCase()}:${el.scrollWidth}/${el.clientWidth}`),
    };
  });

test.describe("an answer full of unbreakable tokens", () => {
  test("does not make the thread scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSeeded(page, seed());
    const m = await measure(page);
    expect(m.threadScrollW, `thread scrolls sideways: ${JSON.stringify(m)}`)
      .toBeLessThanOrEqual(m.threadClientW + 1);
    expect(m.pageScrollW).toBeLessThanOrEqual(m.pageClientW + 1);
  });

  test("no paragraph, list item or heading overflows its own column", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSeeded(page, seed());
    const m = await measure(page);
    expect(m.leaks, `overflowing prose: ${m.leaks.join(", ")}`).toEqual([]);
  });

  test("the wide table still scrolls inside its own box rather than being squashed", async ({
    page,
  }) => {
    // The wrap rule must not be paid for by flattening tables: a wide table is
    // supposed to scroll in place, which is the whole point of its wrapper.
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSeeded(page, seed());
    const m = await measure(page);
    expect(m.tableExists).toBe(true);
    expect(m.tableScrolls, "the wide table should scroll inside its wrapper").toBe(true);
  });

  test("holds at a narrow window too", async ({ page }) => {
    // Open first, then narrow: below 1000px the rail folds itself and stops
    // listing the session this would click. The assertion is about the answer's
    // layout at 820px, not about how you got there.
    await openSeeded(page, seed());
    await page.setViewportSize({ width: 820, height: 700 });
    await page.waitForTimeout(500);
    const m = await measure(page);
    expect(m.threadScrollW).toBeLessThanOrEqual(m.threadClientW + 1);
    expect(m.leaks).toEqual([]);
  });
});

/**
 * The fade at the foot of a capped table is a signal, not a decoration.
 *
 * A table past 12 rows scrolls inside itself, and the last visible row used to
 * be sliced through the middle with nothing saying why — which reads as a
 * rendering fault rather than as "there is more below". The fix was a mask over
 * the last 40px. Applied unconditionally, that fix has its own bug: at the END
 * of the scroll there is nothing below, and the final row — the one a reader
 * scrolled all the way down for — sits permanently dimmed with no way to bring
 * it clear. So the fade has to follow the scroll.
 *
 * jsdom cannot see this: with no layout, `scrollHeight` and `clientHeight` are
 * both 0 and the mask never applies at all. It needs a real browser.
 */
test.describe("a capped table's fade", () => {
  const box = (page: Page) => page.locator(".thread-item table").first().locator("xpath=..");

  test("says 'more below' only while there is more below", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const { title } = seedSession(2, `fade ${Date.now()}`, "tall");
    await page.addInitScript(() => {
      localStorage.setItem("saw.lang", "en");
      localStorage.setItem("saw.onboarded", "1");
    });
    await page.goto("/");
    await page.getByText(title, { exact: true }).first().click();
    await expect(page.locator(".thread-item table").first()).toBeVisible({ timeout: 20_000 });

    const maskAt = async (scrollTop: number | "end") => {
      await box(page).evaluate((el, top) => {
        el.scrollTop = top === "end" ? el.scrollHeight : (top as number);
      }, scrollTop);
      await page.waitForTimeout(250);
      return await box(page).evaluate((el) => getComputedStyle(el).maskImage || "none");
    };

    expect(await maskAt(0), "at the top there IS more below").not.toBe("none");
    expect(await maskAt("end"), "at the end there is not").toBe("none");
  });
});

/**
 * Prose and data are not the same width, and the window is not one column.
 *
 * A 1440px window used to render a 768px column with 428px of empty space
 * beside it — wide enough for a paragraph, and not nearly wide enough for a
 * twelve-column bucket table, which then scrolled inside itself while the room
 * it needed sat unused. One width cannot serve both, so there are two: a
 * reading measure for prose, the full column for data, sharing a left edge.
 */
test.describe("the two widths of an answer", () => {
  async function widths(page: Page) {
    return await page.evaluate(() => {
      const prose = document.querySelector(".thread-prose li, .thread-prose p") as HTMLElement;
      const table = document.querySelector(".thread-prose .thread-bleed") as HTMLElement;
      // The track the answer actually owns, not the outer column: an assistant
      // turn is indented by its gutter, so "the width available to this answer"
      // and "the width of the thread" stopped being the same number.
      const col = prose.closest(".thread-prose") as HTMLElement;
      const px = (s: string) => Math.round(parseFloat(s));
      return {
        prose: Math.round(prose.getBoundingClientRect().width),
        proseLeft: Math.round(prose.getBoundingClientRect().left),
        proseFont: px(getComputedStyle(prose).fontSize),
        table: Math.round(table.getBoundingClientRect().width),
        tableLeft: Math.round(table.getBoundingClientRect().left),
        column: Math.round(col.getBoundingClientRect().width),
      };
    });
  }

  test("a table uses the room a paragraph does not want", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { title } = seedSession(2, `widths ${Date.now()}`, "tall");
    await page.addInitScript(() => {
      localStorage.setItem("saw.lang", "en");
      localStorage.setItem("saw.onboarded", "1");
    });
    await page.goto("/");
    await page.getByText(title, { exact: true }).first().click();
    await expect(page.locator(".thread-prose table").first()).toBeVisible({ timeout: 20_000 });

    const w = await widths(page);
    // The table is wider than the paragraph — the whole point.
    expect(w.table).toBeGreaterThan(w.prose + 100);
    // …and it fills the track the answer owns, so the space is actually used.
    expect(w.table).toBeGreaterThanOrEqual(w.column - 2);
    // The paragraph stays at a reading measure rather than growing with it.
    expect(w.prose).toBeLessThanOrEqual(46 * 16 + 2);
    // Both start at the same place. A centred reading measure inside a wider
    // column gives an answer two left edges and stops it reading as one thing.
    expect(Math.abs(w.proseLeft - w.tableLeft)).toBeLessThanOrEqual(1);
    // And the prose is set at a size meant for reading, not for a control strip.
    expect(w.proseFont).toBeGreaterThanOrEqual(15);
  });
});

/**
 * The rail folds itself when the window stops having room for it.
 *
 * Measured at 900px before this: the rail held 244px — 27% of the window — and
 * the thread's column was squeezed to 630px, narrower than the measure an
 * answer is set at. It is not a preference at that size, it is a squeeze.
 */
test.describe("the rail at a small window", () => {
  const rail = (page: Page) => page.getByTestId("session-rail");

  test("folds below 1000px and comes back above it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
      localStorage.setItem("saw.lang", "en");
      localStorage.setItem("saw.onboarded", "1");
    });
    await page.goto("/");
    await expect(rail(page)).toHaveAttribute("data-collapsed", "false");

    await page.setViewportSize({ width: 900, height: 800 });
    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");

    // Widening gives back the rail the user chose: the fold was the window's
    // doing, and it must not be remembered as if it were theirs.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(rail(page)).toHaveAttribute("data-collapsed", "false");
  });

  test("a folded rail still has a way back to your conversations", async ({ page }) => {
    // It did not. Expand / new chat / settings, and no route to an existing
    // session — survivable while folding was a choice, not survivable once a
    // narrow window folds it for you.
    const { title } = seedSession(3, `folded ${Date.now()}`);
    await page.addInitScript(() => {
      localStorage.setItem("saw.lang", "en");
      localStorage.setItem("saw.onboarded", "1");
      localStorage.setItem("saw.railCollapsed", "1");
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");

    await page.getByTestId("rail-open-palette").click();
    const box = page.getByPlaceholder(/Search chats or run a command/i);
    await expect(box).toBeVisible();
    await box.fill(title.slice(0, 18));
    await page.getByText(title).first().click();
    await expect(page.locator(".thread-item").first()).toBeVisible({ timeout: 20_000 });
  });
});
