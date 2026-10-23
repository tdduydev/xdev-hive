import { BlockList, isIP } from "node:net";

/*
 * IP người gọi để giới hạn tốc độ. Chỉ tin `X-Forwarded-For` khi kết nối đến từ proxy trong `HIVE_TRUSTED_PROXIES`,
 * vì người gọi tự đặt được header này.
 */

/** `::ffff:1.2.3.4` (socket hai ngăn xếp) và `1.2.3.4` là cùng một máy; đưa về một dạng để cùng khoá đếm. */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) ip = mapped[1];
  return isIP(ip) ? ip.toLowerCase() : null;
}

export interface TrustedProxies {
  has(ip: string): boolean;
  readonly empty: boolean;
}

/**
 * `HIVE_TRUSTED_PROXIES`: danh sách CIDR hay IP, phân cách bằng dấu phẩy hoặc khoảng trắng. Mục sai thì báo và bỏ qua,
 * để hub vẫn chạy (lúc đó IP là địa chỉ kết nối, mọi người sau proxy chung một hạn mức).
 */
export function parseTrustedProxies(raw: string | undefined): TrustedProxies {
  const list = new BlockList();
  let count = 0;
  for (const entry of (raw ?? "").split(/[\s,]+/).filter(Boolean)) {
    const [addr, prefix] = entry.split("/");
    const ip = normalizeIp(addr);
    const family = ip ? (isIP(ip) === 6 ? "ipv6" : "ipv4") : null;
    const bits = prefix === undefined ? null : Number(prefix);
    if (
      !ip ||
      !family ||
      (bits !== null && (!Number.isInteger(bits) || bits < 0 || bits > (family === "ipv6" ? 128 : 32)))
    ) {
      console.error(`HIVE_TRUSTED_PROXIES: bỏ qua mục không hợp lệ "${entry}".`);
      continue;
    }
    if (bits === null) list.addAddress(ip, family);
    else list.addSubnet(ip, bits, family);
    count++;
  }
  return {
    empty: count === 0,
    has: (ip) => count > 0 && list.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4"),
  };
}

/**
 * IP để đếm. Chỉ tin `X-Forwarded-For` khi kết nối đến từ proxy đã khai báo, vì người gọi tự đặt được header này; khi đó
 * đi từ phải sang trái và lấy địa chỉ đầu tiên không phải proxy tin cậy (proxy chỉ nối thêm vào cuối chuỗi).
 */
export function clientIp(
  remote: string | undefined,
  forwardedFor: string | undefined,
  trusted: TrustedProxies,
): string {
  const direct = normalizeIp(remote) ?? "unknown";
  if (trusted.empty || direct === "unknown" || !trusted.has(direct) || !forwardedFor) return direct;
  const hops = forwardedFor.split(",").map((h) => normalizeIp(h));
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    // Mục hỏng nghĩa là phần bên trái do người gọi tự viết; dừng ở proxy cuối đã biết thay vì tin phần đó.
    if (!hop) return direct;
    if (!trusted.has(hop)) return hop;
  }
  return hops[0] ?? direct;
}

/** Địa chỉ socket do `@hono/node-server` đặt vào `c.env`; không có (test, adapter khác) thì không biết IP. */
export function socketAddress(env: unknown): string | undefined {
  return (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
}
