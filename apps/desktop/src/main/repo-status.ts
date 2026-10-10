// The repos of a system on this machine, one row each (GROUP-repos-forge): where each checkout stands against its
// remote, whether the remote still answers, and a Pull that only ever fast-forwards a clean checkout. Someone's
// unfinished work, a branch that went its own way, or a checkout an agent is using is reported, never touched.
// No Electron imports.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { redactUrlCredentials, type DesktopProject, type RepoAccessStatus, type RepoPullBlock, type RepoPullResult, type RepoStatusRow } from "@xdev-hive/core";
import { isRepoRoot, withGitWorktreeLock } from "#desktop/main/git.ts";
import { parseRemoteUrl } from "#desktop/main/gitlab/remote.ts";
import { classifyGitRemoteError, gitRemoteDetail, NO_PROMPT_ENV } from "#desktop/main/repo-health.ts";

/** What `git status --porcelain=v2 --branch` says about a checkout. */
export interface StatusV2 {
  /** Null when HEAD is detached. */
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: number;
  conflicts: number;
}

export function parseStatusV2(out: string): StatusV2 {
  const s: StatusV2 = { branch: null, upstream: null, ahead: 0, behind: 0, changes: 0, conflicts: 0 };
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice(14).trim();
      s.branch = head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.upstream ")) s.upstream = line.slice(18).trim() || null;
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [s.ahead, s.behind] = [Number(m[1]), Number(m[2])];
    } else if (line.startsWith("u ")) s.conflicts++;
    // Ignored files ("! ") are not the person's work; everything else is.
    else if (/^[12?] /.test(line)) s.changes++;
  }
  return s;
}

/** Why a fast-forward would not be safe; null when it is (or when there is nothing to pull, which is no harm either). */
export function pullBlock(s: StatusV2 | null, busy: RepoStatusRow["busy"]): RepoPullBlock | null {
  if (!s) return "missing";
  if (busy) return "busy";
  if (s.conflicts) return "conflict";
  if (s.branch === null) return "detached";
  if (!s.upstream) return "noUpstream";
  if (s.changes) return "dirty";
  // Behind and ahead at once: --ff-only would refuse anyway, but saying why beats git's message.
  if (s.ahead && s.behind) return "diverged";
  return null;
}

/** A forge this machine knows: its own GitLab and GitHub, plus the public hosts by name. */
export interface KnownForge { kind: "gitlab" | "github"; url: string }

const PUBLIC: KnownForge[] = [{ kind: "github", url: "https://github.com" }, { kind: "gitlab", url: "https://gitlab.com" }];

/** Which forge a remote is on and the repo's page there. */
export function forgeOf(remote: string | null, forges: KnownForge[]): { forge: KnownForge["kind"] | null; webUrl: string | null } {
  const info = remote ? parseRemoteUrl(remote) : null;
  if (!info) return { forge: null, webUrl: null };
  for (const f of [...forges.filter((x) => x.url), ...PUBLIC]) {
    let base: URL;
    try { base = new URL(f.url); } catch { continue; }
    if (base.hostname.toLowerCase() !== info.host) continue;
    // An HTTPS remote carries a self-hosted GitLab's /gitlab prefix in its path already; an SSH one does not.
    const web = info.https ? `${base.protocol}//${base.host}/${info.path}` : `${f.url.replace(/\/+$/, "")}/${info.path}`;
    return { forge: f.kind, webUrl: web };
  }
  return { forge: null, webUrl: null };
}

/** One git command in a checkout, never asking anything; stdout, or the error with git's stderr and whether it was killed. */
export function runGit(repo: string, args: string[], env: Record<string, string> = {}, timeoutMs = 60_000): Promise<string> {
  return withGitWorktreeLock(repo, () => new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...env, ...NO_PROMPT_ENV }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      const killed = (err as { killed?: boolean }).killed === true || (err as { signal?: string | null }).signal != null;
      reject(Object.assign(err, { stderr: String(stderr || err.message), timedOut: killed }));
    });
  }));
}

export async function readStatus(repo: string): Promise<StatusV2 | null> {
  if (!existsSync(repo) || !isRepoRoot(repo)) return null;
  try {
    return parseStatusV2(await runGit(repo, ["status", "--porcelain=v2", "--branch"]));
  } catch {
    return null;
  }
}

/** The remote the branch pulls from, else the project's own. */
async function remoteName(repo: string, s: StatusV2 | null, fallback: string): Promise<string> {
  if (!s?.branch) return fallback;
  return (await runGit(repo, ["config", "--get", `branch.${s.branch}.remote`]).catch(() => "")).trim() || fallback;
}

export interface FetchMark { at: string; access: RepoAccessStatus; detail: string | null }

