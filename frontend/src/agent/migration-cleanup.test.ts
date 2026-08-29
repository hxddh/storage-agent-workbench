import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("v0.93 migration cleanup", () => {
  it("does not ship one-shot self-modifying migration workflows", () => {
    expect(
      existsSync(new URL("../../../.github/workflows/v093-ui-vocabulary-migration.yml", import.meta.url)),
    ).toBe(false);
  });
});
