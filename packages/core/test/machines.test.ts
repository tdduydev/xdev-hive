import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "#core/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const mbp: Actor = { name: "runner.duy-mbp@duy", role: "agent" };
const imac: Actor = { name: "runner.duy-imac@duy", role: "agent" };
const viewer: Actor = { name: "pm", role: "viewer" };
const admin: Actor = { name: "duy", role: "admin" };

function clock(start = "2026-09-27T08:00:00.000Z") {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (minutes: number) => (t += minutes * 60_000) };
}

const beat = (hive: SqliteHive, actor: Actor, instance: string, runs: unknown[] = []) =>
  hive.call("machines.heartbeat", { machine: actor.name.split(".")[1]!.split("@")[0]!, instance, version: "0.1.0", runs: runs as never }, actor);

const run = {
  runId: "R-abc123",
  project: "demo",
  taskId: "T-1",
  taskTitle: "Thêm trang cài đặt",
  role: "implement",
  status: "running",
  profileId: "claude-1",
  since: "2026-09-27T07:55:00.000Z",
};

describe("machines", () => {
  it("lists machines with their runs and marks silent ones offline", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    await beat(hive, mbp, "aaaaaaaa", [run]);
    await beat(hive, imac, "bbbbbbbb");
    let list = await hive.call("machines.list", {}, viewer);
    assert.deepEqual(list.map((m) => [m.machine, m.online, m.runs.length]), [["duy-mbp", true, 1], ["duy-imac", true, 0]]);
    assert.equal(list[0]!.runs[0]!.taskTitle, "Thêm trang cài đặt");

    c.advance(3);
    await beat(hive, imac, "bbbbbbbb");
    list = await hive.call("machines.list", {}, viewer);
    assert.deepEqual(list.map((m) => [m.machine, m.online]), [["duy-imac", true], ["duy-mbp", false]]);

    assert.deepEqual(await hive.call("machines.remove", { id: mbp.name }, admin), { removed: true });
    assert.equal((await hive.call("machines.list", {}, viewer)).length, 1);
  });

  it("flags two live apps under one machine name, but not a restart", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    for (const instance of ["aaaaaaaa", "aaaaaaaa", "bbbbbbbb", "bbbbbbbb"]) {
      assert.equal((await beat(hive, mbp, instance)).duplicate, false, "a restart switches instance once");
      c.advance(0.5);
    }
    assert.equal((await beat(hive, mbp, "aaaaaaaa")).duplicate, true, "the old instance is back: two apps");
    assert.equal((await hive.call("machines.list", {}, viewer))[0]!.duplicate, true);
    c.advance(6);
    assert.equal((await beat(hive, mbp, "aaaaaaaa")).duplicate, false, "clears once only one app is left");
  });

  it("drops machines silent for two weeks", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    await beat(hive, mbp, "aaaaaaaa");
    c.advance(15 * 24 * 60);
    await beat(hive, imac, "bbbbbbbb");
    assert.deepEqual((await hive.call("machines.list", {}, viewer)).map((m) => m.machine), ["duy-imac"]);
  });

  it("needs the agent role to report", async () => {
    const hive = new SqliteHive(":memory:");
    const readOnly: Actor = { name: "runner.pm-laptop@pm", role: "viewer" };
    await assert.rejects(beat(hive, readOnly, "aaaaaaaa"), (e: unknown) => e instanceof HiveError && e.code === "forbidden");
  });
});

