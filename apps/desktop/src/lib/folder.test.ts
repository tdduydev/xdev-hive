import { describe, expect, it } from "vitest";
import { commonFolder } from "@/lib/folder.ts";

describe("commonFolder", () => {
  it("lấy thư mục chung sâu nhất, giữ kiểu dấu phân cách", () => {
    expect(commonFolder(["/Users/ha/his/his-web", "/Users/ha/his/his-admin/"])).toBe("/Users/ha/his");
    expect(commonFolder(["/Users/ha/his/a", "/Users/ha/his/a/sub"])).toBe("/Users/ha/his/a");
    expect(commonFolder(["D:\\Code\\HIS\\web", "d:\\code\\his\\admin"])).toBe("D:\\Code\\HIS");
  });

  it("không trả gốc ổ đĩa hay /", () => {
    expect(commonFolder(["/a/x", "/b/y"])).toBeNull();
    expect(commonFolder(["/w/x", "/w/y"])).toBeNull();
    expect(commonFolder(["C:\\a", "D:\\a"])).toBeNull();
    expect(commonFolder([])).toBeNull();
  });
});
