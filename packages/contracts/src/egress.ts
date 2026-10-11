import { z } from "zod";

const ipv4 = z.ipv4();
const ipv6 = z.ipv6();

/** Cùng cú pháp file của hive-worker egress-proxy; không nhận comment hay nhiều dòng từ API. */
export function normalizeEgressRule(value: string): string | null {
  const entry = value.trim();
  if (!entry || /[\s#%@\\/?]/u.test(entry.replace(/\/\d+(?=\]|:|$)/u, ""))) return null;
  let host = entry;
  let port = "";
  // IPv6/CIDR nguyên vẹn không có cổng; có cổng thì phải dùng ngoặc vuông như net.SplitHostPort.
  const rawIp = ipv4.safeParse(entry).success || ipv6.safeParse(entry).success;
  const rawPrefix = /^(.*)\/(\d+)$/u.exec(entry);
  const isPrefix = rawPrefix && (ipv4.safeParse(rawPrefix[1]).success || ipv6.safeParse(rawPrefix[1]).success);
  if (!rawIp && !isPrefix && entry.includes(":")) {
    const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/u.exec(entry);
    if (!match) return null;
    host = match[1] ?? match[2] ?? "";
    const n = Number(match[3]);
    if (!Number.isSafeInteger(n) || n < 1 || n > 65535) return null;
    port = `:${n}`;
    if (match[1] && !host.includes(":")) return null;
  }
  const prefix = /^(.*)\/(\d+)$/u.exec(host);
  if (prefix) {
    const address = prefix[1] ?? "";
    const bits = Number(prefix[2]);
    const isV4 = ipv4.safeParse(address).success;
    if ((!isV4 && !ipv6.safeParse(address).success) || bits > (isV4 ? 32 : 128)) return null;
    if (address.includes(":") && address.includes(".")) return null;
    // Proxy tự mask CIDR nên giữ phần host không làm đổi phạm vi cho phép.
    return `${isV4 ? `${address}/${bits}` : port ? `[${address.toLowerCase()}/${bits}]` : `${address.toLowerCase()}/${bits}`}${port}`;
  }
  if (ipv4.safeParse(host).success) return host + port;
  if (ipv6.safeParse(host).success) return (port ? `[${host.toLowerCase()}]` : host.toLowerCase()) + port;
  const wildcard = host.startsWith("*.");
  const domain = wildcard ? host.slice(2) : host;
  if (/^[\d.]+$/u.test(domain) || /[:[\]]/u.test(domain)) return null;
  let ascii: string;
  try {
    // Chuẩn hoá IDNA như proxy Go; chặn alias IP mà URL có thể biến thành địa chỉ khác.
    ascii = new URL(`http://${domain}`).hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return null;
  }
  if (ipv4.safeParse(ascii).success || ascii.length > 253) return null;
  if (!ascii.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) return null;
  return `${wildcard ? "*." : ""}${ascii}${port}`;
}

export const egressRule = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => normalizeEgressRule(v) !== null, {
    message: "Mục mạng phải là tên miền, wildcard, IP hoặc CIDR, kèm cổng từ 1 đến 65535 nếu cần.",
  });

// Chỉ là đề xuất: admin tổ chức phải bật rõ ràng, mặc định không tự mở mạng.
export const SUGGESTED_EGRESS_RULES = [
  "api.anthropic.com:443",
  "api.openai.com:443",
  "registry.npmjs.org:443",
  "proxy.golang.org:443",
  "sum.golang.org:443",
] as const;