describe("quota cooldowns", () => {
  const report = (hive: SqliteHive, actor: Actor, account: string) => hive.call("machines.heartbeat", {
    machine: "test", instance: "aaaaaaaa", profiles: [{ id: "test", label: "Test", kind: "claude", account, installed: true, enabled: true, cooldownUntil: null, runs: 0, rateLimited: 0 }],
  }, actor);

  it("shares a cooldown per account until it ends, last report wins", async () => {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    await report(hive, mbp, "claude-max-duy");
    await report(hive, imac, "claude-max-duy");
    const set = await hive.call("cooldowns.set", { account: "claude-max-duy", until: "2026-09-27T10:13:00.000Z", reason: "usage limit" }, mbp);
    assert.equal(set?.reportedBy, mbp.name);
    await hive.call("cooldowns.set", { account: "claude-max-duy", until: "2026-09-27T09:00:00.000Z", reason: "resets 9am" }, imac);

    const beatReply = await beat(hive, imac, "bbbbbbbb");
    assert.deepEqual(beatReply.cooldowns.map((x) => [x.account, x.until, x.reportedBy]), [["claude-max-duy", "2026-09-27T09:00:00.000Z", imac.name]]);

    c.advance(61);
    assert.deepEqual(await hive.call("cooldowns.list", {}, viewer), [], "expired cooldowns disappear");
  });

  it("clears on request and ignores a reset time already past", async () => {
    const hive = new SqliteHive(":memory:", { now: clock().now });
    await report(hive, mbp, "codex-plus");
    await report(hive, imac, "codex-plus");
    await hive.call("cooldowns.set", { account: "codex-plus", until: "2026-09-27T09:00:00.000Z", reason: "429" }, mbp);
    assert.deepEqual(await hive.call("cooldowns.clear", { account: "codex-plus" }, imac), { cleared: true });
    assert.equal(await hive.call("cooldowns.set", { account: "codex-plus", until: "2026-09-27T07:00:00.000Z", reason: "429" }, mbp), null);
    assert.deepEqual(await hive.call("cooldowns.list", {}, viewer), []);
  });

  it("refuses secrets and bad account names", async () => {
    const hive = new SqliteHive(":memory:", { now: clock().now });
    await report(hive, mbp, "x");
    const until = "2026-09-27T09:00:00.000Z";
    await assert.rejects(hive.call("cooldowns.set", { account: "x", until, reason: `key sk-${"a".repeat(30)}` }, mbp), /secret|API key/i);
    await assert.rejects(hive.call("cooldowns.set", { account: "has space", until, reason: "" }, mbp), /account/);
    await assert.rejects(hive.call("cooldowns.set", { account: "ok", until: "tomorrow", reason: "" }, mbp), (e: unknown) => e instanceof HiveError && e.code === "bad_request");
  });
});

