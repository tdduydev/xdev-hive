import type { InstructionTemplates } from "@xdev-hive/contracts";
import { instructionFiles } from "../governance/index.ts";

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

const readmeMd = (t: TemplateInput) => `# ${t.projectName}

Dự án \`${t.projectKey}\` thuộc hệ thống ${t.systemName}, quản lý trên xDev Hive (${t.publicUrl}).

Coding agent đọc hướng dẫn trong [AGENTS.md](AGENTS.md).
`;

/**
 * Render bộ file mẫu "xdev-standard": file hướng dẫn agent theo mẫu của tổ chức (Chính sách agent, mẫu null là mẫu
 * chuẩn) và README. Hàm thuần: cùng đầu vào cho ra cùng nội dung, nên chạy lại bước commit-template không tạo khác biệt,
 * và snapshot test giữ cho mẫu chuẩn không đổi ngoài ý muốn.
 */
export function renderTemplate(
  input: TemplateInput,
  templates: InstructionTemplates = { agents: null, claude: null, mcp: null },
): TemplateFile[] {
  const t = { ...input, publicUrl: input.publicUrl.replace(/\/+$/, "") };
  return [...instructionFiles(templates, t), { path: "README.md", content: readmeMd(t) }];
}
