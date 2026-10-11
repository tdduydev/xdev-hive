import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface SmtpHostDeps {
  allowPrivate?: boolean | undefined;
  lookup?: ((host: string, options: { all: true }) => Promise<{ address: string; family: number }[]>) | undefined;
}

export const PRIVATE_SMTP_MESSAGE = "Máy chủ SMTP trỏ vào địa chỉ nội bộ";

function blockedIPv4(bytes: number[]): boolean {
  const [a = 0, b = 0] = bytes;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** IPv4 nhúng trong IPv6 phải chịu cùng chính sách, tránh lách bằng ::ffff:127.0.0.1. */
export function isBlockedSmtpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedIPv4(address.split(".").map(Number));
  if (family !== 6) return true;
  let ipv6 = address.split("%")[0] ?? "";
  if (ipv6.includes(".")) {
    const colon = ipv6.lastIndexOf(":");
    const bytes = ipv6
      .slice(colon + 1)
      .split(".")
      .map(Number);
    ipv6 = `${ipv6.slice(0, colon)}:${(((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)).toString(16)}:${(((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)).toString(16)}`;
  }
  const [left = "", right] = ipv6.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const words = (
    right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
  ).map((word) => Number.parseInt(word, 16));
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return blockedIPv4([(words[6] ?? 0) >> 8, (words[6] ?? 0) & 255, (words[7] ?? 0) >> 8, (words[7] ?? 0) & 255]);
  }
  const first = words[0] ?? 0;
  return (
    (words.slice(0, 7).every((word) => word === 0) && (words[7] ?? 0) <= 1) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  );
}

export class PrivateSmtpHostError extends Error {
  constructor() {
    super(PRIVATE_SMTP_MESSAGE);
  }
}

/** Kiểm mọi kết quả, rồi ghim một IP để kết nối không phân giải DNS lần nữa. */
export async function resolveSmtpHost(host: string, deps: SmtpHostDeps = {}): Promise<string> {
  const addresses = await (deps.lookup ?? lookup)(host, { all: true });
  if (addresses.length === 0) throw new Error("Không phân giải được máy chủ SMTP");
  if (!deps.allowPrivate && addresses.some(({ address }) => isBlockedSmtpAddress(address))) {
    throw new PrivateSmtpHostError();
  }
  const address = addresses[0]?.address;
  if (!address || !isIP(address)) throw new Error("Địa chỉ máy chủ SMTP không hợp lệ");
  return address;
}
