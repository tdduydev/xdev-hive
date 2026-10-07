import assert from "node:assert/strict";
import { it } from "node:test";
import { SqliteHive } from "@xdev-hive/core/node";
import { DeployLog, logPattern } from "#web/deploy-log.ts";
import { AlertStore } from "#web/alerts.ts";
import { HubInfoSource } from "#web/hubinfo.ts";

it("groups changing numbers and IDs, separates warnings, redacts before truncating, and expires at 24h", () => {
  let at = 0;
  const log = new DeployLog({ now: () => at });
  assert.equal(new DeployLog({ threshold: NaN }).threshold, 10);
  log.record("error", "other diagnostic");
  log.record("error", "[xdev-hive] request=alpha failed after 10ms");
  log.record("error", "[xdev-hive] request=beta failed after 20ms");
  log.record("warning", "[xdev-hive] request=beta failed after 20ms");
  log.record("error", `[xdev-hive] ${"x".repeat(3000)} sk-${"a".repeat(25)}`);
  const info = log.info();
  assert.equal(info.errors, 3);
  assert.equal(info.warnings, 1);
  assert.equal(info.groups[0]!.count, 2);
  assert.ok(info.groups.some((g) => g.message.includes("line hidden")));
  assert.ok(!JSON.stringify(info).includes("sk-"));
  assert.equal(logPattern("id=abc 550e8400-e29b-41d4-a716-446655440000 123"), logPattern("id=xyz 123e4567-e89b-12d3-a456-426614174000 456"));
  assert.equal(logPattern("run R-ab12 failed"), logPattern("run R-cd34 failed"));
  at = 24 * 3_600_000;
  assert.equal(log.info().errors, 0);
  assert.deepEqual(log.info().groups, []);
});

it("opens repeated errors only above N, deduplicates, resolves at the hour boundary, and obeys the rule switch", async () => {
  let at = Date.parse("2026-10-07T00:00:00Z");
  const now = () => new Date(at);
  const log = new DeployLog({ now: () => at, threshold: 2 });
  const hive = new SqliteHive(":memory:", { now });
  const opened: unknown[] = [];
  const alerts = new AlertStore(hive, { now, deployLog: log, onOpen: (a) => opened.push(a) });
  try {
    for (let n = 0; n < 2; n++) log.record("error", `[xdev-hive] retry ${n} failed`);
    for (let n = 0; n < 4; n++) log.record("warning", "[xdev-hive] noisy warning");
    await alerts.check();
    assert.equal((await alerts.list()).open.length, 0);
    log.record("error", "[xdev-hive] retry 3 failed");
    await alerts.check();
    await alerts.check();
    const [alert] = (await alerts.list()).open;
    assert.equal(alert!.rule, "hub_log_repeat");
    assert.equal(alert!.vars.count, 3);
    assert.equal(opened.length, 1);
    await alerts.setRule("hub_log_repeat", false, "admin");
    assert.equal((await alerts.list()).open.length, 0);
    await alerts.setRule("hub_log_repeat", true, "admin");
    assert.equal((await alerts.list()).open.length, 1);
    at += 3_600_000;
    await alerts.check();
    assert.equal((await alerts.list()).open.length, 0);
    assert.equal(log.info().errors, 3, "still kept for 24h");
  } finally { hive.close(); }
});

it("provides startup backup status and sanitized log data through hub.info", async () => {
  const log = new DeployLog();
  log.backup = "error";
  log.record("error", `[xdev-hive] token hive_${"a".repeat(32)}`);
  const hive = new SqliteHive(":memory:");
  try {
    const info = await new HubInfoSource({ hive, dbPath: ":memory:", deployLog: log }).info();
    assert.equal(info.deployLog?.backup, "error");
    assert.equal(info.deployLog?.startedAt, log.startedAt);
    assert.ok(!JSON.stringify(info).includes(`hive_${"a".repeat(32)}`));
  } finally { hive.close(); }
});

it("bounds memory during a log flood and reports evicted lines", () => {
  const log = new DeployLog({ now: () => 0 });
  for (let n = 0; n < 50_010; n++) log.record("error", "[xdev-hive] flood");
  assert.equal(log.info().errors, 50_000);
  assert.equal(log.info().dropped, 10);
});

it("never persists a credential in repeated-error alerts", async () => {
  const log = new DeployLog({ threshold: 1 });
  const token = `sk-${"b".repeat(30)}`;
  log.record("error", `[xdev-hive] request failed: ${token}`);
  log.record("error", `[xdev-hive] request failed: ${token}`);
  const hive = new SqliteHive(":memory:");
  try {
    const alerts = new AlertStore(hive, { deployLog: log });
    await alerts.check();
    const stored = JSON.stringify(hive.db.prepare("SELECT * FROM hub_alerts").all());
    assert.ok(stored.includes("hub_log_repeat"));
    assert.ok(stored.includes("line hidden"));
    assert.ok(!stored.includes(token));
  } finally { hive.close(); }
});
