import { GitProviderError } from "./errors.ts";
import { assertOwnedRepo, describeWithMarker } from "./shared.ts";
import type {
  AccessCheck,
  BranchRules,
  ChecksState,
  CommentOptions,
  CommitFilesInput,
  CommitStatusInput,
  CreateRepoInput,
  GitProvider,
  GitProviderKind,
  MergeMethod,
  PullRequestFile,
  PullRequestInput,
  PullRequestState,
  RepoInfo,
  RepoRef,
  ScmUser,
  WebhookInput,
} from "./types.ts";
import { COMMIT_STATUS_DESCRIPTION_MAX } from "./types.ts";

type Method = Exclude<keyof GitProvider, "kind">;

export interface MemoryRepo {
  info: RepoInfo;
  /** Nội dung file theo nhánh. */
  branches: Map<string, Map<string, string>>;
  commits: Array<{ branch: string; message: string; sha: string; paths: string[] }>;
  protection: Map<string, BranchRules>;
  hooks: Map<string, WebhookInput>;
  pulls: MemoryPull[];
  comments: Array<{ id: string; number: number; body: string; pullRequest: boolean }>;
  /** Kết quả CI theo sha; sha không có trong map là `none`. */
  checks: Map<string, ChecksState>;
  /** Commit status theo `sha` rồi `context`; đặt lại cùng context thì ghi đè như nhà cung cấp thật. */
  statuses: Map<string, Map<string, CommitStatusInput>>;
}

export interface MemoryPull {
  number: number;
  head: string;
  base: string;
  title: string;
  url: string;
  state: PullRequestState["state"];
  draft: boolean;
  headSha: string;
  mergeable: PullRequestState["mergeable"];
  /** Danh sách file `prFiles` trả; vắng thì suy ra từ nội dung nhánh head và base. */
  files?: PullRequestFile[];
  /** Có sau mergePR. */
  merged?: { method: MergeMethod; sha: string };
}

export interface MemoryProvider extends GitProvider {
  readonly repos: Map<string, MemoryRepo>;
  /** Owner mà provider có quyền tạo repo; owner khác thì checkAccess báo thiếu quyền. */
  readonly owners: Set<string>;
  /** Login hoặc id (dạng chuỗi) của người push được vào mọi repo; mặc định không ai. */
  readonly pushers: Set<string>;
  readonly calls: Array<{ method: Method; args: unknown[] }>;
  /** Mọi lời gọi `method` ném lỗi này cho tới khi gọi lại với null. */
  fail(method: Method, error: GitProviderError | null): void;
  /** Thêm repo có sẵn (không do hub tạo). */
  seedRepo(ref: RepoRef, opts?: { defaultBranch?: string; files?: Record<string, string> }): MemoryRepo;
  /** Đổi trạng thái PR (merge tay, đóng, nhánh chính tiến...) như người dùng làm trên GitHub/GitLab. */
  setPull(ref: RepoRef, number: number, patch: Partial<Omit<MemoryPull, "number">>): MemoryPull;
  setChecks(ref: RepoRef, sha: string, state: ChecksState): void;
}

const key = (ref: RepoRef) => `${ref.owner}/${ref.name}`.toLowerCase();

/**
 * GitProvider trong bộ nhớ cho test saga và chạy hub tại máy không có GitHub/GitLab. Giữ đúng các cam kết của
 * provider thật: createRepo idempotent theo marker, openPR và addWebhook không tạo trùng.
 */
