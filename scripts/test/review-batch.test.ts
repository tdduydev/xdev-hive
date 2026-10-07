import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const script = resolve(import.meta.dirname, "..", "review-batch.mjs");
const tmp = mkdtempSync(join(tmpdir(), "review-batch-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const globalConfig = join(tmp, "gitconfig");
writeFileSync(globalConfig, "");
const fakeNpm = join(tmp, "npm.mjs");
writeFileSync(fakeNpm, `
import { appendFileSync, existsSync, mkdirSync, writeFileSync, writeSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.BATCH_CALLS, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'ci') mkdirSync('node_modules', { recursive: true });
const name = args[0] === 'run' ? args[1] : args[0];
const once = process.env.BATCH_CALLS + '.once';
const failOnce = name === process.env.BATCH_FAIL_ONCE && !existsSync(once);
if (failOnce) writeFileSync(once, name);
if ((name === 'typecheck' && existsSync('fail.txt')) || name === process.env.BATCH_FAIL || failOnce) {
  writeSync(2, 'fake check failed: ' + name + '\\n');
  process.exit(7);
}
writeSync(1, 'fake check passed: ' + name + '\\n');
`);
const fakeSsh = join(tmp, "ssh.mjs");
writeFileSync(fakeSsh, `
import { spawn } from 'node:child_process';
const command = process.argv.at(-1);
const match = /^git-upload-pack '([^']*)'$/.exec(command);
if (!match) { console.error('Unexpected SSH command: ' + command); process.exit(2); }
const child = spawn('git-upload-pack', [match[1]], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
`);

function fixture() {
  const root = mkdtempSync(join(tmp, "case-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1",
    npm_execpath: fakeNpm, BATCH_CALLS: join(root, "calls.jsonl"), DISPLAY: ":fake",
    // A Git SSH transport shim forwards only to the throwaway repo, never the network.
    GIT_SSH_COMMAND: `'${process.execPath}' '${fakeSsh}'`, GIT_SSH_VARIANT: "ssh",
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (file: string, content: string | Buffer) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), content);
  };
  const commit = (message: string) => { git("add", "."); git("commit", "-qm", message); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Batch Test");
  git("config", "user.email", "batch@example.test");
  git("config", "commit.gpgSign", "false");
  put(".gitignore", "node_modules/\n.xdev-hive/artifacts/\n");
  put("package.json", '{"name":"fixture","version":"1.0.0"}\n');
  put("package-lock.json", '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}\n');
  put("shared.txt", "original\n");
  put("binary.dat", Buffer.from([0, 1, 2]));
  const initial = commit("initial");
  const branch = (name: string, files: Record<string, string | Buffer>, base = initial) => {
    git("checkout", "-qb", name, base);
    for (const [file, body] of Object.entries(files)) put(file, body);
    const sha = commit(name);
    git("checkout", "-q", "main");
    return sha;
  };
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const output = join(root, "cli.log");
    const fd = openSync(output, "w");
    try {
      const result = spawnSync(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ...extraEnv }, stdio: ["ignore", fd, fd] });
      assert.equal(result.error, undefined, result.error?.message);
      return { code: result.status, output: readFileSync(output, "utf8") };
    } finally {
      closeSync(fd);
    }
  };
  const report = (name: string) => JSON.parse(readFileSync(join(root, `review-${name}`, ".xdev-hive", "artifacts", "review-batch", "report.json"), "utf8"));
  const calls = () => existsSync(env.BATCH_CALLS) ? readFileSync(env.BATCH_CALLS, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { root, repo, git, put, commit, branch, initial, run, report, calls };
}

