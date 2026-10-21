import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchesSheet, RepoBranchStatus, sortBranches } from "@/components/branches-sheet.tsx";
import type { BranchEvent, BranchInfo, BranchStatus, RepoBranches, WorktreeInfo } from "@/lib/git-branches.ts";
import { setLang } from "@/lib/i18n.ts";
import type { LocalProject, LocalProjects } from "@/lib/local-projects.ts";
import { ProjectsScreen } from "@/screens/projects-screen.tsx";

const FOLDER = "/Users/ha/Code/shop";

interface Call {
  command: string;
  args?: Record<string, unknown> | undefined;
}

// Tiến độ gom theo id ở cấp module (lib/git-branches.ts): mỗi ca một id để ca trước không lẫn vào.
let seq = 0;

const status = (over: Partial<BranchStatus> = {}): BranchStatus => ({
  folder: FOLDER,
  branch: "main",
  detached: false,
  upstreamGone: false,
  dirty: false,
  untracked: false,
  ...over,
});

const branch = (name: string, over: Partial<BranchInfo> = {}): BranchInfo => ({
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

const remoteBranch = (name: string, over: Partial<BranchInfo> = {}): BranchInfo =>
  branch(`origin/${name}`, { ref: `refs/remotes/origin/${name}`, kind: "remote", remote: "origin", ...over });

const worktree = (path: string, over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  path,
  isMain: false,
  locked: false,
  prunable: false,
  bare: false,
  state: "clean",
  submodule: false,
  ...over,
});

const repoOf = (over: Partial<RepoBranches> = {}): RepoBranches => ({
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

/** Tauri giả: `list` trả bảng cố định, `fetch` trả id job để test phát sự kiện như Rust. */
function fakeApp(opts: { repo?: RepoBranches; statuses?: BranchStatus[]; local?: LocalProject[] } = {}) {
  const calls: Call[] = [];
  const listJob = `git-${++seq}`;
  const fetchJob = `git-${++seq}`;
  const listeners: ((e: { payload: unknown }) => void)[] = [];
  const local = opts.local ?? [];
  const view = (): LocalProjects => ({ path: "/x/projects.json", exists: true, imported: 0, projects: local });
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    git_branches_list: () => ({ ...(opts.repo ?? repoOf()), jobId: listJob }),
    git_branches_fetch: () => fetchJob,
    git_branches_status: () => ({ repos: opts.statuses ?? [] }),
    local_projects: view,
    git_groups: () => ({ path: "/x/gitgroups.json", hosts: [], groups: [] }),
    open_agent_terminal: () => null,
  };
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const h = handlers[command];
        if (!h) throw new Error(`lệnh chưa giả: ${command}`);
        return (await h(args)) as T;
      },
    },
    event: {
      listen: async <T,>(_name: string, handler: (e: { payload: T }) => void) => {
        listeners.push(handler as (e: { payload: unknown }) => void);
        return () => {};
      },
    },
  };
  const emit = (jobId: string, event: BranchEvent) =>
    act(() => {
      for (const l of listeners) l({ payload: { jobId, event } });
    });
  return { calls, emit, listJob, fetchJob };
}

const renderSheet = (props: Partial<Parameters<typeof BranchesSheet>[0]> = {}) =>
  render(<BranchesSheet folder={FOLDER} name="shop" onClose={() => {}} onChanged={() => {}} {...props} />);

const many = (n: number, make: (i: number) => BranchInfo) => Array.from({ length: n }, (_, i) => make(i));

beforeEach(() => setLang("vi"));

describe("sortBranches", () => {
  it("nhánh đang đứng ở đầu, còn lại mới commit trước (FR-003)", () => {
    const sorted = sortBranches([
      branch("cu", { committedAt: 100 }),
      branch("moi", { committedAt: 300 }),
      branch("dang-dung", { committedAt: 50, isCurrent: true }),
      branch("giua", { committedAt: 200 }),
    ]);
    expect(sorted.map((b) => b.name)).toEqual(["dang-dung", "moi", "giua", "cu"]);
  });
});

