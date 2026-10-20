import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyBranchEvent,
  type BranchEvent,
  branchNameError,
  cancelBranchJob,
  emptyBranchJob,
  fetchRemotes,
  GitBranchError,
  lastFetchedAt,
  listBranches,
  mergeBranch,
  type RepoBranches,
  resetKeepCommand,
  restoreCommand,
  scanBranches,
  switchBranch,
  useBranchJob,
  type WorktreeInfo,
  withWorktreeEvents,
} from "@/lib/git-branches.ts";
import { errorText } from "@/lib/tauri.ts";

interface Call {
  command: string;
  args?: Record<string, unknown> | undefined;
}

type Handler = (e: { payload: unknown }) => void;

// Tiến độ gom theo id ở cấp module: mỗi ca một id để ca trước không lẫn vào.
let seq = 0;
const nextJob = () => `git-${++seq}`;

let calls: Call[];
let handlers: Map<string, Set<Handler>>;
let replies: Record<string, (args?: Record<string, unknown>) => unknown>;

function emit(jobId: string, event: BranchEvent) {
  for (const h of handlers.get("git-branches:event") ?? []) h({ payload: { jobId, event } });
}

function installTauri() {
  calls = [];
  handlers = new Map();
  replies = {};
  window.__TAURI__ = {
    core: {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const reply = replies[command];
        return (reply ? reply(args) : undefined) as T;
      },
    },
    event: {
      listen: async <T>(name: string, handler: (e: { payload: T }) => void) => {
        const set = handlers.get(name) ?? new Set<Handler>();
        set.add(handler as Handler);
        handlers.set(name, set);
        return () => set.delete(handler as Handler);
      },
    },
  };
}

const worktree = (path: string, over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  path,
  isMain: false,
  locked: false,
  prunable: false,
  bare: false,
  state: "pending",
  submodule: false,
  ...over,
});

const repo = (worktrees: WorktreeInfo[]): RepoBranches => ({
  folder: "/Users/ha/Code/shop",
  defaultBranch: "main",
  current: {
    folder: "/Users/ha/Code/shop",
    branch: "main",
    detached: false,
    upstreamGone: false,
    dirty: false,
    untracked: false,
  },
  remotes: ["origin"],
  branches: [],
  worktrees,
  patterns: ["ai/*", "claude/*"],
  slowPath: false,
});

beforeEach(installTauri);

describe("useBranchJob", () => {
  it("chỉ nhận sự kiện của đúng job", async () => {
    const mine = nextJob();
    const other = nextJob();
    const { result } = renderHook(() => useBranchJob(mine));
    await waitFor(() => expect(handlers.get("git-branches:event")?.size).toBe(1));

    act(() => {
      emit(mine, {
        type: "progress",
        folder: "/a",
        step: "fetch",
        remote: "origin",
        result: "done",
        done: 0,
        total: 2,
      });
      emit(other, { type: "item", item: cleanResult("ai/X"), done: 1, total: 1 });
      emit(mine, { type: "item", item: cleanResult("ai/A"), done: 1, total: 2 });
    });

    expect(result.current?.items.map((i) => i.branch)).toEqual(["ai/A"]);
    expect(result.current?.remotes.origin?.result).toBe("done");
    expect(result.current).toMatchObject({ done: 1, total: 2, finished: false });

    act(() => emit(mine, { type: "done", total: 2, done: 2, summary: { removed: 1 } }));
    expect(result.current).toMatchObject({ finished: true, done: 2, result: { summary: { removed: 1 } } });
  });

  it("giữ sự kiện đến trước khi lệnh Tauri trả id", async () => {
    const id = nextJob();
    replies.git_branches_scan = () => {
      // Repo đầu xong trước khi invoke kịp trả id.
      emit(id, { type: "repo", folder: "/a", repo: scanRepo("/a"), done: 1, total: 1 });
      return id;
    };
    const jobId = await scanBranches(["/a"]);
    expect(jobId).toBe(id);
    expect(calls.at(-1)).toEqual({ command: "git_branches_scan", args: { folders: ["/a"], fetch: true } });

    const { result } = renderHook(() => useBranchJob(jobId));
    expect(Object.keys(result.current?.repos ?? {})).toEqual(["/a"]);
  });

  it("trả null khi chưa có job và cùng một đối tượng khi job chưa có sự kiện", () => {
    const { result: none } = renderHook(() => useBranchJob(null));
    expect(none.current).toBeNull();
    const id = nextJob();
    const { result, rerender } = renderHook(() => useBranchJob(id));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(first).toEqual(emptyBranchJob());
  });

  it("huỷ gửi git_branches_cancel với id của job", async () => {
    await cancelBranchJob("git-42");
    expect(calls).toEqual([{ command: "git_branches_cancel", args: { jobId: "git-42" } }]);
  });

  it("worker dừng giữa chừng thì job xong kèm lỗi", async () => {
    const id = nextJob();
    const { result } = renderHook(() => useBranchJob(id));
    await waitFor(() => expect(handlers.get("git-branches:event")?.size).toBe(1));
    act(() => emit(id, { type: "exit" }));
    expect(result.current).toMatchObject({ finished: true, error: "Worker dừng giữa chừng." });
  });
});

