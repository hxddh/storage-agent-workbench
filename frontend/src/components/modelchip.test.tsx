import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { ModelChip } from "./ModelChip";
import type { ModelProvider } from "../types";

const api = vi.hoisted(() => ({
  listModelProviders: vi.fn(),
  activateModelProvider: vi.fn(),
  updateModelProvider: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), ...api }));

const provider = (over: Partial<ModelProvider>): ModelProvider => ({
  id: "p1", name: "OpenAI", provider_type: "openai", base_url: null, model: "gpt-4.1",
  api_key_ref: null, has_api_key: true, context_window: null, max_output_tokens: null,
  reasoning_effort: null, reasoning_capable: false, active: true,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...over,
});

afterEach(cleanup);

describe("the model chip", () => {
  it("paints no effort control for a model that cannot take one", async () => {
    api.listModelProviders.mockResolvedValue([provider({})]);
    render(<I18nProvider><ModelChip /></I18nProvider>);
    await waitFor(() => expect(screen.getByTestId("model-chip")).toBeTruthy());
    expect(screen.queryByTestId("model-chip-effort")).toBeNull();
    fireEvent.click(screen.getByTestId("model-chip"));
    expect(screen.queryByTestId("model-chip-effort-menu")).toBeNull();
  });

  it("shows model · effort for a reasoning model and stores the choice on the provider", async () => {
    api.listModelProviders.mockResolvedValue([provider({ model: "o3-mini", reasoning_capable: true, reasoning_effort: "medium" })]);
    api.updateModelProvider.mockResolvedValue(provider({ model: "o3-mini", reasoning_capable: true, reasoning_effort: "high" }));
    render(<I18nProvider><ModelChip /></I18nProvider>);
    await waitFor(() => expect(screen.getByTestId("model-chip-effort").textContent).toContain("Medium"));
    fireEvent.click(screen.getByTestId("model-chip"));
    const menu = screen.getByTestId("model-chip-effort-menu");
    expect(menu.querySelector('[aria-pressed="true"]')?.textContent).toBe("Medium");
    // The chip re-reads the provider list after the update lands.
    api.listModelProviders.mockResolvedValue([provider({ model: "o3-mini", reasoning_capable: true, reasoning_effort: "high" })]);
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    await waitFor(() => expect(api.updateModelProvider).toHaveBeenCalledWith("p1", { reasoning_effort: "high" }));
    await waitFor(() => expect(screen.getByTestId("model-chip-effort").textContent).toContain("High"));
  });
});
