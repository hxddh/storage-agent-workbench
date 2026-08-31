/**
 * What the Agent task Composer refuses to do while the backend is unreachable.
 *
 * The offline state must guard the keyboard path as well as buttons. These tests
 * intentionally locate the stable Agent control boundary instead of user-facing
 * placeholder copy, because Delegate/Steer language is part of product UX.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { createElement, createRef } from "react";
import { I18nProvider } from "../i18n";
import { Composer } from "./Composer";

function mount(offline: boolean, text = "why does acme-logs 403?") {
  const onSend = vi.fn();
  render(
    createElement(
      I18nProvider,
      null,
      createElement(Composer, {
        text,
        setText: () => {},
        attached: null,
        attachType: null,
        setAttachType: () => {},
        onClearAttachment: () => {},
        onPickFile: () => {},
        onOpenFilePicker: () => {},
        fileRef: createRef<HTMLInputElement>(),
        taRef: createRef<HTMLTextAreaElement>(),
        busy: false,
        offline,
        uploading: false,
        onSend,
        onStop: () => {},
        onSteer: () => {},
        modelName: "gpt-x",
        onOpenSettings: () => {},
      }),
    ),
  );
  const textbox = within(screen.getByTestId("agent-composer")).getByRole("textbox") as HTMLTextAreaElement;
  return { onSend, textbox };
}

describe("the Agent task Composer while the sidecar is unreachable", () => {
  it("does not delegate on Enter", () => {
    const { onSend, textbox } = mount(true);
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("still delegates on Enter when the sidecar is up", () => {
    const { onSend, textbox } = mount(false);
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("treats a leading slash as ordinary Direction text", () => {
    const { onSend, textbox } = mount(true, "/report");
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(textbox.value).toBe("/report");
  });

  it("preserves the user's task direction while offline", () => {
    const { textbox } = mount(true);
    expect(textbox.value).toContain("acme-logs");
  });
});
