import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import { briefBaseVersion, briefDrift, briefSaveMessage, isBriefConflict, shortSha } from "@/lib/brief.ts";

describe("shortSha", () => {
  it("cắt bảy ký tự như git", () => expect(shortSha("a".repeat(40))).toBe("aaaaaaa"));
  it("brief viết tay chưa có commit thì gạch ngang", () => expect(shortSha(null)).toBe("—"));
});

describe("briefDrift", () => {
  it("chỉ báo khi nhánh chính đã đi trước", () => {
    expect(briefDrift({ commitsBehind: 12 })).toBe(12);
    expect(briefDrift({ commitsBehind: 0 })).toBeNull();
    expect(briefDrift({ commitsBehind: null })).toBeNull();
  });
});

describe("briefBaseVersion", () => {
  it("chưa có brief thì 0 để tạo mới", () => {
    expect(briefBaseVersion(null)).toBe(0);
    expect(briefBaseVersion({ version: 3 })).toBe(3);
  });
});

describe("briefSaveMessage", () => {
  it("CONFLICT nói cách xử lý bằng tiếng Việt", () => {
    const error = new ORPCError("CONFLICT");
    expect(isBriefConflict(error)).toBe(true);
    expect(briefSaveMessage(error)).toMatch(/vừa được người khác hoặc agent cập nhật/);
  });
  it("lỗi khác dùng câu chung", () => {
    expect(isBriefConflict(new ORPCError("FORBIDDEN"))).toBe(false);
    expect(briefSaveMessage(new ORPCError("FORBIDDEN"))).toMatch(/không có quyền/);
  });
});
