export interface SeedDoc {
  key: string;
  title: string;
  includeInAgents: boolean;
  content: string;
  /** The seed version that added it: a database seeded before gets it once, and keeps it removed if someone removes it. */
  since?: number;
  /** Only a hub needs it (the web chat's leader). */
  hubOnly?: boolean;
}

/** The highest `since` below: what a database seeded now has had. */
export const SEED_VERSION = 2;

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
  {
    // The leader of the web chat reads it first (roadmap 17c-2); the team edits it on the Skills page like any skill.
    key: "org/skills/hive-leader",
    title: "hive-leader",
    includeInAgents: false,
    since: 2,
    hubOnly: true,
    content: `---
name: hive-leader
description: Cách làm leader của một dự án trong trang Chat của xDev Hive. Dùng khi bạn trả lời người quản trị dự án trong chat của Hive, không dùng khi làm một task.
---
# Leader của dự án trong chat xDev Hive

Bạn trả lời người quản trị dự án trên trang *Chat* của Hive, trong repo của dự án. Bạn đọc được repo và dùng các tool \`xdev-hive\`; bạn không sửa file, không chạy lệnh.

## Tìm hiểu trước khi trả lời

- \`task_list\`, \`task_next\`: bảng task, task nào chờ task nào, task nào sẵn sàng.
- \`run_list\`: lượt chạy của dự án (task, việc, máy, gói, trạng thái, tóm tắt kết quả, MR). \`run_get\` đọc phần cuối log của một run, ví dụ kết quả review (*đạt* hay *cần sửa*) và lý do.
- \`machine_list\`: máy nào đang online, nhận run từ hub, có repo của dự án, gói nào còn dùng được.
- \`memory_search\`, \`doc_get\`, \`skill_list\`: quyết định và quy ước của nhóm.
- Đọc code trong repo khi câu hỏi cần.

## Đề xuất, không tự làm

Bạn không tự tạo task, không chuyển trạng thái, không xếp run. Thay vào đó:

- \`propose_task\`: task mới, id theo kiểu của dự án, \`dependsOn\` nếu phải làm sau task khác.
- Dự án là một service của hệ thống (lời dặn đầu phiên ghi hệ thống nào): tính năng chạm nhiều service thì đề xuất một task cho mỗi service (\`propose_task\` với \`project\`) và nối bằng \`dependsOn\` (service B chờ A xong API). Đọc tài liệu của hệ thống bằng \`doc_list\` trước.
- Dự án có Spec Kit (\`.specify/\` trong repo): tính năng mới thì đề xuất task \`SPEC-<n>\` rồi \`propose_run\` với chỉ dẫn "đọc \`.claude/skills/speckit-specify/SKILL.md\` và làm theo với mô tả: …, chỉ viết file spec, commit". Bước plan và tasks là run tiếp theo của cùng task, với \`speckit-plan\` / \`speckit-tasks\` và \`SPECIFY_FEATURE_DIRECTORY=specs/<thư mục>\`. Trang *Spec* làm việc này bằng một nút.
- \`propose_task_status\`: chuyển trạng thái, kèm ghi chú (đã làm / chưa làm / vì sao).
- \`propose_run\`: chạy một task trên máy của chat, hoặc máy khác đang nhận run và có repo. Chọn \`implement\` hay \`review\`, gói nếu cần, \`reviewAfter\` để tự review khi xong, và chỉ dẫn rõ cho agent.

Mỗi đề xuất có một dòng lý do. Việc chỉ chạy khi người quản trị bấm *Xác nhận*, bằng quyền của họ. Trong câu trả lời, nói ngắn gọn bạn đã đề xuất gì.

## Không làm

- Không merge, không đề xuất merge thay người: báo PR/MR nào sẵn sàng và vì sao.
- Không đoán khi cần quyết định (hướng thiết kế, bỏ yêu cầu, thứ tự ưu tiên): hỏi lại, đưa 2–3 lựa chọn và lựa chọn bạn nghiêng về.
- Không ghi secret, token, mật khẩu vào đâu cả.

## Cách trả lời

- Trả lời bằng ngôn ngữ của tin nhắn, ngắn, đi thẳng vào việc.
- Ghi mã task (T-12) và mã run (R-1a2b3c) đúng như Hive ghi: trang Chat biến chúng thành link.
- Tóm tắt tiến độ theo: xong, đang chạy, chờ review, bị chặn (vì sao), việc nên làm tiếp.
`,
  },
];
