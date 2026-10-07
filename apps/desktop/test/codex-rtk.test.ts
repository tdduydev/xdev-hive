import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { readyCodexRtk } from "#desktop/main/runner/codex-rtk.ts";
import { SqliteHive } from "@xdev-hive/core/node";

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-codex-rtk-"));
  dirs.push(dir);
  return dir;
};

describe("Codex RTK adapter", () => {
  const fixture = async () => {
    const dir = tmp();
    const bin = path.join(dir, "original bin");
    mkdirSync(bin);
    const rtk = path.join(bin, "rtk");
    writeFileSync(rtk, `#!${process.execPath}\nimport {readFileSync} from 'node:fs';
if(process.argv[2]==='hook') {
  const input=JSON.parse(readFileSync(0,'utf8'));
  if(input.tool_input.command.startsWith('git ') && process.env.BAD_HOOK!=='1') console.log(JSON.stringify({hookSpecificOutput:{updatedInput:{command:'rtk '+input.tool_input.command}}}));
  else console.log('invalid JSON');
} else if(process.argv[2]==='git') {
  if(process.argv[3]==='fail') process.exit(23);
  console.log(JSON.stringify(process.argv.slice(3)));
} else if(process.argv[2]==='proxy') {
  const {spawnSync}=await import('node:child_process');
  process.exit(spawnSync(process.argv[3],process.argv.slice(4),{stdio:'inherit'}).status);
}`, { mode: 0o755 });
    writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nif(process.argv[2]==='fail') process.exit(23); if(process.argv[2]==='plain') console.log('original git'); else console.log(JSON.stringify(process.argv.slice(2)));`, { mode: 0o755 });
    const hive = new SqliteHive(":memory:");
    const entry = (await hive.call("tools.list", {}, { name: "test", role: "admin" })).find((e) => e.id === "rtk")!;
    hive.close();
    const ready = [{ entry, hooks: [{ event: "PreToolUse" as const, matcher: "Bash", argv: [rtk, "hook", "claude"] }] }];
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: dir };
    const result = readyCodexRtk({ ready, runDir: path.join(dir, "run"), env });
    return { dir, rtk, env: { ...env, ...result.env }, result };
  };

  it("wrapper preserves literal arguments, stdin, output and nonzero exit status without recursively wrapping RTK", async () => {
    const f = await fixture();
    const args = ["status", "it's a file", "$(touch should-not-exist)", "`echo nope`", "line\nbreak", "a; exit 9", ""];
    const git = path.join(f.dir, "run/bin/git");
    const output = execFileSync(git, args, { env: f.env, cwd: f.dir, encoding: "utf8" });
    assert.deepEqual(JSON.parse(output), args);
    assert.equal(spawnSync(git, ["fail"], { env: f.env }).status, 23);
    assert.deepEqual(JSON.parse(execFileSync(git, args, { env: { ...f.env, BAD_HOOK: "1" }, encoding: "utf8" })), args, "broken hook falls back to original argv");
    const cat = path.join(f.dir, "run/bin/cat");
    assert.equal(execFileSync(cat, [], { input: "literal stdin\n", env: f.env, encoding: "utf8" }), "literal stdin\n");
    assert.equal(process.env.PATH?.includes(path.join(f.dir, "run/bin")), false);
    assert.ok(f.result.args.includes("allow_login_shell=false"));
    assert.equal(execFileSync(path.join(f.dir, "run/bin/rtk"), ["proxy", "git", "plain"], { env: f.env, encoding: "utf8" }), "original git\n");
  });
});

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
