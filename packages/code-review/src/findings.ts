import type { CodeGateRun, CodeReviewFinding } from "@xdev-hive/contracts";
import type { PatchLine } from "./patch.ts";

/** Phát hiện kèm reviewer đã nêu (tên CLI), để người duyệt biết ai nói gì khi nó hiện trong diff. */
export type DiffFinding = CodeReviewFinding & { by: string };

export function collectFindings(gates: CodeGateRun[]): DiffFinding[] {
  return gates.flatMap((g) => g.reviewers.flatMap((r) => r.findings.map((f) => ({ ...f, by: r.cli }))));
}

/**
 * Gắn phát hiện vào dòng mới của patch. Dòng không nằm trong hunk nào (AI trỏ vào dòng không đổi) hoặc không có số
 * dòng thì vẫn phải hiện, nên trả về `loose` thay vì bỏ.
 */
export function anchorFindings(lines: PatchLine[], findings: DiffFinding[]) {
  const byIndex = new Map<number, DiffFinding[]>();
  const loose: DiffFinding[] = [];
  const indexOfNewLine = new Map<number, number>();
  lines.forEach((l, i) => {
    if (l.kind !== "hunk" && l.newNo !== null) indexOfNewLine.set(l.newNo, i);
  });
  for (const f of findings) {
    const at = f.line === null ? undefined : indexOfNewLine.get(f.line);
    if (at === undefined) {
      loose.push(f);
      continue;
    }
    byIndex.set(at, [...(byIndex.get(at) ?? []), f]);
  }
  return { byIndex, loose };
}

const SEVERITY_ORDER = ["critical", "major", "minor", "info"] as const;

export const bySeverity = (a: DiffFinding, b: DiffFinding) =>
  SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
