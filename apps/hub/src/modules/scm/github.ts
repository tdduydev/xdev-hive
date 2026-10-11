import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { errorFromResponse, GitProviderError, isGitProviderError, networkError } from "./errors.ts";
import { assertOwnedRepo, describeWithMarker } from "./shared.ts";
import type {
  AccessCheck,
  BranchRules,
  CommentOptions,
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

interface CommonOptions {
  /** GitHub Enterprise Server: `https://ghe.example.com/api/v3`. */
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface GitHubAppOptions extends CommonOptions {
  appId: number | string;
  /** Khoá riêng PEM của GitHub App. */
  privateKey: string;
  /** Mỗi provider gắn với một lần cài đặt (một org). */
  installationId: number;
}

export interface GitHubTokenOptions extends CommonOptions {
  /** Fine-grained PAT, PAT cổ điển hoặc token OAuth của một tài khoản. */
  token: string;
}

export type GitHubProviderOptions = GitHubAppOptions | GitHubTokenOptions;

/** Quyền tối thiểu của GitHub App để tạo dự án: tạo repo, bảo vệ nhánh, commit, mở PR, gắn webhook. */
const REQUIRED_PERMISSIONS = ["administration", "contents", "pull_requests", "repository_hooks"] as const;
const REQUIRED_WRITE = REQUIRED_PERMISSIONS.map((p) => `${p}:write`);

interface GhRepo {
  id: number;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  visibility?: string;
  description: string | null;
  clone_url: string;
  ssh_url: string;
  html_url: string;
}

interface GhPull {
  number: number;
  html_url: string;
}

interface GhHook {
  id: number;
  config: { url?: string };
}

function toRepoInfo(r: GhRepo): RepoInfo {
  const visibility: RepoVisibility =
    r.visibility === "internal" || r.visibility === "public" || r.visibility === "private"
      ? r.visibility
      : r.private
        ? "private"
        : "public";
  return {
    id: String(r.id),
    owner: r.owner.login,
    name: r.name,
    defaultBranch: r.default_branch,
    visibility,
    description: r.description ?? "",
    httpUrl: r.clone_url,
    sshUrl: r.ssh_url,
    webUrl: r.html_url,
  };
}

/**
 * Quyền endpoint đòi, GitHub gửi kèm 403 của fine-grained token và token App, ví dụ `administration=write`.
 * Nhiều bộ quyền cách nhau bằng `;`, mỗi bộ đủ dùng; lấy bộ đầu để báo người quản trị cấp gì.
 */
function acceptedPermissions(headers: Record<string, string>): string[] {
  const value = headers["x-accepted-github-permissions"];
  if (!value) return [];
  const [first = ""] = value.split(";");
  return first
    .split(",")
    .map((p) => p.trim().replace("=", ":"))
    .filter(Boolean);
}

/** Lỗi của Octokit (RequestError) có `status` và `response.headers`; đổi sang mã lỗi chung. */
function toError(e: unknown): GitProviderError {
  if (e instanceof GitProviderError) return e;
  const err = e as { status?: unknown; response?: { headers?: Record<string, string>; data?: unknown } };
  if (typeof err?.status === "number" && err.status > 0 && err.response) {
    const data = err.response.data as { message?: unknown } | undefined;
    const detail = typeof data?.message === "string" ? data.message : undefined;
    const headers = err.response.headers ?? {};
    const mapped = errorFromResponse("github", err.status, headers, detail);
    const missingScopes = mapped.code === "forbidden" ? acceptedPermissions(headers) : [];
    if (missingScopes.length === 0) return mapped;
    return new GitProviderError(mapped.code, `${mapped.message}: thiếu ${missingScopes.join(", ")}`, {
      status: mapped.status,
      missingScopes,
      cause: e,
    });
  }
  return networkError("github", e);
}

/**
 * Lỗi khi đổi token cài đặt phải tách khỏi lỗi của lời gọi chính: nếu không, 404 "chưa cài App"
 * bị hiểu nhầm thành "repo không có" và saga đi tạo repo.
 */
function installationError(e: unknown): GitProviderError {
  const err = toError(e);
  if (err.code !== "not_found" && err.code !== "unauthorized") return err;
  return new GitProviderError("unauthorized", "GitHub: GitHub App chưa được cài vào tổ chức hoặc đã bị gỡ", {
    status: err.status,
    cause: e,
  });
}

/**
 * Tên nhánh có `/` (ví dụ `ai/task-1`). Octokit mã hoá `/` thành `%2F` với `{ref}`; mã hoá từng đoạn
 * rồi dùng `{+ref}` để giữ dấu `/` mà ký tự lạ vẫn được mã hoá.
 */
const segments = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");
const refPath = (branch: string) => `heads/${segments(branch)}`;

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toError(e);
  }
}

