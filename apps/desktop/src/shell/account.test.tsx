import { render, screen, within } from "@testing-library/react";
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
    await user.click(await screen.findByRole("button", { name: /Chưa liên kết tài khoản/ }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Token MCP cá nhân"), "hive_pat_abc");
    await user.click(within(dialog).getByRole("button", { name: "Liên kết" }));
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
    await user.click(await screen.findByRole("button", { name: /Chưa liên kết tài khoản/ }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Token MCP cá nhân"), "hive_pat_bad");
    await user.click(within(dialog).getByRole("button", { name: "Liên kết" }));
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
    await user.click(await screen.findByRole("button", { name: /Chưa liên kết tài khoản/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("alert").textContent).toContain("Token không còn dùng được.");
    await user.click(within(dialog).getByRole("button", { name: "Gỡ liên kết" }));
    expect(calls.some((c) => c.command === "account_unlink")).toBe(true);
  });

  it("máy chưa đăng ký: không cho liên kết", async () => {
    fakeTauri({ account_status: () => ({ hub: null, linked: false, account: null, error: null }) });
    render(<AppShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Chưa liên kết tài khoản/ }));
    expect(screen.getByText(/Máy chưa đăng ký với hub nào/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Liên kết" })).toBeNull();
  });
});
