/** Chữ cái đầu của họ và tên ("Trần Đức Duy" → "TD"), như avatar trong mockup. */
export function initials(name: string, fallback = ""): string {
  const words = name.normalize("NFC").trim().split(/\s+/).filter(Boolean);
  const picked = words.length > 1 ? [words[0], words.at(-1)] : words;
  const letters = picked.map((w) => Array.from(w ?? "")[0] ?? "").join("");
  return (letters || Array.from(fallback.trim())[0] || "?").toUpperCase();
}

/** Tên miền của email, chữ thường; null nếu email không hợp lệ. SSO tìm nhà cung cấp theo tên miền này. */
export function emailDomain(email: string): string | null {
  const match = /^[^\s@]+@([^\s@]+\.[^\s@.]+)$/.exec(email.trim());
  return match?.[1]?.toLowerCase() ?? null;
}