async function orNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (isGitProviderError(e, "not_found")) return null;
    throw e;
  }
}

interface GhUser {
  login: string;
}

/** Phần khác nhau giữa GitHub App và token: lấy Octokit đã xác thực, và kiểm quyền. */
interface GitHubAuth {
  octokit(): Promise<Octokit>;
  checkAccess(owner: string): Promise<AccessCheck>;
  /** Chỉ token người dùng mới tạo được repo dưới tài khoản cá nhân; null với GitHub App. */
  viewer: (() => Promise<GhUser>) | null;
}

function appAuth(opts: GitHubAppOptions, BaseOctokit: typeof Octokit): GitHubAuth {
  const app = new App({ appId: opts.appId, privateKey: opts.privateKey, Octokit: BaseOctokit });

  // Octokit tự làm mới token cài đặt khi gần hết hạn, nên chỉ cần tạo một lần.
  let installation: Promise<Octokit> | null = null;
  const octokit = async (): Promise<Octokit> => {
    installation ??= app.getInstallationOctokit(opts.installationId).catch((e: unknown) => {
      installation = null;
      throw installationError(e);
    });
    const o = await installation;
    // Token được đổi lười ngay trong lời gọi chính; lấy trước (có cache) để lỗi đổi token không lẫn vào.
    try {
      await o.auth({ type: "installation" });
    } catch (e) {
      throw installationError(e);
    }
    return o;
  };

  async function checkAccess(owner: string): Promise<AccessCheck> {
    const inst = await call(async () => {
      const res = await app.octokit.request("GET /app/installations/{installation_id}", {
        installation_id: opts.installationId,
      });
      return res.data as {
        account: { login?: string; type?: string } | null;
        permissions: Record<string, string | undefined>;
      };
    });
    const missingScopes: string[] = REQUIRED_PERMISSIONS.filter((p) => {
      const level = inst.permissions[p];
      return level !== "write" && level !== "admin";
    }).map((p) => `${p}:write`);
    const login = inst.account?.login ?? "";
    if (login.toLowerCase() !== owner.toLowerCase()) missingScopes.unshift(`installation:${owner}`);
    // Token cài đặt chỉ tạo được repo trong org; tài khoản cá nhân cần token người dùng.
    const isOrg = inst.account?.type === "Organization";
    return { canCreate: isOrg && missingScopes.length === 0, missingScopes };
  }

  return { octokit, checkAccess, viewer: null };
}

function tokenAuth(opts: GitHubTokenOptions, BaseOctokit: typeof Octokit): GitHubAuth {
  const o = new BaseOctokit({ auth: opts.token });
  const octokit = async () => o;

  // Chủ token không đổi trong đời provider; nhớ lại để createRepo không hỏi GitHub mỗi lần.
  let me: Promise<GhUser> | null = null;
  const viewer = () => {
    me ??= call(async () => (await o.request("GET /user")).data as GhUser).catch((e: unknown) => {
      me = null;
      throw e;
    });
    return me;
  };

  async function checkAccess(owner: string): Promise<AccessCheck> {
    const res = await call(() => o.request("GET /user"));
    const login = (res.data as GhUser).login;
    me ??= Promise.resolve({ login });
    const missingScopes: string[] = [];
    let unverifiedScopes: string[] = [];
    const scopes = res.headers["x-oauth-scopes"];
    if (typeof scopes === "string") {
      // PAT cổ điển và token OAuth liệt kê scope trong header. `repo` gồm tạo repo, commit, PR và webhook.
      const granted = scopes.split(",").map((x) => x.trim());
      if (!granted.includes("repo")) missingScopes.push("repo");
    } else {
      // Fine-grained token không có header scope và không có API đọc quyền của chính nó; thử ghi để dò thì có
      // thể tạo repo thật, nên chỉ báo các quyền cần cấp. Thiếu quyền sẽ lộ ở 403 (x-accepted-github-permissions).
      unverifiedScopes = [...REQUIRED_WRITE];
    }
    if (login.toLowerCase() !== owner.toLowerCase()) {
      // Owner không phải chính chủ token thì phải là org mà token thấy được.
      const org = await orNull(() => call(() => o.request("GET /orgs/{org}", { org: owner })));
      if (!org) missingScopes.unshift(`org:${owner}`);
    }
    return {
      canCreate: missingScopes.length === 0,
      missingScopes,
      ...(unverifiedScopes.length ? { unverifiedScopes } : {}),
    };
  }

  return { octokit, checkAccess, viewer };
}