describe("RepoBranchStatus", () => {
  it("hiện nhánh, chấm sạch/có thay đổi và ↑N ↓M (FR-001)", async () => {
    const onOpen = vi.fn();
    render(
      <RepoBranchStatus
        status={status({ branch: "feature/cart", dirty: true, ahead: 2, behind: 1 })}
        name="shop"
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText("feature/cart")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Có thay đổi" })).toBeTruthy();
    expect(screen.getByText("↑2")).toBeTruthy();
    expect(screen.getByText("↓1")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Xem nhánh của shop" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("HEAD rời và repo sạch; không có số khi bằng upstream", () => {
    render(
      <RepoBranchStatus
        status={status({ branch: undefined, detached: true, ahead: 0, behind: 0 })}
        name="api"
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("HEAD rời")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Sạch" })).toBeTruthy();
    expect(screen.queryByText(/↑/)).toBeNull();
  });

  it("repo lỗi hiện lỗi và không có nút Nhánh", () => {
    render(
      <RepoBranchStatus
        status={status({ error: { code: "not_repo", message: "Thư mục không còn hoặc không phải repo git." } })}
        name="cu"
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("Thư mục không còn hoặc không phải repo git.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("BranchesSheet", () => {
  it("200 nhánh: hiện từng trang, ô lọc tìm trong cả những nhánh chưa hiện", async () => {
    fakeApp({
      repo: repoOf({
        branches: many(200, (i) => branch(`task/t${String(i).padStart(3, "0")}`, { committedAt: 1_000 + i })),
      }),
    });
    renderSheet();
    const user = userEvent.setup();
    expect(await screen.findByText("task/t199")).toBeTruthy();
    expect(screen.queryByText("task/t000")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Hiện thêm 100 mục" }));
    expect(await screen.findByText("task/t000")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Hiện thêm/ })).toBeNull();

    await user.type(screen.getByRole("textbox", { name: "Lọc theo tên" }), "t07");
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getAllByRole("listitem")).toHaveLength(10);
    await user.clear(screen.getByRole("textbox", { name: "Lọc theo tên" }));
    await user.type(screen.getByRole("textbox", { name: "Lọc theo tên" }), "không-có");
    expect(screen.getByText("Không có mục nào khớp.")).toBeTruthy();
  });

  it("nhánh local: đang đứng ở đầu, ↑↓ với upstream, remote đã xoá, chưa đẩy, so với nhánh mặc định", async () => {
    fakeApp({
      repo: repoOf({
        branches: [
          branch("cu", { committedAt: 100, upstream: "origin/cu", upstreamGone: true }),
          branch("feature", {
            committedAt: 900,
            upstream: "origin/feature",
            aheadUpstream: 2,
            behindUpstream: 1,
            aheadDefault: 3,
            behindDefault: 4,
            unpushed: 2,
            subject: "Thêm giỏ hàng",
            worktreePath: "/Users/ha/Code/shop-wt/feature",
          }),
          branch("main", { committedAt: 500, isCurrent: true, isDefault: true, upstream: "origin/main" }),
          branch("khong-theo-doi", { committedAt: 700 }),
        ],
      }),
    });
    renderSheet();
    const rows = (await screen.findAllByRole("listitem")).map((li) => li.textContent ?? "");
    expect(rows).toHaveLength(4);
    for (const [i, name] of ["main", "feature", "khong-theo-doi", "cu"].entries())
      expect(rows[i]?.startsWith(name)).toBe(true);
    expect(rows[0]).toContain("Đang đứng");

    const feature = screen.getByText("feature").closest("li") as HTMLElement;
    expect(within(feature).getByText("↑2")).toBeTruthy();
    expect(within(feature).getByText("↓1")).toBeTruthy();
    expect(within(feature).getByText("Chưa đẩy 2 commit")).toBeTruthy();
    expect(within(feature).getByText("Thêm giỏ hàng")).toBeTruthy();
    expect(feature.textContent).toContain("so với main: ↑3 ↓4");
    expect(feature.textContent).toContain("theo dõi origin/feature");
    expect(feature.textContent).toContain("worktree ~/Code/shop-wt/feature");
    expect(within(screen.getByText("cu").closest("li") as HTMLElement).getByText("Remote đã xoá")).toBeTruthy();
    expect(screen.getByText("khong-theo-doi").closest("li")?.textContent).toContain("không theo dõi remote");
  });

  it("tab Remote chỉ có nhánh remote; tab hiện số lượng", async () => {
    fakeApp({
      repo: repoOf({
        branches: [
          branch("main", { isCurrent: true, isDefault: true }),
          remoteBranch("feature/x", { committedAt: 5 }),
          remoteBranch("feature/y", { committedAt: 9 }),
        ],
      }),
    });
    renderSheet();
    const user = userEvent.setup();
    expect(await screen.findByRole("tab", { name: /Local\s*1/ })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: /Remote\s*2/ }));
    const rows = within(screen.getByRole("tabpanel")).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("origin/feature/y"),
      expect.stringContaining("origin/feature/x"),
    ]);
  });

  it("worktree điền dần theo sự kiện; HEAD rời, thư mục mất, bị khoá, có agent", async () => {
    const WT = "/Users/ha/Code/shop-wt/a";
    const { emit, listJob } = fakeApp({
      repo: repoOf({
        worktrees: [
          worktree(FOLDER, { isMain: true, branch: "main" }),
          worktree(WT, { branch: "ai/a", state: "pending", busy: "agent" }),
          worktree("/Users/ha/Code/shop-wt/b", { head: "0be3c4d5e6f", state: "clean" }),
          worktree("/Users/ha/Code/shop-wt/mat", { branch: "ai/mat", state: "missing", prunable: true }),
          worktree("/Users/ha/Code/shop-wt/khoa", { branch: "ai/khoa", locked: true, lockReason: "đang sao lưu" }),
        ],
      }),
    });
    renderSheet();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: /Worktree\s*5/ }));
    const item = (path: string) => screen.getByTitle(path).closest("li") as HTMLElement;

    expect(within(item(WT)).getByText("Đang đọc…")).toBeTruthy();
    expect(within(item(WT)).getByText("Đang có agent")).toBeTruthy();
    await emit(listJob, {
      type: "worktree",
      folder: FOLDER,
      worktree: worktree(WT, {
        branch: "ai/a",
        state: "dirty",
        busy: "agent",
        files: ["a.ts", "b.ts", "c.ts", "d.ts"],
        filesTotal: 6,
      }),
    });
    expect(within(item(WT)).getByText("Có thay đổi")).toBeTruthy();
    expect(within(item(WT)).queryByText("Đang đọc…")).toBeNull();
    expect(item(WT).textContent).toContain("a.ts, b.ts, c.ts và 3 file nữa");

    expect(within(item("/Users/ha/Code/shop-wt/b")).getByText("HEAD rời ở 0be3c4d")).toBeTruthy();
    expect(within(item("/Users/ha/Code/shop-wt/mat")).getByText("Thư mục đã mất")).toBeTruthy();
    expect(within(item("/Users/ha/Code/shop-wt/mat")).getByText("Có thể dọn")).toBeTruthy();
    expect(within(item("/Users/ha/Code/shop-wt/khoa")).getByText("Bị khoá")).toBeTruthy();
    expect(within(item("/Users/ha/Code/shop-wt/khoa")).getByText("Bị khoá: đang sao lưu")).toBeTruthy();
    expect(within(item(FOLDER)).getByText("Thư mục chính")).toBeTruthy();
  });

  it("Fetch: chạy job, đọc lại bảng, báo màn Dự án, hiện thời điểm fetch cuối", async () => {
    const onChanged = vi.fn();
    const { calls, emit, fetchJob } = fakeApp();
    renderSheet({ onChanged });
    const user = userEvent.setup();
    expect(await screen.findByText("Chưa fetch")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    expect(await screen.findByRole("button", { name: "Đang fetch…" })).toHaveProperty("disabled", true);
    expect(calls.filter((c) => c.command === "git_branches_fetch")).toEqual([
      { command: "git_branches_fetch", args: { folder: FOLDER } },
    ]);
    await emit(fetchJob, {
      type: "done",
      folder: FOLDER,
      fetched: ["origin"],
      fetchFailed: [],
      fetchedAt: "2026-10-20T03:15:00Z",
    });

    await waitFor(() => expect(calls.filter((c) => c.command === "git_branches_list")).toHaveLength(2));
    expect(onChanged).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "Fetch" })).toHaveProperty("disabled", false);
    expect(screen.getByText(/^Fetch lúc /)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Fetch lỗi một remote: báo remote nào lỗi, remote kia vẫn tính", async () => {
    const { emit, fetchJob } = fakeApp({ repo: repoOf({ remotes: ["origin", "upstream"] }) });
    renderSheet();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Fetch" }));
    await screen.findByRole("button", { name: "Đang fetch…" });
    await emit(fetchJob, {
      type: "progress",
      folder: FOLDER,
      step: "fetch",
      remote: "upstream",
      result: "failed",
      error: { code: "auth", message: "Remote từ chối đăng nhập.", remote: "upstream" },
    });
    await emit(fetchJob, {
      type: "done",
      folder: FOLDER,
      fetched: ["origin"],
      fetchFailed: [{ remote: "upstream", message: "Remote từ chối đăng nhập.", auth: true }],
      fetchedAt: "2026-10-20T03:15:00Z",
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Đã fetch origin, nhưng lỗi ở: upstream (Remote từ chối đăng nhập.)",
    );
    expect(screen.getByText(/^Fetch lúc /)).toBeTruthy();
  });

  it("Fetch lỗi cả job (worker dừng) và lệnh list lỗi đều hiện, không văng", async () => {
    const { emit, fetchJob } = fakeApp();
    renderSheet();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Fetch" }));
    await screen.findByRole("button", { name: "Đang fetch…" });
    await emit(fetchJob, { type: "exit", message: "Worker dừng giữa chừng." });
    expect((await screen.findByRole("alert")).textContent).toBe("Worker dừng giữa chừng.");
  });

  it("list lỗi: hiện lỗi thay vì bảng", async () => {
    fakeApp({
      repo: { ...repoOf(), error: { code: "not_repo", message: "Thư mục không còn hoặc không phải repo git." } },
    });
    renderSheet();
    expect((await screen.findByRole("alert")).textContent).toBe("Thư mục không còn hoặc không phải repo git.");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("menu dòng: Sao chép tên, Mở terminal ở worktree; Đổi sang có ở nhánh khác nhánh đang đứng", async () => {
    const WT = "/Users/ha/Code/shop-wt/feature";
    const { calls } = fakeApp({
      repo: repoOf({
        branches: [branch("main", { isCurrent: true }), branch("feature", { worktreePath: WT })],
      }),
    });
    const onClose = vi.fn();
    renderSheet({ onClose });
    // userEvent.setup() thay navigator.clipboard bằng bản của nó, nên theo dõi sau khi gọi.
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");

    await user.click(await screen.findByRole("button", { name: "Thao tác với feature" }));
    expect(await screen.findByRole("menuitem", { name: "Đổi sang nhánh này" })).toBeTruthy();
    await user.click(await screen.findByRole("menuitem", { name: "Sao chép tên" }));
    expect(writeText).toHaveBeenCalledWith("feature");

    // Nhánh không mở ở worktree nào thì không có mục terminal.
    await user.click(screen.getByRole("button", { name: "Thao tác với main" }));
    expect(await screen.findByRole("menuitem", { name: "Sao chép tên" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Mở terminal ở worktree" })).toBeNull();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Thao tác với feature" }));
    await user.click(await screen.findByRole("menuitem", { name: "Mở terminal ở worktree" }));
    await waitFor(() =>
      expect(calls.find((c) => c.command === "open_agent_terminal")?.args).toMatchObject({ folder: WT, bypass: false }),
    );
    // Terminal mở ở cửa sổ riêng của máy: bảng nhánh vẫn mở.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("toàn màn khi hẹp (360 px), cột 640 px bên phải khi rộng; chữ tiếng Anh theo ngôn ngữ", async () => {
    setLang("en");
    fakeApp();
    // Giờ fetch cuối nhớ theo thư mục ở cấp module; thư mục riêng để các ca fetch trước không lẫn vào.
    renderSheet({ folder: "/Users/ha/Code/never-fetched" });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toContain("max-w-full");
    expect(dialog.className).toContain("sm:max-w-160");
    expect(dialog.className).toContain("right-0");
    expect(dialog.className).toContain("h-full");
    expect(await screen.findByRole("heading", { name: "Branches of shop" })).toBeTruthy();
    expect(screen.getByText("Not fetched yet")).toBeTruthy();
  });

  it("git cũ (slowPath): giải thích vì sao thiếu số so với nhánh mặc định", async () => {
    fakeApp({ repo: repoOf({ slowPath: true }) });
    renderSheet();
    expect(await screen.findByText(/cũ hơn 2\.41/)).toBeTruthy();
  });
});

