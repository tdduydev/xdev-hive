// A hub admin adds or drops a project in a machine's app config from the web (ADM-machine-projects). Before this, the
// only way was to quit the app, hand-edit ~/.xdev-hive/config.json and start it again, because the app keeps the config
// in memory and writes it back over any edit. The order reaches the machine over the network, so both ends check every
// field: the hub so nothing odd is stored or shown, the app because it must never trust what it is sent.
import { z } from "zod";
import { PROJECT_NAME } from "./keys.ts";
import type { ProjectState } from "./types.ts";

/** How long a command waits for its machine; after that the web shows it expired and the machine no longer gets it. */
export const PROJECT_COMMAND_TTL_MS = 24 * 60 * 60_000;

/**
 * An absolute path of any OS (the hub cannot know the machine's), with no `.`/`..` segment that could step out of
 * the folder the admin named, and no UNC share: a network folder is not where an app keeps its repositories.
 */
export function isSafeRepoPath(p: string): boolean {
  if (!p || p.length > 1000 || /[\0\r\n]/.test(p)) return false;
  if (p.startsWith("//") || p.startsWith("\\\\")) return false;
  if (!p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p)) return false;
  return !p.split(/[\\/]/).some((s) => s === ".." || s === ".");
}

/**
 * https or ssh only: git's other transports (ext::, file://, fd::) can run commands or read the machine's disk. No
 * user info on https and no password on ssh: a token in the URL would be stored on the hub, shown on the web and
 * written to logs. A leading dash would turn the URL into a git option.
 */
export function isSafeCloneUrl(u: string): boolean {
  if (!u || u.length > 500 || /[\s\0]/.test(u) || u.startsWith("-")) return false;
  if (/^[\w.-]+@[\w.-]+:(?!\/)[\w.~/-]+$/.test(u)) return !u.split(":")[1]!.split("/").includes("..");
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.search || url.hash || url.password) return false;
  if (url.protocol === "https:") return !url.username && url.pathname.length > 1;
  return url.protocol === "ssh:" && url.pathname.length > 1;
}

/** A GitLab path like group/sub/project: what the app sets so its merge requests go to the right repository. */
export const GITLAB_PROJECT = /^[\w.-]+(\/[\w.-]+)+$/;
const isGitlabProject = (v: string) => v.length <= 300 && GITLAB_PROJECT.test(v) && !v.split("/").some((s) => s === ".." || s === ".");

const fields = {
  op: z.enum(["add", "remove"]),
  project: z.string().regex(PROJECT_NAME),
  repo: z.string().refine(isSafeRepoPath, "repo must be an absolute path without . or .. segments"),
  gitlabProject: z.string().refine(isGitlabProject, "gitlabProject must look like group/project"),
  cloneUrl: z.string().refine(isSafeCloneUrl, "cloneUrl must be https or ssh, without credentials"),
};

export const projectOrderShape = {
  op: fields.op,
  project: fields.project,
  repo: fields.repo.nullable().default(null),
  gitlabProject: fields.gitlabProject.nullable().default(null),
  cloneUrl: fields.cloneUrl.nullable().default(null),
};

export function refineProjectOrder(v: { op: "add" | "remove"; repo: string | null; gitlabProject: string | null; cloneUrl: string | null }, ctx: z.RefinementCtx): void {
  if (v.op === "add" && !v.repo) ctx.addIssue({ code: "custom", path: ["repo"], message: "add needs the folder (repo)" });
  // A remove that carried a path or URL would read as if it touched the folder; it never does.
  if (v.op === "remove" && (v.repo || v.gitlabProject || v.cloneUrl)) ctx.addIssue({ code: "custom", message: "remove takes only the project" });
}

/** The order itself, as the hub stores it and the app re-checks it: an add names a folder, a remove only the key. */
export const projectOrderSchema = z.object(projectOrderShape).superRefine(refineProjectOrder);
export type ProjectOrder = z.output<typeof projectOrderSchema>;

/** One project of a machine's config as its app reported it (heartbeat `repos`). */
export const machineRepoSchema = z.object({ project: fields.project, path: z.string().min(1).max(2000) });
export type MachineRepo = z.output<typeof machineRepoSchema>;

export interface MachineProjectCommand extends ProjectOrder {
  id: string;
  requestedBy: string;
  requestedAt: string;
  completedAt: string | null;
  /** null until the machine answers. */
  ok: boolean | null;
  error: string | null;
}

export interface MachineProjects {
  machineId: string;
  machine: string;
  /** false: the app is older than these commands (it never reported its repos). */
  supported: boolean;
  /** state: what the hub did to the project (archived/deleted), null while it is in use. */
  repos: Array<MachineRepo & { state: ProjectState | null }>;
  commands: MachineProjectCommand[];
}

export type ProjectCommandStatus = "pending" | "expired" | "ok" | "failed";

export function projectCommandStatus(c: Pick<MachineProjectCommand, "completedAt" | "ok" | "requestedAt">, now = Date.now()): ProjectCommandStatus {
  if (c.completedAt) return c.ok ? "ok" : "failed";
  return now - Date.parse(c.requestedAt) >= PROJECT_COMMAND_TTL_MS ? "expired" : "pending";
}
