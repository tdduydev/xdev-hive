import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { branch, FOLDER, failure, fakeTauri, type Handler, repoOf, status } from "@/components/branch-test-helpers.ts";
import { BranchesSheet } from "@/components/branches-sheet.tsx";
import { CleanupDialog } from "@/components/cleanup-dialog.tsx";
import { GitOperationPanel } from "@/components/git-operation-panel.tsx";
import type { BranchEvent, GitOperation, RepoBranches, ScanRepo } from "@/lib/git-branches.ts";
import { setLang } from "@/lib/i18n.ts";

beforeEach(() => setLang("vi"));

// Câu thông báo chung thẻ <p> với dòng lệnh quay về, nên chỉ so phần đầu.
const notice = (lead: string) => (_: string, el: Element | null) =>
  el?.tagName === "P" && !!el.textContent?.startsWith(lead);

// Tiến độ gom theo id ở cấp module (lib/git-branches.ts): mỗi ca một id để ca trước không lẫn vào.
let seq = 0;

const HEAD_BEFORE = "9f1c2d3e4a5b6c7d8e9f00112233445566778899";
const UPSTREAM_TIP = "c0ffee00112233445566778899aabbccddeeff00";

const operation = (over: Partial<GitOperation> = {}): GitOperation => ({
  kind: "merge",
  state: "conflict",
  branch: "feature",
  onto: { name: "origin/main", tip: "df58000" },
  headBefore: HEAD_BEFORE,
  conflicts: ["src/cart.ts", "src/pay.ts"],
  conflictsTotal: 2,
  ...over,
});

/** Tauri giả có sự kiện: `list` và `pull` trả id job, test phát sự kiện như Rust. */
function fakeApp(repo: RepoBranches, extra: Record<string, Handler> = {}) {
  const listeners: ((e: { payload: unknown }) => void)[] = [];
  const ids = { pull: "" };
  const app = fakeTauri({
    git_branches_list: () => ({ ...repo, jobId: `git-${++seq}` }),
    git_branches_fetch: () => `git-${++seq}`,
    git_branches_pull: () => {
      ids.pull = `pull-${++seq}`;
      return ids.pull;
    },
    git_branches_scan: () => `scan-${++seq}`,
    git_branches_cancel: () => undefined,
    ...extra,
  });
  const event = window.__TAURI__?.event;
  if (event)
    event.listen = (async (_name: string, handler: (e: { payload: unknown }) => void) => {
      listeners.push(handler);
      return () => {};
    }) as typeof event.listen;
  const emit = (jobId: string, e: BranchEvent) =>
    act(() => {
      for (const l of listeners) l({ payload: { jobId, event: e } });
    });
  return { ...app, ids, emit };
}

const onFeature = (over: Partial<RepoBranches> = {}) =>
  repoOf({
    current: status({ branch: "feature", upstream: "origin/feature" }),
    branches: [
      branch("feature", { isCurrent: true, upstream: "origin/feature", worktreePath: FOLDER }),
      branch("main", { isDefault: true, tip: "df58000" }),
      branch("ai/other", { tip: "7777777" }),
    ],
    ...over,
  });

const renderSheet = (onChanged = () => {}) =>
  render(<BranchesSheet folder={FOLDER} name="shop" onClose={() => {}} onChanged={onChanged} />);

