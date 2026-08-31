import { expect, test, type Page } from "@playwright/test";
import {
  dropCloudProvider,
  listCloudProviders,
  startFakeS3,
  type FakeS3Options,
} from "./fake-s3";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";

/**
 * The agent's HEAVY path: unlock a tool group, survey a whole account, read the
 * verdict back.
 *
 * Of the app's 43 agent tools, four had ever been driven end to end. The
 * untested ones are the stateful ones — `load_tools` (progressive disclosure),
 * `survey_account` (which spawns a real run), `read_run_result` (which picks
 * that run up in a LATER turn), and the cheap persisted-profile readers. They
 * are also where the product makes its most consequential claim: whether any
 * bucket is publicly exposed.
 *
 * The endpoint kinds below are not corner cases. MinIO, Ceph and garage — the
 * S3-compatible systems this product exists to diagnose — answer `501
 * NotImplemented` to most bucket-config sub-resources, and a least-privilege
 * AWS role routinely lacks `s3:GetBucketPolicyStatus`. In both, the exposure
 * question CANNOT be answered, which is a different fact from "nothing is
 * exposed" — and until v0.70.0 the survey said the reassuring one for all three
 * of: unsupported, denied, and genuinely-private.
 */

const SIDECAR = `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || 8799}`;
const BUCKETS = { "acme-logs": ["logs/a.parquet"], "acme-public": ["www/index.html"] };
const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");

interface Harness {
  providerId: string;
  requests: unknown[];
  cleanup: () => Promise<void>;
}

/** Configure a provider on a fake endpoint, then script the agent's turns. */
async function survey(
  page: Page,
  label: string,
  opts: FakeS3Options,
  extraTurns: (pid: string) => Array<string[] | ((req: never) => string[])> = () => [],
): Promise<Harness> {
  const fake = await startFakeS3(BUCKETS, opts);
  const name = `e2e-survey-${label}`;
  const created = await fetch(`${SIDECAR}/cloud-providers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      provider_type: "s3-compatible",
      endpoint_url: fake.endpointUrl,
      region: "us-east-1",
      addressing_style: "path",
      access_key: "AKIAE2ESURVEY0000000",
      secret_key: "e2e-survey-secret-not-real",
    }),
  });
  const providerId = ((await created.json()) as { id: string }).id;

  const model = await startFakeModel([
    // The group must be unlocked first — `survey_account` is not in the core
    // set. This is the app's progressive-disclosure contract, and it had never
    // been exercised from a browser either.
    toolTurn("load_tools", { group: "account_wide" }),
    toolTurn("survey_account", { provider_id: providerId }),
    ...extraTurns(providerId),
    textTurn("I have surveyed the account; the details are above."),
  ] as never[]);
  const modelId = await useFakeModel(model.baseUrl);

  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
  await composer(page).click();
  await composer(page).fill("survey my account and tell me if anything is public");
  await composer(page).press("Enter");
  await expect(page.locator("main").getByText(/I have surveyed the account/)).toBeVisible({
    timeout: 120_000,
  });

  return {
    providerId,
    requests: model.requests,
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

/** The survey summary the agent was actually handed. */
function verdict(requests: unknown[]): string {
  const m = JSON.stringify(requests).match(/Account discovery via provider[^"]{0,600}/);
  return m ? m[0] : "";
}

test.describe("surveying an account", () => {
  test("a minimal S3-compatible endpoint does not get a clean bill of health", async ({ page }) => {
    // Every config sub-resource answers 501 — MinIO/Ceph/garage behaviour.
    const h = await survey(page, "minimal", { subresources: "unsupported" });
    try {
      const v = verdict(h.requests);
      expect(v, "the survey must reach the model").toContain("2 bucket(s) visible");
      expect(v).toContain("UNDETERMINED");
      expect(v).not.toContain("No publicly exposed buckets detected");
      // Named, and with the reason — a count alone is not actionable.
      expect(v).toContain("acme-logs");
      expect(v).toMatch(/unsupported or denied/);
    } finally {
      await h.cleanup();
    }
  });

  test("credentials that cannot read the policy status do not get one either", async ({ page }) => {
    const h = await survey(page, "denied", { subresources: "denied" });
    try {
      const v = verdict(h.requests);
      expect(v).toContain("UNDETERMINED");
      expect(v).not.toContain("No publicly exposed buckets detected");
    } finally {
      await h.cleanup();
    }
  });

  test("an endpoint that really answers, with nothing public, earns the clean verdict", async ({
    page,
  }) => {
    const h = await survey(page, "private", {
      subresources: "full",
      config: { "acme-logs": { policyIsPublic: false }, "acme-public": { policyIsPublic: false } },
    });
    try {
      const v = verdict(h.requests);
      expect(v).toContain("No publicly exposed buckets detected");
      expect(v).not.toContain("UNDETERMINED");
    } finally {
      await h.cleanup();
    }
  });

  test("a genuinely public bucket is named", async ({ page }) => {
    const h = await survey(page, "public", {
      subresources: "full",
      config: { "acme-logs": { policyIsPublic: false }, "acme-public": { policyIsPublic: true } },
    });
    try {
      const v = verdict(h.requests);
      expect(v).toContain("PUBLIC EXPOSURE");
      expect(v).toContain("acme-public");
    } finally {
      await h.cleanup();
    }
  });

  test("the survey does not surface as a run card in the Task", async ({ page }) => {
    // CLAUDE.md is explicit: nothing the agent does in a Task surfaces
    // as a structured run card — those runs are recorded with `origin='agent'`
    // and the Task filters them out; the agent narrates inline. That rule had
    // never been verified in a browser, and `survey_account` is the tool most
    // likely to break it since it creates a real run.
    const h = await survey(page, "nocard", { subresources: "full" });
    try {
      const taskText = await page.locator("main").evaluate((el) => el.textContent ?? "");
      expect(taskText).toContain("I have surveyed the account");
      expect(taskText).not.toMatch(/account_discovery/);
      expect(taskText).not.toMatch(/Run\s+(completed|failed)/i);
    } finally {
      await h.cleanup();
    }
  });

  test("the persisted profile answers posture without a second scan", async ({ page }) => {
    // `query_account_profile` is the cheap reader: it must answer from the
    // survey that already ran, making NO new S3 calls. That is the whole point
    // of persisting the profile.
    const h = await survey(page, "profile", { subresources: "full" }, (pid) => [
      toolTurn("query_account_profile", { provider_id: pid, filter: "all" }),
    ]);
    try {
      const blob = JSON.stringify(h.requests);
      expect(blob).toContain("acme-logs");
      // The profile is a status matrix, never raw object keys (rule 11/16).
      expect(blob).not.toContain("www/index.html");
    } finally {
      await h.cleanup();
    }
  });
});
