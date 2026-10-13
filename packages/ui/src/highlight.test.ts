import { describe, expect, it } from "vitest";
import { highlightLines, languageLabel, resolveLanguage } from "./highlight.ts";

describe("highlight", () => {
  it("resolves aliases and ignores unknown languages instead of guessing", () => {
    expect(resolveLanguage("TS")).toBe("typescript");
    expect(resolveLanguage("sh")).toBe("bash");
    expect(resolveLanguage("html")).toBe("xml");
    expect(resolveLanguage("toml")).toBe("ini");
    expect(resolveLanguage("klingon")).toBeNull();
    expect(resolveLanguage("")).toBeNull();
    expect(resolveLanguage(null)).toBeNull();
  });

  it("labels languages for the code block header", () => {
    expect(languageLabel("ts")).toBe("TypeScript");
    expect(languageLabel("mermaid")).toBe("Mermaid");
    expect(languageLabel("klingon")).toBe("klingon");
    expect(languageLabel(undefined)).toBe("");
  });

  it("marks keywords and strings with hljs classes", () => {
    const [line] = highlightLines('const name = "hive";', "ts");
    const classes = Object.fromEntries((line ?? []).filter((s) => s.className).map((s) => [s.text, s.className]));
    expect(classes.const).toBe("hljs-keyword");
    expect(classes['"hive"']).toBe("hljs-string");
  });

  it("keeps the class of a multi-line token on every line it crosses", () => {
    const lines = highlightLines("/* a\n b */\nlet x", "js");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.[0]?.className).toBe("hljs-comment");
    expect(lines[1]?.[0]?.className).toBe("hljs-comment");
  });

  it("returns plain lines when no language is given", () => {
    const lines = highlightLines("a\n\nb", null);
    expect(lines.map((l) => l.map((s) => s.text).join(""))).toEqual(["a", "", "b"]);
    expect(lines.flat().every((s) => s.className === undefined)).toBe(true);
  });
});
