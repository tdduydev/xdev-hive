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
      hub_check: (args) => args?.hub,
      account_link: () => linked(ACCOUNT),
    });
    render(<AppShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Chưa đăng nhập/ }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Địa chỉ Hive") as HTMLInputElement).value).toBe(HUB);
    await user.click(within(dialog).getByText("Hoặc dùng token MCP cá nhân"));
    await user.type(await within(dialog).findByLabelText("Token MCP cá nhân"), "hive_pat_abc");
    await user.click(within(dialog).getByRole("button", { name: "Đăng nhập" }));
    expect(await within(dialog).findByText("Đang dùng tài khoản Phạm Hà ở Acme.")).toBeTruthy();
    // Chỉ kiểm TLS trước khi gửi token; cùng địa chỉ thì không đổi worker.
    expect(calls.some((c) => c.command === "hub_change")).toBe(false);
    expect(calls.find((c) => c.command === "account_link")?.args).toEqual({ token: "hive_pat_abc" });
    expect(screen.getByText("Dev · Thanh toán")).toBeTruthy();
  });

  it("hub từ chối token: hiện câu lỗi của app, không đóng hộp thoại", async () => {
    fakeTauri({
      account_status: () => unlinked,
      hub_check: (args) => args?.hub,
      account_link: () => Promise.reject("Token không còn dùng được (sai, hết hạn hoặc đã thu hồi)."),
    });
    render(<AppShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Chưa đăng nhập/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByText("Hoặc dùng token MCP cá nhân"));
    await user.type(await within(dialog).findByLabelText("Token MCP cá nhân"), "hive_pat_bad");
    await user.click(within(dialog).getByRole("button", { name: "Đăng nhập" }));
    expect(await within(dialog).findByText(/Token không còn dùng được/)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
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
      hub_check: (args) => args?.hub,
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
    const hub = await within(dialog).findByLabelText("Địa chỉ Hive");
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

describe("đăng nhập lại và đổi địa chỉ hub", () => {
  beforeEach(() => setLang("vi"));
  const NEW = "https://10.86.224.34";
  const OLD = "http://10.86.224.34:7780";
  const at = (hub: string, account: Account | null): AccountStatus => ({
    hub,
    linked: !!account,
    account,
    error: null,
  });

  async function signOutThenOpen(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /Phạm Hà/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Đăng xuất khỏi Hive" }));
    const confirm = await screen.findByRole("dialog", { name: "Đăng xuất khỏi Hive?" });
    await user.click(within(confirm).getByRole("button", { name: "Đăng xuất" }));
    await user.click(await screen.findByRole("button", { name: /Chưa đăng nhập/ }));
    return screen.findByRole("dialog", { name: "Tài khoản" });
  }

  it("đăng xuất rồi đăng nhập lại bằng trình duyệt ở cùng hub: không đăng ký lại máy", async () => {
    let status = at(OLD, ACCOUNT);
    const calls = fakeTauri({
      account_status: () => status,
      account_unlink: () => {
        status = at(OLD, null);
        return status;
      },
      hub_check: (args) => args?.hub,
      account_browser_login: () => {
        status = at(OLD, ACCOUNT);
        return status;
      },
    });
    render(<AppShell />);
    const user = userEvent.setup();
    const dialog = await signOutThenOpen(user);
    // Ô địa chỉ vẫn có và điền sẵn hub đang lưu, kể cả khi máy đã đăng ký.
    expect((within(dialog).getByLabelText("Địa chỉ Hive") as HTMLInputElement).value).toBe(OLD);
    await user.click(within(dialog).getByRole("button", { name: "Đăng nhập bằng trình duyệt" }));
    expect(await within(dialog).findByText("Đang dùng tài khoản Phạm Hà ở Acme.")).toBeTruthy();
    const commands = calls.map((c) => c.command);
    expect(commands).toContain("account_browser_login");
    expect(commands).not.toContain("browser_login");
    expect(commands).not.toContain("hub_change");
  });

  it("đăng nhập → đăng xuất → đổi địa chỉ → đăng nhập bằng trình duyệt ở hub mới", async () => {
    let status = at(OLD, ACCOUNT);
    const calls = fakeTauri({
      account_status: () => status,
      account_unlink: () => {
        status = at(OLD, null);
        return status;
      },
      hub_check: (args) => String(args?.hub).replace(/\/$/, ""),
      hub_change: (args) => {
        status = at(String(args?.hub), null);
        return { hub: args?.hub, changed: true, needsRegister: false };
      },
      account_browser_login: () => {
        status = at(NEW, ACCOUNT);
        return status;
      },
    });
    render(<AppShell />);
    const user = userEvent.setup();
    const dialog = await signOutThenOpen(user);
    const field = within(dialog).getByLabelText("Địa chỉ Hive");
    await user.clear(field);
    await user.type(field, `${NEW}/`);
    await user.click(within(dialog).getByRole("button", { name: "Đăng nhập bằng trình duyệt" }));
    expect(await within(dialog).findByText("Đang dùng tài khoản Phạm Hà ở Acme.")).toBeTruthy();
    const steps = ["hub_check", "hub_change", "account_browser_login", "browser_login"];
    const order = calls.map((c) => c.command).filter((c) => steps.includes(c));
    expect(order).toEqual(["hub_check", "hub_change", "account_browser_login"]);
    expect(calls.find((c) => c.command === "hub_check")?.args).toEqual({ hub: `${NEW}/` });
    expect(calls.find((c) => c.command === "hub_change")?.args).toEqual({ hub: NEW });
    expect((within(dialog).getByLabelText("Địa chỉ Hive") as HTMLInputElement).value).toBe(NEW);
  });

  it("hub mới không nhận đăng ký cũ: hỏi trước, đồng ý thì đăng ký lại bằng trình duyệt", async () => {
    let status = at(OLD, null);
    const calls = fakeTauri({
      account_status: () => status,
      hub_check: (args) => args?.hub,
      hub_change: (args) => ({ hub: args?.hub, changed: false, needsRegister: true }),
      browser_login: () => {
        status = at(NEW, ACCOUNT);
        return "mac-ha";
      },
    });
    render(<AppShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Chưa đăng nhập/ }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText("Địa chỉ Hive");
    await user.clear(field);
    await user.type(field, NEW);
    await user.click(within(dialog).getByRole("button", { name: "Đăng nhập bằng trình duyệt" }));
    expect(await within(dialog).findByText("Đăng ký lại máy với hub mới?")).toBeTruthy();
    expect(within(dialog).getByText(/Gói agent, dự án, tài khoản CLI và tài liệu trên máy giữ nguyên/)).toBeTruthy();
    // Chưa đồng ý thì chưa đăng ký lại.
    expect(calls.some((c) => c.command === "browser_login")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Đăng ký lại và đăng nhập" }));
    expect(await within(dialog).findByText("Đang dùng tài khoản Phạm Hà ở Acme.")).toBeTruthy();
    expect(calls.find((c) => c.command === "browser_login")?.args).toEqual({ hub: NEW });
  });

  it("huỷ ở bước hỏi đăng ký lại thì không đăng ký", async () => {
    const calls = fakeTauri({
      account_status: () => at(OLD, null),
      hub_check: (args) => args?.hub,
      hub_change: (args) => ({ hub: args?.hub, changed: false, needsRegister: true }),
    });
    render(<AppShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Chưa đăng nhập/ }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText("Địa chỉ Hive");
    await user.clear(field);
    await user.type(field, NEW);
    await user.click(within(dialog).getByRole("button", { name: "Đăng nhập bằng trình duyệt" }));
    await user.click(await within(dialog).findByRole("button", { name: "Huỷ" }));
    expect(within(dialog).queryByText("Đăng ký lại máy với hub mới?")).toBeNull();
    expect(calls.some((c) => c.command === "browser_login" || c.command === "register_worker")).toBe(false);
  });

  it("chứng chỉ hub chưa được tin: hiện hướng dẫn cài chứng chỉ, không đổi gì", async () => {
    const calls = fakeTauri({
      account_status: () => at(OLD, null),
      hub_check: () =>
        Promise.reject(
          "Máy này chưa tin chứng chỉ HTTPS của 10.86.224.34. Hub dùng chứng chỉ nội bộ (vd. Caddy local CA) thì xin quản trị hub file chứng chỉ gốc (root.crt) rồi cài vào máy: macOS mở file bằng Keychain Access, thêm vào System và chọn Always Trust.",
        ),
    });
    render(<AppShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Chưa đăng nhập/ }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText("Địa chỉ Hive");
    await user.clear(field);
    await user.type(field, NEW);
    await user.click(within(dialog).getByRole("button", { name: "Đăng nhập bằng trình duyệt" }));
    const error = await within(dialog).findByText(/chưa tin chứng chỉ HTTPS/);
    expect(error.textContent).toContain("root.crt");
    expect(error.textContent).toContain("Always Trust");
    const commands = calls.map((c) => c.command);
    expect(commands).not.toContain("hub_change");
    expect(commands).not.toContain("account_browser_login");
    // Sửa địa chỉ thì lỗi cũ biến mất, thử lại được.
    await user.type(field, "x");
    expect(within(dialog).queryByText(/chưa tin chứng chỉ HTTPS/)).toBeNull();
  });

  it("đã đăng nhập: đổi địa chỉ hub mà không phải đăng nhập lại", async () => {
    let status = at(OLD, ACCOUNT);
    const calls = fakeTauri({
      account_status: () => status,
      hub_check: (args) => args?.hub,
      hub_change: (args) => {
        status = at(String(args?.hub), ACCOUNT);
        return { hub: args?.hub, changed: true, needsRegister: false };
      },
    });
    render(<AppShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Phạm Hà/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Tài khoản và vai trò" }));
    const dialog = await screen.findByRole("dialog", { name: "Tài khoản" });
    const change = within(dialog).getByRole("button", { name: "Đổi địa chỉ" }) as HTMLButtonElement;
    expect(change.disabled).toBe(true);
    const field = within(dialog).getByLabelText("Địa chỉ Hive");
    await user.clear(field);
    await user.type(field, NEW);
    await user.click(change);
    expect(await within(dialog).findByText(`Đã chuyển máy sang ${NEW}. Worker đang kết nối lại.`)).toBeTruthy();
    expect(calls.some((c) => c.command.includes("login"))).toBe(false);
    expect(within(dialog).getByText("Đang dùng tài khoản Phạm Hà ở Acme.")).toBeTruthy();
  });

  it("sau đăng xuất, màn cần hub mời Kết nối Hive và mở đúng hộp thoại có ô địa chỉ", async () => {
    let status = at(OLD, ACCOUNT);
    fakeTauri({
      account_status: () => status,
      account_unlink: () => {
        status = at(OLD, null);
        return status;
      },
    });
    render(<AppShell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Phạm Hà/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Đăng xuất khỏi Hive" }));
    const confirm = await screen.findByRole("dialog", { name: "Đăng xuất khỏi Hive?" });
    await user.click(within(confirm).getByRole("button", { name: "Đăng xuất" }));
    await screen.findByRole("button", { name: /Chưa đăng nhập/ });
    const nav = screen.getByRole("navigation", { name: "Điều hướng app" });
    await user.click(within(nav).getByRole("link", { name: "Việc của tôi" }));
    await user.click(await screen.findByRole("button", { name: "Kết nối Hive" }));
    const dialog = await screen.findByRole("dialog", { name: "Tài khoản" });
    expect((within(dialog).getByLabelText("Địa chỉ Hive") as HTMLInputElement).value).toBe(OLD);
    expect(within(dialog).getByRole("button", { name: "Đăng nhập bằng trình duyệt" })).toBeTruthy();
  });
});
