import { type Plan, type PlanContent, type PlanStatus, planContent, type Run, type Task } from "@xdev-hive/contracts";
import type { Lang } from "@/lib/i18n.ts";
import type { Tone } from "@/lib/run-view.ts";

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  awaiting: "Chờ duyệt",
  approved: "Đã duyệt",
  rejected: "Bị từ chối",
  superseded: "Không còn hiệu lực",
};

export const PLAN_STATUS_TONE: Record<PlanStatus, Tone> = {
  awaiting: "warn",
  approved: "ok",
  rejected: "bad",
  superseded: "neutral",
};

export type FileChange = NonNullable<PlanContent["files"][number]["change"]>;

export const FILE_CHANGE_LABEL: Record<FileChange, string> = { add: "Thêm", modify: "Sửa", delete: "Xoá" };
export const FILE_CHANGES: readonly FileChange[] = ["add", "modify", "delete"];

/** Bản run code làm theo: bản người duyệt sửa nếu có, không thì bản agent nộp. */
export const effectiveContent = (plan: Plan): PlanContent => plan.editedContent ?? plan.content;

/** Kế hoạch chờ duyệt và người xem được quyết; hub vẫn kiểm lại (PLAN_DECIDED, quyền đội). */
export const canDecidePlan = (plan: Plan | undefined, canDecide: boolean): boolean =>
  canDecide && plan?.status === "awaiting";

/**
 * Câu nói việc đang ở đâu trong plan mode, ghép task, kế hoạch mới nhất và run code gần nhất. Kế hoạch mới nhất có
 * thể đã cũ: từ chối kèm lập lại thì run code mới đang `planning` trong khi kế hoạch mới nhất vẫn là bản bị từ chối.
 */
export function planStage(task: Task, latest: Plan | undefined, run: Run | null, lang: Lang = "vi"): string | null {
  if (lang === "en") {
    if (run?.state === "planning")
      return latest
        ? "The agent is planning again after rejection."
        : "The agent is planning. This page updates automatically.";
    if (!latest) return null;
    if (latest.status === "awaiting") return "The plan is waiting for review. The code run starts only after approval.";
    if (latest.status === "approved") return "Plan approved. The code run follows the effective version.";
    if (latest.status === "rejected")
      return task.status === "todo"
        ? "Plan rejected. The task is unassigned again. Assign it to create a new plan."
        : null;
    return "The run waiting on this plan was cancelled or finished before a decision.";
  }
  if (run?.state === "planning") {
    return latest ? "Agent đang lập lại kế hoạch sau lần bị từ chối." : "Agent đang lập kế hoạch. Trang tự cập nhật.";
  }
  if (!latest) return null;
  if (latest.status === "awaiting") return "Kế hoạch đang chờ người duyệt. Run code chỉ chạy sau khi được duyệt.";
  if (latest.status === "approved") return "Kế hoạch đã duyệt. Run code làm theo bản đang có hiệu lực.";
  if (latest.status === "rejected") {
    return task.status === "todo" ? "Kế hoạch bị từ chối, việc quay về chưa giao. Giao lại để lập kế hoạch mới." : null;
  }
  return "Run chờ kế hoạch này đã bị huỷ hoặc đã kết thúc trước khi có người quyết.";
}

// ---- Form sửa kế hoạch ---------------------------------------------------------------------------------------

/**
 * Bản nháp của form: mỗi dòng có `key` riêng để React giữ đúng ô khi thêm, xoá, đổi thứ tự. `change` rỗng là chưa
 * chọn kiểu thay đổi (schema cho phép bỏ trống).
 */
export interface PlanDraft {
  summary: string;
  steps: { key: string; title: string; detail: string }[];
  files: { key: string; path: string; change: FileChange | ""; reason: string }[];
  risks: { key: string; text: string }[];
  questions: { key: string; text: string }[];
}

let seq = 0;
export const draftKey = (): string => `d${++seq}`;

export function toDraft(c: PlanContent): PlanDraft {
  return {
    summary: c.summary,
    steps: c.steps.map((s) => ({ key: draftKey(), title: s.title, detail: s.detail ?? "" })),
    files: c.files.map((f) => ({ key: draftKey(), path: f.path, change: f.change ?? "", reason: f.reason ?? "" })),
    risks: c.risks.map((text) => ({ key: draftKey(), text })),
    questions: c.questions.map((text) => ({ key: draftKey(), text })),
  };
}

