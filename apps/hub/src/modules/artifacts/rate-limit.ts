import { BlockList, isIP } from "node:net";

/*
 * Giới hạn tốc độ của link công khai (plan.md D22, FR-145). Hub chạy một container (NFR-14) nên bộ đếm trong bộ nhớ là
 * đủ, không thêm Redis. Chỉ áp cho `/_artifact/s/*` và khung có vé `s`: phần còn lại của hub cần đăng nhập nên không đổi
 * hành vi.
 */

export const PUBLIC_IP_PER_MINUTE = 60;
export const PUBLIC_LINK_PER_MINUTE = 600;
const WINDOW_MS = 60_000;
const MAX_KEYS = 100_000;

interface Bucket {
  /** Đầu cửa sổ cố định hiện tại (ms). */
  start: number;
  current: number;
  previous: number;
}

export type Verdict = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * Cửa sổ trượt xấp xỉ bằng hai cửa sổ cố định (số của cửa sổ trước nhân phần còn chồng lên): mỗi khoá chỉ giữ ba số, nên
 * 100 000 khoá vẫn nhỏ, khác với giữ từng mốc thời gian (600 mốc mỗi link).
 */
export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(limit: number, windowMs = WINDOW_MS, maxKeys = MAX_KEYS) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  get size(): number {
    return this.buckets.size;
  }

  hit(key: string, now = Date.now()): Verdict {
    this.sweep(now);
    const bucket = this.roll(this.buckets.get(key), now);
    const weight = 1 - (now - bucket.start) / this.windowMs;
    if (bucket.previous * weight + bucket.current + 1 > this.limit) {
      this.store(key, bucket);
      return { ok: false, retryAfterSec: this.retryAfter(bucket, now) };
    }
    bucket.current += 1;
    this.store(key, bucket);
    return { ok: true };
  }

  /** Đưa bucket về cửa sổ chứa `now`; quá hai cửa sổ thì cửa sổ trước coi như không có lượt nào. */
  private roll(bucket: Bucket | undefined, now: number): Bucket {
    const start = now - (now % this.windowMs);
    if (!bucket) return { start, current: 0, previous: 0 };
    if (bucket.start === start) return bucket;
    const previous = bucket.start === start - this.windowMs ? bucket.current : 0;
    return { start, current: 0, previous };
  }

  /** Giây tới khi lượt kế tiếp lọt: chờ phần của cửa sổ trước phai bớt, hoặc sang cửa sổ sau nếu cửa sổ này đã đầy. */
  private retryAfter(bucket: Bucket, now: number): number {
    const elapsed = now - bucket.start;
    let waitMs: number;
    if (bucket.current + 1 > this.limit) {
      // Sang cửa sổ sau, số hiện tại thành "trước" và phải phai tới khi còn chỗ cho một lượt.
      const fade = bucket.current > 0 ? this.windowMs * (1 - (this.limit - 1) / bucket.current) : 0;
      waitMs = this.windowMs - elapsed + Math.max(0, fade);
    } else {
      const needed = this.windowMs * (1 - (this.limit - bucket.current - 1) / bucket.previous);
      waitMs = needed - elapsed;
    }
    return Math.max(1, Math.ceil(waitMs / 1000));
  }

  private store(key: string, bucket: Bucket): void {
    // Xoá rồi đặt lại để thứ tự của Map là thứ tự dùng gần nhất; khi đầy thì bỏ khoá lâu không dùng nhất.
    this.buckets.delete(key);
    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (!oldest.done) this.buckets.delete(oldest.value);
    }
    this.buckets.set(key, bucket);
  }

  /** Dọn khoá đã im quá hai cửa sổ, tối đa một lần mỗi cửa sổ: khoá như thế không còn ảnh hưởng gì tới phép tính. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    const stale = now - (now % this.windowMs) - this.windowMs;
    for (const [key, bucket] of this.buckets) if (bucket.start < stale) this.buckets.delete(key);
  }
}

// ---- IP người gọi --------------------------------------------------------------------------------------------------

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

// ---- Bộ giới hạn của link công khai --------------------------------------------------------------------------------

export interface PublicRateLimiter {
  /** Đếm một lượt theo IP; gọi trước mọi truy vấn database. */
  ip(ip: string, now?: number): Verdict;
  /** Đếm một lượt theo link (id link, sau khi đã tra được link). */
  link(linkId: string, now?: number): Verdict;
}

export function publicRateLimiter(
  opts: { ipPerMinute?: number; linkPerMinute?: number; maxKeys?: number } = {},
): PublicRateLimiter {
  const byIp = new SlidingWindowLimiter(opts.ipPerMinute ?? PUBLIC_IP_PER_MINUTE, WINDOW_MS, opts.maxKeys);
  const byLink = new SlidingWindowLimiter(opts.linkPerMinute ?? PUBLIC_LINK_PER_MINUTE, WINDOW_MS, opts.maxKeys);
  return {
    ip: (ip, now) => byIp.hit(ip, now),
    link: (linkId, now) => byLink.hit(linkId, now),
  };
}
