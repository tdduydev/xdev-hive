import { describe, expect, it } from "vitest";
import { canManageTeam, canSetOrgRole, canSetStatus, effectiveTeamRole, isOrgAdmin } from "@/lib/roles.ts";

describe("vai trò tổ chức", () => {
  it("quản trị tổ chức", () => {
    expect(isOrgAdmin("owner")).toBe(true);
    expect(isOrgAdmin("admin")).toBe(true);
    expect(isOrgAdmin("member")).toBe(false);
  });
});

describe("vai trò trong đội", () => {
  it("quản trị tổ chức là quản trị mọi đội, kể cả đội mình không ở trong", () => {
    expect(effectiveTeamRole("admin", undefined)).toBe("admin");
    expect(effectiveTeamRole("owner", "viewer")).toBe("admin");
  });
  it("thành viên tổ chức: theo vai trò trong đội, không ở trong đội thì không có quyền", () => {
    expect(effectiveTeamRole("member", "member")).toBe("member");
    expect(effectiveTeamRole("member", undefined)).toBeNull();
  });
  it.each([
    ["owner", undefined, true],
    ["member", "admin", true],
    ["member", "member", false],
    ["member", "viewer", false],
    ["member", undefined, false],
  ] as const)("tổ chức %s, đội %s → quản lý đội: %s", (org, team, want) => expect(canManageTeam(org, team)).toBe(want));
});

describe("đổi vai trò tổ chức", () => {
  it("chỉ chủ sở hữu, và không tự đổi của mình", () => {
    expect(canSetOrgRole("owner", false)).toBe(true);
    expect(canSetOrgRole("owner", true)).toBe(false);
    expect(canSetOrgRole("admin", false)).toBe(false);
    expect(canSetOrgRole("member", false)).toBe(false);
  });
});

describe("khoá, mở khoá", () => {
  it.each([
    ["owner", "member", false, true],
    ["owner", "owner", false, true],
    ["admin", "member", false, true],
    ["admin", "admin", false, true],
    ["admin", "owner", false, false],
    ["member", "member", false, false],
    ["owner", "owner", true, false],
  ] as const)("%s khoá %s (là mình: %s) → %s", (actor, target, self, want) =>
    expect(canSetStatus(actor, target, self)).toBe(want),
  );
});
