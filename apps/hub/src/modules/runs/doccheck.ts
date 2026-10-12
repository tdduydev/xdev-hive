/** Nội dung dài quá thì cắt: lời nhắc đi qua stdin của CLI và vào ngữ cảnh của agent. */
const MAX_DOC_CHARS = 60_000;

const clip = (s: string) =>
  s.length > MAX_DOC_CHARS ? `${s.slice(0, MAX_DOC_CHARS)}\n\n[... đã cắt ${s.length - MAX_DOC_CHARS} ký tự]` : s;

/** Lời nhắc của run kiểm tài liệu (gate AI của quy trình duyệt, specs/004). */
export function docCheckPrompt(input: {
  docKey: string;
  title: string;
  workflow: string;
  gate: string;
  checks: string[];
  passScore: number;
  content: string;
  base: string;
}): string {
  const checks = input.checks.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return `Bạn là người kiểm tài liệu tự động ở checkpoint “${input.gate}” của quy trình duyệt ${input.workflow}.

Tài liệu: ${input.title} (\`${input.docKey}\`). Dưới đây là bản đề xuất mới${input.base ? " và bản đã chốt trước đó" : ""}.
Chỉ đọc: không sửa file, không commit. Được đọc code trong repo và gọi \`doc_list\`, \`doc_get\` để đối chiếu với
tài liệu đã chốt khác.

Kiểm từng mục sau, mỗi mục kết luận đạt hay không kèm lý do ngắn (trích dòng nếu có):
${checks}

Chấm điểm chất lượng 0–10 (ngưỡng đạt ${input.passScore}). Xong thì gọi đúng một lần công cụ MCP \`doc_check_submit\`
với \`score\`, \`checklist\` (mỗi mục ở trên một phần tử, \`label\` đúng chữ của mục) và \`summary\` cho người duyệt.

=== BẢN ĐỀ XUẤT ===
${clip(input.content)}
${input.base ? `\n=== BẢN ĐÃ CHỐT TRƯỚC ĐÓ ===\n${clip(input.base)}\n` : ""}`;
}
