import { createRequesterFn, type RequestHandlerFn, type RequestOptions } from "@gitbeaker/requester-utils";
import {
  Branches,
  Commits,
  GroupMembers,
  Groups,
  MergeRequests,
  Namespaces,
  ProjectHooks,
  Projects,
  ProtectedBranches,
  Users,
} from "@gitbeaker/rest";
import { errorFromResponse, GitProviderError, isGitProviderError, networkError } from "./errors.ts";
import { assertOwnedRepo, describeWithMarker, notMergeable } from "./shared.ts";
import type {
  AccessCheck,
  BranchRules,
  ChecksState,
  CiJob,
  CiPipeline,
  CommentOptions,
  CommitFilesInput,
  CommitStatusInput,
  CreateRepoInput,
  FetchLike,
  GitProvider,
  MergeMethod,
  PullRequestFile,
  PullRequestInput,
  PullRequestState,
  RepoInfo,
  RepoRef,
  RepoVisibility,
  ReviewComment,
  ReviewCommentInput,
  ScmUser,
  WebhookInput,
} from "./types.ts";
import { asCiStatus, CI_ACTIVE_STATUSES, COMMIT_STATUS_DESCRIPTION_MAX, ciTime, MAX_PR_FILES } from "./types.ts";

export interface GitLabProviderOptions {
  /** Địa chỉ GitLab, ví dụ `https://gitlab.com` hoặc bản tự host. */
  url: string;
  /** Personal, group hoặc project access token, cần scope `api`. */
  token: string;
  fetch?: FetchLike;
}

/** Mức truy cập của GitLab (docs: api/members). */
const DEVELOPER = 30;
const MAINTAINER = 40;
const NO_ACCESS = 0;
const APPROVAL_RULE_NAME = "Hive";

interface GlProject {
  id: number;
  path: string;
  namespace: { full_path: string };
  default_branch: string | null;
  visibility: string;
  description: string | null;
  http_url_to_repo: string;
  ssh_url_to_repo: string;
  web_url: string;
}

function toRepoInfo(p: GlProject): RepoInfo {
  const visibility: RepoVisibility =
    p.visibility === "public" || p.visibility === "internal" ? p.visibility : "private";
  return {
    id: String(p.id),
    owner: p.namespace.full_path,
    name: p.path,
    defaultBranch: p.default_branch ?? "",
    visibility,
    description: p.description ?? "",
    httpUrl: p.http_url_to_repo,
    sshUrl: p.ssh_url_to_repo,
    webUrl: p.web_url,
  };
}

interface GlMergeRequest {
  iid: number;
  web_url: string;
  state: "opened" | "closed" | "locked" | "merged";
  draft?: boolean;
  work_in_progress?: boolean;
  source_branch: string;
  target_branch: string;
  sha: string;
  /** Có từ GitLab 15.6; bản cũ hơn chỉ có has_conflicts và merge_status. */
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  merge_status?: string;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
}

// Trạng thái còn lại (ci_must_pass, not_approved, discussions_not_resolved, draft_status...) là chờ điều kiện
// của chính GitLab: blocked.
const GL_MERGEABLE: Record<string, PullRequestState["mergeable"]> = {
  mergeable: "clean",
  conflict: "conflict",
  need_rebase: "behind",
  checking: "unknown",
  unchecked: "unknown",
  preparing: "unknown",
  approvals_syncing: "unknown",
};

function mergeableOf(mr: GlMergeRequest): PullRequestState["mergeable"] {
  if (mr.detailed_merge_status) return GL_MERGEABLE[mr.detailed_merge_status] ?? "blocked";
  if (mr.has_conflicts) return "conflict";
  if (mr.merge_status === "can_be_merged") return "clean";
  if (mr.merge_status === "cannot_be_merged") return "blocked";
  return "unknown";
}

interface GlDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  /** Hunk unified không có dòng `---`/`+++`; rỗng khi file nhị phân hoặc bị GitLab thu gọn. */
  diff: string;
  /** GitLab bỏ nội dung diff vì quá lớn (`collapsed` là vượt giới hạn tổng của MR, `too_large` là của riêng file). */
  collapsed?: boolean;
  too_large?: boolean;
}