describe("profiles changed from the web (roadmap 18d)", () => {
  // The machine's token belongs to Duy's account; Hoa is another member, Tú a hub admin.
  const machine: Actor = { name: "runner.duy-mbp@duy-mbp", role: "member", account: "duy", onBehalf: "duy" };
  const duy: Actor = { name: "duy", role: "member", account: "duy", source: { via: "web" } };
  const hoa: Actor = { name: "hoa", role: "member", account: "hoa", source: { via: "web" } };
  const hubAdmin: Actor = { name: "tu", role: "admin", account: "tu", source: { via: "web" } };
  const profile = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    label: id,
    kind: "claude",
    enabled: true,
    account: null,
    installed: true,
    cooldownUntil: null,
    runs: 0,
    rateLimited: 0,
    priority: 10,
    ...over,
  });

  async function setup(profiles = [profile("claude-1"), profile("codex-1", { kind: "codex", priority: 20 })]) {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    const report = (ps: unknown[]) => hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "aaaaaaaa", version: "0.95.0", runs: [], profiles: ps as never }, machine);
    await report(profiles);
    return { hive, c, report };
  }
  const forbidden = (e: unknown) => e instanceof HiveError && e.code === "forbidden" && e.key === "errors.machineProfileForbidden";

  it("keeps the account the machine's token belongs to as its owner", async () => {
    const { hive } = await setup();
    assert.equal((await hive.call("machines.list", {}, viewer))[0]!.owner, "duy");
    // A token of no account owns nothing, even though onBehalf carries its name.
    await hive.call("machines.heartbeat", { machine: "ci", instance: "bbbbbbbb", version: "0.95.0", runs: [] }, { name: "runner.ci@ci", role: "agent", onBehalf: "ci" });
    assert.equal((await hive.call("machines.list", {}, viewer)).find((m) => m.machine === "ci")!.owner, null);
  });

  it("lets the owner and a hub admin change a profile, not another member or an agent on the owner's token", async () => {
    const { hive } = await setup();
    const id = machine.name;
    await assert.rejects(hive.call("machines.setProfile", { machineId: id, profileId: "claude-1", enabled: false }, hoa), forbidden);
    // A restricted account is no hub admin, whatever its role says.
    await assert.rejects(hive.call("machines.setProfile", { machineId: id, profileId: "claude-1", enabled: false }, { ...hubAdmin, access: { projects: {} } as never }), forbidden);
    const agent: Actor = { name: "claude-1.duy-mbp@duy-mbp", role: "member", account: "duy", agent: "claude-1.duy-mbp", source: { via: "mcp" } };
    await assert.rejects(hive.call("machines.setProfile", { machineId: id, profileId: "claude-1", enabled: false }, agent), forbidden);

    let m = await hive.call("machines.setProfile", { machineId: id, profileId: "claude-1", enabled: false }, duy);
    assert.deepEqual(m.profileChanges.map((c) => [c.profileId, c.enabled, c.priority, c.requestedBy]), [["claude-1", false, null, "duy"]]);
    m = await hive.call("machines.setProfile", { machineId: id, profileId: "codex-1", priority: 5 }, hubAdmin);
    assert.deepEqual(m.profileChanges.map((c) => [c.profileId, c.enabled, c.priority, c.requestedBy]), [["claude-1", false, null, "duy"], ["codex-1", null, 5, "tu"]]);
    const log = (await hive.call("admin.audit", { limit: 10 }, admin)).filter((e) => e.action === "machines.setProfile");
    assert.deepEqual(log.map((e) => [e.target, e.detailKey]), [["duy-mbp/codex-1", "audit.profilePriority"], ["duy-mbp/claude-1", "audit.profileOff"]]);
  });

  it("sends the change at each heartbeat until the machine reports the profile as asked", async () => {
    const { hive, report } = await setup();
    await hive.call("machines.setProfile", { machineId: machine.name, profileId: "claude-1", enabled: false, priority: 3 }, duy);
    let beat = await report([profile("claude-1"), profile("codex-1", { priority: 20 })]);
    assert.deepEqual(beat.profileChanges.map((c) => [c.profileId, c.enabled, c.priority]), [["claude-1", false, 3]], "still as before: sent again");
    beat = await report([profile("claude-1", { enabled: false }), profile("codex-1", { priority: 20 })]);
    assert.equal(beat.profileChanges.length, 1, "half done: the priority is still to come");
    beat = await report([profile("claude-1", { enabled: false, priority: 3 }), profile("codex-1", { priority: 20 })]);
    assert.deepEqual(beat.profileChanges, []);
    assert.deepEqual((await hive.call("machines.list", {}, viewer))[0]!.profileChanges, []);
  });

  it("merges a second change into the waiting one, and switching back cancels it", async () => {
    const { hive } = await setup();
    const id = machine.name;
    await hive.call("machines.setProfile", { machineId: id, profileId: "claude-1", enabled: false }, duy);
    let m = await hive.call("machines.setProfile", { machineId: id, profileId: "claude-1", priority: 1 }, duy);
    assert.deepEqual(m.profileChanges.map((c) => [c.enabled, c.priority]), [[false, 1]]);
    m = await hive.call("machines.setProfile", { machineId: id, profileId: "claude-1", enabled: true, priority: 10 }, duy);
    assert.deepEqual(m.profileChanges, [], "the machine already has it so");
  });

  it("drops a change for a profile the machine no longer has, and one the machine never took within a day", async () => {
    const { hive, c, report } = await setup();
    const id = machine.name;
    await hive.call("machines.setProfile", { machineId: id, profileId: "codex-1", enabled: false }, duy);
    assert.deepEqual((await report([profile("claude-1")])).profileChanges, [], "codex-1 is gone from the machine");
    await hive.call("machines.setProfile", { machineId: id, profileId: "claude-1", enabled: false }, duy);
    c.advance(23 * 60);
    assert.equal((await report([profile("claude-1")])).profileChanges.length, 1);
    c.advance(2 * 60);
    assert.deepEqual((await report([profile("claude-1")])).profileChanges, []);
  });

  it("refuses an unknown profile, an unknown machine, and a machine whose app cannot take changes", async () => {
    const { hive, report } = await setup();
    await assert.rejects(hive.call("machines.setProfile", { machineId: machine.name, profileId: "gemini-1", enabled: false }, duy), (e: unknown) => e instanceof HiveError && e.key === "errors.machineProfileNotFound");
    await assert.rejects(hive.call("machines.setProfile", { machineId: "runner.nope@x", profileId: "claude-1", enabled: false }, hubAdmin), (e: unknown) => e instanceof HiveError && e.code === "not_found");
    // An app older than 0.95 reports no priority.
    const { priority: _, ...old } = profile("claude-1");
    await report([old]);
    await assert.rejects(hive.call("machines.setProfile", { machineId: machine.name, profileId: "claude-1", enabled: false }, duy), (e: unknown) => e instanceof HiveError && e.key === "errors.machineAppTooOld");
    await assert.rejects(hive.call("machines.setProfile", { machineId: machine.name, profileId: "claude-1" } as never, duy), (e: unknown) => e instanceof HiveError && e.code === "bad_request");
  });
});

