import { describe, expect, it } from "vitest";
import { nextTeamColor, TEAM_COLORS, teamColor, teamInitials } from "./teams.ts";

describe("màu đội", () => {
  it("đội mới xoay vòng theo số đội đã có", () => {
    expect(nextTeamColor(0)).toBe(TEAM_COLORS[0]);
    expect(nextTeamColor(1)).toBe(TEAM_COLORS[1]);
    expect(nextTeamColor(TEAM_COLORS.length)).toBe(TEAM_COLORS[0]);
  });
  it("đội đã có màu giữ màu đó", () => expect(teamColor({ id: "x", color: "#123456" })).toBe("#123456"));
  it("đội chưa có màu: cố định theo mã đội", () => {
    const team = { id: "3f2a6c1e-0000-4000-8000-000000000001", color: null };
    expect(TEAM_COLORS).toContain(teamColor(team));
    expect(teamColor(team)).toBe(teamColor({ ...team }));
  });
  it("mọi màu dạng #RRGGBB như hub đòi", () => {
    for (const c of TEAM_COLORS) expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe("teamInitials", () => {
  it.each([
    ["Thanh toán", "TT"],
    ["Nội bộ", "NB"],
    ["CRM", "CR"],
    ["ứng dụng di động", "ỨĐ"],
    ["x", "X"],
    ["  ", "?"],
  ])("%j → %s", (name, want) => expect(teamInitials(name)).toBe(want));
});
