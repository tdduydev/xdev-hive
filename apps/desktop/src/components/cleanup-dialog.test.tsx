import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FOLDER, fakeTauri, type Handler, repoOf } from "@/components/branch-test-helpers.ts";
import { BranchesSheet } from "@/components/branches-sheet.tsx";
import { CleanupDialog } from "@/components/cleanup-dialog.tsx";
import type { BranchEvent, BranchSettings, Candidate, CleanResult, ScanRepo } from "@/lib/git-branches.ts";
import { setLang } from "@/lib/i18n.ts";
import type { LocalProjects } from "@/lib/local-projects.ts";
import { ProjectsScreen } from "@/screens/projects-screen.tsx";

const OTHER = "/Users/ha/Code/api";

// Tiến độ gom theo id ở cấp module (lib/git-branches.ts): mỗi ca một id để ca trước không lẫn vào.
let seq = 0;

beforeEach(() => setLang("vi"));

const candidate = (branch: string, over: Partial<Candidate> = {}): Candidate => ({
  folder: FOLDER,
  branch,
  tip: "abc1234",
  committedAt: 1_792_000_000,
  evidence: { kind: "mergedGit", onto: "origin/main" },
  selected: true,
  ...over,
});

const scanRepo = (over: Partial<ScanRepo> = {}): ScanRepo => ({
  folder: FOLDER,
  defaultBranch: "main",
  current: "main",
  fetched: ["origin"],
  fetchFailed: [],
  candidates: [],
  blocked: [],
  ...over,
});

const result = (branch: string, over: Partial<CleanResult> = {}): CleanResult => ({
  folder: FOLDER,
  branch,
  tip: "abc1234",
  result: "removed",
  worktreeRemoved: false,
  branchDeleted: true,
  ...over,
});

/** Tauri giả có sự kiện: `scan` và `clean` trả id job rồi test phát sự kiện như Rust. */
function fakeApp(extra: Record<string, Handler> = {}) {
  const listeners: ((e: { payload: unknown }) => void)[] = [];
  const ids = { scans: [] as string[], clean: "" };
  const { calls, named } = fakeTauri({
    git_branches_scan: () => {
      const id = `scan-${++seq}`;
      ids.scans.push(id);
      return id;
    },
    git_branches_clean: () => {
      ids.clean = `clean-${++seq}`;
      return ids.clean;
    },
    git_branches_cancel: () => undefined,
    ...extra,
  });
  // Thay `listen` của fakeTauri (hàm rỗng) bằng bản ghi lại handler để phát sự kiện.
  const event = window.__TAURI__?.event;
  if (event)
    event.listen = (async (_name: string, handler: (e: { payload: unknown }) => void) => {
      listeners.push(handler);
      return () => {};
    }) as typeof event.listen;
  const emit = (jobId: string, event: BranchEvent) =>
    act(() => {
      for (const l of listeners) l({ payload: { jobId, event } });
    });
  return { calls, named, ids, emit };
}

const scanned = async (app: ReturnType<typeof fakeApp>, repos: ScanRepo[]) => {
  await waitFor(() => expect(app.ids.scans.length).toBeGreaterThan(0));
  const id = app.ids.scans[app.ids.scans.length - 1] ?? "";
  for (const [i, repo] of repos.entries())
    await app.emit(id, { type: "repo", folder: repo.folder, repo, done: i + 1, total: repos.length });
  await app.emit(id, { type: "done", total: repos.length });
  return id;
};

const preview = [
  scanRepo({
    candidates: [
      candidate("ai/merged"),
      candidate("ai/closed", { evidence: { kind: "closedApi", provider: "github", number: 12 }, selected: false }),
      candidate("ai/gone", {
        worktree: { path: `${FOLDER}/.claude/worktrees/agent-1`, prunable: true, agentWorktree: true },
        selected: false,
      }),
    ],
    blocked: [
      candidate("ai/dirty", {
        selected: false,
        blocked: { code: "dirty", message: "x", files: ["src/a.ts", "src/b.ts"], filesTotal: 2 },
      }),
    ],
  }),
];

const open = (folders = [FOLDER], props: Partial<Parameters<typeof CleanupDialog>[0]> = {}) =>
  render(<CleanupDialog folders={folders} onClose={() => {}} onChanged={() => {}} {...props} />);

