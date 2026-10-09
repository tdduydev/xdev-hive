import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatDefaults, HiveSystem, HubUser, Machine } from "@xdev-hive/core";
import { allSelected, bulkTargets, filterCounts, filterUsers, initials, orgLegend, orgTree, paginate, permissionMatrix, roleCounts, serviceAgents, sortUsers, userStatus } from "#ui/lib/users-table.ts";

const user = (id: string, over: Partial<HubUser> = {}): HubUser => ({ id, username: id, displayName: id.toUpperCase(), admin: false, disabled: false, mustChangePassword: false, createdAt: "", lastLoginAt: null, grants: {}, shared: null, sso: false, ...over });
const users = [
  user("an", { displayName: "An Nguyễn", admin: true, lastLoginAt: "2026-10-02T00:00:00Z" }),
  user("binh", { displayName: "Bình Trần", grants: { pay: "lead", web: "viewer" }, sso: true, lastLoginAt: "2026-10-05T00:00:00Z" }),
  user("chi", { displayName: "Chi Lê", disabled: true, grants: { pay: "member" } }),
  user("dung", { displayName: "Dũng Phạm", mustChangePassword: true, grants: { pay: { permissions: ["view", "taskWork"] } } }),
];

describe("users table helpers (R-72l)", () => {
  it("filters by query and by state", () => {
    assert.deepEqual(filterUsers(users, "", "admin").map((u) => u.id), ["an"]);
    assert.deepEqual(filterUsers(users, "ChI", "all").map((u) => u.id), ["chi"]);
    assert.deepEqual(filterUsers(users, "", "disabled").map((u) => u.id), ["chi"]);
    assert.deepEqual(filterUsers(users, "", "mustChange").map((u) => u.id), ["dung"]);
    assert.deepEqual(filterUsers(users, "", "sso").map((u) => u.id), ["binh"]);
    assert.equal(filterCounts(users).active, 2);
    assert.equal(userStatus(users[2]!), "disabled");
  });

  it("sorts both ways and breaks ties by name", () => {
    assert.deepEqual(sortUsers(users, "name", "desc").map((u) => u.id), ["dung", "chi", "binh", "an"]);
    assert.deepEqual(sortUsers(users, "access", "desc").map((u) => u.id), ["an", "binh", "chi", "dung"]);
    assert.deepEqual(sortUsers(users, "last", "desc").map((u) => u.id).slice(0, 2), ["binh", "an"]);
    assert.equal(sortUsers(users, "status", "desc")[0]!.id, "chi");
  });

  it("pages with a clamp and a range", () => {
    const p = paginate([1, 2, 3, 4, 5], 9, 2);
    assert.deepEqual([p.page, p.pages, p.from, p.to, p.rows], [3, 3, 5, 5, [5]]);
    assert.deepEqual(paginate([], 1), { rows: [], page: 1, pages: 1, from: 0, to: 0, total: 0 });
  });

  it("makes initials", () => {
    assert.equal(initials("An Nguyễn"), "AN");
    assert.equal(initials("lan.nguyen"), "LA");
    assert.equal(initials("  "), "?");
  });

  it("keeps the signed-in account out of a bulk action", () => {
    assert.deepEqual(bulkTargets(users, new Set(["an", "chi"]), "an").map((u) => u.id), ["chi"]);
    assert.equal(allSelected(users, new Set(users.map((u) => u.id))), true);
    assert.equal(allSelected([], new Set()), false);
  });

  it("derives the permission matrix from the roles", () => {
    const m = permissionMatrix([{ id: "work", permissions: ["view", "codeReview"] }]);
    assert.deepEqual(m[0]!.rows.map((r) => r.cells), [[true, true, true, true, true], [false, false, true, true, true]]);
    assert.equal(roleCounts().lead >= roleCounts().viewer, true);
  });

  it("builds the org tree from grants, leaving out admins and locked accounts", () => {
    const systems: HiveSystem[] = [{ name: "shop", projects: ["pay"], updatedAt: "", updatedBy: "" }];
    const tree = orgTree(users, systems, ["pay", "web"], "Khác");
    assert.deepEqual(tree.map((s) => s.name), ["shop", "Khác"]);
    const pay = tree[0]!.services[0]!;
    assert.deepEqual(pay.roles.map((r) => [r.role, r.people.map((p) => p.id)]), [["lead", ["binh"]], ["custom", ["dung"]]]);
    assert.equal(pay.count, 2);
    assert.equal(orgLegend(tree).viewer, 1);
  });

  it("serviceAgents lists enabled profiles of machines holding the repo and resolves the leader", () => {
    const profile = (id: string, over = {}) => ({ id, label: id, kind: "claude", enabled: true, installed: true, ...over });
    const machine = (id: string, projects: string[], profiles: unknown[], online = true) => ({ id, machine: `${id}-mac`, online, projects, profiles }) as unknown as Machine;
    const machines = [machine("m1", ["pay"], [profile("a"), profile("off", { enabled: false }), profile("gone", { installed: false })]), machine("m2", ["web"], [profile("b", { kind: "codex" })], false)];
    const defaults = { machineId: "m2", profileId: "b" } as ChatDefaults;
    const pay = serviceAgents("pay", machines, defaults);
    assert.deepEqual(pay.agents.map((a) => a.key), ["m1/a"]);
    assert.deepEqual(pay.leader, { machine: "m2-mac", label: "b" });
    assert.equal(serviceAgents("web", machines, null).leader, null);
    assert.equal(serviceAgents("web", machines, { machineId: "zz", profileId: null } as ChatDefaults).leader, null);
    assert.equal(serviceAgents("web", machines, null).agents[0]!.online, false);
  });
});
