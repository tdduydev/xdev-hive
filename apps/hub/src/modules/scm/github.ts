import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { errorFromResponse, GitProviderError, isGitProviderError, networkError } from "./errors.ts";
import { assertOwnedRepo, combineChecks, describeWithMarker, notMergeable } from "./shared.ts";
import type {
  AccessCheck,
  BranchRules,
  ChecksState,
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
import { COMMIT_STATUS_DESCRIPTION_MAX, ciTime, MAX_PR_FILES } from "./types.ts";

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

interface GhPullFull extends GhPull {
  state: "open" | "closed";
  merged: boolean;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
  /** null khi GitHub đang tính lại (vừa đổi nhánh chính hay vừa push). */
  mergeable: boolean | null;
  mergeable_state?: string;
}

// unstable: kiểm tra không bắt buộc đang đỏ, vẫn merge được (CI do checksFor xét riêng).
const GH_MERGEABLE: Record<string, PullRequestState["mergeable"]> = {
  clean: "clean",
  unstable: "clean",
  has_hooks: "clean",
  behind: "behind",
  dirty: "conflict",
  blocked: "blocked",
  draft: "blocked",
  unknown: "unknown",
};

// neutral, skipped, success là đạt; stale là chạy dở quá 14 ngày, coi như hỏng.
const GH_FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

interface GhPullFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  /** Vắng khi file nhị phân hoặc diff quá lớn. */
  patch?: string;
}

