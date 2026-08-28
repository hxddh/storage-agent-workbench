import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "./seed";

/**
 * What a long investigation does, on the real stack.
 *
 * The server sends the last 60 messages and reports `message_total`, so past 30
 * exchanges the thread is paged. None of that — the `seq` cursor, the "load
 * earlier" arithmetic, "jump to start", finding text inside a collapsed turn,
 * branching from a message — had any integrated coverage: the units were tested
 * against fixtures, and the E2E never produced a conversation long enough to
 * page.
 */

const composer = (page: Page) => page.getByPlaceholder(/Ask Storage Agent/i);
const thread = (page: Page) => page.locator("main");

/** 40 exchanges = 80 messages, comfortably past the 60-message page. */
const EXCHANGES = 40;

async function openLong(page: Page): Promise<string> {
  const { title } = seedSession(EXCHANGES);
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await page.getByText(title).first().click();
  await expect(thread(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 20_000 });
  return title;
}

const threadText = (page: Page) =>
  thread(page).evaluate((el) => (el.textContent ?? "").replace(/\s+/g, " "));

test.describe("a paged investigation", () => {
  test("offers to load the exchanges it is not showing", async ({ page }) => {
    await openLong(page);
    // 80 messages, 60 shown → 20 above. The count is the server's, not a guess.
    await expect(page.getByTestId("load-earlier")).toBeVisible();
    await expect(page.getByTestId("load-earlier")).toContainText("20");
  });

  test("the newest exchange is the one on screen, not the oldest", async ({ page }) => {
    await openLong(page);
    const txt = await threadText(page);
    expect(txt, "the tail must be present").toContain(`QUESTION-${EXCHANGES - 1}`);
    expect(txt, "the head must be paged out").not.toContain("QUESTION-00 ");
  });

  test("load earlier actually prepends the page above", async ({ page }) => {
    await openLong(page);
    await page.getByTestId("load-earlier").click();
    await expect(page.getByTestId("load-earlier")).toBeHidden({ timeout: 15_000 });
    const txt = await threadText(page);
    expect(txt, "the oldest exchange must arrive").toContain("QUESTION-00 ");
    expect(txt, "and the newest must still be there").toContain(`QUESTION-${EXCHANGES - 1}`);
  });

  test("jump to start reaches the first exchange", async ({ page }) => {
    await openLong(page);
    await page.getByTestId("jump-to-start").click();
    await expect(page.getByTestId("jump-to-start")).toBeHidden({ timeout: 20_000 });
    expect(await threadText(page)).toContain("QUESTION-00 ");
  });

  test("every exchange is present once both pages are loaded", async ({ page }) => {
    await openLong(page);
    await page.getByTestId("jump-to-start").click();
    await expect(page.getByTestId("jump-to-start")).toBeHidden({ timeout: 20_000 });
    const txt = await threadText(page);
    for (let i = 0; i < EXCHANGES; i++) {
      expect(txt, `exchange ${i} must be in the thread`).toContain(
        `QUESTION-${String(i).padStart(2, "0")} `,
      );
    }
  });
});