/** Lỗi theo ô: `summary`, `steps`, `steps.<key>.title`, `files.<key>.path`…; `form` là lỗi chung. */
export type DraftErrors = Record<string, string>;

export type DraftResult = { ok: true; content: PlanContent } | { ok: false; errors: DraftErrors };

/**
 * Đổi bản nháp thành nội dung gửi hub. Dòng để trống hết thì bỏ (người duyệt thêm dòng rồi không dùng); dòng điền dở
 * thì báo lỗi ở đúng ô. Sau cùng kiểm lại bằng chính schema của hub để không gửi bản chắc chắn bị từ chối.
 */
export function fromDraft(d: PlanDraft, lang: Lang = "vi"): DraftResult {
  const errors: DraftErrors = {};
  const summary = d.summary.trim();
  if (!summary)
    errors.summary = lang === "vi" ? "Tóm tắt kế hoạch không được để trống." : "Plan summary cannot be empty.";

  const steps: PlanContent["steps"] = [];
  for (const s of d.steps) {
    const title = s.title.trim();
    const detail = s.detail.trim();
    if (!title && !detail) continue;
    if (!title) errors[`steps.${s.key}.title`] = lang === "vi" ? "Bước cần có tiêu đề." : "A step needs a title.";
    steps.push(detail ? { title, detail } : { title });
  }
  if (steps.length === 0)
    errors.steps = lang === "vi" ? "Kế hoạch cần ít nhất một bước." : "The plan needs at least one step.";

  const files: PlanContent["files"] = [];
  for (const f of d.files) {
    const path = f.path.trim();
    const reason = f.reason.trim();
    if (!path && !reason && !f.change) continue;
    if (!path)
      errors[`files.${f.key}.path`] =
        lang === "vi" ? "Nhập đường dẫn file hoặc xoá dòng này." : "Enter a file path or delete this row.";
    files.push({ path, ...(f.change ? { change: f.change } : {}), ...(reason ? { reason } : {}) });
  }

  const lines = (rows: { text: string }[]) => rows.map((r) => r.text.trim()).filter(Boolean);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const parsed = planContent.safeParse({ summary, steps, files, risks: lines(d.risks), questions: lines(d.questions) });
  if (!parsed.success) {
    // Ô nhập đã đặt maxLength theo schema nên hiếm khi tới đây; nêu phần sai để người duyệt tìm ra.
    const where = SECTION_LABEL[String(parsed.error.issues[0]?.path[0])] ?? "kế hoạch";
    return {
      ok: false,
      errors: {
        form:
          lang === "vi"
            ? `Phần ${where} không hợp lệ (quá dài hoặc quá nhiều dòng). Rút gọn rồi thử lại.`
            : "The plan has invalid content (too long or too many rows). Shorten it and try again.",
      },
    };
  }
  return { ok: true, content: parsed.data };
}

const SECTION_LABEL: Record<string, string> = {
  summary: "tóm tắt",
  steps: "các bước",
  files: "file dự kiến đụng",
  risks: "rủi ro",
  questions: "câu hỏi",
};

/** Bản sửa có khác bản đang hiệu lực không; giống thì duyệt nguyên bản, không gửi `content`. */
export function sameContent(a: PlanContent, b: PlanContent): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(c: PlanContent) {
  return {
    summary: c.summary,
    steps: c.steps.map((s) => [s.title, s.detail ?? ""]),
    files: c.files.map((f) => [f.path, f.change ?? "", f.reason ?? ""]),
    risks: c.risks,
    questions: c.questions,
  };
}

/** Đổi chỗ phần tử `i` với phần tử kế bên (`dir` = -1 lên, 1 xuống); ra ngoài mảng thì giữ nguyên. */
export function move<T>(list: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j] as T, next[i] as T];
  return next;
}

export function planStatusLabel(status: PlanStatus, lang: Lang): string {
  return lang === "vi"
    ? PLAN_STATUS_LABEL[status]
    : { awaiting: "Awaiting review", approved: "Approved", rejected: "Rejected", superseded: "Superseded" }[status];
}

export function fileChangeLabel(change: FileChange, lang: Lang): string {
  return lang === "vi" ? FILE_CHANGE_LABEL[change] : { add: "Add", modify: "Edit", delete: "Delete" }[change];
}
