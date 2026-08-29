import { expect, test, type Page } from "@playwright/test";

/**
 * Attaching a file to an investigation, through the browser.
 *
 * "Analyze the file you attached in the conversation" is one of the product's
 * headline capabilities, and the browser half of it had NO coverage: the sidecar
 * suite tests the upload endpoint and the DuckDB engine directly, and no E2E ever
 * picked a file. Everything between — the hidden file input, the size pre-check,
 * type inference from the extension, the chip that asks when the type is
 * ambiguous, and the send button's dependence on an attachment — was unverified.
 *
 * No model provider is configured here (as everywhere in this suite), so what is
 * asserted is the attach → upload seam, not the agent's analysis of the file.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const attachButton = (page: Page) => page.getByRole("button", { name: /attach a dataset/i });

async function fresh(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
}

/** Put a file into the hidden input the paperclip opens. */
async function pick(page: Page, name: string, body: string) {
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(body),
  });
}

const INVENTORY_CSV =
  "bucket,key,size,storage_class,last_modified\n" +
  Array.from({ length: 40 }, (_, i) =>
    `acme-logs,logs/2026/06/part-${i}.parquet,${1048576 * (i + 1)},STANDARD,2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
  ).join("\n") + "\n";

const ACCESS_LOG =
  Array.from({ length: 20 }, (_, i) =>
    `2026-06-25T10:00:${String(i).padStart(2, "0")}Z acme-logs GET /a/p${i}.parquet 200 1048576 42 ms user-agent="aws-sdk/1.0" remote_ip="192.0.2.10"`,
  ).join("\n") + "\n";

test.describe("attaching a file", () => {
  test("the paperclip is offered on a fresh install", async ({ page }) => {
    await fresh(page);
    await expect(attachButton(page)).toBeVisible();
    await expect(attachButton(page)).toBeEnabled();
  });

  test("a .csv is recognized as an inventory without being asked", async ({ page }) => {
    await fresh(page);
    await pick(page, "inventory-2026-06.csv", INVENTORY_CSV);

    await expect(page.getByText("inventory-2026-06.csv")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/inventory/i).first()).toBeVisible();
    // Inferred, so the "which kind of file is this?" prompt must not appear.
    await expect(page.getByText(/Analyze as:/i)).toHaveCount(0);
  });

  test("a .log is recognized as access logs", async ({ page }) => {
    await fresh(page);
    await pick(page, "s3-access-2026-06-25.log", ACCESS_LOG);
    await expect(page.getByText("s3-access-2026-06-25.log")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/access log/i).first()).toBeVisible();
  });

  test("an extension it cannot place asks which kind of file it is", async ({ page }) => {
    await fresh(page);
    // A bare .gz says nothing about the shape inside. The product must ask
    // rather than guess and run the wrong engine.
    await pick(page, "dump.gz", ACCESS_LOG);
    await expect(page.getByText("dump.gz")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Analyze as:/i)).toBeVisible();
    await expect(page.getByTestId("attach-type-inventory")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("attach-type-access_log")).toHaveAttribute("aria-pressed", "false");
  });

  test("picking the type answers the question", async ({ page }) => {
    await fresh(page);
    await pick(page, "dump.gz", ACCESS_LOG);
    await page.getByTestId("attach-type-access_log").click();
    await expect(page.getByText(/Analyze as:/i)).toHaveCount(0);
    await expect(page.getByTestId("attach-type-access_log")).toHaveAttribute("aria-pressed", "true");
  });

  test("an INFERRED type can still be corrected", async ({ page }) => {
    await fresh(page);
    // The type is inferred from the filename, so it can be wrong; it used to
    // render as a plain label with no way to say otherwise, and the file went
    // to the wrong engine.
    await pick(page, "inventory-2026-06.csv", INVENTORY_CSV);
    await expect(page.getByTestId("attach-type-inventory")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("attach-type-access_log").click();
    await expect(page.getByTestId("attach-type-access_log")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("attach-type-inventory")).toHaveAttribute("aria-pressed", "false");
  });

  test("a name whose syllable merely contains 'log' is still an inventory", async ({ page }) => {
    await fresh(page);
    // "catalog" ends in "log"; this used to be routed to the access-log engine.
    await pick(page, "catalog.csv", INVENTORY_CSV);
    await expect(page.getByTestId("attach-type-inventory")).toHaveAttribute("aria-pressed", "true");
  });

  test("an attachment alone is enough to send — no typed question required", async ({ page }) => {
    await fresh(page);
    const send = page.getByRole("button", { name: /^send$/i });
    await expect(send).toBeDisabled();
    await pick(page, "inventory-2026-06.csv", INVENTORY_CSV);
    await expect(send).toBeEnabled({ timeout: 10_000 });
  });

  test("the file actually reaches the server", async ({ page }) => {
    await fresh(page);
    await pick(page, "inventory-2026-06.csv", INVENTORY_CSV);
    await composer(page).fill("what is in this inventory?");
    await composer(page).press("Enter");

    // No model provider, so the turn itself cannot answer — but the upload is a
    // separate, earlier step, and the session must end up owning the file.
    // Asked of the sidecar directly (from node), not through the page: the app
    // origin is the vite preview server, so a relative fetch there would ask the
    // wrong process and pass for the wrong reason.
    await expect
      .poll(async () => await attachedFileNames(), {
        timeout: 30_000,
        message: "the session should own the uploaded file",
      })
      .toContain("inventory-2026-06.csv");
  });
});

/** Every attached filename the sidecar reports, across all sessions. */
async function attachedFileNames(): Promise<string[]> {
  const base = `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || 8799}`;
  const list = (await (await fetch(`${base}/sessions`)).json()) as Array<{ id: string }>;
  const names: string[] = [];
  for (const s of list) {
    const detail = (await (await fetch(`${base}/sessions/${s.id}`)).json()) as {
      attached_files?: Array<{ source_filename?: string }>;
    };
    for (const f of detail.attached_files ?? []) if (f.source_filename) names.push(f.source_filename);
  }
  return names;
}
