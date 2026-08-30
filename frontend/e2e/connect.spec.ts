import { expect, test, type Page } from "@playwright/test";
import { dropCloudProvider, listCloudProviders, startFakeS3, type FakeS3 } from "./fake-s3";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";

/**
 * Connecting to storage, and then asking about it — the app's other main path.
 *
 * `providers.spec.ts` creates a provider whose endpoint points nowhere. That is
 * the right shape for its assertions (the plaintext secret must not reach the
 * DOM or the API response) but it means the question a user asks FIRST on a
 * fresh install — *does this connection work?* — has never been answered by a
 * test. `CloudProviderTester`, the panel that answers it, had no coverage of any
 * kind.
 *
 * With `fake-s3.ts` behind it the whole chain runs for real: browser → sidecar →
 * boto3 → a socket that speaks S3 XML → back. Nothing in this repo had ever
 * driven that end to end. Both the happy path and the failure path matter here,
 * and the failure path more: an operator whose endpoint is wrong sees this panel
 * and nothing else, so what it says IS the diagnosis.
 */

const PROVIDER_NAME = "e2e-fake-s3";
const ACCESS = "AKIAE2ECONNECT000000";
const SECRET = "e2e-connect-secret-value-not-real";

const BUCKETS = {
  "acme-logs": [
    "logs/2026/06/access-0001.parquet",
    "logs/2026/06/access-0002.parquet",
    "logs/2026/07/access-0003.parquet",
  ],
  "acme-backups": ["db/full-2026-06-01.dump"],
};

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
}

async function openCloudProviders(page: Page) {
  await page.getByRole("button", { name: /settings/i }).first().click();
  await expect(page.getByText(/settings & providers/i)).toBeVisible();
  await page.getByRole("button", { name: /^Cloud Providers$/ }).first().click();
}

/** Add a provider pointed at the fake endpoint, through the real form. */
async function addProvider(page: Page, endpointUrl: string, allowedBuckets = "") {
  await page.getByRole("button", { name: /Add cloud provider/i }).first().click();
  // "Custom (S3-compatible)" is the preset that exposes an endpoint field —
  // the one a MinIO/Ceph operator picks.
  await page.getByLabel("Provider", { exact: true }).selectOption({ label: "Custom (S3-compatible)" });
  await page.getByLabel("Endpoint URL", { exact: true }).fill(endpointUrl);
  await page.getByLabel("Region", { exact: true }).fill("us-east-1");
  await page.getByRole("button", { name: /^Advanced$/ }).first().click();
  await page.getByLabel("Name", { exact: true }).fill(PROVIDER_NAME);
  await page.getByLabel("Access key ID", { exact: true }).fill(ACCESS);
  await page.getByLabel("Secret access key", { exact: true }).fill(SECRET);
  if (allowedBuckets) {
    await page.getByLabel("Allowed buckets", { exact: true }).fill(allowedBuckets);
  }
  await page.getByRole("button", { name: /^Add provider$/ }).click();
  await expect(page.getByText(PROVIDER_NAME)).toBeVisible({ timeout: 15_000 });
}

async function openTester(page: Page) {
  await page.getByRole("button", { name: /^Test Connection$/ }).first().click();
}

async function setup(
  page: Page,
  opts: { buckets?: Record<string, string[]>; allowedBuckets?: string } = {},
): Promise<{ fake: FakeS3; cleanup: () => Promise<void> }> {
  const fake = await startFakeS3(opts.buckets ?? BUCKETS);
  await boot(page);
  await openCloudProviders(page);
  await addProvider(page, fake.endpointUrl, opts.allowedBuckets ?? "");
  return {
    fake,
    cleanup: async () => {
      for (const p of await listCloudProviders()) {
        if (p.name === PROVIDER_NAME) await dropCloudProvider(p.id);
      }
      await fake.close();
    },
  };
}

