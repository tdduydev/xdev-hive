import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import type { LocalSession, RemoteStatus } from "@/lib/remote.ts";
import { RemoteScreen } from "@/screens/remote-screen.tsx";

const STATUS: RemoteStatus = {
  enabled: true,
  shared: true,
  roots: [{ id: "r1", label: "payment-api", path: "/Users/ha/Work/payment-api" }],
  devices: [{ id: "d1", label: "iPhone của Hà", userId: "u1", synced: true, createdAt: "2026-10-01T00:00:00Z" }],
  confirmOnMachine: true,
  idleMinutes: 30,
  detachedHours: 8,
  maxHours: 12,
  allowFullAccess: false,
  totpOnHttps: false,
  totp: { enabled: false, locked: false },
};

const SESSIONS: LocalSession[] = [
  {
    id: "s1",
    cli: "claude",
    cwd: "/Users/ha/Work/payment-api",
    account: "",
    started: new Date().toISOString(),
    controlled: true,
    viewers: 1,
  },
  {
    id: "s2",
    cli: "codex",
    cwd: "/Users/ha/Work/web-admin",
    account: "",
    started: new Date().toISOString(),
    controlled: false,
    viewers: 0,
  },
];

interface Opts {
  status?: Partial<RemoteStatus>;
  sessions?: LocalSession[];
  hub?: string | null;
  extra?: Record<string, (args?: Record<string, unknown>) => unknown>;
}

function fakeTauri(opts: Opts = {}) {
  let status: RemoteStatus = { ...STATUS, ...opts.status };
  let sessions = opts.sessions ?? SESSIONS;
  const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    worker_state: () => ({
      kind: "online",
      label: "",
      detail: null,
      wanted: true,
      hub: opts.hub ?? "https://hive.example.com",
    }),
    remote_status: () => status,
    remote_enable: () => {
      status = { ...status, enabled: true };
      return status;
    },
    remote_disable: () => {
      status = { ...status, enabled: false };
      return status;
    },
    remote_root_add: (a) => {
      const path = String(a?.path);
      status = { ...status, roots: [...status.roots, { id: "r2", label: "web-admin", path }] };
      return status.roots.at(-1);
    },
    remote_root_remove: (a) => {
      status = { ...status, roots: status.roots.filter((r) => r.id !== a?.id) };
    },
    remote_device_remove: (a) => {
      status = { ...status, devices: status.devices.filter((d) => d.id !== a?.id) };
    },
    remote_pair: () => ({
      pairId: "p1",
      expiresAt: "2026-10-15T10:10:00Z",
      url: "https://hive.example.com/pair#abc123",
    }),
    remote_pair_decide: () => undefined,
    remote_set: (a) => {
      const map: Record<string, keyof RemoteStatus> = {
        "confirm-on-machine": "confirmOnMachine",
        "allow-full-access": "allowFullAccess",
        "idle-minutes": "idleMinutes",
        "totp-on-https": "totpOnHttps",
      };
      const field = map[String(a?.key)];
      const raw = String(a?.value);
      const value = raw === "on" ? true : raw === "off" ? false : Number(raw);
      status = { ...status, ...(field ? { [field]: value } : {}) };
      return status;
    },
    remote_sessions: () => sessions,
    remote_session_kill: (a) => {
      sessions = sessions.filter((s) => s.id !== a?.id);
    },
    remote_totp_enroll: () => ({
      uri: "otpauth://totp/Hive:may?secret=JBSWY3DPEHPK3PXP&issuer=Hive",
      secret: "JBSWY3DPEHPK3PXP",
      expiresAt: "2026-10-15T10:10:00Z",
      hubUrl: opts.hub ?? "https://hive.example.com",
    }),
    remote_totp_confirm: () => {
      status = { ...status, totp: { enabled: true, locked: false } };
    },
    remote_totp_disable: () => {
      status = { ...status, totp: { enabled: false, locked: false } };
    },
    remote_totp_unlock: () => undefined,
    hive_cli_status: () => ({
      available: true,
      path: "/usr/local/bin/hive",
      installed: true,
      upToDate: true,
      onPath: true,
      dir: "/usr/local/bin",
    }),
    "plugin:dialog|open": () => "/Users/ha/Work/web-admin",
    ...opts.extra,
  };
  const listeners = new Map<string, ((e: { payload: unknown }) => void)[]>();
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const handler = handlers[command];
        if (!handler) throw new Error(`lệnh chưa giả: ${command}`);
        return (await handler(args)) as T;
      },
    },
    event: {
      listen: async <T,>(event: string, handler: (e: { payload: T }) => void) => {
        const all = listeners.get(event) ?? [];
        all.push(handler as (e: { payload: unknown }) => void);
        listeners.set(event, all);
        return () =>
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((h) => h !== handler),
          );
      },
    },
  };
  return {
    calls,
    named: (command: string) => calls.filter((c) => c.command === command),
    emit: async (event: string, payload: unknown) => {
      await act(async () => {
        for (const h of listeners.get(event) ?? []) h({ payload });
      });
    },
  };
}

