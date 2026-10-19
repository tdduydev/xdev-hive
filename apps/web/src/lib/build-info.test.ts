import type { Health } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { formatBuiltAt, shortVersion, wordImportSupport } from "@/lib/build-info.ts";

const health = (patch: Partial<Health> = {}): Health => ({ status: "ok", version: "0.2.22", ...patch }) as Health;

describe("thông tin build", () => {
  it("SHA đầy đủ rút còn 7 ký tự, semver giữ nguyên", () => {
    expect(shortVersion("185ec21a9b0c4f5e6d7a8b9c0d1e2f3a4b5c6d7e")).toBe("185ec21");
    expect(shortVersion("185ec21")).toBe("185ec21");
    expect(shortVersion("0.2.6")).toBe("0.2.6");
  });

  it("ngày build dạng ngày/tháng/năm giờ:phút; không có thì null", () => {
    const local = new Date(2026, 9, 13, 14, 5).toISOString();
    expect(formatBuiltAt(local)).toBe("13/10/2026 14:05");
    expect(formatBuiltAt(null)).toBeNull();
    expect(formatBuiltAt("không phải ngày")).toBeNull();
  });
});

describe("nhập Word theo /api/v1/health", () => {
  it("chưa có health thì chưa biết, không hiện nút", () => {
    expect(wordImportSupport(undefined)).toEqual({ state: "unknown", doc: false });
  });

  it("có pandoc và LibreOffice: nhận cả .doc", () => {
    expect(wordImportSupport(health({ wordImport: true, wordImportDoc: true }))).toEqual({ state: "on", doc: true });
  });

  it("có pandoc, không có LibreOffice: tắt .doc", () => {
    expect(wordImportSupport(health({ wordImport: true, wordImportDoc: false }))).toEqual({ state: "on", doc: false });
  });

  it("wordImport false thì tắt hẳn, kể cả khi wordImportDoc báo true", () => {
    expect(wordImportSupport(health({ wordImport: false, wordImportDoc: true }))).toEqual({ state: "off", doc: false });
  });

  it("hub cũ không báo trường này thì coi là tắt", () => {
    expect(wordImportSupport(health())).toEqual({ state: "off", doc: false });
  });
});
