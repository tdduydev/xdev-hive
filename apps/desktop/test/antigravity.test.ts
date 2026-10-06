import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { AGENT_TEMPLATES, OPEN_POLICY } from "@xdev-hive/core";
import { agyError, antigravityHome, supportsAgyUsage, parseAgyUsage } from "#desktop/main/runner/antigravity.ts";
import { checkLogin, checkUsage, loginParts, type RunCli } from "#desktop/main/runner/login.ts";
import { policyBlocks } from "#desktop/main/runner/command.ts";
import { parseResetAt } from "#desktop/main/runner/usage.ts";
import { AntigravityStream } from "#desktop/main/runner/stream.ts";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

const now = new Date("2026-10-06T06:00:00Z");
const profile = AGENT_TEMPLATES.antigravity;
const sample = readFileSync(path.join(import.meta.dirname, "fixtures", "agy-usage-1.3.0.json"), "utf8");

it("reads the real agy 1.3.0 quota, rounding used fractions and preserving resets", () => {
  const usage = parseAgyUsage(sample, [], now)!;
  assert.equal(usage.session?.percent, 0);
  assert.equal(usage.week?.percent, 1);
  assert.deepEqual(usage.others.map((w) => w.percent), [0, 0]);
  assert.equal(usage.checkedAt, now.toISOString());
  assert.equal(parseResetAt(usage.week?.resets, now)?.toISOString(), "2026-10-09T14:14:00.000Z");
  assert.equal(parseResetAt(usage.session?.resets, now)?.toISOString(), "2026-10-06T12:44:00.000Z");
  for (const model of ["--model=gpt-5", "--model=claude-sonnet"]) {
    const alternate = parseAgyUsage(sample, [model], now)!;
    assert.equal(alternate.week?.percent, 0);
    assert.deepEqual(alternate.others.map((w) => w.percent), [0, 1]);
    assert.equal(parseResetAt(alternate.week?.resets, now)?.toISOString(), "2026-10-13T07:44:00.000Z");
  }
});

it("uses bucket IDs or group names and windows, leaving invalid or missing quotas unknown", () => {
  const payload = (buckets: unknown[], name = "Gemini Models") => JSON.stringify({ command: { data: { groups: [{ name, buckets }] } } });
  assert.equal(parseAgyUsage(payload([{ id: "gemini-5h", remaining_fraction: 0.77 }], "renamed"), [], now)?.session?.percent, 23);
  const fallback = parseAgyUsage(payload([{ window: "weekly", remaining_fraction: 0, reset_time: "invalid" }]), [], now)!;
  assert.equal(fallback.week?.percent, 100);
  assert.equal(fallback.week?.resets, null);
  assert.equal(fallback.session, null);
  for (const remaining_fraction of [-1, 1.1, null, "1"]) {
    assert.equal(parseAgyUsage(payload([{ id: "gemini-5h", remaining_fraction }]), [], now), null);
  }
  for (const output of ["new format", "{}", '{"command":{"data":{"groups":[null,{}]}}}', '{"gemini":{"session":{"percent":0}}}']) {
    assert.equal(parseAgyUsage(output, [], now), null);
  }
});

it("never invokes /usage on old or unknown agy versions, including sign-in checks", async () => {
  const bin = testTmpDir(path.join(os.tmpdir(), "hive-agy-version-"));
  const agy = path.join(bin, "agy");
  writeFileSync(agy, "#!/bin/sh\nexit 0\n"); chmodSync(agy, 0o755);
  for (const version of ["agy 1.1.10", "not a version", "1.1.11-beta.1"]) {
    const calls: string[][] = [];
    const run: RunCli = async (_, args) => { calls.push(args); return { code: 0, output: version }; };
    assert.equal((await checkLogin(profile, { PATH: bin }, now, run)).loggedIn, null);
    assert.equal(await checkUsage(profile, { PATH: bin }, now, run), null);
    assert.deepEqual(calls, [["--version"], ["--version"]]);
  }
  assert.equal(supportsAgyUsage("agy 1.1.11"), true);
  assert.equal(supportsAgyUsage("agy 1.2.17"), true);
});

it("uses a fake agy binary for signed in, signed out and quota checks with profile env", async () => {
  const dir = testTmpDir(path.join(os.tmpdir(), "hive-agy-login-"));
  const file = path.join(dir, "agy");
  const fixture = path.join(import.meta.dirname, "fixtures", "fake-agent.mjs");
  writeFileSync(file, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`); chmodSync(file, 0o755);
  const run: RunCli = (bin, args, env) => new Promise((resolve) => execFile(bin, args, { env }, (err, stdout, stderr) => resolve({ code: err ? 3 : 0, output: stdout + stderr })));
  const p = { ...profile, env: { FAKE_AGY: "1", FAKE_AGY_VERSION: "agy 1.1.11", HOME: dir } };
  assert.equal((await checkLogin(p, { PATH: dir }, now, run)).loggedIn, true);
  assert.equal((await checkUsage(p, { PATH: dir }, now, run))?.week?.percent, 46);
  assert.equal((await checkLogin({ ...p, env: { ...p.env, FAKE_LOGIN: "out" } }, { PATH: dir }, now, run)).loggedIn, false);
  assert.deepEqual(loginParts({ ...p, env: { ...p.env, AGY_ADC_AUTH: "true", GOOGLE_CLOUD_QUOTA_PROJECT: "org", GEMINI_API_KEY: "never-export" } }), { args: [], env: { HOME: dir, AGY_ADC_AUTH: "true", GOOGLE_CLOUD_QUOTA_PROJECT: "org" } });
});

it("preserves unknown stream events and handles split chunks / final line", () => {
  const stream = new AntigravityStream();
  assert.equal(stream.push('{"type":"future",'), "");
  assert.match(stream.push('"custom":1}\n{"type":"assistant","text":"working"}\n'), /future/);
  assert.equal(stream.state.activity, "working");
  stream.push('{"type":"result","result":"done"}');
  assert.match(stream.end(), /done/);
  assert.equal(stream.lastText, "done");
});

it("does not bypass restrictive hub policies using unverified agy flags", () => {
  assert.equal(policyBlocks(profile, OPEN_POLICY), null);
  assert.ok(policyBlocks(profile, { ...OPEN_POLICY, autonomy: "read" }));
  assert.ok(policyBlocks(profile, { ...OPEN_POLICY, mcp: [] }));
});

it("isolates the second Linux profile HOME without claiming OS keyring isolation", () => {
  assert.equal(antigravityHome("agy-2", "linux", "/home/test", true), "/home/test/.xdev-hive/antigravity/agy-2");
  assert.equal(antigravityHome("agy-1", "linux", "/home/test", false), null);
  for (const platform of ["darwin", "win32"] as const) assert.equal(antigravityHome("agy-2", platform, "/home/test", true), null);
});

it("keeps the last AGY_ERROR payload, including an empty error marker", () => {
  assert.equal(agyError('AGY_ERROR: {"message":"earlier"}\nAGY_ERROR: {"message":"quota exhausted"}\n'), '{"message":"quota exhausted"}');
  assert.equal(agyError("AGY_ERROR:\n"), "");
  assert.equal(agyError("success"), null);
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
