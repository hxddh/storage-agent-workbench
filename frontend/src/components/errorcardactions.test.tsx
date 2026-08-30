/**
 * A pasted S3 error is a structured Direction artifact, not a chat message.
 * It must retain the same task controls as any other Direction: redirect the
 * current objective or branch a new task, without falling back to message-era UI.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { AgentTaskResult } from "./AgentTaskResult";
import { parseS3Error, isMostlyError } from "../lib/s3error";

const XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  "<Error><Code>AccessDenied</Code><Message>Access Denied</Message>" +
  "<RequestId>ABC123</RequestId></Error>";

function mount(content: string) {
  const onBranch = vi.fn();
  render(
    createElement(
      I18nProvider,
      null,
      createElement(AgentTaskResult, { role: "user", content, onEdit: () => {}, onBranch }),
    ),
  );
  return { onBranch };
}

describe("the S3 Direction artifact", () => {
  it("is the structured path under test", () => {
    const err = parseS3Error(XML);
    expect(err).not.toBeNull();
    expect(isMostlyError(XML, err!)).toBe(true);
    mount(XML);
    expect(screen.getByTestId("s3-error-card")).toBeTruthy();
  });

  it("keeps task branching", () => {
    const { onBranch } = mount(XML);
    fireEvent.click(screen.getByTestId("branch-task"));
    expect(onBranch).toHaveBeenCalledTimes(1);
  });

  it("keeps task redirect", () => {
    mount(XML);
    expect(screen.getByTestId("redirect-direction")).toBeTruthy();
  });

  it("keeps the same task controls for prose Directions", () => {
    mount("why does acme-logs deny every list call?");
    expect(screen.getByTestId("branch-task")).toBeTruthy();
    expect(screen.getByTestId("redirect-direction")).toBeTruthy();
  });
});
