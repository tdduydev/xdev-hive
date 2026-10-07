import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { toolHash, type DesktopProject, type MachineTools, type SetupReport, type ToolEntry } from "@xdev-hive/core";
import { setMainLocale } from "#desktop/main/i18n.ts";
import { CODEGRAPH_PACKAGE } from "#desktop/main/installer.ts";
import { APP_TOOLS } from "#desktop/main/runner/tools.ts";
import { AGENT_CLIS, cliUpgrade, parseCliVersion, Setup, type SetupHost } from "#desktop/main/setup.ts";
import { expandVars, pathHasDir, pathWithDir, type UserPath } from "#desktop/main/winpath.ts";
import { sysBin } from "#desktop/test/fixtures/sys-path.ts";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

const tmp = (p: string) => testTmpDir(path.join(os.tmpdir(), `hive-setup-${p}-`));

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

function machine(opts: { npm?: boolean; uv?: boolean; specify?: boolean } & Pick<SetupHost, "latest" | "realpath" | "cliBusy" | "holdCli" | "platform" | "registry"> = {}) {
  const bin = tmp("bin");
  const shimDir = tmp("shim");
  const home = tmp("home");
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
  // Windows is the case this task is about: the shim folder is not on PATH until the button writes it to the registry.
  const pathEnv = [bin, ...(opts.platform === "win32" ? [] : [shimDir]), sysBin()].join(path.delimiter);
  // What the runner's last heartbeat carried, and what this machine's user allowed: tests change them in place.
  const hub: { tools: MachineTools | null; trust: Record<string, string> } = { tools: null, trust: {} };
  const setup = new Setup({
    pathEnv: () => pathEnv,
    env: () => ({ PATH: pathEnv, HOME: home }),
    projects: () => projects,
    shim: { electronPath: "/Applications/xDev Hive.app/Contents/MacOS/xDev Hive", entry: "/app/mcp/hive-mcp.mjs", binDir: shimDir, platform: opts.platform },
    home,
    // No registry in tests unless one says what is newest.
    latest: opts.latest ?? (async () => null),
    ...(opts.realpath ? { realpath: opts.realpath } : {}),
    ...(opts.cliBusy ? { cliBusy: opts.cliBusy } : {}),
    ...(opts.holdCli ? { holdCli: opts.holdCli } : {}),
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.registry ? { registry: opts.registry } : {}),
    tools: () => hub.tools,
    toolTrust: () => hub.trust,
  });
  return { setup, bin, shimDir, uvBin, home, projects, hub };
}

/** The user's Path in HKCU\Environment, in memory: what the real one does on Windows, on any machine. */
function fakeRegistry(start: { value: string; expand: boolean } | null = null) {
  const state = { current: start, writes: [] as Array<{ value: string; expand: boolean }>, broadcasts: 0 };
  const reg: UserPath = {
    read: () => state.current,
    write: (value, expand) => {
      state.current = { value, expand };
      state.writes.push({ value, expand });
    },
    broadcast: () => {
      state.broadcasts++;
    },
  };
  return { reg, state };
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
      ["cli:antigravity", "missing"],
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
      // 39b names items by what they do, not by the file or command.
      assert.equal(find(r, "shim").label, "Connect agents to Hive");
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

  it("Windows: offers Add to PATH and writes the folder into the user's Path once", async () => {
    const { reg, state } = fakeRegistry({ value: String.raw`%USERPROFILE%\bin;C:\Program Files\Git\cmd`, expand: true });
    const m = machine({ platform: "win32", registry: reg });
    const installed = await m.setup.install("shim");
    const dir = m.shimDir;

    assert.equal(installed.item.state, "installed", "the registry now has the folder, so the item is done");
    assert.match(installed.output, /Đã thêm/);
    assert.deepEqual(state.writes, [{ value: String.raw`%USERPROFILE%\bin;C:\Program Files\Git\cmd;${dir}`, expand: true }]);
    assert.equal(state.broadcasts, 1, "WM_SETTINGCHANGE once");
    assert.match(state.current!.value, /^%USERPROFILE%\\bin;/, "the entries that were there keep their %…%");

    // Asked again: nothing more is written, and no second broadcast.
    const again = await m.setup.install("shim");
    assert.equal(state.writes.length, 1);
    assert.equal(state.broadcasts, 1);
    assert.match(again.output, /đã có sẵn/);
  });

  it("Windows: a shim off the user's Path gets the button, and without a registry it stays manual", async () => {
    const { reg } = fakeRegistry({ value: String.raw`C:\Windows\system32`, expand: false });
    const m = machine({ platform: "win32", registry: reg });
    writeFileSync(path.join(m.shimDir, "hive-mcp.cmd"), "@echo off\r\nrem xdev-hive: MCP launcher installed by xDev Hive\r\nset ELECTRON_RUN_AS_NODE=1\r\n\"/Applications/xDev Hive.app/Contents/MacOS/xDev Hive\" \"/app/mcp/hive-mcp.mjs\" %*\r\n");
    const item = await m.setup.item("shim");
    assert.equal(item.state, "manual");
    assert.equal(item.action, "Thêm vào PATH");
    assert.match(item.detail, /HKCU\\Environment/);

    const noReg = machine({ platform: "win32" });
    writeFileSync(path.join(noReg.shimDir, "hive-mcp.cmd"), readFileSync(path.join(m.shimDir, "hive-mcp.cmd"), "utf8"));
    assert.equal((await noReg.setup.item("shim")).action, null);
  });
});

