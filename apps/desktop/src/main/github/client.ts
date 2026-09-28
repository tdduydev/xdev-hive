// Minimal GitHub REST (and one GraphQL call) client for pull requests. github.com or GitHub Enterprise Server.
import { GITHUB_URL, HiveError, type HiveErrorCode, type PipelineStatus } from "@xdev-hive/core";
import type { FetchLike } from "../gitlab/client.ts";

export interface GitHubRepo {
  full_name: string;
  default_branch: string | null;
  owner: { login: string };
  html_url: string;
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

/** A check run (GitHub Actions and other apps). */
export interface GitHubCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}

/** A commit status (the older API some CI services still use). */
export interface GitHubStatus {
  context: string;
  state: string;
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

const FAILED = ["failure", "timed_out", "action_required", "startup_failure"];

/**
 * The checks of a commit as one GitLab-style pipeline status: running while any check runs, then failed if
 * one failed. null when the commit has no check at all (no CI).
 */
export function checksStatus(runs: Pick<GitHubCheckRun, "status" | "conclusion">[], statuses: Pick<GitHubStatus, "state">[]): PipelineStatus | null {
  const each: PipelineStatus[] = [
    ...runs.map((r): PipelineStatus => {
      if (r.status !== "completed") return r.status === "in_progress" ? "running" : "pending";
      if (FAILED.includes(r.conclusion ?? "")) return "failed";
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

  async #call<T>(method: string, url: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: "application/vnd.github+json",
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

  createPull(repo: string, body: PullBody): Promise<GitHubPull> {
    return this.#rest("POST", `/repos/${repo}/pulls`, body);
  }

  /** Title and description only: the base branch people may have changed on GitHub stays. */
  updatePull(repo: string, number: number, body: Pick<PullBody, "title" | "body">): Promise<GitHubPull> {
    return this.#rest("PATCH", `/repos/${repo}/pulls/${number}`, body);
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
