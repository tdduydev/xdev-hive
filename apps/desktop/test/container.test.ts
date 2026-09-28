import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AGENT_TEMPLATES, type Actor, type AgentProfile, type HiveBackend } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { containerCommand, containerName } from "../src/main/runner/container.ts";
import { Runner, type RunnerHost } from "../src/main/runner/runner.ts";

const admin: Actor = { name: "duy", role: "admin" };
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), `hive-${p}-`));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("container command", () => {
  const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({ ...AGENT_TEMPLATES.claude, container: { image: "xdev-hive-agent" }, ...over });

  it("mounts the worktree, the repo's .git and the CLI's login, and passes variables by name", () => {
    const home = "/home/duy";
    const have = new Set([`${home}/.claude`, `${home}/.claude.json`, `${home}/.gitconfig`]);
    const c = containerCommand({
      profile: profile(),
      args: ["-p", "do it", "--output-format", "json"],
      stdin: null,
      runId: "R-abc123",
      worktree: "/work/demo/T-1",
      gitDir: "/repos/demo/.git",
      env: { HIVE_AGENT: "claude-1", HIVE_TASK: "T-1" },
      readOnly: ["/data/runs/R-abc123.mcp.json"],
      home,
      user: { uid: 1000, gid: 1000 },
      exists: (p) => have.has(p),
    });
    assert.equal(c.name, "hive-R-abc123");
    assert.deepEqual(c.args, [
      "run", "--rm", "--init", "--name", "hive-R-abc123",
      "--user", "1000:1000",
      "--tmpfs", "/home/duy:rw,exec,uid=1000,gid=1000",
      "-v", "/work/demo/T-1:/work/demo/T-1",
      "-v", "/repos/demo/.git:/repos/demo/.git",
      "-v", "/home/duy/.claude:/home/duy/.claude",
      "-v", "/home/duy/.claude.json:/home/duy/.claude.json",
      "-v", "/home/duy/.gitconfig:/home/duy/.gitconfig:ro",
      "-v", "/data/runs/R-abc123.mcp.json:/data/runs/R-abc123.mcp.json:ro",
      "--workdir", "/work/demo/T-1",
      "-e", "GIT_CONFIG_COUNT", "-e", "GIT_CONFIG_KEY_0", "-e", "GIT_CONFIG_VALUE_0", "-e", "HIVE_AGENT", "-e", "HIVE_TASK", "-e", "HOME",
      "xdev-hive-agent", "claude", "-p", "do it", "--output-format", "json",
    ]);
    assert.deepEqual(c.env, { HIVE_AGENT: "claude-1", HIVE_TASK: "T-1", HOME: home, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" });
    assert.ok(!c.args.some((a) => a.includes("=")) || c.args.every((a) => !/^[A-Z_]+=/.test(a)), "no value on the command line");
  });

  it("follows the profile's login folder, keeps stdin open when the prompt goes there, and knows no host path of the CLI", () => {
    const c = containerCommand({
      profile: profile({ kind: "codex", bin: "/opt/homebrew/bin/codex", env: { CODEX_HOME: "~/.codex-2" } }),
      args: [],
      stdin: "prompt",
      runId: "R-1",
      worktree: "/w",
      gitDir: "/g",
      env: {},
      home: os.homedir(),
      user: null,
      exists: () => true,
    });
    assert.ok(c.args.includes("-i"));
    assert.ok(!c.args.includes("--user"));
    assert.ok(c.args.includes(`${path.join(os.homedir(), ".codex-2")}:${path.join(os.homedir(), ".codex-2")}`));
    assert.equal(c.args.at(-1), "codex");
    assert.equal(containerName("R-a/b"), "hive-R-a-b");
  });
});

// ── the runner with a fake docker on PATH ────────────────────────────────────
function repo(): string {
  const dir = tmp("repo");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(path.join(dir, "README.md"), "# demo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

async function setup(profiles: AgentProfile[], opts: { docker?: boolean; mode?: "local" | "hub" } = {}) {
  const dir = repo();
  const hive = new SqliteHive(":memory:");
  await hive.call("tasks.create", { id: "T-1", project: "demo", title: "Container run" }, admin);
  const record = path.join(tmp("rec"), "calls.jsonl");
  const dockerRecord = path.join(tmp("rec"), "docker.jsonl");
  const bin = tmp("bin");
  if (opts.docker !== false) {
    writeFileSync(path.join(bin, "docker"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(FIXTURES, "fake-docker.mjs"))} "$@"\n`);
    chmodSync(path.join(bin, "docker"), 0o755);
  }
  const hubLike: HiveBackend = { call: (m, i, a) => hive.call(m, i, { ...a, name: `${a.name}@duy-macbook` }) };
  const dataDir = tmp("data");
  const host: RunnerHost = {
    backend: () => (opts.mode === "hub" ? hubLike : hive),
    profiles: () => profiles.map((p) => ({ ...p, env: { ...p.env, FAKE_RECORD: record } })),
    settings: () => ({ worktreeRoot: null, maxParallel: 2, maxAttempts: 3 }),
    projects: () => [{ name: "demo", repo: dir }],
    mode: () => opts.mode ?? "local",
    machine: () => "duy-mbp",
    // A variable only the machine has: it must not reach an agent in a container.
    env: () => ({ ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_RECORD: dockerRecord, HIVE_TEST_HOST_ONLY: "leaked" }),
    hub: () => ({ url: "https://hive.example.test", token: "hive_test_machine_token" }),
  };
  const runner = new Runner(host, { dataDir, user: "duy", tickMs: 60_000 });
  const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, runner, dataDir, calls: () => read(record), docker: () => read(dockerRecord) as string[][] };
}

const boxed = (id: string, mode = "ok", over: Partial<AgentProfile> = {}): AgentProfile => ({
  ...AGENT_TEMPLATES.codex,
  id,
  label: id,
  args: ["{prompt}"],
  env: { FAKE_MODE: mode },
  container: { image: "xdev-hive-agent" },
  ...over,
});

describe("runs in a container", () => {
  it("runs the CLI through docker with the worktree, gives it only its own variables, and commits its work", async () => {
    const { runner, calls, docker } = await setup([boxed("codex-box")]);
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    const done = runner.store.get(run.id)!;
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.equal(done.commits, 1);
    const [args] = docker();
    assert.equal(args![0], "run");
    assert.ok(args!.includes(`hive-${run.id}`));
    assert.ok(args!.includes(`${done.worktree}:${done.worktree}`));
    const [call] = calls();
    assert.equal(call.cwd, realpathSync(done.worktree!));
    assert.equal(call.agent, "codex-box");
    assert.equal(call.hostOnly, null, "the machine's own variables stay out");
    assert.match(runner.log(run.id), new RegExp(`# container hive-${run.id} · image xdev-hive-agent`));
  });

  it("gives Claude the hub's MCP through a file that is gone after the run", async () => {
    const claude = boxed("claude-box", "ok", { kind: "claude", bin: "claude", args: ["{prompt}"] });
    const { runner, docker, dataDir } = await setup([claude], { mode: "hub" });
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    assert.equal(runner.store.get(run.id)!.status, "succeeded", runner.store.get(run.id)!.error ?? "");
    const args = docker()[0]!;
    const file = args[args.indexOf("--mcp-config") + 1]!;
    assert.equal(file, path.join(dataDir, "runs", `${run.id}.mcp.json`));
    assert.ok(args.includes(`${file}:${file}:ro`));
    assert.ok(!args.some((a) => a.includes("hive_test_machine_token")), "the token is not on the command line");
    assert.ok(!existsSync(file), "removed after the run");
    assert.deepEqual(readdirSync(path.join(dataDir, "runs")).filter((f) => f.endsWith(".mcp.json")), []);
  });

  it("moves on to another subscription when the machine has no docker", async () => {
    const plain: AgentProfile = { ...AGENT_TEMPLATES.gemini, id: "gemini-here", bin: process.execPath, args: [path.join(FIXTURES, "fake-agent.mjs"), "{prompt}"], env: { FAKE_MODE: "ok" }, priority: 50 };
    const { runner } = await setup([boxed("codex-box"), plain], { docker: false });
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    const first = runner.store.get(run.id)!;
    assert.equal(first.status, "failed");
    assert.match(first.error ?? "", /docker/);
    const next = runner.list().find((r) => r.parentRunId === run.id)!;
    assert.equal(next.profileId, "gemini-here");
    assert.equal(next.status, "succeeded");
  });

  it("stops the container too when the run is cancelled", async () => {
    const { runner, docker } = await setup([boxed("codex-box", "sleep")]);
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.tick();
    for (let i = 0; i < 100 && !docker().length; i++) await new Promise((r) => setTimeout(r, 50));
    runner.cancel(run.id);
    await runner.settle();
    assert.equal(runner.store.get(run.id)!.status, "cancelled");
    for (let i = 0; i < 100 && docker().length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(docker()[1], ["kill", `hive-${run.id}`]);
  });
});