describe("the user's Path on Windows", () => {
  const env = { USERPROFILE: String.raw`C:\Users\duy`, PATH: "ignored" };
  const bin = String.raw`C:\Users\duy\.xdev-hive\bin`;

  it("counts a folder written with %USERPROFILE%, another case or a trailing slash as the same one", () => {
    assert.equal(expandVars("%UserProfile%\\bin", env), String.raw`C:\Users\duy\bin`);
    assert.equal(expandVars("%NOT_SET%\\bin", env), String.raw`%NOT_SET%\bin`, "a name the env lacks stays as written");
    assert.ok(pathHasDir(String.raw`C:\Windows;%USERPROFILE%\.xdev-hive\bin`, bin, env));
    // A plain string: a raw template cannot end with a backslash, and a trailing one is what some installers leave.
    assert.ok(pathHasDir("c:\\users\\duy\\.xdev-hive\\bin\\", bin, env));
    assert.ok(pathHasDir(String.raw`"C:\Users\duy\.xdev-hive\bin"`, bin, env));
    assert.ok(!pathHasDir(String.raw`C:\Users\duy\.xdev-hive\bin2`, bin, env));
    assert.ok(!pathHasDir(null, bin, env));
  });

  it("appends once, keeps every entry as written, and makes a Path for a user who had none", () => {
    assert.equal(pathWithDir(String.raw`%JAVA_HOME%\bin`, bin, env), String.raw`%JAVA_HOME%\bin;${bin}`);
    assert.equal(pathWithDir(String.raw`%JAVA_HOME%\bin;`, bin, env), String.raw`%JAVA_HOME%\bin;${bin}`, "no empty entry from a trailing ;");
    assert.equal(pathWithDir(String.raw`%USERPROFILE%\.xdev-hive\bin`, bin, env), null, "already there");
    assert.equal(pathWithDir(null, bin, env), bin);
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
    assert.match(find(r, "app:agents").detail, /~\/\.claude\.json.*\.claude\/settings\.json/);
    assert.equal(find(r, "app:speckit").action, null, "no specify on this machine yet");
    assert.match(find(r, "app:speckit").detail, /Cài Spec Kit CLI \(specify\)/);

    for (const id of ["app:agents", "app:codegraph-mcp", "app:superpowers", "app:codegraph-index"]) {
      assert.equal((await m.setup.install(id)).item.state, "installed", id);
    }
    r = await m.setup.status();
    assert.ok(r.projects[0]!.items.filter((i) => i.id !== "app:speckit").every((i) => i.state === "installed"));

    const mcp = JSON.parse(readFileSync(path.join(repo, ".mcp.json"), "utf8"));
    // Only codegraph is shared through git; xdev-hive names this machine's own shim, so it goes to the local scope.
    assert.deepEqual(Object.keys(mcp.mcpServers), ["codegraph"]);
    assert.deepEqual(mcp.mcpServers.codegraph.args, ["-y", CODEGRAPH_PACKAGE, "serve", "--mcp"]);
    assert.equal(mcp.mcpServers.codegraph.env.CODEGRAPH_TELEMETRY, "0");
    const local = JSON.parse(readFileSync(path.join(m.home, ".claude.json"), "utf8"));
    assert.equal(local.projects[repo].mcpServers["xdev-hive"].command, path.join(m.shimDir, "hive-mcp"));
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
    assert.ok(calls(m.bin).includes("uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.0.13 telemetry="), "the app's own pin");
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

describe("Setup: hub tools (tool:<id>)", () => {
  /** A CLI tool of the catalog with no code of its own in the app. */
  const RTK: ToolEntry = {
    id: "rtk",
    name: "RTK",
    description: "",
    kind: "cli",
    package: { registry: "npm", name: "rtk-cli", version: "0.9.0" },
    mcp: null,
    plugin: null,
    hooks: [],
    agents: ["claude"],
    check: ["rtk", "--version"],
    install: ["toolinst", "{package}"],
    prepare: null,
    env: { RTK_TELEMETRY: "0" },
    secretEnv: [],
    license: "MIT",
    homepage: null,
    handler: null,
    enabledByDefault: false,
  };
  /** The catalog as a heartbeat carries it, with `on` turned on for the project app. */
  const catalog = (entries: ToolEntry[], on: string[]): MachineTools => ({
    entries,
    projects: { app: entries.map((e) => ({ id: e.id, enabled: on.includes(e.id) ? true : null, effective: on.includes(e.id), required: false })) },
  });
  /** A machine with the project app, and an installer that puts a fake rtk on PATH. */
  function withRtk(entries: ToolEntry[] = [RTK], on = ["rtk"]) {
    const m = machine();
    m.projects.push({ name: "app", repo: gitRepo() });
    fakeBin(m.bin, "toolinst", `printf '#!/bin/sh\\necho "rtk 0.9.0 env=$RTK_TELEMETRY"\\n' > "${m.bin}/rtk" && chmod +x "${m.bin}/rtk"; echo "installed $1"`);
    m.hub.tools = catalog(entries, on);
    return m;
  }

  it("before the machine's user allows it: manual, and nothing of the tool runs, not even its check", async () => {
    const m = withRtk();
    const item = find(await m.setup.status(), "tool:rtk");
    assert.equal(item.state, "manual");
    assert.equal(item.action, null);
    assert.equal(item.label, "RTK");
    assert.match(item.detail, /Chưa được cho phép trên máy này/);
    await assert.rejects(m.setup.install("tool:rtk"), /Chưa được cho phép trên máy này/);
    assert.deepEqual(calls(m.bin).filter((c) => c.startsWith("toolinst") || c.startsWith("rtk")), []);
  });

  it("allowed: missing with the install command filled in, installs, then the check finds it", async () => {
    const m = withRtk();
    m.hub.trust = { rtk: toolHash(RTK) };
    const before = await m.setup.item("tool:rtk");
    assert.equal(before.state, "missing");
    assert.equal(before.action, "Cài");
    assert.match(before.detail, /toolinst rtk-cli@0\.9\.0/);

    const res = await m.setup.install("tool:rtk");
    assert.ok(calls(m.bin).includes("toolinst rtk-cli@0.9.0 telemetry="));
    assert.match(res.output, /installed rtk-cli@0\.9\.0/);
    assert.equal(res.item.state, "installed");
    // The check runs with the entry's own variables.
    assert.match(res.item.detail, /^rtk 0\.9\.0 env=0 · .*\/rtk$/);
  });

  it("a new version on the hub is a change the user allows again", async () => {
    const m = withRtk();
    m.hub.trust = { rtk: toolHash(RTK) };
    await m.setup.install("tool:rtk");
    m.hub.tools = catalog([{ ...RTK, package: { ...RTK.package!, version: "0.10.0" } }], ["rtk"]);
    assert.equal((await m.setup.item("tool:rtk")).state, "manual");
    await assert.rejects(m.setup.install("tool:rtk"), /Chưa được cho phép/);
  });

  it("with no install command: missing, with nothing to press", async () => {
    const noInstall = { ...RTK, install: null };
    const m = withRtk([noInstall]);
    m.hub.trust = { rtk: toolHash(noInstall) };
    const item = await m.setup.item("tool:rtk");
    assert.equal(item.state, "missing");
    assert.equal(item.action, null);
    await assert.rejects(m.setup.install("tool:rtk"), /Danh mục không có lệnh cài/);
  });

  it("a hook (28d): installed only at the version the catalog pins, else outdated; no {runDir} variable without a run", async () => {
    const hook: ToolEntry = {
      ...RTK,
      kind: "hook",
      hooks: [{ event: "PreToolUse", matcher: "Bash", command: ["rtk", "hook", "claude"] }],
      env: { RTK_TELEMETRY: "0", RTK_DB_PATH: "{runDir}/rtk.db" },
    };
    const m = withRtk([hook]);
    m.hub.trust = { rtk: toolHash(hook) };
    fakeBin(m.bin, "rtk", 'echo "rtk 0.9.0 db=[$RTK_DB_PATH]"');
    const ok = await m.setup.item("tool:rtk");
    assert.equal(ok.state, "installed");
    assert.match(ok.detail, /^rtk 0\.9\.0 db=\[\] · /);

    const pinned = { ...hook, package: { ...hook.package!, version: "0.8.0" } };
    m.hub.tools = catalog([pinned], ["rtk"]);
    m.hub.trust = { rtk: toolHash(pinned) };
    const old = await m.setup.item("tool:rtk");
    assert.equal(old.state, "outdated");
    assert.equal(old.action, null);
    assert.equal(old.detail, "Máy có 0.9.0, danh mục duyệt 0.8.0: run không dùng hook cho tới khi đúng bản (cài đúng bản, hoặc admin nâng phiên bản trong danh mục).");
  });

  it("only tools on for one of the machine's projects, with a check and no handler; none without a catalog", async () => {
    const mcp: ToolEntry = { ...RTK, id: "docs-mcp", kind: "mcp", mcp: { command: "npx", args: ["-y", "{package}"] }, check: null, install: null };
    const m = withRtk([RTK, mcp, APP_TOOLS.speckit], []);
    const ids = (r: SetupReport) => r.machine.map((i) => i.id).filter((id) => id.startsWith("tool:"));
    assert.deepEqual(ids(await m.setup.status()), [], "off for app");
    await assert.rejects(m.setup.item("tool:rtk"), /Không có mục tool:rtk/);

    m.hub.tools = catalog([RTK, mcp, APP_TOOLS.speckit], ["rtk", "docs-mcp", "speckit"]);
    // An MCP server with no check has nothing to install (npx fetches it); the seed keeps cli:specify and app:speckit.
    assert.deepEqual(ids(await m.setup.status()), ["tool:rtk"]);

    m.hub.tools = null;
    assert.deepEqual(ids(await m.setup.status()), []);
  });

  it("installs Spec Kit at the catalog's pinned version once allowed, else at the app's own", async () => {
    const m = machine({ uv: true });
    const newer: ToolEntry = { ...APP_TOOLS.speckit, package: { ...APP_TOOLS.speckit.package!, version: "v1.0.14" } };
    m.hub.tools = catalog([newer], ["speckit"]);
    const uvInstalls = () => calls(m.bin).filter((c) => c.startsWith("uv tool install"));

    // Not allowed yet: the app's pin, never an unpinned spec-kit.
    assert.match((await m.setup.item("cli:specify")).detail, /--from git\+https:\/\/github\.com\/github\/spec-kit\.git@v1\.0\.13/);
    await m.setup.install("cli:specify");
    assert.deepEqual(uvInstalls(), ["uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.0.13 telemetry="]);

    m.hub.trust = { speckit: toolHash(newer) };
    await m.setup.install("cli:specify");
    assert.equal(uvInstalls()[1], "uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.0.14 telemetry=");
  });
});

describe("Antigravity setup without a real CLI or network", () => {
  it("reports GitHub release versions and the /usage minimum without installing anything", async () => {
    const m = machine({ latest: async (pkg) => pkg === "google-antigravity/antigravity-cli" ? "1.2.17" : null });
    fakeBin(m.bin, "agy", 'echo "agy 1.1.10"');
    const old = await m.setup.item("cli:antigravity");
    assert.equal(old.version, "1.1.10");
    assert.equal(old.latest, "1.2.17");
    assert.match(old.detail, /1.1.11/);
    assert.equal(old.action, null, "no guessed installer command");
    assert.ok(!calls(m.bin).some((line) => line.includes("/usage")));
  });
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
