import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import type { SshCheck, SshHost, SshList, SshScan, SshSetup } from "@/lib/ssh.ts";
import { SshScreen } from "@/screens/ssh-screen.tsx";

const FP = "SHA256:Uo7/F8GVJ/JOuiV7cChrx2WTkwvBw5jOn6DsFs+7uOw";
const HOST_FP = "SHA256:hostKeyFingerprintXXXXXXXXXXXXXXXXXXXXXXXXX";

const KEY = {
  path: "/home/ha/.ssh/id_ed25519",
  exists: true,
  type: "ssh-ed25519",
  fingerprint: FP,
  comment: "ha@may xdev-hive 2026-10-17",
  publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv ha@may xdev-hive 2026-10-17",
  encrypted: false,
};

const host = (alias: string, over: Partial<SshHost> = {}): SshHost => ({
  alias,
  hostName: "192.0.2.10",
  user: "deploy",
  port: 22,
  managed: false,
  proxy: false,
  keyUsable: true,
  ...over,
});

const MACMINI = host("macmini", { hostName: "192.0.2.20", user: "duynh60" });
const HIVE = host("hive-prod", { managed: true, identityFile: "~/.ssh/id_ed25519" });

interface Call {
  command: string;
  args?: Record<string, unknown> | undefined;
}

function fakeApp(opts: {
  list?: Partial<SshList>;
  checks?: Record<string, SshCheck>;
  scan?: SshScan;
  setup?: () => SshSetup;
  /** Ghi đè lệnh Tauri để giả dữ liệu lạ hay lỗi của máy. */
  override?: Record<string, (args?: Record<string, unknown>) => unknown>;
}) {
  const calls: Call[] = [];
  let list: SshList = { ssh: "/usr/bin/ssh", configPath: "/home/ha/.ssh/config", key: KEY, hosts: [], ...opts.list };
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    ssh_list: () => list,
    ssh_check: (a) => opts.checks?.[String(a?.alias)] ?? { status: "auth" },
    ssh_scan: () =>
      opts.scan ?? {
        algorithm: "ssh-ed25519",
        fingerprint: HOST_FP,
        known: "unknown",
        adminCommand: "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub",
      },
    ssh_setup: () => {
      if (!opts.setup) throw "chưa giả ssh_setup";
      return opts.setup();
    },
    ssh_remove: (a) => {
      list = { ...list, hosts: list.hosts.filter((h) => h.alias !== a?.alias) };
      return list;
    },
    ssh_open_terminal: () => undefined,
    ...opts.override,
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
  };
  fakeApp.last = { calls };
  return { calls };
}
fakeApp.last = { calls: [] as Call[] };

const row = (alias: string) => screen.getByRole("row", { name: new RegExp(alias) });

beforeEach(() => setLang("vi"));