/** GitLab không trả số dòng đổi; đếm từ hunk, nơi mọi dòng mở đầu bằng `+`/`-` đều là dòng đổi. */
function countChanges(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

function toPullRequestFile(d: GlDiff): PullRequestFile {
  const omitted = d.collapsed === true || d.too_large === true;
  const patch = omitted || d.diff === "" ? undefined : d.diff;
  return {
    path: d.new_path,
    ...(d.renamed_file ? { previousPath: d.old_path } : {}),
    status: d.new_file ? "added" : d.deleted_file ? "removed" : d.renamed_file ? "renamed" : "modified",
    ...countChanges(patch ?? ""),
    ...(patch === undefined ? {} : { patch }),
    truncated: omitted,
  };
}

interface GlPipeline {
  id: number;
  ref: string;
  sha: string;
  status: string;
  source?: string | null;
  web_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  /** Chỉ có khi đọc một pipeline, không có trong danh sách. */
  started_at?: string | null;
  finished_at?: string | null;
  duration?: number | null;
  user?: { username?: string } | null;
}

function toPipeline(p: GlPipeline): CiPipeline {
  return {
    id: String(p.id),
    ref: p.ref,
    sha: p.sha,
    status: asCiStatus(p.status),
    source: p.source ?? null,
    url: p.web_url ?? null,
    createdAt: ciTime(p.created_at),
    updatedAt: ciTime(p.updated_at),
    startedAt: ciTime(p.started_at),
    finishedAt: ciTime(p.finished_at),
    durationSec: p.duration ?? null,
    user: p.user?.username ?? null,
  };
}

interface GlJob {
  id: number;
  name: string;
  stage: string;
  ref: string;
  status: string;
  allow_failure?: boolean;
  failure_reason?: string | null;
  web_url?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration?: number | null;
  user?: { username?: string } | null;
  pipeline: { id: number; sha?: string };
  commit?: { id?: string } | null;
}

function toJob(j: GlJob): CiJob {
  return {
    id: String(j.id),
    pipelineId: String(j.pipeline.id),
    name: j.name,
    stage: j.stage,
    ref: j.ref,
    sha: j.pipeline.sha ?? j.commit?.id ?? null,
    status: asCiStatus(j.status),
    allowFailure: j.allow_failure ?? false,
    failureReason: j.failure_reason ?? null,
    url: j.web_url ?? null,
    createdAt: ciTime(j.created_at),
    startedAt: ciTime(j.started_at),
    finishedAt: ciTime(j.finished_at),
    durationSec: j.duration ?? null,
    user: j.user?.username ?? null,
  };
}

/** Số byte đầu tạo thành chuỗi UTF-8 trọn ký tự: trace của job đang ghi có thể dừng giữa một ký tự nhiều byte. */
function wholeUtf8(bytes: Uint8Array): number {
  let i = bytes.length - 1;
  let tail = 0;
  while (i >= 0 && tail < 3 && ((bytes[i] as number) & 0xc0) === 0x80) {
    i--;
    tail++;
  }
  if (i < 0) return bytes.length;
  const lead = bytes[i] as number;
  const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return size > tail + 1 ? i : bytes.length;
}

const firstLine = (message: string | undefined) => (message ?? "").split("\n", 1)[0] ?? "";

/** GitLab trả `message` là chuỗi hoặc object theo trường (ví dụ `{"name":["has already been taken"]}`). */
function detailOf(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    const m = body.message ?? body.error;
    if (m === undefined) return undefined;
    return (typeof m === "string" ? m : JSON.stringify(m)).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204 || res.headers.get("content-length") === "0") return null;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return res.json();
  return res.text();
}

async function orNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (isGitProviderError(e, "not_found")) return null;
    throw e;
  }
}

/** Repo GitLab định danh bằng đường dẫn đầy đủ; gitbeaker tự mã hoá, còn gọi tay thì phải mã hoá. */
const projectPath = (ref: RepoRef) => `${ref.owner}/${ref.name}`;
const mrPath = (ref: RepoRef, iid: number) => `projects/${encodeURIComponent(projectPath(ref))}/merge_requests/${iid}`;
const pipelinePath = (ref: RepoRef, id: string) =>
  `projects/${encodeURIComponent(projectPath(ref))}/pipelines/${encodeURIComponent(id)}`;
const jobPath = (ref: RepoRef, id: string) =>
  `projects/${encodeURIComponent(projectPath(ref))}/jobs/${encodeURIComponent(id)}`;

