import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { type Account, type AccountStatus, initials, profileOf } from "@/lib/account.ts";
import { setLang } from "@/lib/i18n.ts";
import { AppShell } from "@/shell/app-shell.tsx";

const ACCOUNT: Account = {
  name: "Phạm Hà",
  email: "ha@acme.vn",
  orgId: "o1",
  orgName: "Acme",
  orgRole: "member",
  teams: [{ id: "t1", name: "Thanh toán", role: "member" }],
};
const HUB = "https://hive.acme.vn";

function fakeTauri(handlers: Record<string, (args?: Record<string, unknown>) => unknown>) {
  const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const handler = handlers[command];
        if (!handler) throw new Error(`lệnh chưa giả: ${command}`);
        return (await handler(args)) as T;
      },
    },
    window: { getCurrentWindow: () => ({ label: "app" }) },
  };
  return calls;
}

const unlinked: AccountStatus = { hub: HUB, linked: false, account: null, error: null };
const linked = (account: Account): AccountStatus => ({ hub: HUB, linked: true, account, error: null });

describe("hồ sơ từ vai trò", () => {
  it("lead, dev, writer theo vai trò tổ chức và đội", () => {
    expect(profileOf(null)).toBe("dev");
    expect(profileOf({ ...ACCOUNT, orgRole: "admin" })).toBe("lead");
    expect(profileOf({ ...ACCOUNT, teams: [{ id: "t", name: "A", role: "admin" }] })).toBe("lead");
    expect(profileOf(ACCOUNT)).toBe("dev");
    expect(profileOf({ ...ACCOUNT, teams: [{ id: "t", name: "A", role: "viewer" }] })).toBe("writer");
    expect(profileOf({ ...ACCOUNT, teams: [] })).toBe("dev");
    expect(initials("Phạm Thu Hà")).toBe("PH");
    expect(initials("")).toBe("?");
  });
});

