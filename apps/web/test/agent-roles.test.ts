// Spec 79b: what a project lets its agents do, each agent capped by its own person's grant there.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

let base = "";
let close: () => void;
let hive: SqliteHive;
let tokens: TokenStore;
let users: UserStore;
const machine: Record<string, string> = {};
const session: Record<string, string> = {};

before(async () => {
  hive = new SqliteHive(":memory:");
  hive.seed("hub");
  const root: Actor = { name: "duy", role: "admin" };
  await hive.call("tasks.create", { id: "app-1", project: "app", title: "Đăng nhập" }, root);
  tokens = new TokenStore(hive.db);
  users = new UserStore(hive.db);
  // duy: hub admin (the Mac mini case); lan: the project's lead; minh: a member there, no taskManage.
  for (const [name, admin] of [["duy", true], ["lan", false], ["minh", false]] as const) {
    const u = users.create({ username: name, admin, password: "Correct-horse-79b!", mustChange: false }).user;
    machine[name] = tokens.create(`${name}-mini`, admin ? "admin" : "member", u.id).token;
    session[name] = users.startSession(u.id).token;
  }
  users.setGrants(users.byUsername("lan")!.id, { app: "lead" });
  users.setGrants(users.byUsername("minh")!.id, { app: "member" });
  const server = createHubApp({ hive, tokens, users, allowedHosts: ["127.0.0.1", "localhost"] }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

type Answer = { status: number; body: { result?: any; error?: { key?: string; code?: string } } };
const call = async (headers: Record<string, string>, method: string, input: unknown, agent?: string): Promise<Answer> => {
  const res = await fetch(`${base}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers, ...(agent ? { "x-hive-agent": agent } : {}) },
    body: JSON.stringify({ method, input }),
  });
  return { status: res.status, body: (await res.json()) as Answer["body"] };
};
const bearer = (token: string, method: string, input: unknown = {}, agent?: string) => call({ authorization: `Bearer ${token}` }, method, input, agent);
const person = (who: string, method: string, input: unknown = {}) =>
  call({ cookie: `hive_session=${encodeURIComponent(session[who]!)}`, "x-hive-csrf": "1" }, method, input);
/** An interactive MCP session of `who`'s machine, as the CLI exchanges it. */
const mcp = (who: string, readOnly = false) => tokens.issueMcp(machine[who]!, "app", readOnly);
let n = 0;
const create = (credential: string) => bearer(credential, "tasks.create", { id: `app-agent-${++n}`, project: "app", title: "Agent tạo" }, "claude");

describe("agent rights per project (spec 79b)", () => {
  it("keeps today's rights by default: an admin's MCP agent works tasks but does not create them", async () => {
    const view = await person("lan", "agentRights.get", { project: "app" });
    assert.deepEqual([view.body.result.isDefault, view.body.result.permissions], [true, ["view", "taskWork", "docPropose", "memoryWrite"]]);
    assert.equal((await create(mcp("duy"))).body.error?.key, "errors.need.taskManage");
  });

  it("lets only a person with membersManage change the set, from the hub's page", async () => {
    const input = { project: "app", permissions: ["view", "taskWork", "docPropose", "memoryWrite", "taskManage", "codeReview"] };
    assert.equal((await person("minh", "agentRights.set", input)).body.error?.key, "errors.need.membersManage");
    assert.equal((await bearer(machine.lan!, "agentRights.set", input)).body.error?.key, "errors.agentRightsPerson", "a lead's machine token is what an agent holds");
    assert.equal((await bearer(machine.duy!, "agentRights.set", input)).body.error?.key, "errors.agentRightsPerson", "an admin's too");
    assert.equal((await bearer(mcp("duy"), "agentRights.set", input)).status, 403);
    const tooMuch = await person("lan", "agentRights.set", { project: "app", permissions: ["view", "docApprove"] });
    assert.equal(tooMuch.body.error?.key, "errors.agentRightsInvalid", "approving stays a person's");
    const saved = await person("lan", "agentRights.set", input);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual([saved.body.result.isDefault, saved.body.result.updatedBy], [false, "lan"]);
    const audit = hive.db.prepare("SELECT actor, target, detail FROM audit WHERE action = 'agentRights.set'").all() as Array<Record<string, string>>;
    assert.deepEqual(audit.map((a) => [a.actor, a.target, a.detail]), [["lan", "app", "view, taskWork, taskManage, docPropose, memoryWrite, codeReview"]]);
  });

  it("lets an admin-owned machine's MCP agent create tasks once the lead allows it", async () => {
    const made = await create(mcp("duy"));
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(made.body.result.project, "app");
  });

  it("never gives an agent more than its own person: a member's agent still cannot create tasks", async () => {
    assert.equal((await create(mcp("minh"))).body.error?.key, "errors.need.taskManage");
  });

  it("keeps a read-only credential a viewer", async () => {
    const ro = mcp("duy", true);
    assert.equal((await create(ro)).status, 403);
    assert.equal((await bearer(ro, "tasks.list", { project: "app" })).status, 200);
  });

  it("gives a run credential the set, yet it never moves its own task to done", async () => {
    // The machine pairs with its token first: only a paired machine is issued run credentials.
    assert.equal((await bearer(machine.duy!, "machines.heartbeat", { machine: "mini", instance: "aaaaaaaa", projects: ["app"], acceptsRuns: true }, "runner.mini")).status, 200);
    const run = tokens.issueRun(machine.duy!, { machine: "mini", project: "app", task: "app-1", run: "R-1", minutes: 30, readOnly: false });
    assert.equal((await bearer(run, "tasks.claim", { id: "app-1" }, "claude")).status, 200);
    assert.equal((await bearer(run, "tasks.update", { id: "app-1", status: "review" }, "claude")).status, 200);
    // codeReview from the set gets past the permission check; the run is still the agent's own work.
    assert.equal((await bearer(run, "tasks.update", { id: "app-1", status: "done" }, "claude")).body.error?.key, "errors.selfApprove");
  });

  it("never lets an agent approve a run its own person asked for", async () => {
    await hive.call("tasks.create", { id: "app-2", project: "app", title: "Review" }, { name: "duy", role: "admin" });
    const now = new Date().toISOString();
    hive.db.prepare(`INSERT INTO run_records(machine_id, run_id, machine, project, task_id, task_title, role, status, requested_by, created_at, updated_at)
      VALUES ('runner.mini@duy-mini', 'R-2', 'mini', 'app', 'app-2', 'Review', 'implement', 'succeeded', 'duy', ?, ?)`).run(now, now);
    hive.db.prepare("UPDATE tasks SET status = 'review' WHERE id = 'app-2'").run();
    const done = await bearer(mcp("duy"), "tasks.update", { id: "app-2", status: "done" }, "claude");
    assert.equal(done.body.error?.key, "errors.selfApprove");
  });

  it("goes back to the default, which counts at once", async () => {
    const reset = await person("lan", "agentRights.set", { project: "app", permissions: ["view", "taskWork", "docPropose", "memoryWrite"] });
    assert.equal(reset.body.result.isDefault, true);
    assert.equal((await create(mcp("duy"))).body.error?.key, "errors.need.taskManage");
  });
});
