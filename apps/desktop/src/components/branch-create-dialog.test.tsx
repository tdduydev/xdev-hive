import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchCreateDialog } from "@/components/branch-create-dialog.tsx";
import {
  branch,
  FOLDER,
  failure,
  fakeTauri,
  remoteBranch,
  repoOf,
  sentence,
} from "@/components/branch-test-helpers.ts";
import { BranchesSheet } from "@/components/branches-sheet.tsx";
import type { CreateResult, RepoBranches } from "@/lib/git-branches.ts";
import { setLang } from "@/lib/i18n.ts";

beforeEach(() => setLang("vi"));

const created = (over: Partial<CreateResult> = {}): CreateResult => ({
  folder: FOLDER,
  name: "feature/abc",
  base: "refs/remotes/origin/main",
  tip: "df58",
  switched: true,
  fetched: true,
  dryRun: false,
  ...over,
});

// `--dry-run` trả kết quả thường (tên dùng được); lần tạo thật theo `real`.
const handler = (real: (args: Record<string, unknown>) => unknown) => (args?: Record<string, unknown>) =>
  args?.dryRun ? created({ dryRun: true }) : real(args ?? {});

const repo = (over: Partial<RepoBranches> = {}) =>
  repoOf({
    branches: [branch("main", { isCurrent: true, isDefault: true }), branch("develop"), remoteBranch("release")],
    ...over,
  });

function renderDialog(real: (args: Record<string, unknown>) => unknown, over: Partial<RepoBranches> = {}) {
  const app = fakeTauri({ git_branches_create: handler(real) });
  const props = { onClose: vi.fn(), onCreated: vi.fn() };
  render(<BranchCreateDialog folder={FOLDER} repo={repo(over)} {...props} />);
  return { ...app, ...props, user: userEvent.setup() };
}

const nameBox = () => screen.getByRole("textbox", { name: "Tên nhánh" });
const submit = () => screen.getByRole("button", { name: "Tạo nhánh" }) as HTMLButtonElement;

