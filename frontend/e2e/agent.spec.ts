import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";

/**
 * A real agent turn, in a browser.
 *
 * This is the app's main path and it had never been driven end-to-end from the
 * UI: every other spec runs with no model provider (deliberately — the offline
 * paths must work on a fresh install), so nothing ever watched a question become
 * a streamed answer and then a persisted turn.
 *
 * That last step is precisely where the v0.63.0 bug was felt. The stream
 * succeeded, the answer was watched arriving, and the reload that turns the live
 * bubble into a persisted message hit a 500 — so the answer stayed a bubble with
 * no turn footer and no actions, and the Task never grew. Every assertion here
 * is about what is on screen AFTER the turn ends.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const task = (page: Page) => page.locator("main");

const SKILL = "storageops-security-iam-policy";

// v1.11: the answer is plain Markdown. There is no metadata block any more;
// grounding is derived from the tool log server-side.
const ANSWER =
  "The bucket policy omits s3:ListBucket for that principal, which is why every " +
  "list call returns 403 while GetObject still works.";
const COMMENTARY = "I will read the IAM policy skill before answering.";

const SECOND = "The ACL is not involved: object ownership is set to BucketOwnerEnforced.";

async function ask(page: Page, question: string) {
  await composer(page).click();
  await composer(page).fill(question);
  await composer(page).press("Enter");
}

/** Start a scripted model, point the app at it, and clean up afterwards. */
function withModel(turns: string[][]) {
  return async function setup(page: Page) {
    const model = await startFakeModel(turns);
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
  };
}

const oneTurn = withModel([toolTurn("read_skill", { name: SKILL }), textTurn(ANSWER)]);
const twoTurns = withModel([
  toolTurn("read_skill", { name: SKILL }),
  textTurn(ANSWER),
  textTurn(SECOND),
]);
// Commentary before the action: text the model writes in the SAME completion
// as its tool call, which the runtime closes as its own segment.
const commentaryThenTool = withModel([
  [...textTurn(COMMENTARY).slice(0, -1), ...toolTurn("read_skill", { name: SKILL })],
  textTurn(ANSWER),
]);

