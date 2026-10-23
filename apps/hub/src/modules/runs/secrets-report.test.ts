import { describe, expect, it } from "vitest";
import { sanitizeSecretsReport, secretsInjectedOf } from "./secrets-report.ts";

describe("sanitizeSecretsReport", () => {
  it("giữ số lượng hợp lệ và mọi khoá không liên quan tới bí mật", () => {
    expect(sanitizeSecretsReport({ commitCount: 1, secretsInjected: 3 })).toEqual({
      commitCount: 1,
      secretsInjected: 3,
    });
  });

  it("bỏ khoá nhắc tới bí mật ngoài số lượng, kể cả khác hoa thường", () => {
    const out = sanitizeSecretsReport({
      commitCount: 1,
      secretsInjected: 1,
      secretNames: ["A"],
      Secrets: { A: "x" },
      injectedSECRET: "x",
    });
    expect(out).toEqual({ commitCount: 1, secretsInjected: 1 });
  });

  it.each([-1, 65, 1.5, "2", null, Number.NaN])("bỏ số lượng không hợp lệ %j", (bad) => {
    expect(sanitizeSecretsReport({ ok: true, secretsInjected: bad })).toEqual({ ok: true });
  });

  it("báo cáo rỗng hay null giữ nguyên", () => {
    expect(sanitizeSecretsReport(null)).toBeNull();
    expect(sanitizeSecretsReport({})).toEqual({});
  });
});

describe("secretsInjectedOf", () => {
  it("đọc số hợp lệ, còn lại là undefined", () => {
    expect(secretsInjectedOf({ secretsInjected: 0 })).toBe(0);
    expect(secretsInjectedOf({ secretsInjected: 64 })).toBe(64);
    expect(secretsInjectedOf({ secretsInjected: 65 })).toBeUndefined();
    expect(secretsInjectedOf(null)).toBeUndefined();
    expect(secretsInjectedOf(undefined)).toBeUndefined();
  });
});
