import type { InstructionTemplates } from "@xdev-hive/contracts";

/** Giá trị điền vào mẫu file hướng dẫn agent của một dự án. */
export interface TemplateVars {
  projectKey: string;
  projectName: string;
  /** Địa chỉ công khai của hub (HIVE_PUBLIC_URL), có hay không có `/` cuối đều được. */
  publicUrl: string;
  defaultBranch: string;
  systemName: string;
}

export interface InstructionFile {
  path: "AGENTS.md" | "CLAUDE.md" | ".mcp.json";
  content: string;
}

/**
 * Mẫu chuẩn "xdev-standard" v2 viết bằng biến, để quản trị thấy và sửa được đúng chữ hub sẽ commit (Policies.dc.html).
 * Điền biến cho ra đúng nội dung của mẫu trước khi có chính sách (snapshot ở catalog/template.test.ts giữ điều đó).
 */
export const DEFAULT_TEMPLATES: { [K in keyof InstructionTemplates]: string } = {
  agents: `# {{project.name}}

<!-- Tạo bởi xDev Hive, mẫu xdev-standard v2. Sửa thoải mái; giữ project key cho đúng. -->

Hive project key: \`{{project.key}}\`
Hệ thống: {{system.name}}

## Cách làm việc

- Mỗi task chạy trên nhánh riêng \`ai/<task-id>\`, rồi mở PR vào \`{{project.branch}}\`. Không push thẳng vào \`{{project.branch}}\`.
- Đầu phiên, gọi \`task_get\` để đọc task, rồi \`memory_search\` với vài từ khoá của task để xem quyết định, quy ước
  và cái bẫy đã ghi. Trong run, tool tự dùng dự án \`{{project.key}}\`; ngoài run truyền \`project: "{{project.key}}"\`.
- Cần tài liệu thì \`doc_list\` (lọc \`prefix: "project/{{project.key}}/"\`) rồi \`doc_get\`. Cần cách làm có sẵn thì
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
`,
  claude: "@AGENTS.md\n",
  mcp: `${JSON.stringify(
    {
      mcpServers: {
        "xdev-hive": {
          type: "http",
          url: "{{mcp.url}}",
          // Claude Code và Codex đọc biến môi trường trong cấu hình MCP, nên token không nằm trong repo.
          // biome-ignore lint/suspicious/noTemplateCurlyInString: `${...}` là cú pháp biến môi trường của .mcp.json.
          headers: { Authorization: "Bearer ${HIVE_MCP_TOKEN}", "X-Hive-Project": "{{project.key}}" },
        },
      },
    },
    null,
    2,
  )}\n`,
};

export const TEMPLATE_VARIABLES = ["project.name", "project.key", "project.branch", "system.name", "mcp.url"] as const;

/** Thay `{{biến}}` đã biết; biến lạ giữ nguyên để người sửa mẫu thấy mình gõ sai trong bản xem trước. */
export function fillTemplate(text: string, vars: TemplateVars): string {
  const base = vars.publicUrl.replace(/\/+$/, "");
  const values: Record<(typeof TEMPLATE_VARIABLES)[number], string> = {
    "project.name": vars.projectName,
    "project.key": vars.projectKey,
    "project.branch": vars.defaultBranch,
    "system.name": vars.systemName,
    "mcp.url": `${base}/mcp`,
  };
  return text.replace(/\{\{\s*([a-z.]+)\s*\}\}/g, (all, name: string) =>
    name in values ? values[name as keyof typeof values] : all,
  );
}

/** File hướng dẫn agent của dự án theo mẫu của tổ chức; mẫu null là mẫu chuẩn. */
export function instructionFiles(templates: InstructionTemplates, vars: TemplateVars): InstructionFile[] {
  return [
    { path: "AGENTS.md", content: fillTemplate(templates.agents ?? DEFAULT_TEMPLATES.agents, vars) },
    { path: "CLAUDE.md", content: fillTemplate(templates.claude ?? DEFAULT_TEMPLATES.claude, vars) },
    { path: ".mcp.json", content: fillTemplate(templates.mcp ?? DEFAULT_TEMPLATES.mcp, vars) },
  ];
}

/** Mẫu .mcp.json phải ra JSON hợp lệ sau khi điền biến, không thì CLI bỏ qua cả file. */
export function mcpTemplateError(text: string | null): string | null {
  if (text === null) return null;
  try {
    JSON.parse(
      fillTemplate(text, {
        projectKey: "mau",
        projectName: "Mẫu",
        publicUrl: "https://hive.example",
        defaultBranch: "main",
        systemName: "Mẫu",
      }),
    );
    return null;
  } catch (e) {
    return `Mẫu .mcp.json không phải JSON hợp lệ: ${e instanceof Error ? e.message : String(e)}`;
  }
}
