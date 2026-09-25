import { describe, expect, it, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { fuzzyScore } from "./CommandPalette";
import { cleanHistory } from "./Composer";

afterEach(cleanup);


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

describe("v1.13 @ mentions", () => {
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
