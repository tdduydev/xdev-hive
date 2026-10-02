// A run's worktree is a fresh checkout and git ignores .codegraph/, so it starts without an index. codegraph's MCP
// server then has no project and only tells the agent to read files itself: the runner builds the index first. Since
// roadmap 28b any catalog tool with a prepare step goes through prepareTool; this is the app's own codegraph entry.
import { defaultRun, type Run } from "#desktop/main/setup.ts";
import { APP_TOOLS, prepareTool } from "./tools.ts";

/** `codegraph init` in a fresh worktree, `codegraph sync` in a reused one; never throws. Returns the run log's line. */
export function prepareCodegraph(worktree: string, npx: string | null, env: NodeJS.ProcessEnv, run: Run = defaultRun, now: () => number = Date.now): Promise<string> {
  return prepareTool(APP_TOOLS.codegraph, worktree, {}, () => npx, env, run, now);
}
