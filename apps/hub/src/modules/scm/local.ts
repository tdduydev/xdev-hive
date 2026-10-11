// GitProvider "local" CHỈ ĐỂ THỬ (scripts/e2e-smoke.ts): repo là bare repo git trong một thư mục tạm, PR là file JSON.
// Chỉ bật khi HIVE_E2E=1 và có HIVE_E2E_GIT_ROOT, để hub thật không bao giờ ghi repo vào đĩa của chính nó thay vì gọi
// GitHub/GitLab.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { GitProviderError } from "./errors.ts";
import { assertOwnedRepo, describeWithMarker } from "./shared.ts";
import type { GitProvider, GitProviderKind, RepoInfo, RepoRef } from "./types.ts";

const execFileAsync = promisify(execFile);

/**
 * Host của kết nối Git trỏ vào provider local. Hợp đồng chỉ có kind github/gitlab và baseUrl https, nên script tạo kết
 * nối GitLab với `https://hive-e2e.invalid`; TLD `.invalid` không bao giờ phân giải được (RFC 2606), nên tắt chế độ thử
 * thì kết nối này chỉ báo lỗi mạng chứ không trỏ nhầm sang máy chủ thật.
 */
export const LOCAL_E2E_HOST = "hive-e2e.invalid";

export interface LocalProviderOptions {
  /** Thư mục chứa bare repo, theo dạng `<root>/<owner>/<name>.git`. */
  root: string;
  /** Thư mục ghi file JSON của PR. */
  prDir: string;
}

/** Cấu hình provider local từ môi trường, hoặc undefined khi không ở chế độ thử. */
export function localProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): LocalProviderOptions | undefined {
  const root = env.HIVE_E2E_GIT_ROOT;
  if (env.HIVE_E2E !== "1" || !root) return undefined;
  // Đường dẫn tương đối sẽ đổi nghĩa theo thư mục chạy hub; script luôn truyền đường dẫn tuyệt đối.
  if (!isAbsolute(root)) throw new Error(`HIVE_E2E_GIT_ROOT phải là đường dẫn tuyệt đối: ${root}`);
  return { root, prDir: env.HIVE_E2E_PR_DIR || join(root, "_prs") };
}

