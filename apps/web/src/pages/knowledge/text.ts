import type { Dict } from "@/lib/i18n.ts";

export const knowledgeText: Dict<{
  docsTitle: string;
  docsLead: string;
  docsWordImports: string;
  docsSearch: string;
  docsMcpNote: string;
  skillsLead: string;
  skillsSearch: string;
  skillsLearned: string;
  skillsViews: string;
  memoryLead: string;
  memoryAdd: string;
  proposalsTitle: string;
  proposalsLead: string;
  proposalsSearch: string;
  proposalsReason: string;
  proposalsNote: string;
  proposalsNotePh: string;
  proposalsReject: string;
  loading: string;
  scope: string;
  org: string;
  team: string;
  project: string;
  version: string;
  updated: string;
  author: string;
  content: string;
  kind: string;
  files: string;
  save: string;
  cancel: string;
  replace: string;
  decision: string;
  convention: string;
  gotcha: string;
  note: string;
  status: string;
  pending: string;
  approved: string;
  rejected: string;
  all: string;
  searchMemory: string;
  search: string;
  current: string;
  superseded: string;
  includeOld: string;
  matchedBy: string;
  text: string;
  vector: string;
  score: string;
  inGit: string;
  hubOnly: string;
  hubOnlyHint: string;
  approve: string;
  original: string;
  proposed: string;
  history: string;
  copy: string;
  copied: string;
  copyFailed: string;
  diff: string;
  noChanges: string;
  memoryDiscard: string;
  pendingEmpty: string;
  pendingHint: string;
  memoryViews: string;
  byRun: string;
  choose: string;
  docsEmptyTitle: string;
  docsEmptyBody: string;
  skillsOrgTitle: string;
  skillsOrgLead: string;
  skillsEmptyTitle: string;
  skillsEmptyBody: string;
  includeOldSearch: string;
  noResults: string;
  noResultsHint: string;
  memoryEmptyTitle: string;
  memoryEmptyBody: string;
  noRows: string;
  rows: (from: number, to: number) => string;
  open: string;
  saving: string;
  pendingEmptyHint: string;
  discardTitle: string;
  keep: string;
  discardConfirm: string;
  proposalsViews: string;
  proposedAt: string;
  proposalsNoPending: string;
  proposalsNoPendingHint: string;
  proposalsNone: string;
  proposalsNoneHint: string;
  proposalsReasonTitle: string;
  skillMissing: string;
  notFound: string;
  backToList: string;
  changesTab: string;
  overview: string;
  learnedTab: string;
  versionsTab: string;
  proposalViews: string;
  skillViews: string;
  proposalHistoryLead: (target: string) => string;
  proposalHistoryEmpty: string;
  thisProposal: string;
  decidedAt: string;
  decidedBy: string;
  learnedLead: string;
  learnedEmpty: string;
  learnedEmptyHint: string;
  versionPick: string;
  versionsLead: string;
  path: string;
  filesTitle: string;
  supersededBy: string;
  memoryOf: (kind: string) => string;
}> = {
  vi: {
    choose: "Chọn một dòng để xem nội dung.",
    docsEmptyTitle: "Chưa có tài liệu nào",
    docsEmptyBody: "Tài liệu hiện ở đây khi bản đầu tiên được duyệt. Bấm Tài liệu mới để bắt đầu viết.",
    skillsOrgTitle: "Skill của tổ chức",
    skillsOrgLead: "Skill của tổ chức, đội và dự án; agent nạp theo phạm vi của run.",
    skillsEmptyTitle: "Chưa có skill của tổ chức",
    skillsEmptyBody: "Skill trong kho Git hay do agent đề xuất và được duyệt sẽ hiện ở đây.",
    includeOldSearch: "Tìm kiếm chỉ trả memory hiện hành.",
    noResults: "Không có memory nào khớp",
    noResultsHint: "Thử từ khoá khác hoặc xoá tìm kiếm để xem cả danh sách.",
    memoryEmptyTitle: "Chưa có memory nào",
    memoryEmptyBody: "Memory đã duyệt hiện ở đây. Thêm memory đầu tiên hoặc chờ agent đề xuất.",
    noRows: "Không có dòng nào",
    rows: (from, to) => `Dòng ${from}–${to}`,
    open: "Mở",
    saving: "Đang lưu…",
    pendingEmptyHint: "Khi agent đề xuất một memory mới, nó chờ ở đây cho tới khi có người duyệt.",
    discardTitle: "Bỏ memory này?",
    keep: "Giữ lại",
    discardConfirm: "Bỏ memory",
    proposalsViews: "Trạng thái đề xuất",
    proposedAt: "Đề xuất lúc",
    proposalsNoPending: "Không có đề xuất nào đang chờ",
    proposalsNoPendingHint: "Đề xuất sửa tài liệu hoặc skill của agent và thành viên sẽ hiện ở đây để duyệt.",
    proposalsNone: "Chưa có đề xuất nào",
    proposalsNoneHint: "Đề xuất đã được xử lý theo trạng thái này sẽ hiện ở đây.",
    proposalsReasonTitle: "Lý do",
    skillMissing: "Không tìm thấy skill gốc của đề xuất này.",
    docsTitle: "Tài liệu",
    docsLead: "Tài liệu markdown có phiên bản. Agent đọc qua MCP; người và agent đề xuất sửa.",
    docsWordImports: "Lượt nhập Word",
    docsSearch: "Tìm tiêu đề, key, người sửa…",
    docsMcpNote: "Agent đọc tài liệu này bằng",
    skillsLead: "Skill (SKILL.md) nạp cho agent khi chạy.",
    skillsSearch: "Tìm skill, mô tả, đường dẫn…",
    skillsLearned: "Đề xuất từ agent",
    skillsViews: "Skill và đề xuất từ agent",
    memoryLead: "Ghi nhớ ngắn của agent và người. Agent tìm qua memory_search trước khi làm.",
    memoryAdd: "Thêm memory",
    proposalsTitle: "Đề xuất sửa",
    proposalsLead: "Agent và thành viên đề xuất sửa tài liệu hoặc skill; quản trị đội duyệt.",
    proposalsSearch: "Tìm đích, lý do, người đề xuất…",
    proposalsReason: "Lý do:",
    proposalsNote: "Ghi chú khi duyệt",
    proposalsNotePh: "Không bắt buộc",
    proposalsReject: "Từ chối",
    loading: "Đang tải…",
    scope: "Phạm vi",
    org: "Tổ chức",
    team: "Đội",
    project: "Dự án",
    version: "Bản",
    updated: "Cập nhật",
    author: "Người ghi",
    content: "Nội dung",
    kind: "Loại",
    files: "File liên quan (mỗi dòng một đường dẫn)",
    save: "Lưu",
    cancel: "Huỷ",
    replace: "Thay memory",
    decision: "Quyết định",
    convention: "Quy ước",
    gotcha: "Bẫy đã gặp",
    note: "Ghi chú",
    status: "Trạng thái",
    pending: "Chờ duyệt",
    approved: "Đã duyệt",
    rejected: "Bị từ chối",
    all: "Tất cả",
    searchMemory: "Tìm theo từ và theo nghĩa…",
    search: "Tìm",
    current: "Hiện hành",
    superseded: "Đã cũ",
    includeOld: "Hiện memory đã cũ",
    matchedBy: "Khớp theo",
    text: "Từ",
    vector: "Nghĩa",
    score: "Điểm",
    inGit: "Trong Git",
    hubOnly: "Chỉ trên hub",
    hubOnlyHint: "Chỉ có trên hub; lần đồng bộ kế tiếp sẽ đưa vào kho Git nếu tổ chức đã kết nối kho.",
    approve: "Duyệt",
    original: "Bản gốc",
    proposed: "Bản đề xuất",
    history: "Lịch sử",
    copy: "Chép lệnh MCP",
    copied: "Đã chép",
    copyFailed: "Không chép được. Hãy chép lệnh bên dưới.",
    diff: "Thay đổi nội dung",
    noChanges: "Nội dung không đổi.",
    memoryDiscard: "Bỏ",
    pendingEmpty: "Không có memory nào chờ duyệt.",
    pendingHint: "Memory do agent đề xuất. Chỉ khi được duyệt, agent mới tìm thấy nó qua memory_search.",
    memoryViews: "Danh sách memory",
    byRun: "Run",
    notFound: "Không tìm thấy mục này. Có thể nó đã bị xoá hoặc bạn không có quyền xem.",
    backToList: "Về danh sách",
    changesTab: "Thay đổi",
    overview: "Tổng quan",
    learnedTab: "Học được",
    versionsTab: "Phiên bản",
    proposalViews: "Phần của đề xuất",
    skillViews: "Phần của skill",
    proposalHistoryLead: (target) => `Mọi đề xuất cho ${target}, mới nhất trước.`,
    proposalHistoryEmpty: "Chưa có đề xuất nào khác cho đích này.",
    thisProposal: "Đề xuất đang xem",
    decidedAt: "Quyết định lúc",
    decidedBy: "Người quyết định",
    learnedLead: "Agent đề xuất sửa skill này sau các run; duyệt ở tab Đề xuất từ agent của trang Skills.",
    learnedEmpty: "Chưa có đề xuất nào từ agent",
    learnedEmptyHint: "Khi agent thấy skill này cần sửa sau một run, đề xuất của nó hiện ở đây.",
    versionPick: "Xem bản",
    versionsLead: "Nội dung SKILL.md của từng bản đã lưu.",
    path: "Đường dẫn",
    filesTitle: "File liên quan",
    supersededBy: "Đã thay bằng",
    memoryOf: (kind) => `Memory · ${kind}`,
  },
  en: {
    choose: "Select a row to view its content.",
    docsEmptyTitle: "No docs yet",
    docsEmptyBody: "A doc shows up here once its first version is approved. Use New doc to start writing.",
    skillsOrgTitle: "Organization skills",
    skillsOrgLead: "Skills of the organization, teams and projects; agents load them by the run's scope.",
    skillsEmptyTitle: "No organization skills yet",
    skillsEmptyBody: "Skills in the Git repository, or proposed by agents and approved, show up here.",
    includeOldSearch: "Search only returns current memories.",
    noResults: "No memory matches",
    noResultsHint: "Try another keyword, or clear the search to see the whole list.",
    memoryEmptyTitle: "No memories yet",
    memoryEmptyBody: "Approved memories show up here. Add the first one or wait for an agent to propose one.",
    noRows: "No rows",
    rows: (from, to) => `Rows ${from}–${to}`,
    open: "Open",
    saving: "Saving…",
    pendingEmptyHint: "When an agent proposes a new memory it waits here until someone approves it.",
    discardTitle: "Discard this memory?",
    keep: "Keep it",
    discardConfirm: "Discard memory",
    proposalsViews: "Proposal status",
    proposedAt: "Proposed",
    proposalsNoPending: "No proposals waiting",
    proposalsNoPendingHint: "Edits to docs or skills proposed by agents and members show up here for review.",
    proposalsNone: "No proposals yet",
    proposalsNoneHint: "Proposals decided with this status show up here.",
    proposalsReasonTitle: "Reason",
    skillMissing: "The proposal's original skill was not found.",
    docsTitle: "Docs",
    docsLead: "Versioned markdown docs. Agents read them over MCP; people and agents propose edits.",
    docsWordImports: "Word imports",
    docsSearch: "Search title, key, editor…",
    docsMcpNote: "Agents read this doc with",
    skillsLead: "Skills (SKILL.md) loaded into agent runs.",
    skillsSearch: "Search skill, description, path…",
    skillsLearned: "Agent proposals",
    skillsViews: "Skills and agent proposals",
    memoryLead: "Short notes from agents and people. Agents search them with memory_search before working.",
    memoryAdd: "Add memory",
    proposalsTitle: "Proposals",
    proposalsLead: "Agents and members propose edits to docs or skills; team admins decide.",
    proposalsSearch: "Search target, reason, author…",
    proposalsReason: "Reason:",
    proposalsNote: "Decision note",
    proposalsNotePh: "Optional",
    proposalsReject: "Reject",
    loading: "Loading…",
    scope: "Scope",
    org: "Organization",
    team: "Team",
    project: "Project",
    version: "Version",
    updated: "Updated",
    author: "Author",
    content: "Content",
    kind: "Kind",
    files: "Related files (one path per line)",
    save: "Save",
    cancel: "Cancel",
    replace: "Replace memory",
    decision: "Decision",
    convention: "Convention",
    gotcha: "Gotcha",
    note: "Note",
    status: "Status",
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
    all: "All",
    searchMemory: "Search by words and meaning…",
    search: "Search",
    current: "Current",
    superseded: "Superseded",
    includeOld: "Show superseded memories",
    matchedBy: "Matched by",
    text: "Words",
    vector: "Meaning",
    score: "Score",
    inGit: "In Git",
    hubOnly: "Hub only",
    hubOnlyHint: "Only on the hub; the next sync pushes it to the Git repository if one is connected.",
    approve: "Approve",
    original: "Original",
    proposed: "Proposed",
    history: "History",
    copy: "Copy MCP call",
    copied: "Copied",
    copyFailed: "Could not copy. Copy the command below.",
    diff: "Content changes",
    noChanges: "Content is unchanged.",
    memoryDiscard: "Discard",
    pendingEmpty: "No memories waiting for approval.",
    pendingHint: "Memories proposed by agents. Agents find them through memory_search only after approval.",
    memoryViews: "Memory lists",
    byRun: "Run",
    notFound: "This item was not found. It may have been removed, or you may not have access to it.",
    backToList: "Back to the list",
    changesTab: "Changes",
    overview: "Overview",
    learnedTab: "Learned",
    versionsTab: "Versions",
    proposalViews: "Proposal sections",
    skillViews: "Skill sections",
    proposalHistoryLead: (target) => `Every proposal for ${target}, newest first.`,
    proposalHistoryEmpty: "No other proposals for this target yet.",
    thisProposal: "This proposal",
    decidedAt: "Decided",
    decidedBy: "Decided by",
    learnedLead: "Edits agents proposed for this skill after runs; review them in the Agent proposals tab of Skills.",
    learnedEmpty: "No agent proposals yet",
    learnedEmptyHint: "When an agent finds this skill needs an edit after a run, its proposal shows up here.",
    versionPick: "Show version",
    versionsLead: "SKILL.md content of each saved version.",
    path: "Path",
    filesTitle: "Related files",
    supersededBy: "Replaced by",
    memoryOf: (kind) => `Memory · ${kind}`,
  },
};
