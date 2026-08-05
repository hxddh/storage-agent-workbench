/**
 * A dependency-free syntax highlighter for the four languages this product
 * actually emits in code blocks.
 *
 * Why not a library: the app runs under a CSP that blocks external resources, so
 * a CDN theme is impossible, and bundling highlight.js/shiki would add hundreds
 * of KiB to a desktop binary in order to colour bucket policies. The blocks the
 * agent produces are overwhelmingly:
 *
 *   - `json`  — bucket policies, lifecycle rules, tool results, inventory rows
 *   - `xml`   — S3 error bodies, lifecycle/CORS/replication configuration
 *   - `bash`  — `aws s3api ...` / `curl` reproduction commands
 *   - `sql`   — the analysis SQL recorded in the audit log
 *
 * Anything else falls through to `null` and renders as plain text, which is what
 * happened to every block before this existed. Highlighting is a reading aid,
 * never a claim about correctness — no language is *parsed*, only tokenized.
 */

/** Palette slots, not grammar categories. Each maps to one themed CSS variable.
 *
 * `num` doubles as the "literal" slot (numbers, and shell flags, which read the
 * same way in a command line). `name` is the identifier slot (JSON keys, XML
 * attributes, shell command names). */
export type TokClass = "plain" | "str" | "num" | "kw" | "com" | "name" | "tag" | "punct";

export type Tok = { text: string; c: TokClass };

type Rule = { re: RegExp; c: TokClass };

/** Blocks longer than this are left alone: a 200 KiB inventory dump is not
 * something anyone reads token by token, and tokenizing it on every re-render
 * during a stream would be felt. */
const MAX_HIGHLIGHT_CHARS = 20_000;

const ALIASES: Record<string, string> = {
  json: "json",
  jsonc: "json",
  json5: "json",
  policy: "json",
  xml: "xml",
  html: "xml",
  svg: "xml",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  shellsession: "bash",
  "shell-session": "bash",
  sql: "sql",
  duckdb: "sql",
};

export function normalizeLang(lang: string): string | null {
  const key = (lang || "").trim().toLowerCase().split(/[\s:]/)[0];
  return ALIASES[key] ?? null;
}

/**
 * Scan left to right; at each position the first rule that matches AT that
 * position wins. Every rule is sticky (`y`), so a rule can never match further
 * down the string and silently swallow the text in between. Unmatched
 * characters accumulate into one plain run.
 */
function scan(code: string, rules: Rule[]): Tok[] {
  const out: Tok[] = [];
  let plain = "";
  let i = 0;
  const flush = () => {
    if (plain) {
      out.push({ text: plain, c: "plain" });
      plain = "";
    }
  };
  while (i < code.length) {
    let hit: Tok | null = null;
    for (const r of rules) {
      r.re.lastIndex = i;
      const m = r.re.exec(code);
      if (m && m[0].length > 0) {
        hit = { text: m[0], c: r.c };
        break;
      }
    }
    if (hit) {
      flush();
      out.push(hit);
      i += hit.text.length;
    } else {
      plain += code[i];
      i++;
    }
  }
  flush();
  return out;
}

const JSON_RULES: Rule[] = [
  // A key is a string that a colon follows — the one distinction that makes a
  // policy document skimmable.
  { re: /"(?:[^"\\]|\\.)*"(?=\s*:)/y, c: "name" },
  { re: /"(?:[^"\\]|\\.)*"/y, c: "str" },
  { re: /\b(?:true|false|null)\b/y, c: "kw" },
  { re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, c: "num" },
  { re: /[{}[\],:]/y, c: "punct" },
];

