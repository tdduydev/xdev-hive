/** Ghép class Tailwind, bỏ giá trị rỗng. Không gộp class trùng nên component chỉ nhận class bổ sung, không để ghi đè. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
