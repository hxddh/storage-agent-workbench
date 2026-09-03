import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { fuzzyScore } from "./CommandPalette";
import { cleanHistory } from "./Composer";
import { ApprovalCard } from "./ApprovalCard";
import type { ApprovalItem } from "../lib/turnItems";

afterEach(cleanup);

const draw = (node: React.ReactElement) => render(<I18nProvider>{node}</I18nProvider>);

describe("v1.13 palette fuzzy search", () => {
  it("ranks exact/prefix matches above scattered letters", () => {
    const exact = fuzzyScore("survey", "survey account");
    const scattered = fuzzyScore("srvy", "account survey");
    const nomatch = fuzzyScore("xyz", "survey account");
    expect(exact).toBeGreaterThan(scattered);
    expect(scattered).toBeGreaterThanOrEqual(0);
    expect(nomatch).toBe(-1);
  });

  it("prefers shorter labels on ties", () => {
    expect(fuzzyScore("task", "task")).toBeGreaterThan(fuzzyScore("task", "task list of everything"));
  });
});

describe("v1.13 composer history redaction", () => {
  it("drops entries carrying key material", () => {
    expect(cleanHistory("check AKIAIOSFODNN7EXAMPLE now")).toBeNull();
    expect(cleanHistory("key sk-abc123XYZ_extra here")).toBeNull();
    expect(cleanHistory("-----BEGIN PRIVATE KEY-----\nabc")).toBeNull();
  });

  it("masks credential-bearing values but keeps the entry", () => {
    expect(cleanHistory("why 403 on ?token=abc123?")).toContain("***REDACTED***");
    expect(cleanHistory("why 403 on ?token=abc123?")).not.toContain("abc123");
    expect(cleanHistory("plain question about buckets")).toBe("plain question about buckets");
  });
});

describe("v1.13 approval scan projection", () => {
  const scan = (): ApprovalItem => ({
    kind: "approval",
    decision_id: "d9",
    action_type: "survey_account_large",
    title: "Survey up to 200 buckets on minio",
    reason: "Enumerates up to 200 buckets with live read-only S3 calls.",
    status: "pending",
    impact: {
      gate: "large_scan",
      why: "Enumerates up to 200 buckets on minio with live read-only S3 calls.",
      bucket: null,
      prefix: null,
      source_type: null,
      file_count: null,
      total_bytes: null,
      scan_scope: "up to 200 buckets",
      provider: "minio",
      buckets: 200,
      estimated_calls: 2400,
    },
  });

  it("shows buckets and estimated live calls for a large scan", () => {
    draw(<ApprovalCard item={scan()} onResolve={vi.fn()} />);
    expect(screen.getByTestId("approval-scan-calls").textContent).toContain("200");
    expect(screen.getByTestId("approval-scan-calls").textContent).toContain("2400");
    expect(screen.getByTestId("approval-card").getAttribute("data-action-type")).toBe("survey_account_large");
  });

  it("selecting a mention completes the filename", async () => {
    const { Composer } = await import("./Composer");
    const { ActiveTaskContext } = await import("../agent/activeTask");
    const { container } = render(
      <I18nProvider>
      <ActiveTaskContext.Provider value={null}>
        <Composer
          text=""
          setText={() => undefined}
          attached={null}
          onClearAttachment={() => undefined}
          onPickFile={() => undefined}
          onOpenFilePicker={() => undefined}
          fileRef={{ current: null }}
          taRef={{ current: null }}
          busy={false}
          offline={false}
          uploading={false}
          onSend={() => undefined}
          onStop={() => undefined}
          onSteer={() => undefined}
          mentionables={[{ id: "d1", filename: "inventory-2026.csv" }]}
        />
      </ActiveTaskContext.Provider>
      </I18nProvider>,
    );
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "analyze @inven" } });
    ta.selectionStart = "analyze @inven".length;
    fireEvent.change(ta, { target: { value: "analyze @inven" } });
    expect(screen.getByTestId("composer-mentions").textContent).toContain("inventory-2026.csv");
  });
});