const XML_RULES: Rule[] = [
  { re: /<!--[\s\S]*?-->/y, c: "com" },
  { re: /<!\[CDATA\[[\s\S]*?\]\]>/y, c: "com" },
  { re: /<![A-Za-z][^>]*>/y, c: "com" },
  { re: /<\?[\s\S]*?\?>/y, c: "com" },
  { re: /<\/?[A-Za-z_][\w.:-]*/y, c: "tag" },
  { re: /[A-Za-z_][\w.:-]*(?=\s*=)/y, c: "name" },
  { re: /"[^"]*"|'[^']*'/y, c: "str" },
  { re: /&[a-zA-Z#0-9]+;/y, c: "num" },
  { re: /\/?>|=/y, c: "punct" },
];

const SQL_KEYWORDS =
  "select|from|where|group|by|order|having|limit|offset|join|left|right|inner|outer|full|on|as|and|or|not|in|is|null|like|between|case|when|then|else|end|with|union|all|distinct|insert|into|values|update|set|delete|create|table|view|drop|alter|asc|desc|count|sum|avg|min|max|cast|coalesce|over|partition|window|using|exists";

const SQL_RULES: Rule[] = [
  { re: /--[^\n]*|\/\*[\s\S]*?\*\//y, c: "com" },
  { re: /'(?:[^']|'')*'/y, c: "str" },
  { re: /"[^"]*"/y, c: "name" },
  { re: new RegExp(`(?:${SQL_KEYWORDS})\\b`, "iy"), c: "kw" },
  { re: /\d+(?:\.\d+)?/y, c: "num" },
  { re: /[A-Za-z_]\w*/y, c: "plain" },
  { re: /[(),.;*=<>+\-|]/y, c: "punct" },
];

const BASH_KEYWORDS = /(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|return|export|local|set|source|in)\b/y;

const BASH_RULES: Rule[] = [
  { re: /#[^\n]*/y, c: "com" },
  { re: /"(?:[^"\\]|\\.)*"|'[^']*'/y, c: "str" },
  // `$VAR`, `${VAR}`, `$1` — the part of a pasted command a reader must replace.
  { re: /\$\{[^}]*\}|\$[A-Za-z_]\w*|\$\d/y, c: "tag" },
  { re: BASH_KEYWORDS, c: "kw" },
  // Flags share the literal slot; they scan like values, not like identifiers.
  { re: /--?[A-Za-z][\w-]*/y, c: "num" },
  { re: /\d+(?:\.\d+)?/y, c: "num" },
  { re: /[A-Za-z_][\w./-]*/y, c: "plain" },
  { re: /[|&;<>()[\]{}=]/y, c: "punct" },
];

/** Shell keywords that hand the command position to whatever follows them. */
const OPENS_COMMAND = new Set(["then", "else", "do", "elif", "in"]);

/**
 * Promote the first word of each command to the identifier slot.
 *
 * `aws`, `curl`, `mc` are not keywords in any list — they are whatever the user
 * has installed — so the only honest way to find them is positional: the first
 * word of a line, or of a pipeline/`;`/`&&` segment.
 */
function markCommands(toks: Tok[]): Tok[] {
  let atCommand = true;
  for (const tok of toks) {
    if (tok.c === "com") continue;
    if (tok.c === "plain") {
      if (tok.text.trim() === "") {
        // Whitespace does not consume the command position, but a newline
        // starts a fresh one.
        if (tok.text.includes("\n")) atCommand = true;
        continue;
      }
      if (atCommand && /^[A-Za-z_]/.test(tok.text)) tok.c = "name";
      atCommand = false;
      continue;
    }
    if (tok.c === "punct") {
      atCommand = /[|&;([]/.test(tok.text);
      continue;
    }
    if (tok.c === "kw") {
      atCommand = OPENS_COMMAND.has(tok.text);
      continue;
    }
    atCommand = false;
  }
  return toks;
}

/**
 * Tokenize `code` for `lang`. Returns `null` when the language is unknown or the
 * block is too large — callers render plain text in that case.
 */
export function highlight(code: string, lang: string): Tok[] | null {
  const kind = normalizeLang(lang);
  if (!kind || code.length > MAX_HIGHLIGHT_CHARS) return null;
  switch (kind) {
    case "json":
      return scan(code, JSON_RULES);
    case "xml":
      return scan(code, XML_RULES);
    case "sql":
      return scan(code, SQL_RULES);
    case "bash":
      return markCommands(scan(code, BASH_RULES));
    default:
      return null;
  }
}

/** Tailwind classes per slot. Every one resolves to a themed CSS variable, so a
 * highlighted block is legible on both grounds (guarded by a contrast test). */
export const TOK_CLASS: Record<TokClass, string> = {
  plain: "",
  str: "text-syn-str",
  num: "text-syn-num",
  kw: "text-syn-kw",
  com: "text-syn-com",
  name: "text-syn-name",
  tag: "text-syn-tag",
  punct: "text-syn-punct",
};
