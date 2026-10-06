import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { AGENT_TEMPLATES, type Actor, type AgentProfile, type HiveBackend } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { containerCommand, containerName } from "#desktop/main/runner/container.ts";
import { claudeMcpServers, codexMcpArgs, hubMcpEnv } from "#desktop/main/runner/container-mcp.ts";
import { Runner, type RunnerHost } from "#desktop/main/runner/runner.ts";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

const admin: Actor = { name: "duy", role: "admin" };
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const tmp = (p: string) => testTmpDir(path.join(os.tmpdir(), `hive-${p}-`));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("container command", () => {
  const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({ ...AGENT_TEMPLATES.claude, container: { image: "xdev-hive-agent", network: "open", allow: [] }, ...over });

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

async function setup(profiles: AgentProfile[], opts: { docker?: boolean; mode?: "local" | "hub"; tokens?: Record<string, string>; dockerEnv?: Record<string, string> } = {}) {
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
  // "No docker" means none at all: the machine running the tests may have a real one (colima, Docker Desktop).
  const hostPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((d) => opts.docker !== false || !existsSync(path.join(d, "docker")))
    .join(path.delimiter);
  const dataDir = tmp("data");
  const host: RunnerHost = {
    backend: () => (opts.mode === "hub" ? hubLike : hive),
    profiles: () => profiles.map((p) => ({ ...p, env: { ...p.env, FAKE_RECORD: record } })),
    settings: () => ({ worktreeRoot: null, maxParallel: 2, maxAttempts: 3, acceptHubRuns: false }),
    projects: () => [{ name: "demo", repo: dir }],
    mode: () => opts.mode ?? "local",
    machine: () => "duy-mbp",
    // A variable only the machine has: it must not reach an agent in a container.
    env: () => ({ ...process.env, PATH: `${bin}${path.delimiter}${hostPath}`, FAKE_DOCKER_RECORD: dockerRecord, HIVE_TEST_HOST_ONLY: "leaked", ...opts.dockerEnv }),
    hub: () => ({ url: "https://hive.example.test", token: "hive_test_machine_token" }),
    token: (id) => opts.tokens?.[id],
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
  container: { image: "xdev-hive-agent", network: "open", allow: [] },
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

describe("Hive and sign-in for CLIs in a container", () => {
  const hub = { url: "https://hive.example.test/", token: "hive_machine" };
  const r = { agent: "codex-1.duy-mbp", machine: "duy-mbp", project: "demo", task: "T-1", run: "R-1", readOnly: true };

  it("turns the shim off for Codex and points it at the hub, with the token left in the environment", () => {
    assert.deepEqual(codexMcpArgs(null, r), ["-c", "mcp_servers.xdev-hive.enabled=false"]);
    const args = codexMcpArgs(hub, r);
    assert.deepEqual(args.slice(0, 6), [
      "-c", "mcp_servers.xdev-hive.enabled=false",
      "-c", 'mcp_servers.hive.url="https://hive.example.test/mcp"',
      "-c", 'mcp_servers.hive.bearer_token_env_var="HIVE_HUB_TOKEN"',
    ]);
    const source = JSON.stringify(JSON.stringify({ via: "mcp", machine: "duy-mbp", run: "R-1", task: "T-1" }));
    assert.equal(args[7], `mcp_servers.hive.http_headers={"x-hive-agent"="codex-1.duy-mbp","x-hive-project"="demo","x-hive-source"=${source},"x-hive-run"="R-1","x-hive-readonly"="1"}`);
    assert.deepEqual(args.slice(8), ["-c", 'mcp_servers.hive.default_tools_approval_mode="approve"'], "headless: Hive's tools run without asking");
    assert.ok(!args.join(" ").includes("hive_machine"));
    assert.deepEqual(hubMcpEnv(hub, r, "codex"), { HIVE_HUB_TOKEN: "hive_machine" });
  });

  it("gives Gemini the variables its image settings read, and Claude a server with the token in its file", () => {
    assert.deepEqual(hubMcpEnv(hub, r, "gemini"), {
      HIVE_HUB_TOKEN: "hive_machine",
      HIVE_HUB_URL: "https://hive.example.test",
      HIVE_MCP_AGENT: "codex-1.duy-mbp",
      HIVE_MCP_SOURCE: '{"via":"mcp","machine":"duy-mbp","run":"R-1","task":"T-1"}',
      HIVE_MCP_READONLY: "1",
    });
    assert.deepEqual(hubMcpEnv(null, r, "gemini"), {});
    assert.deepEqual(hubMcpEnv(hub, r, "claude"), {}, "Claude reads its file instead");
    const servers = claudeMcpServers(hub, r) as Record<string, { url: string; headers: Record<string, string> }>;
    assert.equal(servers["xdev-hive"]!.url, "https://hive.example.test/mcp");
    assert.equal(servers["xdev-hive"]!.headers.authorization, "Bearer hive_machine");
    assert.equal(servers["xdev-hive"]!.headers["x-hive-run"], "R-1", "the audit log's run column");
    assert.deepEqual(claudeMcpServers(null, r), {});
  });

  it("hands Codex the hub by name in a hub-mode container run", async () => {
    const { runner, docker, calls } = await setup([boxed("codex-box")], { mode: "hub" });
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    assert.equal(runner.store.get(run.id)!.status, "succeeded", runner.store.get(run.id)!.error ?? "");
    const args = docker()[0]!;
    const image = args.indexOf("xdev-hive-agent");
    assert.deepEqual(args.slice(image + 1, image + 4), ["codex", "-c", "mcp_servers.xdev-hive.enabled=false"], "overrides before the subcommand");
    assert.ok(args.includes("HIVE_HUB_TOKEN"));
    assert.ok(!args.some((a) => a.includes("hive_test_machine_token")));
    assert.equal(calls()[0].hubToken, "set");
  });

  it("signs Claude in with the saved token inside a container only", async () => {
    const claude = boxed("claude-box", "ok", { kind: "claude", bin: "claude", args: ["{prompt}"] });
    const withToken = await setup([claude], { tokens: { "claude-box": "sk-ant-oat01-test" } });
    const run = await withToken.runner.enqueue({ project: "demo", taskId: "T-1" });
    await withToken.runner.settle();
    assert.equal(withToken.runner.store.get(run.id)!.status, "succeeded", withToken.runner.store.get(run.id)!.error ?? "");
    assert.ok(withToken.docker()[0]!.includes("CLAUDE_CODE_OAUTH_TOKEN"));
    assert.ok(!withToken.docker()[0]!.some((a) => a.includes("sk-ant-oat01-test")), "by name only");
    assert.equal(withToken.calls()[0].oauth, "set");
    assert.equal(withToken.runner.profileStatuses()[0]!.hasToken, true);

    const without = await setup([claude]);
    const next = await without.runner.enqueue({ project: "demo", taskId: "T-1" });
    await without.runner.settle();
    assert.ok(!without.docker()[0]!.includes("CLAUDE_CODE_OAUTH_TOKEN"));
    assert.equal(without.runner.profileStatuses()[0]!.hasToken, false);
    assert.equal(without.runner.store.get(next.id)!.status, "succeeded");
  });
});

describe("a container run with a limited network", () => {
  const limited = (id: string, mode = "ok"): AgentProfile => ({ ...boxed(id, mode), container: { image: "xdev-hive-agent", network: "restricted", allow: ["corp.example"] } });

  it("sets up its network and proxy, runs the agent behind it, and takes them down", async () => {
    const { runner, docker, calls } = await setup([limited("codex-net")]);
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    assert.equal(runner.store.get(run.id)!.status, "succeeded", runner.store.get(run.id)!.error ?? "");
    const net = `hive-${run.id}-net`;
    const proxy = `hive-${run.id}-egress`;
    const steps = docker();
    assert.deepEqual(steps.map((a) => a.slice(0, 2)), [["network", "create"], ["run", "-d"], ["network", "connect"], ["run", "--rm"], ["logs", proxy], ["rm", "-f"], ["network", "rm"]]);
    const agent = steps[3]!;
    assert.ok(agent.includes("--network") && agent[agent.indexOf("--network") + 1] === net);
    assert.ok(agent.includes("HTTPS_PROXY"));
    assert.equal(calls()[0].proxy, "http://egress:3128");
    assert.match(runner.log(run.id), /network limited \([^)]*corp\.example/);
  });

  it("names what it blocked when the run fails", async () => {
    const { runner } = await setup([limited("codex-net", "fail")], { dockerEnv: { FAKE_DOCKER_LOGS: "egress proxy on 3128\ndenied evil.example:443\ndenied evil.example:443\n" } });
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    const done = runner.store.get(run.id)!;
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /evil\.example:443/);
    assert.match(runner.log(run.id), /## Network\ndenied evil\.example:443 ×2/);
  });

  it("stops before the agent when the network cannot be set up, and cleans up", async () => {
    const { runner, docker } = await setup([limited("codex-net")], { dockerEnv: { FAKE_DOCKER_FAIL: "network" } });
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    const done = runner.store.get(run.id)!;
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /fake network failure/);
    assert.ok(!docker().some((a) => a[0] === "run" && a[1] === "--rm"), "the agent never started");
    assert.ok(docker().some((a) => a[0] === "rm" && a[1] === "-f"), "teardown tried");
  });
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
