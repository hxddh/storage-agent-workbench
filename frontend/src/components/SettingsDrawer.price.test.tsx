/**
 * Settings is model + storage credentials + language/theme. The cost simulator
 * may still read a Sidecar price table; that table is not a Settings spreadsheet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { I18nProvider } from "../i18n";
import { ThemeProvider } from "../theme";
import { SettingsDrawer } from "./SettingsDrawer";

const api = vi.hoisted(() => ({
  getVaultStatus: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, ...api };
});

vi.mock("../views/ProvidersView", () => ({
  ProvidersView: () => null,
}));

function wrap(node: ReactNode) {
  return render(
    createElement(ThemeProvider, null, createElement(I18nProvider, null, node)),
  );
}

describe("settings drawer", () => {
  beforeEach(() => {
    api.getVaultStatus.mockResolvedValue({ unreadable: false });
  });

  it("does not render a storage price table", async () => {
    wrap(createElement(SettingsDrawer, { open: true, onClose: () => undefined }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.queryByTestId("settings-price-table")).toBeNull();
  });
});
