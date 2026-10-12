import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
};

describe("RegisterScreen", () => {
  beforeEach(() => setLang("vi"));

  it("mới mở: form trống, chưa có thông báo", () => {
    fakeTauri(notification);
    render(<RegisterScreen />);
    expect(screen.getByRole("heading", { name: "Kết nối máy của bạn" })).toBeTruthy();
    expect((screen.getByLabelText("Địa chỉ hub công khai") as HTMLInputElement).value).toBe("");
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
    expect((screen.getByLabelText("Địa chỉ hub công khai") as HTMLInputElement).value).toBe("https://hive.acme.vn");
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
    await user.type(screen.getByLabelText("Địa chỉ hub công khai"), " https://hive.acme.vn ");
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

  it("lỗi: hiện lỗi của Rust và cho gửi lại", async () => {
    fakeTauri({
      ...notification,
      register_worker: () => Promise.reject("Token đã hết hạn hoặc đã dùng."),
    });
    render(<RegisterScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Địa chỉ hub công khai"), "https://hive.acme.vn");
    await user.type(screen.getByLabelText("Token đăng ký"), "hwr_old");
    await user.click(screen.getByRole("button", { name: "Đăng ký và bật worker" }));
    expect(await screen.findByText("Token đã hết hạn hoặc đã dùng.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Đăng ký và bật worker" }) as HTMLButtonElement).disabled).toBe(false);
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
    await userEvent.setup().click(screen.getByRole("button", { name: "EN" }));
    expect(screen.getByRole("heading", { name: "Connect your machine" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Register and start worker" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
  });

  it("ngoài Tauri thì báo lỗi rõ ràng thay vì treo", async () => {
    render(<RegisterScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Địa chỉ hub công khai"), "https://hive.acme.vn");
    await user.type(screen.getByLabelText("Token đăng ký"), "hwr_abc");
    await user.click(screen.getByRole("button", { name: "Đăng ký và bật worker" }));
    expect(await screen.findByText("Chỉ chạy được trong app xDev Hive.")).toBeTruthy();
  });
});