export function createGitLabProvider(opts: GitLabProviderOptions): GitProvider {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const host = opts.url.replace(/\/+$/, "");
  const apiBase = `${host}/api/v4/`;

  async function send(method: string, url: URL, init: Omit<RequestInit, "method"> = {}): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, method });
    } catch (e) {
      throw networkError("gitlab", e);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw errorFromResponse("gitlab", res.status, res.headers, detailOf(text));
    }
    return res;
  }

  // Bộ gửi mặc định của gitbeaker tự thử lại 429 tới 10 lần rồi bỏ mất Retry-After.
  // Tự gửi để lỗi giữ nguyên mã và thời gian chờ, việc thử lại để saga quyết định.
  const handler: RequestHandlerFn = async (endpoint, options) => {
    const o = (options ?? {}) as RequestOptions;
    const prefix = o.prefixUrl ?? apiBase;
    const url = new URL(endpoint, prefix.endsWith("/") ? prefix : `${prefix}/`);
    if (o.searchParams) url.search = o.searchParams;
    const init: Omit<RequestInit, "method"> = {};
    if (o.headers) init.headers = o.headers;
    if (o.body !== undefined) init.body = o.body;
    if (o.signal) init.signal = o.signal;
    const res = await send(o.method ?? "GET", url, init);
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: (await parseBody(res)) as never,
    };
  };
  const config = {
    host,
    token: opts.token,
    requesterFn: createRequesterFn((_, reqOpts) => Promise.resolve(reqOpts), handler),
  };
  const gl = {
    branches: new Branches(config),
    commits: new Commits(config),
    groupMembers: new GroupMembers(config),
    groups: new Groups(config),
    mergeRequests: new MergeRequests(config),
    namespaces: new Namespaces(config),
    projectHooks: new ProjectHooks(config),
    projects: new Projects(config),
    protectedBranches: new ProtectedBranches(config),
    users: new Users(config),
  };

  /** Endpoint gitbeaker chưa có hoặc có kiểu quá rối thì gọi REST trực tiếp. */
  async function rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: Omit<RequestInit, "method"> = { headers: { "private-token": opts.token } };
    if (body !== undefined) {
      init.headers = { ...init.headers, "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await send(method, new URL(path, apiBase), init);
    return (method === "HEAD" ? null : await parseBody(res)) as T;
  }

  async function getRepo(ref: RepoRef): Promise<RepoInfo | null> {
    const p = (await orNull(() => gl.projects.show(projectPath(ref)) as Promise<unknown>)) as GlProject | null;
    return p && toRepoInfo(p);
  }

  async function fileExists(ref: RepoRef, path: string, branch: string): Promise<boolean> {
    const p = `projects/${encodeURIComponent(projectPath(ref))}/repository/files/${encodeURIComponent(path)}`;
    try {
      await rest("HEAD", `${p}?ref=${encodeURIComponent(branch)}`);
      return true;
    } catch (e) {
      if (isGitProviderError(e, "not_found")) return false;
      throw e;
    }
  }

  async function protect(id: string, branch: string, rules: BranchRules): Promise<{ id: number }> {
    const options = {
      // Không ai đẩy thẳng được thì mọi thay đổi phải qua merge request.
      pushAccessLevel: rules.requirePullRequest ? NO_ACCESS : DEVELOPER,
      mergeAccessLevel: DEVELOPER,
      allowForcePush: rules.allowForcePush,
    } as const;
    try {
      return (await gl.protectedBranches.protect(id, branch, options)) as unknown as { id: number };
    } catch (e) {
      // GitLab mặc định bảo vệ sẵn nhánh mặc định khi tạo repo; gói Free không sửa được mức truy cập,
      // nên gỡ rồi bảo vệ lại theo luật của Hive.
      if (!isGitProviderError(e, "conflict")) throw e;
      await orNull(() => gl.protectedBranches.unprotect(id, branch));
      return (await gl.protectedBranches.protect(id, branch, options)) as unknown as { id: number };
    }
  }

  /** Luật duyệt chỉ có ở gói Premium trở lên; gói Free trả 403/404 thì bỏ qua. */
  async function setApprovals(id: string, protectedBranchId: number, approvals: number): Promise<void> {
    const base = `projects/${encodeURIComponent(id)}/approval_rules`;
    const rules = await rest<Array<{ id: number; name: string }>>("GET", base).catch((e: unknown) => {
      if (isGitProviderError(e, "forbidden") || isGitProviderError(e, "not_found")) return null;
      throw e;
    });
    if (rules === null) return;
    const body = { name: APPROVAL_RULE_NAME, approvals_required: approvals, protected_branch_ids: [protectedBranchId] };
    const same = rules.find((r) => r.name === APPROVAL_RULE_NAME);
    if (same) await rest("PUT", `${base}/${same.id}`, body);
    else await rest("POST", base, body);
  }

  return {
    kind: "gitlab",

    async checkAccess(owner) {
      const user = (await gl.users.showCurrentUser()) as unknown as {
        id: number;
        username: string;
        is_admin?: boolean;
      };
      const missingScopes: string[] = [];
      // Chỉ access token mới có endpoint này; token OAuth trả 404 thì không kiểm được scope.
      const token = await orNull(() => rest<{ scopes: string[] }>("GET", "personal_access_tokens/self"));
      if (token && !token.scopes.includes("api")) missingScopes.push("api");
      const ns = (await orNull(() => gl.namespaces.show(owner) as Promise<unknown>)) as {
        id: number;
        kind: string;
        full_path: string;
      } | null;
      if (!ns) return { canCreate: false, missingScopes: [...missingScopes, `namespace:${owner}`] };
      let allowed: boolean;
      if (user.is_admin) allowed = true;
      else if (ns.kind === "user") allowed = ns.full_path.toLowerCase() === user.username.toLowerCase();
      else {
        const member = (await orNull(
          () => gl.groupMembers.show(ns.id, user.id, { includeInherited: true }) as Promise<unknown>,
        )) as { access_level: number } | null;
        const group = (await gl.groups.show(ns.id)) as unknown as { project_creation_level?: string };
        const level = member?.access_level ?? 0;
        const needed = group.project_creation_level === "developer" ? DEVELOPER : MAINTAINER;
        allowed = group.project_creation_level !== "noone" && level >= needed;
        if (!allowed) missingScopes.push(needed === DEVELOPER ? "group:developer" : "group:maintainer");
      }
      return { canCreate: allowed && missingScopes.length === 0, missingScopes } satisfies AccessCheck;
    },

    getRepo,

    async createRepo(input: CreateRepoInput) {
      const existing = await getRepo(input);
      if (existing) return assertOwnedRepo("gitlab", existing, input);
      const ns = (await gl.namespaces.show(input.owner)) as unknown as { id: number };
      try {
        const p = await gl.projects.create({
          name: input.name,
          path: input.name,
          namespaceId: ns.id,
          visibility: input.visibility,
          description: describeWithMarker(input),
          // Có commit đầu thì nhánh mặc định tồn tại, bảo vệ nhánh và commit file mẫu làm được ngay.
          initializeWithReadme: true,
          defaultBranch: input.defaultBranch,
        });
        return toRepoInfo(p as unknown as GlProject);
      } catch (e) {
        // Hai lần chạy saga đua nhau: bên thua nhận 400 "has already been taken".
        if (!isGitProviderError(e, "invalid")) throw e;
        const again = await getRepo(input);
        if (!again) throw e;
        return assertOwnedRepo("gitlab", again, input);
      }
    },

    async commitFiles(ref: RepoRef, input: CommitFilesInput) {
      const id = projectPath(ref);
      if (input.expectedHead && (await this.branchHead(ref, input.branch)) !== input.expectedHead)
        throw new GitProviderError("conflict", "GitLab: nhánh đã thay đổi");
      const branchExists = (await orNull(() => gl.branches.show(id, input.branch) as Promise<unknown>)) !== null;
      if (!branchExists && !input.fromBranch) {
        throw new GitProviderError("not_found", `GitLab: không có nhánh ${input.branch}`);
      }
      const source = branchExists ? input.branch : (input.fromBranch as string);
      // Commits API bắt chọn đúng create hoặc update cho từng file, nên phải biết file đã có chưa.
      const exists = await Promise.all(input.files.map((f) => fileExists(ref, f.path, source)));
      const actions = input.files.map((f, i) => {
        if ("delete" in f) return { action: "delete" as const, filePath: f.path };
        if ("previousPath" in f) return { action: "move" as const, filePath: f.path, previousPath: f.previousPath };
        const binary = "bytes" in f;
        return {
          action: exists[i] ? ("update" as const) : ("create" as const),
          filePath: f.path,
          content: binary ? Buffer.from(f.bytes).toString("base64") : f.content,
          ...(binary ? { encoding: "base64" as const } : {}),
        };
      });
      const commit = (await gl.commits.create(
        id,
        input.branch,
        input.message,
        actions,
        branchExists ? {} : { startBranch: source },
      )) as unknown as { id: string };
      return { sha: commit.id };
    },

    async protectBranch(ref: RepoRef, branch: string, rules: BranchRules) {
      const id = projectPath(ref);
      const pb = await protect(id, branch, rules);
      if (rules.requiredApprovals > 0) await setApprovals(id, pb.id, rules.requiredApprovals);
      // Gói Free không ép được từng check theo tên; chỉ ép được "pipeline phải xanh".
      if (rules.requiredChecks?.length) await gl.projects.edit(id, { onlyAllowMergeIfPipelineSucceeds: true });
    },

    async openPR(ref: RepoRef, input: PullRequestInput) {
      const id = projectPath(ref);
      const labels = input.labels?.length ? input.labels.join(",") : undefined;
      let mr: { iid: number; web_url: string };
      try {
        mr = (await gl.mergeRequests.create(
          id,
          input.head,
          input.base,
          input.draft ? `Draft: ${input.title}` : input.title,
          {
            description: input.body,
            ...(labels ? { labels } : {}),
          },
        )) as unknown as typeof mr;
      } catch (e) {
        // 409 khi MR cùng nhánh nguồn đã mở: trả lại MR đó để saga chạy lại không tạo trùng.
        if (!isGitProviderError(e, "conflict")) throw e;
        const open = (await gl.mergeRequests.all({
          projectId: id,
          sourceBranch: input.head,
          targetBranch: input.base,
          state: "opened",
        })) as unknown as Array<typeof mr>;
        const found = open[0];
        if (!found) throw e;
        mr = found;
        if (labels) await gl.mergeRequests.edit(id, mr.iid, { addLabels: labels });
      }
      return { number: mr.iid, url: mr.web_url };
    },

    async commentOnIssue(ref: RepoRef, number: number, body: string, opts?: CommentOptions) {
      const kind = opts?.pullRequest ? "merge_requests" : "issues";
      const note = await rest<{ id: number }>(
        "POST",
        `projects/${encodeURIComponent(projectPath(ref))}/${kind}/${number}/notes`,
        { body },
      );
      return { id: String(note.id) };
    },

    async listReviewComments(ref: RepoRef, number: number): Promise<ReviewComment[]> {
      const discussions = await rest<
        Array<{
          id: string;
          notes: Array<{
            id: number;
            body: string;
            author?: { username?: string };
            web_url?: string;
            updated_at?: string;
            position?: { new_path?: string; new_line?: number; old_path?: string; old_line?: number };
            resolved?: boolean;
          }>;
        }>
      >("GET", `${mrPath(ref, number)}/discussions?per_page=100`);
      return discussions.flatMap((d) =>
        d.notes.map((n) => ({
          id: String(n.id),
          threadId: d.id,
          path: n.position?.new_path ?? n.position?.old_path ?? "",
          line: n.position?.new_line ?? n.position?.old_line ?? 1,
          side: n.position?.new_line ? "RIGHT" : "LEFT",
          commitSha: "",
          body: n.body,
          author: n.author?.username ?? null,
          url: n.web_url ?? null,
          updatedAt: n.updated_at ?? new Date(0).toISOString(),
          resolved: n.resolved ?? false,
          inReplyToId: n.id === d.notes[0]?.id ? null : String(d.notes[0]?.id ?? ""),
        })),
      );
    },
    async createReviewComment(ref: RepoRef, number: number, input: ReviewCommentInput): Promise<ReviewComment> {
      try {
        const versions = await rest<
          Array<{ head_commit_sha: string; base_commit_sha: string; start_commit_sha: string }>
        >("GET", `${mrPath(ref, number)}/versions?per_page=100`);
        const version = versions.find((v) => v.head_commit_sha === input.commitSha);
        if (!version)
          throw new GitProviderError("position_invalid", "GitLab: không tìm thấy phiên bản diff của commit PR", {
            status: 400,
          });
        const d = await rest<{
          id: string;
          notes: Array<{
            id: number;
            body: string;
            author?: { username?: string };
            web_url?: string;
            updated_at?: string;
          }>;
        }>("POST", `${mrPath(ref, number)}/discussions`, {
          body: input.body,
          position: {
            position_type: "text",
            base_sha: version.base_commit_sha,
            start_sha: version.start_commit_sha,
            head_sha: version.head_commit_sha,
            old_path: input.path,
            new_path: input.path,
            ...(input.side === "LEFT" ? { old_line: input.line } : { new_line: input.line }),
          },
        });
        const n = d.notes[0];
        if (!n) throw new GitProviderError("invalid", "GitLab không trả bình luận vừa tạo");
        return {
          id: String(n.id),
          threadId: d.id,
          path: input.path,
          line: input.line,
          side: input.side,
          commitSha: input.commitSha,
          body: n.body,
          author: n.author?.username ?? null,
          url: n.web_url ?? null,
          updatedAt: n.updated_at ?? new Date().toISOString(),
          resolved: false,
          inReplyToId: null,
        };
      } catch (e) {
        if (isGitProviderError(e, "invalid") && e.status === 400)
          throw new GitProviderError("position_invalid", "GitLab: vị trí bình luận không thuộc diff của PR", {
            status: 400,
            cause: e,
          });
        throw e;
      }
    },
    async replyReviewComment(ref: RepoRef, number: number, threadId: string, body: string): Promise<ReviewComment> {
      const n = await rest<{ id: number; body: string; author?: { username?: string }; updated_at?: string }>(
        "POST",
        `${mrPath(ref, number)}/discussions/${encodeURIComponent(threadId)}/notes`,
        { body },
      );
      return {
        id: String(n.id),
        threadId,
        path: "",
        line: 1,
        side: "RIGHT",
        commitSha: "",
        body: n.body,
        author: n.author?.username ?? null,
        url: null,
        updatedAt: n.updated_at ?? new Date().toISOString(),
        resolved: false,
        inReplyToId: threadId,
      };
    },
    async editReviewComment(ref: RepoRef, number: number, commentId: string, body: string): Promise<ReviewComment> {
      const discussions = await rest<
        Array<{
          id: string;
          notes: Array<{
            id: number;
            body: string;
            author?: { username?: string };
            updated_at?: string;
            position?: { new_path?: string; new_line?: number; old_line?: number };
            resolved?: boolean;
          }>;
        }>
      >("GET", `${mrPath(ref, number)}/discussions?per_page=100`);
      const found = discussions.find((d) => d.notes.some((n) => String(n.id) === commentId));
      if (!found) throw new GitProviderError("not_found", "GitLab: không tìm thấy bình luận");
      const n = await rest<{ id: number; body: string; author?: { username?: string }; updated_at?: string }>(
        "PUT",
        `${mrPath(ref, number)}/discussions/${encodeURIComponent(found.id)}/notes/${commentId}`,
        { body },
      );
      const previous = found.notes.find((item) => String(item.id) === commentId)!;
      return {
        id: String(n.id),
        threadId: found.id,
        path: previous.position?.new_path ?? "",
        line: previous.position?.new_line ?? previous.position?.old_line ?? 1,
        side: previous.position?.new_line ? "RIGHT" : "LEFT",
        commitSha: "",
        body: n.body,
        author: n.author?.username ?? null,
        url: null,
        updatedAt: n.updated_at ?? new Date().toISOString(),
        resolved: previous.resolved ?? false,
        inReplyToId: null,
      };
    },
    async deleteReviewComment(ref: RepoRef, number: number, commentId: string) {
      const discussions = await rest<Array<{ id: string; notes: Array<{ id: number }> }>>(
        "GET",
        `${mrPath(ref, number)}/discussions?per_page=100`,
      );
      const found = discussions.find((d) => d.notes.some((n) => String(n.id) === commentId));
      if (!found) throw new GitProviderError("not_found", "GitLab: không tìm thấy bình luận");
      await rest("DELETE", `${mrPath(ref, number)}/discussions/${encodeURIComponent(found.id)}/notes/${commentId}`);
    },
    async setReviewThreadResolved(ref: RepoRef, number: number, threadId: string, resolved: boolean) {
      await rest("PUT", `${mrPath(ref, number)}/discussions/${encodeURIComponent(threadId)}?resolved=${resolved}`);
    },

    async canPush(ref: RepoRef, user: ScmUser) {
      if (user.id === null) return false;
      // `members/all` tính cả quyền thừa hưởng từ group cha.
      const m = await orNull(() =>
        rest<{ access_level: number }>(
          "GET",
          `projects/${encodeURIComponent(projectPath(ref))}/members/all/${user.id}`,
        ),
      );
      return (m?.access_level ?? 0) >= DEVELOPER;
    },

    async getPR(ref: RepoRef, number: number) {
      const mr = await orNull(() => rest<GlMergeRequest>("GET", mrPath(ref, number)));
      if (!mr) return null;
      return {
        number: mr.iid,
        url: mr.web_url,
        // locked: GitLab đang merge dở, chưa xong; coi như còn mở để hỏi lại sau.
        state: mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "open",
        draft: mr.draft ?? mr.work_in_progress ?? false,
        head: mr.source_branch,
        headSha: mr.sha,
        base: mr.target_branch,
        mergeable: mr.state === "locked" ? "unknown" : mergeableOf(mr),
      } satisfies PullRequestState;
    },

    async updatePRBranch(ref: RepoRef, number: number) {
      // GitLab rebase chạy nền và không nhận sha mong đợi; xung đột chỉ lộ ra ở lần getPR sau (need_rebase/conflict).
      await rest("PUT", `${mrPath(ref, number)}/rebase`);
    },

    async checksFor(ref: RepoRef, sha: string, opts?: { excludeContexts?: readonly string[] }): Promise<ChecksState> {
      if (opts?.excludeContexts?.length) {
        // Status ngoài được ghép vào pipeline; bỏ status review trước khi tổng hợp để tránh phiên chờ chính nó.
        const states: ChecksState[] = [];
        for (let page = 1; ; page++) {
          const items = await rest<Array<{ name: string; status: string; allow_failure: boolean }>>(
            "GET",
            `projects/${encodeURIComponent(projectPath(ref))}/repository/commits/${sha}/statuses?per_page=100&page=${page}`,
          );
          for (const item of items) {
            if (opts.excludeContexts.includes(item.name) || item.status === "skipped") continue;
            if (item.status === "success") states.push("success");
            else if (item.status === "failed" || item.status === "canceled")
              states.push(item.allow_failure ? "success" : "failure");
            else states.push("pending");
          }
          if (items.length < 100) break;
        }
        if (states.includes("failure")) return "failure";
        if (states.includes("pending")) return "pending";
        return states.length ? "success" : "none";
      }
      const q = new URLSearchParams({ sha, order_by: "id", sort: "desc", per_page: "1" });
      const [pipeline] = await rest<Array<{ status: string }>>(
        "GET",
        `projects/${encodeURIComponent(projectPath(ref))}/pipelines?${q}`,
      );
      if (!pipeline || pipeline.status === "skipped") return "none";
      if (pipeline.status === "success") return "success";
      if (pipeline.status === "failed" || pipeline.status === "canceled") return "failure";
      // created, waiting_for_resource, preparing, pending, running, manual, scheduled.
      return "pending";
    },

    async mergePR(ref: RepoRef, number: number, opts: { method: MergeMethod; sha: string }) {
      try {
        const mr = await rest<GlMergeRequest>("PUT", `${mrPath(ref, number)}/merge`, {
          sha: opts.sha,
          squash: opts.method === "squash",
        });
        return { sha: mr.merge_commit_sha ?? mr.squash_commit_sha ?? null };
      } catch (e) {
        // 405: bản nháp, đã đóng, pipeline chưa xanh, thiếu duyệt; 406: xung đột. 409 (sha khác head) đã là conflict.
        if (isGitProviderError(e) && (e.status === 405 || e.status === 406)) throw notMergeable(e);
        throw e;
      }
    },

    async addWebhook(ref: RepoRef, input: WebhookInput) {
      const id = projectPath(ref);
      const options = {
        // GitLab không ký HMAC; gửi secret nguyên văn trong header X-Gitlab-Token.
        token: input.secret,
        pushEvents: input.events.includes("push"),
        mergeRequestsEvents: input.events.includes("pull_request"),
        issuesEvents: input.events.includes("issues"),
        noteEvents: input.events.includes("issue_comment"),
        pipelineEvents: input.events.includes("pipeline"),
        jobEvents: input.events.includes("job"),
        enableSslVerification: true,
      };
      const hooks = (await gl.projectHooks.all(id)) as unknown as Array<{ id: number; url: string }>;
      const same = hooks.find((h) => h.url === input.url);
      if (same) {
        await gl.projectHooks.edit(id, same.id, input.url, options);
        return { id: String(same.id) };
      }
      const hook = (await gl.projectHooks.add(id, input.url, options)) as unknown as { id: number };
      return { id: String(hook.id) };
    },

    async removeWebhook(ref: RepoRef, hookId: string) {
      await orNull(() => gl.projectHooks.remove(projectPath(ref), Number(hookId)) as Promise<unknown>);
    },

    async branchHead(ref: RepoRef, branch: string) {
      const p = `projects/${encodeURIComponent(projectPath(ref))}/repository/branches/${encodeURIComponent(branch)}`;
      const b = await orNull(() => rest<{ commit: { id: string } }>("GET", p));
      return b?.commit.id ?? null;
    },

    async listFiles(ref: RepoRef, sha: string) {
      const out: string[] = [];
      // Cây trả theo trang; đọc hết theo x-next-page để không đồng bộ thiếu rồi xoá nhầm skill.
      for (let page = "1"; page; ) {
        const url = new URL(`projects/${encodeURIComponent(projectPath(ref))}/repository/tree`, apiBase);
        url.search = new URLSearchParams({ recursive: "true", ref: sha, per_page: "100", page }).toString();
        const res = await send("GET", url, { headers: { "private-token": opts.token } });
        const items = (await res.json()) as { path: string; type: string }[];
        out.push(...items.filter((i) => i.type === "blob").map((i) => i.path));
        page = res.headers.get("x-next-page") ?? "";
      }
      return out;
    },

    async readFile(ref: RepoRef, path: string, sha: string) {
      const p = `projects/${encodeURIComponent(projectPath(ref))}/repository/files/${encodeURIComponent(path)}/raw`;
      const body = await orNull(() => rest<unknown>("GET", `${p}?ref=${encodeURIComponent(sha)}`));
      if (body === null) return null;
      // File .json được parseBody đọc thành object; trả lại đúng nội dung chữ.
      return typeof body === "string" ? body : JSON.stringify(body);
    },

    async readFileBytes(ref, path, sha) {
      const p = `projects/${encodeURIComponent(projectPath(ref))}/repository/files/${encodeURIComponent(path)}/raw`;
      const url = new URL(`${p}?ref=${encodeURIComponent(sha)}`, apiBase);
      const response = await orNull(() => send("GET", url, { headers: { "private-token": opts.token } }));
      return response && new Uint8Array(await response.arrayBuffer());
    },

    async readBlob(ref, sha) {
      const p = `projects/${encodeURIComponent(projectPath(ref))}/repository/blobs/${encodeURIComponent(sha)}/raw`;
      const response = await send("GET", new URL(p, apiBase), { headers: { "private-token": opts.token } });
      return new Uint8Array(await response.arrayBuffer());
    },
    async compare(ref, from, to) {
      const result = await rest<{
        diffs: {
          new_path: string;
          old_path: string;
          new_file: boolean;
          deleted_file: boolean;
          renamed_file: boolean;
          new_blob_id?: string;
        }[];
        commits?: {
          id: string;
          title?: string;
          message?: string;
          author_name?: string;
          authored_date?: string;
          created_at?: string;
        }[];
        compare_timeout?: boolean;
        overflow?: boolean;
      }>(
        "GET",
        `projects/${encodeURIComponent(projectPath(ref))}/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      return {
        files: (result.diffs ?? []).map((f) => ({
          path: f.new_path,
          ...(f.renamed_file ? { previousPath: f.old_path } : {}),
          status: f.renamed_file
            ? ("renamed" as const)
            : f.new_file
              ? ("added" as const)
              : f.deleted_file
                ? ("removed" as const)
                : ("modified" as const),
          sha: f.new_blob_id ?? null,
        })),
        commits: (result.commits ?? []).map((c) => ({
          sha: c.id,
          title: c.title ?? firstLine(c.message),
          author: c.author_name ?? null,
          authoredAt: ciTime(c.authored_date ?? c.created_at),
        })),
        incomplete: Boolean(result.compare_timeout || result.overflow),
      };
    },
    async archive(ref, sha, path) {
      const query = new URLSearchParams({ sha, ...(path ? { path } : {}) });
      const response = await send(
        "GET",
        new URL(`projects/${encodeURIComponent(projectPath(ref))}/repository/archive.tar.gz?${query}`, apiBase),
        { headers: { "private-token": opts.token } },
      );
      if (!response.body) throw new GitProviderError("invalid", "GitLab: archive không có nội dung");
      return response.body as ReadableStream<Uint8Array>;
    },
    async lfsBatch(ref, operation, objects) {
      const url = `${host}/${projectPath(ref)}.git/info/lfs/objects/batch`;
      const response = await send("POST", new URL(url), {
        headers: {
          "private-token": opts.token,
          "content-type": "application/vnd.git-lfs+json",
          accept: "application/vnd.git-lfs+json",
        },
        body: JSON.stringify({ operation, transfers: ["basic"], objects }),
      });
      return response.json();
    },

    async prFiles(ref: RepoRef, number: number) {
      const out: PullRequestFile[] = [];
      // Đọc theo x-next-page như listFiles; dừng ở 3 000 file cho khớp GitHub.
      for (let page = "1"; page && out.length < MAX_PR_FILES; ) {
        const url = new URL(`${mrPath(ref, number)}/diffs`, apiBase);
        url.search = new URLSearchParams({ per_page: "100", page }).toString();
        const res = await orNull(() => send("GET", url, { headers: { "private-token": opts.token } }));
        if (!res) return null;
        out.push(...((await res.json()) as GlDiff[]).map(toPullRequestFile));
        page = res.headers.get("x-next-page") ?? "";
      }
      return out.slice(0, MAX_PR_FILES);
    },

    async setCommitStatus(ref: RepoRef, sha: string, input: CommitStatusInput) {
      // GitLab gọi trạng thái hỏng là `failed`; `name` là tên kiểm tra, tương đương `context` của GitHub.
      await rest("POST", `projects/${encodeURIComponent(projectPath(ref))}/statuses/${sha}`, {
        state: input.state === "failure" ? "failed" : input.state,
        name: input.context,
        description: input.description.slice(0, COMMIT_STATUS_DESCRIPTION_MAX),
        ...(input.targetUrl ? { target_url: input.targetUrl } : {}),
      });
    },

    async closePR(ref: RepoRef, number: number) {
      const mr = await orNull(() => rest<{ state: string }>("GET", mrPath(ref, number)));
      if (mr?.state !== "opened") return;
      await rest("PUT", mrPath(ref, number), { state_event: "close" });
    },

    async listPipelines(ref, o) {
      const q = new URLSearchParams({
        order_by: "id",
        sort: "desc",
        per_page: String(o.perPage ?? 20),
        page: String(o.page),
      });
      if (o.branch) q.set("ref", o.branch);
      if (o.sha) q.set("sha", o.sha);
      if (o.status) q.set("status", o.status);
      const url = new URL(`projects/${encodeURIComponent(projectPath(ref))}/pipelines?${q}`, apiBase);
      const res = await send("GET", url, { headers: { "private-token": opts.token } });
      const next = res.headers.get("x-next-page");
      return {
        items: ((await res.json()) as GlPipeline[]).map(toPipeline),
        nextPage: next ? Number(next) : null,
      };
    },

    async pipelineJobs(ref, pipelineId) {
      const out: CiJob[] = [];
      for (let page = "1"; page; ) {
        const url = new URL(`${pipelinePath(ref, pipelineId)}/jobs`, apiBase);
        url.search = new URLSearchParams({ per_page: "100", page }).toString();
        const res = await send("GET", url, { headers: { "private-token": opts.token } });
        out.push(...((await res.json()) as GlJob[]).map(toJob));
        page = res.headers.get("x-next-page") ?? "";
      }
      return out;
    },

    async jobLog(ref, jobId, from) {
      // Đọc trạng thái trước trace: job đã dừng lúc hỏi trạng thái thì trace đọc sau đó chắc chắn đủ.
      const job = await rest<GlJob>("GET", jobPath(ref, jobId));
      const complete = !CI_ACTIVE_STATUSES.includes(asCiStatus(job.status));
      // [Unverified] Tài liệu API trace không nói có nhận Range, nên đọc cả log rồi cắt từ `from`.
      const res = await send("GET", new URL(`${jobPath(ref, jobId)}/trace`, apiBase), {
        headers: { "private-token": opts.token },
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const end = complete ? bytes.length : wholeUtf8(bytes);
      if (from >= end) return { text: "", next: from, complete };
      return { text: new TextDecoder().decode(bytes.subarray(from, end)), next: end, complete };
    },

    async retryPipeline(ref, pipelineId) {
      return toPipeline(await rest<GlPipeline>("POST", `${pipelinePath(ref, pipelineId)}/retry`));
    },
    async cancelPipeline(ref, pipelineId) {
      return toPipeline(await rest<GlPipeline>("POST", `${pipelinePath(ref, pipelineId)}/cancel`));
    },
    async retryJob(ref, jobId) {
      return toJob(await rest<GlJob>("POST", `${jobPath(ref, jobId)}/retry`));
    },
    async cancelJob(ref, jobId) {
      return toJob(await rest<GlJob>("POST", `${jobPath(ref, jobId)}/cancel`));
    },
    async playJob(ref, jobId) {
      return toJob(await rest<GlJob>("POST", `${jobPath(ref, jobId)}/play`));
    },
  };
}
