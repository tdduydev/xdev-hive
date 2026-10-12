import type { DocSummary, SkillSummary } from "./knowledge.ts";

/** Chữ để so khớp: bỏ dấu tiếng Việt và hoa thường, để "hoan tien" tìm được "Hoàn tiền". */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, "d").toLowerCase();
}

/**
 * Tài liệu và skill khớp câu tìm (spec 008 US12): mọi từ của câu tìm phải có trong tiêu đề, key, tên hoặc mô tả. Hub
 * chưa có tìm toàn văn cho tài liệu và skill nên lọc ở client trên danh sách mình đọc được; memory tìm trên hub
 * (`memory.search`, theo từ và theo nghĩa).
 */
export function matchKnowledge(
  query: string,
  docs: readonly DocSummary[],
  skills: readonly SkillSummary[],
): { docs: DocSummary[]; skills: SkillSummary[] } {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return { docs: [], skills: [] };
  const hit = (...fields: string[]) => {
    const text = foldText(fields.join(" "));
    return words.every((word) => text.includes(word));
  };
  return {
    docs: docs.filter((d) => hit(d.title, d.key)),
    skills: skills.filter((s) => hit(s.name, s.description)),
  };
}
