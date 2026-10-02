import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { DesktopProject, SetupReport } from "@xdev-hive/core";
import { setMainLocale } from "#desktop/main/i18n.ts";
import { CODEGRAPH_PACKAGE } from "#desktop/main/installer.ts";
import { AGENT_CLIS, cliUpgrade, parseCliVersion, Setup, type SetupHost } from "#desktop/main/setup.ts";

const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), `hive-setup-${p}-`));

/** A fake CLI: records its args (and CODEGRAPH_TELEMETRY) and runs an optional shell snippet. */
function fakeBin(dir: string, name: string, body = "") {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "${name} $* telemetry=$CODEGRAPH_TELEMETRY" >> "${path.join(dir, "calls.log")}"\n${body}\n`);
  chmodSync(file, 0o755);
}
const calls = (dir: string) => (existsSync(path.join(dir, "calls.log")) ? readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n") : []);

/** A fake specify: `init` and `integration install` write .specify/integration.json in the cwd, as the real one does. */
const SPECIFY = `case "$1" in
  --version) echo "specify 1.0.14.dev0" ;;
  init) mkdir -p .specify && echo '{"version":"1.0.14.dev0","installed_integrations":["claude"]}' > .specify/integration.json && echo "init ok" ;;
  integration) echo '{"version":"1.0.14.dev0","installed_integrations":["claude","'"$3"'"]}' > .specify/integration.json && echo "installed $3" ;;
