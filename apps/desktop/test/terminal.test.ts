import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { AGENT_TEMPLATES } from "@xdev-hive/core";
import { LoginMonitor, loginParts, parseLogin, readLoginHow } from "#desktop/main/runner/login.ts";
import { openInTerminal, terminalScript, type TerminalCommand } from "#desktop/main/terminal.ts";
import { cliCommand } from "#desktop/main/cli-open.ts";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

const tmp = () => testTmpDir(path.join(os.tmpdir(), "hive-term-"));
const command: TerminalCommand = {
  title: "xDev Hive: sign in claude-2",
  bin: "/Users/duy/.local/bin/claude",
  args: ["auth", "login"],
  env: { CLAUDE_CONFIG_DIR: "/Users/duy/.claude-2" },
  done: "Done. Go back to xDev Hive.",
};

describe("sign-in terminal", () => {
  it("writes a shell script that exports only the login dir and runs the command", () => {
    const mac = terminalScript("darwin", command);
    assert.equal(mac.name, "login.command");
    assert.equal(
      mac.content,
      [
        "#!/bin/sh",
        "# xDev Hive: sign in claude-2",
        "export CLAUDE_CONFIG_DIR='/Users/duy/.claude-2'",
        "'/Users/duy/.local/bin/claude' 'auth' 'login'",
        "echo",
        "echo 'Done. Go back to xDev Hive.'",
        "",
      ].join("\n"),
    );
    const linux = terminalScript("linux", command);
    assert.equal(linux.name, "login.sh");
    assert.match(linux.content, /\nread _\n$/, "keeps the window open until Enter");
    assert.match(terminalScript("darwin", { ...command, bin: "/opt/it's/claude" }).content, /'\/opt\/it'\\''s\/claude'/);
  });

  it("writes a cmd script on Windows and refuses what cmd.exe cannot quote", () => {
    const win = terminalScript("win32", { ...command, bin: "C:\\Users\\duy\\AppData\\Roaming\\npm\\claude.cmd", env: { CLAUDE_CONFIG_DIR: "C:\\Users\\duy\\.claude-2" } });
    assert.equal(win.name, "login.cmd");
    assert.ok(win.content.includes('set "CLAUDE_CONFIG_DIR=C:\\Users\\duy\\.claude-2"\r\n'));
    assert.ok(win.content.includes('call "C:\\Users\\duy\\AppData\\Roaming\\npm\\claude.cmd" "auth" "login"\r\n'));
    assert.ok(win.content.endsWith("pause\r\n"));
    assert.throws(() => terminalScript("win32", { ...command, env: { CLAUDE_CONFIG_DIR: "C:\\a%PATH%" } }), /cmd\.exe/);
  });

  it("opens the script in the platform's terminal, or says there is none", () => {
    const calls: Array<[string, string[]]> = [];
    const run = (bin: string, args: string[]) => void calls.push([bin, args]);
    const none = () => null;

    const mac = openInTerminal(command, { dir: tmp(), platform: "darwin", which: none, run })!;
    assert.deepEqual(calls.at(-1), ["open", ["-a", "Terminal", mac]]);
    assert.equal(statSync(mac).mode & 0o777, 0o700, "only the user can read or run it");
    assert.match(readFileSync(mac, "utf8"), /auth' 'login'/);

    const win = openInTerminal(command, { dir: tmp(), platform: "win32", which: none, run })!;
    assert.deepEqual(calls.at(-1), ["cmd.exe", ["/c", "start", "", win]]);

    const gnome = openInTerminal(command, { dir: tmp(), platform: "linux", which: (b) => (b === "gnome-terminal" ? "/usr/bin/gnome-terminal" : null), run })!;
    assert.deepEqual(calls.at(-1), ["/usr/bin/gnome-terminal", ["--", "sh", gnome]]);
    assert.equal(openInTerminal(command, { dir: tmp(), platform: "linux", which: none, run }), null);
  });

  it("starts in the given folder, and stops when it is gone rather than work elsewhere (roadmap 32a)", () => {
    const mac = terminalScript("darwin", { ...command, cwd: "/Users/duy/Work/it's here", name: "cli" });
    assert.equal(mac.name, "cli.command");
    assert.ok(mac.content.includes("\ncd '/Users/duy/Work/it'\\''s here' || exit 1\n'/Users/duy/.local/bin/claude'"), mac.content);
    assert.equal(terminalScript("linux", { ...command, name: "cli" }).name, "cli.sh");
    assert.ok(!terminalScript("linux", command).content.includes("\ncd "), "no cd without a folder");
    const win = terminalScript("win32", { ...command, cwd: "D:\\Work\\xdev hive", name: "cli" });
    assert.equal(win.name, "cli.cmd");
    assert.ok(win.content.includes('cd /d "D:\\Work\\xdev hive" || exit /b 1\r\ncall '), win.content);
    assert.throws(() => terminalScript("win32", { ...command, cwd: 'D:\\a"&calc' }), /cmd\.exe/);
  });

  it("opens a profile's CLI as the person's own session, with Hive's server under the profile's id (roadmap 32a)", () => {
    const shim = "/Users/duy/.local/bin/hive-mcp";
    const opts = { project: "xdev-hive", repo: "/Users/duy/Work/xdev-hive", bin: "/Users/duy/.local/bin/claude", path: "/opt/homebrew/bin:/usr/bin", shim, mcpFile: "/tmp/cli/claude-2/mcp.json", title: "t", done: "d" };
    const claude = { ...AGENT_TEMPLATES.claude, id: "claude-2", env: { CLAUDE_CONFIG_DIR: "~/.claude-2", ANTHROPIC_API_KEY: "never-in-a-script" } };
    const c = cliCommand(claude, opts);
    assert.deepEqual(c.command.args, ["--mcp-config", opts.mcpFile], "no -p and none of the run's flags");
    assert.equal(c.command.cwd, opts.repo);
    assert.deepEqual(c.command.env, {
      CLAUDE_CONFIG_DIR: path.join(os.homedir(), ".claude-2"),
      PATH: opts.path,
      HIVE_AGENT: "claude-2",
      HIVE_PROJECT: "xdev-hive",
    });
    // The shim by full path: a terminal opened from the app does not always carry the PATH the app found.
    assert.deepEqual(JSON.parse(c.mcpConfig!), { mcpServers: { "xdev-hive": { type: "stdio", command: shim, args: [], env: { HIVE_AGENT: "claude-2", HIVE_PROJECT: "xdev-hive" } } } });
    assert.ok(!terminalScript("win32", c.command).content.includes("never-in-a-script"));
    assert.equal(cliCommand(claude, { ...opts, path: null }).command.env.PATH, undefined, "Windows keeps the terminal's PATH");

    const codex = cliCommand({ ...AGENT_TEMPLATES.codex, id: "codex-2", env: { CODEX_HOME: "/Users/duy/.xdev-hive/accounts/codex-2" } }, opts);
    assert.deepEqual(codex.command.args, [
      "-c",
      `mcp_servers.xdev-hive.command='${shim}'`,
      "-c",
      "mcp_servers.xdev-hive.args=[]",
      "-c",
      "mcp_servers.xdev-hive.env={HIVE_AGENT='codex-2',HIVE_PROJECT='xdev-hive'}",
    ]);
    assert.equal(codex.mcpConfig, null);
    assert.equal(codex.command.env.CODEX_HOME, "/Users/duy/.xdev-hive/accounts/codex-2");
    // The script carries the TOML on cmd.exe too: single quotes are no trouble there.
    assert.ok(terminalScript("win32", codex.command).content.includes(`"mcp_servers.xdev-hive.env={HIVE_AGENT='codex-2',HIVE_PROJECT='xdev-hive'}"`));

    const gemini = cliCommand({ ...AGENT_TEMPLATES.gemini, id: "gemini-1" }, opts);
    assert.deepEqual(gemini.command.args, []);
    assert.equal(gemini.command.env.HIVE_AGENT, "gemini-1");
  });

  it("takes the sign-in command and only the login-dir env from a profile", () => {
    const parts = loginParts({ ...AGENT_TEMPLATES.claude, env: { CLAUDE_CONFIG_DIR: "~/.claude-2", ANTHROPIC_API_KEY: "never-in-a-script" } })!;
    assert.deepEqual(parts, { args: ["auth", "login"], env: { CLAUDE_CONFIG_DIR: path.join(os.homedir(), ".claude-2") } });
    assert.deepEqual(loginParts(AGENT_TEMPLATES.codex), { args: ["login"], env: {} });
    assert.equal(loginParts(AGENT_TEMPLATES.gemini), null);
  });

  it("signs in the way the user picked, with the CLI's own options (roadmap 24b)", () => {
    const claude = { ...AGENT_TEMPLATES.claude, env: { CLAUDE_CONFIG_DIR: "~/.xdev-hive/accounts/claude-2" } };
    assert.deepEqual(loginParts(claude, { sso: true, email: "duy@example.com" })?.args, ["auth", "login", "--sso", "--email", "duy@example.com"]);
    assert.deepEqual(loginParts(claude, { console: true })?.args, ["auth", "login", "--console"]);
    assert.deepEqual(loginParts(claude, { device: true })?.args, ["auth", "login"], "Codex's option means nothing to Claude Code");
    assert.deepEqual(loginParts(AGENT_TEMPLATES.codex, { device: true, sso: true })?.args, ["login", "--device-auth"]);
    assert.throws(() => loginParts(claude, { email: "a b@x.com" }), /email/);
    assert.throws(() => loginParts(claude, { email: 'x@y"; rm -rf ~' }), /email/);
    // From the renderer: only true turns an option on, only a string is an email.
    assert.deepEqual(readLoginHow({ sso: "yes", console: 1, device: true, email: 42 }), { sso: false, console: false, device: true });
    assert.deepEqual(readLoginHow(undefined), { sso: false, console: false, device: false });
  });

  it("counts a new account as signed out until its check answers, even when a check of the old list ends after", async () => {
    let profiles = [{ ...AGENT_TEMPLATES.claude, bin: process.execPath }];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const monitor = new LoginMonitor(() => profiles, () => ({ PATH: path.dirname(process.execPath) }), async () => (await slow, { code: 0, output: '{"loggedIn":true}' }));
    const checking = monitor.refresh();
    const added = { ...AGENT_TEMPLATES.claude, id: "claude-2", bin: process.execPath, env: { CLAUDE_CONFIG_DIR: "/tmp/acc/claude-2" } };
    monitor.expectSignedOut(added);
    profiles = [...profiles, added];
    release();
    await checking;
    assert.equal(monitor.get("claude-2")?.loggedIn, false);
    assert.deepEqual(monitor.signedOut(), ["claude-2"]);
  });

  it("tells accounts apart by the email Claude Code reports", () => {
    const out = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "duy@example.com" });
    assert.deepEqual(parseLogin("claude", 0, out), { loggedIn: true, method: "claude.ai · max", account: "duy@example.com" });
    assert.deepEqual(parseLogin("claude", 1, JSON.stringify({ loggedIn: false, authMethod: "none", email: "old@example.com" })), { loggedIn: false, method: null });
  });

  it("knows which profiles to check again when the user comes back", async () => {
    const profiles = [
      { ...AGENT_TEMPLATES.claude, bin: process.execPath },
      { ...AGENT_TEMPLATES.codex, bin: process.execPath },
    ];
    const run = async (_bin: string, args: string[]) => (args[0] === "auth" ? { code: 0, output: '{"loggedIn":false}' } : { code: 0, output: "Logged in using ChatGPT" });
    const logins = new LoginMonitor(() => profiles, () => ({ PATH: path.dirname(process.execPath) }), run);
    await logins.refresh();
    assert.deepEqual(logins.signedOut(), ["claude-1"]);
  });
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
