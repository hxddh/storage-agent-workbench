/**
 * What the Agent task Composer refuses to do while the backend is unreachable.
 *
 * The offline state must guard the keyboard path as well as buttons. These tests
 * intentionally locate the stable Agent control boundary instead of user-facing
 * placeholder copy, because Delegate/Steer language is part of product UX.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { createElement, createRef } from "react";
import { I18nProvider } from "../i18n";
import { Composer } from "./Composer";
import { ActiveTaskContext } from "../agent/activeTask";
import { dropSessionRun, patchSessionRun } from "../sessionRuns";
import type { ExecutionMetrics, ModelProvider } from "../types";

const api = vi.hoisted(() => ({
  listModelProviders: vi.fn(),
  activateModelProvider: vi.fn(),
  updateModelProvider: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), ...api }));

const aProvider = (): ModelProvider => ({
  id: "p1", name: "OpenAI", provider_type: "openai", base_url: null, model: "gpt-4.1",
  api_key_ref: null, has_api_key: true, context_window: null, max_output_tokens: null,
  reasoning_effort: null, reasoning_capable: false, active: true,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
});

beforeEach(() => {
  // Keyboard tests never open the chip; leave the list pending so ModelChip
  // stays on its skeleton and does not update after the assertion.
  api.listModelProviders.mockReturnValue(new Promise(() => {}));
});

function mount(offline: boolean, text = "why does acme-logs 403?", busy = false, taskId: string | null = null) {
  const onSend = vi.fn();
  const onStop = vi.fn();
  const setText = vi.fn();
  render(
    createElement(
      I18nProvider,
      null,
      createElement(
        ActiveTaskContext.Provider,
        { value: taskId },
        createElement(Composer, {
          text,
          setText,
          attached: null,
          onClearAttachment: () => {},
          onPickFile: () => {},
          onOpenFilePicker: () => {},
          fileRef: createRef<HTMLInputElement>(),
          taRef: createRef<HTMLTextAreaElement>(),
          busy,
          offline,
          uploading: false,
          onSend,
          onStop,
          onSteer: () => {},
        }),
      ),
    ),
  );
  const textbox = within(screen.getByTestId("agent-composer")).getByRole("textbox") as HTMLTextAreaElement;
  return { onSend, onStop, setText, textbox };
}

describe("the Agent task Composer while the sidecar is unreachable", () => {
  it("does not delegate on Enter", () => {
    const { onSend, textbox } = mount(true);
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("still delegates on Enter when the sidecar is up", () => {
    const { onSend, textbox } = mount(false);
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("treats a leading slash as ordinary Direction text", () => {
    const { onSend, textbox } = mount(true, "/report");
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(textbox.value).toBe("/report");
  });

  it("preserves the user's task direction while offline", () => {
    const { textbox } = mount(true);
    expect(textbox.value).toContain("acme-logs");
  });
});

describe("Esc in the Composer", () => {
  it("stops the running execution when the Composer is empty", () => {
    const { onStop, textbox } = mount(false, "", true);
    fireEvent.keyDown(textbox, { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the Composer holds text — the draft is never cleared", () => {
    const { onStop, setText, textbox } = mount(false, "keep looking at the bucket policy", true);
    fireEvent.keyDown(textbox, { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
    expect(setText).not.toHaveBeenCalled();
    expect(textbox.value).toBe("keep looking at the bucket policy");
  });

  it("does nothing when no execution is running", () => {
    const { onStop, textbox } = mount(false, "", false);
    fireEvent.keyDown(textbox, { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe("the context meter in the model menu", () => {
  const metrics = (over: Partial<ExecutionMetrics> & { context_window?: number | null }) => ({ messageId: "m1", metrics: over as ExecutionMetrics });

  beforeEach(() => {
    api.listModelProviders.mockResolvedValue([aProvider()]);
  });

  async function openMenu() {
    await waitFor(() => expect(screen.getByTestId("model-chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("model-chip"));
    await waitFor(() => expect(screen.getByTestId("model-chip-menu")).toBeTruthy());
  }

  it("is not painted on the Composer bar", async () => {
    mount(false, "", false, "ctx-bar");
    await waitFor(() => expect(screen.getByTestId("model-chip")).toBeTruthy());
    expect(screen.queryByTestId("context-meter")).toBeNull();
  });

  it("names silence instead of vanishing when usage or the window is missing", async () => {
    patchSessionRun("ctx-none", { lastMetrics: metrics({ total_tokens: 12_000 }) });
    mount(false, "", false, "ctx-none");
    await openMenu();
    // v1.15 — vanishing was the lie; the meter paints a quiet badge.
    expect(screen.getByTestId("context-meter").getAttribute("data-state")).toBe("unreported");
    dropSessionRun("ctx-none");
  });

  it("shows the share of the window the last execution used", async () => {
    patchSessionRun("ctx-some", { lastMetrics: metrics({ usage: { total_tokens: 32_000 }, context_window: 128_000 }) });
    mount(false, "", false, "ctx-some");
    await openMenu();
    const meter = screen.getByTestId("context-meter");
    expect(meter.getAttribute("data-pct")).toBe("25");
    expect(meter.textContent).toContain("25%");
    expect(meter.getAttribute("title")).toContain("32k of 128k");
    dropSessionRun("ctx-some");
  });

  it("paints nothing on the empty start surface", async () => {
    mount(false, "", false, null);
    await waitFor(() => expect(screen.getByTestId("model-chip")).toBeTruthy());
    expect(screen.queryByTestId("context-meter")).toBeNull();
  });
});
