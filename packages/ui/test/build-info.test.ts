import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildText, formatBuildDate } from "#ui/lib/build-info.ts";
import { translate } from "#ui/i18n/translate.ts";

/** ICU versions differ in the space before AM (U+202F or a plain one). */
const plain = (s: string | null) => s?.replace(/\s/g, " ") ?? null;
const t = (key: Parameters<typeof translate>[0], vars?: Record<string, string>) => translate(key, vars);

describe("the hub's build in words", () => {
  it("formats the build date in the reader's locale", () => {
    const iso = "2026-10-10T08:30:00.000Z";
    assert.equal(plain(formatBuildDate(iso, "en-US", { timeZone: "UTC" })), "Oct 10, 2026, 8:30 AM");
    assert.equal(formatBuildDate(iso, "en-US", { short: true, timeZone: "UTC" }), "Oct 10, 2026");
    assert.notEqual(formatBuildDate(iso, "vi-VN", { timeZone: "UTC" }), formatBuildDate(iso, "en-US", { timeZone: "UTC" }));
    assert.equal(formatBuildDate(null, "en-US"), null);
    assert.equal(formatBuildDate("not a date", "en-US"), null);
  });

  it("shows the image's version and date", () => {
    const b = buildText({ version: "0.158.0", commit: "6dc8d24", buildVersion: "0.158.0+6dc8d24", buildDate: "2026-10-10T08:30:00.000Z" }, "en-US", t, "UTC");
    assert.equal(b.label, "0.158.0+6dc8d24 · Oct 10, 2026");
    assert.equal(plain(b.date), "Oct 10, 2026, 8:30 AM");
    assert.ok(b.tip.includes("0.158.0+6dc8d24") && b.tip.includes("6dc8d24") && b.tip.includes(b.date));
  });

  it("marks an image built without the args as a dev build with no date", () => {
    const b = buildText({ version: "0.158.0", commit: null, buildVersion: null, buildDate: null }, "en-US", t);
    assert.equal(b.label, `0.158.0 (${t("build.dev")})`);
    assert.equal(b.date, t("build.unknownDate"));
    const withCommit = buildText({ version: "0.158.0", commit: "6dc8d24b9e", buildVersion: null, buildDate: null }, "en-US", t);
    assert.equal(withCommit.label, `0.158.0+6dc8d24 (${t("build.dev")})`);
  });
});