describe("CleanupDialog: quét", () => {
  it("quét có fetch mọi repo, hiện tiến độ từng repo rồi sang xem trước", async () => {
    const app = fakeApp();
    open([FOLDER, OTHER]);
    await waitFor(() => expect(app.named("git_branches_scan")).toEqual([{ folders: [FOLDER, OTHER], fetch: true }]));
    expect(screen.getAllByText("Đang chờ")).toHaveLength(2);

    const id = app.ids.scans[0] ?? "";
    await app.emit(id, { type: "progress", folder: FOLDER, step: "evidence", done: 0, total: 2 });
    expect(await screen.findByText("đang kiểm bằng chứng merge")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");

    await app.emit(id, {
      type: "repo",
      folder: FOLDER,
      repo: scanRepo({ candidates: [candidate("ai/a")] }),
      done: 1,
      total: 2,
    });
    expect(await screen.findByText("Xong, 1 nhánh dọn được")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");

    await app.emit(id, { type: "repo", folder: OTHER, repo: scanRepo({ folder: OTHER }), done: 2, total: 2 });
    await app.emit(id, { type: "done", total: 2 });
    expect(await screen.findByText("1 nhánh dọn được, 0 nhánh không dọn, trong 2 repo.")).toBeTruthy();
  });

  it("huỷ giữa lúc quét: huỷ job rồi đóng", async () => {
    const app = fakeApp();
    const onClose = vi.fn();
    open([FOLDER], { onClose });
    await waitFor(() => expect(app.ids.scans).toHaveLength(1));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Huỷ" }));
    expect(app.named("git_branches_cancel")).toEqual([{ jobId: app.ids.scans[0] }]);
    expect(onClose).toHaveBeenCalled();
  });

  it("quét lỗi cả job: báo lỗi, có Thử lại", async () => {
    const app = fakeApp();
    open();
    await waitFor(() => expect(app.ids.scans).toHaveLength(1));
    await app.emit(app.ids.scans[0] ?? "", { type: "exit", message: "Worker chết." });
    expect(await screen.findByText("Quét không xong: Worker chết.")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Thử lại" }));
    await waitFor(() => expect(app.ids.scans).toHaveLength(2));
  });
});

describe("CleanupDialog: xem trước", () => {
  it("chỉ chọn sẵn ứng viên sidecar đánh dấu; PR đóng và worktree prunable không chọn sẵn (Q11)", async () => {
    const app = fakeApp();
    open();
    await scanned(app, preview);

    const merged = await screen.findByRole("checkbox", { name: "Dọn nhánh ai/merged" });
    expect((merged as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Dọn nhánh ai/closed" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Dọn nhánh ai/gone" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("PR #12 đã đóng, chưa merge")).toBeTruthy();
    expect(screen.getByText("Đã chọn 1/3")).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Dọn 1 mục" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Huỷ" }));
    await user.click(screen.getByRole("checkbox", { name: "Dọn nhánh ai/closed" }));
    expect(screen.getByRole("button", { name: "Dọn 2 mục" })).toBeTruthy();
    // Bỏ chọn hết thì không dọn được gì.
    await user.click(screen.getByRole("checkbox", { name: "Dọn nhánh ai/closed" }));
    await user.click(screen.getByRole("checkbox", { name: "Dọn nhánh ai/merged" }));
    expect((screen.getByRole("button", { name: "Dọn 0 mục" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("worktree prunable có ghi chú riêng, đường dẫn .claude/worktrees hiện rõ và đánh dấu của agent", async () => {
    const app = fakeApp();
    open();
    await scanned(app, preview);
    expect(await screen.findByText(/chỉ gỡ đăng ký worktree, không xoá file/)).toBeTruthy();
    expect(screen.getByText(/\.claude\/worktrees\/agent-1/)).toBeTruthy();
    expect(screen.getByText("Của agent")).toBeTruthy();
  });

  it("nhóm Không dọn thu gọn sẵn, mở ra thấy lý do và file", async () => {
    const app = fakeApp();
    open();
    await scanned(app, preview);
    const toggle = await screen.findByRole("button", { name: "Không dọn (1)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("ai/dirty")).toBeNull();

    await userEvent.setup().click(toggle);
    expect(screen.getByText("ai/dirty")).toBeTruthy();
    expect(screen.getByText(/Có 2 file đã sửa chưa commit/)).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    // Nhánh bị chặn không có ô chọn.
    expect(screen.queryByRole("checkbox", { name: "Dọn nhánh ai/dirty" })).toBeNull();
  });

  it("repo có nhánh đang đứng đã merge: gợi ý về nhánh mặc định; repo lỗi báo riêng", async () => {
    const app = fakeApp();
    open([FOLDER, OTHER]);
    await scanned(app, [
      scanRepo({ current: "ai/now", suggestDefault: { branch: "main", clean: true } }),
      scanRepo({ folder: OTHER, error: { code: "not_repo", message: "Không phải repo." } }),
    ]);
    expect(await screen.findByText(/Thư mục chính đang ở/)).toBeTruthy();
    expect(screen.getByText("Repo này không quét được: Không phải repo.")).toBeTruthy();
  });

  it("fetch lỗi: nói chỉ dùng bằng chứng đã có trên máy", async () => {
    const app = fakeApp();
    open();
    await scanned(app, [scanRepo({ fetchFailed: [{ remote: "origin", message: "x", auth: false }] })]);
    expect(await screen.findByText(/Không fetch được, chỉ dùng bằng chứng đã có trên máy/)).toBeTruthy();
  });
});

describe("CleanupDialog: mẫu dọn", () => {
  const settings: BranchSettings = {
    path: "/Users/ha/.xdev-hive/branches.json",
    patterns: ["ai/*", "claude/*"],
    rebuildable: ["node_modules", "dist"],
    defaults: { patterns: ["ai/*", "claude/*"], rebuildable: ["node_modules", "dist"] },
  };

  it("sửa mẫu rồi quét lại: lưu từng dòng, bỏ dòng trống, quét lại với lựa chọn mới", async () => {
    const app = fakeApp({
      git_branches_settings: () => settings,
      git_branches_settings_set: (args) => ({ ...settings, ...(args?.settings as object) }),
    });
    open();
    await scanned(app, preview);
    const user = userEvent.setup();
    // Đã đổi chọn thủ công trước khi quét lại: quét lại bỏ hết.
    await user.click(await screen.findByRole("checkbox", { name: "Dọn nhánh ai/closed" }));

    await user.click(screen.getByRole("button", { name: /Mẫu dọn và thư mục dựng lại được/ }));
    const patterns = await screen.findByRole("textbox", { name: "Mẫu tên nhánh được dọn" });
    expect((patterns as HTMLTextAreaElement).value).toBe("ai/*\nclaude/*");
    await user.clear(patterns);
    await user.type(patterns, "agent/*{Enter}{Enter}ai/*");
    await user.click(screen.getByRole("button", { name: "Lưu và quét lại" }));

    await waitFor(() =>
      expect(app.named("git_branches_settings_set")).toEqual([
        { settings: { patterns: ["agent/*", "ai/*"], rebuildable: ["node_modules", "dist"] } },
      ]),
    );
    await waitFor(() => expect(app.ids.scans).toHaveLength(2));
    // Đang quét lại: quay về bước quét.
    expect(await screen.findByText("Đang fetch và quét…")).toBeTruthy();
    await scanned(app, preview);
    expect(((await screen.findByRole("checkbox", { name: "Dọn nhánh ai/closed" })) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it("lưu lỗi: báo lỗi, không quét lại", async () => {
    const app = fakeApp({
      git_branches_settings: () => settings,
      git_branches_settings_set: () => ({ error: { code: "invalid_input", message: "Mẫu không hợp lệ." } }),
    });
    open();
    await scanned(app, preview);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Mẫu dọn và thư mục dựng lại được/ }));
    await user.click(await screen.findByRole("button", { name: "Lưu và quét lại" }));
    expect(await screen.findByText("Mẫu không hợp lệ.")).toBeTruthy();
    expect(app.ids.scans).toHaveLength(1);
  });

  it("về mặc định điền lại hai ô", async () => {
    const app = fakeApp({ git_branches_settings: () => ({ ...settings, patterns: ["x/*"], rebuildable: ["y"] }) });
    open();
    await scanned(app, preview);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Mẫu dọn và thư mục dựng lại được/ }));
    const patterns = await screen.findByRole("textbox", { name: "Mẫu tên nhánh được dọn" });
    expect((patterns as HTMLTextAreaElement).value).toBe("x/*");
    await user.click(screen.getByRole("button", { name: "Về mặc định" }));
    expect((patterns as HTMLTextAreaElement).value).toBe("ai/*\nclaude/*");
  });
});

describe("CleanupDialog: dọn", () => {
  const start = async (app: ReturnType<typeof fakeApp>, onChanged = () => {}) => {
    open([FOLDER], { onChanged });
    await scanned(app, preview);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Dọn 1 mục" }));
    const confirm = await screen.findByRole("alertdialog");
    return { user, confirm };
  };

  it("hộp xác nhận nói số nhánh, số worktree; Dọn gửi đúng mục đã chọn kèm remote đã fetch", async () => {
    const app = fakeApp();
    const { user, confirm } = await start(app);
    expect(within(confirm).getByText("Dọn 1 mục?")).toBeTruthy();
    expect(confirm.textContent).toContain("Sẽ xoá 1 nhánh local và gỡ 0 worktree.");
    await user.click(within(confirm).getByRole("button", { name: "Dọn" }));

    await waitFor(() => expect(app.named("git_branches_clean")).toHaveLength(1));
    expect(app.named("git_branches_clean")[0]).toEqual({
      items: [
        {
          folder: FOLDER,
          branch: "ai/merged",
          tip: "abc1234",
          evidence: { kind: "mergedGit", onto: "origin/main" },
        },
      ],
      fetched: { [FOLDER]: ["origin"] },
    });
    expect(await screen.findByText("Đang dọn…")).toBeTruthy();
  });

  it("huỷ giữa chừng: gửi huỷ cho job dọn, chờ mục đang chạy, mục chưa chạy ghi Chưa chạy", async () => {
    const app = fakeApp();
    const { user, confirm } = await start(app);
    await user.click(within(confirm).getByRole("button", { name: "Dọn" }));
    await screen.findByText("Đang dọn…");
    // Không đóng được hộp thoại khi đang dọn.
    expect(screen.queryByRole("button", { name: "Đóng" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Huỷ" }));
    expect(app.named("git_branches_cancel")).toEqual([{ jobId: app.ids.clean }]);
    expect(await screen.findByText("Đang huỷ, chờ mục đang chạy xong…")).toBeTruthy();

    await app.emit(app.ids.clean, {
      type: "item",
      item: result("ai/merged", { result: "cancelled", code: "cancelled", branchDeleted: false }),
      done: 1,
      total: 1,
    });
    await app.emit(app.ids.clean, { type: "done", total: 1, summary: { cancelled: 1 } });
    expect(await screen.findByText("Chưa chạy")).toBeTruthy();
    expect(screen.getByText("Đã huỷ trước khi tới mục này")).toBeTruthy();
  });

  it("kết quả: dở dang, bỏ qua vì nhánh đã đổi, đã dọn kèm lệnh khôi phục chép được; báo màn cha một lần", async () => {
    const app = fakeApp();
    const onChanged = vi.fn();
    const { user, confirm } = await start(app, onChanged);
    await user.click(within(confirm).getByRole("button", { name: "Dọn" }));
    await screen.findByText("Đang dọn…");
    const id = app.ids.clean;
    await app.emit(id, { type: "item", item: result("ai/merged", { tip: "9f8e7d6" }), done: 1, total: 3 });
    await app.emit(id, {
      type: "item",
      item: result("ai/changed", { result: "skipped", code: "tipChanged", branchDeleted: false }),
      done: 2,
      total: 3,
    });
    await app.emit(id, {
      type: "item",
      item: result("ai/half", {
        result: "partial",
        code: "busy",
        worktree: `${FOLDER}/.claude/worktrees/x`,
        left: `${FOLDER}/.claude/worktrees/x`,
        branchDeleted: false,
      }),
      done: 3,
      total: 3,
    });
    await app.emit(id, {
      type: "done",
      total: 3,
      summary: { removed: 1 },
      log: "/Users/ha/.xdev-hive/branch-clean.log",
    });

    expect(await screen.findByText("Đã dọn 1, bỏ qua 1, lỗi hay dở dang 1.")).toBeTruthy();
    expect(screen.getByText("Nhánh đã đổi sau khi xem trước")).toBeTruthy();
    expect(screen.getByText("Dở dang")).toBeTruthy();
    expect(screen.getByText(/Gỡ dở, còn lại/)).toBeTruthy();
    expect(screen.getByText("/Users/ha/.xdev-hive/branch-clean.log", { exact: false })).toBeTruthy();
    // Chỉ nhánh đã xoá mới có lệnh khôi phục, với mã đỉnh của nó.
    expect(screen.getAllByText("git branch ai/merged 9f8e7d6")).toHaveLength(1);
    expect(screen.queryByText(/git branch ai\/half/)).toBeNull();

    // userEvent.setup() thay navigator.clipboard bằng bản của nó, nên theo dõi sau khi gọi.
    const user2 = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user2.click(screen.getByRole("button", { name: "Sao chép lệnh khôi phục: ai/merged" }));
    expect(writeText).toHaveBeenCalledWith("git branch ai/merged 9f8e7d6");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("đang có job dọn khác: báo câu của Rust và ở lại bước xem trước", async () => {
    const app = fakeApp({
      git_branches_clean: () => {
        throw new Error("Đang dọn nhánh.");
      },
    });
    const { user, confirm } = await start(app);
    await user.click(within(confirm).getByRole("button", { name: "Dọn" }));
    expect(await screen.findByText("Đang dọn nhánh.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dọn 1 mục" })).toBeTruthy();
  });

  it("tiếng Anh: dùng bản dịch theo mã cho lý do của kết quả", async () => {
    setLang("en");
    const app = fakeApp();
    open();
    await scanned(app, preview);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Clean 1 item" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Clean" }));
    await screen.findByText("Cleaning…");
    await app.emit(app.ids.clean, {
      type: "item",
      item: result("ai/merged", {
        result: "skipped",
        code: "tipChanged",
        reason: "Nhánh đã đổi sau khi xem trước",
        branchDeleted: false,
      }),
    });
    await app.emit(app.ids.clean, { type: "done", total: 1 });
    expect(await screen.findByText("The branch changed since the preview")).toBeTruthy();
  });
});

describe("Nút mở hộp thoại dọn nhánh", () => {
  it("BranchesSheet: Dọn nhánh repo này quét đúng repo đó", async () => {
    const app = fakeApp({ git_branches_list: () => ({ ...repoOf(), jobId: `list-${++seq}` }) });
    render(<BranchesSheet folder={FOLDER} name="shop" onClose={() => {}} onChanged={() => {}} />);
    const button = await screen.findByRole("button", { name: "Dọn nhánh repo này" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.setup().click(button);
    await waitFor(() => expect(app.named("git_branches_scan")).toEqual([{ folders: [FOLDER], fetch: true }]));
  });

  const view = (projects: LocalProjects["projects"]): LocalProjects => ({
    path: "/x/projects.json",
    exists: true,
    imported: 0,
    projects,
  });
  const entry = (name: string, folder: string, over = {}) => ({
    projectId: "",
    name,
    folder,
    fullPermission: false,
    exists: true,
    isGit: true,
    ...over,
  });
  const projectHandlers = (projects: LocalProjects["projects"]): Record<string, Handler> => ({
    local_projects: () => view(projects),
    git_groups: () => ({ path: "/x/gitgroups.json", hosts: [], groups: [] }),
    git_branches_status: () => ({ repos: [] }),
  });

  it("Dự án: Dọn nhánh quét mọi repo còn trên máy, bỏ repo mất thư mục", async () => {
    const app = fakeApp(
      projectHandlers([
        entry("shop", FOLDER),
        entry("api", OTHER),
        entry("mat", "/Users/ha/Code/mat", { exists: false, isGit: false }),
      ]),
    );
    render(<ProjectsScreen />);
    const button = await screen.findByRole("button", { name: "Dọn nhánh" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.setup().click(button);
    await waitFor(() => expect(app.named("git_branches_scan")).toEqual([{ folders: [FOLDER, OTHER], fetch: true }]));
    expect(await screen.findByRole("heading", { name: "Dọn nhánh đã merge" })).toBeTruthy();
  });

  it("Dự án: chưa có repo nào thì nút Dọn nhánh tắt", async () => {
    fakeApp(projectHandlers([]));
    render(<ProjectsScreen />);
    const button = await screen.findByRole("button", { name: "Dọn nhánh" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
