import { GitProviderError } from "./errors.ts";
import type { JobEvent, PipelineEvent } from "./events.ts";
import { assertOwnedRepo, describeWithMarker } from "./shared.ts";
import type {
  AccessCheck,
  BranchRules,
  ChecksState,
  CiJob,
  CiPipeline,
  CiStatus,
  CommentOptions,
  CommitFilesInput,
  CommitStatusInput,
  CompareCommit,
  CreateRepoInput,
  GitProvider,
  GitProviderKind,
  ListPipelinesOptions,
  MergeMethod,
  PullRequestFile,
  PullRequestInput,
  PullRequestState,
  RepoInfo,
  RepoRef,
  ReviewComment,
  ReviewCommentInput,
  ScmUser,
  WebhookInput,
} from "./types.ts";
import { CI_ACTIVE_STATUSES, COMMIT_STATUS_DESCRIPTION_MAX } from "./types.ts";

type Method = Exclude<keyof GitProvider, "kind">;

export interface MemoryRepo {
  info: RepoInfo;
  modes?: { truncated?: boolean; incomplete?: boolean };
  /** Nội dung file theo nhánh. */
  branches: Map<string, Map<string, string>>;
  commits: Array<{
    branch: string;
    message: string;
    sha: string;
    paths: string[];
    snapshot: Map<string, string>;
    at?: string;
  }>;
  /** Ảnh chụp nhánh chính lúc tạo repo, khóa theo sha `<nhánh>@init`; không phải commit nên không nằm trong `commits`. */
  initial: Map<string, Map<string, string>>;
  protection: Map<string, BranchRules>;
  hooks: Map<string, WebhookInput>;
  pulls: MemoryPull[];
  comments: Array<{ id: string; number: number; body: string; pullRequest: boolean }>;
  /** Kết quả CI theo sha; sha không có trong map là `none`. */
  checks: Map<string, ChecksState>;
  /** Commit status theo `sha` rồi `context`; đặt lại cùng context thì ghi đè như nhà cung cấp thật. */
  statuses: Map<string, Map<string, CommitStatusInput>>;
  pipelines: CiPipeline[];
  /** Job của mọi pipeline, theo thứ tự pipelineJobs trả. */
  jobs: MemoryJob[];
}

export interface MemoryJob extends CiJob {
  log: string;
  /** Đã có job mới thay sau retry; như GitLab, pipelineJobs không trả job này nữa. */
  retried: boolean;
}

export interface MemoryPipelineInput {
  /** Mặc định nhánh mặc định của repo. */
  ref?: string;
  /** Mặc định head của `ref`. */
  sha?: string;
  /** Mặc định `running`. */
  status?: CiStatus;
  source?: string;
  jobs?: Array<{ name: string; stage?: string; status?: CiStatus; log?: string; allowFailure?: boolean }>;
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
  seedRepo(
    ref: RepoRef,
    opts?: { defaultBranch?: string; files?: Record<string, string>; truncated?: boolean; incomplete?: boolean },
  ): MemoryRepo;
  /** Đổi trạng thái PR (merge tay, đóng, nhánh chính tiến...) như người dùng làm trên GitHub/GitLab. */
  setPull(ref: RepoRef, number: number, patch: Partial<Omit<MemoryPull, "number">>): MemoryPull;
  setChecks(ref: RepoRef, sha: string, state: ChecksState): void;
  /** Tạo pipeline như GitLab vừa chạy, kèm job theo thứ tự cho trước (mặc định job `pending`). */
  seedPipeline(ref: RepoRef, input?: MemoryPipelineInput): { pipeline: CiPipeline; jobs: CiJob[] };
  setPipeline(ref: RepoRef, pipelineId: string, patch: Partial<Omit<CiPipeline, "id">>): CiPipeline;
  /** Đổi trạng thái job; `appendLog` ghi thêm vào cuối log như runner đang chạy. */
  setJob(ref: RepoRef, jobId: string, patch: Partial<Omit<CiJob, "id" | "pipelineId">> & { appendLog?: string }): CiJob;
  /** Sự kiện như webhook Pipeline Hook đã chuẩn hoá, theo trạng thái hiện tại; test đưa vào handler của onScmEvent. */
  pipelineEvent(ref: RepoRef, pipelineId: string): PipelineEvent;
  jobEvent(ref: RepoRef, jobId: string): JobEvent;
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
  const reviewComments = new Map<string, ReviewComment[]>();
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
      initial: new Map([[`${defaultBranch}@init`, new Map([["README.md", `# ${ref.name}\n`]])]]),
      protection: new Map(),
      hooks: new Map(),
      pulls: [],
      comments: [],
      checks: new Map(),
      statuses: new Map(),
      pipelines: [],
      jobs: [],
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
    const commit = repo.commits.find((item) => item.sha === sha);
    if (commit) return new Map(commit.snapshot);
    const initial = repo.initial.get(sha);
    if (initial) return new Map(initial);
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

