import type { OrgMember } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { activeRunCounts, recentDays, teamRoleLookup } from "./projects.ts";
import { searchInput, validateRunsSearch } from "./run-list.ts";
import { makeRun } from "./test-fixtures.ts";

const member = (teams: OrgMember["teams"]): OrgMember => ({
  userId: "u1",
  name: "Duy",
  email: "duy@fpt.com",
  image: null,
  role: "member",
  status: "active",
  joinedAt: "2026-10-01T00:00:00.000Z",
  teams,
});

describe("teamRoleLookup", () => {
  it("vai trò theo đội của chính mình; quản trị tổ chức là quản trị mọi đội", () => {
    const members = [
      member([
        { teamId: "a", name: "A", role: "admin" },
        { teamId: "b", name: "B", role: "viewer" },
      ]),
    ];
    const role = teamRoleLookup("member", members, "u1");
    expect([role("a"), role("b"), role("c")]).toEqual(["admin", "viewer", null]);
    expect(teamRoleLookup("admin", undefined, "u1")("c")).toBe("admin");
    expect(teamRoleLookup("member", members, "u2")("a")).toBeNull();
  });
});

describe("activeRunCounts", () => {
  it("đếm run chưa kết thúc theo dự án", () => {
    const counts = activeRunCounts([
      makeRun({ projectId: "p1", state: "running" }),
      makeRun({ projectId: "p1", state: "queued" }),
      makeRun({ projectId: "p1", state: "succeeded" }),
      makeRun({ projectId: "p2", state: "failed" }),
    ]);
    expect([...counts]).toEqual([["p1", 2]]);
  });
});

describe("recentDays", () => {
  it("7 ngày tính cả hôm nay, theo UTC", () => {
    expect(recentDays(Date.parse("2026-10-11T23:30:00Z"))).toEqual({ from: "2026-10-05", to: "2026-10-11" });
  });
});

describe("bộ lọc /runs", () => {
  it("bỏ giá trị lạ trên URL", () => {
    expect(validateRunsSearch({ status: "xong", cli: "cursor", machine: "abc", project: "" })).toEqual({});
    expect(
      validateRunsSearch({
        status: "failed",
        cli: "codex",
        machine: "3c3c3c3c-0000-4000-8000-000000000001",
        project: "pay",
      }),
    ).toEqual({ status: "failed", cli: "codex", machine: "3c3c3c3c-0000-4000-8000-000000000001", project: "pay" });
  });

  it("đổi sang đầu vào runs.search", () => {
    expect(searchInput({ status: "active", project: "pay", machine: "m" }, "p1")).toEqual({
      limit: 50,
      status: "active",
      projectId: "p1",
      machineId: "m",
    });
    expect(searchInput({}, undefined)).toEqual({ limit: 50 });
  });
});
