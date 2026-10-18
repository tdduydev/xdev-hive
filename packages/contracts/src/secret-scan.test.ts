import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { redactSecrets, SECRET_KINDS, SECRET_MASK, type SecretFinding, scanSecrets } from "./secret-scan.ts";

interface Sample {
  name: string;
  text: string | string[];
  findings?: SecretFinding[];
}

// Cùng file mẫu với test Go (worker/internal/runner/secret_fixture_test.go) để hub và worker bắt cùng một bộ mẫu.
const fixtures = JSON.parse(await readFile(new URL("../fixtures/secret-scan.json", import.meta.url), "utf8")) as {
  positive: Sample[];
  negative: Sample[];
};
const textOf = (s: Sample) => (Array.isArray(s.text) ? s.text.join("") : s.text);

describe("scanSecrets", () => {
  it.each(fixtures.positive)("bắt: $name", (sample) => {
    expect(scanSecrets(textOf(sample))).toEqual(sample.findings);
  });

  it.each(fixtures.negative)("bỏ qua: $name", (sample) => {
    expect(scanSecrets(textOf(sample))).toEqual([]);
  });

  it("có ít nhất 15 mẫu dương và đủ mọi loại", () => {
    expect(fixtures.positive.length).toBeGreaterThanOrEqual(15);
    const kinds = new Set(fixtures.positive.flatMap((s) => s.findings?.map((f) => f.kind) ?? []));
    expect([...kinds].sort()).toEqual([...SECRET_KINDS].sort());
  });

  it("chỉ trả dòng và loại, không trả chuỗi bí mật", () => {
    for (const sample of fixtures.positive) {
      for (const finding of scanSecrets(textOf(sample))) expect(Object.keys(finding).sort()).toEqual(["kind", "line"]);
    }
  });

  it("đếm dòng đúng với xuống dòng CRLF", () => {
    expect(scanSecrets("a=1\r\nb=2\r\nDB_PASSWORD=S3cr3t-Hive!2026\r\n")).toEqual([
      { line: 3, kind: "credential_assignment" },
    ]);
  });

  it("quét văn bản lớn không có bí mật trong thời gian ngắn", () => {
    const line = "const value = computeSomething(input, 42); // ghi chú bình thường không có gì đặc biệt\n";
    const text = line.repeat(20_000) + "x".repeat(500_000);
    const started = performance.now();
    expect(scanSecrets(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("redactSecrets", () => {
  it.each(fixtures.positive)("che mọi chuỗi bắt được: $name", (sample) => {
    const masked = redactSecrets(textOf(sample));
    expect(scanSecrets(masked)).toEqual([]);
    expect(masked).toContain(SECRET_MASK);
  });

  it.each(fixtures.negative)("giữ nguyên chữ không phải bí mật: $name", (sample) => {
    expect(redactSecrets(textOf(sample))).toBe(textOf(sample));
  });

  it("chỉ che giá trị, giữ tên biến và chữ xung quanh", () => {
    const pat = `hive_pat_${"a1".repeat(12)}`;
    expect(redactSecrets(`curl -H "Authorization: Bearer ${pat}" x`)).toBe(
      `curl -H "Authorization: Bearer ${SECRET_MASK}" x`,
    );
    expect(redactSecrets("DB_PASSWORD=hunter2abc9\nPORT=5432")).toBe(`DB_PASSWORD=${SECRET_MASK}\nPORT=5432`);
  });
});
