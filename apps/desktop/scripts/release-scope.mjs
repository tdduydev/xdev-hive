import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const desktopManifest = "apps/desktop/package.json";
const normalize = file => file.replaceAll("\\", "/");
const isAppFile = file => /^(apps\/desktop\/|packages\/(ui|mcp)\/|packages\/core\/src\/|package(-lock)?\.json$|(?:[^/]+\/)*tsconfig(?:\.[^/]+)?\.json$|packages\/[^/]+\/package\.json$)/.test(file);

function onlyVersionChanged(before, after) {
  try {
    const oldManifest = JSON.parse(before);
    const newManifest = JSON.parse(after);
    if (oldManifest.version === newManifest.version) return false;
    delete oldManifest.version;
    delete newManifest.version;
    return JSON.stringify(oldManifest) === JSON.stringify(newManifest);
  } catch { return false; }
}

export function releaseScope(paths, forceApp = false) {
  const files = [...paths].map(normalize);
  // The desktop embeds UI, MCP and core runtime; changes there require new binaries.
  const appFiles = files.filter(isAppFile);
  return { app: forceApp || appFiles.length > 0, appFiles, files };
}

export function changedSinceAppRelease(repoRoot, head = "HEAD") {
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  const previous = git("tag", "--merged", head, "--list", "v*", "--sort=-v:refname").split("\n").find(Boolean);
  // No baseline means that skipping a binary release cannot be justified.
  if (!previous) return { baseline: null, ...releaseScope([], true) };
  const changed = execFileSync("git", ["diff", "--name-only", "-z", `${previous}..${head}`], { cwd: repoRoot, encoding: "utf8" });
  const files = changed.split("\0").filter(Boolean);
  if (files.includes(desktopManifest)) {
    try { if (onlyVersionChanged(git("show", `${previous}:${desktopManifest}`), git("show", `${head}:${desktopManifest}`))) files.splice(files.indexOf(desktopManifest), 1); }
    catch { /* A newly added or removed manifest requires an app release. */ }
  }
  return { baseline: previous, ...releaseScope(files) };
}

export async function changedSinceAppReleaseAsync(repoRoot, head = "HEAD") {
  const git = async (...args) => (await exec("git", args, { cwd: repoRoot, encoding: "utf8" })).stdout.trim();
  const previous = (await git("tag", "--merged", head, "--list", "v*", "--sort=-v:refname")).split("\n").find(Boolean);
  if (!previous) return { baseline: null, ...releaseScope([], true) };
  const changed = (await exec("git", ["diff", "--name-only", "-z", `${previous}..${head}`], { cwd: repoRoot, encoding: "utf8" })).stdout;
  const files = changed.split("\0").filter(Boolean);
  if (files.includes(desktopManifest)) {
    try { if (onlyVersionChanged(await git("show", `${previous}:${desktopManifest}`), await git("show", `${head}:${desktopManifest}`))) files.splice(files.indexOf(desktopManifest), 1); }
    catch { /* A newly added or removed manifest requires an app release. */ }
  }
  return { baseline: previous, ...releaseScope(files) };
}