describe("ProjectsScreen: cột nhánh", () => {
  const entry = (over: Partial<LocalProject>): LocalProject => ({
    projectId: "",
    name: "app",
    folder: "/Users/ha/Work/app",
    fullPermission: false,
    exists: true,
    isGit: true,
    ...over,
  });

  it("repo trên máy có nhánh, sạch/bẩn, ↑↓; Nhánh mở bảng; repo lỗi không có nút; chỉ hỏi repo còn trên máy", async () => {
    const { calls } = fakeApp({
      local: [
        entry({ name: "shop", folder: FOLDER }),
        entry({ name: "cu", folder: "/Users/ha/Work/cu" }),
        entry({ name: "mat", folder: "/Users/ha/Work/mat", exists: false, isGit: false }),
      ],
      statuses: [
        status({ branch: "feature/cart", dirty: true, ahead: 2, behind: 1 }),
        status({
          folder: "/Users/ha/Work/cu",
          error: { code: "not_repo", message: "Thư mục không còn hoặc không phải repo git." },
        }),
      ],
      repo: repoOf({ branches: [branch("feature/cart", { isCurrent: true })] }),
    });
    render(<ProjectsScreen />);
    // Repo trên máy gom theo nhóm và thu gọn khi có nhiều nhóm.
    for (const group of await screen.findAllByRole("button", { expanded: false })) await userEvent.click(group);
    expect(await screen.findByText("feature/cart")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Có thay đổi" })).toBeTruthy();
    expect(screen.getByText("↑2")).toBeTruthy();
    expect(screen.getByText("Thư mục không còn hoặc không phải repo git.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Xem nhánh của / })).toHaveLength(1);
    expect(calls.find((c) => c.command === "git_branches_status")?.args).toEqual({
      folders: [FOLDER, "/Users/ha/Work/cu"],
    });

    await userEvent.setup().click(screen.getByRole("button", { name: "Xem nhánh của shop" }));
    expect(await screen.findByRole("heading", { name: "Nhánh của shop" })).toBeTruthy();
    expect(await screen.findByText("Đang đứng")).toBeTruthy();
  });

  it("lệnh nhánh chưa có (sidecar cũ): màn vẫn dùng được, không có cột nhánh", async () => {
    fakeApp({ local: [entry({ name: "shop", folder: FOLDER })] });
    const invoke = window.__TAURI__?.core.invoke;
    if (window.__TAURI__ && invoke)
      window.__TAURI__.core.invoke = (async (command: string, args?: Record<string, unknown>) => {
        if (command === "git_branches_status") throw new Error("Command git_branches_status not found");
        return invoke(command, args);
      }) as typeof invoke;
    render(<ProjectsScreen />);
    expect(await screen.findByText("shop")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Xem nhánh của / })).toBeNull());
  });
});