describe("liên kết tài khoản", () => {
  beforeEach(() => setLang("vi"));

  it("chưa liên kết: dán token, app gửi đúng token rồi hiện tên và vai trò", async () => {
    const calls = fakeTauri({
      account_status: () => unlinked,
      account_link: () => linked(ACCOUNT),
    });
    render(<AppShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Chưa đăng nhập/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(await within(dialog).findByLabelText("Token MCP cá nhân"), "hive_pat_abc");
    await user.click(within(dialog).getByRole("button", { name: "Đăng nhập" }));
    expect(await within(dialog).findByText("Đang dùng tài khoản Phạm Hà ở Acme.")).toBeTruthy();
    expect(calls.find((c) => c.command === "account_link")?.args).toEqual({ token: "hive_pat_abc" });
    expect(screen.getByText("Dev · Thanh toán")).toBeTruthy();
  });

  it("hub từ chối token: hiện câu lỗi của app, không đóng hộp thoại", async () => {
    fakeTauri({
      account_status: () => unlinked,
      account_link: () => Promise.reject("Token không còn dùng được (sai, hết hạn hoặc đã thu hồi)."),
    });
    render(<AppShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Chưa đăng nhập/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(await within(dialog).findByLabelText("Token MCP cá nhân"), "hive_pat_bad");
    await user.click(within(dialog).getByRole("button", { name: "Đăng nhập" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Token không còn dùng được");
  });

  it("writer không thấy Môi trường và Lượt chạy; lead thấy đủ", async () => {
    fakeTauri({
      account_status: () => linked({ ...ACCOUNT, teams: [{ id: "t1", name: "Thanh toán", role: "viewer" }] }),
    });
    const { unmount } = render(<AppShell />);
    expect(await screen.findByText("Viết tài liệu · Thanh toán")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Môi trường" })).toBeNull();
    unmount();
    fakeTauri({ account_status: () => linked({ ...ACCOUNT, orgRole: "owner" }) });
    render(<AppShell />);
    expect(await screen.findByText("Trưởng nhóm · Thanh toán")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Lượt chạy trên máy" })).toBeTruthy();
  });

  it("token đã lưu hỏng: báo trong hộp thoại và cho gỡ", async () => {
    const calls = fakeTauri({
      account_status: () => ({ hub: HUB, linked: true, account: null, error: "Token không còn dùng được." }),
      account_unlink: () => unlinked,
    });
    render(<AppShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Chưa đăng nhập/ }));
    const dialog = await screen.findByRole("dialog");
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Token không còn dùng được.");
    await user.click(within(dialog).getByRole("button", { name: "Đăng xuất" }));
    // Gỡ token là việc không làm lại được: luôn hỏi lại trước.
    expect(calls.some((c) => c.command === "account_unlink")).toBe(false);
    const confirm = await screen.findByRole("dialog", { name: "Đăng xuất khỏi Hive?" });
    await user.click(within(confirm).getByRole("button", { name: "Đăng xuất" }));
    await waitFor(() => expect(calls.some((c) => c.command === "account_unlink")).toBe(true));
  });

  it("máy chưa đăng ký: kết nối Hive ngay trong hộp thoại, xong thì đọc lại tài khoản", async () => {
    let status: AccountStatus = { hub: null, linked: false, account: null, error: null };
    const calls = fakeTauri({
      account_status: () => status,
      browser_login: () => {
        status = linked(ACCOUNT);
        return "may-ha";
      },
    });
    render(<AppShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Chưa đăng nhập/ }));
    const dialog = await screen.findByRole("dialog");
    // Chưa có hub thì chưa có chỗ dán token cá nhân: kết nối máy trước.
    const hub = await within(dialog).findByLabelText("Địa chỉ hub công khai");
    expect(within(dialog).queryByLabelText("Token MCP cá nhân")).toBeNull();
    await user.type(hub, HUB);
    await user.click(within(dialog).getByRole("button", { name: "Đăng nhập bằng trình duyệt" }));
    expect(await within(dialog).findByText("Đang dùng tài khoản Phạm Hà ở Acme.")).toBeTruthy();
    expect(calls.find((c) => c.command === "browser_login")?.args).toEqual({ hub: HUB });
    expect(screen.getByText("Dev · Thanh toán")).toBeTruthy();
  });

  it("đăng xuất từ thẻ người dùng: hỏi lại, nói rõ máy vẫn đăng ký, xong thì về chưa đăng nhập", async () => {
    const calls = fakeTauri({ account_status: () => linked(ACCOUNT), account_unlink: () => unlinked });
    render(<AppShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Phạm Hà/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Đăng xuất khỏi Hive" }));
    const confirm = await screen.findByRole("dialog", { name: "Đăng xuất khỏi Hive?" });
    expect(confirm.textContent).toContain("Máy vẫn đăng ký với hub: worker vẫn nhận việc");
    await user.click(within(confirm).getByRole("button", { name: "Đăng xuất" }));
    expect(await screen.findByRole("button", { name: /Chưa đăng nhập/ })).toBeTruthy();
    expect(calls.filter((c) => c.command === "account_unlink")).toHaveLength(1);
    const nav = screen.getByRole("navigation", { name: "Điều hướng app" });
    expect(within(nav).getByRole("link", { name: "Gói agent" }).hasAttribute("data-offline")).toBe(false);
    expect(within(nav).getByRole("link", { name: "Việc của tôi" }).hasAttribute("data-offline")).toBe(true);
  });

  it("huỷ ở hộp hỏi lại thì không gỡ token", async () => {
    const calls = fakeTauri({ account_status: () => linked(ACCOUNT), account_unlink: () => unlinked });
    render(<AppShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Phạm Hà/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Đăng xuất khỏi Hive" }));
    const confirm = await screen.findByRole("dialog", { name: "Đăng xuất khỏi Hive?" });
    await user.click(within(confirm).getByRole("button", { name: "Huỷ" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.command === "account_unlink")).toBe(false);
    expect(screen.getByRole("button", { name: /Phạm Hà/ })).toBeTruthy();
  });

  it("thẻ người dùng mở được hộp thoại tài khoản từ menu", async () => {
    fakeTauri({ account_status: () => linked(ACCOUNT) });
    render(<AppShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Phạm Hà/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Tài khoản và vai trò" }));
    const dialog = await screen.findByRole("dialog", { name: "Tài khoản" });
    expect(within(dialog).getByText("Đang dùng tài khoản Phạm Hà ở Acme.")).toBeTruthy();
  });

  it("đăng xuất từ khay: app nghe sự kiện và đọc lại tài khoản", async () => {
    let status = linked(ACCOUNT);
    let emit: (() => void) | null = null;
    fakeTauri({ account_status: () => status });
    Object.assign(window.__TAURI__ ?? {}, {
      event: {
        listen: async <T,>(event: string, handler: (e: { payload: T }) => void) => {
          if (event === "account-changed") emit = () => handler({ payload: undefined as T });
          return () => {};
        },
      },
    });
    render(<AppShell />);
    expect(await screen.findByRole("button", { name: /Phạm Hà/ })).toBeTruthy();
    status = unlinked;
    await waitFor(() => expect(emit).not.toBeNull());
    act(() => emit?.());
    expect(await screen.findByRole("button", { name: /Chưa đăng nhập/ })).toBeTruthy();
  });
});
