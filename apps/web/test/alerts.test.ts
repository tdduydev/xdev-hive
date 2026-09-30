import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Actor, HubAlert } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { AlertStore } from "#web/alerts.ts";
import { createHubApp } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";
import { WebhookStore } from "#web/webhooks.ts";

const runner: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const profile = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  kind: id.split("-")[0]!,
  enabled: true,
  account: null,
  installed: true,
  loggedIn: true,
  cooldownUntil: null,
  runs: 0,
  rateLimited: 0,
  ...over,
});

function setup(backup?: { dir: string; hours: number }) {
  const clock = { at: Date.parse("2026-09-30T08:00:00.000Z") };
  const now = () => new Date(clock.at);
  const hive = new SqliteHive(":memory:", { now });
  const webhooks = new WebhookStore(hive.db);
  const opened: HubAlert[] = [];
  const alerts = new AlertStore(hive, { webhooks, now, onOpen: (a) => opened.push(a), ...(backup ? { backup } : {}) });
  const later = (minutes: number) => (clock.at += minutes * 60_000);
  const iso = (offsetMinutes = 0) => new Date(clock.at + offsetMinutes * 60_000).toISOString();
  const beat = (profiles = [profile("claude-max-1"), profile("codex-team")]) =>
    hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", projects: ["app"], acceptsRuns: true, profiles }, runner);
  const failed = (runId: string, minutesAgo: number, status = "failed") => ({
    runId,
    project: "app",
    taskId: "T-7",
    taskTitle: "Retry webhook",
    role: "implement" as const,
    status: status as "failed",
    profileId: "claude-max-1",
    createdAt: iso(-minutesAgo - 5),
    startedAt: iso(-minutesAgo - 4),
    finishedAt: iso(-minutesAgo),
  });
  return { hive, webhooks, alerts, opened, later, iso, beat, failed };
}

const open = async (alerts: AlertStore) => (await alerts.list()).open.map((a) => `${a.rule} ${a.key}`);

