import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, readSyncOutcome, syncOutcome, type Actor, type HiveEvent } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy", role: "agent" };
const imac: Actor = { name: "runner.duy-imac@duy", role: "agent" };
const lan: Actor = { name: "runner.lan-pc@lan", role: "agent" };
/** May change what agents read in app (Quản lý dự án), only see web. */
const lead: Actor = { name: "hoa", role: "member", access: { projects: { app: "lead", web: "view" } } };
const member: Actor = { name: "an", role: "member", access: { projects: { app: "member" } } };
const code = (code: string) => (e: unknown) => e instanceof HiveError && e.code === code;

function clock(start = "2026-10-01T08:00:00.000Z") {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (minutes: number) => (t += minutes * 60_000) };
}

async function beat(hive: SqliteHive, actor: Actor, projects: string[]) {
  const machine = actor.name.split(".")[1]!.split("@")[0]!;
  return hive.call("machines.heartbeat", { machine, instance: "aaaaaaaa", projects }, actor);
}

describe("sync requests from the Context agent page (roadmap 22n)", () => {
  it("asks each online machine that has the project, once, and the machine hears it apart from installs", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    await beat(hive, imac, ["app"]);
    c.advance(5); // the iMac went quiet: offline
    await beat(hive, mbp, ["app", "web"]);
    await beat(hive, lan, ["web"]);

    const sent = await hive.call("docs.syncRequest", { project: "app" }, admin);
    assert.deepEqual(
      sent.map((x) => [x.machineId, x.kind, x.project, x.itemId, x.status, x.requestedBy]),
      [[mbp.name, "sync", "app", "sync:app", "pending", "duy"]],
      "only the online machine with the project",
    );
    const again = await hive.call("docs.syncRequest", { project: "app" }, admin);
    assert.deepEqual(again.map((x) => x.id), [sent[0]!.id], "an open request is reused, not doubled");

    const reply = await beat(hive, mbp, ["app", "web"]);
    assert.deepEqual(reply.syncCommands.map((x) => x.id), [sent[0]!.id]);
    assert.deepEqual(reply.commands, [], "never shown as an install to approve");
    assert.deepEqual((await beat(hive, lan, ["web"])).syncCommands, [], "another machine never sees it");
    assert.deepEqual((await hive.call("admin.machines", {}, admin)).flatMap((m) => m.commands), [], "the install list stays installs");

    await assert.rejects(hive.call("machines.commandResult", { id: sent[0]!.id, status: "running" }, lan), code("forbidden"));
    await hive.call("machines.commandResult", { id: sent[0]!.id, status: "running" }, mbp);
    assert.deepEqual((await beat(hive, mbp, ["app", "web"])).syncCommands, [], "not sent again once running");
    const outcome = { changed: ["AGENTS.md"], skipped: [], commit: "abc1234", mirrored: 2, note: null };
    await hive.call("machines.commandResult", { id: sent[0]!.id, status: "done", output: JSON.stringify(outcome) }, mbp);

    const status = await hive.call("docs.syncStatus", { project: "app" }, admin);
    assert.deepEqual(
      status.map((s) => [s.machineId, s.online, s.last?.status ?? null]),
      [
        [mbp.name, true, "done"],
        [imac.name, false, null],
      ],
    );
    assert.deepEqual(readSyncOutcome(status[0]!.last!.output), outcome);
    assert.deepEqual(await hive.call("docs.syncRequest", { project: "nothing" }, admin), [], "no machine has it");
  });

  it("takes contextEdit on the project to ask, view to look", async () => {
    const hive = new SqliteHive(":memory:");
    await beat(hive, mbp, ["app", "web"]);
    assert.equal((await hive.call("docs.syncRequest", { project: "app" }, lead)).length, 1);
    await assert.rejects(hive.call("docs.syncRequest", { project: "web" }, lead), code("forbidden"));
    await assert.rejects(hive.call("docs.syncRequest", { project: "app" }, member), code("forbidden"));
    await assert.rejects(hive.call("docs.syncRequest", { project: "app" }, mbp), code("forbidden"), "never a machine or agent token");
    await assert.rejects(hive.call("docs.syncStatus", { project: "web" }, member), code("not_found"));
    assert.equal((await hive.call("docs.syncStatus", { project: "app" }, member)).length, 1);

    const log = await hive.call("admin.audit", { action: "docs.syncRequest" }, admin);
    assert.deepEqual(log.map((e) => [e.actor, e.target, e.detailKey, e.detailVars]), [["hoa", "app", "audit.syncRequest", { count: 1 }]]);
  });

  it("expires a request no machine took or finished in 15 minutes, and tells no webhook", async () => {
    const c = clock();
    const events: HiveEvent[] = [];
    const hive = new SqliteHive(":memory:", { now: c.now, onEvent: (e) => events.push(e) });
    await beat(hive, mbp, ["app"]);
    const [taken] = await hive.call("docs.syncRequest", { project: "app" }, admin);
    await hive.call("machines.commandResult", { id: taken!.id, status: "running" }, mbp);
    c.advance(16);
    await beat(hive, mbp, ["app"]);
    assert.equal((await hive.call("docs.syncStatus", { project: "app" }, admin))[0]!.last!.status, "expired", "the app quit during the sync");
    await assert.rejects(hive.call("machines.commandResult", { id: taken!.id, status: "done" }, mbp), code("conflict"));

    const [next] = await hive.call("docs.syncRequest", { project: "app" }, admin);
    assert.notEqual(next!.id, taken!.id, "an expired one is not reused");
    await hive.call("machines.commandResult", { id: next!.id, status: "failed", output: "Không thấy thư mục repo" }, mbp);
    assert.equal(readSyncOutcome("Không thấy thư mục repo"), null);
    assert.deepEqual(events.filter((e) => e.type.startsWith("command.")), [], "webhooks tell about installs only");
  });

  it("sums up a sync report for the web", () => {
    const o = syncOutcome({
      project: "app",
      files: [
        { file: "AGENTS.md", action: "updated" },
        { file: "CLAUDE.md", action: "unchanged" },
        { file: ".claude/skills/deploy/SKILL.md", action: "skipped", note: "own skill" },
        { file: ".claude/rules/xdev-hive/old.md", action: "removed" },
      ],
      imported: [],
      commit: "abc1234",
      ownAgents: false,
      mirror: { commit: "def5678", changed: ["project/app/guide"], unchanged: 3, missing: [], skipped: [] },
    });
    assert.deepEqual(o, { changed: ["AGENTS.md", ".claude/rules/xdev-hive/old.md"], skipped: [".claude/skills/deploy/SKILL.md"], commit: "abc1234", mirrored: 1, note: null });
    assert.deepEqual(readSyncOutcome(JSON.stringify(o)), o);
  });
});
