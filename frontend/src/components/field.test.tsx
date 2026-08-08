/**
 * v0.68.0 — what a form control is actually CALLED.
 *
 * `Field` wrapped a `<label>` around the control *and* the hint. A wrapping
 * label with no `for` contributes its whole subtree to the control's accessible
 * name, so the name a screen reader announces was label + hint — and for a
 * `<select>`, label + hint + every option's text:
 *
 *   Provider          → "ProviderAWS S3Alibaba Cloud OSSTencent Cloud COS…"
 *   Access key ID     → "Access key IDStored only in the encrypted local vault…"
 *
 * Measured in a browser against the real Add-cloud-provider form — the one every
 * user has to complete before the app does anything at all. `Field` backs 25
 * controls across that form and the evidence-import dialog; 12 carry a hint.
 *
 * The fix is the ordinary one: `<label for>` naming the control, and the hint
 * attached with `aria-describedby` — which is what a hint IS. It is a
 * description, announced after the name, not part of it.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field, TextInput, Select } from "./ui";

describe("Field names its control", () => {
  it("a text field is named by its label alone", () => {
    render(
      <Field label="Region">
        <TextInput defaultValue="" />
      </Field>,
    );
    expect(screen.getByLabelText("Region")).toBeTruthy();
  });

  it("a hint does not become part of the name", () => {
    render(
      <Field label="Access key ID" hint="Stored only in the encrypted local vault.">
        <TextInput type="password" />
      </Field>,
    );
    // The name is the label. Exact — a substring match would pass even with the
    // hint glued on, which is the bug.
    const input = screen.getByLabelText("Access key ID");
    expect(input).toBeTruthy();
    // …and the hint is still reachable, as a DESCRIPTION.
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain("encrypted local vault");
  });

  it("a select is not named by its own options", () => {
    render(
      <Field label="Provider">
        <Select defaultValue="aws">
          <option value="aws">AWS S3</option>
          <option value="oss">Alibaba Cloud OSS</option>
          <option value="custom">Custom (S3-compatible)</option>
        </Select>
      </Field>,
    );
    const select = screen.getByLabelText("Provider");
    expect(select.tagName).toBe("SELECT");
  });

  it("two fields on the same form get distinct ids", () => {
    render(
      <div>
        <Field label="Region" hint="h1">
          <TextInput />
        </Field>
        <Field label="Endpoint URL" hint="h2">
          <TextInput />
        </Field>
      </div>,
    );
    const a = screen.getByLabelText("Region");
    const b = screen.getByLabelText("Endpoint URL");
    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
    expect(a.getAttribute("aria-describedby")).not.toBe(b.getAttribute("aria-describedby"));
  });

  it("an explicit id on the control is respected", () => {
    render(
      <Field label="Region">
        <TextInput id="my-own-id" />
      </Field>,
    );
    expect(screen.getByLabelText("Region").id).toBe("my-own-id");
  });
});
