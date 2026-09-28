// Runs a profile's CLI inside a Docker container instead of straight on the machine (profile.container).
// The container sees the task's worktree and the repo's .git (same paths as on the machine, so paths in
// the prompt and git's worktree links still hold), the CLI's own login folder, and nothing else of the
// home directory. Variables go to Docker by name only (`-e NAME`), so their values never show in the
// process list. No Electron imports.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProfile } from "@xdev-hive/core";
import { expandHome } from "./command.ts";

/** Where each CLI keeps its login and settings, unless the profile's env points elsewhere. */
function loginPaths(profile: AgentProfile, home: string): string[] {
  const env = profile.env;
  const at = (v: string | undefined, fallback: string) => (v ? expandHome(v) : path.join(home, fallback));
  switch (profile.kind) {
    case "claude":
      return [at(env.CLAUDE_CONFIG_DIR, ".claude"), path.join(home, ".claude.json")];
    case "codex":
      return [at(env.CODEX_HOME, ".codex")];
    case "gemini":
      return [path.join(home, ".gemini")];
    default:
      return [];
  }
}

export interface ContainerRun {
  profile: AgentProfile;
  /** The CLI's arguments and stdin as buildCommand made them. */
  args: string[];
  stdin: string | null;
  runId: string;
  worktree: string;
  /** The repo's shared .git directory (git rev-parse --git-common-dir). */
  gitDir: string;
  /** What the agent gets: HIVE_*, the profile's env, the command's own. */
  env: Record<string, string>;
  /** More files of the machine the container reads (mounted read-only), e.g. the MCP config. */
  readOnly?: string[];
  home?: string;
  /** uid:gid to run as (files written keep the person's owner); null on Windows. */
  user?: { uid: number; gid: number } | null;
  exists?: (p: string) => boolean;
}

export interface ContainerCommand {
  /** docker's arguments. */
  args: string[];
  /** Values for the names passed with -e, set in docker's own environment. */
  env: Record<string, string>;
  /** For `docker kill` on cancel and timeout. */
  name: string;
}

/** The container's name for a run (a-z, 0-9, _ . - only). */
export const containerName = (runId: string) => `hive-${runId.replace(/[^\w.-]/g, "-")}`;

export function containerCommand(run: ContainerRun): ContainerCommand {
  const home = run.home ?? os.homedir();
  const exists = run.exists ?? existsSync;
  const user = run.user === undefined ? (typeof process.getuid === "function" ? { uid: process.getuid(), gid: process.getgid!() } : null) : run.user;
  const name = containerName(run.runId);
  // The CLI's own name inside the image: a host path in the profile means nothing there.
  const bin = run.profile.kind === "custom" ? path.basename(run.profile.bin) : run.profile.kind;
  const env: Record<string, string> = {
    ...run.env,
    HOME: home,
    // The mounted repo belongs to the person, not to the container's user as git sees it.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };
  const mounts = [...new Set([run.worktree, run.gitDir, ...loginPaths(run.profile, home), path.join(home, ".gitconfig")])].filter(
    (p, i) => i < 2 || exists(p),
  );
  const args = [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    ...(run.stdin !== null ? ["-i"] : []),
    ...(user ? ["--user", `${user.uid}:${user.gid}`] : []),
    // Home is empty and writable; only the mounts below come from the machine.
    "--tmpfs",
    `${home}:rw,exec${user ? `,uid=${user.uid},gid=${user.gid}` : ""}`,
    ...mounts.flatMap((p) => ["-v", `${p}:${p}${p.endsWith(".gitconfig") ? ":ro" : ""}`]),
    ...(run.readOnly ?? []).flatMap((p) => ["-v", `${p}:${p}:ro`]),
    "--workdir",
    run.worktree,
    ...Object.keys(env)
      .sort()
      .flatMap((k) => ["-e", k]),
    run.profile.container!.image,
    bin,
    ...run.args,
  ];
  return { args, env, name };
}
