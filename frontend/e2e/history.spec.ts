import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "./seed";

/**
 * A multi-turn thread must keep its history readable.
 *
 * The rest of the E2E covers the shell, providers and the inspector, and the
 * smoke spec sends exactly ONE message. Nothing ever produced a long
 * conversation and then checked what remained on screen, which is why the suite
 * stayed green while the released app reportedly showed no history and lost the
 * per-message actions.
 *
 * Two sources of content are used, deliberately:
 *  - the composer + offline triage path, for what a real user does on a fresh
 *    install with no model provider;
 *  - a seeded session (`seed.ts`), for the assistant MESSAGES that the offline
 *    path can never produce and that carry the collapsing, the turn footer and
 *    the per-message actions.
 */

const composer = (page: Page) => page.getByPlaceholder(/Ask Storage Agent/i);
/** The conversation itself — never the session rail, which repeats titles. */
const thread = (page: Page) => page.locator("main");

async function seedFreshApp(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
}

async function paste(page: Page, text: string) {
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await box.press("Enter");
}

async function openSeeded(page: Page, exchanges: number) {
  seedSession(exchanges);
  await seedFreshApp(page);
  await page.goto("/");
  await page.getByText("seeded multi-turn investigation").first().click();
  await expect(thread(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 20_000 });
}

test.describe("a multi-turn thread", () => {
  test("keeps the FIRST exchange visible after a second one", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");

    await paste(page, "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>");
    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });

    await paste(page, "<Error><Code>NoSuchBucket</Code><Message>Not found</Message></Error>");
    await expect(thread(page).getByText(/NoSuchBucket/).first()).toBeVisible({ timeout: 20_000 });

    // The FIRST turn must still be reachable. Collapsed is fine; absent is the bug.
    await expect(thread(page).getByText(/AccessDenied/).first()).toBeVisible();
  });

  test("history survives a reload", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");

    await paste(page, "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>");
    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });

    await page.reload();
    await expect(composer(page)).toBeVisible({ timeout: 20_000 });

    await expect(thread(page).getByText(/AccessDenied/).first()).toBeVisible({ timeout: 15_000 });
  });

  test("cards appear in the order they happened", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    await paste(page, "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>");
    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });
    await paste(page, "<Error><Code>NoSuchBucket</Code><Message>Not found</Message></Error>");
    await expect(thread(page).getByText(/NoSuchBucket/).first()).toBeVisible({ timeout: 20_000 });

    // Read the rendered order out of the THREAD, not out of document.body: the
    // rail lists every session by title, so a body-wide indexOf matches the
    // sidebar and the assertion passes no matter what the thread does. And out
    // of textContent, not innerText — innerText is layout-dependent and Chrome
    // truncates it inside a tall scroll container, which reads as "the card is
    // missing" for a card that is right there in the DOM.
    const order = await thread(page).evaluate((el) => {
      const txt = el.textContent ?? "";
      return { first: txt.indexOf("AccessDenied"), second: txt.indexOf("NoSuchBucket") };
    });
    expect(order.first, "AccessDenied must be present in the thread").toBeGreaterThanOrEqual(0);
    expect(order.second, "NoSuchBucket must be present in the thread").toBeGreaterThanOrEqual(0);
    expect(order.first, "AccessDenied must render BEFORE NoSuchBucket").toBeLessThan(order.second);
  });
});

test.describe("a long conversation", () => {
  test("shows every exchange, oldest first", async ({ page }) => {
    await openSeeded(page, 12);

    // textContent, not innerText: innerText is layout-dependent and Chrome
    // truncates it inside a tall scroll container, so an assertion built on it
    // reports missing history that is in fact rendered.
    const txt = (await thread(page).evaluate((el) => el.textContent ?? "")).replace(/\s+/g, " ");
    for (let i = 0; i < 12; i++) {
      expect(txt, `exchange ${i} must be in the thread`).toContain(`QUESTION-${String(i).padStart(2, "0")}`);
    }
    // Chronological: the first question precedes the last one.
    expect(txt.indexOf("QUESTION-00")).toBeLessThan(txt.indexOf("QUESTION-11"));
  });

  test("older answers collapse but reopen in place", async ({ page }) => {
    await openSeeded(page, 12);

    const collapsed = page.getByTestId("collapsed-turn");
    const n = await collapsed.count();
    expect(n, "older answers are expected to collapse to one line").toBeGreaterThan(0);

    await collapsed.first().click();
    await expect(page.getByTestId("collapsed-turn")).toHaveCount(n - 1);
  });

  test("the newest answer keeps its turn footer", async ({ page }) => {
    await openSeeded(page, 12);
    await expect(page.getByTestId("turn-footer-toggle").last()).toBeVisible();
  });

  test("a user message keeps copy / edit / branch", async ({ page }) => {
    await openSeeded(page, 12);

    const last = thread(page).getByText("QUESTION-11").last();
    await last.scrollIntoViewIfNeeded();
    await last.hover();

    await expect(page.getByTestId("edit-message").last()).toBeVisible();
    await expect(page.getByTestId("branch-message").last()).toBeVisible();
    await expect(thread(page).getByRole("button", { name: /copy/i }).last()).toBeVisible();
  });
});