esac`;

function machine(opts: { npm?: boolean; uv?: boolean; specify?: boolean } & Pick<SetupHost, "latest" | "realpath" | "cliBusy" | "holdCli"> = {}) {
  const bin = tmp("bin");
  const shimDir = tmp("shim");
  // uv's tool bin dir, not on PATH (like ~/.local/bin for a login shell that lacks it).
  const uvBin = tmp("uvbin");
  fakeBin(bin, "claude", 'echo "2.1.283 (Claude Code)"');
  if (opts.npm !== false) {
    // `npm install -g @openai/codex` "installs" codex next to it.
    fakeBin(bin, "npm", `[ "$3" = "@openai/codex" ] && printf '#!/bin/sh\\necho codex-cli 0.157.1\\n' > "${bin}/codex" && chmod +x "${bin}/codex"; echo "added 1 package"`);
    fakeBin(bin, "npx", `[ "$3" = "init" ] && mkdir -p .codegraph && echo db > .codegraph/codegraph.db; echo "npx ok"`);
  }
  if (opts.uv) {
    // `uv tool install specify-cli …` copies a fake specify into uv's bin dir.
    const src = tmp("specify-src");
    fakeBin(src, "specify", SPECIFY);
    fakeBin(bin, "uv", `[ "$1 $2" = "tool dir" ] && echo "${uvBin}"; [ "$1 $2" = "tool install" ] && cp "${src}/specify" "${uvBin}/specify" && echo "Installed 1 executable: specify"; true`);
  }
  if (opts.specify) fakeBin(bin, "specify", SPECIFY);
  const projects: DesktopProject[] = [];
  const pathEnv = [bin, shimDir, "/usr/bin", "/bin"].join(path.delimiter);
  const setup = new Setup({
    pathEnv: () => pathEnv,
    env: () => ({ PATH: pathEnv, HOME: process.env.HOME }),
    projects: () => projects,
    shim: { electronPath: "/Applications/xDev Hive.app/Contents/MacOS/xDev Hive", entry: "/app/mcp/hive-mcp.mjs", binDir: shimDir },
    home: tmp("home"),
    // No registry in tests unless one says what is newest.
    latest: opts.latest ?? (async () => null),
    ...(opts.realpath ? { realpath: opts.realpath } : {}),
    ...(opts.cliBusy ? { cliBusy: opts.cliBusy } : {}),
    ...(opts.holdCli ? { holdCli: opts.holdCli } : {}),
  });
  return { setup, bin, shimDir, uvBin, projects };
}

const find = (r: SetupReport, id: string) => [...r.machine, ...r.projects.flatMap((p) => p.items)].find((i) => i.id === id)!;

function gitRepo() {
  const repo = tmp("repo");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return repo;
}

describe("Setup: this machine", () => {
  it("finds installed CLIs with their version and installs a missing one with npm -g", async () => {
    const m = machine();
    const r = await m.setup.status();
    assert.deepEqual(r.machine.map((i) => [i.id, i.state]), [
      ["cli:claude", "installed"],
      ["cli:codex", "missing"],
      ["cli:gemini", "missing"],
      ["cli:specify", "manual"],
      ["shim", "missing"],
    ]);
    assert.match(find(r, "cli:claude").detail, /^2\.1\.283 \(Claude Code\) · .*\/claude$/);
    assert.equal(find(r, "cli:codex").action, "Cài bằng npm");
    assert.match(find(r, "cli:codex").detail, /npm install -g @openai\/codex/);

    const res = await m.setup.install("cli:codex");
    assert.ok(calls(m.bin).includes("npm install -g @openai/codex telemetry="));
    assert.equal(res.item.state, "installed");
    assert.match(res.item.detail, /codex-cli 0\.157\.1/);
    assert.match(res.output, /added 1 package/);
  });

  it("without npm, says to install Node.js and offers no button", async () => {
    const r = await machine({ npm: false }).setup.status();
    assert.equal(find(r, "cli:gemini").action, null);
    assert.match(find(r, "cli:gemini").detail, /Máy chưa có npm: cài Node\.js/);
    await assert.rejects(machine({ npm: false }).setup.install("cli:gemini"), /Máy chưa có npm/);
  });

  it("writes its items in the interface language", async () => {
    setMainLocale("en");
    try {
      const r = await machine({ npm: false }).setup.status();
      assert.equal(find(r, "shim").label, "hive-mcp command");
      assert.match(find(r, "cli:gemini").detail, /^Not installed\. npm is missing on this machine/);
    } finally {
      setMainLocale("vi");
    }
  });

  it("tells a shim for this build from one for another build, and leaves a foreign file alone", async () => {
    const m = machine();
    const res = await m.setup.install("shim");
    assert.equal(res.item.state, "installed");
    assert.match(readFileSync(path.join(m.shimDir, "hive-mcp"), "utf8"), /xDev Hive\.app/);

    writeFileSync(path.join(m.shimDir, "hive-mcp"), "#!/bin/sh\n# xdev-hive: MCP launcher installed by xDev Hive\nexec /old/Electron /old/hive-mcp.mjs\n");
    assert.equal((await m.setup.item("shim")).state, "outdated");
    writeFileSync(path.join(m.shimDir, "hive-mcp"), "#!/bin/sh\necho mine\n");
    const foreign = await m.setup.item("shim");
    assert.equal(foreign.state, "manual");
    assert.equal(foreign.action, null);
  });
});

describe("Setup: project repos", () => {
  it("reports what each repo lacks and installs Hive config, codegraph and superpowers side by side", async () => {
    const m = machine();
    const repo = gitRepo();
    m.projects.push({ name: "app", repo });
    let r = await m.setup.status();
    assert.deepEqual(r.projects[0]!.items.map((i) => [i.id, i.state]), [
      ["app:agents", "missing"],
      ["app:codegraph-mcp", "missing"],
      ["app:codegraph-index", "missing"],
      ["app:superpowers", "missing"],
      ["app:speckit", "missing"],
    ]);
    assert.match(find(r, "app:agents").detail, /\.mcp\.json.*\.claude\/settings\.json/);
    assert.equal(find(r, "app:speckit").action, null, "no specify on this machine yet");
    assert.match(find(r, "app:speckit").detail, /Cài Spec Kit CLI \(specify\)/);

    for (const id of ["app:agents", "app:codegraph-mcp", "app:superpowers", "app:codegraph-index"]) {
      assert.equal((await m.setup.install(id)).item.state, "installed", id);
    }
    r = await m.setup.status();
    assert.ok(r.projects[0]!.items.filter((i) => i.id !== "app:speckit").every((i) => i.state === "installed"));

    const mcp = JSON.parse(readFileSync(path.join(repo, ".mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(mcp.mcpServers), ["xdev-hive", "codegraph"]);
    assert.deepEqual(mcp.mcpServers.codegraph.args, ["-y", CODEGRAPH_PACKAGE, "serve", "--mcp"]);
    assert.equal(mcp.mcpServers.codegraph.env.CODEGRAPH_TELEMETRY, "0");
    const settings = JSON.parse(readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"));
    assert.match(JSON.stringify(settings.hooks), /guard-docs\.sh/, "the Hive guard hook survives");
    assert.equal(settings.enabledPlugins["superpowers@claude-plugins-official"], true);
    assert.deepEqual(
      calls(m.bin).filter((c) => c.startsWith("npx")),
      [`npx -y ${CODEGRAPH_PACKAGE} telemetry off telemetry=0`, `npx -y ${CODEGRAPH_PACKAGE} init telemetry=0`],
      "telemetry goes off before the first index",
    );
  });

  it("accepts an existing codegraph entry as it is, and flags a hook it must not overwrite", async () => {
    const m = machine();
    const repo = gitRepo();
    m.projects.push({ name: "app", repo });
    const own = '{"mcpServers":{"codegraph":{"command":"codegraph","args":["serve","--mcp"]}}}\n';
    writeFileSync(path.join(repo, ".mcp.json"), own);
    mkdirSync(path.join(repo, ".githooks"));
    writeFileSync(path.join(repo, ".githooks", "pre-commit"), "#!/bin/sh\nnpm run lint\n");

    const r = await m.setup.status();
    assert.equal(find(r, "app:codegraph-mcp").state, "installed");
    await m.setup.install("app:agents");
    const after = await m.setup.item("app:agents");
    assert.equal(after.state, "manual");
    assert.match(after.detail, /\.githooks\/pre-commit: đã có hook khác/);
    assert.equal(JSON.parse(readFileSync(path.join(repo, ".mcp.json"), "utf8")).mcpServers.codegraph.command, "codegraph", "user's own entry kept");
  });

  it("status never writes to the repo", async () => {
    const m = machine();
    const repo = gitRepo();
    m.projects.push({ name: "app", repo });
    await m.setup.status();
    assert.equal(existsSync(path.join(repo, ".mcp.json")), false);
    // `git config --get` exits 1 when the key is unset.
    assert.throws(() => execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: repo, stdio: "pipe" }));
  });
});

describe("Setup: Spec Kit", () => {
  const specifyCalls = (bin: string) => calls(bin).filter((c) => c.startsWith("specify ") && !c.startsWith("specify --version"));

  it("without uv or specify, says to install uv and offers no button", async () => {
    const m = machine();
    const item = await m.setup.item("cli:specify");
    assert.equal(item.state, "manual");
    assert.equal(item.action, null);
    assert.match(item.detail, /Cần uv: https:\/\/docs\.astral\.sh\/uv/);
    await assert.rejects(m.setup.install("cli:specify"), /Cần uv/);
  });

  it("installs specify with uv and finds it in uv's bin dir even when that is not on PATH", async () => {
    const m = machine({ uv: true });
    const before = await m.setup.item("cli:specify");
    assert.equal(before.state, "missing");
    assert.equal(before.action, "Cài bằng uv");

    const res = await m.setup.install("cli:specify");
    assert.ok(calls(m.bin).includes("uv tool install specify-cli --from git+https://github.com/github/spec-kit.git telemetry="));
    assert.equal(res.item.state, "installed");
    assert.equal(res.item.detail, `specify 1.0.14.dev0 · ${path.join(m.uvBin, "specify")} · ngoài PATH`);
    assert.match(res.output, /Installed 1 executable/);

    // The repo item can install with it, by full path.
    const repo = gitRepo();
    m.projects.push({ name: "app", repo });
    assert.equal((await m.setup.item("app:speckit")).action, "Cài Spec Kit");
  });

  it("initialises a repo for Claude, then adds the Codex commands, in the repo", async () => {
    const m = machine({ specify: true });
    const repo = gitRepo();
    m.projects.push({ name: "app", repo });
    const before = await m.setup.item("app:speckit");
    assert.equal(before.state, "missing");
    assert.equal(before.action, "Cài Spec Kit");

    const res = await m.setup.install("app:speckit");
    assert.deepEqual(specifyCalls(m.bin), [
      "specify init --here --force --non-interactive --integration claude --script sh --ignore-agent-tools telemetry=",
      "specify integration install codex --script sh telemetry=",
    ]);
    assert.ok(existsSync(path.join(repo, ".specify", "integration.json")), "ran with the repo as cwd");
    assert.equal(res.item.state, "installed");
    assert.equal(res.item.detail, "Spec Kit 1.0.14.dev0 · claude, codex");
    assert.match(res.output, /Nhớ commit \.specify\//);
  });

  it("on a repo that has Spec Kit for Claude only, adds Codex without running init again", async () => {
    const m = machine({ specify: true });
    const repo = gitRepo();
    m.projects.push({ name: "app", repo });
    mkdirSync(path.join(repo, ".specify"));
    writeFileSync(path.join(repo, ".specify", "integration.json"), '{"version":"1.0.14.dev0","installed_integrations":["claude"]}\n');
    const before = await m.setup.item("app:speckit");
    assert.equal(before.state, "missing");
    assert.equal(before.action, "Thêm lệnh cho Codex CLI");

    const res = await m.setup.install("app:speckit");
    assert.deepEqual(specifyCalls(m.bin), ["specify integration install codex --script sh telemetry="]);
    assert.equal(res.item.state, "installed");
  });

  it("reads a broken integration.json as no integration, without throwing", async () => {
    const m = machine({ specify: true });
    const repo = gitRepo();
    m.projects.push({ name: "app", repo });
    mkdirSync(path.join(repo, ".specify"));
    writeFileSync(path.join(repo, ".specify", "integration.json"), "{ not json");
    const r = await m.setup.status();
    assert.equal(find(r, "app:speckit").state, "missing");
    assert.equal(find(r, "app:speckit").action, "Thêm lệnh cho Claude Code, Codex CLI");
  });
});

describe("Setup: CLI versions and upgrades (roadmap 33)", () => {
  const claude = AGENT_CLIS.find((c) => c.kind === "claude")!;
  const codex = AGENT_CLIS.find((c) => c.kind === "codex")!;

  it("reads the version out of each CLI's --version", () => {
    assert.equal(parseCliVersion("2.1.283 (Claude Code)"), "2.1.283");
    assert.equal(parseCliVersion("codex-cli 0.157.1"), "0.157.1");
    assert.equal(parseCliVersion("0.61.0\n"), "0.61.0");
    assert.equal(parseCliVersion("gemini 0.62.0-preview.3"), "0.62.0-preview.3");
    assert.equal(parseCliVersion("no version here"), null);
    assert.equal(parseCliVersion("10.0.0.1"), null, "four parts is not a version this reads");
  });

  it("upgrades a CLI the way it was installed, so no second copy lands on PATH", () => {
    const own = "/usr/local/bin/claude";
    assert.deepEqual(cliUpgrade(claude, "/Users/duy/.nvm/versions/node/v26.10.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe", own), {
      method: "npm",
      bin: "npm",
      args: ["install", "-g", "@anthropic-ai/claude-code@latest"],
    });
    assert.deepEqual(cliUpgrade(codex, "C:\\Users\\duy\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", "C:\\x\\codex.cmd")?.args, ["install", "-g", "@openai/codex@latest"]);
    assert.deepEqual(cliUpgrade(claude, "/Users/duy/.local/share/claude/versions/2.1.283", own), { method: "native", bin: own, args: ["update"] });
    assert.deepEqual(cliUpgrade(codex, "/opt/homebrew/Cellar/codex/0.157.1/bin/codex", "/opt/homebrew/bin/codex")?.args, ["upgrade", "codex"]);
    assert.deepEqual(cliUpgrade(claude, "/opt/homebrew/Caskroom/claude-code/2.1.283/claude", own)?.args, ["upgrade", "--cask", "claude-code"]);
    assert.equal(cliUpgrade(codex, "/Users/duy/.local/share/claude/versions/2.1.283", own), null, "only Claude Code updates itself");
    assert.equal(cliUpgrade(claude, "/opt/tools/claude", own), null);
  });

  it("shows the newest version and offers an upgrade only when it knows how", async () => {
    const npmInstall = (bin: string) => `/lib/node_modules/@anthropic-ai/claude-code/${path.basename(bin)}`;
    const m = machine({ latest: async (pkg) => (pkg === "@anthropic-ai/claude-code" ? "2.1.290" : null), realpath: npmInstall });
    const item = find(await m.setup.status(), "cli:claude");
    assert.deepEqual([item.state, item.version, item.latest, item.action], ["installed", "2.1.283", "2.1.290", "Nâng cấp lên 2.1.290"], "behind but running: still installed");
    assert.match(item.detail, /^2\.1\.283, có bản 2\.1\.290 · .*\/claude$/);

    const unknown = machine({ latest: async () => "2.1.290", realpath: (b) => b });
    const manual = find(await unknown.setup.status(), "cli:claude");
    assert.equal(manual.action, null);
    assert.match(manual.detail, /nâng cấp theo cách bạn đã cài/);

    const current = machine({ latest: async () => "2.1.283", realpath: npmInstall });
    assert.deepEqual([find(await current.setup.status(), "cli:claude").action, find(await current.setup.status(), "cli:claude").latest], [null, "2.1.283"]);
  });

  it("upgrades with npm while holding the CLI's runs, and not under a running one", async () => {
    const held: string[] = [];
    let busy = 1;
    const m = machine({
      latest: async () => "2.1.290",
      realpath: (b) => `/lib/node_modules/@anthropic-ai/claude-code/${path.basename(b)}`,
      cliBusy: (kind) => (kind === "claude" ? busy : 0),
      holdCli: (kind, on) => void held.push(`${kind}:${on}`),
    });
    await assert.rejects(m.setup.install("cli:claude"), (err: { key?: string }) => err.key === "setupItem.cliBusy");
    assert.deepEqual(held, [], "refused before anything was held");
    busy = 0;
    const r = await m.setup.install("cli:claude");
    assert.ok(calls(m.bin).some((c) => c.startsWith("npm install -g @anthropic-ai/claude-code@latest")), calls(m.bin).join("\n"));
    assert.deepEqual(held, ["claude:true", "claude:false"]);
    assert.equal(r.item.id, "cli:claude");
  });

  it("asks the registry for the newest version once in a while, not at every check", async () => {
    let asked = 0;
    const m = machine({ latest: async () => (asked++, "2.1.290") });
    await m.setup.status();
    await m.setup.status();
    assert.equal(asked, 1);
  });
});

