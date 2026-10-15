import { z } from "zod";
import { id, orgRoute } from "./common.ts";
import { DOC_MAX_CHARS, docKey, docSecretErrors, scopeView } from "./knowledge.ts";
import { gateKind, reviewStatus } from "./workflows.ts";

/**
 * Trình soạn tài liệu (DocEditor.dc.html, SRS DOC-01..05). Mỗi tài liệu có một bản nháp chung cho cả đội: sửa thẳng
 * vào bản nháp, hoặc đề xuất sửa để người khác nhận/bỏ; bình luận neo vào đoạn trích; bản chụp có tên; gửi bản nháp
 * vào quy trình duyệt thành đề xuất sửa tài liệu. Bản đã duyệt vẫn là `docs`/`doc_versions` như trước.
 */

/** Người hoặc agent (run) đã viết; `name` để hiện ngay, không phải hỏi thêm danh bạ. */
export const docActor = z.object({ userId: z.string().nullable(), runId: id.nullable(), name: z.string() });
export type DocActor = z.output<typeof docActor>;

const draftContent = z.string().max(DOC_MAX_CHARS, `Tài liệu dài tối đa ${DOC_MAX_CHARS} ký tự.`);
const title = z.string().trim().min(1, "Tiêu đề không được để trống.").max(200, "Tiêu đề dài tối đa 200 ký tự.");
const revision = z.number().int().min(0);

export const docDraft = z.object({
  key: z.string(),
  title: z.string(),
  content: z.string(),
  scope: scopeView,
  /** Phiên bản đã duyệt mà bản nháp bắt đầu từ đó; 0 là tài liệu mới. */
  baseVersion: z.number().int(),
  /** Phiên bản đã duyệt mới nhất hiện giờ; lớn hơn `baseVersion` là có bản mới cần gộp vào nháp. */
  latestVersion: z.number().int(),
  /** Số lần lưu bản nháp, để lưu lạc quan; 0 là chưa ai sửa (nội dung là bản đã duyệt). */
  revision: z.number().int(),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: docActor.nullable(),
  /** Người gọi được sửa bản nháp, đề xuất và gửi duyệt (thành viên đội). Không được thì chỉ đọc và bình luận. */
  canEdit: z.boolean(),
});
export type DocDraft = z.output<typeof docDraft>;

export const docEditorKey = z.object({ key: docKey });

export const draftSaveInput = z.object({
  key: docKey,
  title: title.optional(),
  content: draftContent,
  /** Revision mình đã đọc; lệch là có người vừa lưu: CONFLICT `DRAFT_CHANGED`, client gộp rồi lưu lại. */
  revision,
});
export type DraftSaveInput = z.input<typeof draftSaveInput>;

export const presenceEntry = z.object({
  userId: z.string(),
  name: z.string(),
  /** Có sửa trong một phút gần nhất. */
  editing: z.boolean(),
  seenAt: z.iso.datetime(),
});
export type PresenceEntry = z.output<typeof presenceEntry>;

export const editorStepState = z.enum(["done", "current", "todo", "failed", "skipped"]);
export type EditorStepState = z.output<typeof editorStepState>;

export const editorStage = z.enum(["drafting", "in_review", "changes_requested", "approved"]);
export type EditorStage = z.output<typeof editorStage>;

export const docEditorState = z.object({
  draft: docDraft,
  /** Người đang mở tài liệu (gồm cả người gọi), mới thấy nhất trước. */
  presence: z.array(presenceEntry),
  /** Quy trình duyệt khớp tài liệu và tiến độ của lần gửi gần nhất; null khi không có quy trình nào khớp. */
  workflow: z
    .object({
      id,
      name: z.string(),
      steps: z.array(
        z.object({ gateId: z.string(), name: z.string(), kind: gateKind, phase: z.string(), state: editorStepState }),
      ),
    })
    .nullable(),
  /** Lần gửi duyệt gần nhất. */
  review: z
    .object({
      id: id.nullable(),
      proposalId: id,
      status: reviewStatus.or(z.enum(["pending", "rejected"])),
      snapshot: z.number().int(),
      note: z.string().nullable(),
    })
    .nullable(),
  stage: editorStage,
  /** Số của bản đang soạn (v3): số lần đã gửi duyệt cộng một. */
  draftNumber: z.number().int(),
  openComments: z.number().int(),
  pendingSuggestions: z.number().int(),
});
export type DocEditorState = z.output<typeof docEditorState>;

// ---- Đề xuất sửa (chế độ Đề xuất, AI) --------------------------------------------------------------------------

export const suggestionStatus = z.enum(["pending", "accepted", "rejected"]);
export type SuggestionStatus = z.output<typeof suggestionStatus>;

export const docSuggestion = z.object({
  id,
  key: z.string(),
  /** Đoạn gốc trong bản nháp (rỗng là thêm khối mới ở cuối) và đoạn thay vào. */
  before: z.string(),
  after: z.string(),
  reason: z.string().nullable(),
  author: docActor,
  status: suggestionStatus,
  /** Đoạn gốc không còn (hoặc lặp lại) trong bản nháp: không nhận được nữa. */
  stale: z.boolean(),
  createdAt: z.iso.datetime(),
  decidedBy: docActor.nullable(),
  decidedAt: z.iso.datetime().nullable(),
});
export type DocSuggestion = z.output<typeof docSuggestion>;

