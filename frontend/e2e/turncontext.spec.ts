import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, useFakeModel } from "./fake-model";
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

test("it cannot change the height of the thread it floats over", async ({ page }) => {
  await openTall(page);
  await scroller(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(400);
  await expect(bar(page)).toBeVisible();

  // The bar mounts and unmounts as a function of scroll position. If it lives
  // inside the scroller, that makes the CONTENT HEIGHT a function of scroll
  // position — and the thread's convergence run re-jumps to the bottom every
  // frame until the height holds still, ignoring scroll events while it does.
  // The first version of this bar was a zero-height sticky element inside the
  // scroller and still moved `scrollHeight` by 8px (its `-mt-2`), which was
  // enough to turn `landing.spec.ts`'s 'jump to latest' test red on CI: the
  // scroller sat at 8785 with the bar and 8793 without.
  //
  // So the invariant is not "it takes no flow height" — that was the weaker
  // claim the earlier version of this test made, and the earlier version of the
  // bar satisfied it while still being an 8px lie. It is that the bar is not
  // part of the scrolled content at all.
  const out = await page.evaluate(() => {
    const sc = document.querySelector('[data-testid="thread-scroll"]') as HTMLElement;
    const el = document.querySelector('[data-testid="turn-context"]') as HTMLElement;
    const holder = el.parentElement as HTMLElement;
    const withBar = sc.scrollHeight;
    holder.style.display = "none";
    const without = sc.scrollHeight;
    holder.style.display = "";
    return { inside: sc.contains(el), withBar, without };
  });
  expect(out.inside).toBe(false);
  expect(out.withBar).toBe(out.without);

  // …and the bar itself is still a real, visible target despite that.
  const box = await bar(page).boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(16);
});

/**
 * The turn that is still being written is the one most in need of a label.
 *
 * Every other test here drives a PERSISTED thread, and the bar found its
 * questions through a `data-question` attribute set only on persisted messages.
 * The in-flight question is rendered from `pending` on a different branch, and
 * it carried no such attribute — so during the longest an answer is ever left
 * unread, the bar either showed nothing (a first turn) or named the PREVIOUS
 * question, labelling the answer you are reading with someone else's. Caught in
 * review on this PR; this asserts the streaming case the other tests could not
 * reach, which needs a real model turn held open on purpose.
 */
const LIVE_QUESTION = "why does the streaming bucket deny every list call";
const LIVE_ANSWER =
  "## Finding\n\n" +
  Array.from(
    { length: 40 },
    (_, i) =>
      `Paragraph ${i} of the live answer. The bucket policy omits s3:ListBucket ` +
      `for the caller principal, so every list returns 403 AccessDenied while ` +
      `head_object on a known key still succeeds.`,
  ).join("\n\n");

test("names the question of the turn that is still streaming", async ({ page }) => {
  test.setTimeout(120_000);
  // Held open on purpose. `textTurn` emits one delta per 24 characters, so this
  // answer streams for roughly 40 × ~180 / 24 × 40ms ≈ 12s — the same knob
  // interrupt.spec.ts uses to have a window to press Stop in. Without it the
  // turn finishes before the assertion runs, the pending question becomes a
  // persisted one, and the test silently measures the case it is not about
  // (that is exactly what the first draft of this test did: it passed against
  // the unfixed component).
  const model = await startFakeModel([textTurn(LIVE_ANSWER)], { deltaDelayMs: 40 });
  const providerId = await useFakeModel(model.baseUrl);
  try {
    await page.addInitScript(() => {
      localStorage.setItem("saw.lang", "en");
      localStorage.setItem("saw.onboarded", "1");
    });
    await page.goto("/");
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
    await composer(page).click();
    await composer(page).fill(LIVE_QUESTION);
    await composer(page).press("Enter");

    // The thread follows the stream, so the question leaves the top of its own
    // accord — no manual scroll, which is how a reader meets this.
    const stop = page.getByRole("button", { name: /stop/i });
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await expect(bar(page)).toBeVisible({ timeout: 8_000 });
    await expect(bar(page)).toContainText(LIVE_QUESTION.slice(0, 24));
    // …and it was the LIVE turn being described, not a finished one: the answer
    // was still arriving when the bar named its question.
    await expect(stop).toBeVisible();
  } finally {
    await dropModelProvider(providerId);
    await model.close();
  }
});
