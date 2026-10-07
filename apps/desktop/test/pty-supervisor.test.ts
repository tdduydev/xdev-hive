import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { PtySupervisor, readLocalPolicy, type Audit, type PtyBackend } from "#desktop/main/pty/supervisor.ts";

test("local PTY policy fails closed for missing/disabled/malformed/permissions/symlink/user/TTL", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-pty-policy-"));
  const file = join(dir, "policy.json");
  const good = { enabled: true, osUser: userInfo().username, projects: { demo: dir }, maxSessionMs: 1000 };
  const save = (p: unknown) => writeFileSync(file, JSON.stringify(p), { mode: 0o600 });
  try {
    assert.throws(() => readLocalPolicy(file), /policy-denied/);
    for (const bad of [{}, { ...good, enabled: false }, { ...good, osUser: "invalid-user" }, { ...good, maxSessionMs: 7_200_001 }, { ...good, projects: { demo: "relative" } }, { ...good, projects: [] }]) {
      save(bad); assert.throws(() => readLocalPolicy(file), /policy-denied/);
    }
    save(good); assert.deepEqual(readLocalPolicy(file), good);
    chmodSync(file, 0o644); assert.throws(() => readLocalPolicy(file), /policy-denied/);
    chmodSync(file, 0o600);
    const link = join(dir, "link"); symlinkSync(file, link); assert.throws(() => readLocalPolicy(link), /policy-denied/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("audit failure prevents native load/spawn; untrusted project and dimensions rejected first", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-pty-audit-"));
  const file = join(dir, "policy.json");
  writeFileSync(file, JSON.stringify({ enabled: true, osUser: userInfo().username, projects: { demo: dir }, maxSessionMs: 1000 }), { mode: 0o600 });
  let spawned = false;
  const events: Audit[] = [];
  const backend: PtyBackend = { spawn() { spawned = true; throw new Error("unexpected"); } };
  const s = new PtySupervisor({ policyFile: file, backend, audit(e) { events.push(e); throw new Error("disk-full"); }, output() {}, exit() {} });
  try {
    assert.throws(() => s.spawn("__proto__"), /project-denied/);
    assert.throws(() => s.spawn("demo", 1, 24), /size-invalid/);
    assert.throws(() => s.spawn("demo"), /disk-full/);
    const asyncSink = new PtySupervisor({ policyFile: file, backend,
      // Simulate a JS caller bypassing the synchronous sink type.
      audit: (() => Promise.resolve()) as unknown as (e: Audit) => undefined, output() {}, exit() {} });
    assert.throws(() => asyncSink.spawn("demo"), /audit-must-be-synchronous/);
    assert.equal(spawned, false);
    assert.deepEqual(events, [{ type: "spawn", cols: 80, rows: 24 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
