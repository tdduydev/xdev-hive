// Whether each project's remote still answers this machine (ADM-member-repo-health). A repo whose access was lost, or
// that was never there, used to show up only when someone tried to clone it by hand; `git ls-remote` every few hours
// tells the hub first, and the Systems page shows it on the member.
import { execFile } from "node:child_process";
import { redactLines, redactUrlCredentials, type RepoAccessReport, type RepoAccessStatus } from "@xdev-hive/core";
import { pushEnv } from "#desktop/main/gitlab/mr.ts";
import { parseRemoteUrl } from "#desktop/main/gitlab/remote.ts";

/** Often enough to catch a revoked access the same day, rarely enough not to be noticed by the forge. */
export const REPO_HEALTH_INTERVAL_MS = 6 * 60 * 60_000;
/** A remote that answers at all answers within seconds; a hung TCP connection must not hold the check for minutes. */
export const LS_REMOTE_TIMEOUT_MS = 20_000;

/**
 * Never a question: no terminal prompt, no Git Credential Manager window (a check nobody started must not pop one up
 * at night), and SSH fails instead of asking for a passphrase or a host key.
 */
export const NO_PROMPT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
};

/** Patterns over git's stderr, first match wins; the order matters (a 403 also says "unable to access"). */
const RULES: Array<[RepoAccessStatus, RegExp]> = [
  // GitLab's answer for a private project the account may not see, and for one that does not exist: the same text on
  // purpose. GitHub's "Repository not found" and a bare HTTP 404 hide private repos the same way.
  ["no_access_or_missing", /could not be found or you don't have permission|repository not found|repository '[^']*' not found|returned error: 404/i],
  ["no_access", /authentication failed|access denied|permission denied|returned error: 40[13]|could not read (username|password)|terminal prompts disabled|invalid username or password|not authorized|forbidden|you are not allowed/i],
  ["not_found", /does not appear to be a git repository|no such remote|not a git repository/i],
  ["network", /could not resolve host|could not resolve hostname|failed to connect|connection (timed out|refused|reset)|network is unreachable|operation timed out|timed out|no route to host|temporary failure in name resolution|ssl|tls|proxy|early eof|the remote end hung up unexpectedly|could not connect/i],
];

/** What git's failure means for the person who reads it; `timedOut`: the check was killed, which is the network's doing. */
export function classifyGitRemoteError(stderr: string, timedOut = false): RepoAccessStatus {
  if (timedOut) return "network";
  for (const [status, pattern] of RULES) if (pattern.test(stderr)) return status;
  return "error";
}

/** Git's last words, safe to send: URLs without their user and password, lines that look like a secret hidden. */
export function gitRemoteDetail(stderr: string): string | null {
  const lines = redactLines(redactUrlCredentials(stderr)).split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines.slice(-2).join(" ").slice(0, 300) : null;
}

/** The commit of HEAD in `git ls-remote <remote> HEAD`'s output; null for an empty repository. */
export function headOf(stdout: string): string | null {
  return /^([0-9a-f]{40,64})\s+HEAD$/m.exec(stdout)?.[1] ?? null;
}

export interface LsRemoteResult { ok: boolean; stdout: string; stderr: string; timedOut: boolean }

export type LsRemote = (repo: string, remote: string, env: Record<string, string>, timeoutMs: number) => Promise<LsRemoteResult>;

/** `git ls-remote` without the checkout's lock: it reads only the remote, so a long push must not hold it back. */
export const gitLsRemote: LsRemote = (repo, remote, env, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["ls-remote", "--quiet", remote, "HEAD"],
      { cwd: repo, encoding: "utf8", env: { ...process.env, ...env, ...NO_PROMPT_ENV }, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const killed = !!err && ((err as { killed?: boolean }).killed === true || (err as { signal?: string | null }).signal != null);
        resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr || (err ? err.message : "")), timedOut: killed });
      },
    );
  });

