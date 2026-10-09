// Minimal GitHub REST (and one GraphQL call) client for pull requests. github.com or GitHub Enterprise Server.
import { GITHUB_URL, HiveError, type GitLabGroupRepo, type HiveErrorCode, type PipelineStatus } from "@xdev-hive/core";
import type { FetchLike } from "#desktop/main/gitlab/client.ts";

export interface GitHubRepo {
  full_name: string;
  default_branch: string | null;
  owner: { login: string };
  html_url: string;
}

/** A repository in an owner listing. */
interface RawOwnerRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch?: string | null;
  ssh_url: string;
  clone_url: string;
  archived?: boolean;
}

export interface GitHubPull {
  number: number;
  html_url: string;
  /** For the GraphQL draft switch. */
  node_id: string;
  title: string;
  draft?: boolean;
  head: { ref: string };
  base: { ref: string };
}

export interface GitHubPullDetail extends GitHubPull {
  state: "open" | "closed";
  merged: boolean;
  head: { ref: string; sha: string };
}

/** A check run (GitHub Actions and other apps). For GitHub Actions its id is the job's id. */
export interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  app?: { slug: string; name: string } | null;
  /** What the app reported, for checks whose log GitHub does not keep. */
  output?: { title: string | null; summary: string | null; text: string | null } | null;
}

/** A commit status (the older API some CI services still use). */
export interface GitHubStatus {
  id: number;
  context: string;
  state: string;
  description: string | null;
  target_url: string | null;
}

export interface PullBody {
  title: string;
  body: string;
  head?: string;
  base?: string;
  draft?: boolean;
}

const CODES: Record<number, HiveErrorCode> = { 400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 422: "bad_request" };

/** GitHub puts the reason in `message`, and for a 422 the details in `errors[].message`. */
function messageOf(json: unknown, fallback: string): string {
  const j = json as { message?: unknown; errors?: Array<{ message?: unknown; code?: unknown }> } | null;
  const details = (j?.errors ?? []).map((e) => e.message ?? e.code).filter(Boolean).join("; ");
  const m = typeof j?.message === "string" ? j.message : null;
  return [m, details].filter(Boolean).join(": ") || fallback;
}