export const SUGGESTION_MAX_CHARS = 20_000;
export const suggestionCreateInput = z
  .object({
    key: docKey,
    before: z.string().max(SUGGESTION_MAX_CHARS),
    after: z.string().max(SUGGESTION_MAX_CHARS),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((s) => s.before !== s.after, { message: "Đề xuất không đổi gì.", path: ["after"] });
export type SuggestionCreateInput = z.input<typeof suggestionCreateInput>;

export const suggestionDecideInput = z.object({ id, accept: z.boolean() });

// ---- Bình luận ---------------------------------------------------------------------------------------------------

export const docComment = z.object({
  id,
  author: docActor,
  body: z.string(),
  createdAt: z.iso.datetime(),
});
export type DocComment = z.output<typeof docComment>;

export const docThread = z.object({
  id,
  key: z.string(),
  /** Đoạn trích được bình luận; null là bình luận chung cho cả tài liệu. */
  quote: z.string().nullable(),
  /** Đoạn trích còn trong bản nháp. */
  anchored: z.boolean(),
  comments: z.array(docComment),
  resolvedAt: z.iso.datetime().nullable(),
  resolvedBy: docActor.nullable(),
});
export type DocThread = z.output<typeof docThread>;

export const commentAddInput = z
  .object({
    key: docKey,
    body: z.string().trim().min(1, "Bình luận không được để trống.").max(4000, "Bình luận dài tối đa 4000 ký tự."),
    /** Mở luồng mới tại đoạn trích này. */
    quote: z.string().trim().min(1).max(500).optional(),
    /** Trả lời trong luồng có sẵn. */
    threadId: id.optional(),
  })
  .refine((c) => !(c.quote && c.threadId), { message: "Trả lời thì không đặt đoạn trích.", path: ["quote"] });
export type CommentAddInput = z.input<typeof commentAddInput>;

export const threadResolveInput = z.object({ id, resolved: z.boolean() });

// ---- Bản chụp và gửi duyệt ---------------------------------------------------------------------------------------

export const docSnapshot = z.object({
  id,
  key: z.string(),
  /** Số thứ tự trong tài liệu, tăng dần. */
  number: z.number().int(),
  name: z.string(),
  title: z.string(),
  baseVersion: z.number().int(),
  author: docActor,
  createdAt: z.iso.datetime(),
  chars: z.number().int(),
  /** Bản chụp được gửi duyệt: đề xuất và phiên duyệt tạo ra. */
  submission: z
    .object({
      proposalId: id,
      reviewId: id.nullable(),
      status: reviewStatus.or(z.enum(["pending", "rejected"])),
      note: z.string().nullable(),
    })
    .nullable(),
});
export type DocSnapshot = z.output<typeof docSnapshot>;
export const docSnapshotDetail = docSnapshot.extend({ content: z.string() });
export type DocSnapshotDetail = z.output<typeof docSnapshotDetail>;

export const snapshotCreateInput = z.object({
  key: docKey,
  name: z.string().trim().min(1, "Đặt tên cho bản chụp.").max(120, "Tên dài tối đa 120 ký tự."),
});

export const submitPreview = z.object({
  workflow: z.object({ id, name: z.string() }).nullable(),
  gates: z.array(
    z.object({
      gateId: z.string(),
      name: z.string(),
      kind: gateKind,
      runs: z.boolean(),
      reason: z.string(),
      /** Ai duyệt (người, vai trò, đội) hoặc ai kiểm (AI, CI). */
      who: z.string(),
    }),
  ),
  /** Số dòng thêm và xoá so với bản đã duyệt. */
  addedLines: z.number().int(),
  deletedLines: z.number().int(),
});
export type SubmitPreview = z.output<typeof submitPreview>;

export const submitInput = z.object({
  key: docKey,
  note: z.string().trim().max(2000, "Ghi chú dài tối đa 2000 ký tự.").optional(),
  /** Gửi đúng bản mình đang thấy: lệch revision thì CONFLICT `DRAFT_CHANGED`. */
  revision,
  /** Người có quyền quản trị xác nhận chuỗi bị nghi không phải bí mật, sau khi nhận `DOC_SECRET_FOUND`. */
  acknowledgeSecrets: z.boolean().optional(),
});
export type SubmitInput = z.input<typeof submitInput>;

export const submitResult = z.object({ snapshot: docSnapshot, proposalId: id, reviewId: id.nullable() });

// ---- AI ------------------------------------------------------------------------------------------------------------

export const assistAction = z.enum(["continue", "template", "acceptance", "crossref", "translate", "custom"]);
export type AssistAction = z.output<typeof assistAction>;
export const assistCli = z.enum(["claude", "codex", "gemini"]);

export const assistTarget = z.object({
  machineId: id,
  name: z.string(),
  clis: z.array(z.string()),
  online: z.boolean(),
  /** Máy đã cài app/worker đủ mới để chạy trợ lý tài liệu. */
  ready: z.boolean(),
});
export type AssistTarget = z.output<typeof assistTarget>;

export const assistStartInput = z
  .object({
    key: docKey,
    action: assistAction,
    cli: assistCli,
    machineId: id.optional(),
    /** Yêu cầu tự do (`custom`) hoặc ghi thêm cho thao tác có sẵn. */
    prompt: z.string().trim().max(2000).optional(),
    /** Đoạn đang chọn: "viết tiếp đoạn này", dịch đoạn này… */
    quote: z.string().max(SUGGESTION_MAX_CHARS).optional(),
  })
  .refine((a) => a.action !== "custom" || !!a.prompt, { message: "Nhập yêu cầu cho AI.", path: ["prompt"] });
export type AssistStartInput = z.input<typeof assistStartInput>;

export const docAssist = z.object({
  runId: id,
  action: assistAction,
  cli: z.string().nullable(),
  machine: z.string().nullable(),
  state: z.string(),
  prompt: z.string().nullable(),
  /** Tóm tắt agent nộp khi xong. */
  summary: z.string().nullable(),
  suggestions: z.number().int(),
  comments: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type DocAssist = z.output<typeof docAssist>;

export const docEditorContract = {
  state: orgRoute("POST", "/v1/doc-editor/state", "Mở trình soạn: bản nháp, người đang xem, tiến độ duyệt", "knowledge")
    .input(docEditorKey)
    .output(docEditorState),
  save: orgRoute("POST", "/v1/doc-editor/draft", "Lưu bản nháp (thành viên đội)", "knowledge")
    .input(draftSaveInput)
    .output(docDraft),
  rebase: orgRoute("POST", "/v1/doc-editor/rebase", "Gộp phiên bản đã duyệt mới nhất vào bản nháp", "knowledge")
    .input(z.object({ key: docKey, revision }))
    .output(z.object({ draft: docDraft, conflicts: z.number().int() })),
  submitPreview: orgRoute("GET", "/v1/doc-editor/submit-preview", "Các checkpoint bản nháp sẽ đi qua", "knowledge")
    .input(docEditorKey)
    .output(submitPreview),
  submit: orgRoute("POST", "/v1/doc-editor/submit", "Chụp bản nháp và gửi vào quy trình duyệt", "knowledge")
    .errors(docSecretErrors)
    .input(submitInput)
    .output(submitResult),
  suggestions: {
    list: orgRoute("GET", "/v1/doc-editor/suggestions", "Đề xuất sửa trên bản nháp", "knowledge")
      .input(z.object({ key: docKey, status: suggestionStatus.optional() }))
      .output(z.array(docSuggestion)),
    create: orgRoute("POST", "/v1/doc-editor/suggestions", "Đề xuất sửa một đoạn của bản nháp", "knowledge")
      .input(suggestionCreateInput)
      .output(docSuggestion),
    decide: orgRoute("POST", "/v1/doc-editor/suggestions/{id}/decide", "Nhận hoặc bỏ đề xuất sửa", "knowledge")
      .input(suggestionDecideInput)
      .output(z.object({ suggestion: docSuggestion, draft: docDraft })),
  },
  comments: {
    list: orgRoute("GET", "/v1/doc-editor/comments", "Luồng bình luận của tài liệu", "knowledge")
      .input(docEditorKey)
      .output(z.array(docThread)),
    add: orgRoute("POST", "/v1/doc-editor/comments", "Bình luận hoặc trả lời", "knowledge")
      .input(commentAddInput)
      .output(docThread),
    resolve: orgRoute("POST", "/v1/doc-editor/comments/{id}/resolve", "Đóng hoặc mở lại luồng", "knowledge")
      .input(threadResolveInput)
      .output(docThread),
  },
  snapshots: {
    list: orgRoute("GET", "/v1/doc-editor/snapshots", "Bản chụp của bản nháp, mới nhất trước", "knowledge")
      .input(docEditorKey)
      .output(z.array(docSnapshot)),
    get: orgRoute("GET", "/v1/doc-editor/snapshots/item", "Đọc một bản chụp", "knowledge")
      .input(z.object({ id }))
      .output(docSnapshotDetail),
    create: orgRoute("POST", "/v1/doc-editor/snapshots", "Chụp bản nháp hiện tại với một tên", "knowledge")
      .input(snapshotCreateInput)
      .output(docSnapshot),
  },
  assist: {
    targets: orgRoute(
      "GET",
      "/v1/doc-editor/assist/targets",
      "Máy của tôi chạy được trợ lý tài liệu",
      "knowledge",
    ).output(z.array(assistTarget)),
    list: orgRoute("GET", "/v1/doc-editor/assist", "Lượt AI đã chạy trên tài liệu", "knowledge")
      .input(docEditorKey)
      .output(z.array(docAssist)),
    start: orgRoute("POST", "/v1/doc-editor/assist", "Nhờ AI trên máy của tôi làm một việc với tài liệu", "knowledge")
      .input(assistStartInput)
      .output(docAssist),
  },
};
