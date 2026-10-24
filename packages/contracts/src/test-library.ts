import type { QaPriority } from "./qa.ts";
import {
  TEST_AREA_CODE,
  TEST_CASE_CODE,
  TEST_SPEC_REQUIREMENT,
  TEST_SRS_REQUIREMENT,
  type TestCaseContent,
  type TestCaseKind,
  type TestParseError,
  type TestStep,
} from "./testing.ts";

/**
 * Bộ đọc file khu test case (specs/036 contracts/tc-markdown.md, research D2). Thuần, không biết database: web dùng để
 * báo lỗi khi đang gõ, hub dùng khi áp dụng file trong tx lưu tài liệu, nên hai bên luôn thấy cùng một kết quả.
 */

export const QA_PARSE_ERRORS_MAX = 100;
export const QA_AREA_NAME_MAX = 120;
export const QA_CASE_NAME_MAX = 300;
export const QA_STEPS_MAX = 50;
export const QA_STEP_CELL_MAX = 1000;
export const QA_LABELS_MAX = 20;
export const QA_LABEL_MAX = 40;

export interface ParsedAreaCase extends TestCaseContent {
  code: string;
  line: number;
}

export interface ParsedArea {
  area: { code: string; name: string; line: number } | null;
  /** Chỉ TC không có lỗi. Hub vẫn không áp dụng file khi `errors` khác rỗng (FR-004). */
  cases: ParsedAreaCase[];
  /** Xếp theo dòng, tối đa `QA_PARSE_ERRORS_MAX`. */
  errors: TestParseError[];
}

type Field = "priority" | "kind" | "requirements" | "labels" | "script" | "testData" | "preconditions" | "note";

const FIELD_NAMES: Record<Field, string> = {
  priority: "Ưu tiên",
  kind: "Loại",
  requirements: "Yêu cầu",
  labels: "Nhãn",
  script: "Script",
  testData: "Dữ liệu test",
  preconditions: "Điều kiện trước",
  note: "Ghi chú",
};
const FIELD_BY_NAME = new Map(Object.entries(FIELD_NAMES).map(([f, n]) => [n.toLowerCase(), f as Field]));
const REQUIRED_FIELDS: readonly Field[] = ["priority", "kind", "requirements"];
const TEXT_MAX: Partial<Record<Field, number>> = { script: 255, testData: 200, preconditions: 1000, note: 1000 };

const PRIORITIES: readonly QaPriority[] = ["P1", "P2", "P3"];
const KINDS: Record<string, TestCaseKind> = { "tự động": "automated", tay: "manual", "dự kiến tự động": "planned" };
const STEP_HEADER = ["#", "thao tác", "kết quả mong đợi"];
// Mã spec viết sai vẫn nhận ra được nhờ tiền tố, để báo "sai dạng" kèm ví dụ đúng thay vì "sai mẫu" chung chung.
const SPEC_PREFIX = /^(?:\d{3}\/)?(FR|AC|NFR|US)/;

const isFence = (line: string) => /^\s*(```|~~~)/.test(line);
const isRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isSeparator = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
// `\|` trong ô là ký tự `|` của nội dung, không phải ranh giới cột.
const cellsOf = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
const listOf = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
const isRelativePath = (p: string) =>
  !p.startsWith("/") && !/[\\:\n\r]/.test(p) && !p.split("/").some((part) => part === "..");

const tooLong = (n: number, field: string, length: number, max: number) => ({
  line: n,
  message: `Dòng ${n}: \`${field}\` dài ${length} ký tự, tối đa ${max}.`,
});
const invalidValue = (n: number, field: string, value: string, allowed: string) => ({
  line: n,
  message: `Dòng ${n}: \`${field}\` không nhận \`${value}\`. Giá trị hợp lệ: ${allowed}.`,
});

/** Lỗi của một mã yêu cầu theo thứ tự ở tc-markdown.md; null khi mã hợp lệ. */
export function requirementCodeError(code: string, n: number): TestParseError | null {
  if (TEST_SPEC_REQUIREMENT.test(code) || TEST_SRS_REQUIREMENT.test(code)) return null;
  const prefix = SPEC_PREFIX.exec(code)?.[1];
  if (prefix)
    return {
      line: n,
      message: `Dòng ${n}: mã yêu cầu \`${code}\` bắt đầu bằng \`${prefix}\` nên phải có dạng mã spec, ví dụ \`${prefix}-001\` hoặc \`036/${prefix}-001\`.`,
    };
  return {
    line: n,
    message: `Dòng ${n}: mã yêu cầu \`${code}\` không đúng mẫu. Mã spec có dạng \`FR-001\` hoặc \`036/AC-012.2\`. Mã SRS gồm 3–16 chữ hoa hoặc số, bắt đầu bằng chữ, ví dụ \`OPD02\`.`,
  };
}

