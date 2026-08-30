import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "./seed";

/**
 * Opening a conversation puts you on the newest message.
 *
 * Reported from the shipped app: *"界面一直玩下拉。就会无限白屏"* — scrolling down
 * never arrives, and the region scrolled into is blank. The thread scrolled to
 * the bottom with a one-shot `scrollIntoView({ behavior: "smooth" })`, which
 * animates toward a target measured when it starts. A thread of REAL answers is
 * still discovering its own height then, so the animation finished short of a
 * bottom that had since moved, and the scroll events it emitted tripped the
 * thread's own "not at the bottom" detector — unpinning the user it was
 * scrolling for, so nothing ever corrected it.
 *
 * `long-task.spec.ts` already opens a 30-turn session and passes, because its
 * answers are one line each: ~36-65px, small enough that the container barely
 * grows after first layout. That is the whole reason this class of bug was
 * invisible to the suite. These seed the "tall" shape — heading, paragraphs, a
 * 24-row table, a list, measured at 1616px — which is the size an agent answer
 * about a bucket actually is.
 *
 * Measured before the fix, on the tall shape: opening settled 1530px (2.7
 * viewports) above the newest message and stayed there, and clicking "jump to
 * latest" ended up 1717px away — further than where it started.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");

async function openSeeded(page: Page, title: string) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
  await page.getByText(title, { exact: true }).first().click();
  await expect(page.locator(".task-item").first()).toBeVisible({ timeout: 20_000 });
}

/** Distance in px from the newest message; 0 means the thread is at the end. */
async function distanceFromBottom(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const sc = document.querySelector("main .overflow-auto") as HTMLElement | null;
    if (!sc) return -1;
    return Math.round(sc.scrollHeight - sc.clientHeight - sc.scrollTop);
  });
}

// The thread's own definition of "at the bottom" (`onScroll`) is 80px. Allow a
// little over it so this asserts on the product's contract rather than on
// sub-pixel layout, while still failing hard at the measured 1530px.
const AT_BOTTOM_PX = 120;

/**
 * Record the scroller's position every frame, so a failure can say WHY.
 *
 * `'jump to latest' actually reaches the latest` has failed on CI a few times —
 * measured at 1 in 23 full-file runs on a loaded developer machine, 0 in 16 on
 * the same machine unloaded, and 0 in 20 when run alone. It has never been
 * reproduced deliberately: 6 forced attempts with no settle wait, 6 with a wheel
 * gesture, and 8 full-file runs under 6 CPU hogs all passed.
 *
 * So this does NOT fix it. Guessing at a fix for a race nobody has reproduced
 * is how the v0.78.0 torn row survived three releases and three wrong theories.
 * This captures the evidence instead, and the trace is built to separate the
 * candidates rather than merely prove something went wrong:
 *
 * - scrollTop returns to the bottom on its own → the thread scrolled back, and
 *   the convergence run in `scrollToBottom` is the mechanism (it re-jumps every
 *   frame until the height settles, and `onScroll` ignores scroll events while
 *   it runs — so a programmatic scroll made mid-run is both undone and never
 *   measured, which a real user's wheel gesture would have prevented by
 *   cancelling the run through `releaseToUser` first);
 * - scrollTop stays put and the button is still absent → the pin state did not
 *   update, and the fault is in `onScroll` or the render, not the scrolling;
 * - scrollHeight is still growing → the thread had not finished laying out, and
 *   the test moved too early.
 */
