/**
 * Settings → Safety (v1.12): the approval policy is read from and written to
 * the Sidecar; the gated tools it can reach are listed from the same reply.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { SafetyPane } from "./SafetyPane";

const api = vi.hoisted(() => ({
  getApprovalPolicy: vi.fn(),
  putApprovalPolicy: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, ...api };
});

const info = (policy: "ask" | "allow_session" | "allow_always") => ({
  policy,
  gated_tools: [
    { name: "import_evidence", action_types: ["import_access_log", "import_inventory"], why: "Moves object bytes onto this machine." },
    { name: "survey_account", action_types: ["survey_account_large"], why: "A survey above the default bucket cap." },
  ],
});

const draw = () => render(<I18nProvider><SafetyPane /></I18nProvider>);

describe("the Safety pane", () => {
  beforeEach(() => {
    api.getApprovalPolicy.mockReset();
    api.putApprovalPolicy.mockReset();
    api.getApprovalPolicy.mockResolvedValue(info("ask"));
    api.putApprovalPolicy.mockImplementation(async (policy: "ask" | "allow_session" | "allow_always") => info(policy));
  });

  it("shows the three options, the one in force, and the gated tools", async () => {
    draw();
    await waitFor(() => expect(screen.getByTestId("approval-policy")).toBeTruthy());
    expect(screen.getByTestId("approval-policy").getAttribute("data-policy")).toBe("ask");
    expect((screen.getByTestId("approval-policy-ask") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("approval-policy-allow_session") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId("approval-policy-allow_always")).toBeTruthy();
    expect(screen.getByText("Ask every time")).toBeTruthy();
    expect(screen.getByText("Always allow")).toBeTruthy();
    const tools = screen.getByTestId("approval-gated-tools");
    expect(tools.textContent).toContain("import_evidence");
    expect(tools.textContent).toContain("survey_account_large");
  });

  it("persists a change with PUT and reflects the reply", async () => {
    draw();
    await waitFor(() => expect(screen.getByTestId("approval-policy")).toBeTruthy());
    fireEvent.click(screen.getByTestId("approval-policy-allow_session"));
    await waitFor(() => expect(api.putApprovalPolicy).toHaveBeenCalledWith("allow_session"));
    await waitFor(() => expect(screen.getByTestId("approval-policy").getAttribute("data-policy")).toBe("allow_session"));
    expect((screen.getByTestId("approval-policy-allow_session") as HTMLInputElement).checked).toBe(true);
  });

  it("rolls back and reports when the Sidecar refuses", async () => {
    api.putApprovalPolicy.mockRejectedValueOnce(new Error("policy locked"));
    draw();
    await waitFor(() => expect(screen.getByTestId("approval-policy")).toBeTruthy());
    fireEvent.click(screen.getByTestId("approval-policy-allow_always"));
    await waitFor(() => expect(screen.getByTestId("approval-policy-error").textContent).toContain("policy locked"));
    expect(screen.getByTestId("approval-policy").getAttribute("data-policy")).toBe("ask");
  });
});
