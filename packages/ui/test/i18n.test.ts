import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isValidElement } from "react";
import { LEVELS } from "@xdev-hive/core";
import { rich } from "../src/i18n/rich.ts";
import { hasKey, LOCALES, translate, type MessageKey } from "../src/i18n/translate.ts";

/** Every leaf path of a catalogue, plural forms counted as one leaf. */
function leaves(node: unknown, prefix = ""): string[] {
  if (typeof node === "string" || (typeof node === "object" && node !== null && "other" in node)) return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

describe("i18n", () => {
  it("translates every key in every language, with the same placeholders", () => {
    const source = leaves(LOCALES.vi.messages).sort();
    for (const [code, locale] of Object.entries(LOCALES)) {
      assert.deepEqual(leaves(locale.messages).sort(), source, `${code} has the same keys as vi`);
      for (const key of source as MessageKey[]) {
        const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        const want = vars(translate(key, undefined, "vi"));
        assert.deepEqual(vars(translate(key, undefined, code as keyof typeof LOCALES)), want, `${code} ${key}`);
      }
    }
  });

  it("fills placeholders and picks plural forms per language", () => {
    assert.equal(translate("password.tooShort", { min: 10 }, "vi"), "Mật khẩu mới cần ít nhất 10 ký tự.");
    assert.equal(translate("password.tooShort", { min: 10 }, "en"), "The new password needs at least 10 characters.");
    assert.equal(translate("diff.gap", { count: 1 }, "en"), "… 1 unchanged line");
    assert.equal(translate("diff.gap", { count: 4 }, "en"), "… 4 unchanged lines");
    assert.equal(translate("diff.gap", { count: 4 }, "vi"), "… 4 dòng không đổi");
  });

  it("puts nodes into a sentence and leaves unknown placeholders", () => {
    const parts = rich("Đổi {field} trong {file}, không phải {other}.", { field: "machine", file: "config.json" });
    assert.deepEqual(
      parts.map((p) => (isValidElement(p) ? `<${(p.props as { children: string }).children}>` : p)),
      ["Đổi ", "<machine>", " trong ", "<config.json>", ", không phải ", "{other}", "."],
    );
  });

  it("has every error key the hub, core and desktop send", () => {
    const repo = path.resolve(import.meta.dirname, "../../..");
    const files = ["packages/core/src", "apps/web/src", "apps/desktop/src/main"].flatMap((dir) =>
      readdirSync(path.join(repo, dir), { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".ts"))
        .map((f) => path.join(repo, dir, f)),
    );
    const keys = new Set(files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/key: "(errors\.[\w.]+)"/g)].map((m) => m[1]!)));
    // Built from the level: errors.need.<level>, errors.needShared.<level>.
    for (const level of LEVELS) keys.add(`errors.need.${level}`).add(`errors.needShared.${level}`);
    assert.ok(keys.size > 30, `found ${keys.size} keys`);
    assert.deepEqual([...keys].filter((k) => !hasKey(k)), []);
  });

  it("falls back to the key when a string is missing", () => {
    assert.equal(translate("nope.missing" as MessageKey), "nope.missing");
  });
});
