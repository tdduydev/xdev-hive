import { execFileSync } from "node:child_process";

export function releaseScope(paths, forceApp = false) {
  const files = [...paths].map(file => file.replaceAll("\\", "/"));
  // The desktop embeds UI, MCP and core runtime; changes there require new binaries.
  const appFiles = files.filter(file => /^(apps\/desktop\/|packages\/(ui|mcp)\/|packages\/core\/src\/|package(-lock)?\.json$|tsconfig\.base\.json$)/.test(file));
  return { app: forceApp || appFiles.length > 0, appFiles, files };
}

export function changedSinceAppRelease(repoRoot, head = "HEAD") {
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  const previous = git("tag", "--merged", head, "--list", "v*", "--sort=-v:refname").split("\n").find(Boolean);
  // No baseline means that skipping a binary release cannot be justified.
  if (!previous) return { baseline: null, ...releaseScope([], true) };
  const changed = execFileSync("git", ["diff", "--name-only", "-z", `${previous}..${head}`], { cwd: repoRoot, encoding: "utf8" });
  return { baseline: previous, ...releaseScope(changed.split("\0").filter(Boolean)) };
}