export interface RepoToCheck {
  project: string;
  repo: string;
  /** The remote's name in the checkout (origin unless the app was told otherwise). */
  remote: string;
  /** Extra env for this remote: the forge token as a header when it is the forge's host (see pushEnv). */
  env?: Record<string, string>;
}

/** A forge this app has a token for: GitLab takes user oauth2, GitHub x-access-token (as for pushes). */
export interface ForgeAuth { url: string; token: string; user: string }

/**
 * The env a push to `remoteUrl` would get: the token of the forge whose host it is, so the check answers for the
 * account the app works as, not for whatever the person's credential store holds; SSH in batch mode either way.
 */
export function forgeEnv(remoteUrl: string, forges: ForgeAuth[]): Record<string, string> {
  const remote = parseRemoteUrl(remoteUrl);
  for (const forge of forges) {
    if (!forge.url || !forge.token) continue;
    let host: string;
    try { host = new URL(forge.url).hostname.toLowerCase(); } catch { continue; }
    if (remote?.host === host) return pushEnv(remoteUrl, remote, host, forge);
  }
  return pushEnv(remoteUrl, remote, "", { user: "", token: "" });
}

export async function checkRepoAccess(target: RepoToCheck, lsRemote: LsRemote = gitLsRemote, now: () => Date = () => new Date(), timeoutMs = LS_REMOTE_TIMEOUT_MS): Promise<RepoAccessReport> {
  let res: LsRemoteResult;
  try {
    res = await lsRemote(target.repo, target.remote, target.env ?? {}, timeoutMs);
  } catch (err) {
    // A missing folder or no git at all: the machine's problem, not the remote's.
    res = { ok: false, stdout: "", stderr: String((err as Error).message ?? err), timedOut: false };
  }
  const checkedAt = now().toISOString();
  if (res.ok) return { project: target.project, status: "ok", checkedAt, head: headOf(res.stdout), detail: null };
  return { project: target.project, status: classifyGitRemoteError(res.stderr, res.timedOut), checkedAt, head: null, detail: gitRemoteDetail(res.stderr) };
}

export interface RepoHealthOptions {
  targets: () => RepoToCheck[];
  check?: (target: RepoToCheck) => Promise<RepoAccessReport>;
  now?: () => Date;
  intervalMs?: number;
}

/**
 * The last check of each project, for every heartbeat to carry. `refresh()` checks again only the projects whose last
 * check is older than the interval (or never ran), so the 10-minute setup tick costs nothing most of the time;
 * `refresh(true)` is the person's "Kiểm tra lại" and checks every one now.
 */
export class RepoHealthMonitor {
  #results = new Map<string, RepoAccessReport>();
  #running: Promise<void> | null = null;
  readonly #opts: Required<RepoHealthOptions>;

  constructor(opts: RepoHealthOptions) {
    this.#opts = { check: (t) => checkRepoAccess(t), now: () => new Date(), intervalMs: REPO_HEALTH_INTERVAL_MS, ...opts };
  }

  /** Only projects the app still has: a removed one stops being reported at once. */
  latest(): RepoAccessReport[] {
    const names = new Set(this.#opts.targets().map((t) => t.project));
    return [...this.#results.values()].filter((r) => names.has(r.project));
  }

  refresh(force = false): Promise<void> {
    // One sweep at a time: a forced one that arrives during a timer one waits for it, then rechecks.
    const run = (this.#running ?? Promise.resolve()).then(() => this.#sweep(force));
    const tracked = run.finally(() => { if (this.#running === tracked) this.#running = null; });
    this.#running = tracked;
    return tracked;
  }

  async #sweep(force: boolean): Promise<void> {
    const due = +this.#opts.now() - this.#opts.intervalMs;
    // One after another: a dozen parallel ls-remote calls to one GitLab look like a scan and may get rate limited.
    for (const target of this.#opts.targets()) {
      const last = this.#results.get(target.project);
      if (!force && last && Date.parse(last.checkedAt) > due) continue;
      this.#results.set(target.project, await this.#opts.check(target));
    }
  }
}
