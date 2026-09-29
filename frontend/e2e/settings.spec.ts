import { expect, test } from "@playwright/test";
import { api, boot, reset } from "./app";
import { startFakeS3 } from "./fake-s3";

test.beforeEach(reset);

test("a model and a storage account are added in Settings; keys never come back", async ({ page }) => {
  const s3 = await startFakeS3({ "acme-logs": ["a.log"] });
  try {
    await boot(page);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-models").click();
    const editor = page.getByTestId("model-editor");
    await editor.getByLabel("Provider").selectOption({ label: "Ollama" });
    await editor.getByLabel("Model", { exact: true }).fill("llama3.1");
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".provider-item")).toContainText("llama3.1");
    await expect(page.getByTestId("model-chip")).toContainText("llama3.1");

    await page.getByTestId("settings-storage").click();
    const cloud = page.getByTestId("cloud-editor");
    await cloud.getByLabel("Service").selectOption({ label: "MinIO" });
    await cloud.getByLabel("Name").fill("lab");
    await cloud.getByLabel("Endpoint").fill(s3.endpointUrl);
    await cloud.getByLabel("Access key").fill("AKIAIOSFODNN7EXAMPLE");
    await cloud.getByLabel("Secret key").fill("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    await cloud.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".provider-item", { hasText: "lab" })).toBeVisible();
    await page.locator(".provider-item", { hasText: "lab" }).click();
    await expect(page.getByTestId("watch")).toContainText("Off");
    await expect(page.getByTestId("settings")).not.toContainText("wJalrXUtnFEMI");

    const clouds = await api<unknown[]>("/providers/clouds");
    expect(JSON.stringify(clouds)).not.toContain("wJalrXUtnFEMI");
    await page.getByTestId("watch").getByRole("button", { name: "Daily" }).click();
    await expect.poll(async () => (await api<Array<{ watch: { enabled: boolean } }>>("/providers/clouds"))[0].watch.enabled).toBe(true);

    await page.getByTestId("settings-general").click();
    await expect(page.getByTestId("settings")).toContainText("Storage is read-only");
  } finally {
    await s3.close();
  }
});

test("the window reads Chinese end to end", async ({ page }) => {
  await boot(page, { lang: "zh" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("今天要照看些什么？");
  await expect(page.getByTestId("new-task")).toContainText("新任务");
  await api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en" }) });
});
