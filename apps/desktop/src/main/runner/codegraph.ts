// A run's worktree is a fresh checkout and git ignores .codegraph/, so it starts without an index. codegraph's MCP
// server then has no project and only tells the agent to read files itself: the runner builds the index first.
import { existsSync } from "node:fs";
import path from "node:path";
import { CODEGRAPH_MCP, CODEGRAPH_PACKAGE } from "#desktop/main/installer.ts";
import { defaultRun, type Run } from "#desktop/main/setup.ts";

/** Enough for a big repo's first index (this repo takes about 3 s); past it the run goes on without one, as before. */
const TIMEOUT_MS = 5 * 60_000;

/**
 * Builds the worktree's index (`codegraph init`), or brings a reused worktree's up to date (`codegraph sync` re-reads
 * only files whose content changed: a fix run, a review, a branch moved on). Never throws, since an agent without the
 * index still works, only with more reading. Returns the line for the run's log.
 */
export async function prepareCodegraph(
  worktree: string,
  npx: string | null,
  env: NodeJS.ProcessEnv,
  run: Run = defaultRun,
  now: () => number = Date.now,
): Promise<string> {
  if (!npx) return "# codegraph: npx not found, no index for this run";
  const step = existsSync(path.join(worktree, ".codegraph", "codegraph.db")) ? "sync" : "init";
  const started = now();
  const r = await run(npx, ["-y", CODEGRAPH_PACKAGE, step, worktree], {
    cwd: worktree,
    // npm's update notice would otherwise be the last line of a failure.
    env: { ...env, ...CODEGRAPH_MCP.env, npm_config_update_notifier: "false" },
    timeoutMs: TIMEOUT_MS,
  });
  const took = `${((now() - started) / 1000).toFixed(1)} s`;
  if (r.ok) return `# codegraph: ${step} ${took}`;
  const last = r.output.trim().split("\n").at(-1)?.trim() ?? "";
  return `# codegraph: ${step} failed after ${took}, no index for this run${last ? `: ${last.slice(0, 200)}` : ""}`;
}
