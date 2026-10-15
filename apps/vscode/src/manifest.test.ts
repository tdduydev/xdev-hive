import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("package.json")) as {
  activationEvents: string[];
  contributes: { commands: { command: string }[] };
};
const vi = JSON.parse(read("package.nls.json")) as Record<string, string>;
const en = JSON.parse(read("package.nls.en.json")) as Record<string, string>;

describe("manifest", () => {
  it("mọi %khoá% có trong cả hai file nls", () => {
    const keys = [...new Set([...read("package.json").matchAll(/"%([^%"]+)%"/g)].flatMap((m) => m[1] ?? []))];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => !(k in vi))).toEqual([]);
    expect(keys.filter((k) => !(k in en))).toEqual([]);
  });

  it("nls không thừa khoá", () => {
    const used = new Set([...read("package.json").matchAll(/%([^%"]+)%/g)].flatMap((m) => m[1] ?? []));
    expect(Object.keys(vi).filter((k) => !used.has(k))).toEqual([]);
  });

  it("không kích hoạt bằng `*`", () => {
    expect(manifest.activationEvents).not.toContain("*");
  });

  it("lệnh không trùng", () => {
    const ids = manifest.contributes.commands.map((c) => c.command);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