const confirmDialog = async () => within(await screen.findByRole("alertdialog"));

describe("màn Điều khiển từ xa", () => {
  beforeEach(() => setLang("vi"));

  it("đang tắt: chỉ có công tắc và lời giải thích, chưa lộ thư mục hay thiết bị", async () => {
    fakeTauri({ status: { enabled: false } });
    render(<RemoteScreen />);
    const toggle = await screen.findByRole("switch", { name: "Cho điều khiển từ xa" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Đang tắt: điện thoại không mở hay xem trực tiếp/)).toBeTruthy();
    expect(screen.queryByText("Thư mục được phép")).toBeNull();
  });

  it("bật phải qua bước xác nhận nêu rủi ro; Huỷ thì không gọi hive", async () => {
    const tauri = fakeTauri({ status: { enabled: false } });
    const user = userEvent.setup();
    render(<RemoteScreen />);
    await user.click(await screen.findByRole("switch", { name: "Cho điều khiển từ xa" }));
    const dialog = await confirmDialog();
    expect(dialog.getByText("Agent có thể chạy lệnh trên máy này khi bạn điều khiển từ điện thoại.")).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Huỷ" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(tauri.named("remote_enable")).toHaveLength(0);

    await user.click(screen.getByRole("switch", { name: "Cho điều khiển từ xa" }));
    await user.click((await confirmDialog()).getByRole("button", { name: "Bật" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Cho điều khiển từ xa" }).getAttribute("aria-checked")).toBe("true"),
    );
    expect(tauri.named("remote_enable")).toHaveLength(1);
    expect(await screen.findByText("Thư mục được phép")).toBeTruthy();
  });

  it("tắt thì gọi ngay, không hỏi lại", async () => {
    const tauri = fakeTauri();
    const user = userEvent.setup();
    render(<RemoteScreen />);
    await user.click(await screen.findByRole("switch", { name: "Cho điều khiển từ xa" }));
    await waitFor(() => expect(tauri.named("remote_disable")).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("thêm thư mục bằng bộ chọn của hệ điều hành rồi gỡ", async () => {
    const tauri = fakeTauri();
    const user = userEvent.setup();
    render(<RemoteScreen />);
    expect(await screen.findByText("~/Work/payment-api")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Thêm thư mục" }));
    expect(await screen.findByText("~/Work/web-admin")).toBeTruthy();
    expect(tauri.named("remote_root_add")[0]?.args).toEqual({ path: "/Users/ha/Work/web-admin", label: null });
    await user.click(screen.getByRole("button", { name: "Gỡ thư mục payment-api" }));
    await waitFor(() => expect(screen.queryByText("~/Work/payment-api")).toBeNull());
    expect(tauri.named("remote_root_remove")[0]?.args).toEqual({ id: "r1" });
  });

  it("ghép điện thoại: vẽ QR từ địa chỉ ghép, hỏi Cho phép trên máy rồi đóng QR khi xong", async () => {
    const tauri = fakeTauri();
    const user = userEvent.setup();
    render(<RemoteScreen />);
    expect(await screen.findByText("iPhone của Hà")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Ghép điện thoại" }));
    const qr = await screen.findByRole("img", { name: "Mã QR ghép thiết bị" });
    expect(qr.querySelector("path")?.getAttribute("d")?.length).toBeGreaterThan(100);
    expect(screen.getByText("https://hive.example.com/pair#abc123")).toBeTruthy();
    expect(screen.getByText("Mã hết hạn sau 10 phút và chỉ dùng một lần.")).toBeTruthy();

    await tauri.emit("remote-pair-request", { event: "pair_request", pairId: "p1", label: "iPhone mới" });
    const dialog = await confirmDialog();
    expect(dialog.getByText("Điện thoại xin ghép:")).toBeTruthy();
    expect(dialog.getByText("iPhone mới")).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Cho phép" }));
    await waitFor(() => expect(tauri.named("remote_pair_decide")[0]?.args).toEqual({ pairId: "p1", allow: true }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await tauri.emit("remote-pair-done", { event: "pair_done", pairId: "p1", ok: true, label: "iPhone mới" });
    await waitFor(() => expect(screen.queryByRole("img", { name: "Mã QR ghép thiết bị" })).toBeNull());
    expect(screen.getByText("Đã ghép iPhone mới.")).toBeTruthy();
  });

  it("từ chối yêu cầu ghép gửi allow=false; ghép hỏng thì nói lý do bằng tiếng Việt", async () => {
    const tauri = fakeTauri();
    const user = userEvent.setup();
    render(<RemoteScreen />);
    await screen.findByText("iPhone của Hà");
    await tauri.emit("remote-pair-request", { event: "pair_request", pairId: "-p2", label: "Máy lạ" });
    await user.click((await confirmDialog()).getByRole("button", { name: "Từ chối" }));
    await waitFor(() => expect(tauri.named("remote_pair_decide")[0]?.args).toEqual({ pairId: "-p2", allow: false }));
    await tauri.emit("remote-pair-done", { event: "pair_done", pairId: "-p2", ok: false, reason: "denied" });
    expect(await screen.findByText("Ghép không thành công: Đã từ chối ghép.")).toBeTruthy();
  });

  it("gỡ thiết bị đã ghép", async () => {
    const tauri = fakeTauri();
    const user = userEvent.setup();
    render(<RemoteScreen />);
    await user.click(await screen.findByRole("button", { name: "Gỡ thiết bị iPhone của Hà" }));
    await waitFor(() => expect(screen.getByText("Chưa ghép điện thoại nào.")).toBeTruthy());
    expect(tauri.named("remote_device_remove")[0]?.args).toEqual({ id: "d1" });
  });

  it("tuỳ chọn: công tắc gọi remote_set; toàn quyền phải xác nhận; số nhập xong mới lưu", async () => {
    const tauri = fakeTauri();
    const user = userEvent.setup();
    render(<RemoteScreen />);
    const confirmOnMachine = await screen.findByRole("switch", { name: "Hỏi trên máy khi ghép" });
    await user.click(confirmOnMachine);
    await waitFor(() => expect(confirmOnMachine.getAttribute("aria-checked")).toBe("false"));
    expect(tauri.named("remote_set")[0]?.args).toEqual({ key: "confirm-on-machine", value: "off" });

    await user.click(screen.getByRole("switch", { name: "Cho phép toàn quyền từ xa" }));
    await user.click((await confirmDialog()).getByRole("button", { name: "Bật" }));
    await waitFor(() => expect(tauri.named("remote_set")[1]?.args).toEqual({ key: "allow-full-access", value: "on" }));

    const idle = screen.getByRole("textbox", { name: "Không hoạt động quá (phút)" });
    await user.clear(idle);
    await user.type(idle, "45");
    await user.tab();
    await waitFor(() => expect(tauri.named("remote_set")[2]?.args).toEqual({ key: "idle-minutes", value: "45" }));

    await user.clear(idle);
    await user.type(idle, "0");
    await user.tab();
    expect((idle as HTMLInputElement).value).toBe("45");
    expect(tauri.named("remote_set")).toHaveLength(3);
  });

  it("danh sách phiên: Giữ lại không ngắt, Ngắt hỏi rồi mới gọi hive kill", async () => {
    const tauri = fakeTauri();
    const user = userEvent.setup();
    render(<RemoteScreen />);
    expect(await screen.findByText("claude · ~/Work/payment-api")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Ngắt phiên codex · ~/Work/web-admin" }));
    let dialog = await confirmDialog();
    expect(dialog.getByText("Ngắt phiên này?")).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Giữ lại" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(tauri.named("remote_session_kill")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Ngắt phiên codex · ~/Work/web-admin" }));
    dialog = await confirmDialog();
    await user.click(dialog.getByRole("button", { name: "Ngắt" }));
    await waitFor(() => expect(screen.queryByText("codex · ~/Work/web-admin")).toBeNull());
    expect(tauri.named("remote_session_kill").map((c) => c.args)).toEqual([{ id: "s2" }]);
  });

  it("Ngắt tất cả nói rõ cả phiên đang gõ tại máy, rồi ngắt từng phiên", async () => {
    const tauri = fakeTauri();
    const user = userEvent.setup();
    render(<RemoteScreen />);
    await screen.findByText("claude · ~/Work/payment-api");
    await user.click(screen.getByRole("button", { name: "Ngắt tất cả" }));
    const dialog = await confirmDialog();
    expect(dialog.getByText(/kể cả phiên bạn đang gõ tại máy/)).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Ngắt tất cả" }));
    expect(await screen.findByText("Không có phiên nào đang chạy.")).toBeTruthy();
    expect(tauri.named("remote_session_kill").map((c) => c.args)).toEqual([{ id: "s1" }, { id: "s2" }]);
  });

  it("danh sách phiên cập nhật theo sự kiện của Rust và nói CLI chưa cho biết nguồn mở phiên", async () => {
    const tauri = fakeTauri({ sessions: [] });
    render(<RemoteScreen />);
    expect(await screen.findByText("Không có phiên nào đang chạy.")).toBeTruthy();
    await tauri.emit("remote-sessions", { sessions: SESSIONS.slice(0, 1) });
    expect(await screen.findByText("claude · ~/Work/payment-api")).toBeTruthy();
    expect(screen.getByText(/CLI chưa cho biết phiên nào do điện thoại mở/)).toBeTruthy();
    await tauri.emit("remote-sessions", { sessions: [{ ...SESSIONS[0], origin: "remote" }] });
    expect(await screen.findByText(/Từ điện thoại/)).toBeTruthy();
  });

  it("TOTP: bật phải quét QR rồi nhập đúng mã 6 số; tắt phải xác nhận", async () => {
    const tauri = fakeTauri();
    const user = userEvent.setup();
    render(<RemoteScreen />);
    await user.click(await screen.findByRole("button", { name: "Bật mã Authenticator" }));
    expect(await screen.findByRole("img", { name: "Mã QR khoá Authenticator" })).toBeTruthy();
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Xác nhận và bật" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Nhập mã 6 số hiện trong app Authenticator"), "12a3456");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await user.click(confirm);
    await waitFor(() => expect(tauri.named("remote_totp_confirm")[0]?.args).toEqual({ code: "123456" }));
    expect(await screen.findByRole("button", { name: "Tắt mã Authenticator" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Mã QR khoá Authenticator" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Tắt mã Authenticator" }));
    await user.click((await confirmDialog()).getByRole("button", { name: "Tắt mã Authenticator" }));
    expect(await screen.findByRole("button", { name: "Bật mã Authenticator" })).toBeTruthy();
    expect(tauri.named("remote_totp_disable")).toHaveLength(1);
  });

  it("TOTP đang khoá thì có nút Mở khoá", async () => {
    const tauri = fakeTauri({ status: { totp: { enabled: true, locked: true } } });
    const user = userEvent.setup();
    render(<RemoteScreen />);
    await user.click(await screen.findByRole("button", { name: "Mở khoá" }));
    await waitFor(() => expect(tauri.named("remote_totp_unlock")).toHaveLength(1));
  });

  it("hub chạy HTTP: cảnh báo ở đầu màn, trong xác nhận bật và ở mục TOTP", async () => {
    fakeTauri({ hub: "http://192.168.1.5:8080", status: { enabled: false } });
    const user = userEvent.setup();
    render(<RemoteScreen />);
    expect(await screen.findByText(/Hub chạy HTTP: nội dung phiên và phím gõ không được mã hoá/)).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "Cho điều khiển từ xa" }));
    const dialog = await confirmDialog();
    expect(dialog.getByText(/Hub chạy HTTP/)).toBeTruthy();
  });

  it("hub HTTPS không có cảnh báo HTTP; mục TOTP chỉ cảnh báo khi hub là HTTP", async () => {
    fakeTauri();
    render(<RemoteScreen />);
    await screen.findByText("Mã Authenticator (đường lui cho hub HTTP)");
    expect(screen.queryByText(/Hub chạy HTTP/)).toBeNull();
    expect(screen.queryByText(/Trên HTTP, nội dung phiên/)).toBeNull();
  });

  it("hub HTTP: mục TOTP cảnh báo mạng không mã hoá", async () => {
    fakeTauri({ hub: "http://hive.lan" });
    render(<RemoteScreen />);
    expect(await screen.findByText(/Trên HTTP, nội dung phiên và phím gõ đi qua mạng không mã hoá/)).toBeTruthy();
  });

  it("không tải được trạng thái thì báo lỗi và cho tải lại", async () => {
    let fail = true;
    fakeTauri({
      extra: {
        remote_status: () => {
          if (fail) throw "Không kết nối được hive-worker.";
          return STATUS;
        },
      },
    });
    const user = userEvent.setup();
    render(<RemoteScreen />);
    expect(await screen.findByText("Không tải được trạng thái điều khiển từ xa.")).toBeTruthy();
    expect(screen.getByText("Không kết nối được hive-worker.")).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Tải lại" }));
    expect(await screen.findByText("Thư mục được phép")).toBeTruthy();
  });

  it("lỗi khi ghi hiện bằng chữ Rust trả về", async () => {
    fakeTauri({
      extra: {
        remote_root_add: () => {
          throw "Thư mục không tồn tại.";
        },
      },
    });
    const user = userEvent.setup();
    render(<RemoteScreen />);
    await user.click(await screen.findByRole("button", { name: "Thêm thư mục" }));
    expect(await screen.findByText("Thư mục không tồn tại.")).toBeTruthy();
  });

  it("lệnh hive: chưa cài thì có nút cài, cài xong báo thư mục chưa nằm trong PATH", async () => {
    const tauri = fakeTauri({
      status: { enabled: false },
      extra: {
        hive_cli_status: () => ({
          available: true,
          path: null,
          installed: false,
          upToDate: false,
          onPath: false,
          dir: "/Users/ha/.local/bin",
        }),
        hive_cli_install: () => ({
          available: true,
          path: "/Users/ha/.local/bin/hive",
          installed: true,
          upToDate: true,
          onPath: false,
          dir: "/Users/ha/.local/bin",
        }),
      },
    });
    const user = userEvent.setup();
    render(<RemoteScreen />);
    await user.click(await screen.findByRole("button", { name: "Cài lệnh hive" }));
    expect(await screen.findByText(/chưa nằm trong PATH/)).toBeTruthy();
    expect(tauri.named("hive_cli_install")).toHaveLength(1);
  });

  it("đổi sang tiếng Anh", async () => {
    fakeTauri({ status: { enabled: false } });
    setLang("en");
    render(<RemoteScreen />);
    expect(await screen.findByRole("switch", { name: "Allow remote control" })).toBeTruthy();
    expect(screen.getByText(/Off: no phone can open or watch a session live/)).toBeTruthy();
  });
});
