import type { AssistAction, EditorStage, EditorStepState, GateKind } from "@xdev-hive/contracts";
import type { BlockTemplate } from "./blocks.ts";

type Dict<T> = Record<"vi" | "en", T>;

/** Chữ của màn Soạn tài liệu (DocEditor.dc.html). */
export const docEditorText: Dict<{
  docs: string;
  loading: string;
  retry: string;
  stage: Record<EditorStage, string>;
  draftV: (n: number) => string;
  presence: string;
  editingNow: (n: number) => string;
  saving: string;
  saved: string;
  unsaved: string;
  readOnly: string;
  modeSuggest: string;
  modeEdit: string;
  submit: string;
  flow: string;
  flowName: (name: string) => string;
  noFlow: string;
  step: Record<EditorStepState, string>;
  toolbar: string;
  blockType: string;
  h1: string;
  h2: string;
  h3: string;
  para: string;
  bold: string;
  italic: string;
  strike: string;
  code: string;
  link: string;
  insert: Record<BlockTemplate, string>;
  insertHint: Partial<Record<BlockTemplate, string>>;
  comment: string;
  askAi: string;
  slash: string;
  blocks: string;
  writeAi: string;
  writeAiHint: string;
  emptyDoc: string;
  editorLabel: string;
  slashHint: string;
  language: string;
  languagePh: string;
  mermaidPreview: string;
  mermaidError: string;
  mermaidLoading: string;
  embedKey: string;
  embedBad: string;
  openEmbed: string;
  linkUrl: string;
  linkApply: string;
  unlink: string;
  selectionMenu: string;
  table: Record<"rowAdd" | "colAdd" | "rowDel" | "colDel" | "tableDel", string>;
  pendingEdits: (n: number) => string;
  sendSuggestions: string;
  discardEdits: string;
  suggestHint: string;
  suggestedBy: (name: string) => string;
  stale: string;
  accept: string;
  reject: string;
  newBlock: string;
  outdated: (v: number) => string;
  rebase: string;
  rebased: (n: number) => string;
  conflictMerged: string;
  tabComments: (n: number) => string;
  tabAi: string;
  tabHistory: string;
  noComments: string;
  quote: string;
  general: string;
  newComment: string;
  commentPh: string;
  send: string;
  reply: string;
  resolve: string;
  reopen: string;
  resolvedCount: (n: number) => string;
  detached: string;
  showResolved: string;
  hideResolved: string;
  aiMachine: string;
  aiNoMachine: string;
  aiOld: string;
  aiOffline: string;
  provider: string;
  aiPh: string;
  aiRun: string;
  aiNote: string;
  aiActions: Record<Exclude<AssistAction, "custom">, [string, string]>;
  aiHistory: string;
  aiResult: (s: number, c: number) => string;
  snapshotName: string;
  snapshotPh: string;
  snapshotCreate: string;
  noSnapshots: string;
  snapshotOf: (n: number) => string;
  compare: string;
  diffAgainst: string;
  close: string;
  submission: Record<string, string>;
  sbTitle: string;
  sbDesc: (v: number) => string;
  sbNoFlow: string;
  sbDiff: (a: number, d: number) => string;
  sbSkip: string;
  sbNote: string;
  cancel: string;
  sbGo: string;
  sbDone: string;
  kind: Record<GateKind, string>;
  inReview: string;
  changesNote: (note: string) => string;
  titleLabel: string;
  newDoc: string;
  newDocKey: string;
  newDocHint: string;
  open: string;
  edit: string;
}> = {
  vi: {
    docs: "Tài liệu",
    loading: "Đang tải…",
    retry: "Thử lại",
    stage: {
      drafting: "Đang soạn",
      in_review: "Đang duyệt",
      changes_requested: "Cần sửa",
      approved: "Đã duyệt",
    },
    draftV: (n) => `v${n} bản nháp`,
    presence: "Đang mở tài liệu",
    editingNow: (n) => `${n} người đang sửa`,
    saving: "Đang lưu…",
    saved: "Đã lưu",
    unsaved: "Chưa lưu",
    readOnly: "Chỉ đọc và bình luận",
    modeSuggest: "Chế độ: Đề xuất",
    modeEdit: "Chế độ: Sửa thẳng",
    submit: "Gửi duyệt",
    flow: "Quy trình duyệt",
    flowName: (name) => `Quy trình: ${name}`,
    noFlow: "Chưa có quy trình duyệt khớp tài liệu này: bản gửi chờ quản trị duyệt ở trang Đề xuất.",
    step: { done: "Đã qua", current: "Đang chờ", todo: "Chưa tới", failed: "Bị trả lại", skipped: "Bỏ qua" },
    toolbar: "Định dạng",
    blockType: "Kiểu khối",
    h1: "Tiêu đề 1",
    h2: "Tiêu đề 2",
    h3: "Tiêu đề 3",
    para: "Đoạn văn",
    bold: "Đậm",
    italic: "Nghiêng",
    strike: "Gạch ngang",
    code: "Code",
    link: "Liên kết",
    insert: {
      h1: "Tiêu đề 1",
      h2: "Tiêu đề",
      para: "Đoạn văn",
      bullet: "Danh sách",
      ordered: "Danh sách số",
      checklist: "Checklist",
      table: "Bảng",
      requirement: "Yêu cầu có mã",
      code: "Khối code",
      mermaid: "Sơ đồ Mermaid",
      callout: "Ghi chú nổi",
      embed: "Nhúng tài liệu",
    },
    insertHint: {
      h2: "Mục lớn",
      checklist: "Tiêu chí chấp nhận",
      table: "Yêu cầu, ma trận",
      requirement: "Tự đánh mã R-n",
      code: "Có tô màu cú pháp",
      mermaid: "Luồng, sequence, ER",
      embed: "Liên kết tới tài liệu khác",
    },
    comment: "Bình luận",
    askAi: "Hỏi AI",
    slash: "Chèn khối",
    blocks: "Khối cơ bản",
    writeAi: "Viết bằng AI",
    writeAiHint: "Dùng gói thuê bao trên máy của bạn",
    emptyDoc: "Tài liệu còn trống. Gõ / ở dòng mới để chèn tiêu đề, bảng, checklist…",
    editorLabel: "Nội dung tài liệu",
    slashHint: "Gõ / để chèn khối",
    language: "Ngôn ngữ của khối code",
    languagePh: "ngôn ngữ",
    mermaidPreview: "Xem trước sơ đồ",
    mermaidError: "Sơ đồ chưa vẽ được",
    mermaidLoading: "Đang vẽ sơ đồ…",
    embedKey: "Key tài liệu nhúng",
    embedBad: "Key dạng project/<dự án>/<tên>, chữ thường, số và . _ - /",
    openEmbed: "Mở",
    linkUrl: "Địa chỉ liên kết",
    linkApply: "Gắn",
    unlink: "Bỏ liên kết",
    selectionMenu: "Định dạng đoạn chọn",
    table: { rowAdd: "Thêm hàng", colAdd: "Thêm cột", rowDel: "Xoá hàng", colDel: "Xoá cột", tableDel: "Xoá bảng" },
    pendingEdits: (n) => `${n} chỗ sửa chưa gửi`,
    sendSuggestions: "Gửi đề xuất",
    discardEdits: "Bỏ chỗ sửa",
    suggestHint:
      "Đang ở chế độ đề xuất: sửa ngay trong tài liệu rồi bấm Gửi đề xuất, bản nháp không đổi cho tới khi được nhận.",
    suggestedBy: (name) => `${name} đề xuất sửa`,
    stale: "Đoạn gốc đã đổi, không nhận được nữa.",
    accept: "Nhận",
    reject: "Bỏ",
    newBlock: "Thêm khối mới",
    outdated: (v) => `Đã có bản v${v} được duyệt sau khi bản nháp này bắt đầu.`,
    rebase: "Gộp vào bản nháp",
    rebased: (n) => (n ? `Đã gộp; ${n} chỗ cả hai bên cùng sửa giữ theo bản nháp.` : "Đã gộp bản mới vào bản nháp."),
    conflictMerged: "Có người vừa lưu bản nháp; đã gộp thay đổi của hai bên.",
    tabComments: (n) => `Bình luận · ${n}`,
    tabAi: "AI",
    tabHistory: "Phiên bản",
    noComments: "Chưa có bình luận. Chọn chữ trong tài liệu rồi bấm Bình luận.",
    quote: "Đoạn trích",
    general: "Bình luận chung",
    newComment: "Bình luận mới",
    commentPh: "Viết bình luận…",
    send: "Gửi",
    reply: "Trả lời…",
    resolve: "Đóng",
    reopen: "Mở lại",
    resolvedCount: (n) => `${n} bình luận đã đóng`,
    detached: "Đoạn trích không còn trong bản nháp",
    showResolved: "Xem",
    hideResolved: "Ẩn",
    aiMachine: "Máy chạy",
    aiNoMachine: "Chưa có máy nào của bạn. Cài app xDev Hive trên máy để AI chạy bằng gói thuê bao của bạn.",
    aiOld: "cần cập nhật app",
    aiOffline: "offline",
    provider: "Nhà cung cấp",
    aiPh: "Ví dụ: viết phần rủi ro dựa trên runbook thanh toán",
    aiRun: "Nhờ AI",
    aiNote:
      "Mọi chỉnh sửa của AI hiện thành đề xuất để bạn nhận hoặc bỏ. Tốn lượt của gói thuê bao, không tốn ngân sách tổ chức.",
    aiActions: {
      continue: ["Viết tiếp đoạn này", "Theo giọng của tài liệu"],
      template: ["Kiểm đủ mục theo mẫu", "Báo mục còn thiếu"],
      acceptance: ["Sinh tiêu chí chấp nhận từ yêu cầu", "Mỗi R-n một tiêu chí"],
      crossref: ["Đối chiếu tài liệu liên quan", "Tài liệu đã duyệt và code trong repo"],
      translate: ["Dịch sang tiếng Anh", "Giữ thuật ngữ và mã R-n"],
    },
    aiHistory: "Lượt AI gần đây",
    aiResult: (s, c) => `${s} đề xuất · ${c} bình luận`,
    snapshotName: "Tên bản chụp",
    snapshotPh: "Ví dụ: Trước buổi họp với pháp chế",
    snapshotCreate: "Chụp bản nháp",
    noSnapshots: "Chưa có bản chụp nào.",
    snapshotOf: (n) => `Bản chụp #${n}`,
    compare: "So với bản nháp",
    diffAgainst: "Khác biệt giữa bản chụp và bản nháp hiện tại",
    close: "Đóng",
    submission: {
      pending: "Chờ duyệt tay",
      in_review: "Đang duyệt",
      changes_requested: "Bị trả lại",
      approved: "Đã duyệt",
      rejected: "Bị từ chối",
      cancelled: "Đã huỷ",
    },
    sbTitle: "Gửi bản nháp vào quy trình duyệt?",
    sbDesc: (v) => `Bản v${v} được chụp lại và khoá. Các checkpoint tiếp theo:`,
    sbNoFlow: "Không có quy trình duyệt khớp: bản gửi thành đề xuất chờ quản trị đội duyệt.",
    sbDiff: (a, d) => `+${a} −${d} dòng so với bản đã duyệt`,
    sbSkip: "bỏ qua",
    sbNote: "Ghi chú cho người duyệt",
    cancel: "Huỷ",
    sbGo: "Gửi duyệt",
    sbDone: "Đã gửi duyệt.",
    kind: { ai: "AI", human: "Người", rule: "Quy tắc", ext: "CI" },
    inReview: "Bản gửi đang được duyệt; bạn vẫn soạn tiếp được cho bản sau.",
    changesNote: (note) => `Người duyệt trả lại: ${note}`,
    titleLabel: "Tiêu đề tài liệu",
    newDoc: "Tài liệu mới",
    newDocKey: "Key tài liệu",
    newDocHint: "Dạng project/<dự án>/<tên>, team/<đội>/<tên> hoặc org/<tên>.",
    open: "Mở trình soạn",
    edit: "Soạn",
  },
  en: {
    docs: "Docs",
    loading: "Loading…",
    retry: "Retry",
    stage: {
      drafting: "Drafting",
      in_review: "In review",
      changes_requested: "Changes requested",
      approved: "Approved",
    },
    draftV: (n) => `v${n} draft`,
    presence: "Viewing now",
    editingNow: (n) => `${n} editing`,
    saving: "Saving…",
    saved: "Saved",
    unsaved: "Unsaved",
    readOnly: "Read and comment only",
    modeSuggest: "Mode: Suggesting",
    modeEdit: "Mode: Editing",
    submit: "Submit for review",
    flow: "Review workflow",
    flowName: (name) => `Workflow: ${name}`,
    noFlow: "No review workflow matches this doc: submissions wait for an admin on the Proposals page.",
    step: { done: "Passed", current: "Waiting", todo: "Not yet", failed: "Returned", skipped: "Skipped" },
    toolbar: "Formatting",
    blockType: "Block type",
    h1: "Heading 1",
    h2: "Heading 2",
    h3: "Heading 3",
    para: "Paragraph",
    bold: "Bold",
    italic: "Italic",
    strike: "Strike",
    code: "Code",
    link: "Link",
    insert: {
      h1: "Heading 1",
      h2: "Heading",
      para: "Paragraph",
      bullet: "Bullet list",
      ordered: "Numbered list",
      checklist: "Checklist",
      table: "Table",
      requirement: "Requirement with id",
      code: "Code block",
      mermaid: "Mermaid diagram",
      callout: "Callout",
      embed: "Embed doc",
    },
    insertHint: {
      h2: "Section",
      checklist: "Acceptance criteria",
      table: "Requirements matrix",
      requirement: "Auto-numbers R-n",
      code: "Syntax highlighted",
      mermaid: "Flow, sequence, ER",
      embed: "Link another doc",
    },
    comment: "Comment",
    askAi: "Ask AI",
    slash: "Insert block",
    blocks: "Basic blocks",
    writeAi: "Write with AI",
    writeAiHint: "Uses your subscription on your machine",
    emptyDoc: "The doc is empty. Type / on a new line to insert headings, tables, checklists…",
    editorLabel: "Doc content",
    slashHint: "Type / to insert a block",
    language: "Code block language",
    languagePh: "language",
    mermaidPreview: "Diagram preview",
    mermaidError: "The diagram could not be drawn",
    mermaidLoading: "Drawing diagram…",
    embedKey: "Embedded doc key",
    embedBad: "Keys look like project/<project>/<name>: lowercase letters, digits and . _ - /",
    openEmbed: "Open",
    linkUrl: "Link address",
    linkApply: "Apply",
    unlink: "Remove link",
    selectionMenu: "Format selection",
    table: {
      rowAdd: "Add row",
      colAdd: "Add column",
      rowDel: "Delete row",
      colDel: "Delete column",
      tableDel: "Delete table",
    },
    pendingEdits: (n) => `${n} unsent ${n === 1 ? "edit" : "edits"}`,
    sendSuggestions: "Send suggestions",
    discardEdits: "Discard edits",
    suggestHint:
      "Suggesting mode: edit right in the doc, then press Send suggestions; the draft changes only when they are accepted.",
    suggestedBy: (name) => `${name} suggests`,
    stale: "The original text changed; this can no longer be accepted.",
    accept: "Accept",
    reject: "Reject",
    newBlock: "Add a block",
    outdated: (v) => `v${v} was approved after this draft started.`,
    rebase: "Merge into draft",
    rebased: (n) =>
      n ? `Merged; ${n} spots edited on both sides kept the draft.` : "Merged the new version into the draft.",
    conflictMerged: "Someone just saved the draft; both sets of changes were merged.",
    tabComments: (n) => `Comments · ${n}`,
    tabAi: "AI",
    tabHistory: "Versions",
    noComments: "No comments yet. Select text in the doc, then press Comment.",
    quote: "Quote",
    general: "General comment",
    newComment: "New comment",
    commentPh: "Write a comment…",
    send: "Send",
    reply: "Reply…",
    resolve: "Resolve",
    reopen: "Reopen",
    resolvedCount: (n) => `${n} resolved comments`,
    detached: "The quote is no longer in the draft",
    showResolved: "Show",
    hideResolved: "Hide",
    aiMachine: "Machine",
    aiNoMachine: "You have no machine yet. Install the xDev Hive app so AI runs on your own subscription.",
    aiOld: "needs app update",
    aiOffline: "offline",
    provider: "Provider",
    aiPh: "e.g. write the risks section from the payments runbook",
    aiRun: "Ask AI",
    aiNote:
      "AI edits show as suggestions you accept or reject. They use your subscription, not the organization budget.",
    aiActions: {
      continue: ["Continue writing", "Matches the doc voice"],
      template: ["Check against the template", "Lists missing sections"],
      acceptance: ["Draft acceptance criteria", "One per R-n"],
      crossref: ["Cross-check related docs", "Approved docs and the repo code"],
      translate: ["Translate to English", "Keeps terms and R-n ids"],
    },
    aiHistory: "Recent AI runs",
    aiResult: (s, c) => `${s} suggestions · ${c} comments`,
    snapshotName: "Snapshot name",
    snapshotPh: "e.g. Before the legal meeting",
    snapshotCreate: "Snapshot draft",
    noSnapshots: "No snapshots yet.",
    snapshotOf: (n) => `Snapshot #${n}`,
    compare: "Compare with draft",
    diffAgainst: "Changes between the snapshot and the current draft",
    close: "Close",
    submission: {
      pending: "Awaiting admin",
      in_review: "In review",
      changes_requested: "Returned",
      approved: "Approved",
      rejected: "Rejected",
      cancelled: "Cancelled",
    },
    sbTitle: "Submit the draft for review?",
    sbDesc: (v) => `v${v} is snapshotted and frozen. Next checkpoints:`,
    sbNoFlow: "No workflow matches: the submission becomes a proposal for a team admin.",
    sbDiff: (a, d) => `+${a} −${d} lines against the approved version`,
    sbSkip: "skipped",
    sbNote: "Note for reviewers",
    cancel: "Cancel",
    sbGo: "Submit",
    sbDone: "Submitted for review.",
    kind: { ai: "AI", human: "Human", rule: "Rule", ext: "CI" },
    inReview: "The submission is in review; you can keep drafting the next version.",
    changesNote: (note) => `Returned by the reviewer: ${note}`,
    titleLabel: "Doc title",
    newDoc: "New doc",
    newDocKey: "Doc key",
    newDocHint: "Like project/<project>/<name>, team/<team>/<name> or org/<name>.",
    open: "Open editor",
    edit: "Edit",
  },
};
