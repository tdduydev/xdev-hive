import type { BranchError, BranchInfo, BranchStatus, RepoBranches, WorktreeInfo } from "@/lib/git-branches.ts";

// Dựng dữ liệu và Tauri giả cho test của hộp thoại đổi nhánh, tạo nhánh (không phải test, vitest không nạp file này).

export const FOLDER = "/Users/ha/Code/shop";

export interface Call {
  command: string;
  args?: Record<string, unknown> | undefined;
}

export const status = (over: Partial<BranchStatus> = {}): BranchStatus => ({
  folder: FOLDER,
  branch: "main",
  detached: false,
  upstreamGone: false,
  dirty: false,
  untracked: false,
  ...over,
});

export const branch = (name: string, over: Partial<BranchInfo> = {}): BranchInfo => ({
  name,
  ref: `refs/heads/${name}`,
  kind: "local",
  upstreamGone: false,
  tip: "1a2b3c4",
  committedAt: 1_792_000_000,
  isCurrent: false,
  isDefault: false,
  matchesPattern: false,
  ...over,
});

export const remoteBranch = (name: string, over: Partial<BranchInfo> = {}): BranchInfo =>
  branch(`origin/${name}`, { ref: `refs/remotes/origin/${name}`, kind: "remote", remote: "origin", ...over });

export const worktree = (path: string, over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  path,
  isMain: false,
  locked: false,
  prunable: false,
  bare: false,
  state: "clean",
  submodule: false,
  ...over,
});

export const repoOf = (over: Partial<RepoBranches> = {}): RepoBranches => ({
  folder: FOLDER,
  defaultBranch: "main",
  defaultRef: "refs/remotes/origin/main",
  current: status(),
  remotes: ["origin"],
  branches: [branch("main", { isCurrent: true, isDefault: true, worktreePath: FOLDER })],
  worktrees: [worktree(FOLDER, { isMain: true, branch: "main" })],
  patterns: ["ai/*"],
  slowPath: false,
  ...over,
});

export const failure = (code: BranchError["code"], over: Partial<BranchError> = {}) => ({
  error: { code, message: `lỗi ${code}`, ...over } satisfies BranchError,
});

export type Handler = (args?: Record<string, unknown>) => unknown;

/** Tauri giả: mỗi lệnh một hàm; lệnh chưa giả thì lỗi để test không âm thầm gọi nhầm. */
export function fakeTauri(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const h = handlers[command];
        if (!h) throw new Error(`lệnh chưa giả: ${command}`);
        return (await h(args)) as T;
      },
    },
    event: { listen: async () => () => {} },
  };
  return {
    calls,
    named: (command: string) => calls.filter((c) => c.command === command).map((c) => c.args),
  };
}

/** Khớp theo toàn bộ chữ của phần tử: câu thông báo có tên nhánh nằm trong thẻ riêng nên `findByText(chuỗi)` không thấy. */
export const sentence = (expected: string) => (_: string, el: Element | null) =>
  el?.tagName === "P" && el.textContent === expected;
