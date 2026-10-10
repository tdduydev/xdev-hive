// Setting a system's group up on this machine (GROUP-init-sync). The hub keeps the group behind a system and where each
// member is cloned from (SystemSource); this machine clones what it lacks into one root folder, in the group's tree
// (customer-ai/his/backend/svc-core), reuses a clone that is already there, and registers each repo under the
// system's own project key. A periodic sync then compares the source with the forge: a repo added to the group joins the
// system, one archived or gone is marked, and machines that set the group up clone the newcomers. Nothing is deleted.
import { existsSync } from "node:fs";
import path from "node:path";
import {
  isSafeCloneUrl,
  memberPath,
  suggestProjectKey,
  systemFolders,
  systemSourceSchema,
  type DesktopProject,
  type GitLabGroupRepo,
  type GitLabImportResult,
  type HiveSystem,
  type SystemInitItem,
  type SystemSource,
  type SystemSourceMember,
} from "@xdev-hive/core";
import { importRepos, matchesRemote, type ImportDeps, type LocalClone } from "#desktop/main/gitlab/import.ts";
import { parseRemoteUrl } from "#desktop/main/gitlab/remote.ts";


const resolved = (p: string) => path.resolve(p);
const sameDir = (a: string, b: string) =>
  process.platform === "win32" || process.platform === "darwin" ? resolved(a).toLowerCase() === resolved(b).toLowerCase() : resolved(a) === resolved(b);
const lastSegment = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? "";

/** Where the group's tree puts a member under `root`; null if its path would leave the root. */
export function memberDir(root: string, source: SystemSource, member: SystemSourceMember): string | null {
  const rel = memberPath(source.groupPath, member.pathWithNamespace);
  const dir = path.resolve(root, ...rel.split("/"));
  return dir.startsWith(path.resolve(root) + path.sep) ? dir : null;
}

/**
 * Where the group's root most likely is on this machine: the folder its members' clones sit under, by their place in
 * the tree (D:/src/customer-ai when svc-core is at D:/src/customer-ai/his/backend/svc-core), the one most of
 * them agree on. null when none of them is here in the tree's layout.
 */