export function createGitHubProvider(opts: GitHubProviderOptions): GitProvider {
  const defaults: Record<string, unknown> = {};
  if (opts.baseUrl) defaults.baseUrl = opts.baseUrl;
  if (opts.fetch) defaults.request = { fetch: opts.fetch };
  const BaseOctokit = Octokit.defaults(defaults);
  const auth = "token" in opts ? tokenAuth(opts, BaseOctokit) : appAuth(opts, BaseOctokit);
  const octokit = auth.octokit;

  async function request<T>(route: string, params: Record<string, unknown> = {}): Promise<T> {
    return call(async () => {
      const o = await octokit();
      const res = await o.request(route, params);
      return res.data as T;
    });
  }

  async function getRepo(ref: RepoRef): Promise<RepoInfo | null> {
    const r = await orNull(() => request<GhRepo>("GET /repos/{owner}/{repo}", { owner: ref.owner, repo: ref.name }));
    return r && toRepoInfo(r);
  }

  async function headSha(ref: RepoRef, branch: string): Promise<string | null> {
    const r = await orNull(() =>
      request<{ object: { sha: string } }>("GET /repos/{owner}/{repo}/git/ref/{+ref}", {
        owner: ref.owner,
        repo: ref.name,
        ref: refPath(branch),
      }),
    );
    return r?.object.sha ?? null;
  }

  /** GitHub tự chọn tên nhánh mặc định khi auto_init; đổi tên cho khớp yêu cầu. */
  async function ensureDefaultBranch(repo: RepoInfo, branch: string): Promise<RepoInfo> {
    if (repo.defaultBranch === branch) return repo;
    await request("POST /repos/{owner}/{repo}/branches/{+branch}/rename", {
      owner: repo.owner,
      repo: repo.name,
      branch: segments(repo.defaultBranch),
      new_name: branch,
    });
    return { ...repo, defaultBranch: branch };
  }

  return {
    kind: "github",

    checkAccess: auth.checkAccess,

    getRepo,

    async createRepo(input: CreateRepoInput) {
      const existing = await getRepo(input);
      if (existing) return ensureDefaultBranch(assertOwnedRepo("github", existing, input), input.defaultBranch);
      const personal = auth.viewer && (await auth.viewer()).login.toLowerCase() === input.owner.toLowerCase();
      if (personal && input.visibility === "internal") {
        throw new GitProviderError(
          "invalid",
          "GitHub: repo internal chỉ có trong org, không tạo dưới tài khoản cá nhân",
        );
      }
      // Cần ít nhất một commit thì Git Data API mới dựng được tree cho commit kế tiếp.
      const common = { name: input.name, description: describeWithMarker(input), auto_init: true };
      let created: RepoInfo;
      try {
        created = toRepoInfo(
          personal
            ? // Repo dưới tài khoản của chính chủ token; endpoint này chỉ nhận cờ private.
              await request<GhRepo>("POST /user/repos", { ...common, private: input.visibility !== "public" })
            : await request<GhRepo>("POST /orgs/{org}/repos", {
                ...common,
                org: input.owner,
                visibility: input.visibility,
              }),
        );
      } catch (e) {
        // Hai lần chạy saga đua nhau: bên thua nhận 422 "name already exists".
        if (!isGitProviderError(e, "invalid")) throw e;
        const again = await getRepo(input);
        if (!again) throw e;
        created = assertOwnedRepo("github", again, input);
      }
      return ensureDefaultBranch(created, input.defaultBranch);
    },

    async commitFiles(ref: RepoRef, input: CommitFilesInput) {
      const repo = { owner: ref.owner, repo: ref.name };
      let parent = await headSha(ref, input.branch);
      const branchExists = parent !== null;
      if (!branchExists) {
        if (!input.fromBranch) throw new GitProviderError("not_found", `GitHub: không có nhánh ${input.branch}`);
        parent = await headSha(ref, input.fromBranch);
        if (!parent) throw new GitProviderError("not_found", `GitHub: không có nhánh ${input.fromBranch}`);
      }
      const base = await request<{ tree: { sha: string } }>("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        ...repo,
        commit_sha: parent,
      });
      const tree = await request<{ sha: string }>("POST /repos/{owner}/{repo}/git/trees", {
        ...repo,
        base_tree: base.tree.sha,
        tree: input.files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
      });
      const commit = await request<{ sha: string }>("POST /repos/{owner}/{repo}/git/commits", {
        ...repo,
        message: input.message,
        tree: tree.sha,
        parents: [parent],
      });
      if (branchExists) {
        // force: false để không đè commit người khác vừa đẩy lên giữa chừng; khi đó GitHub trả 422.
        await request("PATCH /repos/{owner}/{repo}/git/refs/{+ref}", {
          ...repo,
          ref: refPath(input.branch),
          sha: commit.sha,
          force: false,
        });
      } else {
        await request("POST /repos/{owner}/{repo}/git/refs", {
          ...repo,
          ref: `refs/heads/${input.branch}`,
          sha: commit.sha,
        });
      }
      return { sha: commit.sha };
    },

    async protectBranch(ref: RepoRef, branch: string, rules: BranchRules) {
      const checks = rules.requiredChecks ?? [];
      await request("PUT /repos/{owner}/{repo}/branches/{+branch}/protection", {
        owner: ref.owner,
        repo: ref.name,
        branch: segments(branch),
        required_status_checks: checks.length > 0 ? { strict: true, contexts: checks } : null,
        // Không ép admin để người quản trị còn đường gỡ khi cần; agent không phải admin nên vẫn bị chặn.
        enforce_admins: false,
        required_pull_request_reviews: rules.requirePullRequest
          ? { required_approving_review_count: rules.requiredApprovals }
          : null,
        restrictions: null,
        allow_force_pushes: rules.allowForcePush,
        allow_deletions: false,
      });
    },

    async openPR(ref: RepoRef, input: PullRequestInput) {
      const repo = { owner: ref.owner, repo: ref.name };
      let pr: GhPull;
      try {
        pr = await request<GhPull>("POST /repos/{owner}/{repo}/pulls", {
          ...repo,
          head: input.head,
          base: input.base,
          title: input.title,
          body: input.body,
          draft: input.draft ?? false,
        });
      } catch (e) {
        // 422 khi PR cùng head/base đã mở: trả lại PR đó để saga chạy lại không tạo trùng.
        if (!isGitProviderError(e, "invalid")) throw e;
        const open = await request<GhPull[]>("GET /repos/{owner}/{repo}/pulls", {
          ...repo,
          head: `${ref.owner}:${input.head}`,
          base: input.base,
          state: "open",
        });
        const found = open[0];
        if (!found) throw e;
        pr = found;
      }
      if (input.labels?.length) {
        await request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
          ...repo,
          issue_number: pr.number,
          labels: input.labels,
        });
      }
      return { number: pr.number, url: pr.html_url };
    },

    async commentOnIssue(ref: RepoRef, number: number, body: string, _opts?: CommentOptions) {
      // PR cũng là issue với GitHub: bình luận chung (không gắn dòng code) đi qua API của issue.
      const c = await request<{ id: number }>("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: ref.owner,
        repo: ref.name,
        issue_number: number,
        body,
      });
      return { id: String(c.id) };
    },

    async addWebhook(ref: RepoRef, input: WebhookInput) {
      const repo = { owner: ref.owner, repo: ref.name };
      const body = {
        active: true,
        events: input.events,
        config: { url: input.url, secret: input.secret, content_type: "json", insecure_ssl: "0" },
      };
      const hooks = await request<GhHook[]>("GET /repos/{owner}/{repo}/hooks", { ...repo, per_page: 100 });
      const same = hooks.find((h) => h.config.url === input.url);
      if (same) {
        await request("PATCH /repos/{owner}/{repo}/hooks/{hook_id}", { ...repo, hook_id: same.id, ...body });
        return { id: String(same.id) };
      }
      const hook = await request<GhHook>("POST /repos/{owner}/{repo}/hooks", { ...repo, name: "web", ...body });
      return { id: String(hook.id) };
    },

    async removeWebhook(ref: RepoRef, id: string) {
      await orNull(() =>
        request("DELETE /repos/{owner}/{repo}/hooks/{hook_id}", {
          owner: ref.owner,
          repo: ref.name,
          hook_id: Number(id),
        }),
      );
    },
  };
}
