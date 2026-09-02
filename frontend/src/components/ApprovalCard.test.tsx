import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import type { ApprovalItem } from "../lib/turnItems";
import { ApprovalCard } from "./ApprovalCard";

const item = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  kind: "approval",
  decision_id: "d1",
  action_type: "import_access_log",
  title: "Download access logs from acme-logs/logs/2026/",
  reason: "The analysis needs the raw access log.",
  status: "pending",
  impact: {
    gate: "cloud_download",
    why: "Moves object bytes from the configured bucket onto this machine.",
    bucket: "acme-logs",
    prefix: "logs/2026/",
    source_type: "access_log",
    file_count: 312,
    total_bytes: 1_932_735_283,
    scan_scope: "prefix logs/2026/ · up to 500 files",
  },
  ...over,
});

afterEach(cleanup);

const draw = (node: React.ReactElement) => render(<I18nProvider>{node}</I18nProvider>);

describe("the inline approval card", () => {
  it("shows the projected impact and the three choices while pending", () => {
    const onResolve = vi.fn();
    draw(<ApprovalCard item={item()} onResolve={onResolve} />);
    const card = screen.getByTestId("approval-card");
    expect(card.getAttribute("data-status")).toBe("pending");
    expect(screen.getByTestId("approval-movement").textContent).toContain("312 files");
    expect(screen.getByTestId("approval-movement").textContent).toContain("1.8 GiB");
    expect(card.textContent).toContain("acme-logs");
    expect(card.textContent).toContain("logs/2026/");
    expect(card.textContent).not.toMatch(/Decision required/);
    fireEvent.click(screen.getByTestId("approval-allow"));
    expect(onResolve).toHaveBeenCalledWith("d1", "approved", "once");
    fireEvent.click(screen.getByTestId("approval-allow-task"));
    expect(onResolve).toHaveBeenCalledWith("d1", "approved", "task");
    fireEvent.click(screen.getByTestId("approval-deny"));
    expect(onResolve).toHaveBeenCalledWith("d1", "declined", "once");
  });

  it("collapses to one resolved line afterwards", () => {
    draw(<ApprovalCard item={item({ status: "approved", scope: "task" })} />);
    expect(screen.queryByTestId("approval-allow")).toBeNull();
    expect(screen.getByTestId("approval-resolved").textContent).toMatch(/Allowed for this task/);
    cleanup();
    draw(<ApprovalCard item={item({ status: "declined" })} />);
    expect(screen.getByTestId("approval-resolved").textContent).toMatch(/Denied/);
    cleanup();
    draw(<ApprovalCard item={item({ status: "granted" })} />);
    expect(screen.getByTestId("approval-resolved").textContent).toMatch(/automatically/);
  });

  it("disables the choices while a resolution is in flight", () => {
    draw(<ApprovalCard item={item()} onResolve={vi.fn()} busy />);
    expect((screen.getByTestId("approval-allow") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Sending…")).toBeTruthy();
  });
});
