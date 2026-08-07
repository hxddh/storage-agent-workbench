import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, useFakeModel } from "./fake-model";

/**
 * Redirecting a turn that is already running.
 *
 * Pressing Enter while an answer streams does not queue a second question and
 * does not no-op: it CANCELS the running turn and sends the new one, keeping
 * what the first turn had already produced. That is a deliberate design — you
 * realise mid-answer that you asked the wrong thing — and it has real machinery
 * under it: a cancel, a wait for the turn to settle, a latest-wins payload, and
 * a composer that must not be left holding text it already sent.
 *
 * It had no browser coverage. It shares `stop()` with the Stop button, which
 * turned out never to have worked at all (v0.64.0) — steering was unaffected
 * because it passes a session id explicitly, but that is exactly the kind of
 * near-miss worth pinning down.
 */

const composer = (page: Page) => page.getByPlaceholder(/Ask Storage Agent/i);
const thread = (page: Page) => page.locator("main");

const FIRST = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i} about the bucket POLICY on acme-logs.`,
).join(" ");
const SECOND = "Short answer: the LIFECYCLE rule is what expires those objects.";

async function open(page: Page) {
  // The first answer streams slowly, so there is a window to redirect inside;
  // the second lands immediately.
  const model = await startFakeModel([textTurn(FIRST), textTurn(SECOND)], { deltaDelayMs: 150 });
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

test.describe("redirecting a running turn", () => {
  test("Enter mid-answer sends the new question instead of queueing it", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      await expect(thread(page).getByText(/Paragraph 0 about the bucket POLICY/)).toBeVisible({
        timeout: 30_000,
      });

      await ask(page, "actually, what expires those objects?");
      await expect(thread(page).getByText(/LIFECYCLE rule is what expires/)).toBeVisible({
        timeout: 60_000,
      });
    } finally {
      await cleanup();
    }
  });

  test("the redirected question is not left sitting in the composer", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      await expect(thread(page).getByText(/Paragraph 0 about the bucket POLICY/)).toBeVisible({
        timeout: 30_000,
      });

      await ask(page, "actually, what expires those objects?");
      await expect(thread(page).getByText(/LIFECYCLE rule is what expires/)).toBeVisible({
        timeout: 60_000,
      });
      await expect(composer(page)).toHaveValue("");
    } finally {
      await cleanup();
    }
  });

  test("what the redirected turn had already produced is kept", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      await expect(thread(page).getByText(/Paragraph 0 about the bucket POLICY/)).toBeVisible({
        timeout: 30_000,
      });
      await ask(page, "actually, what expires those objects?");
      await expect(thread(page).getByText(/LIFECYCLE rule is what expires/)).toBeVisible({
        timeout: 60_000,
      });

      // Both questions and the interrupted answer stay in the record. A redirect
      // is a change of direction, not an erasure of what was already said.
      const txt = await thread(page).evaluate((el) => el.textContent ?? "");
      expect(txt).toContain("why does acme-logs return 403?");
      expect(txt).toContain("actually, what expires those objects?");
      expect(txt).toContain("Paragraph 0 about the bucket POLICY");
    } finally {
      await cleanup();
    }
  });

  test("the whole exchange survives a reload", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      await expect(thread(page).getByText(/Paragraph 0 about the bucket POLICY/)).toBeVisible({
        timeout: 30_000,
      });
      await ask(page, "actually, what expires those objects?");
      await expect(thread(page).getByText(/LIFECYCLE rule is what expires/)).toBeVisible({
        timeout: 60_000,
      });

      await page.reload();
      await expect(composer(page)).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(async () => await thread(page).evaluate((el) => el.textContent ?? ""), {
          timeout: 20_000,
          message: "both questions must still be in the investigation",
        })
        .toContain("actually, what expires those objects?");
      expect(await thread(page).evaluate((el) => el.textContent ?? "")).toContain(
        "why does acme-logs return 403?",
      );
    } finally {
      await cleanup();
    }
  });

  test("the redirected turn is not left running server-side", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      await expect(thread(page).getByText(/Paragraph 0 about the bucket POLICY/)).toBeVisible({
        timeout: 30_000,
      });
      await ask(page, "actually, what expires those objects?");
      await expect(thread(page).getByText(/LIFECYCLE rule is what expires/)).toBeVisible({
        timeout: 60_000,
      });

      // Asked of the sidecar, not the UI: a turn left registered would make the
      // next question wait behind one nobody is running.
      const base = `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || 8799}`;
      const sessions = (await (await fetch(`${base}/sessions`)).json()) as Array<{ id: string }>;
      const states = await Promise.all(
        sessions.map(async (s) => (await (await fetch(`${base}/sessions/${s.id}/turn`)).json()) as { running: boolean }),
      );
      expect(states.every((s) => s.running === false)).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
