import { describe, expect, it } from "vitest";
import { LiveRunLogs, redactRunData } from "./live-logs.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const text = (logs: ReturnType<LiveRunLogs["after"]>) =>
  logs.map((c) => Buffer.from(c.bytes, "base64").toString()).join("");

describe("log trực tiếp chỉ giữ trong RAM", () => {
  it("che token cắt ngang hai gói, bỏ gói trùng và nối lại từ con trỏ", () => {
    const logs = new LiveRunLogs();
    const token = `ghp_${"A".repeat(36)}`;
    logs.push("run", 1, 1, b64(`xin chào ${token.slice(0, 12)}`));
    logs.push("run", 1, 2, b64(`${token.slice(12)}\nxong`));
    logs.push("run", 1, 2, b64("lặp"));
    logs.finish("run", 1);
    const all = logs.after("run", 0, 200);
    expect(text(all)).toContain("xin chào");
    expect(text(all)).toContain("xong");
    expect(text(all)).not.toContain(token);
    expect(text(all)).not.toContain("lặp");
    expect(logs.after("run", all.at(-1)?.id ?? 0, 200)).toEqual([]);
  });

  it("xoá bộ đệm sau 5 phút và tách hai lần thử", () => {
    let now = 0;
    const logs = new LiveRunLogs(() => now);
    logs.push("run", 1, 1, b64("cũ"));
    logs.finish("run", 1);
    logs.push("run", 2, 1, b64("mới"));
    logs.finish("run", 2);
    expect(text(logs.after("run", 0, 200))).toBe("mới");
    now = 5 * 60_000;
    expect(logs.after("run", 0, 200)).toEqual([]);
  });

  it("che chuỗi lồng trong báo cáo trước khi ghi sự kiện hay kết quả", () => {
    const token = `ghp_${"A".repeat(36)}`;
    const report = redactRunData({ error: { details: [token] }, count: 3, plain: "hoàn thành" });
    expect(JSON.stringify(report)).not.toContain(token);
    expect(report).toMatchObject({ count: 3, plain: "hoàn thành" });
  });
});