interface Draft {
  code: string;
  name: string;
  line: number;
  fields: Map<Field, { value: string; line: number }>;
  /** Bảng bước đã gặp; null khi chưa có. */
  steps: TestStep[] | null;
  stepsLine: number;
  /** Đã qua bảng bước: danh sách sau đó là chữ thường, không phải trường. */
  pastTable: boolean;
  errors: TestParseError[];
}

function finishCase(d: Draft): { case: ParsedAreaCase | null; errors: TestParseError[] } {
  const errors = d.errors;
  const missing = (f: Field) =>
    errors.push({ line: d.line, message: `Dòng ${d.line}: TC \`${d.code}\` thiếu trường \`${FIELD_NAMES[f]}\`.` });
  const r = d.fields.get("requirements");
  const requirements = [...new Set(listOf(r?.value ?? ""))];
  for (const f of REQUIRED_FIELDS)
    if (f === "requirements" ? !requirements.length : !d.fields.get(f)?.value) missing(f);

  const text = (f: Field): string | null => {
    const got = d.fields.get(f);
    if (!got?.value) return null;
    const max = TEXT_MAX[f];
    if (max && got.value.length > max) errors.push(tooLong(got.line, FIELD_NAMES[f], got.value.length, max));
    return got.value;
  };

  const p = d.fields.get("priority");
  const priority = PRIORITIES.find((x) => x === p?.value.toUpperCase());
  if (p?.value && !priority) errors.push(invalidValue(p.line, FIELD_NAMES.priority, p.value, PRIORITIES.join(", ")));

  const k = d.fields.get("kind");
  const kind = k?.value ? KINDS[k.value.toLowerCase()] : undefined;
  if (k?.value && !kind) errors.push(invalidValue(k.line, FIELD_NAMES.kind, k.value, Object.keys(KINDS).join(", ")));

  for (const code of requirements) {
    const e = requirementCodeError(code, r?.line ?? d.line);
    if (e) errors.push(e);
  }

  const l = d.fields.get("labels");
  const labels = [...new Set(listOf(l?.value ?? ""))];
  const labelsLine = l?.line ?? d.line;
  if (labels.length > QA_LABELS_MAX)
    errors.push({
      line: labelsLine,
      message: `Dòng ${labelsLine}: có ${labels.length} nhãn, tối đa ${QA_LABELS_MAX}.`,
    });
  for (const label of labels) {
    if (/\s/.test(label))
      errors.push(
        invalidValue(labelsLine, FIELD_NAMES.labels, label, "nhãn không có dấu cách, cách nhau bằng dấu phẩy"),
      );
    else if (label.length > QA_LABEL_MAX)
      errors.push(tooLong(labelsLine, FIELD_NAMES.labels, label.length, QA_LABEL_MAX));
  }

  const script = text("script");
  if (script && !isRelativePath(script))
    errors.push(
      invalidValue(
        d.fields.get("script")?.line ?? d.line,
        FIELD_NAMES.script,
        script,
        "đường dẫn tương đối trong repo test, không chứa `..`",
      ),
    );
  if (kind === "automated" && !script)
    errors.push({ line: d.line, message: `Dòng ${d.line}: TC \`${d.code}\` loại tự động phải có \`Script\`.` });

  if (!d.steps?.length)
    errors.push({
      line: d.steps ? d.stepsLine : d.line,
      message: `Dòng ${d.steps ? d.stepsLine : d.line}: TC \`${d.code}\` cần ít nhất một bước có thao tác và kết quả mong đợi.`,
    });

  const content = {
    name: d.name,
    priority: priority ?? "P2",
    kind: kind ?? "manual",
    requirements,
    labels,
    script,
    testData: text("testData"),
    preconditions: text("preconditions"),
    note: text("note"),
    steps: d.steps ?? [],
  };
  if (errors.length) return { case: null, errors };
  return { case: { code: d.code, line: d.line, ...normalizeTestCase(content) }, errors };
}