describe("quota outlook heartbeat", () => {
  it("keeps machine estimates and Codex metadata through validation and storage", async () => {
    const hive = new SqliteHive(":memory:");
    const outlook = { sessionResetsAt: "2026-10-06T15:00:00+07:00", weekResetsAt: "2026-10-12T15:00:00Z", running: 2, resetsLeft: 23, fullSessionsLeft: 9.5, weekPerSession: 8, credits: { balance: "0", hasCredits: false, unlimited: false }, planType: "plus", spendControlReached: true };
    await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "aaaaaaaa", version: "0.1.0", profiles: [{ id: "codex", label: "Codex", kind: "codex", enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0, ...outlook }] }, mbp);
    const profile = (await hive.call("machines.list", {}, viewer))[0]!.profiles[0]!;
    for (const key of Object.keys(outlook) as Array<keyof typeof outlook>) assert.deepEqual(profile[key], outlook[key]);
    hive.close();
  });
});

describe("remote runner settings", () => {
  const owner: Actor = { name: "lan", role: "member", account: "lan" };
  const machine: Actor = { name: "runner.remote@lan", role: "agent", account: "lan" };
  const settings = { maxParallel: 2, mrEnabled: false, mrWhen: "after_review" as const };
  const p = { id: "claude-1", label: "Claude", kind: "claude", enabled: true, installed: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0, priority: 10, stopAtSession: 95, stopAtWeek: 90 };
  function setup() {
    const c = clock();
    const hive = new SqliteHive(":memory:", { now: c.now });
    const report = (extra = {}) => hive.call("machines.heartbeat", { machine: "remote", instance: "abcdef01", profiles: [p], runnerSettings: settings, ...extra }, machine);
    return { hive, c, report };
  }
  it("allows owner and hub admin, denies other people, scoped admins and agents; audits settings", async () => {
    const { hive, report } = setup(); await report();
    const input = { machineId: machine.name, settings: { maxParallel: 4, mrEnabled: true } };
    for (const actor of [{ name: "other", role: "member", account: "other" }, { ...admin, access: { projects: {} } }, machine, { ...admin, agent: "codex.remote" }] as Actor[]) {
      await assert.rejects(hive.call("machines.setRunner", input, actor), (e: unknown) => e instanceof HiveError && e.code === "forbidden");
    }
    let m = await hive.call("machines.setRunner", input, owner);
    assert.deepEqual(m.runnerChange?.settings, input.settings);
    m = await hive.call("machines.setRunner", { machineId: machine.name, settings: { mrWhen: "after_success" } }, admin);
    assert.deepEqual(m.runnerChange?.settings, { ...input.settings, mrWhen: "after_success" });
    const audit = (await hive.call("admin.audit", { limit: 10 }, admin)).filter(e => e.action === "machines.setRunner");
    assert.equal(audit.length, 2);
    assert.match(audit[0]!.detail!, /after_success/);
  });
  it("resends until all settings are reported, handles reverting pending changes, expires after a day", async () => {
    const { hive, c, report } = setup(); await report();
    await hive.call("machines.setRunner", { machineId: machine.name, settings: { maxParallel: 4, mrEnabled: true } }, owner);
    assert.deepEqual((await report()).runnerChange?.settings, { maxParallel: 4, mrEnabled: true });
    assert.ok((await report({ runnerSettings: { ...settings, maxParallel: 4 } })).runnerChange);
    assert.equal((await report({ runnerSettings: { ...settings, maxParallel: 4, mrEnabled: true } })).runnerChange, null);
    assert.equal((await hive.call("machines.list", {}, viewer))[0]!.maxParallel, 4);
    await hive.call("machines.setRunner", { machineId: machine.name, settings: { maxParallel: 3 } }, owner);
    assert.equal((await hive.call("machines.setRunner", { machineId: machine.name, settings: { maxParallel: 4 } }, owner)).runnerChange, null);
    await hive.call("machines.setRunner", { machineId: machine.name, settings: { maxParallel: 3 } }, owner);
    c.advance(24 * 60 + 1); assert.equal((await report()).runnerChange, null);
  });
  it("requires capability and validates public settings with the desktop's bounds", async () => {
    const { hive, report } = setup(); await report({ runnerSettings: undefined, profiles: [{ ...p, stopAtSession: undefined, stopAtWeek: undefined }] });
    await assert.rejects(hive.call("machines.setRunner", { machineId: machine.name, settings: { maxParallel: 4 } }, owner), (e: unknown) => e instanceof HiveError && e.key === "errors.machineAppTooOld");
    await assert.rejects(hive.call("machines.setProfile", { machineId: machine.name, profileId: p.id, stopAtSession: 50 }, owner), (e: unknown) => e instanceof HiveError && e.key === "errors.machineAppTooOld");
    await report();
    for (const settings of [{}, { maxParallel: 0 }, { maxParallel: 9 }, { maxParallel: 1.5 }, { mrEnabled: "true" }, { mrWhen: "other" }, { token: "private" }]) {
      await assert.rejects(hive.call("machines.setRunner", { machineId: machine.name, settings } as never, owner), (e: unknown) => e instanceof HiveError && e.code === "bad_request");
    }
    await report({ runnerSettings: undefined });
    await assert.rejects(hive.call("machines.setRunner", { machineId: machine.name, settings: { mrEnabled: true } }, owner), (e: unknown) => e instanceof HiveError && e.key === "errors.machineAppTooOld");
    for (const stopAtSession of [0, 101, 1.5]) await assert.rejects(hive.call("machines.setProfile", { machineId: machine.name, profileId: p.id, stopAtSession }, owner));
  });
  it("coalesces thresholds with enabled/priority and waits for full acknowledgement", async () => {
    const { hive, report } = setup(); await report();
    await hive.call("machines.setProfile", { machineId: machine.name, profileId: p.id, enabled: false, stopAtSession: 70 }, owner);
    await hive.call("machines.setProfile", { machineId: machine.name, profileId: p.id, stopAtWeek: 60, priority: 5 }, admin);
    let b = await report({ profiles: [{ ...p, enabled: false, priority: 5, stopAtSession: 70 }] });
    assert.equal(b.profileChanges.length, 1);
    assert.equal(b.profileChanges[0]!.stopAtWeek, 60);
    b = await report({ profiles: [{ ...p, enabled: false, priority: 5, stopAtSession: 70, stopAtWeek: 60 }] });
    assert.deepEqual(b.profileChanges, []);
    const audit = (await hive.call("admin.audit", { limit: 10 }, admin)).filter(e => e.action === "machines.setProfile");
    assert.match(audit[0]!.detail!, /stopAtWeek/);
  });
});


