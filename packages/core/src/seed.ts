export interface SeedDoc {
  key: string;
  title: string;
  includeInAgents: boolean;
  content: string;
}

export const SEED_DOCS: SeedDoc[] = [
  {
    key: "org/agent-protocol",
    title: "Agent protocol",
    includeInAgents: true,
    content: `## Agent protocol (xDev Hive)

Áp dụng cho mọi coding agent (Claude Code, Codex, Gemini, Cursor…) làm việc trong repo này.
Project key của repo nằm ở dòng "Hive project key" phía trên. Truyền nó vào tham số \`project\` của các tool \`xdev-hive\`.

1. Đầu phiên: gọi \`memory_search\` với chủ đề của task. Cần quy chuẩn chung thì dùng \`doc_list\` / \`doc_get\`.
2. Chỉ làm task đã \`task_claim\` thành công. Làm trên branch/worktree riêng \`ai/<task-id>\`.
3. Khi chốt quyết định, convention, hoặc gặp gotcha: gọi \`memory_write\` (ngắn gọn, mỗi mục một ý).
4. KHÔNG sửa trực tiếp \`AGENTS.md\`, \`CLAUDE.md\`, \`docs/decisions.md\`. Muốn đổi thì \`doc_get\` rồi \`doc_propose\` với \`baseVersion\` vừa đọc.
5. Kết thúc: \`task_update\` sang \`review\`, \`note\` ghi rõ đã làm / chưa làm / cách kiểm tra / rủi ro.
6. Không bao giờ ghi secret, token, mật khẩu vào memory hay tài liệu.`,
  },
];