test.describe("connecting to storage", () => {
  test("Test Connection reaches the endpoint and says so", async ({ page }) => {
    const { fake, cleanup } = await setup(page);
    try {
      await openTester(page);
      await page.getByRole("button", { name: /^Test Connection$/ }).last().click();

      // The panel reports success AND the endpoint it actually used — an
      // operator with two similar providers configured needs to see which one
      // answered.
      await expect(page.getByText("test_credentials")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(fake.endpointUrl).first()).toBeVisible();
      expect(fake.requests.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test("List Objects returns the bucket's real contents", async ({ page }) => {
    const { cleanup } = await setup(page);
    try {
      await openTester(page);
      await page.getByPlaceholder(/bucket/i).last().fill("acme-logs");
      await page.getByRole("button", { name: /^List Objects$/ }).click();

      await expect(page.getByText("list_objects_v2")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/access-0001\.parquet/)).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test("Head Bucket on a bucket that is not there names the reason", async ({ page }) => {
    const { cleanup } = await setup(page);
    try {
      await openTester(page);
      await page.getByPlaceholder(/bucket/i).last().fill("not-a-bucket");
      await page.getByRole("button", { name: /^Head Bucket$/ }).click();

      await expect(page.getByText("head_bucket")).toBeVisible({ timeout: 30_000 });
      // A 404 has to arrive as a diagnosis, not as a blank card or a raw
      // exception. The bucket name is a DNS-style identifier, not a secret, and
      // the answer is useless without knowing what failed.
      const panel = await page.locator("body").evaluate((el) => el.textContent ?? "");
      expect(panel).toMatch(/404|NoSuchBucket|not.?found|does not exist/i);
    } finally {
      await cleanup();
    }
  });

  test("an endpoint that refuses the credentials is diagnosable, not a blank failure", async ({
    page,
  }) => {
    const { fake, cleanup } = await setup(page);
    try {
      fake.failWith(403, "SignatureDoesNotMatch", "the request signature we calculated does not match");
      await openTester(page);
      await page.getByRole("button", { name: /^Test Connection$/ }).last().click();

      await expect(page.getByText("test_credentials")).toBeVisible({ timeout: 30_000 });
      const panel = await page.locator("body").evaluate((el) => el.textContent ?? "");
      expect(panel).toContain("SignatureDoesNotMatch");
    } finally {
      await cleanup();
    }
  });

  test("no secret reaches the page or the API, even after a live call", async ({ page }) => {
    const { cleanup } = await setup(page);
    try {
      await openTester(page);
      await page.getByRole("button", { name: /^Test Connection$/ }).last().click();
      await expect(page.getByText("test_credentials")).toBeVisible({ timeout: 30_000 });

      // Rules 1/2/4, checked after a call that actually SIGNED with the secret —
      // the point at which it is most likely to have been echoed back.
      expect(await page.locator("body").innerText()).not.toContain(SECRET);
      expect(await page.locator("body").innerText()).not.toContain(ACCESS);
      const listed = await page.evaluate(
        async (base) => await (await fetch(`${base}/cloud-providers`)).text(),
        `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || 8799}`,
      );
      expect(listed).not.toContain(SECRET);
    } finally {
      await cleanup();
    }
  });

  test("the agent answers about the bucket from a real listing", async ({ page }) => {
    // The whole product in one test: a configured provider, a question, a
    // read-only tool call over HTTP, an answer grounded in what came back.
    const { fake, cleanup } = await setup(page);
    const provider = (await listCloudProviders()).find((p) => p.name === PROVIDER_NAME);
    expect(provider, "the provider must exist before the agent can use it").toBeTruthy();

    const model = await startFakeModel([
      toolTurn("list_objects", { provider_id: provider!.id, bucket: "acme-logs", max_keys: 50 }),
      textTurn(
        "acme-logs holds three access-log objects under logs/2026/, split across " +
          "June and July. Nothing is in a cold storage class yet.",
      ),
    ]);
    const modelId = await useFakeModel(model.baseUrl);
    try {
      // The model provider was added after this page loaded; reload so the
      // composer is in its configured state rather than offering "Add a model".
      await page.reload();
      await expect(composer(page)).toBeVisible({ timeout: 20_000 });
      await composer(page).click();
      await composer(page).fill("what is in acme-logs?");
      await composer(page).press("Enter");

      await expect(page.locator("main").getByText(/three access-log objects/)).toBeVisible({
        timeout: 90_000,
      });

      // Grounded, not invented: the listing the agent was handed has to carry
      // the real keys from the real socket.
      const sent = JSON.stringify(model.requests);
      expect(sent).toContain("access-0001.parquet");
      expect(fake.requests.some((r) => r.includes("acme-logs"))).toBe(true);
      // And no credential went with it (rule 1).
      expect(sent).not.toContain(SECRET);
      expect(sent).not.toContain(ACCESS);
    } finally {
      await cleanup();
      await dropModelProvider(modelId);
      await model.close();
    }
  });

  test("the listing is bounded on the wire, not filtered afterwards", async ({ page }) => {
    const { fake, cleanup } = await setup(page);
    try {
      await openTester(page);
      await page.getByPlaceholder(/bucket/i).last().fill("acme-logs");
      await page.getByRole("button", { name: /^List Objects$/ }).click();
      await expect(page.getByText("list_objects_v2")).toBeVisible({ timeout: 30_000 });

      // Rule 12: the bound has to be in the REQUEST. A cap applied after the
      // response still makes the provider do — and bill for — the full listing.
      expect(fake.requests.some((r) => /max-keys=\d+/.test(r))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("a hundred real objects are still summarised to at most twenty samples", async ({ page }) => {
    const big = { big: Array.from({ length: 100 }, (_, i) => `data/part-${String(i).padStart(4, "0")}.parquet`) };
    const { cleanup } = await setup(page, { buckets: big });
    try {
      await openTester(page);
      await page.getByPlaceholder(/bucket/i).last().fill("big");
      await page.getByRole("button", { name: /^List Objects$/ }).click();
      await expect(page.getByText("list_objects_v2")).toBeVisible({ timeout: 30_000 });

      // Rule 16, on screen, against a bucket that really returns 100 keys.
      const body = await page.locator("body").evaluate((el) => el.textContent ?? "");
      const shown = new Set(body.match(/data\/part-\d{4}\.parquet/g) ?? []);
      expect(shown.size).toBeGreaterThan(0);
      expect(shown.size).toBeLessThanOrEqual(20);
      // The COUNT is still the truth — summarising must not understate the bucket.
      expect(body).toContain("100");
    } finally {
      await cleanup();
    }
  });

  test("a bucket outside the allowlist is refused before anything is sent", async ({ page }) => {
    const { fake, cleanup } = await setup(page, { allowedBuckets: "acme-logs" });
    try {
      await openTester(page);
      const before = fake.requests.length;
      await page.getByPlaceholder(/bucket/i).last().fill("acme-backups");
      await page.getByRole("button", { name: /^Head Bucket$/ }).click();

      // The allowlist is a scope the user configured in this very form. The
      // strong form of honouring it is that the endpoint is never contacted at
      // all — a denial after the request has already been made is not a scope.
      await expect
        .poll(async () => await page.locator("body").evaluate((el) => el.textContent ?? ""), {
          timeout: 20_000,
          message: "a refusal has to say something",
        })
        .toMatch(/not allowed|denied|scope|allowlist|allowed_buckets|403/i);
      expect(fake.requests.length).toBe(before);
    } finally {
      await cleanup();
    }
  });
});