it("migrates existing machines and pending profile changes without losing them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-machine-settings-migration-"));
  const file = join(dir, "hub.db");
  try {
    const before = new SqliteHive(file, { migrateTo: migrationIndex("ADD COLUMN runner_settings") });
    before.db.prepare("INSERT INTO machines(id, machine, instance, version, runs, last_seen, profiles, projects, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("runner.remote@lan", "remote", "abcdef01", "0.146.1", "[]", "2026-10-08T00:00:00.000Z", "[]", "[]", "lan");
    before.db.prepare("INSERT INTO machine_profile_changes(machine_id, profile_id, enabled, priority, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("runner.remote@lan", "claude-1", 0, 5, "lan", "2026-10-08T00:00:00.000Z");
    before.close();
    const after = new SqliteHive(file);
    try {
      const m = (await after.call("machines.list", {}, viewer))[0]!;
      assert.equal(m.owner, "lan");
      assert.equal(m.runnerSettings, undefined);
      assert.equal(m.runnerChange, null);
      assert.equal(m.profileChanges[0]!.enabled, false);
      assert.equal(m.profileChanges[0]!.priority, 5);
      assert.equal(m.profileChanges[0]!.stopAtSession, null);
      assert.equal(m.profileChanges[0]!.stopAtWeek, null);
    } finally { after.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("persists the latest system snapshot, retaining it when older apps omit it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-system-"));
  const file = join(dir, "hub.sqlite");
  let hive = new SqliteHive(file, { migrateTo: migrationIndex("ADD COLUMN system") });
  try {
    await beat(hive, mbp, "aaaaaaaa");
    hive.close();
    hive = new SqliteHive(file);
    assert.equal((await hive.call("machines.list", {}, viewer))[0]!.system, undefined);
    const system = { os: "macos" as const, osName: "macOS 26.0", hardware: "Mac mini", uptimeSeconds: 600, cpu: { percent: 24, detail: "", cores: 14, load: 2.4 } };
    await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "aaaaaaaa", system }, mbp);
    assert.deepEqual((await hive.call("machines.list", {}, viewer))[0]!.system, system);
    const next = { ...system, cpu: { ...system.cpu, percent: 99 } };
    await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "aaaaaaaa", system: next }, mbp);
    await beat(hive, mbp, "aaaaaaaa");
    hive.close(); hive = new SqliteHive(file);
    assert.deepEqual((await hive.call("machines.list", {}, viewer))[0]!.system, next);
    for (const bad of [{ ...next, hardware: "x".repeat(301) }, { ...next, cpu: { ...next.cpu, percent: 101 } }, { ...next, uptimeSeconds: -1 }]) {
      await assert.rejects(() => hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "aaaaaaaa", system: bad }, mbp));
    }
  } finally { hive.close(); rmSync(dir, { recursive: true, force: true }); }
});
