// Token xDev Hive: PAT (`hive_pat_…`), token máy (`hwm_…`), mã đăng ký (`hwr_…`) và header Bearer.
const PATTERNS: RegExp[] = [
  /\b(?:hive_pat|hwm|hwr)_[A-Za-z0-9_-]+/g,
  /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /((?:authorization|x-api-key)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)[^\s"',}]+/gi,
];

export const MASK = "***";

export function redact(text: string): string {
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (_m, prefix: unknown) => (typeof prefix === "string" ? `${prefix}${MASK}` : MASK));
  }
  return out;
}
