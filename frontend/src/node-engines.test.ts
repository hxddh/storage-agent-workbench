/**
 * v0.57.0 — CI must run a Node the dependencies actually support.
 *
 * The v0.57.0 frontend generation bump passed locally (Node 22.22.2) and failed
 * in CI (Node 20) with `webidl.util.markAsUncloneable is not a function`:
 * jsdom 30 declares `engines.node: ^22.22.2 || ...`, its undici 8 declares
 * `>=22.19.0`, and `worker_threads.markAsUncloneable` landed in Node 22.10 and
 * was never backported to 20. npm does not enforce `engines` unless
 * `engine-strict` is set, so `npm ci` succeeded and the mismatch only surfaced
 * as a runtime TypeError inside the test worker.
 *
 * Nothing declared what Node this frontend needs, so nothing could check it.
 * Both halves are fixed here: `engines.node` in package.json states the floor,
 * and this test holds the workflows to it.
 *
 * Scope, stated honestly: this compares MAJORS. A within-major floor (22.22.2)
 * still relies on `actions/setup-node` resolving `"22"` to the latest 22.x,
 * which is far past 22.22.2 — that part is not, and cannot be, asserted here.
 * The failure that actually happened (20 < 22) is fully covered.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FRONTEND = join(__dirname, "..");
const REPO = join(FRONTEND, "..");
const PKG = JSON.parse(readFileSync(join(FRONTEND, "package.json"), "utf8"));

/**
 * The lowest Node version that satisfies a semver range, as [major, minor,
 * patch]. A range is OR-clauses; the floor is the lowest clause's lower bound.
 * `^22.22.2 || ^24.15.0 || >=26.0.0` → 22.22.2.
 */
function floorOf(range: string): [number, number, number] | null {
  let best: [number, number, number] | null = null;
  for (const clause of range.split("||")) {
    const m = clause.trim().match(/^[\^~>=v\s]*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) continue;
    const v: [number, number, number] = [+m[1], +(m[2] ?? 0), +(m[3] ?? 0)];
    if (!best || cmp(v, best) < 0) best = v;
  }
  return best;
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Every installed package's declared `engines.node`, scoped packages included. */
function installedEngineFloors(): { name: string; range: string }[] {
  const root = join(FRONTEND, "node_modules");
  if (!existsSync(root)) return [];
  const out: { name: string; range: string }[] = [];
  const push = (dir: string, name: string) => {
    const p = join(dir, "package.json");
    if (!existsSync(p)) return;
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (typeof j?.engines?.node === "string") out.push({ name, range: j.engines.node });
    } catch {
      /* a malformed manifest in node_modules is not this test's business */
    }
  };
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      for (const sub of readdirSync(join(root, entry))) {
        push(join(root, entry, sub), `${entry}/${sub}`);
      }
    } else {
      push(join(root, entry), entry);
    }
  }
  return out;
}

/** Every `node-version:` pinned across the GitHub workflows. */
function workflowNodeVersions(): { file: string; version: string }[] {
  const dir = join(REPO, ".github", "workflows");
  const out: { file: string; version: string }[] = [];
  for (const f of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const text = readFileSync(join(dir, f), "utf8");
    for (const m of text.matchAll(/node-version:\s*["']?([0-9x.]+)["']?/g)) {
      out.push({ file: f, version: m[1] });
    }
  }
  return out;
}

describe("the declared Node floor", () => {
  it("is declared at all", () => {
    expect(typeof PKG.engines?.node).toBe("string");
  });

  it("is no lower than the strictest floor any installed package requires", () => {
    // Max-of-floors is a sound LOWER bound on the true intersection: if our
    // declared floor sits below it, some installed package definitely cannot run.
    const declared = floorOf(PKG.engines.node);
    expect(declared).not.toBeNull();
    const installed = installedEngineFloors();
    if (installed.length === 0) return; // no node_modules — nothing to compare against
    const tooHigh = installed
      .map((p) => ({ ...p, floor: floorOf(p.range) }))
      .filter((p) => p.floor && cmp(p.floor, declared!) > 0)
      .map((p) => `${p.name} requires ${p.range}`);
    expect(tooHigh).toEqual([]);
  });
});

describe("every workflow that sets up Node", () => {
  it("uses a major at least as new as the declared floor", () => {
    const declared = floorOf(PKG.engines.node)!;
    const sites = workflowNodeVersions();
    // If this ever finds zero sites the regex has drifted and the guard is dead.
    expect(sites.length).toBeGreaterThan(0);
    const stale = sites
      .filter((s) => {
        const v = floorOf(s.version);
        return !v || v[0] < declared[0];
      })
      .map((s) => `${s.file}: node-version ${s.version} < ${declared[0]}`);
    expect(stale).toEqual([]);
  });
});
