/**
 * What the composer refuses to do while the backend is unreachable.
 *
 * The offline state disabled the send and attach BUTTONS. It did not touch the
 * keyboard, which is the path most people use: type, press Enter. So the one
 * interaction the offline banner was meant to prevent still dispatched into a
 * dead service and came back as a raw fetch error under the banner saying the
 * service was dead. Slash commands had the same hole — /report is a send.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createElement, createRef } from "react";
import { I18nProvider } from "../i18n";
import { Composer } from "./Composer";

function mount(offline: boolean, text = "why does acme-logs 403?") {
  const onSend = vi.fn();
  const onSlashReport = vi.fn();
  const onSlashPickFile = vi.fn();
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
        onSlashReport,
        onSlashPickFile,
      }),
    ),
  );
  return { onSend, onSlashReport, onSlashPickFile };
}

describe("the composer while the sidecar is unreachable", () => {
  it("does not send on Enter", () => {
    const { onSend } = mount(true);
    fireEvent.keyDown(screen.getByPlaceholderText(/Ask Storage Agent/i), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("still sends on Enter when the sidecar is up", () => {
    // The guard must be about being offline, not about Enter.
    const { onSend } = mount(false);
    fireEvent.keyDown(screen.getByPlaceholderText(/Ask Storage Agent/i), { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("does not run a slash command either", () => {
    const { onSlashReport } = mount(true, "/report");
    fireEvent.keyDown(screen.getByPlaceholderText(/Ask Storage Agent/i), { key: "Enter" });
    expect(onSlashReport).not.toHaveBeenCalled();
  });

  it("leaves the text alone — a blinking service must not eat what you wrote", () => {
    mount(true);
    expect(
      (screen.getByPlaceholderText(/Ask Storage Agent/i) as HTMLTextAreaElement).value,
    ).toContain("acme-logs");
  });
});
