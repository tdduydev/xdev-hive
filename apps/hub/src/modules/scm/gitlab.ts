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
  CommentOptions,
  CommitFilesInput,
  CreateRepoInput,
  FetchLike,
  GitProvider,
  MergeMethod,
  PullRequestInput,
  PullRequestState,
  RepoInfo,
  RepoRef,
  RepoVisibility,
  ScmUser,
  WebhookInput,
} from "./types.ts";

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
      const branchExists = (await orNull(() => gl.branches.show(id, input.branch) as Promise<unknown>)) !== null;
      if (!branchExists && !input.fromBranch) {
        throw new GitProviderError("not_found", `GitLab: không có nhánh ${input.branch}`);
      }
      const source = branchExists ? input.branch : (input.fromBranch as string);
      // Commits API bắt chọn đúng create hoặc update cho từng file, nên phải biết file đã có chưa.
      const exists = await Promise.all(input.files.map((f) => fileExists(ref, f.path, source)));
      const actions = input.files.map((f, i) => ({
        action: exists[i] ? ("update" as const) : ("create" as const),
        filePath: f.path,
        content: f.content,
      }));
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

    async checksFor(ref: RepoRef, sha: string): Promise<ChecksState> {
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

    async closePR(ref: RepoRef, number: number) {
      const mr = await orNull(() => rest<{ state: string }>("GET", mrPath(ref, number)));
      if (mr?.state !== "opened") return;
      await rest("PUT", mrPath(ref, number), { state_event: "close" });
    },
  };
}
