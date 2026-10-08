// Run with Electron-as-Node, never the host Node. The module may live inside ASAR.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.ok(process.versions.electron, 'Use ELECTRON_RUN_AS_NODE=1 <Electron executable> scripts/pty-smoke.mjs <supervisor module>');
const { PtySupervisor } = await import(pathToFileURL(resolve(process.argv[2] ?? 'out/main/pty-supervisor.js')).href);
const root = mkdtempSync(join(tmpdir(), 'hive-pty-spike-'));
const policyFile = join(root, 'local.json');
const policy = { enabled: true, osUser: userInfo().username, projects: { fixture: root }, maxSessionMs: 60_000 };
const save = value => { writeFileSync(policyFile, JSON.stringify(value), { mode: 0o600 }); chmodSync(policyFile, 0o600); };
let output = '';
const audit = [];
let exited = false;
let failAudit = false;
const s = new PtySupervisor({ policyFile, audit: e => { if (failAudit) throw new Error('synthetic-disk-full'); audit.push(e); }, output: d => { output += d; }, exit: () => { exited = true; } });
const waitFor = async (predicate, label) => {
  const until = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > until) throw new Error(`Timeout: ${label}`); await new Promise(r => setTimeout(r, 25)); }
};
const waitText = text => waitFor(() => output.includes(text), text);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  assert.throws(() => s.spawn('fixture'), /policy-denied/);
  save({ ...policy, enabled: false });
  assert.throws(() => s.spawn('fixture'), /policy-denied/);
  save(policy);
  assert.throws(() => s.spawn('other'), /project-denied/);
  process.env.HIVE_PTY_SYNTHETIC_SECRET = 'must-not-inherit';
  s.spawn('fixture');
  assert.throws(() => s.spawn('fixture'), /busy/);
  await waitText('hive-spike$');
  s.write("printf 'ENV:%s:HISTORY:%s:END\\n' \"${HIVE_PTY_SYNTHETIC_SECRET-unset}\" \"$HISTFILE\"\r");
  await waitText('ENV:unset:HISTORY:/dev/null:END');
  s.resize(101, 37);
  s.write('stty size\r');
  await waitText('37 101');
  assert.throws(() => s.resize(401, 24), /size-invalid/);
  assert.throws(() => s.write('x'.repeat(16_385)), /input-too-large/);
  s.write("stty -echo; printf 'NOECHO_READY\\n'; read -r hidden; unset hidden; stty echo; printf 'NOECHO_DONE\\n'\r");
  await waitText('\r\nNOECHO_READY\r\n');
  const canary = 'synthetic-password-69b';
  s.write(canary + '\r');
  await waitText('\r\nNOECHO_DONE\r\n');
  assert.ok(!output.includes(canary), 'No-echo input absent from PTY output');
  assert.ok(!JSON.stringify(audit).includes(canary), 'No input content in audit');
  assert.ok(audit.some(e => e.type === 'sensitive-input' && e.bytes === canary.length + 1));
  s.write("/bin/sh -c 'trap \"\" TERM HUP; sleep 120 & printf \"GRAND:%s:END\\n\" $!; wait' & printf 'CHILD:%s:END\\n' $!\r");
  await waitFor(() => /CHILD:\d+:END/.test(output), 'background child');
  const child = Number(output.match(/CHILD:(\d+):END/)[1]);
  assert.ok(alive(child));
  await waitFor(() => /GRAND:\d+:END/.test(output), 'grandchild');
  const grandchild = Number(output.match(/GRAND:(\d+):END/)[1]);
  assert.ok(alive(grandchild));
  save({ ...policy, enabled: false });
  await waitFor(() => exited, 'local opt-out kills shell');
  await s.stop();
  await waitFor(() => !alive(child), 'SIGKILL removes TERM-resistant background child');
  await waitFor(() => !alive(grandchild), 'SIGKILL removes grandchild');
  assert.throws(() => s.write('blocked\r'), /not-active/);
  save({ ...policy, maxSessionMs: 1000 });
  exited = false;
  s.spawn('fixture');
  await waitFor(() => exited, 'absolute timeout');
  await s.stop();
  save(policy);
  exited = false;
  output = '';
  s.spawn('fixture');
  await waitText('hive-spike$');
  failAudit = true;
  assert.throws(() => s.write('echo MUST_NOT_EXECUTE\r'), /input-failed/);
  await s.stop();
  assert.ok(!output.includes('MUST_NOT_EXECUTE'));
  console.log(JSON.stringify({ status: 'PASS', platform: process.platform, arch: process.arch, electron: process.versions.electron,
    node: process.versions.node, modules: process.versions.modules, napi: process.versions.napi,
    checks: ['default-off', 'local-opt-in', 'project-allowlist', 'max-one', 'spawn', 'minimal-env', 'history-off', 'resize', 'input-limit', 'no-echo', 'input-markers', 'local-opt-out', 'process-tree-kill', 'ttl', 'audit-failure-closes-before-input'],
    cleanupUncertain: true }));
} finally { await s.stop(); rmSync(root, { recursive: true, force: true }); }
