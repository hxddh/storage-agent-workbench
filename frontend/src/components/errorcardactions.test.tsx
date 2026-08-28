/**
 * A pasted S3 error is still a message you can act on.
 *
 * When the user's turn is recognised as an error it renders as a card instead
 * of a prose bubble. That second render path inlined its own action row and
 * carried only edit — so branching, the action that matters most on exactly
 * this message (a pasted error is the seed of a whole investigation, and
 * following two hypotheses from it is the normal way to work), silently
 * disappeared for the messages most likely to need it.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { MessageCard } from "./ThreadCards";
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
      createElement(MessageCard, { role: "user", content, onEdit: () => {}, onBranch }),
    ),
  );
  return { onBranch };
}

describe("the S3 error card", () => {
  it("is the path under test — this message really does render as a card", () => {
    const err = parseS3Error(XML);
    expect(err).not.toBeNull();
    expect(isMostlyError(XML, err!)).toBe(true);
  });

  it("keeps branch, like every other user message", () => {
    const { onBranch } = mount(XML);
    fireEvent.click(screen.getByTestId("branch-message"));
    expect(onBranch).toHaveBeenCalledTimes(1);
  });

  it("keeps edit too", () => {
    mount(XML);
    expect(screen.getByTestId("edit-message")).toBeTruthy();
  });

  it("a prose question is unaffected", () => {
    mount("why does acme-logs deny every list call?");
    expect(screen.getByTestId("branch-message")).toBeTruthy();
  });
});
