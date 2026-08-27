/**
 * One byte ladder, because there were three.
 *
 * `RunDetail.bytesH` and `EvidenceImportDialog.bytesH` were the same function
 * pasted twice, and they had already drifted: one topped out at PiB, the other
 * at TiB. Nobody sees that in a single screenshot, which is why it drifts — a
 * run detail and an import dialog describing the same object could round it
 * differently and both look right.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fmtBytes } from "./format";

describe("fmtBytes", () => {
  it("keeps whole bytes whole", () => {
    // "512.0 B" implies a precision that a byte count does not have.
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(0)).toBe("0 B");
  });

  it("climbs the binary ladder with binary labels", () => {
    expect(fmtBytes(1024)).toBe("1.0 KiB");
    expect(fmtBytes(1024 ** 2)).toBe("1.0 MiB");
    expect(fmtBytes(1024 ** 3)).toBe("1.0 GiB");
    expect(fmtBytes(1024 ** 4)).toBe("1.0 TiB");
    expect(fmtBytes(1024 ** 5)).toBe("1.0 PiB");
  });

  it("stops at the top of the ladder rather than inventing a unit", () => {
    expect(fmtBytes(1024 ** 6)).toBe("1024.0 PiB");
  });

  it("returns null for what is not a byte count, rather than '0 B'", () => {
    // An absent size and a zero-byte object are different facts — the same
    // distinction the sidecar draws everywhere else.
    expect(fmtBytes(null)).toBeNull();
    expect(fmtBytes(undefined)).toBeNull();
    expect(fmtBytes(Number.NaN)).toBeNull();
    expect(fmtBytes(-1)).toBeNull();
  });
});

describe("the ladder is not re-implemented", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
    }
    return out;
  }

  it("has exactly one unit ladder in the source tree", () => {
    const files = walk(join(import.meta.dirname ?? __dirname, ".."));
    const ladders = files.filter((f) => /"KiB",\s*"MiB"/.test(readFileSync(f, "utf8")));
    expect(ladders.map((f) => f.split("/").slice(-2).join("/"))).toEqual(["lib/format.ts"]);
  });
});
