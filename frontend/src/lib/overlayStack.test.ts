/**
 * Escape closes the top overlay, and only that one.
 *
 * Five window-level Escape handlers had grown up independently and all fired at
 * once. Measured in a browser before this existed: with the session inspector
 * open, opening the command palette and pressing Escape once left
 * `{palette: 0, inspector: 0}` — both gone.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { closeTopOverlay, overlayDepth, pushOverlay, resetOverlayStack } from "./overlayStack";

beforeEach(() => resetOverlayStack());

describe("the overlay stack", () => {
  it("asks the one that opened last", () => {
    const first = vi.fn();
    const second = vi.fn();
    pushOverlay(first);
    pushOverlay(second);

    expect(closeTopOverlay()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("moves down the stack as each one goes", () => {
    const first = vi.fn();
    const second = vi.fn();
    pushOverlay(first);
    const popSecond = pushOverlay(second);

    closeTopOverlay();
    // A real overlay unmounts when it closes; that is what removes it.
    popSecond();
    closeTopOverlay();
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("says so when there is nothing to close, so Escape stays inert", () => {
    // The composer must not swallow Escape when no overlay is open.
    expect(closeTopOverlay()).toBe(false);
  });

  it("removes an overlay from the middle without disturbing the rest", () => {
    // Closing is not always top-down: a drawer can be dismissed by its own
    // button while a palette sits above it.
    const bottom = vi.fn();
    const middle = vi.fn();
    const top = vi.fn();
    pushOverlay(bottom);
    const popMiddle = pushOverlay(middle);
    pushOverlay(top);

    popMiddle();
    expect(overlayDepth()).toBe(2);
    closeTopOverlay();
    expect(top).toHaveBeenCalledTimes(1);
    expect(middle).not.toHaveBeenCalled();
  });
});
