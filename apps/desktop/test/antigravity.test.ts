import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { AGENT_TEMPLATES, OPEN_POLICY } from "@xdev-hive/core";
import { agyError, antigravityHome, supportsAgyUsage, parseAgyUsage } from "#desktop/main/runner/antigravity.ts";
import { checkLogin, checkUsage, loginParts, type RunCli } from "#desktop/main/runner/login.ts";
import { policyBlocks } from "#desktop/main/runner/command.ts";
import { AntigravityStream } from "#desktop/main/runner/stream.ts";

const now = new Date("2026-10-06T06:00:00Z");
const profile = AGENT_TEMPLATES.antigravity;
const sample = { pools: { gemini: { session: { percent: 23 }, week: { percent: 46 } }, claude_gpt: { five_hour: { used_percent: 37 }, weekly: { usedPercent: 62 } } } };

it("reads both provisional pools, chooses Claude/GPT by model, leaves unknown windows unknown", () => {
  const usage = parseAgyUsage(JSON.stringify(sample), [], now)!;
  assert.equal(usage.session?.percent, 23);
  assert.equal(usage.week?.percent, 46);
  assert.deepEqual(usage.others.map((w) => w.percent), [37, 62]);
  assert.equal(parseAgyUsage(JSON.stringify(sample), ["--model=gpt-5"], now)?.session?.percent, 37);
  assert.equal(parseAgyUsage('{"gemini":{"session":{"percent":200},"week":{"percent":null}}}', [], now), null);
  assert.equal(parseAgyUsage("new format", [], now), null);
  assert.equal(parseAgyUsage('{"gemini":{"session":{"percent":0}}}', [], now)?.week, null);
});

it("never invokes /usage on old or unknown agy versions, including sign-in checks", async () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), "hive-agy-version-"));
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-agy-login-"));
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
