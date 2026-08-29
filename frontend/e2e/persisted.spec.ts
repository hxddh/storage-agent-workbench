import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, useFakeModel } from "./fake-model";

/**
 * What streamed is what stays.
 *
 * Reported from the shipped app: the answer streams in, and when the turn
 * settles the content disappears. The live bubble and the persisted message come
 * from two different sources — the accumulated deltas, and `result.final_output`
 * — and the client's bubble survives only until the thread reloads the turn from
 * the server. Any disagreement between those two is invisible until the moment
 * it replaces what the user was reading.
 *
 * `agent.spec.ts` asserts an answer is visible after streaming, and that a
 * normal exchange survives a reload. Neither can see this class of bug, because
 * its scripted model produces a well-formed `final_output` every time. These
 * drive the shapes a REAL model produces — reasoning tags — and assert on the
 * text after the turn has settled, which is the moment the user described.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const thread = (page: Page) => page.locator("main");

async function ask(page: Page, turns: string[][], question: string) {
  const model = await startFakeModel(turns);
  const modelId = await useFakeModel(model.baseUrl);
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
  await composer(page).click();
  await composer(page).fill(question);
  await composer(page).press("Enter");
  return {
    cleanup: async () => {
      await dropModelProvider(modelId);
      await model.close();
    },
  };
}

/** The thread's text once the turn has SETTLED — the persisted message, not the
 *  live bubble.
 *
 *  Keyed on "Ask again", a per-message action that only a PERSISTED assistant
 *  message carries. Not the turn-footer toggle: that appears only when the turn
 *  ran tools, and these turns deliberately run none. */
async function settledText(page: Page): Promise<string> {
  await expect(page.getByRole("button", { name: /Ask again/i }).last()).toBeVisible({
    timeout: 60_000,
  });
  return await thread(page).evaluate((el) => el.textContent ?? "");
}

test.describe("the answer that streamed is the answer that stays", () => {
  test("a reasoning model's answer survives the turn settling", async ({ page }) => {
    const { cleanup } = await ask(
      page,
      [textTurn("<think>Check the policy first.</think>\n\nThe policy omits s3:ListBucket.")],
      "why does acme-logs return 403?",
    );
    try {
      const settled = await settledText(page);
      expect(settled).toContain("The policy omits s3:ListBucket");
      // …and the reasoning is not what replaced it.
      expect(settled).not.toContain("Check the policy first");
      expect(settled).not.toContain("<think>");
    } finally {
      await cleanup();
    }
  });

  test("a stream that ends mid-thought does not surface the reasoning afterwards", async ({
    page,
  }) => {
    // The live stripper holds back an UNCLOSED `<think>`, so the user reads a
    // clean answer while it streams. The persist-time stripper handled only
    // PAIRED blocks, so the stored answer kept the raw tag — and the model's
    // reasoning appeared on screen the moment the thread reloaded the turn.
    const { cleanup } = await ask(
      page,
      [textTurn("The policy omits s3:ListBucket.\n<think>now let me double-check the ACL")],
      "why does acme-logs return 403?",
    );
    try {
      const settled = await settledText(page);
      expect(settled).toContain("The policy omits s3:ListBucket");
      expect(settled).not.toContain("<think>");
      expect(settled).not.toContain("double-check the ACL");
    } finally {
      await cleanup();
    }
  });

  test("a turn with no usable text says so instead of rendering an empty bubble", async ({
    page,
  }) => {
    // A reasoning model that wraps its entire reply in `<think>` leaves nothing
    // after stripping. An empty message is indistinguishable from a broken app.
    const { cleanup } = await ask(
      page,
      [textTurn("<think>The policy omits s3:ListBucket, so list returns 403.</think>")],
      "why does acme-logs return 403?",
    );
    try {
      await settledText(page);
      // POLL: the live bubble is replaced by the persisted message when the
      // thread reloads the turn, and that is the moment this test is about.
      await expect
        .poll(async () => await thread(page).evaluate((el) => el.textContent ?? ""), {
          timeout: 20_000,
          message: "a turn with no usable text must still say something",
        })
        .toMatch(/no readable answer/i);
      const settled = await thread(page).evaluate((el) => el.textContent ?? "");
      expect(settled).not.toContain("<think>");
      // The reasoning itself must not be what gets shown.
      expect(settled).not.toContain("so list returns 403");
    } finally {
      await cleanup();
    }
  });

  test("the answer is still there after a reload", async ({ page }) => {
    const { cleanup } = await ask(
      page,
      [textTurn("<think>Check the policy.</think>\n\nThe policy omits s3:ListBucket.")],
      "why does acme-logs return 403?",
    );
    try {
      await settledText(page);
      await page.reload();
      await expect(composer(page)).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(async () => await thread(page).evaluate((el) => el.textContent ?? ""), {
          timeout: 20_000,
          message: "the answer must survive a reload, not just the turn",
        })
        .toContain("The policy omits s3:ListBucket");
    } finally {
      await cleanup();
    }
  });
});
