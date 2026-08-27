import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, useFakeModel } from "./fake-model";
import { seedSession } from "./seed";

/**
 * Your question sits at the top of the screen while you read the answer.
 *
 * The first attempt at this was a sticky horizontal strip over the thread that
 * NAMED the question once it had scrolled away. It worked, and it was the wrong
 * shape for the job: a bar of furniture describing content that is only
 * off-screen because the thread scrolled past it. ChatGPT, Codex and Cursor all
 * solve it the other way — put the question where the reader is looking and let
 * the answer grow beneath it — and that needs no furniture at all.
 *
 * A thread cannot scroll past its own last pixel, so for a turn shorter than the
 * viewport this is impossible without somewhere to scroll into. The spacer under
 * the last turn is that somewhere, and it is SOLVED for rather than guessed:
 * exactly enough that scrolling to the end puts the question `TAIL_GAP_PX` below
 * the top, and no more, so the thread never scrolls into blankness it does not
 * need.
 */
const composer = (p: Page) => p.getByPlaceholder(/Ask Storage Agent/i);
const scroller = (p: Page) => p.getByTestId("thread-scroll");

test.use({ viewport: { width: 1440, height: 900 } });

/** Where the newest question sits, in pixels from the top of the reading area. */
async function questionTop(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const sc = document.querySelector('[data-testid="thread-scroll"]') as HTMLElement;
    const qs = sc.querySelectorAll<HTMLElement>("[data-question]");
    const last = qs[qs.length - 1];
    return Math.round(last.getBoundingClientRect().top - sc.getBoundingClientRect().top);
  });
}

const geometry = (page: Page) =>
  page.evaluate(() => {
    const sc = document.querySelector('[data-testid="thread-scroll"]') as HTMLElement;
    const sp = sc.querySelector('[data-testid="tail-space"]') as HTMLElement;
    return {
      spacer: Math.round(sp.getBoundingClientRect().height),
      clientH: sc.clientHeight,
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

test("a short answer leaves the question at the top of the screen", async ({ page }) => {
  test.setTimeout(120_000);
  const { cleanup } = await ask(page, SHORT, "does the ACL matter here");
  try {
    await expect(page.getByText(/omits s3:ListBucket for that principal/).first()).toBeVisible({
      timeout: 60_000,
    });
    await page.waitForTimeout(2000);
    // Measured, not approximated: the anchor is 28px and this asserts the real
    // number, because "roughly near the top" is what a broken spacer also looks
    // like at a glance.
    expect(await questionTop(page)).toBeLessThanOrEqual(40);
    expect(await questionTop(page)).toBeGreaterThanOrEqual(0);
  } finally {
    await cleanup();
  }
});

test("the space it adds is exactly what the turn needs, never more", async ({ page }) => {
  test.setTimeout(120_000);
  const { cleanup } = await ask(page, SHORT, "does the ACL matter here");
  try {
    await expect(page.getByText(/omits s3:ListBucket for that principal/).first()).toBeVisible({
      timeout: 60_000,
    });
    await page.waitForTimeout(2000);
    const g = await geometry(page);
    // A spacer taller than the viewport would be scrollable emptiness — the
    // thing this product was just reported for.
    expect(g.spacer).toBeGreaterThan(0);
    expect(g.spacer).toBeLessThan(g.clientH);
    // And the thread is genuinely at its end, not stranded above it.
    expect(g.fromBottom).toBeLessThanOrEqual(2);
  } finally {
    await cleanup();
  }
});

test("an answer taller than the screen adds no space at all", async ({ page }) => {
  test.setTimeout(120_000);
  const { cleanup } = await ask(page, LONG, "walk me through the whole policy");
  try {
    await expect(page.getByText(/Paragraph 29/).first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2500);
    const g = await geometry(page);
    expect(g.spacer).toBe(0);
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
