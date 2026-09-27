import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LOCALES, translate, type MessageKey } from "../src/i18n/translate.ts";

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

  it("falls back to the key when a string is missing", () => {
    assert.equal(translate("nope.missing" as MessageKey), "nope.missing");
  });
});