test.describe("a real agent turn", () => {
  // Two scripted turns through the real Sidecar (model round-trips, durable
  // persistence, the title step, a reload) take longer than the 30 s default
  // on a loaded CI runner; every inner wait stays bounded on its own.
  test.describe.configure({ timeout: 120_000 });
  test("the answer arrives and stays on screen", async ({ page }) => {
    const { cleanup } = await oneTurn(page);
    try {
      await ask(page, "why does acme-logs return 403 on every list call?");
      await expect(task(page).getByText(/omits s3:ListBucket/)).toBeVisible({ timeout: 60_000 });
      // No bookkeeping block, no proposal-era Decision card, ever.
      await expect(task(page).getByText(/next_action_proposals/)).toHaveCount(0);
      await expect(task(page).getByText(/Decision required/)).toHaveCount(0);
      await expect(page.getByTestId("approval-card")).toHaveCount(0);
      await expect(page.getByTestId("turn-answer").last()).toContainText("omits s3:ListBucket");
    } finally {
      await cleanup();
    }
  });

  test("the finished turn keeps its worked group — what ran, and how long", async ({ page }) => {
    const { cleanup } = await oneTurn(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      await expect(task(page).getByText(/omits s3:ListBucket/)).toBeVisible({ timeout: 60_000 });
      // The worked group hangs off the PERSISTED message, so its presence is
      // the proof that the post-turn reload actually landed. It sits BEFORE
      // the answer and folds once the turn is done; a click opens the rows.
      const group = page.getByTestId("worked-group").last();
      await expect(group).toBeVisible({ timeout: 30_000 });
      await expect(group).toContainText(/Worked/);
      await group.getByTestId("execution-head").click();
      await expect(group.getByTestId("worked-row").first()).toContainText("read_skill");
      const order = await task(page).evaluate((el) =>
        [...el.querySelectorAll("[data-testid='worked-group'],[data-testid='turn-answer']")]
          .map((node) => node.getAttribute("data-testid")));
      expect(order.indexOf("worked-group")).toBeLessThan(order.indexOf("turn-answer"));
    } finally {
      await cleanup();
    }
  });

  test("commentary the model wrote before acting is its own segment before the worked group", async ({ page }) => {
    const { cleanup } = await commentaryThenTool(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      await expect(task(page).getByText(/omits s3:ListBucket/)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("turn-commentary").first()).toContainText(/read the IAM policy skill/);
      const order = await task(page).evaluate((el) =>
        [...el.querySelectorAll("[data-testid='turn-commentary'],[data-testid='worked-group'],[data-testid='turn-answer']")]
          .map((node) => node.getAttribute("data-testid")));
      expect(order).toEqual(["turn-commentary", "worked-group", "turn-answer"]);
      // The commentary is NOT repeated inside the answer.
      await expect(page.getByTestId("turn-answer").last()).not.toContainText(/read the IAM policy skill/);
    } finally {
      await cleanup();
    }
  });

  test("the user's question is a bubble with a copy action", async ({ page }) => {
    const { cleanup } = await oneTurn(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      await expect(page.getByTestId("worked-group")).toBeVisible({ timeout: 60_000 });

      const q = page.getByTestId("turn-user").last();
      await expect(q).toContainText("why does acme-logs return 403?");
      await q.hover();
      await expect(page.getByTestId("redirect-direction")).toHaveCount(0);
      await expect(page.getByTestId("branch-task")).toHaveCount(0);
      await expect(task(page).getByRole("button", { name: /copy/i }).last()).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test("nothing is painted after the answer: no chips, no footer, no proposals", async ({ page }) => {
    const { cleanup } = await oneTurn(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      await expect(page.getByTestId("turn-answer").last()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: /Continue task/i })).toHaveCount(0);
      await expect(page.getByTestId("work-result-open-report")).toHaveCount(0);
      await expect(page.getByTestId("work-result-artifacts")).toHaveCount(0);
      await expect(task(page).getByText(/tool calls?\s*\(/)).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });

  test("a SECOND turn appends — the first one is still there", async ({ page }) => {
    const { cleanup } = await twoTurns(page);
    try {
      await ask(page, "first question about acme-logs");
      await expect(task(page).getByText(/omits s3:ListBucket/)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("worked-group")).toBeVisible({ timeout: 30_000 });

      await ask(page, "second question about acme-logs");
      await expect(task(page).getByText(/BucketOwnerEnforced/)).toBeVisible({ timeout: 60_000 });

      // The reported symptom, asserted directly.
      const txt = await task(page).evaluate((el) => el.textContent ?? "");
      expect(txt).toContain("first question about acme-logs");
      expect(txt).toContain("omits s3:ListBucket");
      expect(txt).toContain("second question about acme-logs");
      expect(txt).toContain("BucketOwnerEnforced");
    } finally {
      await cleanup();
    }
  });

  test("both exchanges survive a reload", async ({ page }) => {
    // Two real turns plus a reload on a shared CI runner can exceed the
    // default 30 s test budget while every single wait inside is still
    // comfortably within its own timeout; give the whole test the room.
    const { cleanup } = await twoTurns(page);
    try {
      await ask(page, "first question about acme-logs");
      await expect(page.getByTestId("worked-group")).toBeVisible({ timeout: 60_000 });
      await ask(page, "second question about acme-logs");
      await expect(task(page).getByText(/BucketOwnerEnforced/)).toBeVisible({ timeout: 60_000 });

      await page.reload();
      await expect(composer(page)).toBeVisible({ timeout: 20_000 });
      // The open Task is restored at mount rather than after the
      // session list returns, and a session whose content is still loading now
      // renders the task document instead of the empty-start Composer.
      //
      // HONEST LIMIT: this assertion does not discriminate. It was written after
      // a 1-in-6 flake in which this very check found the start surface on
      // screen, but neither reverting the change nor delaying /sessions
      // reproduces that here — so it guards the behaviour, it does not prove the
      // flake's cause.
      await expect(task(page).getByText(/How can I help/i)).toHaveCount(0);

      await expect
        .poll(async () => await task(page).evaluate((el) => el.textContent ?? ""), {
          timeout: 20_000,
          message: "the app must reopen the Task it was on",
        })
        .toContain("first question about acme-logs");
      const txt = await task(page).evaluate((el) => el.textContent ?? "");
      expect(txt).toContain("second question about acme-logs");
      expect(txt).toContain("BucketOwnerEnforced");
    } finally {
      await cleanup();
    }
  });

  test("no credential value is sent to the model", async ({ page }) => {
    const { model, cleanup } = await oneTurn(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      await expect(task(page).getByText(/omits s3:ListBucket/)).toBeVisible({ timeout: 60_000 });
      // Rule 1, checked against the bytes that actually went over the socket.
      expect(JSON.stringify(model.requests)).not.toContain("not-a-real-key");
    } finally {
      await cleanup();
    }
  });
});