const pressMenu = async (user: ReturnType<typeof userEvent.setup>, branchName: string, item: string | RegExp) => {
  await user.click(await screen.findByRole("button", { name: `Thao tác với ${branchName}` }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
};

describe("Pull", () => {
  it("diverged: gợi ý Merge upstream hay Rebase lên upstream và chạy tiếp ngay trong hộp thoại", async () => {
    const merged = operation({
      state: "done",
      branch: "feature",
      onto: { name: "origin/feature", tip: UPSTREAM_TIP },
      conflicts: [],
      conflictsTotal: 0,
      head: "e0e0e0e",
    });
    const app = fakeApp(onFeature(), { git_branches_merge: () => ({ operation: merged }) });
    const user = userEvent.setup();
    renderSheet();
    await user.click(await screen.findByRole("button", { name: "Pull" }));
    await waitFor(() => expect(app.named("git_branches_pull")).toEqual([{ folder: FOLDER, confirmBusy: false }]));
    await app.emit(app.ids.pull, {
      type: "done",
      folder: FOLDER,
      error: {
        code: "diverged",
        message: "x",
        ahead: 2,
        behind: 1,
        upstream: "origin/feature",
        upstreamTip: UPSTREAM_TIP,
      },
    });
    expect(
      await screen.findByText(
        (_, el) =>
          el?.tagName === "P" &&
          el.textContent ===
            "Nhánh có 2 commit mới ở máy và thiếu 1 commit của origin/feature. Pull chỉ tiến nhanh nên không chạy.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rebase lên upstream" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Merge upstream" }));
    await waitFor(() =>
      expect(app.named("git_branches_merge")).toEqual([
        { folder: FOLDER, onto: UPSTREAM_TIP, ontoName: "origin/feature", ff: false, confirmBusy: false },
      ]),
    );
    expect(await screen.findByText(notice("Đã merge origin/feature vào feature."))).toBeTruthy();
  });

  it("diverged: Rebase lên upstream gửi mã upstream đã đọc", async () => {
    const app = fakeApp(onFeature(), {
      git_branches_rebase: () => ({ operation: operation({ kind: "rebase", state: "conflict", step: 1, total: 3 }) }),
    });
    const user = userEvent.setup();
    renderSheet();
    await user.click(await screen.findByRole("button", { name: "Pull" }));
    await waitFor(() => expect(app.ids.pull).not.toBe(""));
    await app.emit(app.ids.pull, {
      type: "done",
      error: {
        code: "diverged",
        message: "x",
        ahead: 1,
        behind: 1,
        upstream: "origin/feature",
        upstreamTip: UPSTREAM_TIP,
      },
    });
    await user.click(await screen.findByRole("button", { name: "Rebase lên upstream" }));
    await waitFor(() =>
      expect(app.named("git_branches_rebase")).toEqual([
        { folder: FOLDER, onto: UPSTREAM_TIP, ontoName: "origin/feature", confirmRewrite: false, confirmBusy: false },
      ]),
    );
  });

  it("tiến nhanh xong: báo số commit và hiện lệnh quay về, đọc lại bảng", async () => {
    const app = fakeApp(onFeature());
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderSheet(onChanged);
    await user.click(await screen.findByRole("button", { name: "Pull" }));
    await waitFor(() => expect(app.ids.pull).not.toBe(""));
    await app.emit(app.ids.pull, {
      type: "done",
      folder: FOLDER,
      pull: { state: "done", headBefore: HEAD_BEFORE, head: "ab12ab1", behind: 3 },
    });
    expect(await screen.findByText(notice("Đã pull 3 commit vào feature."))).toBeTruthy();
    expect(screen.getByText(`git reset --keep ${HEAD_BEFORE}`)).toBeTruthy();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(app.named("git_branches_list").length).toBeGreaterThan(1);
  });

  it("không có upstream: nút tắt và nói lý do", async () => {
    fakeApp(onFeature({ current: status({ branch: "feature" }) }));
    renderSheet();
    const pull = await screen.findByRole("button", { name: "Pull" });
    await waitFor(() => expect((pull as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText("Pull không chạy được: Nhánh này chưa theo dõi nhánh remote nào")).toBeTruthy();
  });

  it("thư mục có thay đổi: hộp thoại liệt kê file và không chạy gì thêm", async () => {
    const app = fakeApp(onFeature());
    const user = userEvent.setup();
    renderSheet();
    await user.click(await screen.findByRole("button", { name: "Pull" }));
    await waitFor(() => expect(app.ids.pull).not.toBe(""));
    await app.emit(app.ids.pull, {
      type: "done",
      error: { code: "dirty", message: "x", files: ["src/a.ts", "?? notes.md"], filesTotal: 2 },
    });
    expect(await screen.findByText("Thư mục có 2 file đang sửa hay chưa theo dõi.")).toBeTruthy();
    expect(screen.getByText("?? notes.md")).toBeTruthy();
    expect(app.named("git_branches_merge")).toEqual([]);
  });
});

describe("Merge và Rebase", () => {
  it("merge xong: báo kết quả kèm lệnh git reset --keep, không còn khung thao tác dở", async () => {
    const app = fakeApp(onFeature(), {
      git_branches_merge: () => ({
        operation: operation({
          state: "done",
          branch: "feature",
          onto: { name: "ai/other", tip: "7777777" },
          conflicts: [],
          conflictsTotal: 0,
        }),
      }),
    });
    const user = userEvent.setup();
    renderSheet();
    await pressMenu(user, "ai/other", "Merge vào nhánh đang đứng");
    expect(await screen.findByText(notice("Đã merge ai/other vào feature."))).toBeTruthy();
    expect(app.named("git_branches_merge")).toEqual([
      { folder: FOLDER, onto: "7777777", ontoName: "ai/other", ff: false, confirmBusy: false },
    ]);
    expect(screen.getByText(`git reset --keep ${HEAD_BEFORE}`)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Đang merge" })).toBeNull();
  });

  it("merge dừng vì xung đột: đọc lại và hiện khung Đang merge với file xung đột", async () => {
    const state = { stopped: false };
    const dangling = operation({ branch: "feature", onto: { name: "ai/other", tip: "7777777" } });
    const base = onFeature();
    // Sau khi merge dừng, `list` báo repo đang dở merge như sidecar thật.
    const app = fakeApp(base, {
      git_branches_merge: () => {
        state.stopped = true;
        return { operation: dangling };
      },
      git_branches_list: () => ({
        ...(state.stopped ? { ...base, operation: dangling, current: { ...base.current, operation: "merge" } } : base),
        jobId: `git-${++seq}`,
      }),
    });
    const user = userEvent.setup();
    renderSheet();
    await pressMenu(user, "ai/other", "Merge vào nhánh đang đứng");
    const panel = await screen.findByRole("region", { name: "Đang merge" });
    expect(within(panel).getByText("src/cart.ts")).toBeTruthy();
    expect(within(panel).getByText("2 file còn xung đột:")).toBeTruthy();
    expect(app.named("git_branches_merge")).toHaveLength(1);
  });

  it("rebase gặp needsConfirm: hỏi, bấm Rebase thì gửi lại với confirmRewrite", async () => {
    const replies = [
      () => failure("needsConfirm", { count: 2 }),
      () => ({
        operation: operation({
          kind: "rebase",
          state: "done",
          conflicts: [],
          conflictsTotal: 0,
          onto: { name: "ai/other", tip: "7777777" },
        }),
      }),
    ];
    const app = fakeApp(onFeature(), { git_branches_rebase: () => replies.shift()?.() });
    const user = userEvent.setup();
    renderSheet();
    await pressMenu(user, "ai/other", "Rebase nhánh đang đứng lên nhánh này");
    expect(await screen.findByText("Rebase viết lại 2 commit đã đẩy.")).toBeTruthy();
    expect(screen.getByText("Sau đó phải force-push mới đẩy lên remote được; app không push.")).toBeTruthy();
    expect(app.named("git_branches_rebase")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Rebase" }));
    expect(await screen.findByText(notice("Đã rebase feature lên ai/other."))).toBeTruthy();
    expect(app.named("git_branches_rebase")).toEqual([
      { folder: FOLDER, onto: "7777777", ontoName: "ai/other", confirmRewrite: false, confirmBusy: false },
      { folder: FOLDER, onto: "7777777", ontoName: "ai/other", confirmRewrite: true, confirmBusy: false },
    ]);
  });

  it("đang có agent chạy: hỏi trước, bấm Vẫn chạy thì gửi lại với confirmBusy", async () => {
    const replies = [
      () => failure("busy", { busy: [{ kind: "agent", path: `${FOLDER}/.claude/worktrees/a1`, label: "Agent a1" }] }),
      () => ({
        operation: operation({
          state: "done",
          conflicts: [],
          conflictsTotal: 0,
          onto: { name: "ai/other", tip: "7777777" },
        }),
      }),
    ];
    const app = fakeApp(onFeature(), { git_branches_merge: () => replies.shift()?.() });
    const user = userEvent.setup();
    renderSheet();
    await pressMenu(user, "ai/other", "Merge vào nhánh đang đứng");
    expect(await screen.findByText("Có chương trình đang dùng thư mục này.")).toBeTruthy();
    expect(screen.getByText(/Agent a1/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Vẫn chạy" }));
    await screen.findByText(notice("Đã merge ai/other vào feature."));
    expect(app.named("git_branches_merge")[1]).toMatchObject({ confirmBusy: true });
  });

  it("dòng nhánh đang đứng có lối tắt Cập nhật từ nhánh mặc định (merge)", async () => {
    const app = fakeApp(onFeature(), {
      git_branches_merge: () => ({
        operation: operation({
          state: "done",
          conflicts: [],
          conflictsTotal: 0,
          onto: { name: "main", tip: "df58000" },
        }),
      }),
    });
    const user = userEvent.setup();
    renderSheet();
    await pressMenu(user, "feature", "Cập nhật từ main");
    await screen.findByText(notice("Đã merge main vào feature."));
    expect(app.named("git_branches_merge")).toEqual([
      { folder: FOLDER, onto: "df58000", ontoName: "main", ff: false, confirmBusy: false },
    ]);
  });

  it("HEAD rời: Pull, Merge và Rebase đều tắt kèm lý do, không gọi sidecar", async () => {
    const app = fakeApp(
      onFeature({
        current: status({ branch: undefined, detached: true, head: "abc1234" }),
        branches: [branch("main", { isDefault: true }), branch("ai/other")],
      }),
    );
    const user = userEvent.setup();
    renderSheet();
    const pull = await screen.findByRole("button", { name: "Pull" });
    await waitFor(() => expect((pull as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText("Pull không chạy được: Cần đứng trên một nhánh")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Thao tác với ai/other" }));
    const merge = await screen.findByRole("menuitem", { name: /Merge vào nhánh đang đứng/ });
    expect(merge.hasAttribute("data-disabled")).toBe(true);
    expect(within(merge).getByText("Cần đứng trên một nhánh")).toBeTruthy();
    expect(
      (await screen.findByRole("menuitem", { name: /Rebase nhánh đang đứng lên nhánh này/ })).hasAttribute(
        "data-disabled",
      ),
    ).toBe(true);
    await user.click(merge);
    expect(app.named("git_branches_merge")).toEqual([]);
  });
});

describe("GitOperationPanel", () => {
  const renderPanel = (op: GitOperation, handlers: Record<string, Handler> = {}) => {
    const app = fakeTauri(handlers);
    const props = { onFinished: vi.fn(), onTerminal: vi.fn() };
    render(<GitOperationPanel folder={FOLDER} operation={op} {...props} />);
    return { ...app, ...props };
  };

  it("hiện bước n/m, file xung đột và lệnh git reset --keep <headBefore> (chỉ để đọc)", () => {
    const { calls } = renderPanel(operation({ kind: "rebase", step: 2, total: 3 }));
    expect(screen.getByRole("region", { name: "Đang rebase" })).toBeTruthy();
    expect(screen.getByText("Bước 2/3")).toBeTruthy();
    expect(screen.getByText("src/pay.ts")).toBeTruthy();
    expect(screen.getByText(`git reset --keep ${HEAD_BEFORE}`)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("Tiếp tục khi còn file U: sidecar trả conflict, khung giữ nguyên và báo còn bao nhiêu file", async () => {
    const still = operation({ conflicts: ["src/pay.ts"], conflictsTotal: 1 });
    const { named, onFinished } = renderPanel(operation(), { git_branches_continue: () => ({ operation: still }) });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Tiếp tục" }));
    expect(await screen.findByText("Còn 1 file chưa giải quyết, git chưa được chạy.")).toBeTruthy();
    expect(screen.getByText("1 file còn xung đột:")).toBeTruthy();
    expect(screen.queryByText("src/cart.ts")).toBeNull();
    expect(screen.getByText("src/pay.ts")).toBeTruthy();
    expect(named("git_branches_continue")).toEqual([{ folder: FOLDER }]);
    expect(onFinished).not.toHaveBeenCalled();
  });

  it("rebase sang bước sau cũng xung đột: cập nhật bước và file", async () => {
    const next = operation({ kind: "rebase", step: 3, total: 3, conflicts: ["src/next.ts"], conflictsTotal: 1 });
    renderPanel(operation({ kind: "rebase", step: 2, total: 3 }), {
      git_branches_continue: () => ({ operation: next }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Tiếp tục" }));
    expect(await screen.findByText("Bước 3/3")).toBeTruthy();
    expect(screen.getByText("src/next.ts")).toBeTruthy();
  });

  it("hết xung đột: Tiếp tục xong thì báo cho BranchesSheet", async () => {
    const finished = operation({ state: "done", conflicts: [], conflictsTotal: 0, head: "e0e0e0e" });
    const { onFinished } = renderPanel(operation({ conflicts: [], conflictsTotal: 0 }), {
      git_branches_continue: () => ({ operation: finished }),
    });
    expect(screen.getByText("Không còn file xung đột. Bấm Tiếp tục để hoàn tất.")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Tiếp tục" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith(finished));
  });

  it("Huỷ hỏi lại trước; Giữ lại thì không gọi, Huỷ thao tác thì gọi abort", async () => {
    const aborted = operation({ state: "aborted", conflicts: [], conflictsTotal: 0, head: HEAD_BEFORE });
    const { named, onFinished } = renderPanel(operation(), { git_branches_abort: () => ({ operation: aborted }) });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Huỷ" }));
    expect(screen.getByText(/đưa thư mục về như trước khi bắt đầu/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Giữ lại" }));
    expect(named("git_branches_abort")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Huỷ" }));
    await user.click(screen.getByRole("button", { name: "Huỷ thao tác" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith(aborted));
    expect(named("git_branches_abort")).toEqual([{ folder: FOLDER }]);
  });

  it("Mở thư mục và Mở terminal", async () => {
    const { named, onTerminal } = renderPanel(operation(), { open_folder: () => undefined });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Mở thư mục" }));
    await user.click(screen.getByRole("button", { name: "Mở terminal" }));
    expect(named("open_folder")).toEqual([{ folder: FOLDER }]);
    expect(onTerminal).toHaveBeenCalledWith(FOLDER);
  });

  it("lỗi của sidecar khi Tiếp tục hiện ngay trong khung", async () => {
    renderPanel(operation(), {
      git_branches_continue: () => failure("no_operation", { message: "Không có thao tác dở." }),
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Tiếp tục" }));
    expect(await screen.findByText("Không có thao tác dở.")).toBeTruthy();
  });

  it("tiếng Anh", () => {
    setLang("en");
    renderPanel(operation({ kind: "rebase", step: 1, total: 2 }));
    expect(screen.getByRole("region", { name: "Rebase in progress" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Abort" })).toBeTruthy();
    expect(screen.getByText("Step 1/2")).toBeTruthy();
  });
});

describe("CleanupDialog: nhãn bằng chứng từ API", () => {
  const scanned = (repo: ScanRepo) => {
    const app = fakeApp(repoOf());
    return { app, repo };
  };

  it("MR đã merge, PR đã đóng và lỗi đọc API kèm lý do", async () => {
    const { app, repo } = scanned({
      folder: FOLDER,
      defaultBranch: "main",
      current: "main",
      fetched: ["origin"],
      fetchFailed: [],
      apiError: "token hết hạn",
      candidates: [
        {
          folder: FOLDER,
          branch: "ai/gl",
          tip: "abc1234",
          committedAt: 1_792_000_000,
          evidence: { kind: "mergedApi", provider: "gitlab", number: 12 },
          selected: true,
        },
        {
          folder: FOLDER,
          branch: "ai/gh",
          tip: "abc1235",
          committedAt: 1_792_000_000,
          evidence: { kind: "closedApi", provider: "github", number: 7 },
          selected: false,
        },
      ],
      blocked: [],
    });
    render(<CleanupDialog folders={[FOLDER]} onClose={() => {}} onChanged={() => {}} />);
    await waitFor(() => expect(app.named("git_branches_scan")).toHaveLength(1));
    const id = `scan-${seq}`;
    await app.emit(id, { type: "repo", folder: FOLDER, repo, done: 1, total: 1 });
    await app.emit(id, { type: "done", total: 1 });
    expect(await screen.findByText("MR !12 đã merge")).toBeTruthy();
    expect(screen.getByText("PR #7 đã đóng, chưa merge")).toBeTruthy();
    expect(screen.getByText("Không đọc được PR/MR: token hết hạn")).toBeTruthy();
  });
});
