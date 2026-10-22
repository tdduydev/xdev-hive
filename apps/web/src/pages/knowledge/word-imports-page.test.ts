import { describe, expect, it } from "vitest";
import { countParts, importTarget } from "@/pages/knowledge/word-imports-page.tsx";

const zero = {
  queued: 0,
  converting: 0,
  ready: 0,
  skipped: 0,
  blockedSecret: 0,
  failed: 0,
  proposed: 0,
  cancelled: 0,
  done: 0,
};

describe("số file của một lượt nhập", () => {
  it("chỉ in các trạng thái có file, theo thứ tự cố định", () => {
    expect(countParts({ ...zero, failed: 1, done: 3, blockedSecret: 2 })).toEqual([
      { key: "blockedSecret", text: "2 có bí mật", tone: "bad" },
      { key: "failed", text: "1 lỗi", tone: "bad" },
      { key: "done", text: "3 đã tạo", tone: "ok" },
    ]);
  });

  it("lượt chưa có file nào thì không có nhãn", () => {
    expect(countParts(zero)).toEqual([]);
  });
});

describe("đích của một lượt nhập", () => {
  it("tạo mới: thư mục, hoặc gốc khi để trống", () => {
    expect(importTarget({ mode: "create", targetDir: "docs/srs/", docKey: null })).toBe("docs/srs/");
    expect(importTarget({ mode: "create", targetDir: "", docKey: null })).toBe("Thư mục gốc");
  });

  it("cập nhật và gắn: tài liệu đích, hoặc gạch khi đã mất", () => {
    expect(importTarget({ mode: "update", targetDir: "docs/", docKey: "org/srs-0" })).toBe("org/srs-0");
    expect(importTarget({ mode: "link", targetDir: "", docKey: null })).toBe("—");
  });
});
