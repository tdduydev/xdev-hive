import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchSwitchDialog } from "@/components/branch-switch-dialog.tsx";
import {
  branch,
  FOLDER,
  failure,
  fakeTauri,
  remoteBranch,
  repoOf,
  sentence,
  status,
} from "@/components/branch-test-helpers.ts";
import { BranchesSheet } from "@/components/branches-sheet.tsx";
import type { BranchInfo, SwitchResult } from "@/lib/git-branches.ts";
import { setLang } from "@/lib/i18n.ts";

beforeEach(() => setLang("vi"));

const done = (name: string): SwitchResult => ({ folder: FOLDER, branch: name, head: "77aa", carried: false });

function renderDialog(target: BranchInfo, handler: (args?: Record<string, unknown>) => unknown) {
  const app = fakeTauri({ git_branches_switch: handler });
  const props = { onClose: vi.fn(), onSwitched: vi.fn(), onOpenTerminal: vi.fn() };
  render(<BranchSwitchDialog folder={FOLDER} branch={target} {...props} />);
  return { ...app, ...props };
}

describe("BranchSwitchDialog", () => {
  it("thư mục sạch: đổi ngay sang nhánh local, không hỏi gì", async () => {
    const { named, onSwitched } = renderDialog(branch("feature"), () => done("feature"));
    await waitFor(() => expect(onSwitched).toHaveBeenCalledWith(done("feature")));
    expect(named("git_branches_switch")).toEqual([
      { folder: FOLDER, branch: "feature", track: null, carry: false, confirmBusy: false },
    ]);
  });

  it("nhánh chỉ có trên remote: đổi bằng --track", async () => {
    const { named, onSwitched } = renderDialog(remoteBranch("feature"), () => done("feature"));
    await waitFor(() => expect(onSwitched).toHaveBeenCalled());
    expect(named("git_branches_switch")).toEqual([
      { folder: FOLDER, branch: null, track: "origin/feature", carry: false, confirmBusy: false },
    ]);
  });

  it("chỉ gửi một lệnh ghi dù StrictMode chạy effect hai lần", async () => {
    const app = fakeTauri({ git_branches_switch: () => done("feature") });
    const onSwitched = vi.fn();
    render(
      <StrictMode>
        <BranchSwitchDialog
          folder={FOLDER}
          branch={branch("feature")}
          onClose={() => {}}
          onSwitched={onSwitched}
          onOpenTerminal={() => {}}
        />
      </StrictMode>,
    );
    await waitFor(() => expect(onSwitched).toHaveBeenCalled());
    expect(app.named("git_branches_switch")).toHaveLength(1);
    expect(onSwitched).toHaveBeenCalledTimes(1);
  });

  it("dirty: liệt kê file, 'Đổi, mang thay đổi theo' gọi lại với --carry (Q10)", async () => {
    const handler = vi
      .fn()
      .mockReturnValueOnce(failure("dirty", { files: ["src/a.ts", "README.md"], filesTotal: 5 }))
      .mockReturnValueOnce({ ...done("feature"), carried: true });
    const { named, onSwitched } = renderDialog(branch("feature"), handler);
    const user = userEvent.setup();

    expect(await screen.findByText("Thư mục có 5 file đang sửa.")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
    expect(screen.getByText("và 3 file khác")).toBeTruthy();
    expect(onSwitched).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Đổi, mang thay đổi theo" }));
    await waitFor(() => expect(onSwitched).toHaveBeenCalled());
    expect(named("git_branches_switch").map((a) => a?.carry)).toEqual([false, true]);
  });

  it("dirty rồi Huỷ: đóng, không gọi lại", async () => {
    const { named, onClose, onSwitched } = renderDialog(branch("feature"), () => failure("dirty", { files: ["a"] }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Huỷ" }));
    expect(onClose).toHaveBeenCalled();
    expect(onSwitched).not.toHaveBeenCalled();
    expect(named("git_branches_switch")).toHaveLength(1);
  });

  it("agent đang chạy: xác nhận lần nữa (FR-014), rồi gặp dirty thì không hỏi lại về agent", async () => {
    const handler = vi
      .fn()
      .mockReturnValueOnce(failure("busy", { busy: [{ path: FOLDER, kind: "agent", label: "claude (pid 4242)" }] }))
      .mockReturnValueOnce(failure("dirty", { files: ["a.ts"], filesTotal: 1 }))
      .mockReturnValueOnce(done("feature"));
    const { named, onSwitched } = renderDialog(branch("feature"), handler);
    const user = userEvent.setup();

    expect(await screen.findByText("Có chương trình đang dùng thư mục này.")).toBeTruthy();
    expect(screen.getByText(/claude \(pid 4242\)/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Vẫn đổi" }));

    await user.click(await screen.findByRole("button", { name: "Đổi, mang thay đổi theo" }));
    await waitFor(() => expect(onSwitched).toHaveBeenCalled());
    expect(named("git_branches_switch").map((a) => [a?.confirmBusy, a?.carry])).toEqual([
      [false, false],
      [true, false],
      [true, true],
    ]);
  });

  it("agent không có nhãn thì gọi theo loại", async () => {
    renderDialog(branch("feature"), () => failure("busy", { busy: [{ path: FOLDER, kind: "terminal" }] }));
    expect(await screen.findByText(/Terminal đang mở/)).toBeTruthy();
  });

  it("nhánh đang mở ở worktree khác: báo đường dẫn, có nút mở terminal ở đó", async () => {
    const { onOpenTerminal, onSwitched } = renderDialog(branch("feature"), () =>
      failure("checked_out", { path: "/Users/ha/Code/shop-wt/feature" }),
    );
    const user = userEvent.setup();
    expect(await screen.findByText(/Nhánh đang mở ở .*shop-wt\/feature/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Mở terminal ở đó" }));
    expect(onOpenTerminal).toHaveBeenCalledWith("/Users/ha/Code/shop-wt/feature");
    expect(onSwitched).not.toHaveBeenCalled();
  });

  it("đang dở rebase: nêu thao tác và không có nút thử lại", async () => {
    renderDialog(branch("feature"), () => failure("in_progress", { operation: "rebase" }));
    expect(await screen.findByText(/Repo đang rebase dở/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Thử lại" })).toBeNull();
    expect(screen.getByRole("button", { name: "Đóng" })).toBeTruthy();
  });

  it("local cùng tên đã có (--track): báo, chỉ sang tab Local", async () => {
    renderDialog(remoteBranch("feature"), () => failure("exists"));
    expect(await screen.findByText(/Đã có nhánh local cùng tên/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Thử lại" })).toBeNull();
  });

  it("git từ chối: hiện dòng cuối stderr đã che (FR-042), có Thử lại", async () => {
    const handler = vi
      .fn()
      .mockReturnValueOnce(
        failure("git", {
          message: "Git không đổi được nhánh.",
          detail: "error: Your local changes to the following files would be overwritten by checkout: a.ts",
        }),
      )
      .mockReturnValueOnce(done("feature"));
    const { onSwitched } = renderDialog(branch("feature"), handler);
    const user = userEvent.setup();
    expect(await screen.findByText("Git không đổi được nhánh.")).toBeTruthy();
    expect(screen.getByText(/would be overwritten by checkout/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    await waitFor(() => expect(onSwitched).toHaveBeenCalled());
  });

  it("lệnh Tauri lỗi (sidecar cũ): hiện nguyên câu lỗi", async () => {
    renderDialog(branch("feature"), () => {
      throw "Worker không phản hồi sau 90 giây.";
    });
    expect(await screen.findByText("Worker không phản hồi sau 90 giây.")).toBeTruthy();
  });
});

describe("BranchesSheet: đổi nhánh", () => {
  const sheetApp = (switchHandler: (args?: Record<string, unknown>) => unknown, over = {}) => {
    const repo = repoOf({
      branches: [
        branch("main", { isCurrent: true, isDefault: true }),
        branch("feature", { committedAt: 1_792_000_500 }),
        remoteBranch("remote-only"),
      ],
      ...over,
    });
    const app = fakeTauri({
      git_branches_list: () => ({ ...repo, jobId: "list-1" }),
      git_branches_switch: switchHandler,
    });
    const onChanged = vi.fn();
    render(<BranchesSheet folder={FOLDER} name="shop" onClose={() => {}} onChanged={onChanged} />);
    return { ...app, onChanged };
  };

  // Mỗi `user.click` là một lần bấm; SC-005 giới hạn 3 lần cho mỗi thao tác.
  const clicks = (user: ReturnType<typeof userEvent.setup>) => {
    let n = 0;
    return {
      get count() {
        return n;
      },
      click: async (el: HTMLElement) => {
        n++;
        await user.click(el);
      },
    };
  };

  it("thư mục sạch: 2 lần bấm, rồi đọc lại bảng và báo màn Dự án", async () => {
    const { named, onChanged } = sheetApp(() => done("feature"));
    const c = clicks(userEvent.setup());

    await c.click(await screen.findByRole("button", { name: "Thao tác với feature" }));
    await c.click(await screen.findByRole("menuitem", { name: "Đổi sang nhánh này" }));

    expect(await screen.findByText(sentence("Đã đổi sang feature."))).toBeTruthy();
    expect(c.count).toBe(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(named("git_branches_list")).toHaveLength(2);
    expect(screen.queryByText("Đổi sang feature")).toBeNull();
  });

  it("dirty: 3 lần bấm (menu, Đổi sang, Đổi mang thay đổi theo)", async () => {
    const handler = vi
      .fn()
      .mockReturnValueOnce(failure("dirty", { files: ["a.ts"], filesTotal: 1 }))
      .mockReturnValueOnce({ ...done("feature"), carried: true });
    sheetApp(handler);
    const c = clicks(userEvent.setup());

    await c.click(await screen.findByRole("button", { name: "Thao tác với feature" }));
    await c.click(await screen.findByRole("menuitem", { name: "Đổi sang nhánh này" }));
    await c.click(await screen.findByRole("button", { name: "Đổi, mang thay đổi theo" }));

    expect(await screen.findByText(sentence("Đã đổi sang feature."))).toBeTruthy();
    expect(c.count).toBe(3);
  });

  it("nhánh chỉ có trên remote đổi bằng --track", async () => {
    const { named } = sheetApp(() => done("remote-only"));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: /Remote/ }));
    await user.click(await screen.findByRole("button", { name: "Thao tác với origin/remote-only" }));
    await user.click(await screen.findByRole("menuitem", { name: "Đổi sang nhánh này" }));
    await screen.findByText(sentence("Đã đổi sang remote-only."));
    expect(named("git_branches_switch")[0]).toMatchObject({ track: "origin/remote-only", branch: null });
  });

  it("nhánh đang đứng không có mục Đổi sang", async () => {
    sheetApp(() => done("main"));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Thao tác với main" }));
    expect(await screen.findByRole("menuitem", { name: "Sao chép tên" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Đổi sang nhánh này" })).toBeNull();
  });

  it("Q13: đang đứng ở nhánh khác nhánh mặc định thì gợi ý Về nhánh mặc định, một lần bấm", async () => {
    const { named } = sheetApp(() => done("main"), {
      current: status({ branch: "ai/DOCS" }),
      branches: [branch("main", { isDefault: true }), branch("ai/DOCS", { isCurrent: true })],
    });
    const user = userEvent.setup();
    expect(await screen.findByText(/không phải nhánh mặc định/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Về nhánh mặc định" }));
    await screen.findByText(sentence("Đã đổi sang main."));
    expect(named("git_branches_switch")[0]).toMatchObject({ branch: "main", track: null });
  });

  it("Q13: thư mục có thay đổi thì nút Về nhánh mặc định tắt", async () => {
    sheetApp(() => done("main"), {
      current: status({ branch: "ai/DOCS", dirty: true }),
      branches: [branch("main", { isDefault: true }), branch("ai/DOCS", { isCurrent: true })],
    });
    const button = await screen.findByRole("button", { name: "Về nhánh mặc định" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("Q13: đang ở nhánh mặc định thì không gợi ý", async () => {
    sheetApp(() => done("main"));
    await screen.findByRole("button", { name: "Thao tác với main" });
    expect(screen.queryByRole("button", { name: "Về nhánh mặc định" })).toBeNull();
  });

  it("chữ tiếng Anh theo ngôn ngữ", async () => {
    setLang("en");
    const handler = vi.fn().mockReturnValueOnce(failure("dirty", { files: ["a.ts"], filesTotal: 1 }));
    sheetApp(handler);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Actions for feature" }));
    await user.click(await screen.findByRole("menuitem", { name: "Switch to this branch" }));
    const dialog = (await screen.findAllByRole("dialog")).at(-1) as HTMLElement;
    expect(within(dialog).getByRole("button", { name: "Switch, carry changes" })).toBeTruthy();
  });
});
