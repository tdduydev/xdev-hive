import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectForm } from "@/components/connect-form.tsx";
import { setLang } from "@/lib/i18n.ts";
import { RegisterScreen } from "@/screens/register-screen.tsx";

type Handler = (args?: Record<string, unknown>) => unknown;

/** window.__TAURI__ giả: mỗi lệnh một hàm, ghi lại lệnh đã gọi. */
function fakeTauri(handlers: Record<string, Handler>) {
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
  };
  return calls;
}

const notification = {
  "plugin:notification|is_permission_granted": () => true,
  // Hub giả luôn khoẻ: trả địa chỉ đã bỏ khoảng trắng như Rust.
  hub_check: (args?: Record<string, unknown>) => String(args?.hub).trim(),
};

describe("RegisterScreen", () => {
  beforeEach(() => setLang("vi"));

  it("mới mở: form trống, chưa có thông báo", () => {
    fakeTauri(notification);
    render(<RegisterScreen />);
    expect(screen.getByRole("heading", { name: "Kết nối máy của bạn" })).toBeTruthy();
    expect((screen.getByLabelText("Địa chỉ Hive") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("dán lệnh: điền hub và token, xoá lệnh đã dán", async () => {
    const calls = fakeTauri({
      ...notification,
      parse_registration: () => ({ hub: "https://hive.acme.vn", token: "hwr_abc" }),
    });
    render(<RegisterScreen />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Hoặc dán lệnh đăng ký"));
    await user.type(screen.getByLabelText("Lệnh do admin đội cung cấp"), "hive-worker register --hub x --token y");
    await user.click(screen.getByRole("button", { name: "Điền từ lệnh" }));
    expect(await screen.findByText("Đã điền địa chỉ hub và token.")).toBeTruthy();
    expect((screen.getByLabelText("Địa chỉ Hive") as HTMLInputElement).value).toBe("https://hive.acme.vn");
    expect((screen.getByLabelText("Token đăng ký") as HTMLInputElement).value).toBe("hwr_abc");
    expect((screen.getByLabelText("Lệnh do admin đội cung cấp") as HTMLTextAreaElement).value).toBe("");
    expect(calls.find((c) => c.command === "parse_registration")?.args).toEqual({
      input: "hive-worker register --hub x --token y",
    });
  });

  it("đang đăng ký: nút bị tắt; xong thì báo đã đăng ký", async () => {
    let finish: (id: string) => void = () => {};
    const calls = fakeTauri({
      ...notification,
      register_worker: () => new Promise<string>((resolve) => (finish = resolve)),
    });
    render(<RegisterScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Địa chỉ Hive"), " https://hive.acme.vn ");
    await user.type(screen.getByLabelText("Token đăng ký"), "hwr_abc");
    await user.click(screen.getByRole("button", { name: "Đăng ký và bật worker" }));
    expect(await screen.findByText("Đang đăng ký máy…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Đăng ký và bật worker" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.find((c) => c.command === "register_worker")?.args).toEqual({
      hub: "https://hive.acme.vn",
      token: "hwr_abc",
    });
    finish("m-1");
    expect(await screen.findByText("Đã đăng ký. Worker đang kết nối với hub.")).toBeTruthy();
    expect(screen.queryByLabelText("Token đăng ký")).toBeNull();
  });

  it("đăng nhập bằng trình duyệt: cần địa chỉ hub, chờ trình duyệt rồi báo đã đăng ký", async () => {
    let finish: (id: string) => void = () => {};
    const calls = fakeTauri({
      ...notification,
      browser_login: () => new Promise<string>((resolve) => (finish = resolve)),
    });
    render(<RegisterScreen />);
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Đăng nhập bằng trình duyệt" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.type(screen.getByLabelText("Địa chỉ Hive"), " http://192.0.2.10:3000 ");
    await user.click(button);
    expect(await screen.findByText("Đang chờ bạn đăng nhập trên trình duyệt…")).toBeTruthy();
    expect(calls.find((c) => c.command === "browser_login")?.args).toEqual({ hub: "http://192.0.2.10:3000" });
    finish("mac-duy");
    expect(await screen.findByText("Đã đăng ký. Worker đang kết nối với hub.")).toBeTruthy();
  });

  it("đăng nhập bằng trình duyệt bị từ chối: hiện lỗi và cho thử lại", async () => {
    fakeTauri({
      ...notification,
      browser_login: () => Promise.reject("Bạn đã từ chối kết nối trên trình duyệt."),
    });
    render(<RegisterScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Địa chỉ Hive"), "https://hive.acme.vn");
    await user.click(screen.getByRole("button", { name: "Đăng nhập bằng trình duyệt" }));
    expect(await screen.findByText("Bạn đã từ chối kết nối trên trình duyệt.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Đăng nhập bằng trình duyệt" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("lỗi: hiện lỗi của Rust và cho gửi lại", async () => {
    fakeTauri({
      ...notification,
      register_worker: () => Promise.reject("Token đã hết hạn hoặc đã dùng."),
    });
    render(<RegisterScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Địa chỉ Hive"), "https://hive.acme.vn");
    await user.type(screen.getByLabelText("Token đăng ký"), "hwr_old");
    await user.click(screen.getByRole("button", { name: "Đăng ký và bật worker" }));
    expect(await screen.findByText("Token đã hết hạn hoặc đã dùng.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Đăng ký và bật worker" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("địa chỉ hub có chứng chỉ chưa tin: báo cách cài chứng chỉ, không mở trình duyệt", async () => {
    const calls = fakeTauri({
      ...notification,
      hub_check: () =>
        Promise.reject(
          "Máy này chưa tin chứng chỉ HTTPS của 192.0.2.10. Hub dùng chứng chỉ nội bộ (vd. Caddy local CA) thì xin quản trị hub file chứng chỉ gốc (root.crt) rồi cài vào máy.",
        ),
    });
    render(<RegisterScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Địa chỉ Hive"), "https://192.0.2.10");
    await user.click(screen.getByRole("button", { name: "Đăng nhập bằng trình duyệt" }));
    expect(await screen.findByText(/chưa tin chứng chỉ HTTPS của 10\.86\.224\.34/)).toBeTruthy();
    expect(calls.some((c) => c.command === "browser_login")).toBe(false);
  });

  it("xin quyền thông báo khi chưa có", async () => {
    const request = vi.fn(() => true);
    fakeTauri({
      "plugin:notification|is_permission_granted": () => false,
      "plugin:notification|request_permission": request,
    });
    render(<RegisterScreen />);
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
  });

  it("tiếng Anh", async () => {
    fakeTauri(notification);
    render(<RegisterScreen />);
    await userEvent.setup().selectOptions(screen.getByLabelText("Ngôn ngữ"), "en");
    expect(screen.getByRole("heading", { name: "Connect your machine" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Register and start worker" })).toBeTruthy();
    expect(screen.getByLabelText("Hive address")).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
  });

  it("ngoài Tauri thì báo lỗi rõ ràng thay vì treo", async () => {
    render(<RegisterScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Địa chỉ Hive"), "https://hive.acme.vn");
    await user.type(screen.getByLabelText("Token đăng ký"), "hwr_abc");
    await user.click(screen.getByRole("button", { name: "Đăng ký và bật worker" }));
    expect(await screen.findByText("Chỉ chạy được trong app xDev Hive.")).toBeTruthy();
  });
});

describe("CA riêng của hub", () => {
  beforeEach(() => setLang("vi"));
  const ca = {
    hub: "https://hub.test",
    name: "CN=Caddy Local Authority - Test Root",
    fingerprint: "CD:97:76:49",
    previousFingerprint: "AA:BB:CC:DD",
  };

  it("chỉ tin sau khi đối chiếu; hiển thị cả vân tay cũ và mới, chưa đăng nhập", async () => {
    const calls = fakeTauri({
      ...notification,
      hub_check: () => {
        throw "HIVE_CA_UNTRUSTED: Chưa tin chứng chỉ. Có thể cài CA trên macOS, Windows, iOS, Android.";
      },
      hub_ca_inspect: () => ca,
      hub_ca_trust: () => undefined,
    });
    render(<RegisterScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Địa chỉ Hive"), ca.hub);
    await user.click(screen.getByRole("button", { name: "Đăng nhập bằng trình duyệt" }));
    expect(await screen.findByText(ca.name)).toBeTruthy();
    expect(screen.getByText(`SHA-256: ${ca.fingerprint}`)).toBeTruthy();
    expect(screen.getByText(`SHA-256 đã tin trước đây: ${ca.previousFingerprint}`)).toBeTruthy();
    expect(calls.some((c) => c.command === "hub_ca_trust" || c.command === "browser_login")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Đã đối chiếu, tin cậy CA này" }));
    expect(await screen.findByText("Đã tin CA. Bấm đăng nhập hoặc đổi địa chỉ để tiếp tục.")).toBeTruthy();
    expect(calls.find((c) => c.command === "hub_ca_trust")?.args).toEqual({ hub: ca.hub, fingerprint: ca.fingerprint });
    expect(calls.some((c) => c.command === "browser_login")).toBe(false);
  });

  it("huỷ xác nhận và quên CA không gửi token hay đăng nhập", async () => {
    const calls = fakeTauri({
      ...notification,
      hub_check: () => {
        throw "HIVE_CA_UNTRUSTED: Chưa tin chứng chỉ.";
      },
      hub_ca_inspect: () => ca,
      hub_ca_forget: () => undefined,
    });
    render(<RegisterScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Địa chỉ Hive"), ca.hub);
    await user.click(screen.getByRole("button", { name: "Đăng nhập bằng trình duyệt" }));
    await screen.findByText(ca.name);
    await user.click(screen.getByRole("button", { name: "Huỷ" }));
    expect(screen.queryByText(ca.name)).toBeNull();
    expect(calls.some((c) => c.command === "hub_ca_trust")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Quên chứng chỉ đã tin" }));
    expect(calls.some((c) => c.command === "hub_ca_forget")).toBe(true);
    expect(calls.some((c) => ["browser_login", "register_worker", "account_link"].includes(c.command))).toBe(false);
  });

  it("không dò CA khi chứng chỉ sai tên hoặc mạng lỗi", async () => {
    const calls = fakeTauri({
      ...notification,
      hub_check: () => {
        throw "Chứng chỉ HTTPS không dành cho địa chỉ này.";
      },
    });
    render(<RegisterScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Địa chỉ Hive"), ca.hub);
    await user.click(screen.getByRole("button", { name: "Đăng nhập bằng trình duyệt" }));
    expect(await screen.findByText("Chứng chỉ HTTPS không dành cho địa chỉ này.")).toBeTruthy();
    expect(calls.some((c) => c.command === "hub_ca_inspect")).toBe(false);
  });
});

it("đã đăng nhập vẫn kiểm được CA ở địa chỉ hub đang dùng", async () => {
  setLang("vi");
  fakeTauri({
    hub_check: () => {
      throw "HIVE_CA_UNTRUSTED: Chưa tin chứng chỉ.";
    },
    hub_ca_inspect: () => ({
      hub: "https://hub.test",
      name: "CN=CA mới",
      fingerprint: "AA:BB",
      previousFingerprint: "CC:DD",
    }),
  });
  render(<ConnectForm current="https://hub.test" linked />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Kiểm chứng chỉ hub" }));
  expect(await screen.findByText("CN=CA mới")).toBeTruthy();
});