const GH_FILE_STATUS: Record<string, PullRequestFile["status"]> = {
  added: "added",
  removed: "removed",
  renamed: "renamed",
  copied: "added",
};

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
      if (input.expectedHead && input.expectedHead !== parent)
        throw new GitProviderError("conflict", "GitHub: nhánh đã thay đổi");
      const moved = input.files.filter(
        (f): f is Extract<CommitFilesInput["files"][number], { previousPath: string }> => "previousPath" in f,
      );
      const sourceTree = moved.length
        ? await request<{ tree: { path: string; sha: string }[] }>("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
            ...repo,
            tree_sha: base.tree.sha,
            recursive: "1",
          })
        : { tree: [] };
      const treeEntries = await Promise.all(
        input.files.map(async (f) => {
          if ("delete" in f) return { path: f.path, mode: "100644", type: "blob", sha: null };
          if ("previousPath" in f) {
            const source = sourceTree.tree.find((entry) => entry.path === f.previousPath);
            if (!source) throw new GitProviderError("not_found", `GitHub: không có file ${f.previousPath}`);
            return [
              { path: f.previousPath, mode: "100644", type: "blob", sha: null },
              { path: f.path, mode: "100644", type: "blob", sha: source.sha },
            ];
          }
          const content = "bytes" in f ? Buffer.from(f.bytes).toString("base64") : f.content;
          if ("bytes" in f) {
            const blob = await request<{ sha: string }>("POST /repos/{owner}/{repo}/git/blobs", {
              ...repo,
              content,
              encoding: "base64",
            });
            return { path: f.path, mode: "100644", type: "blob", sha: blob.sha };
          }
          return { path: f.path, mode: "100644", type: "blob", content };
        }),
      ).then((entries) => entries.flat());
      const tree = await request<{ sha: string }>("POST /repos/{owner}/{repo}/git/trees", {
        ...repo,
        base_tree: base.tree.sha,
        tree: treeEntries,
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

    async listReviewComments(ref: RepoRef, number: number): Promise<ReviewComment[]> {
      const out: ReviewComment[] = [];
      for (let page = 1; ; page++) {
        const comments = await request<
          Array<{
            id: number;
            node_id?: string;
            in_reply_to_id?: number;
            path: string;
            line: number | null;
            original_line?: number;
            side: "LEFT" | "RIGHT";
            commit_id: string;
            body: string;
            user?: { login?: string };
            html_url: string;
            updated_at: string;
          }>
        >("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
          owner: ref.owner,
          repo: ref.name,
          pull_number: number,
          per_page: 100,
          page,
        });
        out.push(
          ...comments.map((c) => ({
            id: String(c.id),
            threadId: c.in_reply_to_id ? String(c.in_reply_to_id) : (c.node_id ?? String(c.id)),
            path: c.path,
            line: c.line ?? c.original_line ?? 1,
            side: c.side,
            commitSha: c.commit_id,
            body: c.body,
            author: c.user?.login ?? null,
            url: c.html_url,
            updatedAt: c.updated_at,
            resolved: false,
            inReplyToId: c.in_reply_to_id ? String(c.in_reply_to_id) : null,
          })),
        );
        if (comments.length < 100) break;
      }
      return out;
    },
    async createReviewComment(ref: RepoRef, number: number, input: ReviewCommentInput): Promise<ReviewComment> {
      try {
        const c = await request<{
          id: number;
          node_id?: string;
          path: string;
          line: number | null;
          side: "LEFT" | "RIGHT";
          commit_id: string;
          body: string;
          user?: { login?: string };
          html_url: string;
          updated_at: string;
        }>("POST /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
          owner: ref.owner,
          repo: ref.name,
          pull_number: number,
          ...input,
          commit_id: input.commitSha,
        });
        return {
          id: String(c.id),
          threadId: c.node_id ?? String(c.id),
          path: c.path,
          line: c.line ?? input.line,
          side: c.side,
          commitSha: c.commit_id,
          body: c.body,
          author: c.user?.login ?? null,
          url: c.html_url,
          updatedAt: c.updated_at,
          resolved: false,
          inReplyToId: null,
        };
      } catch (e) {
        if (isGitProviderError(e, "invalid") && e.status === 422)
          throw new GitProviderError("position_invalid", "GitHub: dòng không thuộc phần thay đổi của PR", {
            status: 422,
            cause: e,
          });
        throw e;
      }
    },
    async replyReviewComment(ref: RepoRef, number: number, threadId: string, body: string): Promise<ReviewComment> {
      const c = await request<{
        id: number;
        path: string;
        line: number | null;
        side: "LEFT" | "RIGHT";
        commit_id: string;
        body: string;
        user?: { login?: string };
        html_url: string;
        updated_at: string;
      }>("POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies", {
        owner: ref.owner,
        repo: ref.name,
        pull_number: number,
        comment_id: Number(threadId),
        body,
      });
      return {
        id: String(c.id),
        threadId,
        path: c.path,
        line: c.line ?? 1,
        side: c.side,
        commitSha: c.commit_id,
        body: c.body,
        author: c.user?.login ?? null,
        url: c.html_url,
        updatedAt: c.updated_at,
        resolved: false,
        inReplyToId: threadId,
      };
    },
    async editReviewComment(ref: RepoRef, _number: number, commentId: string, body: string): Promise<ReviewComment> {
      const c = await request<{
        id: number;
        node_id?: string;
        path: string;
        line: number | null;
        side: "LEFT" | "RIGHT";
        commit_id: string;
        body: string;
        user?: { login?: string };
        html_url: string;
        updated_at: string;
      }>("PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}", {
        owner: ref.owner,
        repo: ref.name,
        comment_id: Number(commentId),
        body,
      });
      return {
        id: String(c.id),
        threadId: c.node_id ?? String(c.id),
        path: c.path,
        line: c.line ?? 1,
        side: c.side,
        commitSha: c.commit_id,
        body: c.body,
        author: c.user?.login ?? null,
        url: c.html_url,
        updatedAt: c.updated_at,
        resolved: false,
        inReplyToId: null,
      };
    },
    async deleteReviewComment(ref: RepoRef, _number: number, commentId: string) {
      await request("DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}", {
        owner: ref.owner,
        repo: ref.name,
        comment_id: Number(commentId),
      });
    },
    async setReviewThreadResolved(_ref: RepoRef, _number: number, threadId: string, resolved: boolean) {
      const field = resolved ? "resolveReviewThread" : "unresolveReviewThread";
      await request("POST /graphql", {
        query: `mutation($threadId: ID!) { ${field}(input: {threadId: $threadId}) { thread { isResolved } } }`,
        threadId,
      });
    },

    async canPush(ref: RepoRef, user: ScmUser) {
      if (!user.login) return false;
      // `permission` gộp vai: maintain tính là write, triage tính là read. Người không phải cộng tác viên thì 404.
      const r = await orNull(() =>
        request<{ permission: string }>("GET /repos/{owner}/{repo}/collaborators/{username}/permission", {
          owner: ref.owner,
          repo: ref.name,
          username: user.login,
        }),
      );
      return r?.permission === "admin" || r?.permission === "write";
    },

    async getPR(ref: RepoRef, number: number) {
      const pr = await orNull(() =>
        request<GhPullFull>("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: ref.owner,
          repo: ref.name,
          pull_number: number,
        }),
      );
      if (!pr) return null;
      const mergeable =
        pr.mergeable === null
          ? "unknown"
          : (GH_MERGEABLE[pr.mergeable_state ?? ""] ?? (pr.mergeable ? "clean" : "conflict"));
      return {
        number: pr.number,
        url: pr.html_url,
        state: pr.merged ? "merged" : pr.state === "open" ? "open" : "closed",
        draft: pr.draft ?? false,
        head: pr.head.ref,
        headSha: pr.head.sha,
        base: pr.base.ref,
        mergeable,
      } satisfies PullRequestState;
    },

    async updatePRBranch(ref: RepoRef, number: number, expectedHeadSha: string) {
      try {
        await request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch", {
          owner: ref.owner,
          repo: ref.name,
          pull_number: number,
          expected_head_sha: expectedHeadSha,
        });
      } catch (e) {
        // 422: xung đột với nhánh chính, hoặc head đã khác expected_head_sha.
        if (isGitProviderError(e, "invalid")) throw notMergeable(e);
        throw e;
      }
    },

    async checksFor(ref: RepoRef, sha: string, opts?: { excludeContexts?: readonly string[] }): Promise<ChecksState> {
      const repo = { owner: ref.owner, repo: ref.name, ref: sha };
      // Hai nguồn CI của GitHub: commit status (CI ngoài, API cũ) và check run (GitHub Actions, App).
      const status = await request<{
        state: string;
        total_count: number;
        statuses: Array<{ context: string; state: string }>;
      }>("GET /repos/{owner}/{repo}/commits/{ref}/status", {
        ...repo,
        ...(opts?.excludeContexts?.length ? { per_page: 100, page: 1 } : {}),
      });
      const checks = await request<{ check_runs: Array<{ status: string; conclusion: string | null }> }>(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        { ...repo, per_page: 100 },
      );
      const states: ChecksState[] = [];
      // Không có status nào thì GitHub vẫn trả state "pending" với total_count 0.
      if (opts?.excludeContexts?.length) {
        // Checkpoint CI không được chờ chính status của phiên review đang chạy.
        let items = status.statuses;
        for (let page = 1; ; page++) {
          for (const item of items) {
            if (!opts.excludeContexts.includes(item.context))
              states.push(item.state === "success" ? "success" : item.state === "pending" ? "pending" : "failure");
          }
          if (items.length < 100) break;
          const next = await request<{ statuses: Array<{ context: string; state: string }> }>(
            "GET /repos/{owner}/{repo}/commits/{ref}/status",
            { ...repo, per_page: 100, page: page + 1 },
          );
          items = next.statuses;
        }
      } else if (status.total_count > 0) {
        states.push(status.state === "success" ? "success" : status.state === "pending" ? "pending" : "failure");
      }
      for (const run of checks.check_runs) {
        if (run.status !== "completed") states.push("pending");
        else states.push(GH_FAILED.has(run.conclusion ?? "") ? "failure" : "success");
      }
      return combineChecks(states);
    },

    async mergePR(ref: RepoRef, number: number, opts: { method: MergeMethod; sha: string }) {
      try {
        const r = await request<{ sha?: string | null }>("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
          owner: ref.owner,
          repo: ref.name,
          pull_number: number,
          merge_method: opts.method,
          sha: opts.sha,
        });
        return { sha: r.sha ?? null };
      } catch (e) {
        // 405: chưa merge được (thiếu người duyệt, kiểm tra bắt buộc, xung đột). 409: head đã khác sha (có sẵn conflict).
        if (isGitProviderError(e, "invalid") && e.status === 405) throw notMergeable(e);
        throw e;
      }
    },

    async addWebhook(ref: RepoRef, input: WebhookInput) {
      const repo = { owner: ref.owner, repo: ref.name };
      const body = {
        active: true,
        // GitHub không có sự kiện tên pipeline, job; đổi sang workflow_run, workflow_job ở đợt sau.
        events: input.events.filter((e) => e !== "pipeline" && e !== "job"),
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

    branchHead: (ref: RepoRef, branch: string) => headSha(ref, branch),

    async listFiles(ref: RepoRef, sha: string) {
      const tree = await request<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>(
        "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
        { owner: ref.owner, repo: ref.name, tree_sha: sha, recursive: "1" },
      );
      if (!tree.truncated) return tree.tree.filter((e) => e.type === "blob").map((e) => e.path);
      const paths: string[] = [];
      const visit = async (treeSha: string, prefix = ""): Promise<void> => {
        const nested = await request<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>(
          "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
          { owner: ref.owner, repo: ref.name, tree_sha: treeSha },
        );
        for (const entry of nested.tree) {
          const path = prefix ? `${prefix}/${entry.path}` : entry.path;
          if (entry.type === "blob") paths.push(path);
          else if (entry.type === "tree") await visit(entry.sha, path);
        }
        if (nested.truncated) throw new GitProviderError("invalid", "GitHub: cây con quá lớn, không thể đọc an toàn");
      };
      const commit = await request<{ tree: { sha: string } }>("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        owner: ref.owner,
        repo: ref.name,
        commit_sha: sha,
      });
      await visit(commit.tree.sha);
      return paths;
    },

    async readFile(ref: RepoRef, path: string, sha: string) {
      const file = await orNull(() =>
        request<{ content?: string; encoding?: string }>("GET /repos/{owner}/{repo}/contents/{+path}", {
          owner: ref.owner,
          repo: ref.name,
          path: segments(path),
          ref: sha,
        }),
      );
      if (file?.encoding === "none" || (file?.content === "" && file?.encoding !== "base64")) {
        const result = await request<{ tree: { sha: string } }>("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
          owner: ref.owner,
          repo: ref.name,
          commit_sha: sha,
        });
        const tree = await request<{ tree: { path: string; sha: string }[] }>(
          "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
          { owner: ref.owner, repo: ref.name, tree_sha: result.tree.sha, recursive: "1" },
        );
        const blob = tree.tree.find((entry) => entry.path === path);
        if (!blob) return null;
        const content = await request<{ content: string; encoding: string }>(
          "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
          { owner: ref.owner, repo: ref.name, file_sha: blob.sha },
        );
        return Buffer.from(content.content, content.encoding === "base64" ? "base64" : "utf8").toString("utf8");
      }
      if (!file?.content) return file ? "" : null;
      return file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
    },

    async readFileBytes(ref, path, sha) {
      // contents chỉ nhúng nội dung tới 1 MB; đi qua blob theo sha để file lớn cũng đủ byte.
      const file = await orNull(() =>
        request<{ type?: string; sha?: string }>("GET /repos/{owner}/{repo}/contents/{+path}", {
          owner: ref.owner,
          repo: ref.name,
          path: segments(path),
          ref: sha,
        }),
      );
      if (file?.type !== "file" || !file.sha) return null;
      const data = await request<{ content: string; encoding: string }>(
        "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
        { owner: ref.owner, repo: ref.name, file_sha: file.sha },
      );
      return new Uint8Array(Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf8"));
    },

    async readBlob(ref, blob) {
      const data = await request<{ content: string; encoding: string }>(
        "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
        { owner: ref.owner, repo: ref.name, file_sha: blob },
      );
      return new Uint8Array(Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf8"));
    },
    async compare(ref, from, to) {
      const data = await request<{
        files?: { filename: string; previous_filename?: string; status: string; sha: string }[];
        commits?: { sha: string; commit: { message: string; author?: { name?: string; date?: string } | null } }[];
      }>("GET /repos/{owner}/{repo}/compare/{basehead}", {
        owner: ref.owner,
        repo: ref.name,
        basehead: `${from}...${to}`,
        per_page: 100,
      });
      const files = (data.files ?? []).map((f) => ({
        path: f.filename,
        ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
        status: (f.status === "renamed"
          ? "renamed"
          : f.status === "removed"
            ? "removed"
            : f.status === "added"
              ? "added"
              : "modified") as "added" | "removed" | "modified" | "renamed",
        sha: f.sha,
      }));
      const commits = (data.commits ?? []).map((c) => ({
        sha: c.sha,
        title: c.commit.message.split("\n", 1)[0] ?? "",
        author: c.commit.author?.name ?? null,
        authoredAt: ciTime(c.commit.author?.date),
      }));
      return { files, commits, incomplete: files.length >= 300 };
    },
    async archive(ref, sha, path) {
      const o = await octokit();
      const credentials = (await o.auth()) as { token?: string };
      if (!credentials.token)
        throw new GitProviderError("invalid", "GitHub: không lấy được thông tin xác thực archive");
      const base = opts.baseUrl ? new URL(opts.baseUrl) : new URL("https://api.github.com");
      const endpoint = new URL(
        `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/tarball/${encodeURIComponent(sha)}`,
        `${base.href.replace(/\/?$/, "/")}`,
      );
      let response: Response;
      try {
        response = await (opts.fetch ?? fetch)(endpoint, {
          headers: { authorization: `Bearer ${credentials.token}`, accept: "application/vnd.github+json" },
        });
      } catch (error) {
        throw networkError("github", error);
      }
      if (!response.ok)
        throw errorFromResponse("github", response.status, response.headers, await response.text().catch(() => ""));
      if (!response.body) throw new GitProviderError("invalid", "GitHub: archive không có nội dung");
      // GitHub archive API only returns the full repo; callers filter paths while unpacking.
      void path;
      return response.body;
    },
    async lfsBatch(ref, operation, objects) {
      const o = await octokit();
      const credentials = (await o.auth()) as { token?: string };
      if (!credentials.token) throw new GitProviderError("invalid", "GitHub: không lấy được thông tin xác thực LFS");
      const base = opts.baseUrl ? new URL(opts.baseUrl).origin : "https://github.com";
      const url = `${base}/${ref.owner}/${ref.name}.git/info/lfs/objects/batch`;
      let response: Response;
      try {
        response = await (opts.fetch ?? fetch)(url, {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`x-access-token:${credentials.token}`).toString("base64")}`,
            "content-type": "application/vnd.git-lfs+json",
            accept: "application/vnd.git-lfs+json",
          },
          body: JSON.stringify({ operation, transfers: ["basic"], objects }),
        });
      } catch (error) {
        throw networkError("github", error);
      }
      if (!response.ok)
        throw errorFromResponse("github", response.status, response.headers, await response.text().catch(() => ""));
      return response.json();
    },

    async prFiles(ref: RepoRef, number: number) {
      const perPage = 100;
      const out: PullRequestFile[] = [];
      // GitHub dừng ở 3 000 file (30 trang); trang cuối ngắn hơn per_page báo hết sớm hơn.
      for (let page = 1; out.length < MAX_PR_FILES; page++) {
        const files = await orNull(() =>
          request<GhPullFile[]>("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
            owner: ref.owner,
            repo: ref.name,
            pull_number: number,
            per_page: perPage,
            page,
          }),
        );
        if (!files) return null;
        for (const f of files) {
          out.push({
            path: f.filename,
            ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
            status: GH_FILE_STATUS[f.status] ?? "modified",
            additions: f.additions,
            deletions: f.deletions,
            ...(f.patch === undefined ? {} : { patch: f.patch }),
            // File nhị phân và đổi tên thuần không có dòng đổi nên không có patch cũng không phải bị cắt.
            truncated: f.patch === undefined && f.additions + f.deletions > 0,
          });
        }
        if (files.length < perPage) break;
      }
      return out.slice(0, MAX_PR_FILES);
    },

    async setCommitStatus(ref: RepoRef, sha: string, input: CommitStatusInput) {
      await request("POST /repos/{owner}/{repo}/statuses/{sha}", {
        owner: ref.owner,
        repo: ref.name,
        sha,
        state: input.state,
        context: input.context,
        description: input.description.slice(0, COMMIT_STATUS_DESCRIPTION_MAX),
        ...(input.targetUrl ? { target_url: input.targetUrl } : {}),
      });
    },

    async closePR(ref: RepoRef, number: number) {
      const pr = await orNull(() =>
        request<GhPullFull>("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: ref.owner,
          repo: ref.name,
          pull_number: number,
        }),
      );
      if (pr?.state !== "open") return;
      await request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: ref.owner,
        repo: ref.name,
        pull_number: number,
        state: "closed",
      });
    },

    listPipelines: noActions,
    pipelineJobs: noActions,
    jobLog: noActions,
    retryPipeline: noActions,
    cancelPipeline: noActions,
    retryJob: noActions,
    cancelJob: noActions,
    playJob: noActions,
  };
}

// GitHub Actions (workflow run, job) làm ở đợt sau của spec 020 (Q11).
const noActions = () =>
  Promise.reject(new GitProviderError("unsupported", "GitHub: chưa hỗ trợ xem và chạy GitHub Actions"));
