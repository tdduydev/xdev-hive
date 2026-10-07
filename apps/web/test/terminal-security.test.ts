import assert from "node:assert/strict";
import { it } from "node:test";
import { terminalDecision, type Actor, type TerminalCapability } from "@xdev-hive/core";
import { SqliteHive, TerminalStore } from "@xdev-hive/core/node";
import type { Request, RequestHandler, Response } from "express";
import { createHubApp } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

// 69a: the actors here are the ones the hub's own middleware builds, so a name collision is tried the way a caller
// would try it, not with a hand-made Actor.
it("accepts a terminal machine report only from the machine's own token, whoever names a token like it", async () => {
  const hive = new SqliteHive(":memory:");
  const tokens = new TokenStore(hive.db);
  const users = new UserStore(hive.db);
  const created = users.create({ username: "alice" });
  const alice = users.changePassword(created.user.id, created.password, "Correct-horse-battery-9");
  const mallory = users.create({ username: "mallory" }).user;
  users.setGrants(alice.id, { app: "member" });
  users.setGrants(mallory.id, { app: "lead" });
  const app = createHubApp({ hive, tokens, users });
  const route = (app as unknown as { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } }> } })
    .router.stack.find((layer) => layer.route?.path === "/api/rpc" && layer.route.methods.post)!.route!;
  type Caller = { bearer?: string; cookie?: string; label?: string; source?: string };
  const call = async (who: Caller, body: unknown, run = true) => {
    const headers: Record<string, string | undefined> = {
      authorization: who.bearer ? `Bearer ${who.bearer}` : undefined,
      cookie: who.cookie ? `hive_session=${who.cookie}` : undefined,
      "x-hive-csrf": who.cookie ? "1" : undefined,
      "x-hive-agent": who.label,
      "x-hive-source": who.source ? JSON.stringify({ via: who.source }) : undefined,
    };
    const req = { method: "POST", path: "/api/rpc", body, get: (key: string) => headers[key.toLowerCase()] };
    let status = 200;
    const res = { locals: {} as { actor?: Actor }, status: (code: number) => { status = code; return res; }, json: () => res };
    let authenticated = false;
    route.stack[0]!.handle(req as Request, res as unknown as Response, () => { authenticated = true; });
    if (authenticated && run) await route.stack.at(-1)!.handle(req as Request, res as unknown as Response, () => {});
    return { status, actor: res.locals.actor };
  };
  const actorOf = async (who: Caller) => (await call(who, {}, false)).actor!;

  try {
    const cap: TerminalCapability = { protocol: 1, enabled: true, projects: ["app"], platforms: ["linux"], auditReady: true, guiReady: true };
    const machineToken = tokens.create("machine", "agent", alice.id).token;
    const runner: Caller = { bearer: machineToken, label: "runner.test", source: "desktop" };
    // The hub, not the test, records who owns the machine: its heartbeat does.
    const beat = await call(runner, { method: "machines.heartbeat", input: { machine: "test", instance: "aaaaaaaa", projects: ["app"], terminal: cap } });
    assert.equal(beat.status, 200);
    const store = new TerminalStore(hive.db, () => new Date());
    const machine = store.machine("runner.test@machine")!;
    assert.equal(machine.owner, "alice");
    const session = store.create({
      project: "app", machineId: machine.id, creator: "alice", browserSession: "s", checkoutRef: "repo", reason: "", idempotencyKey: crypto.randomUUID(),
    });
    const report = (actor: Actor) => {
      const d = terminalDecision({ op: "machineReport", actor, hubEnabled: true, project: "app", machine: store.machine(machine.id), session });
      return d.ok ? "ok" : d.denial;
    };

    assert.equal(report(await actorOf(runner)), "ok");
    const lookalikes: Array<[string, string, string]> = [
      ["mallory's viewer token named like the machine", tokens.create("machine", "viewer", mallory.id).token, "desktop"],
      ["mallory's agent token named like the machine", tokens.create("machine", "agent", mallory.id).token, "desktop"],
      ["mallory's member token named like the machine", tokens.create("machine", "member", mallory.id).token, "desktop"],
      ["alice's own viewer token named like the machine", tokens.create("machine", "viewer", alice.id).token, "desktop"],
      ["the machine token used by an MCP server", machineToken, "mcp"],
    ];
    for (const [who, bearer, source] of lookalikes) {
      const actor = await actorOf({ bearer, label: "runner.test", source });
      assert.equal(actor.name, machine.id, `${who} does reach the machine's name`);
      assert.equal(report(actor), "notMachine", who);
    }
    const exchanged = tokens.issueMcp(machineToken, "app", false);
    assert.equal(report(await actorOf({ bearer: exchanged, label: "runner.test", source: "desktop" })), "notMachine", "MCP credential of the machine");
    const browser = await actorOf({ cookie: users.startSession(alice.id).token });
    assert.ok(browser.humanSession);
    assert.equal(report({ ...browser, name: machine.id }), "notMachine", "the owner's browser");
    assert.equal(terminalDecision({ op: "create", actor: browser, hubEnabled: true, project: "app", machine, stepUp: true }).ok, true,
      "while the same person may open one from the page");
  } finally {
    hive.close();
  }
});
