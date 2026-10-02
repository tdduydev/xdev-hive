// Spec Kit features to the hub (roadmap 20b): specs/<NNN-name>/{spec,plan,tasks}.md on the project's target branch,
// and on the branches agents write new ones on (ai/<task>, and NNN-name, the branch Spec Kit makes for a feature).
// Reads git only, never the checkout, like mirror.ts: what someone has not committed is not shown.
import { createHash } from "node:crypto";
import { SPEC_DIR, SPEC_FEATURES_MAX, SPEC_FILE_MAX, SPEC_FILES, type Actor, type DesktopProject, type HiveBackend, type SpecFiles } from "@xdev-hive/core";
import { git, isGitRepo } from "./git.ts";
import { remoteStart } from "./runner/worktree.ts";

export interface PushedSpec {
  dir: string;
  branch: string;
  commit: string;
  files: SpecFiles;
}

/** A branch is work in progress when an agent's run or Spec Kit made it. */
const WORK_BRANCH = /^(ai\/|\d{3}-)/;
/** Branches nobody committed to for this long are left behind, not shown as features being written. */
const STALE_DAYS = 30;
const CUT = "\n…(cắt bớt)";

const tryGit = (repo: string, args: string[]): string | null => {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
};

const fit = (text: string | null) => (text !== null && text.length > SPEC_FILE_MAX ? text.slice(0, SPEC_FILE_MAX - CUT.length) + CUT : text);

/** The features of one ref; `branch` is what they are labelled with ("" for the target branch). */
export function readSpecs(repo: string, ref: string, branch = ""): PushedSpec[] {
  // The tree form lists only what is in specs/, with each entry's type: folders are features, files are not.
  const tree = tryGit(repo, ["ls-tree", `${ref}:specs`]);
  if (!tree) return [];
  const commit = git(repo, ["rev-parse", "--short", `${ref}^{commit}`]);
  const out: PushedSpec[] = [];
  for (const line of tree.split("\n")) {
    const m = /^\d+ tree [0-9a-f]+\t(.+)$/.exec(line);
    if (!m || !SPEC_DIR.test(m[1]!)) continue;
    const dir = m[1]!;
    const files = Object.fromEntries(SPEC_FILES.map((f) => [f, fit(tryGit(repo, ["show", `${ref}:specs/${dir}/${f}.md`]))])) as unknown as SpecFiles;
    if (SPEC_FILES.every((f) => files[f] === null)) continue;
    out.push({ dir, branch, commit, files });
  }
  return out;
}

const sameFiles = (a: SpecFiles, b: SpecFiles) => SPEC_FILES.every((f) => a[f] === b[f]);

/**
 * The target branch's features (fetched from the remote; HEAD when there is none), then those that differ on a branch
 * being worked on: a folder the target does not have, or one of its three files changed.
 */
export async function collectSpecs(repo: string, targetBranch?: string, now = Date.now()): Promise<PushedSpec[]> {
  const ref = (await remoteStart(repo, targetBranch)).ref ?? "HEAD";
  const target = readSpecs(repo, ref);
  const byDir = new Map(target.map((f) => [f.dir, f]));
  const out = [...target];
  const branches = (tryGit(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]) ?? "").split("\n").filter((b) => WORK_BRANCH.test(b) && b !== targetBranch);
  for (const branch of branches.sort()) {
    const at = Number(tryGit(repo, ["log", "-1", "--format=%ct", `refs/heads/${branch}`]));
    if (!at || at * 1000 < now - STALE_DAYS * 86_400_000) continue;
    for (const f of readSpecs(repo, `refs/heads/${branch}`, branch)) {
      const base = byDir.get(f.dir);
      if (!base || !sameFiles(base.files, f.files)) out.push(f);
    }
  }
  return out.slice(0, SPEC_FEATURES_MAX);
}

/**
 * Sends the project's features when they differ from `last` (the hash this returned the time before). Returns the hash
 * of what the hub now has from this machine; `last` again when nothing was sent, null when the repo is not git.
 */
export async function pushSpecs(backend: HiveBackend, actor: Actor, project: DesktopProject, last?: string | null): Promise<string | null> {
  if (!isGitRepo(project.repo)) return last ?? null;
  const features = await collectSpecs(project.repo, project.targetBranch);
  const hash = createHash("sha256").update(JSON.stringify(features)).digest("hex");
  if (hash === last) return last;
  await backend.call("specs.push", { project: project.name, features }, actor);
  return hash;
}
