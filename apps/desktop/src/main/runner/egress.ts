// A run's container with a limited network (profile.container.network "restricted", the default): its
// own Docker network with no way out (--internal) and a proxy container, from the same image, that is
// on that network and on Docker's bridge and lets through the allowed hosts only (docker/agent/egress.mjs).
// Both belong to one run and go with it. No Electron imports.
import type { AgentProfile } from "@xdev-hive/core";

/** Hosts every restricted container may reach: the CLIs' APIs and sign-in, package registries, GitHub. */
export const DEFAULT_EGRESS = [
  // Claude Code
  ".anthropic.com",
  "claude.ai",
  ".claude.ai",
  "claude.com",
  ".claude.com",
  // Codex
  ".openai.com",
  "chatgpt.com",
  ".chatgpt.com",
  // Gemini CLI
  ".googleapis.com",
  "accounts.google.com",
  // Packages the agent may install while it tests (asked 28/9)
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  // GitHub
  "github.com",
  ".github.com",
  ".githubusercontent.com",
];

/** host, or host:port when the URL names one. null for a URL that cannot be read. */
function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return null;
  }
}

/** The allowlist of a run: the defaults, the hub and the team's GitLab, and what the profile adds. */
export function egressAllow(profile: AgentProfile, urls: { hub?: string | null; gitlab?: string | null }): string[] {
  const extra = [urls.hub, urls.gitlab].map((u) => (u ? hostOf(u) : null)).filter((h): h is string => h !== null);
  return [...new Set([...DEFAULT_EGRESS, ...extra, ...(profile.container?.allow ?? [])].map((h) => h.toLowerCase()))];
}

export const PROXY_PORT = 3128;
/** The proxy's name on the run's network. */
export const PROXY_ALIAS = "egress";

export interface Egress {
  network: string;
  proxy: string;
  /** docker commands (arguments), in order, that set it up. */
  setup: string[][];
  /** And that take it down (each may fail when setup stopped half-way). */
  teardown: string[][];
  /** For the agent's container. */
  runArgs: string[];
  env: Record<string, string>;
}

export function egressPlan(runId: string, image: string, allow: string[]): Egress {
  const network = `hive-${runId.replace(/[^\w.-]/g, "-")}-net`;
  const proxy = `hive-${runId.replace(/[^\w.-]/g, "-")}-egress`;
  const url = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
  return {
    network,
    proxy,
    setup: [
      ["network", "create", "--internal", network],
      // On Docker's bridge first (the way out), then on the run's network under the alias the agent uses.
      ["run", "-d", "--rm", "--init", "--name", proxy, "--user", "node", "-e", "HIVE_EGRESS_ALLOW", image, "node", "/opt/xdev-hive/egress.mjs"],
      ["network", "connect", "--alias", PROXY_ALIAS, network, proxy],
    ],
    teardown: [
      ["rm", "-f", proxy],
      ["network", "rm", network],
    ],
    runArgs: ["--network", network],
    env: {
      HTTPS_PROXY: url,
      HTTP_PROXY: url,
      https_proxy: url,
      http_proxy: url,
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
      // Node's own fetch uses the variables above only with this (checked with Node 22.23 in the image).
      NODE_USE_ENV_PROXY: "1",
    },
  };
}

/** What the proxy refused, from its log (one "denied host:port" per line), most frequent first. */
export function deniedHosts(log: string): Array<{ host: string; count: number }> {
  const counts = new Map<string, number>();
  for (const line of log.split("\n")) {
    const m = /^denied (\S+)$/.exec(line.trim());
    if (m) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([host, count]) => ({ host, count }));
}