describe("BranchCreateDialog", () => {
  it("mặc định: gốc là nhánh mặc định trên remote, đổi sang và fetch trước đều bật", async () => {
    renderDialog(() => created());
    expect((screen.getByRole("combobox", { name: "Nhánh gốc" }) as HTMLSelectElement).value).toBe(
      "refs/remotes/origin/main",
    );
    expect((screen.getByRole("checkbox", { name: /Đổi sang nhánh mới/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Fetch nhánh gốc trước/ }) as HTMLInputElement).checked).toBe(true);
    expect(submit().disabled).toBe(true);
  });

  it("gõ tên rồi Tạo: gửi tên, gốc là ref đầy đủ, đổi sang, fetch trước", async () => {
    const { named, onCreated, user } = renderDialog(() => created());
    await user.type(nameBox(), "feature/abc");
    expect(await screen.findByText("Tên dùng được.")).toBeTruthy();
    await user.click(submit());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created()));
    expect(named("git_branches_create").at(-1)).toEqual({
      folder: FOLDER,
      name: "feature/abc",
      base: "refs/remotes/origin/main",
      switchTo: true,
      fetch: true,
      carry: false,
      confirmBusy: false,
      dryRun: false,
    });
    // Lần kiểm tên trước khi bấm Tạo là --dry-run, không ghi gì.
    expect(named("git_branches_create").filter((a) => a?.dryRun)).not.toHaveLength(0);
  });

  it("Enter trong ô tên cũng tạo", async () => {
    const { onCreated, user } = renderDialog(() => created());
    await user.type(nameBox(), "feature/abc");
    await screen.findByText("Tên dùng được.");
    await user.type(nameBox(), "{Enter}");
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("tên sai: nút tắt, nêu lý do, không gọi sidecar", async () => {
    const { calls, user } = renderDialog(() => created());
    await user.type(nameBox(), "a..b");
    expect(await screen.findByText(/không được có “\.\.”/)).toBeTruthy();
    expect(submit().disabled).toBe(true);
    expect(nameBox().getAttribute("aria-invalid")).toBe("true");
    await new Promise((r) => setTimeout(r, 350));
    expect(calls.filter((c) => c.command === "git_branches_create")).toHaveLength(0);
  });

  it("tên có khoảng trắng hay .lock bị chặn ngay", async () => {
    const { user } = renderDialog(() => created());
    await user.type(nameBox(), "a b");
    expect(await screen.findByText(/khoảng trắng/)).toBeTruthy();
    await user.clear(nameBox());
    await user.type(nameBox(), "x.lock");
    expect(await screen.findByText(/“\.lock”/)).toBeTruthy();
    expect(submit().disabled).toBe(true);
  });

  it("tên đã có (dry-run báo exists): báo 'Nhánh đã có', nút tắt", async () => {
    fakeTauri({ git_branches_create: () => failure("exists") });
    const props = { onClose: vi.fn(), onCreated: vi.fn() };
    render(<BranchCreateDialog folder={FOLDER} repo={repo()} {...props} />);
    const user = userEvent.setup();
    await user.type(nameBox(), "develop");
    expect(await screen.findByText(/Nhánh đã có/)).toBeTruthy();
    expect(submit().disabled).toBe(true);
    expect(props.onCreated).not.toHaveBeenCalled();
  });

  it("git từ chối tên (dry-run invalid_name): hiện lý do của sidecar", async () => {
    fakeTauri({
      git_branches_create: () => failure("invalid_name", { message: "Tên nhánh không hợp lệ.", detail: "fatal: bad" }),
    });
    render(<BranchCreateDialog folder={FOLDER} repo={repo()} onClose={() => {}} onCreated={() => {}} />);
    await userEvent.setup().type(nameBox(), "ok-name");
    expect(await screen.findByText(/Tên nhánh không hợp lệ\. fatal: bad/)).toBeTruthy();
    expect(submit().disabled).toBe(true);
  });

  it("sidecar chưa hỗ trợ dry-run (not_implemented) thì không chặn nút Tạo", async () => {
    fakeTauri({ git_branches_create: () => failure("not_implemented") });
    render(<BranchCreateDialog folder={FOLDER} repo={repo()} onClose={() => {}} onCreated={() => {}} />);
    await userEvent.setup().type(nameBox(), "feature/abc");
    await waitFor(() => expect(submit().disabled).toBe(false));
  });

  it("gốc là nhánh local: không fetch, ô fetch tắt và khoá; bỏ 'Đổi sang' thì chỉ tạo", async () => {
    const { named, onCreated, user } = renderDialog(() => created({ switched: false, fetched: false }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Nhánh gốc" }), "refs/heads/develop");
    const fetchBox = screen.getByRole("checkbox", { name: /Fetch nhánh gốc trước/ }) as HTMLInputElement;
    expect(fetchBox.checked).toBe(false);
    expect(fetchBox.disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /Đổi sang nhánh mới/ }));
    await user.type(nameBox(), "feature/x");
    await screen.findByText("Tên dùng được.");
    await user.click(submit());
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(named("git_branches_create").at(-1)).toMatchObject({
      base: "refs/heads/develop",
      switchTo: false,
      fetch: false,
    });
  });

  it("tắt 'Fetch nhánh gốc trước' với gốc remote thì không fetch", async () => {
    const { named, user } = renderDialog(() => created({ fetched: false }));
    await user.click(screen.getByRole("checkbox", { name: /Fetch nhánh gốc trước/ }));
    await user.type(nameBox(), "feature/x");
    await screen.findByText("Tên dùng được.");
    await user.click(submit());
    await waitFor(() => expect(named("git_branches_create").at(-1)).toMatchObject({ fetch: false, dryRun: false }));
  });

  it("nhánh remote chưa có bản local nằm trong danh sách gốc", async () => {
    renderDialog(() => created());
    const group = screen.getByRole("group", { name: "Nhánh remote" });
    expect(within(group).getByRole("option", { name: "origin/main" })).toBeTruthy();
    expect(within(group).getByRole("option", { name: "origin/release" })).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: "Nhánh local" })).getByRole("option", { name: "develop" }),
    ).toBeTruthy();
  });

  it("fetch lỗi: hỏi 'Tạo từ bản đã có trên máy?', đồng ý thì gọi lại không fetch", async () => {
    const real = vi
      .fn()
      .mockReturnValueOnce(failure("fetch_failed", { remote: "origin", detail: "fatal: unable to access" }))
      .mockReturnValueOnce(created({ fetched: false }));
    const { named, onCreated, user } = renderDialog(real);
    await user.type(nameBox(), "feature/abc");
    await screen.findByText("Tên dùng được.");
    await user.click(submit());
    expect(await screen.findByText("Không fetch được từ origin. Tạo từ bản đã có trên máy?")).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Tạo từ bản trên máy" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const writes = named("git_branches_create").filter((a) => !a?.dryRun);
    expect(writes.map((a) => a?.fetch)).toEqual([true, false]);
  });

  it("dirty khi đổi sang: liệt kê file, 'Tạo, mang thay đổi theo' gửi --carry", async () => {
    const real = vi
      .fn()
      .mockReturnValueOnce(failure("dirty", { files: ["src/a.ts"], filesTotal: 4 }))
      .mockReturnValueOnce(created());
    const { named, onCreated, user } = renderDialog(real);
    await user.type(nameBox(), "feature/abc");
    await screen.findByText("Tên dùng được.");
    await user.click(submit());
    expect(await screen.findByText("Thư mục có 4 file đang sửa.")).toBeTruthy();
    expect(screen.getByText("và 3 file khác")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Tạo, mang thay đổi theo" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(
      named("git_branches_create")
        .filter((a) => !a?.dryRun)
        .map((a) => a?.carry),
    ).toEqual([false, true]);
  });

  it("agent đang chạy: xác nhận rồi gửi confirmBusy", async () => {
    const real = vi
      .fn()
      .mockReturnValueOnce(failure("busy", { busy: [{ path: FOLDER, kind: "agent", label: "codex (pid 7)" }] }))
      .mockReturnValueOnce(created());
    const { named, onCreated, user } = renderDialog(real);
    await user.type(nameBox(), "feature/abc");
    await screen.findByText("Tên dùng được.");
    await user.click(submit());
    expect(await screen.findByText(/codex \(pid 7\)/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Vẫn tạo" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(
      named("git_branches_create")
        .filter((a) => !a?.dryRun)
        .map((a) => a?.confirmBusy),
    ).toEqual([false, true]);
  });

  it("đang dở thao tác: báo lỗi, giữ hộp thoại", async () => {
    const { onCreated, user } = renderDialog(() =>
      failure("in_progress", { operation: "merge", message: "Repo đang merge dở." }),
    );
    await user.type(nameBox(), "feature/abc");
    await screen.findByText("Tên dùng được.");
    await user.click(submit());
    expect(await screen.findByText(/Repo đang merge dở/)).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("Huỷ đóng hộp thoại, không tạo gì", async () => {
    const { named, onClose, user } = renderDialog(() => created());
    await user.click(screen.getByRole("button", { name: "Huỷ" }));
    expect(onClose).toHaveBeenCalled();
    expect(named("git_branches_create")).toHaveLength(0);
  });
});

describe("BranchesSheet: tạo nhánh", () => {
  it("2 lần bấm (Tạo nhánh, Tạo) khi thư mục sạch; xong thì đọc lại bảng và báo màn Dự án", async () => {
    const app = fakeTauri({
      git_branches_list: () => ({ ...repo(), jobId: "list-1" }),
      git_branches_create: handler(() => created()),
    });
    const onChanged = vi.fn();
    render(<BranchesSheet folder={FOLDER} name="shop" onClose={() => {}} onChanged={onChanged} />);
    const user = userEvent.setup();
    let clicks = 0;
    const click = async (el: HTMLElement) => {
      clicks++;
      await user.click(el);
    };

    await click(await screen.findByRole("button", { name: "Tạo nhánh" }));
    await user.type(nameBox(), "feature/abc");
    await screen.findByText("Tên dùng được.");
    await click(submit());

    expect(await screen.findByText(sentence("Đã tạo và đổi sang feature/abc."))).toBeTruthy();
    expect(clicks).toBe(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(app.named("git_branches_list")).toHaveLength(2);
  });

  it("tạo mà không đổi sang: thông báo đúng", async () => {
    fakeTauri({
      git_branches_list: () => ({ ...repo(), jobId: "list-1" }),
      git_branches_create: handler(() => created({ switched: false })),
    });
    render(<BranchesSheet folder={FOLDER} name="shop" onClose={() => {}} onChanged={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Tạo nhánh" }));
    await user.click(screen.getByRole("checkbox", { name: /Đổi sang nhánh mới/ }));
    await user.type(nameBox(), "feature/abc");
    await screen.findByText("Tên dùng được.");
    await user.click(submit());
    expect(await screen.findByText(sentence("Đã tạo nhánh feature/abc."))).toBeTruthy();
  });
});
