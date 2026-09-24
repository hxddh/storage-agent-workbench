import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  dropLiveTask,
  patchLiveTask,
  useLiveTaskIndexVersion,
} from "../liveTasks";

function RuntimeIndexProbe() {
  const version = useLiveTaskIndexVersion();
  return <output data-testid="runtime-index-version">{version}</output>;
}

describe("Agent task runtime index", () => {
  it("notifies task navigation when a background task changes state", () => {
    const taskId = "runtime-index-test-task";
    render(<RuntimeIndexProbe />);
    const before = Number(screen.getByTestId("runtime-index-version").textContent);

    act(() => patchLiveTask(taskId, { busy: true, pending: "inspect bucket" }));
    const working = Number(screen.getByTestId("runtime-index-version").textContent);
    expect(working).toBeGreaterThan(before);

    act(() => patchLiveTask(taskId, { busy: false, pending: null }));
    const settled = Number(screen.getByTestId("runtime-index-version").textContent);
    expect(settled).toBeGreaterThan(working);

    act(() => dropLiveTask(taskId));
  });
});
