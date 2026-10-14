import { useArtifactsEnv } from "./env.tsx";

/*
 * Chữ của phiên bản, so sánh, chia sẻ và ô soạn (ArtifactVersions/ArtifactShare/ArtifactEditor.dc.html). Để riêng khỏi
 * `text.ts` vì T022 và T023 cũng thêm chữ và sửa chung một file sẽ xung đột khi gộp nhánh.
 */
export interface EditText {
  versionsTitle: string;
  versionsEmpty: string;
  loadError: string;
  retry: string;
  immutable: string;
  current: string;
  latest: string;
  open: string;
  rename: string;
  renameLabel: string;
  renameSave: string;
  cancel: string;
  restore: string;
  restoreTitle: (n: number) => string;
  restoreHelp: (next: number) => string;
  restoreConfirm: string;
  restored: (n: number) => string;
  renamed: string;
  restoredFrom: (n: number) => string;
  tombstoned: string;
  compileError: string;
  compare: string;
  compareFrom: string;
  compareTo: string;
  compareSame: string;
  compareDiff: string;
  compareSide: string;
  compareMode: string;
  legend: string;
  noChange: string;
  gap: (n: number) => string;
  originLabel: Record<string, string>;
  offline: string;

  shareTitle: string;
  shareScope: string;
  shareWho: string;
  scopePrivate: string;
  scopePrivateHelp: string;
  scopeProject: string;
  scopeProjectHelp: string;
  projectLabel: string;
  projectChoose: string;
  projectsLoading: string;
  historyWarning: (project: string) => string;
  ack: string;
  olderVersion: (viewing: number, latest: number) => string;
  shareSave: string;
  shared: string;
  publicSeparate: string;
  close: string;

  editorTitle: string;
  editorLabel: string;
  noteLabel: string;
  notePlaceholder: string;
  noteHint: string;
  save: string;
  saving: string;
  saved: string;
  preview: string;
  previewing: string;
  previewHint: string;
  previewTitle: string;
  previewCompile: string;
  draftNote: string;
  secret: (line: number, kind: string) => string;
  secretBody: string;
  secretJump: (line: number) => string;
  offlineSave: string;
  conflictTitle: (latest: number, base: number) => string;
  conflictBody: string;
  conflictDiff: string;
  conflictHide: string;
  conflictTakeTheirs: string;
  conflictKeepMine: string;
  conflictDrop: string;
  theirs: (n: number) => string;
  mine: (n: number) => string;
  tombstonedLatest: string;
  leaveTitle: string;
  leaveBody: string;
  leaveStay: string;
  leaveDiscard: string;
}

