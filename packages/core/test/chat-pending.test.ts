import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const lan: Actor = { name: "lan", role: "member", account: "lan", access: { projects: { app: "lead" } }, source: { via: "web" } };
// Minh works on pay only: app's chat is not his to see.
const minh: Actor = { name: "minh", role: "member", account: "minh", access: { projects: { pay: "lead" } }, source: { via: "web" } };

const profile = (id: string) => ({ id, label: id, kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0 });
const fails = (key: string) => (e: unknown) => e instanceof HiveError && e.key === key;

async function setup() {
  const hive = new SqliteHive(":memory:");
  await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", profiles: [profile("claude-1")], projects: ["app"], acceptsRuns: true }, mbp);
  const sent = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Split the sign-in work" }, lan);
  await hive.call("chat.progress", { replyId: sent.reply.id, text: "…" }, mbp);
  const leader: Actor = { name: "claude-1.duy-mbp@chat", role: "agent", access: { projects: { app: "member" } }, agent: "claude-1.duy-mbp", chatReply: sent.reply.id, source: { via: "mcp" } };
  const propose = (id: string) => hive.call("chat.propose", { action: { kind: "task.create", id, title: `Task ${id}`, dependsOn: [] } as never, reason: "Asked in the chat" }, leader);
  return { hive, propose };
}

describe("leaders' proposals waiting for a person (roadmap 35c)", () => {
  it("lists what nobody confirmed or set aside yet, the newest first", async () => {
    const { hive, propose } = await setup();
    const a = await propose("T-1");
    const b = await propose("T-2");
    const c = await propose("T-3");
    assert.deepEqual(
      (await hive.call("chat.pending", {}, lan)).map((x) => x.id),
      [c.id, b.id, a.id],
    );
    await hive.call("chat.decide", { actionId: a.id, accept: true }, lan);
    await hive.call("chat.decide", { actionId: b.id, accept: false }, lan);
    assert.deepEqual(
      (await hive.call("chat.pending", { project: "app" }, lan)).map((x) => [x.id, x.status]),
      [[c.id, "proposed"]],
    );
  });

  it("shows only projects the caller sees", async () => {
    const { hive, propose } = await setup();
    await propose("T-1");
    assert.equal((await hive.call("chat.pending", {}, admin)).length, 1);
    assert.deepEqual(await hive.call("chat.pending", {}, minh), []);
    // As everywhere, a project one may not see does not exist for them.
    await assert.rejects(hive.call("chat.pending", { project: "app" }, minh), fails("errors.notFound"));
  });
});