export function isLocalConnection(conn: { baseUrl: string | null }): boolean {
  if (!conn.baseUrl) return false;
  try {
    return new URL(conn.baseUrl).hostname === LOCAL_E2E_HOST;
  } catch {
    return false;
  }
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
// Commit của hub cần danh tính git; máy CI không có cấu hình global.
const GIT_ENV = {
  GIT_AUTHOR_NAME: "xDev Hive",
  GIT_AUTHOR_EMAIL: `hive@${LOCAL_E2E_HOST}`,
  GIT_COMMITTER_NAME: "xDev Hive",
  GIT_COMMITTER_EMAIL: `hive@${LOCAL_E2E_HOST}`,
};

/** Nội dung file JSON mà openPR ghi; scripts/e2e-smoke.ts đọc lại để kiểm PR. */
export interface LocalPullRequest {
  number: number;
  owner: string;
  name: string;
  head: string;
  base: string;
  headSha: string;
  title: string;
  body: string;
  createdAt: string;
}

export function createLocalProvider(kind: GitProviderKind, opts: LocalProviderOptions): GitProvider {
  const repoPath = (ref: RepoRef) => {
    const parts = [...ref.owner.split("/"), ref.name];
    // owner/name đi thẳng vào đường dẫn file: chặn `..` để không ghi ra ngoài thư mục gốc.
    if (!parts.every((p) => SEGMENT.test(p) && p !== "." && p !== "..")) {
      throw new GitProviderError("invalid", `local: tên repo không hợp lệ ${ref.owner}/${ref.name}`);
    }
    const last = parts.pop() as string;
    return join(opts.root, ...parts, `${last}.git`);
  };

  const git = async (dir: string, args: string[], extra: { env?: Record<string, string>; stdin?: string } = {}) => {
    const pending = execFileAsync("git", args, { cwd: dir, env: { ...process.env, ...GIT_ENV, ...extra.env } });
    if (extra.stdin !== undefined) pending.child.stdin?.end(extra.stdin);
    const { stdout } = await pending;
    return stdout.trim();
  };

  const exists = (p: string) =>
    access(p).then(
      () => true,
      () => false,
    );

  const info = async (ref: RepoRef, dir: string): Promise<RepoInfo> => {
    const head = await git(dir, ["symbolic-ref", "--short", "HEAD"]);
    const description = (await readFile(join(dir, "description"), "utf8").catch(() => "")).trim();
    const url = pathToFileURL(dir).href;
    return {
      id: createHash("sha256").update(dir).digest("hex").slice(0, 12),
      owner: ref.owner,
      name: ref.name,
      defaultBranch: head,
      visibility: "private",
      description,
      // Worker clone và push thẳng qua file://, không cần token.
      httpUrl: url,
      sshUrl: url,
      webUrl: url,
    };
  };

  const need = async (ref: RepoRef) => {
    const dir = repoPath(ref);
    if (!(await exists(dir))) throw new GitProviderError("not_found", `local: không tìm thấy ${ref.owner}/${ref.name}`);
    return dir;
  };

  const branchSha = (dir: string, branch: string) =>
    git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).catch(() => null);

  /**
   * Một commit vào bare repo bằng lệnh plumbing: không cần worktree, giống API commit của GitHub/GitLab. `current` là
   * sha nhánh đang trỏ tới, null khi nhánh chưa có.
   */
  const commit = async (
    dir: string,
    branch: string,
    { parent, current }: { parent: string | null; current: string | null },
    message: string,
    files: Array<{ path: string; content: string }>,
  ) => {
    // Index riêng cho mỗi commit, để hai bước saga chạy song song không ghi đè index của nhau.
    const env = { GIT_INDEX_FILE: join(dir, `hive-index-${process.pid}-${Date.now()}-${Math.random()}`) };
    try {
      await git(dir, parent ? ["read-tree", parent] : ["read-tree", "--empty"], { env });
      for (const f of files) {
        const blob = await git(dir, ["hash-object", "-w", "--stdin"], { stdin: f.content });
        await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${f.path}`], { env });
      }
      const tree = await git(dir, ["write-tree"], { env });
      const sha = await git(dir, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]);
      // Kèm giá trị cũ để update-ref từ chối khi nhánh vừa đổi (chuỗi rỗng: nhánh phải chưa có), như API của
      // GitHub/GitLab từ chối commit không fast-forward.
      await git(dir, ["update-ref", `refs/heads/${branch}`, sha, current ?? ""]);
      return sha;
    } finally {
      await rm(env.GIT_INDEX_FILE, { force: true });
    }
  };

  return {
    kind,

    async checkAccess() {
      return { canCreate: true, missingScopes: [] };
    },

    async getRepo(ref) {
      const dir = repoPath(ref);
      return (await exists(dir)) ? info(ref, dir) : null;
    },

    async createRepo(input) {
      const dir = repoPath(input);
      if (await exists(dir)) return assertOwnedRepo(kind, await info(input, dir), input);
      await mkdir(dir, { recursive: true });
      await git(dir, ["init", "--bare", "--quiet", `--initial-branch=${input.defaultBranch}`]);
      await writeFile(join(dir, "description"), `${describeWithMarker(input)}\n`);
      // Repo mới trên GitHub/GitLab (auto_init) có sẵn README; làm giống để worker fetch được nhánh chính.
      await commit(dir, input.defaultBranch, { parent: null, current: null }, "Initial commit", [
        { path: "README.md", content: `# ${input.name}\n` },
      ]);
      return info(input, dir);
    },

    async commitFiles(ref, input) {
      const dir = await need(ref);
      const current = await branchSha(dir, input.branch);
      const parent = current ?? (input.fromBranch ? await branchSha(dir, input.fromBranch) : null);
      if (!parent) throw new GitProviderError("not_found", `local: không có nhánh ${input.fromBranch ?? input.branch}`);
      return { sha: await commit(dir, input.branch, { parent, current }, input.message, input.files) };
    },

    async protectBranch(ref, branch) {
      // Bare repo không có luật bảo vệ nhánh; chỉ kiểm nhánh có thật như provider thật.
      const dir = await need(ref);
      if (!(await branchSha(dir, branch))) throw new GitProviderError("not_found", `local: không có nhánh ${branch}`);
    },

    async openPR(ref, input) {
      const dir = await need(ref);
      const headSha = await branchSha(dir, input.head);
      if (!headSha) throw new GitProviderError("not_found", `local: không có nhánh ${input.head}`);
      await mkdir(opts.prDir, { recursive: true });
      const file = join(
        opts.prDir,
        `${[...ref.owner.split("/"), ref.name, input.head.replaceAll("/", "_")].join("__")}.json`,
      );
      const url = pathToFileURL(file).href;
      // PR cùng head đang mở thì trả lại, như GitHub/GitLab.
      const existing = await readFile(file, "utf8").catch(() => null);
      if (existing) return { number: (JSON.parse(existing) as LocalPullRequest).number, url };
      const pr: LocalPullRequest = {
        number: (Date.now() % 1_000_000) + 1,
        owner: ref.owner,
        name: ref.name,
        head: input.head,
        base: input.base,
        headSha,
        title: input.title,
        body: input.body,
        createdAt: new Date().toISOString(),
      };
      await writeFile(file, `${JSON.stringify(pr, null, 2)}\n`);
      return { number: pr.number, url };
    },

    async commentOnIssue(ref, number, body, commentOpts) {
      // Ghi bình luận cạnh file PR để script kiểm được Hive đã trả lời.
      const dir = await need(ref);
      const file = join(dir, "hive-comments.jsonl");
      const id = String(Date.now());
      await appendFile(
        file,
        `${JSON.stringify({ id, number, body, pullRequest: commentOpts?.pullRequest ?? false })}\n`,
      );
      return { id };
    },

    async canPush() {
      // Chế độ thử chỉ có người chạy script.
      return true;
    },

    async addWebhook(ref, input) {
      // Repo trên đĩa không gọi webhook về được; chỉ ghi lại URL và sự kiện, không ghi secret.
      const dir = await need(ref);
      await writeFile(join(dir, "hive-webhook.json"), `${JSON.stringify({ url: input.url, events: input.events })}\n`);
      return { id: "local" };
    },

    async removeWebhook() {},
  };
}
