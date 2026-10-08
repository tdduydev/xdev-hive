// A Node unpacked next to the Linux app (~/hive-runtime/node-v24…/) was npm's global prefix there, so every CLI the
// person or Setup installed (codex, claude…) landed inside the app's folder: deleting it, or moving to the .deb, took
// the CLIs too and the plans said "CLI not installed". Node and its global CLIs now live in ~/.xdev-hive/tools.
import { existsSync, readdirSync, statSync } from "node:fs";
import { cp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { compareVersions, type AgentProfile } from "@xdev-hive/core";

export interface ToolMove { from: string; to: string }

export const toolsDir = (home: string) => path.join(home, ".xdev-hive", "tools");

/** Where a Node next to the app may sit: the running AppImage layout's root, and the usual ~/hive-runtime (gone from the layout after moving to the .deb, but its CLIs are still there to keep). */
export function runtimeRoots(home: string, layoutRoot: string | null): string[] {
  return [...new Set([layoutRoot, path.join(home, "hive-runtime")].filter((r): r is string => !!r))];
}

const nodeDirs = (root: string) => {
  try {
    return readdirSync(root).filter((n) => /^node-v?\d/.test(n) && existsSync(path.join(root, n, "bin", "node")));
  } catch {
    return [];
  }
};

const versionOf = (name: string) => /^node-v?(\d+(?:\.\d+)*)/.exec(name)?.[1] ?? "0";

/**
 * Copies each Node found in the runtime roots (with its global CLIs: npm's bin links are relative, kept as they are)
 * into the tools folder, once. The old folder stays: the person's shell may still use it. Async: Node with a few CLIs
 * is hundreds of MB.
 */
export async function migrateRuntimeNode(roots: string[], home: string): Promise<ToolMove[]> {
  const moves: ToolMove[] = [];
  for (const root of roots) {
    for (const name of nodeDirs(root)) {
      const from = path.join(root, name);
      const to = path.join(toolsDir(home), name);
      moves.push({ from, to });
      if (existsSync(to)) continue;
      // Copied beside it and renamed in one step: a copy cut short (app quit) is never taken for a whole Node.
      const stage = `${to}.partial-${process.pid}`;
      await rm(stage, { recursive: true, force: true });
      await cp(from, stage, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      await rename(stage, to);
    }
  }
  return moves;
}

/** bin folders of the Nodes in the tools folder, newest first: put before the login shell's PATH so they win. */
export function toolBinDirs(home: string): string[] {
  return nodeDirs(toolsDir(home))
    .sort((a, b) => compareVersions(versionOf(b), versionOf(a)))
    .map((n) => path.join(toolsDir(home), n, "bin"))
    .filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
}

/** `value` with a moved folder's path replaced, in the form it was written (absolute or ~/…). */
function moved(value: string, moves: ToolMove[], home: string): string {
  for (const { from, to } of moves) {
    for (const [a, b] of [[from, to], [tilde(from, home), tilde(to, home)]] as const) {
      if (!a) continue;
      if (value === a || value.startsWith(`${a}/`)) return b + value.slice(a.length);
      // A PATH-like value: each entry on its own.
      if (value.includes(":") && value.split(":").some((p) => p === a || p.startsWith(`${a}/`))) {
        return value.split(":").map((p) => (p === a || p.startsWith(`${a}/`) ? b + p.slice(a.length) : p)).join(":");
      }
    }
  }
  return value;
}

const tilde = (p: string, home: string) => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : "");

/** Profiles whose CLI (bin, or a path in env) points into a moved Node, pointed at the copy. null: none changed. */
export function migrateProfiles(profiles: AgentProfile[], moves: ToolMove[], home: string): AgentProfile[] | null {
  if (!moves.length) return null;
  let changed = false;
  const next = profiles.map((p) => {
    const bin = moved(p.bin, moves, home);
    const env = Object.fromEntries(Object.entries(p.env ?? {}).map(([k, v]) => [k, moved(v, moves, home)]));
    if (bin === p.bin && Object.entries(env).every(([k, v]) => v === p.env?.[k])) return p;
    changed = true;
    return { ...p, bin, env };
  });
  return changed ? next : null;
}

/** npm's global prefix is inside one of the runtime roots: a CLI installed there goes away with the app. */
export function insideRuntime(prefix: string, roots: string[]): boolean {
  return roots.some((r) => prefix === r || prefix.startsWith(`${r}${path.sep}`));
}
