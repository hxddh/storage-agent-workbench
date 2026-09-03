import { describe, expect, it } from "vitest";
import { highlight, normalizeLang } from "./highlight";

describe("config-language highlighting (v1.14)", () => {
  it("resolves yaml/toml/ini aliases", () => {
    expect(normalizeLang("yaml")).toBe("yaml");
    expect(normalizeLang("YML")).toBe("yaml");
    expect(normalizeLang("toml")).toBe("toml");
    expect(normalizeLang("ini")).toBe("ini");
    expect(normalizeLang("python")).toBeNull();
  });

  it("marks yaml keys, strings and comments", () => {
    const toks = highlight("server:\n  host: localhost # main\n  port: 9000", "yaml");
    expect(toks).not.toBeNull();
    const byClass = (c: string) => (toks ?? []).filter((t) => t.c === c).map((t) => t.text);
    expect(byClass("name")).toContain("server");
    expect(byClass("com")).toContain("# main");
    expect(byClass("num")).toContain("9000");
  });

  it("marks toml sections and ini keys", () => {
    const toml = highlight("[server]\nhost = \"localhost\"", "toml");
    expect(toml?.some((t) => t.c === "name" && t.text === "[server]")).toBe(true);
    const ini = highlight("[paths]\ndata = /var/lib", "ini");
    expect(ini?.some((t) => t.c === "name" && t.text === "data")).toBe(true);
  });
});
