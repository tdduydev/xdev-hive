import type { Dict } from "@/lib/i18n.ts";

export const knowledgeText: Dict<{
  docsTitle: string;
  docsLead: string;
  docsSearch: string;
  docsMcpNote: string;
  skillsLead: string;
  skillsSearch: string;
  memoryLead: string;
  memoryAdd: string;
  proposalsTitle: string;
  proposalsLead: string;
  proposalsSearch: string;
  proposalsReason: string;
  proposalsNote: string;
  proposalsNotePh: string;
  proposalsReject: string;
  knowledge: string;
  loading: string;
  empty: string;
  choose: string;
  retry: string;
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
  older: string;
  newer: string;
  pageNote: string;
  diff: string;
  noChanges: string;
}> = {
  vi: {
    docsTitle: "Tài liệu",
    docsLead: "Tài liệu markdown có phiên bản. Agent đọc qua MCP; người và agent đề xuất sửa.",
    docsSearch: "Tìm tiêu đề, key, người sửa…",
    docsMcpNote: "Agent đọc tài liệu này bằng",
    skillsLead: "Skill (SKILL.md) nạp cho agent khi chạy.",
    skillsSearch: "Tìm skill, mô tả, đường dẫn…",
    memoryLead: "Ghi nhớ ngắn của agent và người. Agent tìm qua memory_search trước khi làm.",
    memoryAdd: "Thêm memory",
    proposalsTitle: "Đề xuất sửa",
    proposalsLead: "Agent và thành viên đề xuất sửa tài liệu hoặc skill; quản trị đội duyệt.",
    proposalsSearch: "Tìm đích, lý do, người đề xuất…",
    proposalsReason: "Lý do:",
    proposalsNote: "Ghi chú khi duyệt",
    proposalsNotePh: "Không bắt buộc",
    proposalsReject: "Từ chối",
    knowledge: "Kiến thức",
    loading: "Đang tải…",
    empty: "Chưa có dữ liệu.",
    choose: "Chọn một dòng để xem nội dung.",
    retry: "Thử lại",
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
    older: "Trang dữ liệu sau",
    newer: "Trang dữ liệu trước",
    pageNote: "Số liệu trong trang đang tải",
    diff: "Thay đổi nội dung",
    noChanges: "Nội dung không đổi.",
  },
  en: {
    docsTitle: "Docs",
    docsLead: "Versioned markdown docs. Agents read them over MCP; people and agents propose edits.",
    docsSearch: "Search title, key, editor…",
    docsMcpNote: "Agents read this doc with",
    skillsLead: "Skills (SKILL.md) loaded into agent runs.",
    skillsSearch: "Search skill, description, path…",
    memoryLead: "Short notes from agents and people. Agents search them with memory_search before working.",
    memoryAdd: "Add memory",
    proposalsTitle: "Proposals",
    proposalsLead: "Agents and members propose edits to docs or skills; team admins decide.",
    proposalsSearch: "Search target, reason, author…",
    proposalsReason: "Reason:",
    proposalsNote: "Decision note",
    proposalsNotePh: "Optional",
    proposalsReject: "Reject",
    knowledge: "Knowledge",
    loading: "Loading…",
    empty: "No data yet.",
    choose: "Select a row to view its content.",
    retry: "Retry",
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
    older: "Next data page",
    newer: "Previous data page",
    pageNote: "Counts on the loaded page",
    diff: "Content changes",
    noChanges: "Content is unchanged.",
  },
};