async function traceScroll(page: Page, forMs = 12_000): Promise<void> {
  await page.evaluate((ms) => {
    const sc = document.querySelector("main .overflow-auto") as HTMLElement | null;
    if (!sc) return;
    const trace: number[][] = [];
    (window as unknown as { __scrollTrace: number[][] }).__scrollTrace = trace;
    const t0 = performance.now();
    const tick = () => {
      const at = performance.now() - t0;
      trace.push([Math.round(at), Math.round(sc.scrollTop), Math.round(sc.scrollHeight)]);
      if (at < ms) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, forMs);
}

/** Assert the rescue affordance appeared; on failure, report the trace. */
async function expectJumpToLatestOffered(page: Page): Promise<void> {
  try {
    await expect(page.getByTestId("jump-to-latest")).toBeVisible({ timeout: 10_000 });
  } catch (original) {
    const trace = await page.evaluate(
      () => (window as unknown as { __scrollTrace?: number[][] }).__scrollTrace ?? []);
    const el = await page.evaluate(() => {
      const sc = document.querySelector("main .overflow-auto") as HTMLElement | null;
      return sc
        ? { scrollTop: Math.round(sc.scrollTop), scrollHeight: Math.round(sc.scrollHeight),
            clientHeight: Math.round(sc.clientHeight) }
        : null;
    });
    const inDom = await page.getByTestId("jump-to-latest").count();
    // Every frame is too much to read; the shape is in the first second and in
    // where it ended up.
    const head = trace.slice(0, 60).map(([t, top, h]) => `${t}:${top}/${h}`).join(" ");
    const tail = trace.slice(-10).map(([t, top, h]) => `${t}:${top}/${h}`).join(" ");
    const returned = trace.length > 1 && trace[trace.length - 1][1] > 200;
    throw new Error(
      `'jump to latest' never appeared after scrolling away.\n` +
      `  button nodes in DOM: ${inDom} (0 = never rendered, 1 = rendered but not visible)\n` +
      `  scroller at failure: ${JSON.stringify(el)}\n` +
      `  scrolled itself back to the bottom: ${returned} ` +
      `(true → the convergence run undid the scroll; false → the pin state never updated)\n` +
      `  trace ms:scrollTop/scrollHeight, first 60 frames: ${head}\n` +
      `  last 10 frames: ${tail}\n` +
      `  original: ${(original as Error).message}`,
    );
  }
}

test.describe("a long thread of realistically-sized answers", () => {
  test("opens on the newest message, not partway up", async ({ page }) => {
    const { title } = seedSession(40, `landing tall ${Date.now()}`, "tall");
    await openSeeded(page, title);

    await expect
      .poll(() => distanceFromBottom(page), {
        timeout: 15_000,
        message: "opening the session must land on the newest message",
      })
      .toBeLessThanOrEqual(AT_BOTTOM_PX);

    // …and it must STAY there: the failure mode was landing short and never
    // correcting, which a single early sample cannot tell from a slow landing.
    await page.waitForTimeout(2000);
    expect(await distanceFromBottom(page)).toBeLessThanOrEqual(AT_BOTTOM_PX);

    // Landing at the bottom means the thread knows it is pinned, so the rescue
    // affordance must not be offered.
    await expect(page.getByTestId("jump-to-latest")).toBeHidden();
  });

  test("'jump to latest' actually reaches the latest", async ({ page }) => {
    // The diagnostic below is only worth having if it gets to RUN. The suite's
    // per-test deadline is 30s (playwright.config.ts) and this test can spend
    // most of that before the assertion starts — up to 20s waiting for the
    // composer, 20s for the first thread item, 15s polling for the bottom. On a
    // loaded CI box the 10s assertion can therefore reach the deadline, and
    // Playwright kills the test mid-`catch`: no trace, just a generic timeout,
    // in precisely the flaky run this whole change exists to explain. Buy the
    // headroom explicitly rather than leave the diagnostic to chance.
    test.setTimeout(90_000);
    const { title } = seedSession(40, `landing jump ${Date.now()}`, "tall");
    await openSeeded(page, title);
    await expect.poll(() => distanceFromBottom(page), { timeout: 15_000 }).toBeLessThanOrEqual(AT_BOTTOM_PX);

    // Scroll away, the way a user re-reading an earlier turn does. Traced from
    // just before the scroll, so an occurrence of the known flake reports the
    // scroller's own behaviour rather than only "the button was not there".
    await traceScroll(page);
    await page.evaluate(() => {
      const sc = document.querySelector("main .overflow-auto") as HTMLElement;
      sc.scrollTop = 0;
    });
    await expectJumpToLatestOffered(page);

    await page.getByTestId("jump-to-latest").click();
    await expect
      .poll(() => distanceFromBottom(page), {
        timeout: 15_000,
        message: "the rescue affordance must reach the bottom, not stop short of it",
      })
      .toBeLessThanOrEqual(AT_BOTTOM_PX);
    await expect(page.getByTestId("jump-to-latest")).toBeHidden();
  });

  test("scrolling up still hands control back to the reader", async ({ page }) => {
    // The fix keeps correcting the scroll position across frames. It must not
    // do that against someone deliberately scrolling away — following the
    // conversation cannot become a trap.
    const { title } = seedSession(40, `landing release ${Date.now()}`, "tall");
    await openSeeded(page, title);
    await expect.poll(() => distanceFromBottom(page), { timeout: 15_000 }).toBeLessThanOrEqual(AT_BOTTOM_PX);

    await page.mouse.move(600, 300);
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -400);
    await page.waitForTimeout(600);

    expect(await distanceFromBottom(page)).toBeGreaterThan(AT_BOTTOM_PX);
    await expect(page.getByTestId("jump-to-latest")).toBeVisible();
  });
});
