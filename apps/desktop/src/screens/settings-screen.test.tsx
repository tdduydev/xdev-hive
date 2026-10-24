import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { type Account, AccountContext, ConnectContext, SignOutContext } from "@/lib/account.ts";
import { setLang } from "@/lib/i18n.ts";
import type { AppSettings } from "@/lib/settings.ts";
import { SettingsScreen } from "@/screens/settings-screen.tsx";

const ACCOUNT: Account = {
  name: "Trần Lan",
  email: "lan@acme.vn",
  orgId: "o1",
  orgName: "Acme Software",
  orgRole: "admin",
  teams: [{ id: "t1", name: "Thanh toán", role: "member" }],
};

const SETTINGS: AppSettings = {
  startWorker: true,
  hideOnClose: true,
  notifyRuns: true,
  notifyApprovals: true,
  notifyQuestions: true,
  notifyOffline: true,
  tokenScoreDaily: true,
};

type Handlers = Record<string, (args?: Record<string, unknown>) => unknown>;

function fakeTauri(over: Handlers = {}) {
  const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
  let settings = { ...SETTINGS };
  let push: (v: unknown) => void = () => {};
  const handlers: Handlers = {
    app_settings: () => settings,
    set_app_setting: (args) => {
      settings = { ...settings, [String(args?.key)]: args?.value };
      return settings;
    },
    this_machine: () => "dev-ha",
    worker_state: () => ({ kind: "online", label: "", detail: null, wanted: true, hub: "https://hive.acme.vn" }),
    "plugin:app|version": () => "0.9.4",
    update_status: () => ({ current: "0.9.4", ready: null }),
    check_updates_now: () => ({ current: "0.9.4", ready: null }),
    relaunch_to_update: () => undefined,
    ...over,
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
      listen: async <T,>(event: string, handler: (e: { payload: T }) => void) => {
        if (event === "update-ready") push = (v) => handler({ payload: v as T });
        return () => {};
      },
    },
  };
  return { calls, emitReady: (v: unknown) => act(async () => push(v)) };
}

function renderSettings(account: Account | null = ACCOUNT, signOut = () => {}, connect = () => {}) {
  return render(
    <AccountContext.Provider value={account}>
      <ConnectContext.Provider value={connect}>
        <SignOutContext.Provider value={account ? signOut : null}>
          <SettingsScreen />
        </SignOutContext.Provider>
      </ConnectContext.Provider>
    </AccountContext.Provider>,
  );
}

