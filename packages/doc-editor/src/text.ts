import type {
  AssistAction,
  EditorStage,
  EditorStepState,
  GateKind,
  SdlcPhaseStatus,
  SdlcSyncState,
} from "@xdev-hive/contracts";
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
  insertImage: string;
  attachFile: string;
  uploading: (n: number) => string;
  uploadFailed: (name: string, reason: string) => string;
  dismiss: string;
  imageMissing: string;
  imageAlt: string;
  linkResolving: string;
  linkNone: string;
  openLinkedDoc: (key: string) => string;
  openLinkedAsset: string;
  openLinkedExternal: string;
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
    insertImage: "Chèn ảnh",
    attachFile: "Đính kèm file",
    uploading: (n) => (n > 1 ? `Đang tải lên ${n} file…` : "Đang tải lên…"),
    uploadFailed: (name, reason) => `Không tải lên được ${name}: ${reason}`,
    dismiss: "Đóng thông báo",
    imageMissing: "Chưa hiện được ảnh",
    imageAlt: "Mô tả ảnh",
    linkResolving: "Đang tìm liên kết…",
    linkNone: "Không tìm thấy đích của liên kết này",
    openLinkedDoc: (key) => `Mở tài liệu ${key}`,
    openLinkedAsset: "Mở file đính kèm",
    openLinkedExternal: "Mở trên repo",
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
    insertImage: "Insert image",
    attachFile: "Attach file",
    uploading: (n) => (n > 1 ? `Uploading ${n} files…` : "Uploading…"),
    uploadFailed: (name, reason) => `Could not upload ${name}: ${reason}`,
    dismiss: "Dismiss message",
    imageMissing: "Image cannot be shown",
    imageAlt: "Image description",
    linkResolving: "Resolving link…",
    linkNone: "This link has no target",
    openLinkedDoc: (key) => `Open document ${key}`,
    openLinkedAsset: "Open attachment",
    openLinkedExternal: "Open in repository",
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

