// A profile's CLI opened for the person at this machine to work in a project's repo (roadmap 32a). It is their
// session, not a run: no -p, no run flags, no agent policy, and their own MCP servers, hooks and settings stay.
// Only Hive's server is added, under the profile's name, so what they claim or remember shows as that profile.
// No Electron imports.
import type { AgentProfile } from "@xdev-hive/core";
import { MCP_NAME, hiveMcpServer, hiveMcpServerAt, mcpLaunch } from "./installer.ts";
import { loginDirEnv } from "./runner/login.ts";
import type { TerminalCommand } from "./terminal.ts";

export interface CliOpen {
  command: TerminalCommand;
  /** Written to `mcpFile` before the terminal opens (Claude Code); null when the CLI takes none. */
  mcpConfig: string | null;
}

/** TOML literal string: Codex parses `-c` values as TOML, and single quotes survive both sh and cmd.exe quoting. */
const tomlLiteral = (s: string) => {
  if (/['\r\n]/.test(s)) throw new Error(`Cannot pass ${JSON.stringify(s)} to Codex -c`);
  return `'${s}'`;
};

export function cliCommand(
  profile: AgentProfile,
  /** path: the PATH runs get; null keeps the terminal's own (cmd.exe inherits the app's env). shim: its full path. */
  opts: { project: string; repo: string; bin: string; path: string | null; shim: string; mcpFile: string; title: string; done: string },
): CliOpen {
  const server = hiveMcpServer(profile.id, opts.project);
  // PATH so the CLI finds the hive-mcp shim (and node) the way runs do: Terminal on macOS starts from the login
  // profile, whose PATH may lack them.
  const env = { ...loginDirEnv(profile), ...(opts.path ? { PATH: opts.path } : {}), ...server.env };
  const base = { title: opts.title, bin: opts.bin, env, done: opts.done, cwd: opts.repo, name: "cli" };
  if (profile.kind === "claude") {
    // A file, not inline JSON: cmd.exe cannot carry the quotes of an inline value. The shim by full path, because a
    // terminal opened from the app does not always carry the PATH the app found (Windows: cmd.exe inherits its own).
    const entry = hiveMcpServerAt(opts.shim, profile.id, opts.project);
    return { command: { ...base, args: ["--mcp-config", opts.mcpFile] }, mcpConfig: `${JSON.stringify({ mcpServers: { [MCP_NAME]: entry } }, null, 2)}\n` };
  }
  if (profile.kind === "codex") {
    const vars = Object.entries(server.env).map(([k, v]) => `${k}=${tomlLiteral(v)}`).join(",");
    const launch = mcpLaunch(opts.shim, []);
    // The command too: an account folder made before Hive's block was installed would have an env and nothing to run.
    const args = [
      "-c",
      `mcp_servers.${MCP_NAME}.command=${tomlLiteral(launch.command)}`,
      "-c",
      `mcp_servers.${MCP_NAME}.args=[${launch.args.map(tomlLiteral).join(",")}]`,
      "-c",
      `mcp_servers.${MCP_NAME}.env={${vars}}`,
    ];
    return { command: { ...base, args }, mcpConfig: null };
  }
  // Gemini and custom CLIs read Hive's server from their own settings; HIVE_AGENT in the env names the profile.
  return { command: { ...base, args: [] }, mcpConfig: null };
}
