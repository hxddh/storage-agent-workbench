import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "./seed";

/**
 * The question stays reachable while you read the answer.
 *
 * A real answer is tall — this suite's own fixture measures one at 1616px and a
 * survey answer with a table is taller — so by the time you are in the middle of
 * one the question is several screens above and nothing on screen says what is
 * being answered. Reported behaviour everywhere else (Codex, ChatGPT) keeps it
 * visible; this app dropped it.
 *
 * Asserted through the real stack at a real viewport, because the whole claim is
 * about what is on screen after scrolling: a unit test cannot scroll.
 */
const composer = (page: Page) => page.getByPlaceholder(/Ask Storage Agent/i);
const bar = (page: Page) => page.getByTestId("turn-context");

test.use({ viewport: { width: 1280, height: 800 } });

async function openTall(page: Page) {
  const s = seedSession(4, `tall ${Date.now()}`, "tall");
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await page.getByText(s.title, { exact: true }).first().click();
  await expect(page.locator(".thread-item").first()).toBeVisible({ timeout: 20_000 });
  return s;
}

// The real scroll container, not "the parent of the first item" — those are not
// the same element, and setting scrollTop on the wrong one silently does nothing
// while every assertion still passes.
const scroller = (page: Page) => page.getByTestId("thread-scroll");

test("it never repeats a question that is already on screen", async ({ page }) => {
  await openTall(page);
  // The invariant, rather than "there is no bar at scrollTop 0": the thread
  // lazy-loads earlier messages when you reach the top, which prepends content
  // and moves you off the top again, so "at the top" is not a position a test
  // can hold. What must always be true is that the bar is not noise — it names
  // the question you can no longer see, never one you can.
  for (const frac of [0, 0.3, 0.7, 1]) {
    await scroller(page).evaluate((el, f) => {
      el.scrollTop = el.scrollHeight * (f as number);
    }, frac);
    await page.waitForTimeout(350);
    if ((await bar(page).count()) === 0) continue;
    const shown = (await bar(page).innerText()).replace(/^↑\s*/, "").trim();
    const visibleQuestions = await page.locator("[data-question]").evaluateAll((ns) =>
      ns
        .filter((n) => {
          const r = n.getBoundingClientRect();
          return r.bottom > 0 && r.top < window.innerHeight;
        })
        .map((n) => (n.getAttribute("data-question") || "").trim()),
    );
    expect(visibleQuestions, `at ${frac} the bar repeated a visible question`).not.toContain(shown);
  }
});

test("the question appears once it has scrolled away, and leads back to it", async ({ page }) => {
  await openTall(page);
  await scroller(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(400);

  await expect(bar(page)).toBeVisible();
  const shown = (await bar(page).innerText()).replace(/^↑\s*/, "").trim();
  expect(shown.length).toBeGreaterThan(0);

  // It names a question that is actually in this thread, not a stale one.
  const questions = await page.locator("[data-question]").evaluateAll((ns) =>
    ns.map((n) => (n.getAttribute("data-question") || "").trim()),
  );
  expect(questions.some((q) => q.startsWith(shown.slice(0, 20)))).toBe(true);

  // And it is a way back, not just a label.
  await bar(page).click();
  await page.waitForTimeout(600);
  const top = await scroller(page).evaluate((el) => el.scrollTop);
  const height = await scroller(page).evaluate((el) => el.scrollHeight);
  expect(top).toBeLessThan(height * 0.9);
});

test("it takes no space in the flow, so appearing cannot shift the thread", async ({ page }) => {
  await openTall(page);
  await scroller(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(400);
  await expect(bar(page)).toBeVisible();

  // Asserted directly on the element rather than inferred from scrollHeight
  // before/after: the thread lazy-loads earlier messages when you reach the top,
  // so a before/after comparison races that load and measures it instead of the
  // bar. (It passed alone and failed in the full suite — the timing gave it
  // away.) The claim is that the sticky wrapper contributes zero flow height,
  // which is a property of one element and can simply be read off it.
  const flowHeight = await bar(page).evaluate((el) => (el.parentElement as HTMLElement).offsetHeight);
  expect(flowHeight).toBe(0);

  // …and the bar itself is still a real, visible target despite that.
  const box = await bar(page).boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(16);
});
