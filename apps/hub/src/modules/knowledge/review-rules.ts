import {
  type BreakdownContext,
  type ChecklistItem,
  coverage,
  parseBreakdown,
  parseTestCaseTable,
  type ReviewGate,
  type ReviewPhase,
  reviewGate,
  type SdlcDecomposition,
  type SlaState,
} from "@xdev-hive/contracts";

/** Gate trải phẳng theo thứ tự chạy, kèm giai đoạn chứa nó. */
export interface FlatGate {
  gate: ReviewGate;
  phase: string;
  index: number;
}

/**
 * Cấu hình gate lưu dạng JSON từ lúc tạo quy trình hay phiên duyệt: parse lại để trường thêm sau (vd. `reviewers.teams`)
 * có giá trị mặc định thay vì undefined ở dòng cũ.
 */
export function flatGates(phases: ReviewPhase[]): FlatGate[] {
  const out: FlatGate[] = [];
  for (const p of phases)
    for (const g of p.gates) {
      const parsed = reviewGate.safeParse(g);
      out.push({ gate: parsed.success ? parsed.data : g, phase: p.name, index: out.length });
    }
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

/** Cách đọc bản tách và requirement của hạng mục AI SDLC; chỉ `sdlc` biết, nên deps của `knowledge` đưa vào. */
export interface BreakdownRuleInput {
  decomposition: Pick<SdlcDecomposition, "parser" | "granularity" | "requirementId" | "maxTasks" | "maxChecklist">;
  context: BreakdownContext;
  /** Requirement đã đọc từ tài liệu yêu cầu, theo thứ tự xuất hiện. */
  requirements: readonly string[];
}

export interface GateContext {
  docType: string;
  content: string;
  base: string;
  /** Số câu hỏi mở của hạng mục (bảng của `sdlc`); không có khi tài liệu không thuộc hạng mục. */
  openQuestions?: number | undefined;
  breakdown?: BreakdownRuleInput | undefined;
  qaChecks?: { code: string; passed: boolean; note: string }[] | undefined;
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

/** Mã requirement mặc định của tài liệu thường; chế độ AI SDLC đưa mẫu riêng (`FR-\d{3}` của Spec Kit…). */
export const DEFAULT_REQUIREMENT_ID = "R-\\d+";

// Tên nhóm để mẫu của người dùng có nhóm riêng vẫn không làm lệch số nhóm.
const reqLine = (id: string) =>
  new RegExp(
    `^\\s*(?:[-*+]\\s+|#{1,6}\\s+|\\d+[.)]\\s+)?(?:\\*\\*)?\\s*(?<id>${id})\\b\\s*(?:\\*\\*)?\\s*[:.)\\-–—]?\\s*(?<text>.*)$`,
  );
const REQ_LINES = new Map<string, RegExp>([[DEFAULT_REQUIREMENT_ID, reqLine(DEFAULT_REQUIREMENT_ID)]]);
const HEADING = /^\s*#{1,6}\s/;
const ACCEPTANCE = /(tiêu chí|chấp nhận|acceptance|\bAC\b|^\s*[-*]?\s*(given|when|then|cho|khi|thì)\b)/i;

/**
 * Yêu cầu có mã (mặc định R-n, hoặc mẫu `idPattern` của chế độ) và các dòng tiêu chí chấp nhận nằm trong khối của nó
 * (tới yêu cầu hay tiêu đề kế tiếp).
 */
export function requirementsOf(content: string, idPattern?: string | RegExp): Requirement[] {
  const source =
    idPattern === undefined ? DEFAULT_REQUIREMENT_ID : typeof idPattern === "string" ? idPattern : idPattern.source;
  let re = REQ_LINES.get(source);
  if (!re) {
    re = reqLine(source);
    REQ_LINES.set(source, re);
  }
  const out: Requirement[] = [];
  let cur: Requirement | null = null;
  for (const line of content.split("\n")) {
    const m = re.exec(line);
    if (m?.groups?.id) {
      cur = { id: m.groups.id, text: (m.groups.text ?? "").trim(), acceptance: [] };
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

const OPEN_MARKER = /\[NEEDS CLARIFICATION/gi;
const NOT_IN_ITEM = "Tài liệu không thuộc hạng mục AI SDLC nên không kiểm được.";

/** Dấu `[NEEDS CLARIFICATION` còn trong văn bản và câu hỏi mở đã ghi ở hạng mục (do người dùng trả lời trước khi duyệt). */
function openQuestionChecks(ctx: GateContext): ChecklistItem[] {
  const lines = ctx.content.split("\n").flatMap((l, i) => (l.match(OPEN_MARKER) ? [i + 1] : []));
  const out: ChecklistItem[] = [
    {
      label: "Không còn dấu [NEEDS CLARIFICATION]",
      passed: lines.length === 0,
      note: lines.length ? `Còn ở dòng ${lines.slice(0, 8).join(", ")}${lines.length > 8 ? "…" : ""}.` : null,
    },
  ];
  if (ctx.openQuestions !== undefined)
    out.push({
      label: "Không còn câu hỏi mở của hạng mục",
      passed: ctx.openQuestions === 0,
      note: ctx.openQuestions ? `Còn ${ctx.openQuestions} câu hỏi chưa trả lời.` : null,
    });
  return out;
}

/** Bộ đọc của contracts ném lỗi khi chưa cài (khung của spec 011 T003): báo là không đạt thay vì làm hỏng phiên duyệt. */
function readBreakdown(ctx: GateContext) {
  const b = ctx.breakdown;
  if (!b) return null;
  try {
    return parseBreakdown(ctx.content, b.decomposition, b.context);
  } catch (e) {
    return {
      ok: false as const,
      breakdown: null,
      errors: [{ line: 0, message: e instanceof Error ? e.message : String(e) }],
    };
  }
}

const errorNote = (errors: { message: string }[]) =>
  `${errors
    .slice(0, 5)
    .map((e) => e.message)
    .join(" ")}${errors.length > 5 ? ` (và ${errors.length - 5} lỗi khác)` : ""}`;

/** Bản tách đọc được: task có phụ thuộc hợp lệ, không vượt giới hạn của chế độ. */
function breakdownChecks(ctx: GateContext): ChecklistItem[] {
  const res = readBreakdown(ctx);
  if (!res) return [{ label: "Bản tách task đọc được", passed: false, note: NOT_IN_ITEM }];
  if (!res.ok) return [{ label: "Bản tách task đọc được", passed: false, note: errorNote(res.errors) }];
  return [
    { label: "Bản tách task đọc được", passed: true, note: null },
    {
      label: "Có ít nhất một task",
      passed: res.breakdown.tasks.length > 0,
      note: res.breakdown.tasks.length ? null : "Chưa có task nào.",
    },
  ];
}

/** Mọi requirement của tài liệu yêu cầu có ít nhất một task chứa nó. */
function coverageChecks(ctx: GateContext): ChecklistItem[] {
  const label = "Mọi requirement đều có task";
  const res = readBreakdown(ctx);
  if (!res || !ctx.breakdown) return [{ label, passed: false, note: NOT_IN_ITEM }];
  if (!res.ok)
    return [{ label, passed: false, note: `Bản tách chưa đọc được nên chưa tính độ phủ: ${errorNote(res.errors)}` }];
  if (!ctx.breakdown.requirements.length)
    return [{ label, passed: false, note: "Không thấy requirement nào ở tài liệu yêu cầu." }];
  const { missing } = coverage(ctx.breakdown.requirements, res.breakdown);
  return [
    {
      label,
      passed: missing.length === 0,
      note: missing.length
        ? `Chưa có task cho ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}.`
        : null,
    },
  ];
}

const CRITERIA_HEADING = /acceptance criteria|tiêu chí chấp nhận/i;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
// Mẫu EARS (Kiro): điều kiện WHEN/WHILE/WHERE/IF tuỳ chọn rồi "… SHALL …"; bản tiếng Việt KHI/NẾU/TRONG KHI … PHẢI.
// Từ khoá viết hoa mới tính, để câu văn thường có chữ "when", "phải" không lọt qua.
const EARS_START = /^(?:WHEN|WHILE|WHERE|IF|THE|KHI|NẾU|TRONG KHI|Ở NƠI|HỆ THỐNG)(?![\p{L}\p{N}])/u;
const EARS_RESPONSE = /(?<![\p{L}\p{N}])(?:SHALL|PHẢI)(?![\p{L}\p{N}])/u;

/** Mỗi tiêu chí trong mục Acceptance Criteria (Tiêu chí chấp nhận) viết theo EARS. */
function earsChecks(ctx: GateContext): ChecklistItem[] {
  const label = "Tiêu chí chấp nhận viết theo EARS";
  const bad: number[] = [];
  let criteria = 0;
  let inside = false;
  for (const [i, line] of ctx.content.split("\n").entries()) {
    if (HEADING.test(line)) {
      inside = CRITERIA_HEADING.test(line);
      continue;
    }
    const item = inside ? LIST_ITEM.exec(line) : null;
    if (!item) continue;
    criteria++;
    // Bỏ mã tiêu chí đứng đầu (`**1.1**`, `1.1:`) trước khi xét từ khoá mở đầu.
    const text = (item[1] ?? "")
      .replace(/^(?:\*\*)?[\w.-]*\d(?:\*\*)?\s*[:.)\-–—]?\s*/u, "")
      .replace(/^\*\*|\*\*/g, "");
    if (!EARS_START.test(text) || !EARS_RESPONSE.test(text)) bad.push(i + 1);
  }
  if (criteria === 0)
    return [
      { label, passed: false, note: "Không thấy tiêu chí nào trong mục Acceptance Criteria (Tiêu chí chấp nhận)." },
    ];
  return [
    {
      label,
      passed: bad.length === 0,
      note: bad.length
        ? `Dòng ${bad.slice(0, 8).join(", ")}${bad.length > 8 ? "…" : ""} chưa theo mẫu “WHEN … THE SYSTEM SHALL …”.`
        : null,
    },
  ];
}

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
    } else if (rule === "qa-cases") {
      const parsed = parseTestCaseTable(ctx.content);
      out.push({
        label: "TC có cấu trúc và liên kết FR/AC",
        passed: parsed.ok,
        note: parsed.ok ? null : parsed.errors.map((e) => `Dòng ${e.line}: ${e.message}`).join(" "),
      });
    } else if (rule === "qa-tests") {
      const checks = ctx.qaChecks?.length
        ? ctx.qaChecks
        : [{ code: "QA", passed: false, note: "Thiếu dữ liệu cổng QA." }];
      out.push(...checks.map((c) => ({ label: `${c.code} đạt hoặc được miễn`, passed: c.passed, note: c.note })));
    } else if (rule === "requirements") {
      const reqs = requirementsOf(ctx.content);
      if (!reqs.length) out.push({ label: "Có yêu cầu đánh mã R-n", passed: false, note: "Không thấy R-1, R-2…" });
      for (const r of reqs)
        out.push({
          label: `${r.id} có tiêu chí chấp nhận`,
          passed: r.acceptance.length > 0,
          note: r.acceptance.length ? null : "Thêm tiêu chí chấp nhận cho yêu cầu này.",
        });
    } else if (rule === "no-open-questions") {
      out.push(...openQuestionChecks(ctx));
    } else if (rule === "breakdown") {
      out.push(...breakdownChecks(ctx));
    } else if (rule === "coverage") {
      out.push(...coverageChecks(ctx));
    } else if (rule === "ears") {
      out.push(...earsChecks(ctx));
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
