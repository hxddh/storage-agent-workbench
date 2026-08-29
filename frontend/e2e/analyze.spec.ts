import { expect, test, type Page } from "@playwright/test";
import {
  dropModelProvider,
  startFakeModel,
  textTurn,
  toolResults,
  toolTurn,
  useFakeModel,
} from "./fake-model";

/**
 * Attach a file, ask about it, get an answer — the whole capability, in a
 * browser.
 *
 * The pieces were covered separately: the sidecar suite tests the upload
 * endpoint and the DuckDB engine directly, and `attach.spec.ts` covers the
 * picker. What nothing covered was the path a user actually takes, end to end:
 * pick a file, ask a question, watch the agent find the upload, run the local
 * analysis, and answer from real numbers.
 *
 * The scripted model is REACTIVE here. `analyze_uploaded_file` takes the id that
 * `list_uploaded_files` just returned, so a constant script cannot call it — the
 * double reads the id out of the tool result the way a model does. That is the
 * difference between testing "a tool was called" and testing that the agent can
 * chain one tool into the next at all.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const thread = (page: Page) => page.locator("main");

const INVENTORY_CSV =
  "bucket,key,size,storage_class,last_modified\n" +
  Array.from({ length: 120 }, (_, i) =>
    `acme-logs,logs/2026/06/part-${i}.parquet,${1024 * (i + 1)},${
      i % 5 === 0 ? "GLACIER" : "STANDARD"
    },2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
  ).join("\n") + "\n";

const ANSWER =
  "The inventory holds 120 objects totalling about 7.4 MB, and one in five is " +
  "already in GLACIER. The small-object ratio is what stands out.";

/** dataset_id looks like a uuid; pull the first one out of the tool result. */
const DATASET_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

async function setup(page: Page) {
  const model = await startFakeModel([
    // 1. find the upload
    toolTurn("list_uploaded_files", {}),
    // 2. analyze it, using the id the previous step returned
    (req) => {
      const id = DATASET_ID.exec(toolResults(req))?.[0];
      if (!id) return textTurn("I could not find the uploaded file.");
      return toolTurn("analyze_uploaded_file", { dataset_id: id });
    },
    // 3. answer
    textTurn(ANSWER),
  ]);
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

async function attachAndAsk(page: Page, question: string) {
  await page.locator('input[type="file"]').setInputFiles({
    name: "inventory-2026-06.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(INVENTORY_CSV),
  });
  await expect(page.getByText("inventory-2026-06.csv")).toBeVisible({ timeout: 10_000 });
  await composer(page).click();
  await composer(page).fill(question);
  await composer(page).press("Enter");
}

test.describe("analyzing an attached file", () => {
  test("the agent finds the upload, analyzes it, and answers", async ({ page }) => {
    const { cleanup } = await setup(page);
    try {
      await attachAndAsk(page, "what is in this inventory?");
      await expect(thread(page).getByText(/one in five is already in GLACIER/)).toBeVisible({
        timeout: 90_000,
      });
    } finally {
      await cleanup();
    }
  });

  test("the trace shows both steps, in the order they ran", async ({ page }) => {
    const { cleanup } = await setup(page);
    try {
      await attachAndAsk(page, "what is in this inventory?");
      await expect(page.getByTestId("turn-footer-toggle")).toBeVisible({ timeout: 90_000 });

      const trace = await thread(page).evaluate((el) => el.textContent ?? "");
      expect(trace).toContain("list_uploaded_files");
      expect(trace).toContain("analyze_uploaded_file");
      expect(trace.indexOf("list_uploaded_files")).toBeLessThan(
        trace.indexOf("analyze_uploaded_file"),
      );
    } finally {
      await cleanup();
    }
  });

  test("the analysis ran on the real file, not on a guess", async ({ page }) => {
    const { model, cleanup } = await setup(page);
    try {
      await attachAndAsk(page, "what is in this inventory?");
      await expect(page.getByTestId("turn-footer-toggle")).toBeVisible({ timeout: 90_000 });

      // The DuckDB result the agent was handed. It has to carry this file's real
      // numbers — 120 rows — or the whole path is decorative.
      const results = JSON.stringify(model.requests);
      expect(results).toContain("120");
      // And it must be an INVENTORY analysis, not the access-log engine.
      expect(results).toMatch(/storage_class|object_count|total_bytes|GLACIER/);
    } finally {
      await cleanup();
    }
  });

  test("no raw object key reaches the model as a row dump", async ({ page }) => {
    const { model, cleanup } = await setup(page);
    try {
      await attachAndAsk(page, "what is in this inventory?");
      await expect(page.getByTestId("turn-footer-toggle")).toBeVisible({ timeout: 90_000 });

      // Rule 16: the model sees sanitized AGGREGATES with at most a sample of
      // keys — never the 120 rows. The file has 120 distinct keys; a row dump
      // would put nearly all of them on the wire.
      const sent = JSON.stringify(model.requests);
      const keys = new Set(sent.match(/logs\/2026\/06\/part-\d+\.parquet/g) ?? []);
      expect(keys.size).toBeLessThanOrEqual(20);
    } finally {
      await cleanup();
    }
  });

  test("the attachment is listed as part of the investigation afterwards", async ({ page }) => {
    const { cleanup } = await setup(page);
    try {
      await attachAndAsk(page, "what is in this inventory?");
      await expect(thread(page).getByText(/one in five is already in GLACIER/)).toBeVisible({
        timeout: 90_000,
      });
      await page.reload();
      await expect(composer(page)).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(async () => await thread(page).evaluate((el) => el.textContent ?? ""), {
          timeout: 20_000,
        })
        .toContain("one in five is already in GLACIER");
    } finally {
      await cleanup();
    }
  });
});
