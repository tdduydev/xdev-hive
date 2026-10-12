import type { ChecklistItem, ReviewGate, ReviewPhase, SlaState } from "@xdev-hive/contracts";

/** Gate trải phẳng theo thứ tự chạy, kèm giai đoạn chứa nó. */
export interface FlatGate {
  gate: ReviewGate;
  phase: string;
  index: number;
}

export function flatGates(phases: ReviewPhase[]): FlatGate[] {
  const out: FlatGate[] = [];
  for (const p of phases) for (const g of p.gates) out.push({ gate: g, phase: p.name, index: out.length });
  return out;
}

/** Loại tài liệu: đoạn cuối của key, bỏ đuôi file (`project/pay/prd-refund.md` → `prd-refund`). */
export const docTypeOf = (key: string) => (key.split("/").at(-1) ?? key).replace(/\.[a-z0-9]+$/, "");

export function typeMatches(docType: string, types: string[]): boolean {
  return (
    types.length === 0 || types.some((t) => docType === t.toLowerCase() || docType.startsWith(`${t.toLowerCase()}-`))
  );
}

/**
 * Số dòng thêm và xoá theo multiset dòng. Không phải diff đầy đủ (dòng chuyển chỗ không tính), nhưng đủ cho ngưỡng
 * Δ dòng và số liệu ở hàng chờ, và không tốn O(n·m) với tài liệu dài.
 */
export function diffCounts(before: string, after: string): { added: number; deleted: number } {
  const count = new Map<string, number>();
  for (const l of before.split("\n")) count.set(l, (count.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of after.split("\n")) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else added++;
  }
  let deleted = 0;
  for (const n of count.values()) deleted += n;
  return { added, deleted };
}

/** Chỉ sửa khoảng trắng, dấu câu hay ký hiệu Markdown: bỏ hết những thứ đó rồi so. */
export function formattingOnly(before: string, after: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s*_#>`~\-|.,;:!?()[\]"'“”]/g, "");
  return before !== after && norm(before) === norm(after);
}

export interface GateContext {
  docType: string;
  content: string;
  base: string;
}

/** Gate có chạy với đề xuất này không, kèm lý do để hiện ở bản chạy thử và ở phiên duyệt. */
export function gateApplies(gate: ReviewGate, ctx: GateContext): { runs: boolean; reason: string } {
  const c = gate.conditions;
  if (!typeMatches(ctx.docType, c.docTypes))
    return { runs: false, reason: `Loại tài liệu ${ctx.docType} không thuộc ${c.docTypes.join(", ")}.` };
  if (c.keywords.length) {
    const text = ctx.content.toLowerCase();
    const hit = c.keywords.find((k) => text.includes(k.toLowerCase()));
    if (!hit) return { runs: false, reason: `Không nhắc tới ${c.keywords.join(", ")}.` };
  }
  const { added, deleted } = diffCounts(ctx.base, ctx.content);
  if (c.minChangedLines !== null && added + deleted < c.minChangedLines)
    return { runs: false, reason: `Đổi ${added + deleted} dòng, dưới ngưỡng ${c.minChangedLines}.` };
  if (c.skipFormattingOnly && formattingOnly(ctx.base, ctx.content))
    return { runs: false, reason: "Chỉ sửa chính tả, định dạng." };
  return { runs: true, reason: "Đủ điều kiện." };
}

export interface Requirement {
  id: string;
  text: string;
  acceptance: string[];
}

