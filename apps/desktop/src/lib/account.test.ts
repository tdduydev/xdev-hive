import { describe, expect, it } from "vitest";
import { type Account, profileOf } from "@/lib/account.ts";

const account = (roles: Account["teams"][number]["role"][]): Account => ({
  name: "An",
  email: "an@example.test",
  orgId: "o",
  orgName: "Hive",
  orgRole: "member",
  teams: roles.map((role, index) => ({ id: String(index), name: "Đội", role })),
});
describe("hồ sơ BA/PO", () => {
  it("BA và đội chỉ xem dùng hồ sơ writer", () => {
    expect(profileOf(account(["ba"]))).toBe("writer");
    expect(profileOf(account(["ba", "viewer"]))).toBe("writer");
  });
  it("quyền quản trị hoặc phát triển giữ hồ sơ tương ứng", () => {
    expect(profileOf(account(["ba", "member"]))).toBe("dev");
    expect(profileOf(account(["ba", "admin"]))).toBe("lead");
    expect(profileOf({ ...account(["ba"]), orgRole: "owner" })).toBe("lead");
    expect(profileOf(null)).toBe("dev");
  });
});
