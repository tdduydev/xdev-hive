import { GitProviderError } from "./errors.ts";
import { assertOwnedRepo, describeWithMarker } from "./shared.ts";
import type {
  AccessCheck,
  BranchRules,
  CommitFilesInput,
  CreateRepoInput,
  GitProvider,
  GitProviderKind,
  PullRequestInput,
  RepoInfo,
  RepoRef,
  WebhookInput,
} from "./types.ts";

type Method = Exclude<keyof GitProvider, "kind">;

export interface MemoryRepo {
  info: RepoInfo;
  /** Nội dung file theo nhánh. */
  branches: Map<string, Map<string, string>>;
  commits: Array<{ branch: string; message: string; sha: string; paths: string[] }>;
  protection: Map<string, BranchRules>;
  hooks: Map<string, WebhookInput>;
  pulls: Array<{ number: number; head: string; base: string; title: string; url: string }>;
}

export interface MemoryProvider extends GitProvider {
  readonly repos: Map<string, MemoryRepo>;
  /** Owner mà provider có quyền tạo repo; owner khác thì checkAccess báo thiếu quyền. */
  readonly owners: Set<string>;
  readonly calls: Array<{ method: Method; args: unknown[] }>;
  /** Mọi lời gọi `method` ném lỗi này cho tới khi gọi lại với null. */
  fail(method: Method, error: GitProviderError | null): void;
  /** Thêm repo có sẵn (không do hub tạo). */
  seedRepo(ref: RepoRef, opts?: { defaultBranch?: string; files?: Record<string, string> }): MemoryRepo;
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
    };
    repos.set(key(ref), repo);
    return repo;
  };

  const need = (ref: RepoRef): MemoryRepo => {
    const repo = repos.get(key(ref));
    if (!repo) throw new GitProviderError("not_found", `${host}: không tìm thấy ${ref.owner}/${ref.name}`);
    return repo;
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
      seq += 1;
      const sha = seq.toString(16).padStart(40, "0");
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
      repo.pulls.push({ number, head: input.head, base: input.base, title: input.title, url });
      return { number, url };
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
  };
}
