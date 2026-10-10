// Spec 79b: a project's agent set caps its agents, each never past its own account's grant there.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_DEFAULT, AGENT_PERMISSIONS, HiveError, permissionsOn, readAgentRights, type Actor, type Permission } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const wide: Permission[] = ["view", "taskWork", "docPropose", "memoryWrite", "taskManage", "codeReview"];
const rights = { app: wide };
const sorted = (s: Set<Permission> | null) => (s ? [...s].sort() : null);

describe("agent rights (spec 79b)", () => {
  it("reads only what an agent may get, view always in", () => {
    assert.deepEqual(readAgentRights(["taskManage", "view"]), ["view", "taskManage"]);
    assert.equal(readAgentRights(["taskWork"]), null, "without view nothing else means anything");
    for (const p of ["docApprove", "memoryApprove", "chatApprove", "contextEdit", "projectSettings", "membersManage", "qaVerify", "docEdit"])
      assert.equal(readAgentRights(["view", p]), null, `${p} stays a person's`);
    assert.ok(AGENT_DEFAULT.every((p) => AGENT_PERMISSIONS.includes(p)));
  });

  it("is the set ∩ the account's grant, the default where the project set nothing", () => {
    const lead: Actor = { name: "claude@lan", role: "agent", account: "lan", mcpCredential: true, tokenId: "t", access: { projects: { app: "lead", web: "lead" } }, agentRights: rights };
    assert.deepEqual(sorted(permissionsOn(lead, "app")), [...wide].sort());
    assert.deepEqual(sorted(permissionsOn(lead, "web")), [...AGENT_DEFAULT].sort());
    const member: Actor = { ...lead, access: { projects: { app: "member" } } };
    assert.equal(permissionsOn(member, "app")!.has("taskManage"), false, "never more than the person");
    // A hub admin's agent (no access): the set alone.
    const admin: Actor = { name: "claude@duy", role: "agent", account: "duy", mcpCredential: true, tokenId: "t", agentRights: rights };
    assert.deepEqual(sorted(permissionsOn(admin, "app")), [...wide].sort());
    assert.deepEqual(sorted(permissionsOn(admin, "web")), [...AGENT_DEFAULT].sort());
    // No account behind the token, or a chat leader's reply token: the default.
    const { account: _, ...unowned } = admin;
    assert.deepEqual(sorted(permissionsOn(unowned, "app")), [...AGENT_DEFAULT].sort());
    assert.deepEqual(sorted(permissionsOn({ ...admin, chatReply: 1 }, "app")), [...AGENT_DEFAULT].sort());
    // Read-only credentials are viewers: the set does not reach them.
    assert.deepEqual(sorted(permissionsOn({ ...admin, role: "viewer" }, "app")), ["view"]);
  });

  it("sets come only from the hive, and a person sets them", async () => {
    const hive = new SqliteHive(":memory:");
    hive.seed("hub");
    const root: Actor = { name: "duy", role: "admin", account: "duy" };
    await hive.call("tasks.create", { id: "app-1", project: "app", title: "t" }, root);
    const agent: Actor = { name: "claude@duy", role: "agent", account: "duy", mcpCredential: true, tokenId: "t", access: { projects: { app: "lead" } } };
    // A forged set on the actor is replaced by what the project stored.
    await assert.rejects(hive.call("tasks.create", { id: "app-2", project: "app", title: "t" }, { ...agent, agentRights: rights }), (e) => e instanceof HiveError && e.key === "errors.need.taskManage");
    await assert.rejects(hive.call("agentRights.set", { project: "app", permissions: wide }, { ...root, tokenId: "t" }), (e) => e instanceof HiveError && e.key === "errors.agentRightsPerson");
    const view = await hive.call("agentRights.set", { project: "app", permissions: wide }, root);
    assert.deepEqual([view.isDefault, view.updatedBy], [false, "duy"]);
    await hive.call("tasks.create", { id: "app-2", project: "app", title: "t" }, agent);
    // Kept as one of the project's settings, which deleting or restoring the project carries.
    assert.ok(hive.db.prepare("SELECT 1 FROM settings WHERE key = 'agentRights:app'").get());
  });
});
