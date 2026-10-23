import { describe, expect, it } from "vitest";
import { buildCsp, libSource } from "./csp.ts";
import { LIB_BASE } from "./fixtures.ts";

const directives = (csp: string) =>
  new Map(csp.split("; ").map((d) => [d.split(" ")[0] as string, d.split(" ").slice(1)]));

describe("buildCsp", () => {
  it("khoá mọi nguồn và luôn chặn mạng", () => {
    const d = directives(buildCsp({ libBase: LIB_BASE }));
    expect(d.get("default-src")).toEqual(["'none'"]);
    expect(d.get("connect-src")).toEqual(["'none'"]);
    expect(d.get("form-action")).toEqual(["'none'"]);
    expect(d.get("frame-src")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'none'"]);
    expect(d.get("img-src")).toEqual(["data:", "blob:"]);
    expect(d.get("sandbox")).toEqual(["allow-scripts"]);
  });

  it("blobBase là ngoại lệ duy nhất của connect-src và chỉ mở thêm ảnh từ đúng thư mục đó", () => {
    const blobBase = "https://hive.example.com/_artifact/blob/";
    const d = directives(buildCsp({ libBase: LIB_BASE, blobBase }));
    expect(d.get("connect-src")).toEqual([blobBase]);
    expect(d.get("img-src")).toEqual(["data:", "blob:", blobBase]);
    expect(d.get("script-src")).toEqual(["'unsafe-inline'", LIB_BASE]);
    expect(() => buildCsp({ libBase: LIB_BASE, blobBase: "https://x.example/b/; connect-src *" })).toThrow();
  });

  it("chỉ có host của hub làm nguồn ngoài", () => {
    const csp = buildCsp({ libBase: LIB_BASE });
    const sources = csp.split(/[\s;]+/).filter((t) => /^[a-z-]+:\/\//.test(t));
    expect(new Set(sources)).toEqual(new Set([LIB_BASE]));
    // Không có ký tự đại diện hay scheme mở (https:, *) làm nguồn script/style.
    expect(csp).not.toMatch(/[\s](\*|https?:|wss?:)[\s;]|\*\./);
  });

  it("nhận scheme riêng của app và chuẩn hoá dấu / cuối", () => {
    expect(buildCsp({ libBase: "hive-artifact://localhost/lib" })).toContain(
      "script-src 'unsafe-inline' hive-artifact://localhost/lib/",
    );
  });

  it.each([
    "https://hive.example.com/lib/; script-src *",
    "https://hive.example.com/lib/ https://cdn.example.com/",
    "https://hive.example.com/lib/, img-src *",
    "https://hive.example.com/lib/'",
    "https://hive.example.com/lib/?x=1",
    "https://hive.example.com/lib/#x",
    "https://user:pass@hive.example.com/lib/",
    "/_artifact/lib/",
    "",
  ])("từ chối libBase %j", (libBase) => {
    expect(() => buildCsp({ libBase })).toThrow();
  });

  it("libSource giữ nguyên thư mục", () => {
    expect(libSource("http://127.0.0.1:3000/_artifact/lib/")).toBe("http://127.0.0.1:3000/_artifact/lib/");
  });
});
