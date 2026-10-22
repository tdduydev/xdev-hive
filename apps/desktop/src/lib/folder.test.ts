import { describe, expect, it } from "vitest";
import { commonFolder } from "@/lib/folder.ts";

describe("commonFolder", () => {
  it("lấy thư mục chung sâu nhất, giữ kiểu dấu phân cách", () => {
    expect(commonFolder(["/Users/ha/his/his-web", "/Users/ha/his/his-admin/"])).toBe("/Users/ha/his");
    expect(commonFolder(["/Users/ha/his/a", "/Users/ha/his/a/sub"])).toBe("/Users/ha/his/a");
    expect(commonFolder(["D:\\Code\\HIS\\web", "d:\\code\\his\\admin"])).toBe("D:\\Code\\HIS");
  });

  it("không trả gốc ổ đĩa, thư mục cách gốc một cấp hay thư mục nhà", () => {
    expect(commonFolder(["/Users/ha/web", "/Users/ha/Work/api"])).toBeNull();
    expect(commonFolder(["/home/ha/web", "/home/ha/api"])).toBeNull();
    expect(commonFolder(["C:\\Users\\ha\\web", "C:\\Users\\ha\\api"])).toBeNull();
    expect(commonFolder(["D:\\Code\\web", "D:\\Code\\api"])).toBeNull();
    expect(commonFolder(["/srv/code/web", "/srv/code/api"])).toBe("/srv/code");
    expect(commonFolder(["/a/x", "/b/y"])).toBeNull();
    expect(commonFolder(["/w/x", "/w/y"])).toBeNull();
    expect(commonFolder(["C:\\a", "D:\\a"])).toBeNull();
    expect(commonFolder([])).toBeNull();
  });
});