export interface RepoDeps {
  forges(): KnownForge[];
  /** Env for a git network command to `url`: the forge token as a header when it is that forge's host (forgeEnv). */
  env(url: string): Record<string, string>;
  busy(project: string): RepoStatusRow["busy"];
  /** The last ls-remote of the 6-hourly repo check, when there is one. */
  health(project: string): { access: RepoAccessStatus; detail: string | null } | null;
  /** This screen's own fetches, which say more recently whether the remote answers. */
  fetched: Map<string, FetchMark>;
  now(): Date;
  /** A forge token worked for this remote: for the "last used" line of the connection card. */
  used?(url: string, by: "fetch" | "pull"): void;
}

const projectRemote = (p: DesktopProject) => p.git?.remote ?? "origin";

export async function statusRow(p: DesktopProject, deps: RepoDeps): Promise<RepoStatusRow> {
  const s = await readStatus(p.repo);
  const remoteUrl = s ? (await runGit(p.repo, ["remote", "get-url", await remoteName(p.repo, s, projectRemote(p))]).catch(() => "")).trim() || null : null;
  const busy = deps.busy(p.name);
  const mark = deps.fetched.get(p.name);
  const health = mark ? null : deps.health(p.name);
  return {
    project: p.name,
    repo: p.repo,
    exists: s !== null,
    branch: s?.branch ?? null,
    upstream: s?.upstream ?? null,
    ahead: s?.ahead ?? 0,
    behind: s?.behind ?? 0,
    changes: s?.changes ?? 0,
    conflicts: s?.conflicts ?? 0,
    remote: remoteUrl ? redactUrlCredentials(remoteUrl) : null,
    ...forgeOf(remoteUrl, deps.forges()),
    access: mark?.access ?? health?.access ?? "unchecked",
    accessDetail: mark?.detail ?? health?.detail ?? null,
    fetchedAt: mark?.at ?? null,
    busy,
    block: pullBlock(s, busy),
  };
}

/** `git fetch` of the branch's remote, remembered as this repo's access; a failure is a row's state, not an error. */
export async function fetchRepo(p: DesktopProject, deps: RepoDeps): Promise<void> {
  const s = await readStatus(p.repo);
  if (!s) return;
  const remote = await remoteName(p.repo, s, projectRemote(p));
  const url = (await runGit(p.repo, ["remote", "get-url", remote]).catch(() => "")).trim();
  const at = deps.now().toISOString();
  if (!url) return void deps.fetched.set(p.name, { at, access: "not_found", detail: null });
  try {
    await runGit(p.repo, ["fetch", "--quiet", "--prune", remote], deps.env(url), 120_000);
    deps.fetched.set(p.name, { at, access: "ok", detail: null });
    deps.used?.(url, "fetch");
  } catch (err) {
    const e = err as { stderr?: string; timedOut?: boolean };
    deps.fetched.set(p.name, { at, access: classifyGitRemoteError(e.stderr ?? "", e.timedOut), detail: gitRemoteDetail(e.stderr ?? "") });
  }
}

/** Fast-forwards one checkout when nothing of anyone's is in the way; checked again right before, not from the page's copy. */
export async function pullRepo(p: DesktopProject, deps: RepoDeps): Promise<RepoPullResult> {
  const before = await statusRow(p, deps);
  if (before.block) return { project: p.name, outcome: "skipped", reason: before.block, error: null, row: before };
  const url = (await runGit(p.repo, ["remote", "get-url", await remoteName(p.repo, await readStatus(p.repo), projectRemote(p))]).catch(() => "")).trim();
  const head = (await runGit(p.repo, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  try {
    await runGit(p.repo, ["pull", "--ff-only", "--quiet"], url ? deps.env(url) : {}, 5 * 60_000);
  } catch (err) {
    const e = err as { stderr?: string; timedOut?: boolean };
    deps.fetched.set(p.name, { at: deps.now().toISOString(), access: classifyGitRemoteError(e.stderr ?? "", e.timedOut), detail: gitRemoteDetail(e.stderr ?? "") });
    // A refused fast-forward is the remote's branch having moved on past ours: the next screen says diverged.
    return { project: p.name, outcome: "failed", reason: null, error: gitRemoteDetail(e.stderr ?? "") ?? "git pull failed", row: await statusRow(p, deps) };
  }
  deps.fetched.set(p.name, { at: deps.now().toISOString(), access: "ok", detail: null });
  if (url) deps.used?.(url, "pull");
  const after = (await runGit(p.repo, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  return { project: p.name, outcome: after && after !== head ? "pulled" : "upToDate", reason: null, error: null, row: await statusRow(p, deps) };
}