describe("hub alerts", () => {
  it("opens an alert for a task failing three times within the hour, once, and ends it when that passes", async () => {
    const { hive, alerts, opened, later, failed } = setup();
    await hive.call("runs.push", { machine: "duy-mbp", runs: [failed("R-1", 50), failed("R-2", 30)] }, runner);
    assert.deepEqual(await open(alerts), [], "two are not a streak");
    await hive.call("runs.push", { machine: "duy-mbp", runs: [failed("R-3", 5)] }, runner);
    await alerts.check();
    await alerts.check();
    const [a] = (await alerts.list()).open;
    assert.deepEqual([a!.rule, a!.key, a!.severity, a!.vars.count, a!.project], ["run_fail_streak", "app/T-7", "high", 3, "app"]);
    assert.equal(opened.length, 1, "sent once, however often it is checked");
    later(30);
    await alerts.check();
    const list = await alerts.list();
    assert.deepEqual(list.open, []);
    assert.deepEqual([list.recent[0]!.rule, list.recent[0]!.resolvedBy], ["run_fail_streak", null], "it ended by itself");
  });

  it("sees a machine that stopped reporting, and a plan vendor with every plan resting", async () => {
    const { alerts, later, beat, iso } = setup();
    await beat([profile("claude-max-1", { cooldownUntil: iso(90) }), profile("claude-max-2", { cooldownUntil: iso(30) }), profile("codex-team")]);
    await alerts.check();
    const [resting] = (await alerts.list()).open;
    assert.deepEqual([resting!.rule, resting!.key, resting!.vars.count, resting!.vars.until], ["vendor_resting", "claude", 2, iso(30)]);
    later(61);
    await alerts.check();
    assert.deepEqual(await open(alerts), ["machine_offline runner.duy-mbp@duy-mbp"], "an offline machine's plans are not counted");
    await beat();
    await alerts.check();
    assert.deepEqual(await open(alerts), []);
  });

  it("keeps the quota rule off until an admin turns it on, and ends a rule's alerts when it is turned off", async () => {
    const { alerts, beat } = setup();
    await beat([profile("claude-max-1", { sessionPercent: 88, weekPercent: 40 }), profile("codex-team")]);
    assert.deepEqual(await open(alerts), []);
    assert.equal((await alerts.setRule("quota_near", true, "duy")).enabled, true);
    assert.deepEqual(await open(alerts), ["quota_near runner.duy-mbp@duy-mbp/claude-max-1"]);
    await alerts.setRule("quota_near", false, "duy");
    assert.deepEqual(await open(alerts), []);
    await assert.rejects(alerts.setRule("nope", true, "duy"), /Unknown alert rule/);
  });

  it("watches webhooks that fail, and CI that fails after the last fix run until a run of the task succeeds", async () => {
    const { hive, webhooks, alerts, later, failed } = setup();
    const w = webhooks.save({ name: "Kênh dev", kind: "slack", url: "https://hooks.slack.com/services/T/B/x9Qa", events: ["run.failed"], projects: [], locale: "vi", enabled: true });
    webhooks.record(w.id, "HTTP 500", new Date());
    alerts.onEvent({ type: "run.ciLimit", project: "app", run: { kind: "ci_limit", project: "app", taskId: "T-7", taskTitle: "x", runId: "R-4", profileId: null, role: "implement", error: null, mrUrl: null, mrIid: 84, machine: runner.name } });
    await alerts.check();
    const byRule = Object.fromEntries((await alerts.list()).open.map((a) => [a.rule, a]));
    assert.deepEqual(byRule.webhook_failed?.vars, { name: "Kênh dev", kind: "slack", error: "HTTP 500" });
    assert.deepEqual([byRule.ci_fix_exhausted?.vars.mr, byRule.ci_fix_exhausted?.vars.machine], [84, "duy-mbp"]);
    const acked = (await alerts.ack(byRule.ci_fix_exhausted!.id, "duy"));
    assert.equal(acked.ackedBy, "duy");
    assert.equal(acked.resolvedAt, null, "seen is not solved");
    later(10);
    await hive.call("runs.push", { machine: "duy-mbp", runs: [failed("R-5", 1, "succeeded")] }, runner);
    webhooks.record(w.id, null, new Date());
    await alerts.check();
    assert.deepEqual(await open(alerts), []);
  });

  it("finds a backup older than its interval, and not on a hub that just started", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-backups-"));
    const { alerts, later } = setup({ dir, hours: 24 });
    await alerts.check();
    assert.deepEqual(await open(alerts), []);
    const file = path.join(dir, "hub-2026-09-29T00-00-00-000Z.db");
    writeFileSync(file, "x");
    const old = new Date(Date.parse("2026-09-29T00:00:00Z"));
    utimesSync(file, old, old);
    await alerts.check();
    assert.deepEqual(await open(alerts), ["backup_overdue backup"], "32 hours old");
    later(0);
    utimesSync(file, new Date(Date.parse("2026-09-30T07:00:00Z")), new Date(Date.parse("2026-09-30T07:00:00Z")));
    await alerts.check();
    assert.deepEqual(await open(alerts), []);
  });

  it("feeds the overview what machines and people did, the newest first", async () => {
    const { hive, alerts, failed, later } = setup();
    await hive.call("runs.push", { machine: "duy-mbp", runs: [failed("R-1", 40), failed("R-2", 20), failed("R-3", 2)] }, runner);
    await alerts.check();
    later(1);
    const feed = await alerts.feed();
    assert.equal(feed[0]!.key, "feed.alertOpened");
    assert.equal(feed[0]!.vars.rule, "run_fail_streak");
    assert.ok(feed.some((e) => e.key === "feed.run.failed" && e.vars.task === "T-7" && e.src === "duy-mbp"));
    assert.ok(feed.some((e) => e.key === "feed.runStarted"));
    assert.deepEqual(
      feed.map((e) => e.at),
      [...feed.map((e) => e.at)].sort().reverse(),
    );
  });

  it("answers hub admins only", async () => {
    const hive = new SqliteHive(":memory:");
    const tokens = new TokenStore(hive.db);
    const admin = tokens.create("duy", "admin").token;
    const agent = tokens.create("duy-mbp", "agent").token;
    const app = createHubApp({ hive, tokens, users: new UserStore(hive.db), allowedHosts: ["127.0.0.1"], alerts: new AlertStore(hive) });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const rpc = async (token: string, method: string, input?: unknown) =>
      (await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ method, input }) })).status;
    try {
      assert.equal(await rpc(admin, "alerts.list"), 200);
      assert.equal(await rpc(admin, "alerts.feed", { limit: 10 }), 200);
      assert.equal(await rpc(agent, "alerts.list"), 403);
      assert.equal(await rpc(agent, "alerts.setRule", { rule: "quota_near", enabled: true }), 403);
    } finally {
      server.close();
    }
  });
});
