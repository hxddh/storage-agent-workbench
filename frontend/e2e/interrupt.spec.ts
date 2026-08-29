import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, useFakeModel } from "./fake-model";

/**
 * Stopping a turn, and steering one.
 *
 * Both are real controls with real machinery behind them — a cancel event that
 * reaches the running SDK stream, a PARTIAL answer persisted so the work is not
 * thrown away, and a turn handle that must be released or the next question
 * waits behind a turn nobody is running. None of it had browser coverage, for
 * the same reason as the rest: there was no model, so there was never a turn to
 * interrupt.
 *
 * The scripted model here streams slowly on purpose. A model that answers
 * instantly leaves no window to press Stop in, which is why this could not be
 * tested before rather than why it was skipped.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const thread = (page: Page) => page.locator("main");
const stopButton = (page: Page) => page.getByRole("button", { name: /^stop$/i });

// Long enough that, at 150 ms a chunk, the turn lasts several seconds.
const LONG = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i} of a long answer about the bucket policy on acme-logs.`,
).join(" ");

async function open(page: Page, deltaDelayMs = 150) {
  const model = await startFakeModel([textTurn(LONG)], { deltaDelayMs });
  const providerId = await useFakeModel(model.baseUrl);
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
  return {
    model,
    cleanup: async () => {
      await dropModelProvider(providerId);
      await model.close();
    },
  };
}

async function ask(page: Page, question: string) {
  await composer(page).click();
  await composer(page).fill(question);
  await composer(page).press("Enter");
}

test.describe("interrupting a turn", () => {
  test("Stop replaces Send while the answer is streaming", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      await expect(stopButton(page)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: /^send$/i })).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });

  test("pressing Stop ends the turn and says who ended it", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      // Wait for real text, so there is a partial answer worth keeping.
      await expect(thread(page).getByText(/Paragraph 0 of a long answer/)).toBeVisible({
        timeout: 30_000,
      });
      await stopButton(page).click();

      await expect(thread(page).getByText(/stopped by user/i).first()).toBeVisible({ timeout: 30_000 });
      // The composer comes back: a stopped turn must not leave the app locked.
      await expect(page.getByRole("button", { name: /^send$/i })).toBeVisible({ timeout: 30_000 });
    } finally {
      await cleanup();
    }
  });

  test("the partial answer is kept, not thrown away", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      await expect(thread(page).getByText(/Paragraph 0 of a long answer/)).toBeVisible({
        timeout: 30_000,
      });
      await stopButton(page).click();
      await expect(thread(page).getByText(/stopped by user/i).first()).toBeVisible({ timeout: 30_000 });

      // What the user already read must still be on screen — and still there
      // after a reload, which is the difference between "kept" and "not yet gone".
      await expect(thread(page).getByText(/Paragraph 0 of a long answer/)).toBeVisible();
      await page.reload();
      await expect(composer(page)).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(async () => await thread(page).evaluate((el) => el.textContent ?? ""), {
          timeout: 20_000,
        })
        .toContain("why does acme-logs return 403?");
    } finally {
      await cleanup();
    }
  });

  test("a stopped turn does not block the next question", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await ask(page, "first question");
      await expect(thread(page).getByText(/Paragraph 0 of a long answer/)).toBeVisible({
        timeout: 30_000,
      });
      await stopButton(page).click();
      await expect(thread(page).getByText(/stopped by user/i).first()).toBeVisible({ timeout: 30_000 });

      // Wait for Send to come back before asking again. That is not a
      // convenience: while a turn is busy, Enter REDIRECTS it rather than
      // sending, so typing too early would exercise steering and not a new turn.
      // The button changing back is the signal a user reads too.
      await expect(page.getByRole("button", { name: /^send$/i })).toBeVisible({ timeout: 30_000 });

      // The turn handle has to be released server-side, or this one waits behind
      // a turn nobody is running.
      await ask(page, "second question");
      await expect
        .poll(async () => await thread(page).evaluate((el) => el.textContent ?? ""), {
          timeout: 30_000,
          message: "the second question must reach the thread",
        })
        .toContain("second question");
      expect(await thread(page).evaluate((el) => el.textContent ?? "")).toContain("first question");
    } finally {
      await cleanup();
    }
  });
});
