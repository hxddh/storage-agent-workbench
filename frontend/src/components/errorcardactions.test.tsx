/**
 * A pasted S3 error is a structured Direction artifact, not a chat message.
 * It keeps the useful fields and a copy/raw path. Branch and Redirect are not
 * product actions on Direction.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { AgentTaskResult } from "./AgentTaskResult";
import { parseS3Error, isMostlyError } from "../lib/s3error";

const XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  "<Error><Code>AccessDenied</Code><Message>Access Denied</Message>" +
  "<RequestId>ABC123</RequestId></Error>";

function mount(content: string) {
  render(
    createElement(
      I18nProvider,
      null,
      createElement(AgentTaskResult, { role: "user", content }),
    ),
  );
}

describe("the S3 Direction artifact", () => {
  it("is the structured path under test", () => {
    const err = parseS3Error(XML);
    expect(err).not.toBeNull();
    expect(isMostlyError(XML, err!)).toBe(true);
    mount(XML);
    expect(screen.getByTestId("s3-error-card")).toBeTruthy();
  });

  it("does not offer branch or redirect chrome", () => {
    mount(XML);
    expect(screen.queryByTestId("branch-task")).toBeNull();
    expect(screen.queryByTestId("redirect-direction")).toBeNull();
  });

  it("keeps copy and raw payload access", () => {
    mount(XML);
    expect(screen.getByTestId("s3-error-raw-toggle")).toBeTruthy();
  });
});
