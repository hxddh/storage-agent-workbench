import { expect, test } from "@playwright/test";
import { addStorage, boot, delegate, reset, settled } from "./app";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel, type FakeModel } from "./fake-model";
import { startFakeS3, type FakeS3 } from "./fake-s3";

let model: FakeModel;
let s3: FakeS3;
let providerId = "";

test.beforeEach(async () => {
  await reset();
  s3 = await startFakeS3({ "acme-www": ["index.html"], "acme-logs": ["2026/09/01/a.log"] },
    { config: { "acme-www": {}, "acme-logs": { encrypted: true } } });
});
test.afterEach(async () => {
  if (providerId) await dropModelProvider(providerId);
  await model?.close();
  await s3.close();
});

test("what a survey learns outlives the task: the home shows the estate and what needs care", async ({ page }) => {
  const storageId = await addStorage(s3.endpointUrl);
  model = await startFakeModel([toolTurn("survey_account", { provider_id: storageId }),
    textTurn("Surveyed both buckets.")]);
  providerId = await useFakeModel(model.baseUrl);
  await boot(page);
  await delegate(page, "Survey my storage account");
  await expect(page.getByTestId("result")).toContainText("Surveyed both buckets.", { timeout: 30_000 });
  await settled(page);
  await page.getByRole("button", { name: /Worked for/ }).click();
  await expect(page.locator(".tool-row").first()).toHaveAttribute("data-status", "ok");
  await expect(page.locator(".tool-row").first()).toContainText("Surveyed account");

  await page.getByTestId("nav-home").click();
  await expect(page.getByTestId("estate")).toContainText("acme-prod");
  await expect(page.getByTestId("estate")).toContainText("2 buckets");
  const care = page.getByTestId("needs-care");
  await expect(care.getByTestId("issue").first()).toBeVisible();
  const issue = care.getByTestId("issue").filter({ hasText: "acme-www" }).first();
  await issue.locator(".issue-head").click();
  // The fix is text for the user; storage stays read-only.
  const fix = issue.getByRole("button", { name: "Show the fix" });
  if (await fix.count()) {
    await fix.click();
    await expect(issue.locator(".issue-fix pre")).toContainText("aws");
    await expect(issue).toContainText("never writes to storage");
  }
  await issue.getByRole("button", { name: "Open task" }).click();
  await expect(page.getByTestId("result")).toContainText("Surveyed both buckets.");
  expect(s3.requests.filter((r) => /^(PUT|POST|DELETE) /.test(r))).toEqual([]);
});

test("the estate view: an account, a bucket page, a note, and a fix pack that says what it cannot tell", async ({ page }) => {
  const storageId = await addStorage(s3.endpointUrl);
  model = await startFakeModel([toolTurn("survey_account", { provider_id: storageId }), textTurn("Surveyed.")]);
  providerId = await useFakeModel(model.baseUrl);
  await boot(page);
  await delegate(page, "Survey my storage account");
  await expect(page.getByTestId("result")).toContainText("Surveyed.", { timeout: 30_000 });
  await settled(page);

  await page.getByTestId("nav-estate").click();
  await page.getByTestId("estate-account").first().click();
  await expect(page.getByTestId("bucket-row")).toHaveCount(2);
  await page.getByTestId("bucket-row").filter({ hasText: "acme-www" }).click();
  const bucket = page.getByTestId("bucket-page");
  await expect(bucket.locator(".page-title")).toHaveText("acme-www");
  await expect(page.getByTestId("timeline")).toContainText("First observed");

  // A note is kept on the bucket and survives a reload.
  await page.getByTestId("note-input").fill("Serves the marketing site.");
  await page.getByTestId("note-add").click();
  await expect(page.getByTestId("note")).toContainText("Serves the marketing site.");
  await page.reload();
  await expect(page.getByTestId("note")).toContainText("Serves the marketing site.");

  // The fix pack: CLI, Terraform, the document — and an honest impact preview.
  const issue = bucket.getByTestId("issue").filter({ has: page.getByRole("button", { name: /public access block/i }) }).first();
  const target = (await issue.count()) ? issue : bucket.getByTestId("issue").first();
  await target.locator(".issue-head").click();
  const show = target.getByRole("button", { name: "Show the fix" });
  if (await show.count()) {
    await show.click();
    await expect(target.getByTestId("fix-pack")).toBeVisible();
    await target.getByRole("button", { name: "Terraform" }).click();
    await expect(target.locator(".issue-fix pre")).toContainText("resource \"aws_s3_bucket");
    await expect(target.getByTestId("impact")).toHaveAttribute("data-verdict", /low|caution|unknown/);
  }

  // Ask about this bucket fills the Composer; it never submits.
  await page.getByTestId("ask-bucket").click();
  await expect(page.getByTestId("home")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toHaveValue(/acme-www/);
  expect(s3.requests.filter((r) => /^(PUT|POST|DELETE) /.test(r))).toEqual([]);
});
