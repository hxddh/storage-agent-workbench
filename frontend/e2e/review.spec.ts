import { expect, test, type Page } from "@playwright/test";
import {
  dropCloudProvider,
  listCloudProviders,
  startFakeS3,
  type FakeS3Options,
} from "./fake-s3";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";

/**
 * The four review lenses, against endpoints that cannot answer.
 *
 * v0.70.0 found the account survey saying "No publicly exposed buckets
 * detected" for a check that never ran. The bucket review produces the same
 * SHAPE of output — a verdict the agent narrates — from the same config
 * sub-resources, so it was the obvious next place to look for that bug.
 *
 * It is not there. The review layer already distinguishes all three states, and
 * says so in its own `overall_status`:
 *
 *   minimal S3-compatible (501)  → provider_limited, every aspect named unsupported
 *   credentials without access    → partial_access,  every aspect named denied
 *   an endpoint that answers      → reviewed,        and the GOOD verdict says
 *                                                     what it checked
 *
 * `_unsupported_findings` even covers the unexpected-error case, with a comment
 * that reads like the lesson v0.70.0 had to learn the hard way: a read error
 * "is NOT 'no problem'".
 *
 * So this spec pins good behaviour rather than fixing bad. That is worth doing
 * precisely because the survey shows how quietly this property can be lost: the
 * data was honest there too, and a single collapsed branch one level up turned
 * "could not check" into "nothing wrong".
 */

const SIDECAR = `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || 8799}`;
const composer = (page: Page) => page.getByPlaceholder(/Ask Storage Agent/i);

async function review(page: Page, label: string, opts: FakeS3Options): Promise<{
  summary: string;
  cleanup: () => Promise<void>;
}> {
  const fake = await startFakeS3({ "acme-logs": ["logs/a.parquet"] }, opts);
  const name = `e2e-review-${label}`;
  const pid = ((await (await fetch(`${SIDECAR}/cloud-providers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name, provider_type: "s3-compatible", endpoint_url: fake.endpointUrl,
      region: "us-east-1", addressing_style: "path",
      access_key: "AKIAE2EREVIEW0000000", secret_key: "e2e-review-secret-not-real",
    }),
  })).json()) as { id: string }).id;

  const model = await startFakeModel([
    toolTurn("load_tools", { group: "bucket_config" }),
    toolTurn("review_bucket_config", { provider_id: pid, bucket: "acme-logs" }),
    textTurn("I have reviewed the bucket; the details are above."),
  ]);
  const modelId = await useFakeModel(model.baseUrl);

  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
  await composer(page).click();
  await composer(page).fill("review the configuration of acme-logs");
  await composer(page).press("Enter");
  await expect(page.locator("main").getByText(/I have reviewed the bucket/)).toBeVisible({
    timeout: 120_000,
  });

  const m = JSON.stringify(model.requests).match(/Read-only configuration review[^"]{0,900}/);
  return {
    summary: m ? m[0] : "",
    cleanup: async () => {
      await dropModelProvider(modelId);
      await model.close();
      for (const p of await listCloudProviders()) {
        if (p.name === name) await dropCloudProvider(p.id);
      }
      await fake.close();
    },
  };
}

test.describe("reviewing a bucket the endpoint cannot fully describe", () => {
  test("a minimal S3-compatible endpoint is reported as provider-limited", async ({ page }) => {
    const r = await review(page, "minimal", { subresources: "unsupported" });
    try {
      expect(r.summary, "the review must reach the model").toContain("acme-logs");
      expect(r.summary).toContain("provider_limited");
      expect(r.summary).toContain("Provider unsupported");
      // Named aspect by aspect, so the operator knows what to check by hand.
      expect(r.summary).toMatch(/policy not supported|encryption not supported/);
      // And never mistaken for a healthy bucket.
      expect(r.summary).not.toContain("overall status: reviewed");
    } finally {
      await r.cleanup();
    }
  });

  test("credentials that cannot read the configuration are reported as partial access", async ({
    page,
  }) => {
    const r = await review(page, "denied", { subresources: "denied" });
    try {
      expect(r.summary).toContain("partial_access");
      expect(r.summary).toMatch(/Access denied reading/);
      expect(r.summary).not.toContain("overall status: reviewed");
    } finally {
      await r.cleanup();
    }
  });

  test("an endpoint that really answers gets a real verdict, and it says what it checked", async ({
    page,
  }) => {
    const r = await review(page, "full", {
      subresources: "full",
      config: { "acme-logs": { policyIsPublic: false, encrypted: true } },
    });
    try {
      expect(r.summary).toContain("reviewed");
      // The distinction v0.70.0 was about: a clean verdict states its basis.
      expect(r.summary).toMatch(/Not public \(policy verdict \+ ACL check\)/);
      expect(r.summary).toContain("Default encryption enabled");
    } finally {
      await r.cleanup();
    }
  });
});