describe("màn Máy chủ SSH", () => {
  it("hiện khoá của máy, khối viết tay và khối của app, trạng thái tự kiểm khi mở", async () => {
    const { calls } = fakeApp({
      list: { hosts: [MACMINI, HIVE] },
      checks: { "hive-prod": { status: "ok" }, macmini: { status: "auth" } },
    });
    render(<SshScreen />);
    expect(await screen.findByText(FP)).toBeTruthy();
    expect(screen.getByText(KEY.path)).toBeTruthy();
    await waitFor(() => expect(within(row("hive-prod")).getByText("Khoá dùng được")).toBeTruthy());
    expect(within(row("hive-prod")).getByText("Do app quản lý")).toBeTruthy();
    expect(within(row("macmini")).getByText("duynh60@192.0.2.20:22")).toBeTruthy();
    expect(within(row("macmini")).getByText("Tự viết")).toBeTruthy();
    expect(within(row("macmini")).getByText("Cần thiết lập")).toBeTruthy();
    expect(calls.filter((c) => c.command === "ssh_check").map((c) => c.args?.alias)).toEqual(["macmini", "hive-prod"]);
  });

  it("chưa có khoá và chưa có OpenSSH: báo app sẽ tạo khoá và cách bật OpenSSH Client", async () => {
    fakeApp({ list: { ssh: "", key: { path: KEY.path, exists: false, encrypted: false } } });
    render(<SshScreen />);
    expect(await screen.findByText(/Máy chưa có OpenSSH client/)).toBeTruthy();
    expect(screen.getByText(/app tạo khoá ed25519/)).toBeTruthy();
    expect(screen.getByText(/Chưa có máy chủ nào/)).toBeTruthy();
  });

  it("Windows: ghi chú WSL có ~/.ssh riêng; macOS/Linux thì không", async () => {
    fakeApp({
      list: { configPath: "C:\\Users\\ha\\.ssh\\config", key: { ...KEY, path: "C:\\Users\\ha\\.ssh\\id_ed25519" } },
    });
    const { unmount } = render(<SshScreen />);
    expect(await screen.findByText(/WSL/)).toBeTruthy();
    unmount();
    fakeApp({});
    render(<SshScreen />);
    await screen.findByText(FP);
    expect(screen.queryByText(/WSL/)).toBeNull();
  });

  it("cài xong mà máy chủ vẫn từ chối khoá: gợi ý AuthorizedKeysFile", async () => {
    const user = userEvent.setup();
    fakeApp({
      scan: { algorithm: "ssh-ed25519", fingerprint: HOST_FP, known: "known", adminCommand: "x" },
      setup: () => ({ key: KEY, keyCreated: false, configWritten: true, check: { status: "auth" } }),
    });
    render(<SshScreen />);
    await user.click(await screen.findByRole("button", { name: "Thêm máy chủ" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Địa chỉ máy chủ"), "192.0.2.10");
    await user.type(within(dialog).getByLabelText("Tên đăng nhập"), "deploy");
    await user.type(within(dialog).getByLabelText("Tên gợi nhớ"), "hive-prod");
    await user.click(within(dialog).getByRole("button", { name: "Tiếp" }));
    await user.type(await within(dialog).findByLabelText(/Mật khẩu của/), "pw");
    await user.click(within(dialog).getByRole("button", { name: "Cài khoá" }));
    expect(await within(dialog).findByText(/AuthorizedKeysFile/)).toBeTruthy();
  });

  it("thêm máy chủ chưa biết: đối chiếu dấu vân tay trước, mật khẩu gửi một lần rồi ô trống", async () => {
    const user = userEvent.setup();
    const { calls } = fakeApp({
      setup: () => ({ key: KEY, keyCreated: true, configWritten: true, check: { status: "ok" } }),
    });
    render(<SshScreen />);
    await user.click(await screen.findByRole("button", { name: "Thêm máy chủ" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Địa chỉ máy chủ"), "192.0.2.10");
    await user.type(within(dialog).getByLabelText("Tên đăng nhập"), "deploy");
    await user.type(within(dialog).getByLabelText("Tên gợi nhớ"), "hive-prod");
    await user.click(within(dialog).getByRole("button", { name: "Tiếp" }));
    expect(await within(dialog).findByText(HOST_FP)).toBeTruthy();
    expect(within(dialog).getByText("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub")).toBeTruthy();
    expect(calls.find((c) => c.command === "ssh_scan")?.args).toEqual({ host: "192.0.2.10", port: 22 });
    const next = within(dialog).getByRole("button", { name: "Tiếp" });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).queryByLabelText(/Mật khẩu/)).toBeNull();
    await user.click(within(dialog).getByLabelText(/Tôi đã đối chiếu/));
    await user.click(next);
    const password = within(dialog).getByLabelText("Mật khẩu của deploy@192.0.2.10") as HTMLInputElement;
    expect(password.type).toBe("password");
    expect(password.autocomplete).toBe("off");
    await user.type(password, "pw-thu");
    await user.click(within(dialog).getByRole("button", { name: "Cài khoá" }));
    expect(await within(dialog).findByText(/ssh hive-prod đăng nhập bằng khoá/)).toBeTruthy();
    expect(within(dialog).getByText(/Đã tạo khoá mới/)).toBeTruthy();
    expect(calls.find((c) => c.command === "ssh_setup")?.args).toEqual({
      host: "192.0.2.10",
      port: 22,
      user: "deploy",
      alias: "hive-prod",
      fingerprint: HOST_FP,
      password: "pw-thu",
    });
    expect(within(dialog).queryByDisplayValue("pw-thu")).toBeNull();
    expect(calls.filter((c) => c.command === "ssh_list")).toHaveLength(2);
  });

  it("khoá máy chủ đã đổi: dừng, không có ô mật khẩu, không đi tiếp được", async () => {
    const user = userEvent.setup();
    fakeApp({ scan: { algorithm: "ssh-ed25519", fingerprint: HOST_FP, known: "changed", adminCommand: "x" } });
    render(<SshScreen />);
    await user.click(await screen.findByRole("button", { name: "Thêm máy chủ" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Địa chỉ máy chủ"), "192.0.2.10");
    await user.type(within(dialog).getByLabelText("Tên đăng nhập"), "deploy");
    await user.type(within(dialog).getByLabelText("Tên gợi nhớ"), "hive-prod");
    await user.click(within(dialog).getByRole("button", { name: "Tiếp" }));
    expect(await within(dialog).findByText("Khoá máy chủ đã đổi")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Tiếp" })).toBeNull();
    expect(within(dialog).queryByLabelText(/Mật khẩu/)).toBeNull();
    expect(within(dialog).queryByLabelText(/Tôi đã đối chiếu/)).toBeNull();
  });

  it("máy chủ đã biết: sang thẳng bước mật khẩu; cài lỗi thì báo lỗi và ô mật khẩu trống để gõ lại", async () => {
    const user = userEvent.setup();
    fakeApp({
      scan: { algorithm: "ssh-ed25519", fingerprint: HOST_FP, known: "known", adminCommand: "x" },
      setup: () => {
        throw "sai mật khẩu hoặc máy chủ không cho đăng nhập bằng mật khẩu";
      },
    });
    render(<SshScreen />);
    await user.click(await screen.findByRole("button", { name: "Thêm máy chủ" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Địa chỉ máy chủ"), "192.0.2.10");
    await user.type(within(dialog).getByLabelText("Tên đăng nhập"), "deploy");
    await user.type(within(dialog).getByLabelText("Tên gợi nhớ"), "hive-prod");
    await user.click(within(dialog).getByRole("button", { name: "Tiếp" }));
    expect(await within(dialog).findByText(/Máy chủ đã biết/)).toBeTruthy();
    const password = within(dialog).getByLabelText(/Mật khẩu của/) as HTMLInputElement;
    await user.type(password, "sai-roi");
    await user.click(within(dialog).getByRole("button", { name: "Cài khoá" }));
    expect(await within(dialog).findByText(/sai mật khẩu hoặc máy chủ/)).toBeTruthy();
    expect((within(dialog).getByLabelText(/Mật khẩu của/) as HTMLInputElement).value).toBe("");
    // Khoá có thể đã được tạo trước khi lỗi: màn đọc lại danh sách.
    await waitFor(() => expect(fakeApp.last.calls.filter((c) => c.command === "ssh_list")).toHaveLength(2));
  });

  it("khối viết tay: Chuyển sang khoá điền sẵn và khoá ô; máy trung gian hay khoá không được dùng thì nút bị khoá", async () => {
    const user = userEvent.setup();
    fakeApp({
      list: {
        hosts: [
          MACMINI,
          host("jump", { proxy: true }),
          host("other", { keyUsable: false, identityFile: "~/.ssh/khac" }),
        ],
      },
    });
    const { calls } = fakeApp.last;
    render(<SshScreen />);
    await waitFor(() => expect(within(row("other")).getByText("Cần thiết lập")).toBeTruthy());
    // Khối đi qua máy trung gian không tự kiểm khi mở màn: lệnh proxy có thể mở trình duyệt hay gửi MFA.
    expect(calls.filter((c) => c.command === "ssh_check").map((c) => c.args?.alias)).toEqual(["macmini", "other"]);
    await user.click(within(row("jump")).getByRole("button", { name: "Kiểm tra" }));
    const jump = await waitFor(() => within(row("jump")).getByRole("button", { name: "Chuyển sang khoá" }));
    expect((jump as HTMLButtonElement).disabled).toBe(true);
    expect(within(row("jump")).getByText(/máy trung gian/)).toBeTruthy();
    expect((within(row("other")).getByRole("button", { name: "Chuyển sang khoá" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(within(row("other")).getByText(/không dùng khoá của máy/)).toBeTruthy();
    await user.click(within(row("macmini")).getByRole("button", { name: "Chuyển sang khoá" }));
    const dialog = screen.getByRole("dialog");
    const address = within(dialog).getByLabelText("Địa chỉ máy chủ") as HTMLInputElement;
    expect(address.value).toBe("192.0.2.20");
    expect(address.readOnly).toBe(true);
    expect((within(dialog).getByLabelText("Tên gợi nhớ") as HTMLInputElement).value).toBe("macmini");
  });

  it("Xoá chỉ có ở khối của app, có xác nhận, rồi hướng dẫn gỡ khoá trên máy chủ", async () => {
    const user = userEvent.setup();
    const { calls } = fakeApp({ list: { hosts: [MACMINI, HIVE] } });
    render(<SshScreen />);
    await waitFor(() => expect(within(row("hive-prod")).getByRole("button", { name: "Xoá" })).toBeTruthy());
    expect(within(row("macmini")).queryByRole("button", { name: "Xoá" })).toBeNull();
    await user.click(within(row("hive-prod")).getByRole("button", { name: "Xoá" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Xoá hive-prod khỏi ~\/\.ssh\/config/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Xoá" }));
    const howTo = await screen.findByText(/authorized_keys/);
    expect(howTo.textContent).toContain(`"${KEY.comment}"`);
    expect(howTo.textContent).toContain("deploy@192.0.2.10");
    expect(calls.find((c) => c.command === "ssh_remove")?.args).toEqual({ alias: "hive-prod" });
    expect(screen.queryByRole("row", { name: /hive-prod/ })).toBeNull();
  });

  it("Tắt đăng nhập bằng mật khẩu chỉ khi khoá dùng được; lệnh chỉ hiện sau khi đánh dấu Tôi hiểu", async () => {
    const user = userEvent.setup();
    fakeApp({ list: { hosts: [MACMINI, HIVE] }, checks: { "hive-prod": { status: "ok" } } });
    render(<SshScreen />);
    const open = await waitFor(() =>
      within(row("hive-prod")).getByRole("button", { name: "Tắt đăng nhập bằng mật khẩu…" }),
    );
    expect(within(row("macmini")).queryByRole("button", { name: "Tắt đăng nhập bằng mật khẩu…" })).toBeNull();
    await user.click(open);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/giữ phiên đang mở/i)).toBeTruthy();
    expect(within(dialog).queryByText(/PasswordAuthentication no/)).toBeNull();
    const show = within(dialog).getByRole("button", { name: "Xem hướng dẫn" });
    expect((show as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dialog).getByLabelText("Tôi hiểu"));
    await user.click(show);
    expect(within(dialog).getByText(/PasswordAuthentication no/)).toBeTruthy();
  });

  it("Ubuntu chưa có ~/.ssh/config: worker trả hosts null mà màn vẫn hiện, không trắng", async () => {
    fakeApp({
      override: {
        ssh_list: () => ({ ssh: "/usr/bin/ssh", configPath: "/home/ha/.ssh/config", key: KEY, hosts: null }),
      },
    });
    render(<SshScreen />);
    expect(await screen.findByText(/Chưa có máy chủ nào/)).toBeTruthy();
    expect(screen.getByText(KEY.path)).toBeTruthy();
  });

  it("xoá khối cuối cùng: worker trả hosts null, màn về trạng thái rỗng", async () => {
    const user = userEvent.setup();
    fakeApp({
      list: { hosts: [HIVE] },
      override: {
        ssh_remove: () => ({ ssh: "/usr/bin/ssh", configPath: "/home/ha/.ssh/config", key: KEY, hosts: null }),
      },
    });
    render(<SshScreen />);
    await user.click(await within(await waitFor(() => row("hive-prod"))).findByRole("button", { name: "Xoá" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Xoá" }));
    expect(await screen.findByText(/Chưa có máy chủ nào/)).toBeTruthy();
  });

  it("đọc ~/.ssh lỗi: báo lỗi và Thử lại đọc lại được", async () => {
    const user = userEvent.setup();
    let fail = true;
    const { calls } = fakeApp({
      list: { hosts: [MACMINI] },
      override: {
        ssh_list: () => {
          if (fail) throw "không đọc được /home/ha/.ssh/config: permission denied";
          return { ssh: "/usr/bin/ssh", configPath: "/home/ha/.ssh/config", key: KEY, hosts: [MACMINI] };
        },
      },
    });
    render(<SshScreen />);
    expect(await screen.findByText(/permission denied/)).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    await waitFor(() => expect(row("macmini")).toBeTruthy());
    expect(screen.queryByText(/permission denied/)).toBeNull();
    expect(calls.filter((c) => c.command === "ssh_list")).toHaveLength(2);
  });

  it("worker trả trạng thái app chưa biết: hiện như Lỗi, không trắng màn", async () => {
    fakeApp({
      list: { hosts: [MACMINI] },
      checks: { macmini: { status: "moi_them" as never, detail: "chi tiết lạ" } },
    });
    render(<SshScreen />);
    await waitFor(() => expect(within(row("macmini")).getByText("Lỗi")).toBeTruthy());
  });

  it("Mở remote: chạy ssh tới đúng alias trong terminal của máy; lỗi thì báo, không trắng màn", async () => {
    const user = userEvent.setup();
    let fail = false;
    const { calls } = fakeApp({
      list: { hosts: [MACMINI, HIVE] },
      override: {
        ssh_open_terminal: () => {
          if (fail) throw "Không tìm thấy ứng dụng terminal (x-terminal-emulator, gnome-terminal, konsole).";
        },
      },
    });
    render(<SshScreen />);
    const open = await waitFor(() => within(row("macmini")).getByRole("button", { name: "Mở remote" }));
    await user.click(open);
    await waitFor(() =>
      expect(calls.filter((c) => c.command === "ssh_open_terminal").map((c) => c.args)).toEqual([{ alias: "macmini" }]),
    );
    fail = true;
    await user.click(within(row("hive-prod")).getByRole("button", { name: "Mở remote" }));
    expect(await screen.findByText("Không mở được terminal tới hive-prod")).toBeTruthy();
    expect(screen.getByText(/x-terminal-emulator/)).toBeTruthy();
  });

  it("Mở remote bị khoá khi máy chưa có OpenSSH client", async () => {
    fakeApp({ list: { ssh: "", hosts: [MACMINI] } });
    render(<SshScreen />);
    const open = await waitFor(() => within(row("macmini")).getByRole("button", { name: "Mở remote" }));
    expect((open as HTMLButtonElement).disabled).toBe(true);
  });

  it("chữ tiếng Anh khi chọn EN", async () => {
    setLang("en");
    fakeApp({ list: { hosts: [HIVE] }, checks: { "hive-prod": { status: "ok" } } });
    render(<SshScreen />);
    expect(await screen.findByRole("button", { name: "Add server" })).toBeTruthy();
    await waitFor(() => expect(within(row("hive-prod")).getByText("Key works")).toBeTruthy());
    expect(within(row("hive-prod")).getByRole("button", { name: "Open remote" })).toBeTruthy();
  });
});
