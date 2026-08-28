import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, useFakeModel } from "./fake-model";
import { seedSession } from "./seed";

/**
 * The thread ends where the conversation ends.
 *
 * v0.88.0 replaced a sticky bar naming the question with "anchoring": a spacer
 * under the last turn, sized so that scrolling to the end put the question at
 * the top of the screen. A thread cannot scroll past its own last pixel, so for
 * a turn shorter than the viewport that spacer was most of a viewport of
 * nothing — and "scroll down and you get a blank screen" was reported again,
 * against the release that was supposed to have fixed it.
 *
 * The test that was supposed to prevent this said, in its own comment, "a
 * spacer taller than the viewport would be scrollable emptiness — the thing
 * this product was just reported for", and then asserted `spacer < clientH`.
 * A spacer of clientH − 1 passed. On a 900px window that is 899px of blank
 * screen, green.
 *
 * The spacer is gone. What these assert now is the plain property it violated:
 * below the last thing the agent said there is nothing left to scroll into.
 */
const composer = (p: Page) => p.getByPlaceholder(/Ask Storage Agent/i);
const scroller = (p: Page) => p.getByTestId("thread-scroll");

test.use({ viewport: { width: 1440, height: 900 } });

/** How much scrollable nothing is left under the last painted content. */
const emptiness = (page: Page) =>
  page.evaluate(() => {
    const sc = document.querySelector('[data-testid="thread-scroll"]') as HTMLElement;
    const area = sc.getBoundingClientRect();
    let lowest = area.top;
    for (const n of Array.from(sc.querySelectorAll<HTMLElement>("*"))) {
      const paints = (n.textContent ?? "").trim().length > 0 || n.tagName === "svg";
      if (!paints) continue;
      const r = n.getBoundingClientRect();
      if (r.height >= 1 && r.width >= 1 && r.bottom > lowest) lowest = r.bottom;
    }
    return {
      clientH: sc.clientHeight,
      // Anything below the last painted pixel that can still be scrolled to.
      below: Math.round(sc.scrollHeight - (lowest - area.top + sc.scrollTop)),
      fromBottom: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight),
    };
  });

async function ask(page: Page, answer: string, question: string) {
  const model = await startFakeModel([textTurn(answer)], { deltaDelayMs: 4 });
  const providerId = await useFakeModel(model.baseUrl);
  const { title } = seedSession(6, `anchor ${Date.now()}`, "tall");
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await page.getByText(title, { exact: true }).first().click();
  await expect(page.locator(".thread-item").first()).toBeVisible({ timeout: 30_000 });
  await composer(page).click();
  await composer(page).fill(question);
  await composer(page).press("Enter");
  return { cleanup: async () => { await dropModelProvider(providerId); await model.close(); } };
}

const SHORT = "The bucket policy omits s3:ListBucket for that principal.";
const LONG =
  "## Finding\n\n" +
  Array.from(
    { length: 30 },
    (_, i) => `Paragraph ${i}. The bucket policy omits s3:ListBucket for the caller principal, ` +
              `so every list returns 403 AccessDenied while head_object still succeeds.`,
  ).join("\n\n");

test("a short answer leaves nothing to scroll into", async ({ page }) => {
  test.setTimeout(120_000);
  const { cleanup } = await ask(page, SHORT, "does the ACL matter here");
  try {
    await expect(page.getByText(/omits s3:ListBucket for that principal/).first()).toBeVisible({
      timeout: 60_000,
    });
    await page.waitForTimeout(2000);
    const g = await emptiness(page);
    // The padding at the foot of the scroller is real and deliberate; a
    // viewport of it is not. Measured against what this replaces: the spacer
    // alone was within a pixel of the full 900px window.
    expect(
      g.below,
      `${g.below}px of scrollable nothing under the last turn, in a ${g.clientH}px window`,
    ).toBeLessThanOrEqual(96);
  } finally {
    await cleanup();
  }
});

test("the answer is on screen when it finishes, not scrolled past", async ({ page }) => {
  test.setTimeout(120_000);
  const { cleanup } = await ask(page, SHORT, "does the ACL matter here");
  try {
    const answer = page.getByText(/omits s3:ListBucket for that principal/).first();
    await expect(answer).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2000);
    // Removing the spacer must not reintroduce the opposite fault: the reader
    // ends the turn looking at the answer, inside the reading area.
    const seen = await page.evaluate(() => {
      const sc = document.querySelector('[data-testid="thread-scroll"]') as HTMLElement;
      const el = Array.from(sc.querySelectorAll<HTMLElement>("p, li")).find((n) =>
        (n.textContent ?? "").includes("omits s3:ListBucket for that principal"),
      )!;
      const a = sc.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top - a.top), bottom: Math.round(r.bottom - a.top), h: Math.round(a.height) };
    });
    expect(seen.top).toBeGreaterThanOrEqual(0);
    expect(seen.bottom).toBeLessThanOrEqual(seen.h);
  } finally {
    await cleanup();
  }
});

test("a long answer still lands at its end", async ({ page }) => {
  test.setTimeout(120_000);
  const { cleanup } = await ask(page, LONG, "walk me through the whole policy");
  try {
    await expect(page.getByText(/Paragraph 29/).first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2500);
    const g = await emptiness(page);
    expect(g.fromBottom).toBeLessThanOrEqual(4);
    expect(g.below).toBeLessThanOrEqual(96);
  } finally {
    await cleanup();
  }
});

test("the sticky context bar is gone", async ({ page }) => {
  test.setTimeout(120_000);
  const { title } = seedSession(8, `nobar ${Date.now()}`, "tall");
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await page.getByText(title, { exact: true }).first().click();
  await expect(page.locator(".thread-item").first()).toBeVisible({ timeout: 30_000 });
  await scroller(page).evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });
  await page.waitForTimeout(600);
  await expect(page.getByTestId("turn-context")).toHaveCount(0);
});
