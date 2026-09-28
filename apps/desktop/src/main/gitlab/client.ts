// Minimal GitLab REST v4 client for merge requests.
import { HiveError, type HiveErrorCode } from "@xdev-hive/core";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GitLabProject {
  id: number;
  path_with_namespace: string;
  default_branch: string | null;
  web_url: string;
}

export interface GitLabMr {
  iid: number;
  web_url: string;
  title: string;
  draft?: boolean;
  source_branch: string;
  target_branch: string;
}

export interface GitLabPipeline {
  id: number;
  status: string;
  web_url: string;
}

export interface GitLabMrDetail extends GitLabMr {
  state: "opened" | "closed" | "locked" | "merged";
  merged_at?: string | null;
  /** The pipeline of the MR's latest commit; null before one ran (or without CI). */
  head_pipeline?: GitLabPipeline | null;
}

export interface GitLabJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  web_url: string;
  allow_failure?: boolean;
}

export interface MrBody {
  source_branch?: string;
  target_branch: string;
  title: string;
  description: string;
  labels?: string;
  remove_source_branch?: boolean;
}

const CODES: Record<number, HiveErrorCode> = { 400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict" };

function messageOf(json: unknown, fallback: string): string {
  const m = (json as { message?: unknown; error?: unknown } | null)?.message ?? (json as { error?: unknown } | null)?.error;
  if (!m) return fallback;
  return typeof m === "string" ? m : JSON.stringify(m);
}

export class GitLabClient {
  readonly baseUrl: string;
  readonly #token: string;
  readonly #fetch: FetchLike;

  constructor(url: string, token: string, fetchImpl: FetchLike = fetch) {
    if (!/^https?:\/\//.test(url)) throw new HiveError("bad_request", "GitLab URL phải bắt đầu bằng http:// hoặc https://", { key: "errors.gitlabUrl" });
    if (!token) throw new HiveError("bad_request", "Chưa có GitLab token.", { key: "errors.gitlabNoToken" });
    this.baseUrl = url.replace(/\/+$/, "");
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  get host(): string {
    return new URL(this.baseUrl).hostname.toLowerCase();
  }

  async #request<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}/api/v4${path}`, {
        method,
        headers: { "PRIVATE-TOKEN": this.#token, accept: raw ? "text/plain" : "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      const reason = (err as Error).message;
      throw new HiveError("bad_request", `Không kết nối được GitLab ${this.baseUrl}: ${reason}`, { key: "errors.gitlabUnreachable", vars: { url: this.baseUrl, reason } });
    }
    const text = await res.text();
    if (raw && res.ok) return text as T;
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON (proxy error page etc.)
    }
    if (!res.ok) {
      throw new HiveError(CODES[res.status] ?? "bad_request", `GitLab ${res.status}: ${messageOf(json, text.slice(0, 200) || res.statusText)}`);
    }
    return json as T;
  }

  user(): Promise<{ username: string; name: string }> {
    return this.#request("GET", "/user");
  }

  project(pathOrId: string | number): Promise<GitLabProject> {
    return this.#request("GET", `/projects/${encodeURIComponent(String(pathOrId))}`);
  }

  openMergeRequests(projectId: number, sourceBranch: string): Promise<GitLabMr[]> {
    return this.#request("GET", `/projects/${projectId}/merge_requests?state=opened&source_branch=${encodeURIComponent(sourceBranch)}`);
  }

  /** `project` is the numeric id or the path (group/project). */
  mergeRequest(project: string | number, iid: number): Promise<GitLabMrDetail> {
    return this.#request("GET", `/projects/${encodeURIComponent(String(project))}/merge_requests/${iid}`);
  }

  failedJobs(project: string | number, pipelineId: number): Promise<GitLabJob[]> {
    return this.#request("GET", `/projects/${encodeURIComponent(String(project))}/pipelines/${pipelineId}/jobs?scope[]=failed&per_page=50`);
  }

  /** The job's log as plain text. */
  jobTrace(project: string | number, jobId: number): Promise<string> {
    return this.#request("GET", `/projects/${encodeURIComponent(String(project))}/jobs/${jobId}/trace`, undefined, true);
  }

  createMergeRequest(projectId: number, body: MrBody): Promise<GitLabMr> {
    return this.#request("POST", `/projects/${projectId}/merge_requests`, body);
  }

  updateMergeRequest(projectId: number, iid: number, body: Partial<MrBody>): Promise<GitLabMr> {
    return this.#request("PUT", `/projects/${projectId}/merge_requests/${iid}`, body);
  }
}
