import { z } from "zod";
import { id, orgRoute } from "./common.ts";

export const qaCaseCode = z.string().regex(/^TC-\d{3,5}$/, "Mã test case có dạng TC-001.");
export const qaPriority = z.enum(["P1", "P2", "P3"]);
export type QaPriority = z.output<typeof qaPriority>;
export const qaAutomation = z.enum(["manual", "automated"]);
export type QaAutomation = z.output<typeof qaAutomation>;
export const qaResultStatus = z.enum(["passed", "failed", "skipped", "flaky"]);
export type QaResultStatus = z.output<typeof qaResultStatus>;
export const QA_MAX_REPORT_CASES = 5000;
const count = z.number().int().min(0).max(1_000_000);
const duration = z
  .number()
  .int()
  .min(0)
  .max(7 * 86_400_000);

// Danh sách cho phép chỉ chứa mã TC và số liệu để log, tên test và dữ liệu môi trường ở lại máy.
export const qaReportCase = z.strictObject({
  code: qaCaseCode,
  status: qaResultStatus,
  retries: z.number().int().min(0).max(100),
  durationMs: duration,
});
export const qaTestReport = z
  .strictObject({
    runner: z.enum(["playwright", "junit"]),
    commit: z
      .string()
      .regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/, "Commit phải là SHA đầy đủ.")
      .optional(),
    totals: z.strictObject({ total: count, passed: count, failed: count, skipped: count, flaky: count }),
    durationMs: duration,
    cases: z.array(qaReportCase).max(QA_MAX_REPORT_CASES),
    truncated: z.boolean(),
  })
  .superRefine((r, ctx) => {
    const t = r.totals;
    if (t.total !== t.passed + t.failed + t.skipped + t.flaky)
      ctx.addIssue({ code: "custom", message: "Tổng số không khớp từng loại kết quả.", path: ["totals"] });
    // Một TC có thể gồm nhiều test; tổng của runner luôn lớn hơn hoặc bằng số TC đã nhận diện.
    if (r.cases.length > t.total)
      ctx.addIssue({ code: "custom", message: "Số TC vượt tổng số test.", path: ["cases"] });
    if (new Set(r.cases.map((c) => c.code)).size !== r.cases.length)
      ctx.addIssue({ code: "custom", message: "Mã TC trong báo cáo bị trùng.", path: ["cases"] });
    for (const status of qaResultStatus.options)
      if (r.cases.filter((c) => c.status === status).length > t[status])
        ctx.addIssue({
          code: "custom",
          message: "Số TC theo trạng thái vượt tổng số test tương ứng.",
          path: ["cases"],
        });
  });
export type QaTestReport = z.output<typeof qaTestReport>;

export const qaCaseDefinition = z
  .object({
    code: qaCaseCode,
    title: z.string().trim().min(3).max(300),
    priority: qaPriority,
    automation: qaAutomation,
    requirementIds: z
      .array(z.string().regex(/^(FR|AC)-[\w.]+$/))
      .min(1)
      .max(50),
    scriptPath: z.string().max(500).nullable(),
    testKey: z.string().max(500).nullable(),
    required: z.boolean().default(true),
  })
  .superRefine((c, ctx) => {
    if (c.automation === "automated" && !c.scriptPath)
      ctx.addIssue({ code: "custom", message: "TC tự động cần đường dẫn script.", path: ["scriptPath"] });
    if (c.scriptPath && (c.scriptPath.includes("..") || /[\\:\n\r]/.test(c.scriptPath) || c.scriptPath.startsWith("/")))
      ctx.addIssue({ code: "custom", message: "Script phải là đường dẫn tương đối trong repo.", path: ["scriptPath"] });
  });
export type QaCaseDefinition = z.output<typeof qaCaseDefinition>;
export const qaGateCheck = z.object({ code: z.string(), passed: z.boolean(), note: z.string() });
export const qaView = z.object({
  cases: z.array(
    qaCaseDefinition.safeExtend({
      id,
      retired: z.boolean(),
      lastStatus: qaResultStatus.nullable(),
      waivedBy: z.string().nullable(),
      waiverReason: z.string().nullable(),
    }),
  ),
  report: z.object({ runId: id, createdAt: z.iso.datetime(), data: qaTestReport }).nullable(),
  checks: z.array(qaGateCheck),
  canWaive: z.boolean(),
});
export type QaView = z.output<typeof qaView>;
export const qaContract = {
  view: orgRoute("GET", "/v1/sdlc/qa", "Metadata kiểm thử và cổng QA của hạng mục", "sdlc")
    .input(z.object({ itemId: id }))
    .output(qaView),
  waive: orgRoute("POST", "/v1/sdlc/qa/waive", "Miễn hoặc thu hồi miễn TC bắt buộc", "sdlc")
    .input(z.object({ caseId: id, waived: z.boolean(), reason: z.string().trim().min(10).max(500) }))
    .output(z.object({ ok: z.literal(true) })),
};

export interface ParsedTestCase {
  code: string;
  title: string;
  priority: QaPriority;
  automation: QaAutomation;
  requirementIds: string[];
  scriptPath: string | null;
  testKey: string | null;
  required: boolean;
}

export interface TestCaseTableError {
  /** Dòng trong tài liệu, đếm từ 1. */
  line: number;
  message: string;
}

export type TestCaseTableResult =
  | { ok: true; cases: ParsedTestCase[]; errors: [] }
  | { ok: false; cases: ParsedTestCase[]; errors: TestCaseTableError[] };

