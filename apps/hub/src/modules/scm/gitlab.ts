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
import { assertOwnedRepo, describeWithMarker } from "./shared.ts";
import type {
  AccessCheck,
  BranchRules,
  CommitFilesInput,
  CreateRepoInput,
  FetchLike,
  GitProvider,
  PullRequestInput,
  RepoInfo,
  RepoRef,
  RepoVisibility,
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
  };
}