/** Chữ của khung bên "Hạng mục" và thẻ AI SDLC trong ReviewPane (DocEditor.dc.html, DocReview.dc.html biến thể sdlc). */
export const sdlcPanelText: Dict<{
  tab: string;
  title: (ref: string, phase: string) => string;
  meta: (size: string, mode: string) => string;
  openItem: string;
  readOnly: string;
  roText: string;
  notFound: string;
  phaseStatus: Record<SdlcPhaseStatus, string>;
  runTitle: string;
  runText: string;
  openRun: string;
  waitTitle: string;
  errTitle: string;
  projects: string;
  role: Record<"home" | "participant", string>;
  disabled: string;
  stageTitle: string;
  stagesAria: string;
  stageState: Record<"done" | "now" | "todo", string>;
  gatesTitle: string;
  noGates: string;
  perTeam: (gates: string) => string;
  autoRule: (min: string, hours: number) => string;
  contractTitle: string;
  provider: string;
  consumers: string;
  contractNote: string;
  tplTitle: string;
  tplOpen: string;
  noTpl: string;
  reqTitle: string;
  reqMissing: string;
  reqPresent: string;
  qaTitle: string;
  qaNote: string;
  qaRecommended: string;
  noQa: string;
  syncTitle: string;
  syncState: Record<SdlcSyncState, string>;
  rewriteTitle: string;
  rewriteHint: string;
  rewriteNote: (step: string) => string;
  rewrite: string;
  rewriting: string;
  rewriteDone: string;
  noStep: string;
  autoTitle: string;
  autoBadge: (score: string, threshold: string) => string;
  autoShort: (score: string) => string;
  autoBy: string;
  revocableUntil: (at: string) => string;
  revokeOver: (at: string) => string;
  revoked: (by: string, reason: string) => string;
  notAuto: string;
  bdTitle: string;
  bdOpen: string;
}> = {
  vi: {
    tab: "Hạng mục",
    title: (ref, phase) => `Hạng mục ${ref} · ${phase}`,
    meta: (size, mode) => `cỡ ${size} · chế độ ${mode}`,
    openItem: "Mở hạng mục",
    readOnly: "Chỉ đọc",
    roText: "Bạn chỉ có quyền đọc hạng mục này, nên không có nút soạn lại.",
    notFound: "Tài liệu này không còn thuộc hạng mục nào.",
    phaseStatus: {
      pending: "Chưa tới",
      drafting: "Đang soạn",
      awaiting_answers: "Chờ trả lời",
      in_review: "Đang duyệt",
      approved: "Đã duyệt",
      skipped: "Bỏ qua",
    },
    runTitle: "Agent đang soạn",
    runText: "Bản mới hiện thành đề xuất, bạn nhận hoặc bỏ từng chỗ.",
    openRun: "Xem run",
    waitTitle: "Chờ máy AI SDLC",
    errTitle: "Agent không nộp tài liệu",
    projects: "Dự án",
    role: { home: "Dự án chính", participant: "Dự án tham gia" },
    disabled: "đã tắt AI SDLC",
    stageTitle: "Giai đoạn và cổng",
    stagesAria: "Giai đoạn của hạng mục",
    stageState: { done: "xong", now: "hiện tại", todo: "chưa tới" },
    gatesTitle: "Cổng của giai đoạn này",
    noGates: "Giai đoạn không có cổng: tài liệu thành baseline ngay khi lưu.",
    perTeam: (gates) => `Mỗi đội tham gia có một checkpoint riêng: ${gates}.`,
    autoRule: (min, hours) => `Tự duyệt khi AI chấm từ ${min}/10, thu hồi được trong ${hours} giờ.`,
    contractTitle: "Tài liệu thuộc contract",
    provider: "Bên cung cấp",
    consumers: "Bên dùng",
    contractNote: "Mỗi đội có một checkpoint người. Contract luôn cần người, không tự duyệt.",
    tplTitle: "Khuôn của chế độ",
    tplOpen: "Xem khuôn",
    noTpl: "Chế độ không có khuôn cho tài liệu này.",
    reqTitle: "Mục bắt buộc",
    reqMissing: "chưa có",
    reqPresent: "đã có",
    qaTitle: "Câu hỏi đã trả lời",
    qaNote: "Đã ghi vào mục Clarifications của tài liệu.",
    qaRecommended: "dùng đề xuất",
    noQa: "Chưa có câu hỏi nào được trả lời ở giai đoạn này.",
    syncTitle: "Đồng bộ repo",
    syncState: {
      none: "Chưa đồng bộ",
      pending: "Đang chờ đồng bộ",
      synced: "Đã đồng bộ",
      failed: "Lỗi đồng bộ",
      drifted: "Lệch repo",
      deleted: "Đã xoá trên repo",
    },
    rewriteTitle: "Chỉ dẫn cho agent (không bắt buộc)",
    rewriteHint: "Ví dụ: thêm mục ngoài phạm vi, giữ nguyên các câu đã trả lời",
    rewriteNote: (step) => `Agent đọc bản nháp và các câu đã trả lời. Chạy bước ${step}.`,
    rewrite: "Nhờ agent soạn lại",
    rewriting: "Đang gửi…",
    rewriteDone: "Đã giao cho agent. Bản mới hiện thành đề xuất khi xong.",
    noStep: "Giai đoạn này không có bước agent soạn tài liệu.",
    autoTitle: "Tự duyệt bởi AI",
    autoBadge: (score, threshold) => `Tự duyệt bởi AI · ${score}/10 (ngưỡng ${threshold})`,
    autoShort: (score) => `Tự duyệt bởi AI · ${score}/10`,
    autoBy: "AI tự duyệt",
    revocableUntil: (at) => `Thu hồi được tới ${at}`,
    revokeOver: (at) => `Hạn thu hồi đã qua: ${at}. Muốn đổi, tạo đề xuất sửa như thường.`,
    revoked: (by, reason) => `Đã thu hồi bởi ${by}: ${reason}`,
    notAuto: "Không tự duyệt",
    bdTitle: "Bản tách task",
    bdOpen: "Mở bản tách đầy đủ",
  },
  en: {
    tab: "Item",
    title: (ref, phase) => `Item ${ref} · ${phase}`,
    meta: (size, mode) => `size ${size} · ${mode} mode`,
    openItem: "Open item",
    readOnly: "Read-only",
    roText: "You can only read this item, so there is no rewrite button.",
    notFound: "This doc no longer belongs to an item.",
    phaseStatus: {
      pending: "Not started",
      drafting: "Drafting",
      awaiting_answers: "Awaiting answers",
      in_review: "In review",
      approved: "Approved",
      skipped: "Skipped",
    },
    runTitle: "Agent is drafting",
    runText: "The new version shows as suggestions you accept or reject.",
    openRun: "View run",
    waitTitle: "Waiting for an AI SDLC machine",
    errTitle: "The agent did not submit the document",
    projects: "Projects",
    role: { home: "Home project", participant: "Participant" },
    disabled: "AI SDLC off",
    stageTitle: "Stage and gates",
    stagesAria: "Item stages",
    stageState: { done: "done", now: "current", todo: "upcoming" },
    gatesTitle: "Gates of this stage",
    noGates: "This stage has no gate: the doc is baselined on save.",
    perTeam: (gates) => `Each participating team has its own checkpoint: ${gates}.`,
    autoRule: (min, hours) => `Auto-approved when the AI scores ${min}/10 or more; revocable for ${hours} h.`,
    contractTitle: "Document of a contract",
    provider: "Provider",
    consumers: "Consumers",
    contractNote: "Each team has a human checkpoint. Contracts always need a human, never auto-approved.",
    tplTitle: "Mode template",
    tplOpen: "View template",
    noTpl: "The mode has no template for this doc.",
    reqTitle: "Required sections",
    reqMissing: "missing",
    reqPresent: "present",
    qaTitle: "Answered questions",
    qaNote: "Written to the Clarifications section of the document.",
    qaRecommended: "used the recommendation",
    noQa: "No question has been answered in this stage yet.",
    syncTitle: "Repo sync",
    syncState: {
      none: "Not synced",
      pending: "Sync pending",
      synced: "In sync",
      failed: "Sync failed",
      drifted: "Repo drift",
      deleted: "Deleted in repo",
    },
    rewriteTitle: "Instructions for the agent (optional)",
    rewriteHint: "e.g. add an out-of-scope section, keep the answered questions",
    rewriteNote: (step) => `The agent reads the draft and the answered questions. Runs step ${step}.`,
    rewrite: "Ask the agent to rewrite",
    rewriting: "Sending…",
    rewriteDone: "Handed to the agent. The new version shows as suggestions when done.",
    noStep: "This stage has no agent step that drafts the doc.",
    autoTitle: "Auto-approved by AI",
    autoBadge: (score, threshold) => `Auto-approved by AI · ${score}/10 (threshold ${threshold})`,
    autoShort: (score) => `Auto-approved by AI · ${score}/10`,
    autoBy: "AI auto-approval",
    revocableUntil: (at) => `Can be revoked until ${at}`,
    revokeOver: (at) => `Revoke window ended: ${at}. To change it, make a normal suggestion.`,
    revoked: (by, reason) => `Revoked by ${by}: ${reason}`,
    notAuto: "Not auto-approved",
    bdTitle: "Task breakdown",
    bdOpen: "Open the full breakdown",
  },
};