const REQ_LINE = /^\s*(?:[-*+]\s+|#{1,6}\s+|\d+[.)]\s+)?(?:\*\*)?\s*(R-\d+)\b\s*(?:\*\*)?\s*[:.)\-–—]?\s*(.*)$/;
const HEADING = /^\s*#{1,6}\s/;
const ACCEPTANCE = /(tiêu chí|chấp nhận|acceptance|\bAC\b|^\s*[-*]?\s*(given|when|then|cho|khi|thì)\b)/i;

/** Yêu cầu có mã R-n và các dòng tiêu chí chấp nhận nằm trong khối của nó (tới yêu cầu hay tiêu đề kế tiếp). */
export function requirementsOf(content: string): Requirement[] {
  const out: Requirement[] = [];
  let cur: Requirement | null = null;
  for (const line of content.split("\n")) {
    const m = REQ_LINE.exec(line);
    if (m?.[1]) {
      cur = { id: m[1], text: (m[2] ?? "").trim(), acceptance: [] };
      if (!out.some((r) => r.id === cur?.id)) out.push(cur);
      continue;
    }
    if (HEADING.test(line) && !/tiêu chí|acceptance/i.test(line)) {
      cur = null;
      continue;
    }
    if (cur && line.trim() && ACCEPTANCE.test(line)) cur.acceptance.push(line.trim().replace(/^[-*+]\s+/, ""));
  }
  return out;
}

const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "khoá riêng (private key)"],
  [/\bAKIA[0-9A-Z]{16}\b/, "access key AWS"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "token GitHub"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/, "token GitLab"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/, "token Slack"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, "khoá API (sk-…)"],
  [/\b(hive_pat|hwm|hwr)_[A-Za-z0-9_-]{16,}\b/, "token xDev Hive"],
];

/** Kết quả các quy tắc của gate `rule`. */
export function ruleChecklist(gate: ReviewGate, ctx: GateContext): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  for (const rule of gate.rules ?? []) {
    if (rule === "sections") {
      const headings = ctx.content
        .split("\n")
        .filter((l) => HEADING.test(l))
        .map((l) => l.replace(/^\s*#+\s*/, "").toLowerCase());
      for (const s of gate.sections ?? []) {
        const ok = headings.some((h) => h.includes(s.toLowerCase()));
        out.push({ label: `Có mục “${s}”`, passed: ok, note: ok ? null : "Thiếu mục này." });
      }
      if (!gate.sections?.length) out.push({ label: "Có mục bắt buộc", passed: true, note: "Chưa khai mục nào." });
    } else if (rule === "requirements") {
      const reqs = requirementsOf(ctx.content);
      if (!reqs.length) out.push({ label: "Có yêu cầu đánh mã R-n", passed: false, note: "Không thấy R-1, R-2…" });
      for (const r of reqs)
        out.push({
          label: `${r.id} có tiêu chí chấp nhận`,
          passed: r.acceptance.length > 0,
          note: r.acceptance.length ? null : "Thêm tiêu chí chấp nhận cho yêu cầu này.",
        });
    } else if (rule === "no-secrets") {
      const found = SECRETS.filter(([re]) => re.test(ctx.content)).map(([, name]) => name);
      out.push({
        label: "Không có dữ liệu nhạy cảm",
        passed: found.length === 0,
        note: found.length ? `Có ${found.join(", ")}.` : null,
      });
    } else if (rule === "max-diff") {
      const { added, deleted } = diffCounts(ctx.base, ctx.content);
      const max = gate.maxDiffLines ?? 200;
      out.push({
        label: `Thay đổi không quá ${max} dòng`,
        passed: added + deleted <= max,
        note: `Đổi ${added + deleted} dòng.`,
      });
    }
  }
  return out;
}

/** Trạng thái hạn duyệt: sắp hết hạn khi còn dưới 1/4 thời gian và dưới 8 giờ. */
export function slaOf(dueAt: Date | null, startedAt: Date, now = Date.now()): SlaState {
  if (!dueAt) return "none";
  const left = dueAt.getTime() - now;
  if (left < 0) return "overdue";
  const total = dueAt.getTime() - startedAt.getTime();
  return left < Math.min(total / 4, 8 * 3_600_000) ? "due-soon" : "on-time";
}

/** Người duyệt cần có ở gate: 0 là mọi người được chỉ định (không chỉ định ai thì 1). */
export function requiredApprovals(gate: ReviewGate): number {
  const r = gate.reviewers;
  if (!r) return 1;
  if (r.quorum === 0) return Math.max(1, r.users.length);
  return r.quorum;
}
