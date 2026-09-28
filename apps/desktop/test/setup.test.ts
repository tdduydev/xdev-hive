import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { DesktopProject, SetupReport } from "@xdev-hive/core";
import { setMainLocale } from "../src/main/i18n.ts";
import { CODEGRAPH_PACKAGE } from "../src/main/installer.ts";
import { Setup } from "../src/main/setup.ts";

const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), `hive-setup-${p}-`));

/** A fake CLI: records its args (and CODEGRAPH_TELEMETRY) and runs an optional shell snippet. */
function fakeBin(dir: string, name: string, body = "") {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "${name} $* telemetry=$CODEGRAPH_TELEMETRY" >> "${path.join(dir, "calls.log")}"\n${body}\n`);
  chmodSync(file, 0o755);
}
const calls = (dir: string) => (existsSync(path.join(dir, "calls.log")) ? readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n") : []);

function machine(opts: { npm?: boolean } = {}) {
  const bin = tmp("bin");
  const shimDir = tmp("shim");
  fakeBin(bin, "claude", 'echo "2.1.283 (Claude Code)"');
  if (opts.npm !== false) {
    // `npm install -g @openai/codex` "installs" codex next to it.
    fakeBin(bin, "npm", `[ "$3" = "@openai/codex" ] && printf '#!/bin/sh\\necho codex-cli 0.157.1\\n' > "${bin}/codex" && chmod +x "${bin}/codex"; echo "added 1 package"`);
    fakeBin(bin, "npx", `[ "$3" = "init" ] && mkdir -p .codegraph && echo db > .codegraph/codegraph.db; echo "npx ok"`);
  }
  const projects: DesktopProject[] = [];
  const pathEnv = [bin, shimDir, "/usr/bin", "/bin"].join(path.delimiter);
  const setup = new Setup({
    pathEnv: () => pathEnv,
    env: () => ({ PATH: pathEnv, HOME: process.env.HOME }),
    projects: () => projects,
    shim: { electronPath: "/Applications/xDev Hive.app/Contents/MacOS/xDev Hive", entry: "/app/mcp/hive-mcp.mjs", binDir: shimDir },
    home: tmp("home"),
  });
  return { setup, bin, shimDir, projects };
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
    assert.deepEqual(r.machine.map((i) => [i.id, i.state]), [["cli:claude", "installed"], ["cli:codex", "missing"], ["cli:gemini", "missing"], ["shim", "missing"]]);
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
    ]);
    assert.match(find(r, "app:agents").detail, /\.mcp\.json.*\.claude\/settings\.json/);

    for (const id of ["app:agents", "app:codegraph-mcp", "app:superpowers", "app:codegraph-index"]) {
      assert.equal((await m.setup.install(id)).item.state, "installed", id);
    }
    r = await m.setup.status();
    assert.ok(r.projects[0]!.items.every((i) => i.state === "installed"));

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
