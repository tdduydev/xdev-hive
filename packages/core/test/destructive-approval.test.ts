import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DESTRUCTIVE_EXEMPT,
  DESTRUCTIVE_METHODS,
  DESTRUCTIVE_NAME,
  HiveError,
  isAgentCaller,
  isCliActionProposalKey,
  METHOD_ROLES,
  type Actor,
  type HiveEvent,
} from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

// Incident 2026-10-05: an agent session on a machine's admin hub token deleted three projects with nobody approving.
const agentOnAdminToken: Actor = { name: "claude-code@hc-duytd20-macmini", role: "admin", agent: "claude-code", source: { via: "mcp" }, onBehalf: "duytd20" };
const person: Actor = { name: "duy", role: "admin", source: { via: "web" }, account: "duy", humanSession: "session-duy" };
const script: Actor = { name: "duy", role: "admin" };

async function pending(call: Promise<unknown>): Promise<number> {
  try {
    await call;
  } catch (err) {
    assert.ok(err instanceof HiveError, String(err));
    assert.equal(err.code, "pending_approval", err.message);
    assert.match(err.message, /đã gửi đề xuất #\d+, chờ duyệt/);
    return Number(err.vars?.id);
  }
  assert.fail("expected the call to be held for approval");
}

function hub() {
  const events: HiveEvent[] = [];
  const hive = new SqliteHive(":memory:", { backup: async () => ({ file: "/backups/hub.db" }), onEvent: (e) => events.push(e) });
  return { hive, events };
}

describe("destructive calls of agents (ADM)", () => {
  it("classifies every method named like a deletion", () => {
    const destructive = new Set<string>(DESTRUCTIVE_METHODS);
    const loose = Object.keys(METHOD_ROLES).filter((m) => DESTRUCTIVE_NAME.test(m) && !destructive.has(m) && !(m in DESTRUCTIVE_EXEMPT));
    assert.deepEqual(loose, [], "add each to DESTRUCTIVE_METHODS or, with why, to DESTRUCTIVE_EXEMPT");
    for (const m of DESTRUCTIVE_METHODS) assert.ok(!(m in DESTRUCTIVE_EXEMPT), `${m} is in both lists`);
    for (const m of ["projects.delete", "projects.archive", "systems.remove", "memory.remove", "docs.remove"]) assert.ok(destructive.has(m), m);
  });

  it("tells agents from people", () => {
    assert.equal(isAgentCaller(agentOnAdminToken), true, "an admin role is no guard");
    assert.equal(isAgentCaller({ name: "x", role: "agent" }), true);
    assert.equal(isAgentCaller({ name: "x", role: "member", mcpCredential: true }), true);
    assert.equal(isAgentCaller({ name: "claude@x", role: "admin", agent: "claude", source: { via: "api" } }), true);
    assert.equal(isAgentCaller(person), false);
    assert.equal(isAgentCaller(script), false, "a bare token of the server shell, CI or a test");
    assert.equal(isAgentCaller({ name: "desktop@duy", role: "member", agent: "desktop", source: { via: "desktop" } }), false, "the desktop window");
    assert.equal(isAgentCaller({ name: "runner.mbp@duy", role: "member", agent: "runner.mbp", source: { via: "desktop" } }), false, "a paired machine's runner");
  });

  it("holds an agent's projects.delete as a proposal until a person approves it", async () => {
    const { hive, events } = hub();
    await hive.call("tasks.create", { id: "T-1", project: "ehospital", title: "Keep me" }, script);
    await hive.call("projects.archive", { project: "ehospital" }, script);

    const id = await pending(hive.call("projects.delete", { project: "ehospital", confirm: "ehospital" }, agentOnAdminToken));
    assert.equal((await hive.call("tasks.list", { project: "ehospital" }, script)).length, 1, "nothing deleted");
    const proposal = (await hive.call("proposals.list", { status: "pending" }, script)).find((p) => p.id === id)!;
    assert.ok(proposal, "the proposal exists");
    assert.ok(isCliActionProposalKey(proposal.docKey));
    assert.ok(proposal.docKey.startsWith("org/"), "a project's fate is the hub's: an archived project's proposals are hidden");
    assert.equal(proposal.author, agentOnAdminToken.name);
    assert.deepEqual(JSON.parse(proposal.content), { method: "projects.delete", project: null, input: { project: "ehospital", confirm: "ehospital" } });
    assert.ok(events.some((e) => e.type === "proposal.created" && e.proposal.id === id), "the Proposals page hears of it");

    // The agent cannot approve it itself, not even on the admin token.
    await assert.rejects(hive.call("proposals.approve", { id }, agentOnAdminToken), (e: unknown) => e instanceof HiveError && e.code === "forbidden");

    const approved = await hive.call("proposals.approve", { id }, person);
    assert.equal(approved.status, "approved", approved.reviewNote ?? "");
    assert.equal(approved.reviewer, "duy");
    assert.deepEqual(await hive.call("tasks.list", { project: "ehospital" }, script), [], "deleted once approved");

    const audit = await hive.call("admin.audit", {}, script);
    const deleted = audit.find((a) => a.action === "projects.delete")!;
    assert.ok(deleted, "the deletion is in the log");
    assert.equal(deleted.actor, "duy", "the approver");
    assert.equal(deleted.agent, agentOnAdminToken.name, "and the agent that asked");
    assert.match(deleted.detail, new RegExp(`#${id} `));
    assert.ok(audit.some((a) => a.action === "proposals.create" && a.agent === "claude-code"), "the hold is logged as the agent's");
    assert.ok(audit.some((a) => a.action === "proposals.approve" && a.actor === "duy"));
  });

  it("runs exactly the proposed input, with the approver's rights", async () => {
    const { hive } = hub();
    await hive.call("tasks.create", { id: "T-1", project: "a", title: "A" }, script);
    await hive.call("tasks.create", { id: "T-2", project: "b", title: "B" }, script);
    const id = await pending(hive.call("projects.archive", { project: "a" }, agentOnAdminToken));
    // A person without hub admin rights cannot make it happen by approving it.
    const lead: Actor = { name: "lan", role: "member", access: { projects: { a: "lead" }, shared: "lead" }, account: "lan", source: { via: "web" }, humanSession: "session-lan" };
    const tried = await hive.call("proposals.approve", { id }, lead);
    assert.equal(tried.status, "conflict");
    assert.deepEqual((await hive.call("projects.list", {}, script)).filter((p) => p.state === "archived").map((p) => p.project), []);
  });

  it("holds the other destructive methods and leaves the rest alone", async () => {
    const { hive } = hub();
    const memory = await hive.call("memory.write", { project: "app", kind: "gotcha", content: "keep this" }, script);
    await hive.call("docs.save", { key: "project/app/guide", content: "text" }, script);
    await hive.call("systems.save", { name: "billing", projects: ["app"] }, script);

    const memoryHold = await pending(hive.call("memory.remove", { id: memory.id }, agentOnAdminToken));
    await pending(hive.call("docs.remove", { key: "project/app/guide" }, agentOnAdminToken));
    await pending(hive.call("systems.remove", { name: "billing" }, agentOnAdminToken));
    assert.equal((await hive.call("memory.list", { project: "app" }, script)).length, 1);
    assert.ok(await hive.call("docs.get", { key: "project/app/guide" }, script));
    assert.equal((await hive.call("systems.list", {}, script)).length, 1);
    const held = (await hive.call("proposals.list", { status: "pending" }, script)).find((p) => p.id === memoryHold)!;
    assert.ok(held.docKey.startsWith("project/app/"), "a project's own data is for that project's reviewers");

    // Writing is not destructive: an agent still does it straight away.
    await hive.call("memory.write", { project: "app", kind: "gotcha", content: "more" }, agentOnAdminToken);
  });

  it("lets a person delete directly, as before", async () => {
    const { hive } = hub();
    await hive.call("tasks.create", { id: "T-1", project: "old", title: "Old" }, script);
    await hive.call("projects.archive", { project: "old" }, person);
    const deleted = await hive.call("projects.delete", { project: "old", confirm: "old" }, person);
    assert.equal(deleted.project, "old");
    assert.deepEqual(await hive.call("proposals.list", {}, script), [], "no proposal for a person");
    const line = (await hive.call("admin.audit", {}, script)).find((a) => a.action === "projects.delete")!;
    assert.equal(line.actor, "duy");
    assert.equal(line.agent, null);
  });

  it("runs an approved hub RPC through the hub's registered action", async () => {
    const { hive } = hub();
    const ran: Array<{ input: Record<string, unknown>; by: Actor }> = [];
    hive.onApprovedAction("tokens.revoke", async (input, by) => {
      ran.push({ input, by });
      return { revoked: true };
    });
    const err = hive.holdForApproval("tokens.revoke", { id: "tok-1" }, agentOnAdminToken);
    assert.equal(err.code, "pending_approval");
    const id = Number(err.vars?.id);
    assert.equal(ran.length, 0, "held, not run");
    assert.equal((await hive.call("proposals.approve", { id }, person)).status, "approved");
    assert.deepEqual(ran.map((r) => r.input), [{ id: "tok-1" }]);
    assert.equal(ran[0]!.by.name, "duy");
    assert.deepEqual(ran[0]!.by.approvedProposal, { id, author: agentOnAdminToken.name });

    // A method this hub has no action for stays pending instead of being marked done.
    const orphan = Number(hive.holdForApproval("users.purge", { id: "u1" }, agentOnAdminToken).vars?.id);
    await assert.rejects(hive.call("proposals.approve", { id: orphan }, person), (e: unknown) => e instanceof HiveError && e.code === "bad_request");
    assert.equal((await hive.call("proposals.list", { status: "pending" }, script)).some((p) => p.id === orphan), true);
  });
});
