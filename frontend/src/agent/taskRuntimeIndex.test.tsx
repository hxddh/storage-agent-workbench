import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  dropSessionRun,
  patchSessionRun,
  useSessionRunIndexVersion,
} from "../sessionRuns";

function RuntimeIndexProbe() {
  const version = useSessionRunIndexVersion();
  return <output data-testid="runtime-index-version">{version}</output>;
}

describe("Agent task runtime index", () => {
  it("notifies the command center when a background task changes state", () => {
    const taskId = "runtime-index-test-task";
    render(<RuntimeIndexProbe />);
    const before = Number(screen.getByTestId("runtime-index-version").textContent);

    act(() => patchSessionRun(taskId, { busy: true, pending: "inspect bucket" }));
    const working = Number(screen.getByTestId("runtime-index-version").textContent);
    expect(working).toBeGreaterThan(before);

    act(() => patchSessionRun(taskId, { busy: false, pending: null }));
    const settled = Number(screen.getByTestId("runtime-index-version").textContent);
    expect(settled).toBeGreaterThan(working);

    act(() => dropSessionRun(taskId));
  });
});
