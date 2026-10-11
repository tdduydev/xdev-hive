export interface TemplateInput {
  projectKey: string;
  projectName: string;
  /** Địa chỉ công khai của hub (HIVE_PUBLIC_URL), không có `/` cuối. */
  publicUrl: string;
  defaultBranch: string;
  systemName: string;
}

export interface TemplateFile {
  path: string;
  content: string;
}

export const TEMPLATE_ID = "xdev-standard";
export const TEMPLATE_VERSION = 2;

const agentsMd = (t: TemplateInput) => `# ${t.projectName}

<!-- Tạo bởi xDev Hive, mẫu ${TEMPLATE_ID} v${TEMPLATE_VERSION}. Sửa thoải mái; giữ project key cho đúng. -->

Hive project key: \`${t.projectKey}\`
Hệ thống: ${t.systemName}

## Cách làm việc

- Mỗi task chạy trên nhánh riêng \`ai/<task-id>\`, rồi mở PR vào \`${t.defaultBranch}\`. Không push thẳng vào \`${t.defaultBranch}\`.
- Đầu phiên, gọi \`task_get\` để đọc task, rồi \`memory_search\` với vài từ khoá của task để xem quyết định, quy ước
  và cái bẫy đã ghi. Trong run, tool tự dùng dự án \`${t.projectKey}\`; ngoài run truyền \`project: "${t.projectKey}"\`.
- Cần tài liệu thì \`doc_list\` (lọc \`prefix: "project/${t.projectKey}/"\`) rồi \`doc_get\`. Cần cách làm có sẵn thì
  \`skill_list\` rồi \`skill_get\`.
- Chốt một quyết định, gặp một cái bẫy, hay thống nhất một quy ước thì ghi ngay bằng \`memory_write\` (\`kind\`:
  decision, convention, gotcha, note). Mỗi memory một ý, kèm lý do và file liên quan.
- Tài liệu sai hoặc thiếu thì gọi \`doc_propose\` với \`baseVersion\` lấy từ \`doc_get\`; quản trị đội sẽ duyệt.
  Không sửa tài liệu của Hive bằng cách khác.
- Kết thúc, gọi \`task_update\` kèm tóm tắt việc đã làm và bằng chứng (lệnh test đã chạy, kết quả, còn vướng gì).

## MCP của Hive

Cấu hình trong \`.mcp.json\`. Token lấy từ biến môi trường \`HIVE_MCP_TOKEN\`; worker của Hive tự đặt khi chạy task.
Không chép token vào file trong repo.

## Quy ước của repo

Bổ sung tại đây: cách cài, cách chạy test, cấu trúc thư mục, quy tắc đặt tên.
`;

const claudeMd = () => "@AGENTS.md\n";

const mcpJson = (t: TemplateInput) =>
  `${JSON.stringify(
    {
      mcpServers: {
        "xdev-hive": {
          type: "http",
          url: `${t.publicUrl}/mcp`,
          // Claude Code và Codex đọc biến môi trường trong cấu hình MCP, nên token không nằm trong repo.
          // biome-ignore lint/suspicious/noTemplateCurlyInString: `${...}` là cú pháp biến môi trường của .mcp.json.
          headers: { Authorization: "Bearer ${HIVE_MCP_TOKEN}", "X-Hive-Project": t.projectKey },
        },
      },
    },
    null,
    2,
  )}\n`;

const readmeMd = (t: TemplateInput) => `# ${t.projectName}

Dự án \`${t.projectKey}\` thuộc hệ thống ${t.systemName}, quản lý trên xDev Hive (${t.publicUrl}).

Coding agent đọc hướng dẫn trong [AGENTS.md](AGENTS.md).
`;

/**
 * Render bộ file mẫu "xdev-standard". Hàm thuần: cùng đầu vào cho ra cùng nội dung, nên chạy lại bước
 * commit-template không tạo khác biệt, và snapshot test giữ cho mẫu không đổi ngoài ý muốn.
 */
export function renderTemplate(input: TemplateInput): TemplateFile[] {
  const t = { ...input, publicUrl: input.publicUrl.replace(/\/+$/, "") };
  return [
    { path: "AGENTS.md", content: agentsMd(t) },
    { path: "CLAUDE.md", content: claudeMd() },
    { path: ".mcp.json", content: mcpJson(t) },
    { path: "README.md", content: readmeMd(t) },
  ];
}
