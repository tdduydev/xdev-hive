import type { ArtifactScope } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import type { TeamRole } from "../tenancy/index.ts";
import { type ArtifactAction, type ArtifactFacts, can, type RunReader, type UserReader } from "./access.ts";

// Bảng quyền của plan.md "Permissions & Authorization" (FR-020, FR-021, FR-032), từng ô, không cần database.

const TEAM = "team-a";
const OTHER_TEAM = "team-b";
const PROJECT = "project-a";

const user = (userId: string, opts: { org?: UserReader["orgRole"]; team?: TeamRole } = {}): UserReader => ({
  kind: "user",
  userId,
  orgRole: opts.org ?? "member",
  teams: new Map(opts.team ? [[TEAM, opts.team]] : []),
});

const facts = (scope: ArtifactScope, over: Partial<ArtifactFacts> = {}): ArtifactFacts => ({
  ownerUserId: "owner",
  scope,
  teamId: scope === "project" || scope === "team" ? TEAM : null,
  projectId: scope === "project" ? PROJECT : null,
  ownerActive: true,
  linkedToRun: false,
  linkedToRunWork: false,
  ...over,
});

const ACTIONS: ArtifactAction[] = ["read", "write", "manage", "own"];
const allowed = (reader: UserReader | RunReader, f: ArtifactFacts) => ACTIONS.filter((a) => can(reader, f, a));

describe("quyền của người", () => {
  it("chủ làm được mọi việc ở mọi phạm vi", () => {
    for (const scope of ["private", "project", "team", "org"] as const)
      expect(allowed(user("owner"), facts(scope))).toEqual(ACTIONS);
  });

  it("private: chỉ chủ, kể cả quản trị tổ chức cũng không đọc (C5)", () => {
    expect(allowed(user("x", { org: "owner", team: "admin" }), facts("private"))).toEqual([]);
    expect(allowed(user("x", { team: "member" }), facts("private"))).toEqual([]);
  });

  it("private của người đã rời tổ chức: quản trị tổ chức dọn được nhưng vẫn không đọc nội dung qua bảng quyền đọc", () => {
    const f = facts("private", { ownerActive: false });
    expect(can(user("x", { org: "admin" }), f, "manage")).toBe(true);
    expect(can(user("x", { org: "admin" }), f, "read")).toBe(false);
    expect(can(user("x"), f, "manage")).toBe(false);
  });

  it.each([
    ["viewer", ["read"]],
    ["ba", ["read"]],
    ["member", ["read", "write"]],
    ["admin", ["read", "write", "manage"]],
  ] as const)("project/team: vai trò %s của đội", (role, expected) => {
    for (const scope of ["project", "team"] as const)
      expect(allowed(user("x", { team: role }), facts(scope))).toEqual(expected);
  });

  it("project/team: người ngoài đội không thấy gì", () => {
    const outsider: UserReader = { ...user("x"), teams: new Map([[OTHER_TEAM, "admin"]]) };
    expect(allowed(outsider, facts("project"))).toEqual([]);
    expect(allowed(outsider, facts("team"))).toEqual([]);
  });

  it("org: thành viên đọc và sửa; quản trị tổ chức quản lý", () => {
    expect(allowed(user("x"), facts("org"))).toEqual(["read", "write"]);
    expect(allowed(user("x", { org: "admin" }), facts("org"))).toEqual(["read", "write", "manage"]);
  });

  it("team: quản trị đội đọc, sửa, quản lý; vai trò đội không đổi gì ở phạm vi org", () => {
    expect(allowed(user("x", { team: "admin" }), facts("team"))).toEqual(["read", "write", "manage"]);
    // Quản trị đội không phải quản trị tổ chức nên không quản lý được artifact `org`.
    expect(allowed(user("x", { team: "admin" }), facts("org"))).toEqual(["read", "write"]);
    expect(allowed(user("x", { org: "owner" }), facts("team"))).toEqual([]);
  });

  it("org: người ngoài mọi đội vẫn đọc được, nhưng không quản lý team của đội khác", () => {
    const outsider: UserReader = { ...user("x"), teams: new Map([[OTHER_TEAM, "admin"]]) };
    expect(can(outsider, facts("org"), "read")).toBe(true);
    expect(can(outsider, facts("team"), "manage")).toBe(false);
  });

  it("chỉ chủ có quyền `own` (tạo link công khai, C17)", () => {
    expect(can(user("x", { org: "owner", team: "admin" }), facts("project"), "own")).toBe(false);
  });
});

describe("quyền của run (FR-032)", () => {
  const run = (actor: UserReader | null): RunReader => ({
    kind: "run",
    runId: "run-1",
    runKind: "leader",
    projectId: PROJECT,
    teamId: TEAM,
    taskId: null,
    threadId: "thread-1",
    actor,
  });

  it("đọc artifact dự án của run, không đọc dự án khác", () => {
    expect(can(run(null), facts("project"), "read")).toBe(true);
    expect(can(run(null), facts("project", { projectId: "project-b" }), "read")).toBe(false);
  });

  it("không đọc private của người khác dù có liên kết", () => {
    const f = facts("private", { linkedToRunWork: true, linkedToRun: true });
    expect(can(run(user("someone")), f, "read")).toBe(false);
    expect(can(run(user("owner")), f, "read")).toBe(true);
  });

  it("sửa artifact chính run tạo", () => {
    expect(allowed(run(null), facts("project", { linkedToRun: true }))).toEqual(["read", "write"]);
  });

  it("artifact gắn với cuộc trò chuyện: sửa được chỉ khi người run làm thay sửa được", () => {
    const f = facts("project", { projectId: "project-b", linkedToRunWork: true });
    expect(allowed(run(user("x", { team: "member" })), f)).toEqual(["read", "write"]);
    expect(allowed(run(user("x", { team: "viewer" })), f)).toEqual(["read"]);
    expect(allowed(run(null), f)).toEqual(["read"]);
  });

  it("artifact team/org: run chỉ đọc khi gắn với run hay công việc của run", () => {
    for (const scope of ["team", "org"] as const) {
      expect(can(run(null), facts(scope), "read")).toBe(false);
      expect(allowed(run(null), facts(scope, { linkedToRunWork: true }))).toEqual(["read"]);
      expect(allowed(run(null), facts(scope, { linkedToRun: true }))).toEqual(["read", "write"]);
    }
  });

  it("artifact dự án không gắn với run: chỉ đọc", () => {
    expect(allowed(run(user("x", { team: "admin" })), facts("project"))).toEqual(["read"]);
  });

  it("run không bao giờ quản lý hay làm chủ", () => {
    const f = facts("private", { ownerUserId: "x", linkedToRun: true });
    expect(allowed(run(user("x")), f)).toEqual(["read", "write"]);
  });
});
