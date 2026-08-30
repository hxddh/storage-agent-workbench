/**
 * Price-table rate inputs must keep an accessible name after the wrapping
 * <label> was replaced with table cells.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { I18nProvider } from "../i18n";
import { ThemeProvider } from "../theme";
import { SettingsDrawer } from "./SettingsDrawer";

const api = vi.hoisted(() => ({
  getPriceTable: vi.fn(),
  putPriceTable: vi.fn(),
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

describe("settings price table", () => {
  beforeEach(() => {
    api.getVaultStatus.mockResolvedValue({ unreadable: false });
    api.getPriceTable.mockResolvedValue({
      id: "prices",
      confirmed: true,
      example: false,
      note: "",
      rates: { storage_gb_month: { STANDARD: 0.023, GLACIER: 0.004 } },
      updated_at: null,
    });
  });

  it("names each rate input from its storage-class row header", async () => {
    wrap(createElement(SettingsDrawer, { open: true, onClose: () => undefined }));
    await waitFor(() => expect(screen.getByTestId("settings-price-table")).toBeTruthy());
    expect(screen.getByLabelText("STANDARD")).toBeTruthy();
    expect(screen.getByLabelText("GLACIER")).toBeTruthy();
  });
});