  /** Commit sau `from` tới hết `to`, cùng nhánh với `to`, cũ tới mới. */
  const commitsBetween = (repo: MemoryRepo, from: string, to: string): CompareCommit[] => {
    const end = repo.commits.findIndex((c) => c.sha === to);
    const branch = repo.commits[end]?.branch;
    if (branch === undefined) return [];
    const start = repo.commits.findIndex((c) => c.sha === from);
    return repo.commits
      .slice(start + 1, end + 1)
      .filter((c) => c.branch === branch)
      .map((c) => ({
        sha: c.sha,
        title: c.message.split("\n", 1)[0] ?? "",
        author: "hive",
        authoredAt: c.at ?? null,
      }));
  };

  const pipelineOf = (repo: MemoryRepo, id: string): CiPipeline => {
    const p = repo.pipelines.find((item) => item.id === id);
    if (!p) throw new GitProviderError("not_found", `${host}: không có pipeline ${id}`);
    return p;
  };
  const jobOf = (repo: MemoryRepo, id: string): MemoryJob => {
    const j = repo.jobs.find((item) => item.id === id);
    if (!j) throw new GitProviderError("not_found", `${host}: không có job ${id}`);
    return j;
  };
  const jobView = ({ log: _log, retried: _retried, ...job }: MemoryJob): CiJob => ({ ...job });
  const isActive = (status: CiStatus) => CI_ACTIVE_STATUSES.includes(status);
  const wrongState = (what: string) => new GitProviderError("invalid", `${host}: ${what}`, { status: 400 });