/**
 * Đọc một file khu. TC kéo dài tới `###` kế tiếp hoặc `#`, `##` kế tiếp; khối code bị bỏ qua để ví dụ trong ghi chú
 * không thành TC.
 */
export function parseTestArea(md: string): ParsedArea {
  // Editor trên macOS có thể lưu chữ Việt ở dạng tổ hợp (NFD); chuẩn hoá để tên trường và giá trị so được.
  const lines = md.normalize("NFC").split(/\r?\n/);
  const errors: TestParseError[] = [];
  const cases: ParsedAreaCase[] = [];
  const seen = new Map<string, number>();
  let area: ParsedArea["area"] = null;
  let areaSeen = false;
  let draft: Draft | null = null;
  let fence = false;

  const close = () => {
    if (!draft) return;
    const done = finishCase(draft);
    errors.push(...done.errors);
    if (done.case) cases.push(done.case);
    draft = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const n = i + 1;
    if (isFence(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const line = raw.trim();

    const heading = /^(#{1,3})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 0;
      const body = heading[2] ?? "";
      close();
      if (level === 1 && !areaSeen) {
        areaSeen = true;
        const m = /^(\S+)\s+(.+)$/.exec(body);
        if (!m) {
          errors.push({
            line: n,
            message: `Dòng ${n}: file khu phải bắt đầu bằng \`# <MÃ KHU> <tên khu>\`, ví dụ \`# DANGNHAP Đăng nhập\`.`,
          });
        } else {
          const [, code = "", name = ""] = m;
          if (!TEST_AREA_CODE.test(code))
            errors.push({
              line: n,
              message: `Dòng ${n}: mã khu \`${code}\` phải gồm 2–16 chữ hoa hoặc số, bắt đầu bằng chữ.`,
            });
          else if (name.length > QA_AREA_NAME_MAX) errors.push(tooLong(n, "Tên khu", name.length, QA_AREA_NAME_MAX));
          else area = { code, name, line: n };
        }
      }
      // `###` không bắt đầu bằng `TC-` là tiêu đề thường của tài liệu, không phải TC.
      if (level === 3 && /^tc-/i.test(body)) draft = openCase(body, n, area?.code ?? null, seen, errors);
      continue;
    }
    if (!draft) continue;
    const d: Draft = draft;

    if (isRow(line)) {
      if (d.pastTable) continue;
      if (!d.steps) {
        const header = cellsOf(line).map((c) => c.toLowerCase());
        const isStepTable =
          header.length === STEP_HEADER.length &&
          header.every((c, j) => c === STEP_HEADER[j]) &&
          isSeparator(lines[i + 1] ?? "");
        if (isStepTable) {
          d.steps = [];
          d.stepsLine = n;
          i++;
        }
        continue;
      }
      readStep(d, cellsOf(line), n);
      continue;
    }
    if (d.steps) d.pastTable = true;
    if (d.pastTable) continue;

    const field = /^[-*]\s+([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (field) readField(d, field[1] ?? "", (field[2] ?? "").trim(), n);
  }
  close();

  if (!areaSeen)
    errors.push({
      line: 1,
      message: "Dòng 1: file khu phải bắt đầu bằng `# <MÃ KHU> <tên khu>`, ví dụ `# DANGNHAP Đăng nhập`.",
    });
  return { area, cases, errors: capErrors(errors) };
}

function openCase(
  body: string,
  n: number,
  areaCode: string | null,
  seen: Map<string, number>,
  errors: TestParseError[],
): Draft | null {
  const [code = "", ...rest] = body.split(/\s+/);
  const name = rest.join(" ");
  const fail = (message: string) => {
    errors.push({ line: n, message: `Dòng ${n}: ${message}` });
    return null;
  };
  if (/^TC-\d{3,5}$/.test(code))
    return fail(
      `mã \`${code}\` là mã TC của hạng mục. Mã thư viện có dạng \`TC-<KHU>-<SỐ>\`, ví dụ \`TC-${areaCode ?? "KHU"}-001\`.`,
    );
  if (!TEST_CASE_CODE.test(code))
    return fail(`mã \`${code}\` phải có dạng \`TC-<KHU>-<SỐ>\`, \`<SỐ>\` gồm 3–5 chữ số.`);
  const codeArea = code.split("-")[1] ?? "";
  if (areaCode && codeArea !== areaCode)
    return fail(`mã \`${code}\` thuộc khu \`${codeArea}\`, file này là khu \`${areaCode}\`.`);
  const first = seen.get(code);
  if (first) return fail(`mã \`${code}\` đã có ở dòng ${first}.`);
  seen.set(code, n);
  const draft: Draft = {
    code,
    name,
    line: n,
    fields: new Map(),
    steps: null,
    stepsLine: n,
    pastTable: false,
    errors: [],
  };
  if (!name) draft.errors.push({ line: n, message: `Dòng ${n}: TC \`${code}\` thiếu trường \`Tên\`.` });
  else if (name.length > QA_CASE_NAME_MAX) draft.errors.push(tooLong(n, "Tên", name.length, QA_CASE_NAME_MAX));
  return draft;
}

function readField(d: Draft, rawName: string, value: string, n: number) {
  const field = FIELD_BY_NAME.get(rawName.trim().toLowerCase());
  if (!field) {
    d.errors.push({
      line: n,
      message: `Dòng ${n}: không có trường \`${rawName}\`. Trường hợp lệ: ${Object.values(FIELD_NAMES).join(", ")}.`,
    });
    return;
  }
  const first = d.fields.get(field);
  if (first) {
    d.errors.push({ line: n, message: `Dòng ${n}: trường \`${rawName}\` đã khai ở dòng ${first.line}.` });
    return;
  }
  d.fields.set(field, { value, line: n });
}

function readStep(d: Draft, cells: string[], n: number) {
  const steps = d.steps ?? [];
  const k = steps.length + 1;
  const [num = "", action = "", expected = ""] = cells;
  if (k > QA_STEPS_MAX) {
    if (k === QA_STEPS_MAX + 1)
      d.errors.push({ line: n, message: `Dòng ${n}: TC \`${d.code}\` có quá ${QA_STEPS_MAX} bước.` });
    steps.push({ n: k, action, expected });
    return;
  }
  if (num !== String(k)) d.errors.push(invalidValue(n, "#", num, String(k)));
  if (!action || !expected)
    d.errors.push({ line: n, message: `Dòng ${n}: bước ${k} thiếu thao tác hoặc kết quả mong đợi.` });
  if (action.length > QA_STEP_CELL_MAX) d.errors.push(tooLong(n, "Thao tác", action.length, QA_STEP_CELL_MAX));
  if (expected.length > QA_STEP_CELL_MAX)
    d.errors.push(tooLong(n, "Kết quả mong đợi", expected.length, QA_STEP_CELL_MAX));
  steps.push({ n: k, action, expected });
}

function capErrors(errors: TestParseError[]): TestParseError[] {
  const sorted = errors.map((e, i) => ({ e, i })).sort((a, b) => a.e.line - b.e.line || a.i - b.i);
  const all = sorted.map((x) => x.e);
  if (all.length <= QA_PARSE_ERRORS_MAX) return all;
  const kept = all.slice(0, QA_PARSE_ERRORS_MAX - 1);
  const rest = all.length - kept.length;
  return [
    ...kept,
    { line: all[kept.length]?.line ?? 1, message: `Còn ${rest} lỗi khác. Sửa các lỗi trên rồi lưu lại.` },
  ];
}

/**
 * Nội dung chuẩn hoá của TC (FR-007): bỏ `code`, `line`, sắp xếp yêu cầu và nhãn, khoá theo thứ tự cố định. Hub băm
 * `JSON.stringify` của kết quả, nên đổi thứ tự trong file hay di chuyển TC không tăng phiên bản.
 */
export function normalizeTestCase(c: TestCaseContent): TestCaseContent {
  return {
    name: c.name,
    priority: c.priority,
    kind: c.kind,
    requirements: [...c.requirements].sort(),
    labels: [...c.labels].sort(),
    script: c.script,
    testData: c.testData,
    preconditions: c.preconditions,
    note: c.note,
    steps: c.steps.map((s) => ({ n: s.n, action: s.action, expected: s.expected })),
  };
}

/** Mẫu "Thêm khu chức năng" (FR-008); test kiểm mẫu qua được bộ đọc. */
export function areaTemplate(code: string, name: string): string {
  return `# ${code} ${name}

Mô tả ngắn phạm vi của khu.

### TC-${code}-001 Tên test case ví dụ

- Ưu tiên: P2
- Loại: tay
- Yêu cầu: FR-001
- Nhãn: vi-du

| # | Thao tác | Kết quả mong đợi |
|---|---|---|
| 1 | Mô tả thao tác | Mô tả kết quả mong đợi |
`;
}
