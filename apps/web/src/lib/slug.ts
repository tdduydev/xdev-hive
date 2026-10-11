/** Độ dài tối đa của định danh, khớp `slug` trong packages/contracts. */
export const SLUG_MAX = 40;

/**
 * Gợi ý định danh từ tên tiếng Việt ("Thanh toán" → "thanh-toan"), để người tạo không phải tự gõ. Hub vẫn kiểm
 * lại định dạng bằng schema `slug` của hợp đồng.
 */
export function slugify(name: string): string {
  return (
    name
      .normalize("NFD")
      // Bỏ dấu thanh và dấu mũ sau khi tách ra khỏi chữ; "đ" không tách được nên đổi riêng.
      .replace(/\p{M}/gu, "")
      .replace(/[đĐ]/g, "d")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, SLUG_MAX + 1)
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX)
      .replace(/-+$/, "")
  );
}
