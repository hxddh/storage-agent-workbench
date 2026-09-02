/**
 * Settings is model + storage credentials + language/theme. The cost simulator
 * may still read a Sidecar price table; that table is not a Settings spreadsheet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { I18nProvider } from "../i18n";
import { ThemeProvider } from "../theme";
import { SettingsDialog } from "./SettingsDialog";

const api = vi.hoisted(() => ({
  getVaultStatus: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, ...api };
});

vi.mock("../views/ProvidersView", () => ({
  ModelProvidersPanel: () => <div data-testid="model-panel" />,
  CloudProvidersPanel: () => <div data-testid="cloud-panel" />,
}));
vi.mock("./NativeAgentPanel", () => ({ NativeAgentPanel: () => null }));

function wrap(node: ReactNode) {
  return render(
    createElement(ThemeProvider, null, createElement(I18nProvider, null, node)),
  );
}

describe("settings dialog", () => {
  beforeEach(() => {
    api.getVaultStatus.mockResolvedValue({ unreadable: false });
  });

  it("does not render a storage price table", async () => {
    wrap(createElement(SettingsDialog, { open: true, onClose: () => undefined }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.queryByTestId("settings-price-table")).toBeNull();
  });

  it("is model + storage + general + safety, navigated by pressed sections", async () => {
    wrap(createElement(SettingsDialog, { open: true, onClose: () => undefined }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    const model = screen.getByRole("button", { name: "Model Providers" });
    const cloud = screen.getByRole("button", { name: "Cloud Providers" });
    expect(model.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(model);
    expect(model.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("model-panel")).toBeTruthy();
    fireEvent.click(cloud);
    expect(cloud.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("cloud-panel")).toBeTruthy();
  });
});
