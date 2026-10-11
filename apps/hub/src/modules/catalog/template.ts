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
export const TEMPLATE_VERSION = 1;

const agentsMd = (t: TemplateInput) => `# ${t.projectName}

<!-- Tạo bởi xDev Hive, mẫu ${TEMPLATE_ID} v${TEMPLATE_VERSION}. Sửa thoải mái; giữ project key cho đúng. -->

Hive project key: \`${t.projectKey}\`
Hệ thống: ${t.systemName}

## Cách làm việc

- Mỗi task chạy trên nhánh riêng \`ai/<task-id>\`, rồi mở PR vào \`${t.defaultBranch}\`. Không push thẳng vào \`${t.defaultBranch}\`.
- Đầu task, gọi MCP \`memory_search\` với project key \`${t.projectKey}\` để xem quyết định và ghi chú đã có.
- Cuối task, gọi MCP \`task_update\` kèm tóm tắt việc đã làm và bằng chứng (lệnh test đã chạy, kết quả).
- Điều gì đáng nhớ cho lần sau (quyết định, cái bẫy, lệnh hay dùng) thì ghi bằng \`memory_add\`.

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
