// A hub admin's order to add or drop a project in this app's config (ADM-machine-projects). It arrives over the network,
// so every field is checked again here against this machine's own rules before anything is cloned or saved, and a
// remove only ever takes the project out of the config: the folder and its work stay on disk.
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { isSafeRepoPath, projectOrderSchema, type DesktopProject, type MachineProjectCommand } from "@xdev-hive/core";
import { parseRemoteUrl } from "#desktop/main/gitlab/remote.ts";

export interface ProjectCommandDeps {
  projects(): DesktopProject[];
  /** Saves the project to the config (persist); throws when the key is taken or the folder is no repository. */
  add(project: DesktopProject): void;
  /** Drops the project from the config (persist), never its folder. */
  remove(name: string): void;
  /** Whether `dir` is the top of a git work tree. */
  isRepo(dir: string): boolean;
  /** origin of the repository at `dir`, null without one. */
  remote(dir: string): string | null;
  /** Clones `url` into the missing folder `dir`; rejects with git's last words. */
  clone(url: string, dir: string): Promise<void>;
  /** A run of the project is queued or going: dropping it now would pull the repository from under it. */
  busy(name: string): boolean;
}

export interface ProjectCommandResult { id: string; ok: boolean; error: string | null }

const samePath = (a: string, b: string) => process.platform === "win32" || process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
const remotePath = (url: string | null) => (url ? parseRemoteUrl(url) : null);

/** The repository at `dir` has to be the one the hub named, by GitLab path and by clone URL when given. */
function checkRemote(dir: string, remote: string | null, gitlabProject: string | null, cloneUrl: string | null): void {
  const actual = remotePath(remote);
  if (gitlabProject && actual?.path.toLowerCase() !== gitlabProject.toLowerCase()) {
    throw new Error(`${dir}: origin ${remote ?? "(none)"} is not ${gitlabProject}.`);
  }
  const wanted = remotePath(cloneUrl);
  if (wanted && (actual?.host !== wanted.host || actual.path.toLowerCase() !== wanted.path.toLowerCase())) {
    throw new Error(`${dir}: origin ${remote ?? "(none)"} is not ${wanted.host}/${wanted.path}.`);
  }
}

/** Throws with the reason the hub shows next to the command. */
async function apply(command: MachineProjectCommand, deps: ProjectCommandDeps): Promise<void> {
  // Parsed again with the hub's schema, then with this OS's idea of a path: the hub cannot know which OS it talks to.
  const parsed = projectOrderSchema.safeParse({ op: command.op, project: command.project, repo: command.repo, gitlabProject: command.gitlabProject, cloneUrl: command.cloneUrl });
  if (!parsed.success) throw new Error(`Refused: ${parsed.error.issues.map((i) => `${i.path.join(".") || "order"}: ${i.message}`).join("; ")}`);
  const order = parsed.data;
  const existing = deps.projects().find((p) => p.name === order.project);
  if (order.op === "remove") {
    if (!existing) return;
    if (deps.busy(order.project)) throw new Error(`${order.project} has a queued or running run; try again when it ends.`);
    deps.remove(order.project);
    return;
  }
  const repo = order.repo!;
  if (!isSafeRepoPath(repo) || !path.isAbsolute(repo) || path.resolve(repo) !== path.normalize(repo)) throw new Error(`${repo} is not an absolute path on this machine.`);
  const dir = path.resolve(repo);
  if (existing) {
    // A command answered before the hub heard of it comes again: the same project in the same folder is done already.
    if (samePath(path.resolve(existing.repo), dir)) return;
    throw new Error(`${order.project} is already in this app, at ${existing.repo}.`);
  }
  const taken = deps.projects().find((p) => samePath(path.resolve(p.repo), dir));
  if (taken) throw new Error(`${dir} is already project ${taken.name}.`);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} is a file.`);
    if (!deps.isRepo(dir)) throw new Error(`${dir} is not a git repository.`);
    checkRemote(dir, deps.remote(dir), order.gitlabProject, order.cloneUrl);
  } else {
    if (!order.cloneUrl) throw new Error(`${dir} does not exist and no clone URL was given.`);
    // Checked before cloning, so a mismatched pair never fetches a repository nobody asked for.
    const wanted = remotePath(order.cloneUrl);
    if (order.gitlabProject && wanted?.path.toLowerCase() !== order.gitlabProject.toLowerCase()) throw new Error(`${order.cloneUrl} is not ${order.gitlabProject}.`);
    mkdirSync(path.dirname(dir), { recursive: true });
    await deps.clone(order.cloneUrl, dir);
    if (!deps.isRepo(dir)) throw new Error(`${dir} is not a git repository after cloning.`);
  }
  deps.add({ name: order.project, repo: dir, ...(order.gitlabProject ? { gitlabProject: order.gitlabProject } : {}) });
}

export async function applyProjectCommand(command: MachineProjectCommand, deps: ProjectCommandDeps): Promise<ProjectCommandResult> {
  try {
    await apply(command, deps);
    return { id: command.id, ok: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: command.id, ok: false, error: message.slice(0, 1000) };
  }
}
