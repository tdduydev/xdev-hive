import type { LearnTrigger } from "@xdev-hive/contracts";
import { SKILL_LEARNING_MAX_PER_RUN } from "@xdev-hive/contracts";
import type { NamedText } from "./dedupe.ts";

// Lời nhắc của run `skill_proposal` (specs/014). Agent chỉ nhận bản tóm tắt từng run (mục tiêu, lỗi, cách sửa, lệnh),
// không nhận transcript: phần lớn token của việc học nằm ở đây, nên mỗi mục bị cắt cứng.

const clip = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export interface AttemptDigest {
  state: string;
  /** Lý do run không thành công hoặc kiểm tra không đạt. */
  problems: string[];
}

/** Tóm tắt một task đáng học: các lần chạy trước đó (lỗi) và lần cuối (cách sửa). */
export interface TaskDigest {
  taskKey: string;
  title: string;
  body: string;
  triggers: LearnTrigger[];
  retries: number;
  /** Chi phí đã định dạng (vd. "1,20 USD" hoặc "85k token"); null khi chưa có số. */
  cost: string | null;
  /** Các lần chạy trước lần cuối, cũ trước. */
  attempts: AttemptDigest[];
  /** Ghi chú của agent ở lần cuối (agent_report): nó đã làm và sửa gì. */
  notes: string[];
  /** Lệnh lần cuối đã chạy (nếu worker báo). */
  commands: string[];
  runIds: string[];
}

export const TRIGGER_LABEL: Record<LearnTrigger, string> = {
  retries: "thử lại nhiều lần",
  cost: "chi phí vượt p90 của dự án",
  marked: "người duyệt đánh dấu nên thành skill",
};

export function renderDigest(d: TaskDigest, index: number): string {
  const lines = [
    `### ${index}. ${d.taskKey}: ${clip(d.title, 160)}`,
    `Đáng học vì: ${d.triggers.map((t) => TRIGGER_LABEL[t]).join("; ")}. Số lần thử lại: ${d.retries}${d.cost ? `; chi phí: ${d.cost}` : ""}.`,
  ];
  if (d.body) lines.push(`Mục tiêu: ${clip(d.body, 500)}`);
  d.attempts.forEach((a, i) => {
    lines.push(
      `Lần ${i + 1} (${a.state}): ${a.problems.length ? a.problems.map((p) => clip(p, 200)).join(" | ") : "không có lỗi ghi lại"}`,
    );
  });
  if (d.notes.length) lines.push(`Cách sửa / báo cáo của agent: ${d.notes.map((n) => clip(n, 500)).join(" | ")}`);
  if (d.commands.length) lines.push(`Lệnh đã dùng: ${d.commands.map((c) => `\`${clip(c, 120)}\``).join(", ")}`);
  lines.push(`Run: ${d.runIds.join(", ")}`);
  return lines.join("\n");
}

export interface PromptInput {
  projectKey: string;
  digests: TaskDigest[];
  /** Skill đang áp dụng cho dự án (tên và mô tả một dòng); agent biết cái nào đã có để đề xuất sửa thay vì thêm trùng. */
  existing: NamedText[];
  /** Skill đã bị từ chối ở dự án này: không đề xuất lại. */
  rejected: NamedText[];
  /** Số đề xuất tối đa còn trong hạn mức hôm nay. */
  limit: number;
}

const MAX_LISTED_SKILLS = 60;

/** Lời nhắc đầy đủ. Dài khoảng vài nghìn token: nội dung cố định ngắn, phần còn lại là tóm tắt run. */
export function skillProposalPrompt(input: PromptInput): string {
  const max = Math.max(1, Math.min(SKILL_LEARNING_MAX_PER_RUN, input.limit));
  const lines = [
    `Bạn rút skill từ những việc khó của dự án ${input.projectKey}. Skill là bản hướng dẫn ngắn mà agent đọc khi gặp lại`,
    "đúng loại việc, để lần sau khỏi thử lại.",
    "",
    "Chế độ chỉ đọc: không sửa file, không commit. Được đọc repo; được gọi `skill_list`, `skill_get`, `memory_search`",
    "của xdev-hive để kiểm tra skill hay memory đã có.",
    "",
    `Chỉ đề xuất khi bài học TÁI SỬ DỤNG được cho việc khác (một cách làm, một cái bẫy, một lệnh đúng), không phải cho riêng task này. Tối đa ${max} đề xuất; không có gì đáng thì nộp mảng rỗng.`,
    "- `new`: skill chưa có. `edit`: sửa skill đã có (đọc bản hiện tại bằng `skill_get`, giữ phần còn đúng).",
    "- `name`: chữ thường không dấu, gạch ngang. `description`: một hai câu nói KHI NÀO dùng skill.",
    "- `content`: Markdown ngắn (dưới 60 dòng), không có frontmatter (hub tự ghép), gồm mục “Khi nào dùng”, các bước hoặc lệnh",
    "  đúng, và chỗ hay sai. Chỉ ghi điều đã thấy trong các run dưới đây hoặc đã kiểm trong repo.",
    "- `reason`: gặp lỗi gì, mất mấy lần thử; người duyệt đọc dòng này đầu tiên.",
    "- Không ghi secret, token, đường dẫn máy cá nhân.",
  ];
  if (input.existing.length) {
    lines.push("", "Skill đang có (đừng thêm trùng; muốn bổ sung thì dùng `edit`):");
    for (const s of input.existing.slice(0, MAX_LISTED_SKILLS)) lines.push(`- ${s.name}: ${clip(s.description, 100)}`);
    if (input.existing.length > MAX_LISTED_SKILLS)
      lines.push(`- … và ${input.existing.length - MAX_LISTED_SKILLS} skill khác (dùng \`skill_list\`).`);
  }
  if (input.rejected.length) {
    lines.push("", "Đã bị người trong đội từ chối, đừng đề xuất lại:");
    for (const s of input.rejected.slice(0, 15)) lines.push(`- ${s.name}: ${clip(s.description, 100)}`);
  }
  lines.push("", "## Các việc khó gần đây", "");
  input.digests.forEach((d, i) => {
    lines.push(renderDigest(d, i + 1), "");
  });
  lines.push(
    "Khi xong, gọi tool MCP `skill_proposal_submit` của xdev-hive đúng một lần với `proposals`. Không gọi thì không có",
    "đề xuất nào được lưu.",
  );
  return lines.join("\n");
}

/** Chi phí hiển thị trong tóm tắt: USD khi CLI báo, không thì tổng token. */
export function costLabel(costUsd: number | null, tokens: number): string | null {
  if (costUsd !== null) return `${costUsd.toFixed(2)} USD`;
  if (tokens > 0) return `${Math.round(tokens / 1000)}k token`;
  return null;
}