export const editText: Record<"vi" | "en", EditText> = {
  vi: {
    versionsTitle: "Lịch sử phiên bản",
    versionsEmpty: "Chưa có phiên bản để so sánh",
    loadError: "Không tải được dữ liệu. Kiểm tra kết nối rồi thử lại.",
    retry: "Thử lại",
    immutable: "Mỗi lần lưu tạo một phiên bản. Khôi phục giữ nguyên toàn bộ lịch sử.",
    current: "đang xem",
    latest: "mới nhất",
    open: "Mở",
    rename: "Đặt tên bản",
    renameLabel: "Tên phiên bản",
    renameSave: "Lưu tên",
    cancel: "Thôi",
    restore: "Khôi phục bản này",
    restoreTitle: (n) => `Khôi phục bản v${n}`,
    restoreHelp: (next) => `Tạo v${next} từ bản đã chọn; không xoá các phiên bản giữa.`,
    restoreConfirm: "Khôi phục",
    restored: (n) => `Đã tạo v${n} từ phiên bản đã chọn.`,
    renamed: "Đã lưu tên phiên bản.",
    restoredFrom: (n) => `Khôi phục từ v${n}`,
    tombstoned: "Phiên bản này đã bị xoá vì chứa bí mật.",
    compileError: "Lỗi biên dịch",
    compare: "So sánh",
    compareFrom: "Bản trước",
    compareTo: "Bản sau",
    compareSame: "Chọn hai phiên bản khác nhau để so sánh.",
    compareDiff: "Khác biệt",
    compareSide: "Cạnh nhau",
    compareMode: "Cách xem",
    legend: "Dấu −: dòng xoá · Dấu +: dòng thêm.",
    noChange: "Hai phiên bản giống nhau.",
    gap: (n) => `${n} dòng không đổi`,
    originLabel: { leader: "Leader", terminal: "Terminal", run: "Run", mcp: "MCP", manual: "Người sửa" },
    offline: "Đang offline — kết nối hub để dùng thao tác này.",

    shareTitle: "Chia sẻ",
    shareScope: "Ai được xem?",
    shareWho: "Phạm vi của artifact",
    scopePrivate: "Cá nhân",
    scopePrivateHelp: "Chỉ bạn. Quản trị tổ chức không đọc được.",
    scopeProject: "Dự án",
    scopeProjectHelp: "Thành viên đội của dự án đọc được; member trở lên sửa được.",
    projectLabel: "Dự án",
    projectChoose: "Chọn dự án…",
    projectsLoading: "Đang tải dự án…",
    historyWarning: (project) => `Mọi thành viên dự án ${project} sẽ thấy cả các phiên bản cũ.`,
    ack: "Tôi đã kiểm tra các phiên bản cũ.",
    olderVersion: (viewing, latest) =>
      `Bạn đang xem v${viewing}. Người được chia sẻ sẽ thấy bản mới nhất (v${latest}), không phải bản này.`,
    shareSave: "Lưu thay đổi",
    shared: "Đã đổi phạm vi.",
    publicSeparate: "Đổi phạm vi không thay đổi link công khai. Chỉ chủ artifact tạo được link.",
    close: "Đóng",

    editorTitle: "Sửa artifact",
    editorLabel: "Nội dung",
    noteLabel: "Ghi chú bản",
    notePlaceholder: "Ví dụ: thêm bước rollback",
    noteHint: "Tuỳ chọn, hiện trong lịch sử phiên bản.",
    save: "Lưu",
    saving: "Đang lưu…",
    saved: "Đã lưu.",
    preview: "Xem trước",
    previewing: "Đang dựng xem trước…",
    previewHint: 'Bấm "Xem trước" để chạy nội dung chưa lưu trong khung cách ly.',
    previewTitle: "Xem trước nội dung chưa lưu",
    previewCompile: "Lỗi biên dịch",
    draftNote: "Bản nháp giữ trong trình duyệt, không lưu lên hub.",
    secret: (line, kind) => `Có chuỗi giống bí mật ở dòng ${line} (${kind}).`,
    secretBody: "Xoá rồi lưu lại. Hub không lưu và không hiện lại chuỗi đó.",
    secretJump: (line) => `Tới dòng ${line}`,
    offlineSave: "Đang offline. Chưa lưu được; nối mạng lại rồi bấm Lưu. Bản nháp giữ trong trình duyệt.",
    conflictTitle: (latest, base) => `Artifact đã có v${latest} trong lúc bạn sửa từ v${base}.`,
    conflictBody: "Lưu đè sẽ làm mất thay đổi đó, nên hub chưa lưu bản của bạn.",
    conflictDiff: "Xem khác biệt rồi gộp",
    conflictHide: "Ẩn khác biệt",
    conflictTakeTheirs: "Lấy bản mới nhất làm gốc",
    conflictKeepMine: "Giữ của tôi, lưu thành bản kế tiếp",
    conflictDrop: "Bỏ thay đổi của tôi",
    theirs: (n) => `Bản mới nhất (v${n})`,
    mine: (n) => `Bản của bạn (từ v${n})`,
    tombstonedLatest: "Bản mới nhất đã bị xoá vì chứa bí mật nên không so sánh được.",
    leaveTitle: "Bỏ thay đổi chưa lưu?",
    leaveBody: "Bạn đã sửa nội dung nhưng chưa lưu. Rời đi thì bản nháp trong trình duyệt bị bỏ.",
    leaveStay: "Ở lại soạn",
    leaveDiscard: "Bỏ thay đổi",
  },
  en: {
    versionsTitle: "Version history",
    versionsEmpty: "No versions to compare",
    loadError: "Could not load data. Check your connection and retry.",
    retry: "Retry",
    immutable: "Each save creates a version. Restoring preserves the entire history.",
    current: "viewing",
    latest: "latest",
    open: "Open",
    rename: "Name version",
    renameLabel: "Version name",
    renameSave: "Save name",
    cancel: "Cancel",
    restore: "Restore this version",
    restoreTitle: (n) => `Restore v${n}`,
    restoreHelp: (next) => `Creates v${next} from the selected version; keeps intervening versions.`,
    restoreConfirm: "Restore",
    restored: (n) => `Created v${n} from the selected version.`,
    renamed: "Version name saved.",
    restoredFrom: (n) => `Restored from v${n}`,
    tombstoned: "This version was deleted because it contained a secret.",
    compileError: "Compile error",
    compare: "Compare",
    compareFrom: "Earlier version",
    compareTo: "Later version",
    compareSame: "Choose two different versions to compare.",
    compareDiff: "Differences",
    compareSide: "Side by side",
    compareMode: "View mode",
    legend: "−: removed line · +: added line.",
    noChange: "The two versions are identical.",
    gap: (n) => `${n} unchanged lines`,
    originLabel: { leader: "Leader", terminal: "Terminal", run: "Run", mcp: "MCP", manual: "Human edit" },
    offline: "Offline — connect to the hub to use this action.",

    shareTitle: "Share",
    shareScope: "Who can view?",
    shareWho: "Artifact scope",
    scopePrivate: "Private",
    scopePrivateHelp: "Only you. Organization admins cannot read it.",
    scopeProject: "Project",
    scopeProjectHelp: "The project team can read; members and above can edit.",
    projectLabel: "Project",
    projectChoose: "Choose a project…",
    projectsLoading: "Loading projects…",
    historyWarning: (project) => `All members of ${project} will see every previous version.`,
    ack: "I have reviewed previous versions.",
    olderVersion: (viewing, latest) =>
      `You are viewing v${viewing}. People it is shared with will see the latest version (v${latest}), not this one.`,
    shareSave: "Save changes",
    shared: "Scope changed.",
    publicSeparate: "Changing scope does not change public links. Only the owner can create links.",
    close: "Close",

    editorTitle: "Edit artifact",
    editorLabel: "Content",
    noteLabel: "Version note",
    notePlaceholder: "e.g. add rollback step",
    noteHint: "Optional; shown in version history.",
    save: "Save",
    saving: "Saving…",
    saved: "Saved.",
    preview: "Preview",
    previewing: "Building preview…",
    previewHint: 'Press "Preview" to run the unsaved content in the isolated frame.',
    previewTitle: "Preview of unsaved content",
    previewCompile: "Compile error",
    draftNote: "Draft stays in this browser, not saved to the hub.",
    secret: (line, kind) => `Text that looks like a secret on line ${line} (${kind}).`,
    secretBody: "Remove it and save again. The hub does not store or show it back.",
    secretJump: (line) => `Go to line ${line}`,
    offlineSave: "You are offline. Cannot save yet; reconnect, then press Save. The draft stays in this browser.",
    conflictTitle: (latest, base) => `The artifact got v${latest} while you were editing from v${base}.`,
    conflictBody: "Saving over it would lose that change, so the hub did not save yours.",
    conflictDiff: "Review differences and merge",
    conflictHide: "Hide differences",
    conflictTakeTheirs: "Start from the latest version",
    conflictKeepMine: "Keep mine, save as the next version",
    conflictDrop: "Discard my changes",
    theirs: (n) => `Latest (v${n})`,
    mine: (n) => `Yours (from v${n})`,
    tombstonedLatest: "The latest version was deleted because it contained a secret, so it cannot be compared.",
    leaveTitle: "Discard unsaved changes?",
    leaveBody: "You edited the content but have not saved it. Leaving discards the draft kept in this browser.",
    leaveStay: "Keep editing",
    leaveDiscard: "Discard changes",
  },
};

export function useEditText(): EditText {
  return editText[useArtifactsEnv().lang];
}
