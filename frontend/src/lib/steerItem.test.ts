/**
 * A Steer is a Direction, never a tool row (v1.18): `steer.applied` lands as
 * one `steer` item where the running model loop took it, live and durable.
 */
import { describe, expect, it } from "vitest";
import { dispatchDurableEvent, type LiveEventHandlers } from "../api";
import type { ToolActivity } from "../types";
import { EMPTY_TURN, applySteer, applyTool, segmentsOf, turnItemsOf } from "./turnItems";

const tool = (over: Partial<ToolActivity> = {}): ToolActivity =>
  ({ id: "c1", tool: "head_bucket", target: "logs", result: "ok", ok: true, status: "completed", ...over }) as ToolActivity;

describe("steer turn items", () => {
  it("dispatches steer.applied to its own handler, not onTool", () => {
    const seen: string[] = [];
    const on = {
      onDelta: () => {},
      onTool: () => seen.push("tool"),
      onSteerApplied: (p: { text: string }) => seen.push(`steer:${p.text}`),
    } as unknown as LiveEventHandlers;
    dispatchDurableEvent("steer.applied", { text: "only the logs bucket" }, on);
    expect(seen).toEqual(["steer:only the logs bucket"]);
  });

  it("places the steer between the worked groups it splits", () => {
    let turn = applyTool(EMPTY_TURN, tool({ id: "a" }));
    turn = applySteer(turn, "  only the logs bucket ");
    turn = applyTool(turn, tool({ id: "b" }));
    expect(segmentsOf(turn.items).map((s) => s.kind)).toEqual(["worked", "steer", "worked"]);
    expect(turn.items[1]).toEqual({ kind: "steer", text: "only the logs bucket" });
    expect(applySteer(turn, "   ")).toBe(turn);
  });

  it("projects a persisted steer ref and drops pre-1.18 steer notices from the tool rows", () => {
    const items = turnItemsOf({
      turn_items: [{ kind: "tool", id: "a" }, { kind: "steer", text: "skip versions" }],
      tool_activity: [tool({ id: "a" }), tool({ id: undefined, tool: "user_steer", result: "skip versions" })],
    });
    expect(items.map((i) => i.kind)).toEqual(["tool", "steer"]);
  });

  it("reads a legacy live user_steer row as a steer", () => {
    const segments = segmentsOf([{ kind: "tool", record: tool({ tool: "user_steer", result: "faster" }) }]);
    expect(segments).toEqual([{ kind: "steer", text: "faster" }]);
  });
});
