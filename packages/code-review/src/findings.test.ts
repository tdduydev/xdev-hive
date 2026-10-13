import { describe, expect, it } from "vitest";
import { anchorFindings, collectFindings } from "./findings.ts";
import { parsePatch } from "./patch.ts";
import { aiGate, patch } from "./test-fixtures.ts";

describe("collectFindings", () => {
  it("gom phát hiện của mọi reviewer kèm tên CLI", () => {
    const all = collectFindings([aiGate]);
    expect(all).toHaveLength(2);
    expect(all.every((f) => f.by === "claude")).toBe(true);
  });
});

describe("anchorFindings", () => {
  const lines = parsePatch(patch);
  const f = (line: number | null) => ({
    file: "src/refund.ts",
    line,
    severity: "major" as const,
    message: "m",
    by: "claude",
  });

  it("gắn theo dòng mới của patch", () => {
    const { byIndex, loose } = anchorFindings(lines, [f(11)]);
    const at = lines.findIndex((l) => l.kind === "add" && l.newNo === 11);
    expect(byIndex.get(at)).toHaveLength(1);
    expect(loose).toEqual([]);
  });

  it("dòng ngoài hunk hoặc không có dòng thì vào loose, không mất", () => {
    const { byIndex, loose } = anchorFindings(lines, [f(500), f(null)]);
    expect(byIndex.size).toBe(0);
    expect(loose).toHaveLength(2);
  });
});