describe("review batch (isolated Git repositories)", () => {
  it("merges in order, reports conflicts and lag, rolls back failed typecheck, and preserves the source checkout", () => {
    const f = fixture();
    const good = f.branch("ai/good", { "good.txt": "good\n" });
    const conflict = f.branch("ai/conflict", { "shared.txt": "branch side\n" });
    const bad = f.branch("ai/bad", { "fail.txt": "typecheck must fail\n" });
    const later = f.branch("ai/later", { "later.txt": "later\n" });
    f.put("shared.txt", "base side\n");
    const base = f.commit("advance main");
    f.put("dirty.txt", "caller work stays here\n");
    f.git("add", "dirty.txt");
    f.put("shared.txt", "uncommitted change\n");
    const status = f.git("status", "--porcelain");
    const result = f.run(["--name", "mixed", "ai/good", "ai/conflict", "ai/bad", "ai/missing", "ai/later"]);
    assert.equal(result.code, 1, result.output);
    const report = f.report("mixed");
    assert.equal(report.base, base);
    assert.deepEqual(report.branches.map((row: any) => [row.source, row.status, row.behind]), [
      ["ai/good", "included", 1], ["ai/conflict", "skipped", 1], ["ai/bad", "skipped", 1], ["ai/missing", "skipped", null], ["ai/later", "included", 1],
    ]);
    assert.match(report.branches[2].reason, /typecheck.*rolled back/);
    assert.match(result.output, /Conflict: shared.txt/);
    assert.match(result.output, /<{7} HEAD/);
    assert.match(result.output, /branch side/);
    assert.match(result.output, /base side/);
    assert.equal(report.branches[1].conflicts[0].file, "shared.txt");
    assert.equal(existsSync(join(report.worktree, "fail.txt")), false);
    assert.equal(readFileSync(join(report.worktree, "later.txt"), "utf8"), "later\n");
    assert.equal(f.git("rev-parse", "main"), base);
    assert.equal(f.git("branch", "--show-current"), "main");
    assert.equal(f.git("status", "--porcelain"), status);
    for (const [sha, included] of [[good, true], [conflict, false], [bad, false], [later, true]] as const) {
      assert.equal(f.git("rev-list", "review/mixed").split("\n").includes(sha), included);
    }
    const merges = f.git("log", "--format=%s", "--merges", "review/mixed").split("\n");
    assert.deepEqual(merges, ["Merge ai/later (review/mixed)", "Merge ai/good (review/mixed)"]);
    assert.equal(f.calls().filter(call => call.args[1] === "typecheck").length, 3);
    assert.equal(f.calls().filter(call => call.args[0] === "ci").length, 1);
    assert.ok(f.calls().every(call => call.cwd === report.worktree));
  });

  it("runs the full gate sequentially, records logs and forwards --only to both e2e commands", () => {
    const f = fixture();
    f.branch("ai/ready", { "ready.txt": "ready\n" });
    const result = f.run(["--name", "gate", "--gate", "--only", "login,setup", "ai/ready"]);
    assert.equal(result.code, 0, result.output);
    const report = f.report("gate");
    assert.deepEqual(report.gate.map((check: any) => check.name), ["typecheck", "test", "e2e", "e2e-mobile", "desktop-build", "desktop-smoke"]);
    for (const check of report.gate) {
      assert.equal(check.status, "passed");
      assert.match(readFileSync(check.log, "utf8"), /Exit: 0/);
    }
    const calls = f.calls().map(call => call.args);
    assert.deepEqual(calls.slice(0, 4), [["ci", "--prefer-offline"], ["run", "typecheck"], ["run", "typecheck"], ["test"]]);
    for (const [index, scriptName, dir] of [[4, "e2e", "web"], [5, "e2e:mobile", "mobile"]] as const) {
      assert.deepEqual(calls[index], ["run", scriptName, "-w", "@xdev-hive/web", "--", join(report.out, dir), "--only", "login,setup"]);
    }
    assert.deepEqual(calls[6], ["run", "build", "-w", "@xdev-hive/desktop"]);
    assert.deepEqual(calls[7], ["run", "smoke", "-w", "@xdev-hive/desktop", "--", join(report.out, "desktop")]);
  });

  it("stops the gate at the first failure and retains included branches", () => {
    const f = fixture();
    f.branch("ai/ready", { "ready.txt": "ready\n" });
    const result = f.run(["--name", "failed-gate", "--gate", "ai/ready"], { BATCH_FAIL: "test" });
    assert.equal(result.code, 1, result.output);
    const report = f.report("failed-gate");
    assert.deepEqual(report.gate.map((check: any) => [check.name, check.status]), [["typecheck", "passed"], ["test", "failed"]]);
    assert.equal(report.branches[0].status, "included");
    assert.equal(f.calls().length, 4);
    assert.match(readFileSync(report.gate[1].log, "utf8"), /fake check failed: test/);
  });

  it("fetches remote sources without overwriting local branches or FETCH_HEAD, then removes its temporary refs", () => {
    const f = fixture();
    const local = f.branch("ai/remote", { "local.txt": "local\n" });
    const remote = join(f.root, "remote repo");
    f.git("clone", "-q", f.repo, remote);
    f.git("-C", remote, "config", "user.name", "Remote Test");
    f.git("-C", remote, "config", "user.email", "remote@example.test");
    f.git("-C", remote, "checkout", "-qb", "ai/remote", "main");
    writeFileSync(join(remote, "remote.txt"), "remote\n");
    f.git("-C", remote, "add", ".");
    f.git("-C", remote, "-c", "commit.gpgSign=false", "commit", "-qm", "remote");
    f.git("-C", remote, "branch", "topic/review");
    const fetchHead = f.git("rev-parse", "--git-path", "FETCH_HEAD");
    writeFileSync(resolve(f.repo, fetchHead), "keep FETCH_HEAD\n");
    const result = f.run(["--name", "remote", `fake-host:${remote}#ai/remote`, `fake-host:${remote}#topic/review`]);
    assert.equal(result.code, 0, result.output);
    const report = f.report("remote");
    assert.equal(report.branches[0].status, "included");
    assert.equal(report.branches[1].status, "included");
    assert.equal(readFileSync(join(report.worktree, "remote.txt"), "utf8"), "remote\n");
    assert.equal(existsSync(join(report.worktree, "local.txt")), false);
    assert.equal(f.git("rev-parse", "ai/remote"), local);
    assert.equal(f.git("for-each-ref", "refs/review-batch/"), "");
    assert.equal(readFileSync(resolve(f.repo, fetchHead), "utf8"), "keep FETCH_HEAD\n");
  });

  it("reports a failed remote fetch and continues with the next local branch", () => {
    const f = fixture();
    f.branch("ai/good", { "good.txt": "good\n" });
    const result = f.run(["--name", "fetch-failed", `fake-host:${join(f.root, "missing")}#ai/missing`, "ai/good"]);
    assert.equal(result.code, 1, result.output);
    const report = f.report("fetch-failed");
    assert.match(report.branches[0].reason, /fetch failed/);
    assert.equal(report.branches[1].status, "included");
    assert.equal(f.git("for-each-ref", "refs/review-batch/"), "");
  });

  it("refreshes dependencies after manifest changes and again after rolling one back", () => {
    const f = fixture();
    f.branch("ai/good", { "good.txt": "good\n" });
    f.branch("ai/bad-manifest", { "package.json": '{"name":"fixture","version":"2.0.0"}\n', "fail.txt": "bad\n" });
    f.branch("ai/later", { "later.txt": "later\n" });
    const result = f.run(["--name", "manifests", "ai/good", "ai/bad-manifest", "ai/later"]);
    assert.equal(result.code, 1, result.output);
    assert.equal(f.calls().filter(call => call.args[0] === "ci").length, 3);
    assert.deepEqual(f.report("manifests").branches.map((row: any) => row.status), ["included", "skipped", "included"]);
    assert.match(readFileSync(join(f.report("manifests").worktree, "package.json"), "utf8"), /1.0.0/);
  });

  it("retries a failed install for the next source and gates the accepted subset while returning failure for an incomplete batch", () => {
    const f = fixture();
    const first = f.branch("ai/first", { "first.txt": "first\n" });
    const second = f.branch("ai/second", { "second.txt": "second\n" });
    const result = f.run(["--name", "install-retry", "--gate", "ai/first", "ai/second"], { BATCH_FAIL_ONCE: "ci" });
    assert.equal(result.code, 1, result.output);
    const report = f.report("install-retry");
    assert.match(report.branches[0].reason, /dependency install.*rolled back/);
    assert.equal(report.branches[1].status, "included");
    const commits = f.git("rev-list", "review/install-retry").split("\n");
    assert.equal(commits.includes(first), false);
    assert.equal(commits.includes(second), true);
    assert.equal(f.calls().filter(call => call.args[0] === "ci").length, 2);
    assert.equal(report.gate.length, 6);
    assert.ok(report.gate.every((check: any) => check.status === "passed"));
  });

  it("supports a custom base and destination, and treats repeated sources as already included", () => {
    const f = fixture();
    f.branch("ai/good", { "good.txt": "good\n" });
    f.git("branch", "baseline", f.initial);
    f.put("new-main.txt", "main advanced\n");
    const main = f.commit("advance main");
    const worktree = join(f.root, "custom tree");
    const result = f.run(["--name", "custom", "--base", "baseline", "--worktree", worktree, "ai/good", "ai/good"]);
    assert.equal(result.code, 0, result.output);
    const report = JSON.parse(readFileSync(join(worktree, ".xdev-hive", "artifacts", "review-batch", "report.json"), "utf8"));
    assert.equal(report.baseRef, "baseline");
    assert.equal(report.base, f.initial);
    assert.ok(report.branches.every((row: any) => row.status === "included" && row.behind === 0));
    assert.match(report.branches[1].reason, /already included/);
    assert.equal(existsSync(join(worktree, "new-main.txt")), false);
    assert.equal(f.git("rev-parse", "main"), main);
    assert.equal(f.calls().filter(call => call.args[1] === "typecheck").length, 2);
    assert.equal(f.git("rev-list", "--count", "--merges", "review/custom"), "1");
  });

  it("handles binary conflicts with Git stage details and leaves no pending merge", () => {
    const f = fixture();
    f.branch("ai/binary", { "binary.dat": Buffer.from([0, 3, 4]) });
    f.put("binary.dat", Buffer.from([0, 5, 6]));
    f.commit("base binary");
    const result = f.run(["--name", "binary", "ai/binary"]);
    assert.equal(result.code, 1, result.output);
    const report = f.report("binary");
    assert.equal(report.branches[0].conflicts[0].file, "binary.dat");
    assert.match(report.branches[0].conflicts[0].sections[0], /100644 .* 2\tbinary.dat/);
    assert.equal(f.git("-C", report.worktree, "diff", "--name-only", "--diff-filter=U"), "");
    assert.equal(f.calls().length, 0);
  });

  it("reports symlink conflicts without reading files outside the review worktree", { skip: process.platform === "win32" }, () => {
    const f = fixture();
    const link = join(f.repo, "linked");
    symlinkSync("initial-target", link);
    const base = f.commit("symlink base");
    f.git("checkout", "-qb", "ai/symlink", base);
    unlinkSync(link);
    symlinkSync("branch-target", link);
    f.commit("branch symlink");
    f.git("checkout", "-q", "main");
    unlinkSync(link);
    const outside = join(f.root, "outside.txt");
    writeFileSync(outside, "<<<<<<< external-file\nDO NOT READ THE SYMLINK TARGET\n>>>>>>> external-file\n");
    symlinkSync(outside, link);
    f.commit("base symlink");
    const result = f.run(["--name", "symlink", "ai/symlink"]);
    assert.equal(result.code, 1, result.output);
    const conflict = f.report("symlink").branches[0].conflicts[0];
    assert.equal(conflict.file, "linked");
    assert.match(conflict.sections[0], /120000 .* 2\tlinked/);
    assert.doesNotMatch(result.output, /DO NOT READ/);
    assert.doesNotMatch(conflict.sections[0], /DO NOT READ/);
  });

  it("wraps only GUI gate steps in xvfb on headless Linux and sets Electron's sandbox environment", { skip: process.platform !== "linux" }, () => {
    const f = fixture();
    f.branch("ai/good", { "good.txt": "good\n" });
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    const guiCalls = join(f.root, "gui.jsonl");
    writeFileSync(join(bin, "xvfb-run"), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(process.env.BATCH_GUI_CALLS, JSON.stringify({ args, sandbox: process.env.ELECTRON_DISABLE_SANDBOX }) + '\\n');
const child = spawn(args[3], args.slice(4), { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
`, { mode: 0o755 });
    const result = f.run(["--name", "headless", "--gate", "ai/good"], { DISPLAY: "", PATH: `${bin}:${process.env.PATH}`, BATCH_GUI_CALLS: guiCalls });
    assert.equal(result.code, 0, result.output);
    const calls = readFileSync(guiCalls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(call => call.args[6]), ["e2e", "e2e:mobile", "smoke"]);
    for (const call of calls) {
      assert.deepEqual(call.args.slice(0, 3), ["-a", "-s", "-screen 0 1440x900x24"]);
      assert.equal(call.sandbox, "1");
    }
  });

  it("refuses unsafe setup and reusing an existing branch or directory", () => {
    const f = fixture();
    f.branch("ai/good", { "good.txt": "good\n" });
    for (const args of [
      ["ai/good"], ["--name", "../bad", "ai/good"], ["--name", "x", "--base", "missing", "ai/good"],
      ["--name", "x", "--only", "login", "ai/good"], ["--name", "x", "--wat", "ai/good"],
      ["--name", "x", "--worktree", f.repo, "ai/good"], ["--name", "x", "--base"],
      ["--name", "x", "--worktree", join(f.repo, "..child"), "ai/good"],
    ]) assert.equal(f.run(args).code, 2, args.join(" "));
    if (process.platform !== "win32") {
      const alias = join(f.root, "source-alias");
      symlinkSync(f.repo, alias);
      assert.equal(f.run(["--name", "x", "--worktree", join(alias, "nested"), "ai/good"]).code, 2);
      assert.equal(existsSync(join(f.repo, "nested")), false);
    }
    assert.equal(f.git("branch", "--list", "review/*"), "");
    assert.equal(f.calls().length, 0);
    assert.equal(f.run(["--name", "once", "ai/good"]).code, 0);
    assert.match(f.run(["--name", "once", "ai/good"]).output, /already exists/);
    const existing = join(f.root, "existing");
    mkdirSync(existing);
    writeFileSync(join(existing, "keep.txt"), "keep\n");
    assert.equal(f.run(["--name", "existing", "--worktree", existing, "ai/good"]).code, 2);
    assert.equal(readFileSync(join(existing, "keep.txt"), "utf8"), "keep\n");
    assert.equal(f.run(["--help"]).code, 0);
  });
});