describe("applyBranchEvent", () => {
  it("done có lỗi thì giữ mã lỗi", () => {
    const job = applyBranchEvent(emptyBranchJob(), {
      type: "done",
      folder: "/a",
      error: { code: "diverged", message: "Nhánh đã tách", ahead: 2, behind: 1, upstream: "origin/x" },
    });
    expect(job).toMatchObject({ finished: true, errorCode: "diverged", error: "Nhánh đã tách" });
  });

  it("fetch xong ghi thời điểm fetch của thư mục", async () => {
    const id = nextJob();
    replies.git_branches_fetch = () => id;
    expect(await fetchRemotes("/Users/ha/Code/api")).toBe(id);
    act(() =>
      emit(id, { type: "done", folder: "/Users/ha/Code/api", fetched: ["origin"], fetchedAt: "2026-10-20T03:15:00Z" }),
    );
    expect(lastFetchedAt("/Users/ha/Code/api")).toBe("2026-10-20T03:15:00Z");
  });
});

describe("listBranches", () => {
  it("điền trạng thái worktree từ sự kiện của list", async () => {
    const id = nextJob();
    const main = worktree("/Users/ha/Code/shop", { isMain: true, state: "clean" });
    const linked = worktree("/Users/ha/Code/shop-wt/a");
    replies.git_branches_list = () => ({ ...repo([main, linked]), jobId: id });

    const list = await listBranches("/Users/ha/Code/shop");
    const { result } = renderHook(() => useBranchJob(list.jobId));
    expect(withWorktreeEvents(list, result.current).worktrees[1]?.state).toBe("pending");

    act(() =>
      emit(id, {
        type: "worktree",
        folder: list.folder,
        worktree: { ...linked, state: "dirty", files: ["a.ts"], filesTotal: 1 },
      }),
    );
    const merged = withWorktreeEvents(list, result.current);
    expect(merged.worktrees.map((w) => w.state)).toEqual(["clean", "dirty"]);
  });

  it("kết quả có error thì ném GitBranchError", async () => {
    replies.git_branches_list = () => ({
      error: { code: "not_repo", message: "Thư mục không còn hoặc không phải repo git.", path: "/x" },
    });
    const err = await listBranches("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitBranchError);
    expect((err as GitBranchError).code).toBe("not_repo");
    expect(errorText(err)).toBe("Thư mục không còn hoặc không phải repo git.");
  });
});

describe("wrapper", () => {
  it("switch theo dõi nhánh remote gửi track, không gửi branch", async () => {
    replies.git_branches_switch = () => ({ folder: "/a", branch: "x", head: "77aa", carried: false });
    await switchBranch("/a", { track: "origin/x" }, { carry: true });
    expect(calls[0]).toEqual({
      command: "git_branches_switch",
      args: { folder: "/a", branch: null, track: "origin/x", carry: true, confirmBusy: false },
    });
  });

  it("merge gửi mã đã đọc làm onto và trả operation", async () => {
    replies.git_branches_merge = () => ({
      operation: { kind: "merge", state: "conflict", conflicts: ["src/cart.ts"], conflictsTotal: 1 },
    });
    const op = await mergeBranch("/a", { name: "origin/main", tip: "df58" }, { ff: true });
    expect(op.state).toBe("conflict");
    expect(calls[0]?.args).toEqual({
      folder: "/a",
      onto: "df58",
      ontoName: "origin/main",
      ff: true,
      confirmBusy: false,
    });
  });

  it("dirty mang danh sách file trong lỗi", async () => {
    replies.git_branches_switch = () => ({
      error: { code: "dirty", message: "Thư mục có 1 file đang sửa.", files: ["README.md"], filesTotal: 1 },
    });
    await expect(switchBranch("/a", { branch: "main" })).rejects.toMatchObject({
      code: "dirty",
      info: { files: ["README.md"] },
    });
  });

  it("ngoài Tauri thì báo chỉ chạy được trong app", async () => {
    delete window.__TAURI__;
    await expect(switchBranch("/a", { branch: "main" })).rejects.toThrow("Chỉ chạy được trong app xDev Hive.");
  });
});

describe("branchNameError", () => {
  it.each(["feature/abc", "ai/GITBR-T003", "fix-1.2", "a@b"])("nhận %s", (name) => {
    expect(branchNameError(name)).toBeNull();
  });

  it.each([
    "",
    "  ",
    "@",
    "a b",
    "a..b",
    "-x",
    "a@{1}",
    "/a",
    "a/",
    "a//b",
    "a.",
    "a/.b",
    "a.lock",
    "x/y.lock/z",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[b",
    "a\\b",
    "a\tb",
  ])("từ chối %j", (name) => {
    expect(branchNameError(name)).not.toBeNull();
  });
});

describe("lệnh khôi phục", () => {
  it("tên thường không bọc", () => {
    expect(restoreCommand("ai/A", "aaaa")).toBe("git branch ai/A aaaa");
  });

  it("bọc tên có ký tự của shell", () => {
    expect(restoreCommand("ai/it's$x", "aaaa")).toBe("git branch 'ai/it'\\''s$x' aaaa");
    expect(restoreCommand("ai/it's$x", "aaaa", true)).toBe("git branch 'ai/it''s$x' aaaa");
  });

  it("reset --keep về mã trước thao tác", () => {
    expect(resetKeepCommand("9f1c")).toBe("git reset --keep 9f1c");
  });
});

function cleanResult(branch: string) {
  return {
    folder: "/a",
    branch,
    tip: "aaaa",
    result: "removed" as const,
    worktreeRemoved: false,
    branchDeleted: true,
  };
}

function scanRepo(folder: string) {
  return { folder, fetched: ["origin"], fetchFailed: [], candidates: [], blocked: [] };
}