test.describe("finding something said 30 turns ago", () => {
  test("a match 30 turns back is found and scrolled to", async ({ page }) => {
    await openLong(page);
    await page.keyboard.press("ControlOrMeta+f");
    const box = page.getByPlaceholder(/Find in this investigation/i);
    await expect(box).toBeVisible();
    // This used to also assert that finding a match OPENED a folded turn. Turns
    // no longer fold, so what is left is the part that was always the point:
    // the match is reachable and on screen.
    await box.fill("bucket-25 denies");
    await expect(thread(page).getByText(/ANSWER-25/)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("branching from a message", () => {
  test("creates a second investigation and leaves the first intact", async ({ page }) => {
    await openLong(page);
    const railBefore = await page.locator("nav").evaluate((el) => el.textContent ?? "");

    const q = thread(page).getByText(`QUESTION-${EXCHANGES - 1} `).last();
    await q.scrollIntoViewIfNeeded();
    await q.hover();
    await page.getByTestId("branch-message").last().click();

    // The rail gains a session; the original is still listed.
    await expect
      .poll(async () => (await page.locator("nav").evaluate((el) => el.textContent ?? "")).length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(railBefore.length);
    await expect(thread(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("the composer on a loaded session", () => {
  test("a draft survives switching away and back", async ({ page }) => {
    const title = await openLong(page);
    await composer(page).fill("does bucket-7 have a lifecycle rule");
    await page.getByRole("button", { name: /new investigation/i }).first().click();
    await expect(composer(page)).toHaveValue("", { timeout: 10_000 });
    await page.getByText(title).first().click();
    await expect(composer(page)).toHaveValue("does bucket-7 have a lifecycle rule", {
      timeout: 10_000,
    });
  });
});

/**
 * Find steps through matches, and marks them.
 *
 * It used to report "1 / 29" and move between MESSAGES: the total counted every
 * occurrence, the cursor counted the messages that held at least one, so an
 * answer with twelve mentions was a single stop and next/previous wrapped long
 * before reaching the number on screen. Nothing was marked either — it scrolled
 * a two-thousand-word answer into view and left you to find the word by eye.
 *
 * Painted with the CSS Custom Highlight API, so this asserts through
 * `CSS.highlights` rather than by looking for <mark> elements: nothing is
 * wrapped, which is the point — a streaming answer's DOM is not rewritten by
 * searching it.
 */
test.describe("finding a term that appears many times in one answer", () => {
  test("moves within the answer, not just to it, and marks what it found", async ({ page }) => {
    test.setTimeout(90_000);
    // The "tall" shape on purpose: the default one-line answers mention a
    // bucket once each, so nothing there can tell "stepped to the message" from
    // "stepped to the match". A realistic answer names its bucket in four
    // paragraphs and twenty-four table rows.
    const { title } = seedSession(6, `find ${Date.now()}`, "tall");
    await page.addInitScript(() => {
      localStorage.setItem("saw.lang", "en");
      localStorage.setItem("saw.onboarded", "1");
    });
    await page.goto("/");
    await page.getByText(title, { exact: true }).first().click();
    await expect(page.locator(".thread-item").first()).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.getByTestId("find-input")).toBeVisible();
    await page.getByTestId("find-input").fill("bucket-003");
    await page.waitForTimeout(900);

    const paint = await page.evaluate(() => {
      const reg = (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights;
      return {
        supported: !!reg,
        rest: reg?.get("saw-find")?.size ?? 0,
        active: reg?.get("saw-find-active")?.size ?? 0,
      };
    });
    // The browser this suite runs is Chromium, so the API is there; if that ever
    // changes the assertion should fail loudly rather than skip itself.
    expect(paint.supported).toBe(true);
    expect(paint.active).toBe(1);
    expect(paint.rest).toBeGreaterThan(1);

    // Stepping moves the view WITHIN the answer. On the old cursor every one of
    // these steps stayed on the same message and the thread did not move.
    const at = () => page.getByTestId("thread-scroll").evaluate((el) => Math.round(el.scrollTop));
    const before = await at();
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: /next match/i }).click();
      await page.waitForTimeout(350);
    }
    expect(Math.abs((await at()) - before)).toBeGreaterThan(20);
  });
});

/**
 * The conversation itself is reachable from the keyboard.
 *
 * Everything else in this app had a chord — the palette, find, the inspector,
 * the rail — and the thread, the surface you spend all your time in, had none:
 * reading back through a long investigation meant reaching for the scrollbar.
 * `j`/`k` are bare letters, so the first thing to prove is that they do NOT
 * fire while someone is typing.
 */
test.describe("moving through the conversation from the keyboard", () => {
  test("j and k step through exchanges, and never while typing", async ({ page }) => {
    await openLong(page);
    const at = () => page.getByTestId("thread-scroll").evaluate((el) => Math.round(el.scrollTop));

    const start = await at();
    await page.locator("body").press("k");
    await page.waitForTimeout(700);
    const up = await at();
    expect(up, "k moves back through the thread").toBeLessThan(start);

    await page.locator("body").press("j");
    await page.waitForTimeout(700);
    expect(await at(), "j moves forward again").toBeGreaterThan(up);

    // In the composer they are letters, not commands.
    const box = page.getByPlaceholder(/Ask Storage Agent/i);
    await box.click();
    const before = await at();
    await box.type("jkjk");
    await page.waitForTimeout(500);
    await expect(box).toHaveValue("jkjk");
    expect(await at(), "typing must not scroll the thread").toBe(before);
  });
});