/** Repository and number of a pull request web URL on `baseUrl`; null for any other URL. */
export function pullRef(baseUrl: string, url: string): { repo: string; number: number } | null {
  const base = baseUrl.replace(/\/+$/, "");
  if (!url.startsWith(`${base}/`)) return null;
  const m = /^([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(url.slice(base.length + 1));
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}

/** Check conclusions that fail the checks (the rest pass, skip or cancel). */
export const FAILED_CONCLUSIONS = ["failure", "timed_out", "action_required", "startup_failure"];

/**
 * The checks of a commit as one GitLab-style pipeline status: running while any check runs, then failed if
 * one failed. null when the commit has no check at all (no CI).
 */
export function checksStatus(runs: Pick<GitHubCheckRun, "status" | "conclusion">[], statuses: Pick<GitHubStatus, "state">[]): PipelineStatus | null {
  const each: PipelineStatus[] = [
    ...runs.map((r): PipelineStatus => {
      if (r.status !== "completed") return r.status === "in_progress" ? "running" : "pending";
      if (FAILED_CONCLUSIONS.includes(r.conclusion ?? "")) return "failed";
      if (r.conclusion === "cancelled") return "canceled";
      if (r.conclusion === "skipped" || r.conclusion === "stale") return "skipped";
      return "success";
    }),
    ...statuses.map((s): PipelineStatus => (s.state === "success" ? "success" : s.state === "pending" ? "pending" : "failed")),
  ];
  if (!each.length) return null;
  for (const status of ["running", "pending", "failed", "canceled", "success"] as const) if (each.includes(status)) return status;
  return "skipped";
}

/** REST and GraphQL endpoints: api.github.com for github.com, <url>/api/v3 and <url>/api/graphql for Enterprise Server. */
export function githubApi(url: string): { rest: string; graphql: string } {
  const base = url.replace(/\/+$/, "");
  if (base.toLowerCase() === GITHUB_URL) return { rest: "https://api.github.com", graphql: "https://api.github.com/graphql" };
  return { rest: `${base}/api/v3`, graphql: `${base}/api/graphql` };
}

export class GitHubClient {
  readonly baseUrl: string;
  readonly #api: { rest: string; graphql: string };
  readonly #token: string;
  readonly #fetch: FetchLike;

  constructor(url: string, token: string, fetchImpl: FetchLike = fetch) {
    if (!/^https?:\/\//.test(url)) throw new HiveError("bad_request", "GitHub URL phải bắt đầu bằng http:// hoặc https://", { key: "errors.githubUrl" });
    if (!token) throw new HiveError("bad_request", "Chưa có GitHub token.", { key: "errors.githubNoToken" });
    this.baseUrl = url.replace(/\/+$/, "");
    this.#api = githubApi(this.baseUrl);
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  get host(): string {
    return new URL(this.baseUrl).hostname.toLowerCase();
  }

  /** `raw`: the body as text (a job log). */
  async #call<T>(method: string, url: string, body?: unknown, raw = false): Promise<T> {
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: raw ? "text/plain" : "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      const reason = (err as Error).message;
      throw new HiveError("bad_request", `Không kết nối được GitHub ${this.baseUrl}: ${reason}`, { key: "errors.githubUnreachable", vars: { url: this.baseUrl, reason } });
    }
    const text = await res.text();
    if (raw && res.ok) return text as T;
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON (proxy error page etc.)
    }
    if (!res.ok) throw new HiveError(CODES[res.status] ?? "bad_request", `GitHub ${res.status}: ${messageOf(json, text.slice(0, 200) || res.statusText)}`);
    return json as T;
  }

  #rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.#call(method, `${this.#api.rest}${path}`, body);
  }

  user(): Promise<{ login: string; name: string | null }> {
    return this.#rest("GET", "/user");
  }

  /**
   * Every repository of an organization or a user, archived ones left out (roadmap 74a), in the import's shape.
   * The token's own account goes through /user/repos, because /users/{login}/repos leaves out its private ones.
   */
  async ownerRepos(owner: string): Promise<GitLabGroupRepo[]> {
    const me = (await this.user()).login;
    let base: string;
    if (me.toLowerCase() === owner.toLowerCase()) base = "/user/repos?affiliation=owner";
    else {
      const who = await this.#rest<{ type?: string }>("GET", `/users/${encodeURIComponent(owner)}`);
      base = who.type === "Organization" ? `/orgs/${encodeURIComponent(owner)}/repos?type=all` : `/users/${encodeURIComponent(owner)}/repos?type=owner`;
    }
    const out: GitLabGroupRepo[] = [];
    for (let page = 1; page <= 50; page++) {
      const batch = await this.#rest<RawOwnerRepo[]>("GET", `${base}&sort=full_name&per_page=100&page=${page}`);
      for (const r of batch) {
        if (r.archived) continue;
        out.push({ id: r.id, name: r.name, pathWithNamespace: r.full_name, defaultBranch: r.default_branch ?? null, sshUrl: r.ssh_url, httpUrl: r.clone_url });
      }
      if (batch.length < 100) break;
    }
    return out;
  }

  /** `repo` is owner/name. */
  repo(repo: string): Promise<GitHubRepo> {
    return this.#rest("GET", `/repos/${repo}`);
  }

  /** Open pull requests from `branch` of the same repository. */
  openPulls(repo: string, owner: string, branch: string): Promise<GitHubPull[]> {
    return this.#rest("GET", `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  }

  pull(repo: string, number: number): Promise<GitHubPullDetail> {
    return this.#rest("GET", `/repos/${repo}/pulls/${number}`);
  }

  async checkRuns(repo: string, sha: string): Promise<GitHubCheckRun[]> {
    return (await this.#rest<{ check_runs: GitHubCheckRun[] }>("GET", `/repos/${repo}/commits/${sha}/check-runs?per_page=100`)).check_runs ?? [];
  }

  /** The latest status of each context on the commit. */
  async statuses(repo: string, sha: string): Promise<GitHubStatus[]> {
    return (await this.#rest<{ statuses: GitHubStatus[] }>("GET", `/repos/${repo}/commits/${sha}/status`)).statuses ?? [];
  }

  /** A GitHub Actions job's log as plain text (GitHub answers with a redirect to a short-lived download). */
  jobLog(repo: string, jobId: number): Promise<string> {
    return this.#call("GET", `${this.#api.rest}/repos/${repo}/actions/jobs/${jobId}/logs`, undefined, true);
  }

  createPull(repo: string, body: PullBody): Promise<GitHubPull> {
    return this.#rest("POST", `/repos/${repo}/pulls`, body);
  }

  /** Title and description only: the base branch people may have changed on GitHub stays. */
  updatePull(repo: string, number: number, body: Pick<PullBody, "title" | "body">): Promise<GitHubPull> {
    return this.#rest("PATCH", `/repos/${repo}/pulls/${number}`, body);
  }

  /** Merges it with the repository's default method (roadmap 18c); 405 when it cannot be merged, 409 when the head moved. */
  merge(repo: string, number: number): Promise<{ merged: boolean; message: string; sha?: string }> {
    return this.#rest("PUT", `/repos/${repo}/pulls/${number}/merge`, {});
  }

  addLabels(repo: string, number: number, labels: string[]): Promise<unknown> {
    return this.#rest("POST", `/repos/${repo}/issues/${number}/labels`, { labels });
  }

  /** REST cannot turn a pull request into a draft or back: GraphQL can. */
  async setDraft(nodeId: string, draft: boolean): Promise<void> {
    const mutation = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    const res = await this.#call<{ errors?: Array<{ message?: string }> }>("POST", this.#api.graphql, {
      query: `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
      variables: { id: nodeId },
    });
    if (res?.errors?.length) throw new HiveError("bad_request", `GitHub: ${res.errors.map((e) => e.message).join("; ")}`);
  }
}