describe("SettingsScreen", () => {
  beforeEach(() => setLang("vi"));

  it("công tắc của worker và thông báo đọc từ Rust, đổi thì lưu qua set_app_setting", async () => {
    const { calls } = fakeTauri();
    renderSettings();
    const user = userEvent.setup();
    const start = await screen.findByRole("switch", { name: "Bật worker khi mở app" });
    // Công tắc khoá cho tới khi đọc xong cài đặt từ Rust.
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    expect(start.getAttribute("aria-checked")).toBe("true");
    await user.click(start);
    expect(calls.find((c) => c.command === "set_app_setting")?.args).toEqual({ key: "startWorker", value: false });
    expect(screen.getByRole("switch", { name: "Bật worker khi mở app" }).getAttribute("aria-checked")).toBe("false");
    for (const name of [
      "Đóng cửa sổ chỉ ẩn xuống khay",
      "Run trên máy xong hoặc lỗi",
      "Kế hoạch hoặc PR chờ tôi duyệt",
      "Agent hoặc Leader hỏi tôi",
      "Worker mất kết nối hub",
    ])
      expect(screen.getByRole("switch", { name }).getAttribute("aria-checked")).toBe("true");
    // Khởi động cùng Windows cần plugin autostart chưa có: chưa đưa lên màn.
    expect(screen.queryByText("Khởi động cùng Windows")).toBeNull();
  });

  it("tài khoản: vai trò, đội, hub; Đăng xuất khỏi Hive hỏi lại qua AppShell", async () => {
    fakeTauri();
    let asked = 0;
    renderSettings(ACCOUNT, () => {
      asked += 1;
    });
    const card = screen.getByRole("region", { name: "Tài khoản Hive" });
    expect(within(card).getByText("Trần Lan")).toBeTruthy();
    expect(within(card).getByText("Quản trị · Acme Software")).toBeTruthy();
    expect(within(card).getByText("Thanh toán · Thành viên")).toBeTruthy();
    expect(await within(card).findByText("hive.acme.vn")).toBeTruthy();
    await userEvent.setup().click(within(card).getByRole("button", { name: "Đăng xuất khỏi Hive" }));
    expect(asked).toBe(1);
    expect(within(card).getByText(/Máy vẫn đăng ký với hub/)).toBeTruthy();
  });

  it("chưa đăng nhập: nói rõ mục trên máy vẫn dùng được, nút mở hộp thoại kết nối", async () => {
    fakeTauri();
    let opened = 0;
    renderSettings(null, undefined, () => {
      opened += 1;
    });
    const card = screen.getByRole("region", { name: "Tài khoản Hive" });
    expect(within(card).getByText(/Không đăng nhập vẫn dùng được các mục trên máy/)).toBeTruthy();
    await userEvent.setup().click(within(card).getByRole("button", { name: "Kết nối Hive" }));
    expect(opened).toBe(1);
  });

  it("có bản mới: Xem thay đổi và Mở lại để cập nhật", async () => {
    const { calls, emitReady } = fakeTauri();
    renderSettings();
    await emitReady({ version: "0.9.5", notes: "## Có gì mới\n\n- Trang Máy này" });
    expect(screen.getByText("Đã có bản 0.9.5.")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Xem thay đổi" }));
    expect(await screen.findByRole("heading", { name: "Có gì mới" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Đóng" }));
    await user.click(screen.getByRole("button", { name: "Mở lại để cập nhật" }));
    expect(calls.some((c) => c.command === "relaunch_to_update")).toBe(true);
  });

  it("chưa có bản mới: Kiểm tra bản mới báo đang dùng bản mới nhất", async () => {
    const { calls } = fakeTauri();
    renderSettings();
    await userEvent.setup().click(screen.getByRole("button", { name: "Kiểm tra bản mới" }));
    expect(await screen.findByText("Đang dùng bản mới nhất (0.9.4).")).toBeTruthy();
    expect(calls.some((c) => c.command === "check_updates_now")).toBe(true);
  });

  it("đổi ngôn ngữ và giao diện ngay tại màn", async () => {
    fakeTauri();
    renderSettings();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Tối" }));
    expect(localStorage.getItem("hive.theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Tối" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByRole("region", { name: "Hive account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "English" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("không đọc được cài đặt: báo và khoá công tắc", async () => {
    fakeTauri({ app_settings: () => Promise.reject("lỗi đọc") });
    renderSettings();
    expect(await screen.findByText("Không đọc được cài đặt của app.")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Bật worker khi mở app" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("bí mật trên máy: nút mở hộp đề nghị xoá bí mật; Giữ lại liệt kê mục còn lại, không gọi purge", async () => {
    const { calls } = fakeTauri({
      secrets_list: () => ({
        secrets: [
          { name: "DATABASE_URL", description: "", createdAt: "", valueChangedAt: "", projects: [], inUseBy: 0 },
        ],
        reserved: { exact: [], prefixes: [] },
      }),
    });
    renderSettings();
    const user = userEvent.setup();
    const card = screen.getByRole("region", { name: "Bí mật trên máy" });
    expect(calls.some((c) => c.command === "secrets_list")).toBe(false);
    await user.click(within(card).getByRole("button", { name: /Dọn bí mật trước khi gỡ app/ }));
    const dialog = await screen.findByRole("dialog", { name: "Xoá mọi bí mật khỏi kho?" });
    expect(await within(dialog).findByText("DATABASE_URL")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Giữ lại" }));
    expect(await within(dialog).findByText("Các bí mật vẫn còn trong kho")).toBeTruthy();
    expect(within(dialog).getByText("DATABASE_URL")).toBeTruthy();
    expect(calls.some((c) => c.command === "secrets_purge")).toBe(false);
  });
});
