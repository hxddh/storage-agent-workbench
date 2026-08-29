import { expect, test, type Page } from "@playwright/test";

/** Browser coverage for file evidence entering an Agent task: picker, type
 * inference/correction, size/type UX, and the upload seam into durable task state. */
const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const attachButton = (page: Page) => page.getByRole("button", { name: /attach a dataset/i });
const delegateButton = (page: Page) => page.getByTestId("agent-composer").getByRole("button", { name: "Delegate task", exact: true });

async function fresh(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
}

async function pick(page: Page, name: string, body: string) {
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(body) });
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

test.describe("attaching evidence to an Agent task", () => {
  test("the attachment control is offered on a fresh task", async ({ page }) => {
    await fresh(page);
    await expect(attachButton(page)).toBeVisible();
    await expect(attachButton(page)).toBeEnabled();
  });

  test("a .csv is recognized as inventory without asking", async ({ page }) => {
    await fresh(page);
    await pick(page, "inventory-2026-06.csv", INVENTORY_CSV);
    await expect(page.getByText("inventory-2026-06.csv")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/inventory/i).first()).toBeVisible();
    await expect(page.getByText(/Analyze as:/i)).toHaveCount(0);
  });

  test("a .log is recognized as access logs", async ({ page }) => {
    await fresh(page);
    await pick(page, "s3-access-2026-06-25.log", ACCESS_LOG);
    await expect(page.getByText("s3-access-2026-06-25.log")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/access log/i).first()).toBeVisible();
  });

  test("an ambiguous extension asks which evidence type it is", async ({ page }) => {
    await fresh(page);
    await pick(page, "dump.gz", ACCESS_LOG);
    await expect(page.getByText("dump.gz")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Analyze as:/i)).toBeVisible();
    await expect(page.getByTestId("attach-type-inventory")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("attach-type-access_log")).toHaveAttribute("aria-pressed", "false");
  });

  test("picking the type resolves ambiguity", async ({ page }) => {
    await fresh(page);
    await pick(page, "dump.gz", ACCESS_LOG);
    await page.getByTestId("attach-type-access_log").click();
    await expect(page.getByText(/Analyze as:/i)).toHaveCount(0);
    await expect(page.getByTestId("attach-type-access_log")).toHaveAttribute("aria-pressed", "true");
  });

  test("an inferred type can still be corrected", async ({ page }) => {
    await fresh(page);
    await pick(page, "inventory-2026-06.csv", INVENTORY_CSV);
    await expect(page.getByTestId("attach-type-inventory")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("attach-type-access_log").click();
    await expect(page.getByTestId("attach-type-access_log")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("attach-type-inventory")).toHaveAttribute("aria-pressed", "false");
  });

  test("a filename whose syllable contains log is still inventory when its shape says so", async ({ page }) => {
    await fresh(page);
    await pick(page, "catalog.csv", INVENTORY_CSV);
    await expect(page.getByTestId("attach-type-inventory")).toHaveAttribute("aria-pressed", "true");
  });

  test("attached evidence alone is enough to delegate the task", async ({ page }) => {
    await fresh(page);
    await expect(delegateButton(page)).toBeDisabled();
    await pick(page, "inventory-2026-06.csv", INVENTORY_CSV);
    await expect(delegateButton(page)).toBeEnabled({ timeout: 10_000 });
  });

  test("the evidence file reaches durable task state", async ({ page }) => {
    await fresh(page);
    await pick(page, "inventory-2026-06.csv", INVENTORY_CSV);
    await composer(page).fill("what is in this inventory?");
    await composer(page).press("Enter");
    await expect
      .poll(async () => await attachedFileNames(), {
        timeout: 30_000,
        message: "the Agent task should own the uploaded evidence file",
      })
      .toContain("inventory-2026-06.csv");
  });
});

async function attachedFileNames(): Promise<string[]> {
  const base = `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || 8799}`;
  const list = (await (await fetch(`${base}/sessions`)).json()) as Array<{ id: string }>;
  const names: string[] = [];
  for (const session of list) {
    const detail = (await (await fetch(`${base}/sessions/${session.id}`)).json()) as {
      attached_files?: Array<{ source_filename?: string }>;
    };
    for (const file of detail.attached_files ?? []) if (file.source_filename) names.push(file.source_filename);
  }
  return names;
}