type Column = "code" | "title" | "priority" | "automation" | "requirements" | "script" | "testKey" | "required";

// Nhận cả tên cột tiếng Việt và tiếng Anh: agent và người viết tay không luôn dùng đúng khuôn.
const COLUMN_NAMES: Record<Column, string[]> = {
  code: ["mã", "ma", "tc", "id", "code", "mã tc"],
  title: ["tiêu đề", "tieu de", "tên", "title", "name", "mô tả"],
  priority: ["ưu tiên", "uu tien", "priority"],
  automation: ["loại", "loai", "automation", "tự động", "kiểu"],
  requirements: ["yêu cầu", "yeu cau", "requirements", "requirement", "fr/ac", "truy vết"],
  script: ["script", "file", "file test"],
  testKey: ["khoá test", "khóa test", "test key", "key"],
  required: ["bắt buộc", "required"],
};

const MAX_CASES = 5000;
const REQUIREMENT = /\b(?:FR|AC)-[\w.]+/g;

const cellsOf = (line: string) => {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body.split("|").map((c) =>
    c
      .trim()
      .replace(/^`(.*)`$/, "$1")
      .trim(),
  );
};
const isSeparator = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const isRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const empty = (v: string | undefined) => !v || v === "-" || v === "—";

function columnOf(header: string): Column | null {
  const h = header.toLowerCase().replace(/\*/g, "").trim();
  for (const [col, names] of Object.entries(COLUMN_NAMES) as [Column, string[]][]) if (names.includes(h)) return col;
  return null;
}

function automationOf(v: string): QaAutomation | null {
  const s = v.toLowerCase();
  if (/^(automated|auto|tự động|tu dong|e2e)$/.test(s)) return "automated";
  if (/^(manual|thủ công|thu cong|tay)$/.test(s)) return "manual";
  return null;
}

/**
 * Đọc bảng test case (FR-010): bảng Markdown đầu tiên có cột mã và tiêu đề. Thuần, dùng ở hub khi tài liệu
 * `test-cases` thành baseline và ở màn xem trước. Có lỗi thì `ok = false`, hub không đổi gì (tránh retire TC vì một
 * dòng gõ sai).
 */
export function parseTestCaseTable(md: string): TestCaseTableResult {
  const lines = md.split(/\r?\n/);
  const errors: TestCaseTableError[] = [];
  const cases: ParsedTestCase[] = [];
  let fence = false;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence || !isRow(line) || !isSeparator(lines[i + 1] ?? "")) continue;
    const cols = cellsOf(line).map(columnOf);
    if (!cols.includes("code") || !cols.includes("title")) continue;
    const seen = new Set<string>();
    const keys = new Set<string>();
    for (let j = i + 2; j < lines.length && isRow(lines[j] ?? ""); j++) {
      const row = cellsOf(lines[j] ?? "");
      const get = (c: Column) => {
        const at = cols.indexOf(c);
        return at < 0 ? "" : (row[at] ?? "");
      };
      const lineNo = j + 1;
      const code = get("code");
      if (!/^TC-\d{3,5}$/.test(code)) {
        errors.push({ line: lineNo, message: `Mã “${code}” không đúng dạng TC-001.` });
        continue;
      }
      if (seen.has(code)) {
        errors.push({ line: lineNo, message: `Mã ${code} trùng.` });
        continue;
      }
      seen.add(code);
      const title = get("title");
      if (title.length < 3) errors.push({ line: lineNo, message: `${code}: thiếu tiêu đề.` });
      const p = get("priority").toUpperCase();
      const priority = empty(p) ? "P2" : qaPriority.safeParse(p).data;
      if (!priority) errors.push({ line: lineNo, message: `${code}: ưu tiên phải là P1, P2 hoặc P3.` });
      const a = get("automation");
      const automation = empty(a) ? "manual" : automationOf(a);
      if (!automation) errors.push({ line: lineNo, message: `${code}: loại phải là manual hoặc automated.` });
      const script = get("script");
      const key = get("testKey");
      if (!empty(key)) {
        if (keys.has(key)) errors.push({ line: lineNo, message: `${code}: khoá test “${key}” trùng.` });
        keys.add(key);
      }
      const requiredValue = get("required").toLowerCase();
      if (!empty(requiredValue) && !["true", "false", "có", "không"].includes(requiredValue))
        errors.push({ line: lineNo, message: `${code}: Bắt buộc phải là true hoặc false.` });
      const definition = {
        code,
        title,
        priority: priority ?? "P2",
        automation: automation ?? "manual",
        requirementIds: [...new Set(get("requirements").match(REQUIREMENT) ?? [])],
        scriptPath: empty(script) ? null : script,
        testKey: empty(key) ? null : key,
        required: !["false", "không"].includes(requiredValue),
      };
      const parsed = qaCaseDefinition.safeParse(definition);
      if (!parsed.success) errors.push({ line: lineNo, message: `${code}: ${parsed.error.issues[0]?.message}` });
      cases.push(definition);
    }
    break;
  }
  if (!cases.length && !errors.length)
    errors.push({ line: 1, message: "Không thấy bảng test case (cột Mã, Tiêu đề)." });
  if (cases.length > MAX_CASES) errors.push({ line: 1, message: `Tối đa ${MAX_CASES} test case mỗi tài liệu.` });
  return errors.length ? { ok: false, cases, errors } : { ok: true, cases, errors: [] };
}
