import { describe, expect, it } from "vitest";
import { clientIp, normalizeIp, parseTrustedProxies, publicRateLimiter, SlidingWindowLimiter } from "./rate-limit.ts";

// Đầu một phút tròn để biết chắc lượt nào rơi vào cửa sổ nào.
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % 60_000);

describe("SlidingWindowLimiter", () => {
  it("60 lượt trong một phút lọt, lượt 61 bị chặn kèm Retry-After", () => {
    const limiter = new SlidingWindowLimiter(60);
    for (let i = 0; i < 60; i++) expect(limiter.hit("1.2.3.4", T0 + i * 100).ok).toBe(true);
    const blocked = limiter.hit("1.2.3.4", T0 + 6_000);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
      expect(blocked.retryAfterSec).toBeLessThanOrEqual(120);
    }
    // Khoá khác không bị ảnh hưởng.
    expect(limiter.hit("5.6.7.8", T0 + 6_000).ok).toBe(true);
  });

  it("cửa sổ trượt: lượt của phút trước còn tính theo phần chồng lên, rồi phai hết", () => {
    const limiter = new SlidingWindowLimiter(10);
    for (let i = 0; i < 10; i++) limiter.hit("k", T0 + 50_000 + i);
    // 10 giây sau đầu phút kế: phút trước còn 10 × 5/6 ≈ 8,3 lượt nên chỉ lọt thêm 1.
    expect(limiter.hit("k", T0 + 70_000).ok).toBe(true);
    const blocked = limiter.hit("k", T0 + 70_001);
    expect(blocked.ok).toBe(false);
    // Hết phút kế, phút trước không còn tính.
    for (let i = 0; i < 9; i++) expect(limiter.hit("k", T0 + 180_000 + i).ok).toBe(true);
  });

  it("Retry-After đủ để lượt kế tiếp lọt", () => {
    const limiter = new SlidingWindowLimiter(5);
    for (let i = 0; i < 5; i++) limiter.hit("k", T0 + 1_000);
    const blocked = limiter.hit("k", T0 + 2_000);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(limiter.hit("k", T0 + 2_000 + blocked.retryAfterSec * 1000).ok).toBe(true);
  });

  it("lượt bị chặn không làm dài thêm thời gian chờ", () => {
    const limiter = new SlidingWindowLimiter(2);
    limiter.hit("k", T0);
    limiter.hit("k", T0);
    for (let i = 0; i < 100; i++) expect(limiter.hit("k", T0 + i).ok).toBe(false);
    // Hai phút sau mọi lượt cũ đã phai.
    expect(limiter.hit("k", T0 + 120_000).ok).toBe(true);
  });

  it("giữ tối đa maxKeys khoá và dọn khoá đã im", () => {
    const limiter = new SlidingWindowLimiter(1, 60_000, 3);
    for (const k of ["a", "b", "c", "d"]) limiter.hit(k, T0);
    expect(limiter.size).toBe(3);
    // Khoá cũ nhất bị bỏ: "a" lại được một lượt.
    expect(limiter.hit("a", T0).ok).toBe(true);
    limiter.hit("z", T0 + 300_000);
    expect(limiter.size).toBe(1);
  });
});

describe("publicRateLimiter", () => {
  it("mặc định 60/phút mỗi IP và 600/phút mỗi link, đếm riêng nhau", () => {
    const limiter = publicRateLimiter();
    for (let i = 0; i < 60; i++) expect(limiter.ip("9.9.9.9", T0).ok).toBe(true);
    expect(limiter.ip("9.9.9.9", T0).ok).toBe(false);
    for (let i = 0; i < 600; i++) expect(limiter.link("link-1", T0).ok).toBe(true);
    expect(limiter.link("link-1", T0).ok).toBe(false);
    expect(limiter.link("link-2", T0).ok).toBe(true);
  });
});

describe("IP người gọi", () => {
  it("chuẩn hoá IPv4 ánh xạ trong IPv6 và bỏ chuỗi không phải IP", () => {
    expect(normalizeIp("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(normalizeIp(" 2001:DB8::1 ")).toBe("2001:db8::1");
    expect(normalizeIp("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeIp("không-phải-ip")).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });

  it("không khai báo proxy tin cậy thì bỏ qua X-Forwarded-For", () => {
    const none = parseTrustedProxies(undefined);
    expect(clientIp("203.0.113.9", "1.1.1.1", none)).toBe("203.0.113.9");
    expect(clientIp(undefined, "1.1.1.1", none)).toBe("unknown");
  });

  it("kết nối từ proxy tin cậy: lấy IP cuối chưa tin cậy trong X-Forwarded-For", () => {
    const trusted = parseTrustedProxies("172.16.0.0/12, 10.0.0.5");
    expect(clientIp("::ffff:172.18.0.2", "198.51.100.7", trusted)).toBe("198.51.100.7");
    // Người gọi tự thêm IP giả ở bên trái; proxy nối IP thật vào cuối.
    expect(clientIp("172.18.0.2", "6.6.6.6, 198.51.100.7, 10.0.0.5", trusted)).toBe("198.51.100.7");
    // Kết nối không từ proxy tin cậy: header do người gọi tự đặt, không tin.
    expect(clientIp("203.0.113.9", "6.6.6.6", trusted)).toBe("203.0.113.9");
    // Mục hỏng nằm bên phải mục thật: dừng lại ở địa chỉ kết nối.
    expect(clientIp("172.18.0.2", "198.51.100.7, rác", trusted)).toBe("172.18.0.2");
    expect(clientIp("172.18.0.2", undefined, trusted)).toBe("172.18.0.2");
  });

  it("mục sai trong HIVE_TRUSTED_PROXIES bị bỏ qua, mục đúng vẫn dùng", () => {
    const trusted = parseTrustedProxies("abc, 10.0.0.0/99, 2001:db8::/32");
    expect(trusted.empty).toBe(false);
    expect(trusted.has("2001:db8::1")).toBe(true);
    expect(trusted.has("10.0.0.1")).toBe(false);
    expect(parseTrustedProxies("").empty).toBe(true);
  });
});