export function createMemoryProvider(
  kind: GitProviderKind = "github",
  owners: string[] = ["xdev-team"],
): MemoryProvider {
  const repos = new Map<string, MemoryRepo>();
  const ownerSet = new Set(owners);
  const pushers = new Set<string>();
  const failures = new Map<Method, GitProviderError>();
  const calls: MemoryProvider["calls"] = [];
  let seq = 0;
  const host = kind === "github" ? "github.com" : "gitlab.com";

  const makeRepo = (ref: RepoRef, defaultBranch: string, description: string): MemoryRepo => {
    seq += 1;
    const repo: MemoryRepo = {
      info: {
        id: String(1000 + seq),
        owner: ref.owner,
        name: ref.name,
        defaultBranch,
        visibility: "private",
        description,
        httpUrl: `https://${host}/${ref.owner}/${ref.name}.git`,
        sshUrl: `git@${host}:${ref.owner}/${ref.name}.git`,
        webUrl: `https://${host}/${ref.owner}/${ref.name}`,
      },
      branches: new Map([[defaultBranch, new Map([["README.md", `# ${ref.name}\n`]])]]),
      commits: [],
      protection: new Map(),
      hooks: new Map(),
      pulls: [],
      comments: [],
      checks: new Map(),
      statuses: new Map(),
    };
    repos.set(key(ref), repo);
    return repo;
  };

  const need = (ref: RepoRef): MemoryRepo => {
    const repo = repos.get(key(ref));
    if (!repo) throw new GitProviderError("not_found", `${host}: không tìm thấy ${ref.owner}/${ref.name}`);
    return repo;
  };

  const nextSha = () => {
    seq += 1;
    return seq.toString(16).padStart(40, "0");
  };

  const pull = (ref: RepoRef, number: number): MemoryPull => {
    const pr = need(ref).pulls.find((p) => p.number === number);
    if (!pr) throw new GitProviderError("not_found", `${host}: không có PR ${number}`);
    return pr;
  };

  const headOf = (repo: MemoryRepo, branch: string): string | null => {
    if (!repo.branches.has(branch)) return null;
    return repo.commits.filter((c) => c.branch === branch).at(-1)?.sha ?? `${branch}@init`;
  };
  const filesAt = (repo: MemoryRepo, sha: string): Map<string, string> => {
    for (const branch of repo.branches.keys())
      if (headOf(repo, branch) === sha) return repo.branches.get(branch) as Map<string, string>;
    throw new GitProviderError("not_found", `${host}: không có commit ${sha}`);
  };

  /** Patch một hunk cho cả file: đủ để màn review có gì đó vẽ, không mô phỏng thuật toán diff. */
  const wholeFilePatch = (before: string | undefined, after: string | undefined): string => {
    const lines = (text: string | undefined) => (text ? text.replace(/\n$/, "").split("\n") : []);
    const old = lines(before);
    const now = lines(after);
    return [
      `@@ -${old.length ? 1 : 0},${old.length} +${now.length ? 1 : 0},${now.length} @@`,
      ...old.map((l) => `-${l}`),
      ...now.map((l) => `+${l}`),
    ].join("\n");
  };

  const derivedFiles = (repo: MemoryRepo, pr: MemoryPull): PullRequestFile[] => {
    const head = repo.branches.get(pr.head) ?? new Map<string, string>();
    const base = repo.branches.get(pr.base) ?? new Map<string, string>();
    const files: PullRequestFile[] = [];
    for (const path of [...new Set([...head.keys(), ...base.keys()])].sort()) {
      const before = base.get(path);
      const after = head.get(path);
      if (before === after) continue;
      const patch = wholeFilePatch(before, after);
      files.push({
        path,
        status: before === undefined ? "added" : after === undefined ? "removed" : "modified",
        additions: after === undefined ? 0 : after.replace(/\n$/, "").split("\n").length,
        deletions: before === undefined ? 0 : before.replace(/\n$/, "").split("\n").length,
        patch,
        truncated: false,
      });
    }
    return files;
  };

  const track = <A extends unknown[], R>(method: Method, fn: (...args: A) => R) =>
    (async (...args: A) => {
      calls.push({ method, args });
      const err = failures.get(method);
      if (err) throw err;
      return fn(...args);
    }) as (...args: A) => Promise<Awaited<R>>;

  return {
    kind,
    repos,
    owners: ownerSet,
    pushers,
    calls,
    fail(method, error) {
      if (error) failures.set(method, error);
      else failures.delete(method);
    },
    seedRepo(ref, opts = {}) {
      const repo = makeRepo(ref, opts.defaultBranch ?? "main", "");
      const files = repo.branches.get(repo.info.defaultBranch);
      for (const [p, c] of Object.entries(opts.files ?? {})) files?.set(p, c);
      return repo;
    },
    setPull(ref, number, patch) {
      return Object.assign(pull(ref, number), patch);
    },
    setChecks(ref, sha, state) {
      need(ref).checks.set(sha, state);
    },

    checkAccess: track("checkAccess", (owner: string): AccessCheck => {
      const ok = [...ownerSet].some((o) => o.toLowerCase() === owner.toLowerCase());
      return { canCreate: ok, missingScopes: ok ? [] : [`installation:${owner}`] };
    }),

    getRepo: track("getRepo", (ref: RepoRef) => repos.get(key(ref))?.info ?? null),

    createRepo: track("createRepo", (input: CreateRepoInput) => {
      const existing = repos.get(key(input));
      if (existing) return assertOwnedRepo(kind, existing.info, input);
      const repo = makeRepo(input, input.defaultBranch, describeWithMarker(input));
      repo.info.visibility = input.visibility;
      return repo.info;
    }),

    commitFiles: track("commitFiles", (ref: RepoRef, input: CommitFilesInput) => {
      const repo = need(ref);
      let files = repo.branches.get(input.branch);
      if (!files) {
        const from = input.fromBranch && repo.branches.get(input.fromBranch);
        if (!from)
          throw new GitProviderError("not_found", `${host}: không có nhánh ${input.fromBranch ?? input.branch}`);
        files = new Map(from);
        repo.branches.set(input.branch, files);
      }
      for (const f of input.files) files.set(f.path, f.content);
      const sha = nextSha();
      repo.commits.push({ branch: input.branch, message: input.message, sha, paths: input.files.map((f) => f.path) });
      return { sha };
    }),

    protectBranch: track("protectBranch", (ref: RepoRef, branch: string, rules: BranchRules) => {
      const repo = need(ref);
      if (!repo.branches.has(branch)) throw new GitProviderError("not_found", `${host}: không có nhánh ${branch}`);
      repo.protection.set(branch, rules);
    }),

    openPR: track("openPR", (ref: RepoRef, input: PullRequestInput) => {
      const repo = need(ref);
      const open = repo.pulls.find((p) => p.head === input.head && p.base === input.base);
      if (open) return { number: open.number, url: open.url };
      const number = repo.pulls.length + 1;
      const url = `${repo.info.webUrl}/pull/${number}`;
      const headSha = repo.commits.findLast((c) => c.branch === input.head)?.sha ?? nextSha();
      repo.pulls.push({
        number,
        head: input.head,
        base: input.base,
        title: input.title,
        url,
        state: "open",
        draft: input.draft ?? false,
        headSha,
        mergeable: "clean",
      });
      return { number, url };
    }),

    getPR: track("getPR", (ref: RepoRef, number: number): PullRequestState | null => {
      const pr = need(ref).pulls.find((p) => p.number === number);
      if (!pr) return null;
      const { number: n, url, state, draft, head, headSha, base, mergeable } = pr;
      return { number: n, url, state, draft, head, headSha, base, mergeable };
    }),

    updatePRBranch: track("updatePRBranch", (ref: RepoRef, number: number, expectedHeadSha: string) => {
      const pr = pull(ref, number);
      if (pr.headSha !== expectedHeadSha || pr.mergeable === "conflict") {
        throw new GitProviderError("conflict", `${host}: không cập nhật được nhánh của PR ${number}`);
      }
      // Cập nhật nhánh tạo commit mới trên head: CI phải chạy lại trên sha mới.
      pr.headSha = nextSha();
      pr.mergeable = "clean";
    }),

    checksFor: track("checksFor", (ref: RepoRef, sha: string) => need(ref).checks.get(sha) ?? "none"),

    mergePR: track("mergePR", (ref: RepoRef, number: number, opts: { method: MergeMethod; sha: string }) => {
      const repo = need(ref);
      const pr = pull(ref, number);
      if (pr.state !== "open" || pr.draft || pr.mergeable !== "clean" || pr.headSha !== opts.sha) {
        throw new GitProviderError("conflict", `${host}: PR ${number} chưa merge được`);
      }
      const head = repo.branches.get(pr.head);
      const base = repo.branches.get(pr.base);
      if (head && base) for (const [path, content] of head) base.set(path, content);
      const sha = nextSha();
      pr.state = "merged";
      pr.merged = { method: opts.method, sha };
      return { sha };
    }),

    commentOnIssue: track("commentOnIssue", (ref: RepoRef, number: number, body: string, opts?: CommentOptions) => {
      const repo = need(ref);
      seq += 1;
      const id = String(seq);
      repo.comments.push({ id, number, body, pullRequest: opts?.pullRequest ?? false });
      return { id };
    }),

    canPush: track("canPush", (ref: RepoRef, user: ScmUser) => {
      need(ref);
      return (user.login !== null && pushers.has(user.login)) || (user.id !== null && pushers.has(String(user.id)));
    }),

    addWebhook: track("addWebhook", (ref: RepoRef, input: WebhookInput) => {
      const repo = need(ref);
      for (const [id, hook] of repo.hooks) {
        if (hook.url === input.url) {
          repo.hooks.set(id, input);
          return { id };
        }
      }
      seq += 1;
      const id = String(seq);
      repo.hooks.set(id, input);
      return { id };
    }),

    removeWebhook: track("removeWebhook", (ref: RepoRef, id: string) => {
      repos.get(key(ref))?.hooks.delete(id);
    }),

    // Repo giả chỉ giữ nội dung mới nhất của mỗi nhánh: sha đọc được là commit cuối của nhánh đó.
    branchHead: track("branchHead", (ref: RepoRef, branch: string) => headOf(need(ref), branch)),

    listFiles: track("listFiles", (ref: RepoRef, sha: string) => [...filesAt(need(ref), sha).keys()].sort()),

    readFile: track("readFile", (ref: RepoRef, path: string, sha: string) => filesAt(need(ref), sha).get(path) ?? null),

    prFiles: track("prFiles", (ref: RepoRef, number: number): PullRequestFile[] | null => {
      const repo = need(ref);
      const pr = repo.pulls.find((p) => p.number === number);
      return pr ? (pr.files ?? derivedFiles(repo, pr)) : null;
    }),

    setCommitStatus: track("setCommitStatus", (ref: RepoRef, sha: string, input: CommitStatusInput) => {
      const byContext = need(ref).statuses.get(sha) ?? new Map<string, CommitStatusInput>();
      byContext.set(input.context, {
        ...input,
        description: input.description.slice(0, COMMIT_STATUS_DESCRIPTION_MAX),
      });
      need(ref).statuses.set(sha, byContext);
    }),

    closePR: track("closePR", (ref: RepoRef, number: number) => {
      const pr = need(ref).pulls.find((p) => p.number === number);
      if (pr?.state === "open") pr.state = "closed";
    }),
  };
}
