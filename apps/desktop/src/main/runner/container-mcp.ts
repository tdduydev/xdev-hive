// How an agent in a container reaches Hive: the hub's HTTP MCP (hub mode only; a container has neither
// the hive-mcp shim nor the local database). Each CLI takes it differently:
//   Claude Code  --mcp-config <file> (runner writes it 0600, mounts it read-only, removes it)
//   Codex        -c overrides: the shim's server off, an HTTP one with the token from HIVE_HUB_TOKEN
//   Gemini CLI   the image's /etc/gemini-cli/settings.json, filled from HIVE_HUB_URL, HIVE_HUB_TOKEN…
// The headers only narrow what the machine's token may do (see the hub's /mcp). No Electron imports.
import { agentSource } from "@xdev-hive/core";

export interface HubMcp {
  url: string;
  token: string;
}

export interface McpRun {
  /** Actor name the hub records writes under (agentActorName). */
  agent: string;
  machine: string;
  project: string;
  task: string;
  run: string;
  readOnly: boolean;
}

const endpoint = (hub: HubMcp) => `${hub.url.replace(/\/+$/, "")}/mcp`;

/** What the hub's /mcp reads besides the token. */
export function hubHeaders(r: McpRun): Record<string, string> {
  return {
    "x-hive-agent": r.agent,
    "x-hive-project": r.project,
    "x-hive-source": JSON.stringify(agentSource(r.machine, { HIVE_TASK: r.task, HIVE_RUN: r.run })),
    // As the stdio shim sends it: the run column of the audit rows this agent's writes leave.
    "x-hive-run": r.run,
    ...(r.readOnly ? { "x-hive-readonly": "1" } : {}),
  };
}

/** Claude Code's mcpServers (the file holds the token). */
export function claudeMcpServers(hub: HubMcp | null, r: McpRun): Record<string, unknown> {
  if (!hub) return {};
  return { "xdev-hive": { type: "http", url: endpoint(hub), headers: { authorization: `Bearer ${hub.token}`, ...hubHeaders(r) } } };
}

/** A TOML basic string (JSON's escapes are valid TOML ones). */
const toml = (s: string) => JSON.stringify(s);

/** Codex's -c overrides (put before its subcommand). The token itself stays in the environment. */
export function codexMcpArgs(hub: HubMcp | null, r: McpRun): string[] {
  // ~/.codex/config.toml (mounted) points xdev-hive at the shim, which the container does not have.
  const off = ["-c", "mcp_servers.xdev-hive.enabled=false"];
  if (!hub) return off;
  const headers = Object.entries(hubHeaders(r))
    .map(([k, v]) => `${toml(k)}=${toml(v)}`)
    .join(",");
  return [
    ...off,
    "-c",
    `mcp_servers.hive.url=${toml(endpoint(hub))}`,
    "-c",
    'mcp_servers.hive.bearer_token_env_var="HIVE_HUB_TOKEN"',
    "-c",
    `mcp_servers.hive.http_headers={${headers}}`,
    // Headless: Hive's tools run without asking (see codexArgs).
    "-c",
    'mcp_servers.hive.default_tools_approval_mode="approve"',
  ];
}

/** Variables the container gets for Codex and Gemini (passed by name, so the token is not on the command line). */
export function hubMcpEnv(hub: HubMcp | null, r: McpRun, kind: string): Record<string, string> {
  if (!hub || (kind !== "codex" && kind !== "gemini")) return {};
  const h = hubHeaders(r);
  return {
    HIVE_HUB_TOKEN: hub.token,
    ...(kind === "gemini"
      ? { HIVE_HUB_URL: hub.url.replace(/\/+$/, ""), HIVE_MCP_AGENT: h["x-hive-agent"]!, HIVE_MCP_SOURCE: h["x-hive-source"]!, HIVE_MCP_READONLY: r.readOnly ? "1" : "" }
      : {}),
  };
}