export function suggestRoot(system: HiveSystem, projects: DesktopProject[]): string | null {
  const votes = new Map<string, number>();
  for (const m of system.source?.members ?? []) {
    const local = projects.find((p) => p.name === m.project);
    if (!local) continue;
    const rel = memberPath(system.source!.groupPath, m.pathWithNamespace).split("/");
    const parts = path.resolve(local.repo).split(path.sep);
    const tail = parts.slice(-rel.length).map((s) => s.toLowerCase());
    if (tail.join("/") !== rel.map((s) => s.toLowerCase()).join("/")) continue;
    const root = parts.slice(0, -rel.length).join(path.sep) || path.sep;
    votes.set(root, (votes.get(root) ?? 0) + 1);
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

/**
 * What setting the system up under `root` would do, member by member in the group's tree order. A clone is reused when
 * it sits where the tree puts it, or elsewhere under its own repo name; another copy of the same remote under another
 * name (svc-core-e2e) is someone's second working copy, not the service, and is left alone.
 */
export function planSystemInit(system: HiveSystem, root: string, projects: DesktopProject[], local: LocalClone[]): SystemInitItem[] {
  const owners = new Map(projects.map((p) => [resolved(p.repo).toLowerCase(), p.name]));
  const ownerOf = (dir: string) => owners.get(resolved(dir).toLowerCase()) ?? null;
  const order = systemFolders(system).flatMap((f) => f.projects);
  return order.map((project): SystemInitItem => {
    const member = system.source?.members.find((m) => m.project === project) ?? null;
    const existing = projects.find((p) => p.name === project);
    if (existing) return { project, pathWithNamespace: member?.pathWithNamespace ?? null, dir: existing.repo, state: "added", owner: null };
    if (!member || !system.source) return { project, pathWithNamespace: null, dir: null, state: "unknown", owner: null };
    if (member.state !== "active") return { project, pathWithNamespace: member.pathWithNamespace, dir: null, state: "gone", owner: null };
    const dir = memberDir(root, system.source, member);
    if (!dir) return { project, pathWithNamespace: member.pathWithNamespace, dir: null, state: "unknown", owner: null };
    const base = { project, pathWithNamespace: member.pathWithNamespace };
    const matching = local.filter((c) => matchesRemote(c.remote, member));
    const atTree = matching.find((c) => sameDir(c.dir, dir));
    if (atTree) {
      const owner = ownerOf(atTree.dir);
      return owner ? { ...base, dir, state: "conflict", owner } : { ...base, dir, state: "folder", owner: null };
    }
    const name = lastSegment(member.pathWithNamespace);
    const elsewhere = matching.find((c) => !ownerOf(c.dir) && lastSegment(c.dir) === name);
    if (elsewhere) return { ...base, dir: elsewhere.dir, state: "folder", owner: null };
    if (existsSync(dir)) return { ...base, dir, state: "conflict", owner: ownerOf(dir) };
    return { ...base, dir, state: "new", owner: null };
  });
}

/**
 * The clone URL has to name the member's own repository: the hub stores what a person sent, and this machine clones it
 * with its forge token. A self-hosted GitLab may serve under a prefix (/gitlab/group/repo).
 */
export function urlNamesMember(url: string, member: Pick<SystemSourceMember, "pathWithNamespace">): boolean {
  if (!isSafeCloneUrl(url)) return false;
  const remote = parseRemoteUrl(url);
  const want = member.pathWithNamespace.toLowerCase();
  const got = remote?.path.toLowerCase() ?? "";
  return got === want || got.endsWith(`/${want}`);
}

export type InitDeps = Pick<ImportDeps, "clone" | "remote"> & {
  projects(): DesktopProject[];
  add(project: DesktopProject): void;
};

/**
 * Clones and registers what the plan offers (folder and new), one after another: a repo that fails is reported on its
 * own. `only` narrows it to some projects (the periodic sync clones only the members that are new to this machine).
 */
export async function initSystem(system: HiveSystem, root: string, protocol: "ssh" | "https", local: LocalClone[], deps: InitDeps, only?: string[]): Promise<GitLabImportResult[]> {
  const source = system.source;
  if (!source) return [];
  const plan = planSystemInit(system, root, deps.projects(), local).filter((i) => (i.state === "new" || i.state === "folder") && (!only || only.includes(i.project)));
  const field = source.forge === "github" ? "githubRepo" : "gitlabProject";
  const refused: GitLabImportResult[] = [];
  const items = plan.flatMap((i) => {
    const member = source.members.find((m) => m.project === i.project)!;
    const url = protocol === "https" ? member.httpUrl : member.sshUrl;
    if (!urlNamesMember(url, member)) {
      refused.push({ key: i.project, pathWithNamespace: member.pathWithNamespace, ok: false, cloned: false, error: `${url} is not ${member.pathWithNamespace}.` });
      return [];
    }
    return [{ key: i.project, pathWithNamespace: member.pathWithNamespace, dir: i.dir!, url, sshUrl: member.sshUrl, httpUrl: member.httpUrl, targetBranch: member.defaultBranch }];
  });
  const results = await importRepos(items, {
    check: (key) => {
      if (deps.projects().some((p) => p.name === key)) throw new Error(`${key} is already a project here.`);
    },
    clone: deps.clone,
    remote: deps.remote,
    add: deps.add,
    field,
  });
  return [...refused, ...results];
}

export interface SourceDiff {
  source: SystemSource;
  projects: string[];
  /** Repos new to the group, with the project key each got. */
  added: string[];
  /** Members that left the group or were archived since the last sync. */
  gone: string[];
  /** Members that were gone and are listed again. */
  back: string[];
  /** Anything to save beyond syncedAt. */
  changed: boolean;
}

/**
 * The source after looking at the forge. A repo the group lists for the first time becomes a member and a project of
 * the system under a key no other project has; a member taken out of the system by a person stays out. A member the
 * group no longer lists is `archived` when the forge says so, else `gone`; `archived(path)` answers per missing member.
 */
export function diffSource(
  system: Pick<HiveSystem, "projects">,
  source: SystemSource,
  repos: GitLabGroupRepo[],
  archived: ReadonlySet<string>,
  taken: Iterable<string>,
  now: string,
): SourceDiff {
  const used = new Set([...taken, ...system.projects, ...source.members.map((m) => m.project)]);
  const listed = new Map(repos.map((r) => [r.pathWithNamespace.toLowerCase(), r]));
  const known = new Set(source.members.map((m) => m.pathWithNamespace.toLowerCase()));
  const projects = new Set(system.projects);
  const out: SourceDiff = { source, projects: [], added: [], gone: [], back: [], changed: false };
  const members = source.members.map((m): SystemSourceMember => {
    const repo = listed.get(m.pathWithNamespace.toLowerCase());
    if (!repo) {
      const state = archived.has(m.pathWithNamespace.toLowerCase()) ? "archived" : "gone";
      if (m.state !== state) {
        out.changed = true;
        if (m.state === "active") out.gone.push(m.project);
      }
      return { ...m, state };
    }
    if (m.state !== "active") out.back.push(m.project);
    const next = { ...m, pathWithNamespace: repo.pathWithNamespace, sshUrl: repo.sshUrl, httpUrl: repo.httpUrl, defaultBranch: repo.defaultBranch, state: "active" as const };
    if (JSON.stringify(next) !== JSON.stringify(m)) out.changed = true;
    return next;
  });
  for (const repo of [...repos].sort((a, b) => a.pathWithNamespace.localeCompare(b.pathWithNamespace))) {
    if (known.has(repo.pathWithNamespace.toLowerCase())) continue;
    const key = suggestProjectKey(repo.pathWithNamespace, used);
    used.add(key);
    members.push({ project: key, pathWithNamespace: repo.pathWithNamespace, sshUrl: repo.sshUrl, httpUrl: repo.httpUrl, defaultBranch: repo.defaultBranch, state: "active" });
    projects.add(key);
    out.added.push(key);
    out.changed = true;
  }
  // The forge's URLs are checked like the hub checks them, so one odd repo cannot make the whole save fail.
  const parsed = systemSourceSchema.safeParse({ ...source, members, syncedAt: now });
  out.source = parsed.success ? parsed.data : { ...source, syncedAt: now };
  out.projects = [...projects].sort();
  return out;
}

/**
 * Links a system put together by hand (or before sources existed) to its group: each project is matched to a repo by
 * the path this machine's config has for it, then by its clone's remote, then by its name. The repos of the group that
 * match none come in as new members, which the person sees before saving.
 */
export function linkSource(
  system: Pick<HiveSystem, "projects">,
  forge: SystemSource["forge"],
  url: string,
  groupPath: string,
  repos: GitLabGroupRepo[],
  projects: DesktopProject[],
  remoteOf: (dir: string) => string | null,
  taken: Iterable<string>,
  now: string,
): { source: SystemSource; projects: string[]; matched: string[]; added: string[]; unmatched: string[] } {
  const field = forge === "github" ? "githubRepo" : "gitlabProject";
  const byPath = new Map(repos.map((r) => [r.pathWithNamespace.toLowerCase(), r]));
  const claimed = new Set<string>();
  const members: SystemSourceMember[] = [];
  const unmatched: string[] = [];
  const take = (project: string, repo: GitLabGroupRepo | undefined) => {
    if (!repo || claimed.has(repo.pathWithNamespace.toLowerCase())) return false;
    claimed.add(repo.pathWithNamespace.toLowerCase());
    members.push({ project, pathWithNamespace: repo.pathWithNamespace, sshUrl: repo.sshUrl, httpUrl: repo.httpUrl, defaultBranch: repo.defaultBranch, state: "active" });
    return true;
  };
  for (const project of [...system.projects].sort()) {
    const local = projects.find((p) => p.name === project);
    const remote = local && existsSync(local.repo) ? remoteOf(local.repo) : null;
    const done =
      take(project, local?.[field] ? byPath.get(local[field]!.toLowerCase()) : undefined) ||
      take(project, repos.find((r) => remote && matchesRemote(remote, r))) ||
      take(project, repos.find((r) => lastSegment(r.pathWithNamespace) === project && !claimed.has(r.pathWithNamespace.toLowerCase())));
    if (!done) unmatched.push(project);
  }
  const base: SystemSource = { forge, url, groupPath, members, syncedAt: null };
  const diff = diffSource(system, base, repos, new Set(), taken, now);
  return { source: diff.source, projects: diff.projects, matched: members.map((m) => m.project), added: diff.added, unmatched };
}