  /** Như GitLab: job cũ ẩn đi, job mới đứng ngay chỗ job cũ trong danh sách. */
  const retryJobIn = (repo: MemoryRepo, job: MemoryJob): MemoryJob => {
    seq += 1;
    const again: MemoryJob = {
      ...job,
      id: String(seq),
      status: "pending",
      failureReason: null,
      startedAt: null,
      finishedAt: null,
      durationSec: null,
      log: "",
      retried: false,
    };
    job.retried = true;
    repo.jobs.splice(repo.jobs.indexOf(job) + 1, 0, again);
    return again;
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
      repo.modes = {
        ...(opts.truncated !== undefined ? { truncated: opts.truncated } : {}),
        ...(opts.incomplete !== undefined ? { incomplete: opts.incomplete } : {}),
      };
      const files = repo.branches.get(repo.info.defaultBranch);
      for (const [p, c] of Object.entries(opts.files ?? {})) files?.set(p, c);
      if (files) repo.initial.set(`${repo.info.defaultBranch}@init`, new Map(files));
      return repo;
    },
    setPull(ref, number, patch) {
      return Object.assign(pull(ref, number), patch);
    },
    setChecks(ref, sha, state) {
      need(ref).checks.set(sha, state);
    },
    seedPipeline(ref, input = {}) {
      const repo = need(ref);
      const branch = input.ref ?? repo.info.defaultBranch;
      const sha = input.sha ?? headOf(repo, branch) ?? nextSha();
      seq += 1;
      const now = new Date().toISOString();
      const pipeline: CiPipeline = {
        id: String(seq),
        ref: branch,
        sha,
        status: input.status ?? "running",
        source: input.source ?? "push",
        url: `${repo.info.webUrl}/-/pipelines/${seq}`,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        finishedAt: null,
        durationSec: null,
        user: null,
      };
      repo.pipelines.push(pipeline);
      const jobs = (input.jobs ?? []).map((j) => {
        seq += 1;
        const job: MemoryJob = {
          id: String(seq),
          pipelineId: pipeline.id,
          name: j.name,
          stage: j.stage ?? "test",
          ref: branch,
          sha,
          status: j.status ?? "pending",
          allowFailure: j.allowFailure ?? false,
          failureReason: null,
          url: `${repo.info.webUrl}/-/jobs/${seq}`,
          createdAt: now,
          startedAt: null,
          finishedAt: null,
          durationSec: null,
          user: null,
          log: j.log ?? "",
          retried: false,
        };
        repo.jobs.push(job);
        return jobView(job);
      });
      return { pipeline: { ...pipeline }, jobs };
    },
    setPipeline(ref, pipelineId, patch) {
      return { ...Object.assign(pipelineOf(need(ref), pipelineId), patch) };
    },
    setJob(ref, jobId, { appendLog, ...patch }) {
      const job = Object.assign(jobOf(need(ref), jobId), patch);
      if (appendLog) job.log += appendLog;
      return jobView(job);
    },
    pipelineEvent(ref, pipelineId) {
      const repo = need(ref);
      const pipeline = { ...pipelineOf(repo, pipelineId) };
      return {
        provider: kind,
        repo: `${repo.info.owner}/${repo.info.name}`,
        actor: null,
        actorId: null,
        kind: "pipeline",
        pipeline,
      };
    },
    jobEvent(ref, jobId) {
      const repo = need(ref);
      const job = jobView(jobOf(repo, jobId));
      return {
        provider: kind,
        repo: `${repo.info.owner}/${repo.info.name}`,
        actor: null,
        actorId: null,
        kind: "job",
        job,
      };
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
      const currentHead = headOf(repo, input.branch);
      if (input.expectedHead && input.expectedHead !== currentHead)
        throw new GitProviderError("conflict", `${host}: nhánh đã thay đổi`);
      if (repo.protection.get(input.branch)?.requirePullRequest)
        throw new GitProviderError("forbidden", `${host}: nhánh được bảo vệ`, { status: 403 });
      let files = repo.branches.get(input.branch);
      if (!files) {
        const from = input.fromBranch && repo.branches.get(input.fromBranch);
        if (!from)
          throw new GitProviderError("not_found", `${host}: không có nhánh ${input.fromBranch ?? input.branch}`);
        files = new Map(from);
        repo.branches.set(input.branch, files);
      }
      files = new Map(files);
      repo.branches.set(input.branch, files);
      for (const f of input.files) {
        if ("delete" in f) files.delete(f.path);
        else if ("previousPath" in f) {
          const content = files.get(f.previousPath);
          files.delete(f.previousPath);
          if (content !== undefined) files.set(f.path, content);
        } else files.set(f.path, "bytes" in f ? new TextDecoder().decode(f.bytes) : f.content);
      }
      const sha = nextSha();
      repo.commits.push({
        branch: input.branch,
        message: input.message,
        sha,
        paths: input.files.map((f) => f.path),
        snapshot: new Map(files),
        at: new Date().toISOString(),
      });
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

    listReviewComments: track("listReviewComments", (ref: RepoRef, number: number) =>
      (reviewComments.get(`${key(ref)}#${number}`) ?? []).map((comment) => ({ ...comment })),
    ),
    createReviewComment: track("createReviewComment", (ref: RepoRef, number: number, input: ReviewCommentInput) => {
      need(ref);
      seq += 1;
      const id = String(seq);
      const comment: ReviewComment = {
        ...input,
        id,
        threadId: id,
        author: "hive",
        url: null,
        updatedAt: new Date().toISOString(),
        resolved: false,
        inReplyToId: null,
      };
      const list = reviewComments.get(`${key(ref)}#${number}`) ?? [];
      list.push(comment);
      reviewComments.set(`${key(ref)}#${number}`, list);
      return comment;
    }),
    replyReviewComment: track("replyReviewComment", (ref: RepoRef, number: number, threadId: string, body: string) => {
      need(ref);
      const list = reviewComments.get(`${key(ref)}#${number}`) ?? [];
      const parent = list.find((comment) => comment.id === threadId || comment.threadId === threadId);
      if (!parent) throw new GitProviderError("not_found", `${host}: không tìm thấy luồng ${threadId}`);
      seq += 1;
      const comment: ReviewComment = {
        ...parent,
        id: String(seq),
        body,
        updatedAt: new Date().toISOString(),
        inReplyToId: parent.id,
      };
      list.push(comment);
      return comment;
    }),
    editReviewComment: track("editReviewComment", (ref: RepoRef, number: number, commentId: string, body: string) => {
      need(ref);
      const comment = (reviewComments.get(`${key(ref)}#${number}`) ?? []).find((item) => item.id === commentId);
      if (!comment) throw new GitProviderError("not_found", `${host}: không tìm thấy bình luận ${commentId}`);
      comment.body = body;
      comment.updatedAt = new Date().toISOString();
      return { ...comment };
    }),
    deleteReviewComment: track("deleteReviewComment", (ref: RepoRef, number: number, commentId: string) => {
      need(ref);
      const list = reviewComments.get(`${key(ref)}#${number}`) ?? [];
      const index = list.findIndex((item) => item.id === commentId);
      if (index < 0) throw new GitProviderError("not_found", `${host}: không tìm thấy bình luận ${commentId}`);
      list.splice(index, 1);
    }),
    setReviewThreadResolved: track(
      "setReviewThreadResolved",
      (ref: RepoRef, number: number, threadId: string, resolved: boolean) => {
        need(ref);
        const list = reviewComments.get(`${key(ref)}#${number}`) ?? [];
        const found = list.filter((item) => item.threadId === threadId);
        if (!found.length) throw new GitProviderError("not_found", `${host}: không tìm thấy luồng ${threadId}`);
        for (const comment of found) comment.resolved = resolved;
      },
    ),

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

    listFiles: track("listFiles", (ref: RepoRef, sha: string) => {
      const paths = [...filesAt(need(ref), sha).keys()].sort();
      return need(ref).modes?.truncated ? paths.slice(0, Math.max(1, Math.floor(paths.length / 2))) : paths;
    }),

    readFile: track("readFile", (ref: RepoRef, path: string, sha: string) => filesAt(need(ref), sha).get(path) ?? null),
    readFileBytes: track("readFileBytes", (ref: RepoRef, path: string, sha: string) => {
      const file = filesAt(need(ref), sha).get(path);
      return file === undefined ? null : new TextEncoder().encode(file);
    }),
    readBlob: track("readBlob", (ref: RepoRef, blob: string) => {
      const file = [...need(ref).branches.values()]
        .flatMap((files) => [...files.values()])
        .find((content) => content === blob);
      if (file === undefined) throw new GitProviderError("not_found", `${host}: không có blob ${blob}`);
      return new TextEncoder().encode(file);
    }),
    compare: track("compare", (ref: RepoRef, from: string, to: string) => {
      const repo = need(ref);
      const fromFiles = filesAt(repo, from);
      const toFiles = filesAt(repo, to);
      const files = [...new Set([...fromFiles.keys(), ...toFiles.keys()])].flatMap((path) => {
        const oldValue = fromFiles.get(path),
          newValue = toFiles.get(path);
        if (oldValue === newValue) return [];
        return [
          {
            path,
            status:
              newValue === undefined
                ? ("removed" as const)
                : oldValue === undefined
                  ? ("added" as const)
                  : ("modified" as const),
            sha: newValue ?? null,
          },
        ];
      });
      return { files, commits: commitsBetween(repo, from, to), incomplete: Boolean(repo.modes?.incomplete) };
    }),
    archive: track("archive", async (ref: RepoRef, sha: string, path?: string) => {
      const entries = [...filesAt(need(ref), sha)].filter(
        ([name]) => !path || name.startsWith(`${path}/`) || name === path,
      );
      const bytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(entries)));
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    }),
    lfsBatch: track(
      "lfsBatch",
      (_ref: RepoRef, _operation: "upload" | "download", objects: { oid: string; size: number }[]) => ({
        objects: objects.map((object) => ({ ...object, actions: {} })),
      }),
    ),

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

    listPipelines: track("listPipelines", (ref: RepoRef, opts: ListPipelinesOptions) => {
      const perPage = opts.perPage ?? 20;
      const all = need(ref)
        .pipelines.filter(
          (p) =>
            (!opts.branch || p.ref === opts.branch) &&
            (!opts.sha || p.sha === opts.sha) &&
            (!opts.status || p.status === opts.status),
        )
        .sort((a, b) => Number(b.id) - Number(a.id));
      const start = (opts.page - 1) * perPage;
      return {
        items: all.slice(start, start + perPage).map((p) => ({ ...p })),
        nextPage: start + perPage < all.length ? opts.page + 1 : null,
      };
    }),
    pipelineJobs: track("pipelineJobs", (ref: RepoRef, pipelineId: string) => {
      const repo = need(ref);
      pipelineOf(repo, pipelineId);
      return repo.jobs.filter((j) => j.pipelineId === pipelineId && !j.retried).map(jobView);
    }),
    jobLog: track("jobLog", (ref: RepoRef, jobId: string, from: number) => {
      const job = jobOf(need(ref), jobId);
      const bytes = new TextEncoder().encode(job.log);
      const complete = !isActive(job.status);
      if (from >= bytes.length) return { text: "", next: from, complete };
      return { text: new TextDecoder().decode(bytes.subarray(from)), next: bytes.length, complete };
    }),
    retryPipeline: track("retryPipeline", (ref: RepoRef, pipelineId: string) => {
      const repo = need(ref);
      const pipeline = pipelineOf(repo, pipelineId);
      const failed = repo.jobs.filter(
        (j) => j.pipelineId === pipelineId && !j.retried && (j.status === "failed" || j.status === "canceled"),
      );
      for (const job of failed) retryJobIn(repo, job);
      pipeline.status = "pending";
      pipeline.finishedAt = null;
      return { ...pipeline };
    }),
    cancelPipeline: track("cancelPipeline", (ref: RepoRef, pipelineId: string) => {
      const repo = need(ref);
      const pipeline = pipelineOf(repo, pipelineId);
      for (const job of repo.jobs)
        if (job.pipelineId === pipelineId && !job.retried && isActive(job.status)) job.status = "canceled";
      pipeline.status = "canceled";
      return { ...pipeline };
    }),
    retryJob: track("retryJob", (ref: RepoRef, jobId: string) => {
      const repo = need(ref);
      const job = jobOf(repo, jobId);
      if (job.retried || !["success", "failed", "canceled"].includes(job.status))
        throw wrongState(`job ${jobId} chưa dừng nên chưa chạy lại được`);
      return jobView(retryJobIn(repo, job));
    }),
    cancelJob: track("cancelJob", (ref: RepoRef, jobId: string) => {
      const job = jobOf(need(ref), jobId);
      if (!isActive(job.status)) throw wrongState(`job ${jobId} không còn chạy nên không huỷ được`);
      job.status = "canceled";
      return jobView(job);
    }),
    playJob: track("playJob", (ref: RepoRef, jobId: string) => {
      const job = jobOf(need(ref), jobId);
      if (job.status !== "manual") throw wrongState(`job ${jobId} không chờ bấm tay`);
      job.status = "pending";
      return jobView(job);
    }),
  };
}
