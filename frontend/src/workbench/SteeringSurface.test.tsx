import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { SteeringSurface } from "./SteeringSurface";

const mocks = vi.hoisted(() => ({
  controller: {
    submit: vi.fn(async () => undefined),
    submitWithDataset: vi.fn(async () => undefined),
    stop: vi.fn(),
    steer: vi.fn(async () => undefined),
  },
  run: {
    busy: false,
    uploading: false,
    pending: null as string | null,
    error: null as string | null,
    needKey: false,
  },
}));

vi.mock("../hooks/useTurnRunner", () => ({
  useActiveTurnController: () => mocks.controller,
}));

vi.mock("../sessionRuns", () => ({
  useSessionRun: () => mocks.run,
  getSessionRun: () => mocks.run,
}));

function renderSteering() {
  return render(
    <I18nProvider>
      <SteeringSurface sessionId="s1" visible offline={false} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  mocks.controller.submit.mockClear();
  mocks.controller.submitWithDataset.mockClear();
  mocks.controller.stop.mockClear();
  mocks.controller.steer.mockClear();
  mocks.run.busy = false;
  mocks.run.uploading = false;
  mocks.run.pending = null;
  mocks.run.error = null;
  mocks.run.needKey = false;
  localStorage.setItem("saw.lang", "en");
});

afterEach(cleanup);

describe("Workbench steering surface", () => {
  it("sends through the Timeline-owned controller while the Agent is idle", async () => {
    renderSteering();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "compare the failed calls" } });
    fireEvent.click(screen.getByRole("button", { name: "send" }));

    await vi.waitFor(() => {
      expect(mocks.controller.submit).toHaveBeenCalledWith("compare the failed calls");
    });
    expect(mocks.controller.steer).not.toHaveBeenCalled();
  });

  it("redirects the same in-flight turn rather than creating a second runner", async () => {
    mocks.run.busy = true;
    mocks.run.pending = "inspect bucket policy";
    renderSteering();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "focus on lifecycle instead" } });
    fireEvent.click(screen.getByRole("button", { name: "Redirect" }));

    await vi.waitFor(() => {
      expect(mocks.controller.steer).toHaveBeenCalledWith("focus on lifecycle instead");
    });
    expect(mocks.controller.submit).not.toHaveBeenCalled();
  });

  it("stops the active session through the shared controller", () => {
    mocks.run.busy = true;
    renderSteering();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(mocks.controller.stop).toHaveBeenCalledWith("s1");
  });

  it("does not offer a steering dock on Timeline or without an investigation", () => {
    const { rerender } = render(
      <I18nProvider>
        <SteeringSurface sessionId="s1" visible={false} offline={false} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("workbench-steering")).toHaveAttribute("hidden");

    rerender(
      <I18nProvider>
        <SteeringSurface sessionId={null} visible offline={false} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("workbench-steering")).toHaveAttribute("hidden");
  });
});
