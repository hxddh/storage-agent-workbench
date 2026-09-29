/**
 * The v6 window contract, executable. If an intentional replacement is
 * needed, change the code, this file and the canonical docs together.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname);
const ROOT = path.resolve(SRC, "..", "..");

function files(dir: string, ext: RegExp): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "test" ? [] : files(p, ext);
    return ext.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const source = files(SRC, /\.(ts|tsx)$/);
const read = (p: string) => fs.readFileSync(p, "utf8");
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");

describe("one submit path", () => {
  it("only the API module talks to the Sidecar", () => {
    const fetchers = source.filter((p) => /\bfetch\(|new EventSource\(/.test(read(p))).map(rel).sort();
    expect(fetchers).toEqual(["api/client.ts", "api/index.ts", "store/task.ts", "store/tasks.ts"]);
    // The stores only follow streams; they never submit.
    for (const p of ["store/task.ts", "store/tasks.ts"]) expect(read(path.join(SRC, p))).not.toMatch(/\bfetch\(/);
  });

  it("work is submitted through /tasks and nowhere else", () => {
    const api = read(path.join(SRC, "api/index.ts"));
    expect(api).toMatch(/`\/tasks\/\$\{id\}\/turns`/);
    for (const retired of ["/sessions", "/runs", "/agent-tasks", "/executions", "decisions", "approval"]) {
      expect(api).not.toContain(retired);
    }
  });
});

describe("the window", () => {
  it("is sidebar · title bar · one document · one Composer, plus the side pane", () => {
    const shell = read(path.join(SRC, "shell/Shell.tsx"));
    for (const part of ["<Sidebar", 'className="titlebar"', 'className="document"', "<Composer", "<Inspector"]) {
      expect(shell).toContain(part);
    }
    // One Composer on a task page; the home renders its own (the only start surface).
    expect(shell.match(/<Composer\b/g)).toHaveLength(1);
    expect(read(path.join(SRC, "home/Home.tsx")).match(/<Composer\b/g)).toHaveLength(1);
  });

  it("starters and next steps only fill the Composer — they never submit", () => {
    const home = read(path.join(SRC, "home/Home.tsx"));
    const result = read(path.join(SRC, "task/Result.tsx"));
    expect(home).toMatch(/onClick=\{\(\) => app\.prefill\(/);
    expect(result).toMatch(/onClick=\{\(\) => app\.prefill\(s\)\}/);
    for (const text of [home, result]) expect(text).not.toMatch(/api\.(submit|createTask|steer)\(/);
  });

  it("the estate never submits work and never writes to storage", () => {
    // v6: the estate is a primary surface, but work still starts only in the Composer.
    const estate = source.filter((p) => rel(p).startsWith("estate/"));
    expect(estate.map(rel).sort()).toEqual(["estate/EstatePage.tsx", "estate/IssueCard.tsx", "estate/Notes.tsx"]);
    for (const p of estate) expect(read(p)).not.toMatch(/api\.(submit|createTask|steer|resume)\(/);
    // Ask about this bucket only fills the Composer.
    expect(read(path.join(SRC, "estate/EstatePage.tsx"))).toContain("app.prefill(");
  });

  it("paints no approval, plan or chat-era chrome", () => {
    const all = source.map(read).join("\n");
    for (const banned of ["Waiting for approval", "update_plan", "New chat", "thread.", "ApprovalCard", "PlanCard"]) {
      expect(all).not.toContain(banned);
    }
  });

  it("guesses nothing: the conclusion comes only from the recorded item", () => {
    const derive = read(path.join(SRC, "store/derive.ts"));
    expect(derive).toMatch(/case "conclusion":\s*\n\s*conclusion = it\.payload;/);
    expect(derive).not.toMatch(/split\(".\s*"\)/);
  });
});

describe("the design system", () => {
  it("no component carries a raw colour", () => {
    const offenders = source.filter((p) => p.endsWith(".tsx"))
      // A token's own fallback (`var(--canvas, #0f0f0f)`, the last-resort error screen) is not a raw colour.
      .filter((p) => /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(read(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace(/var\([^)]*\)/g, "")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("styles use tokens, not raw colours (outside the token sheet)", () => {
    const sheets = files(path.join(SRC, "styles"), /\.css$/);
    for (const sheet of sheets) {
      const css = read(sheet).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css, rel(sheet)).not.toMatch(/(?<![-\w])#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it("honours reduced motion", () => {
    expect(read(path.join(SRC, "styles/app.css"))).toContain("prefers-reduced-motion: reduce");
  });
});

describe("copy", () => {
  const dict = read(path.join(SRC, "i18n.tsx"));
  const block = (name: string) => {
    const start = dict.indexOf(`const ${name}: Dict = {`);
    const end = dict.indexOf("\n};", start);
    return new Set([...dict.slice(start, end).matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
  };
  const en = block("en");
  const zh = block("zh");

  it("English and Chinese carry the same keys", () => {
    expect([...en].filter((k) => !zh.has(k))).toEqual([]);
    expect([...zh].filter((k) => !en.has(k))).toEqual([]);
  });

  it("every literal key the window asks for exists", () => {
    const used = new Set<string>();
    for (const p of source) for (const m of read(p).matchAll(/\bt\("([a-zA-Z0-9_.]+)"/g)) used.add(m[1]);
    const missing = [...used].filter((k) => !en.has(k));
    expect(missing).toEqual([]);
  });
});

describe("the native shell", () => {
  it("declares every menu command the Rust menu bar sends", () => {
    const rust = fs.readFileSync(path.join(ROOT, "src-tauri/src/lib.rs"), "utf8");
    const ids = [...rust.slice(rust.indexOf("const MENU_COMMANDS"), rust.indexOf("];", rust.indexOf("const MENU_COMMANDS")))
      .matchAll(/\("([a-z-]+)",/g)].map((m) => m[1]);
    const native = read(path.join(SRC, "hooks/useNativeAgent.ts"));
    expect(ids.length).toBeGreaterThan(8);
    for (const id of ids) expect(native).toContain(`"${id}"`);
  });

  it("Quick Ask is a second window of the same app, on the same submit path", () => {
    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
    const quick = conf.app.windows.find((w: { label?: string }) => w.label === "quick");
    expect(quick.url).toBe("index.html?view=quick");
    expect(quick.visible).toBe(false);
    expect(read(path.join(SRC, "quick/QuickAsk.tsx"))).toContain('api.createTask(q, "quick_ask")');
  });
});
