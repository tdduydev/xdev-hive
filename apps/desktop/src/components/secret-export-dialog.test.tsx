import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { SecretExportDialog } from "@/components/secret-export-dialog.tsx";
import { setLang } from "@/lib/i18n.ts";

const NAMES = ["DATABASE_URL", "SENTRY_DSN", "STRIPE_TEST_KEY"];
const PASSWORD = "mat-khau-du-dai-1";

function fakeApp(opts: { saveTo?: string | null; fail?: string } = {}) {
  const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "plugin:dialog|save")
          return (opts.saveTo === undefined ? "/tmp/may-cu.hivesecrets" : opts.saveTo) as T;
        if (command === "secrets_export") {
          if (opts.fail) throw new Error(opts.fail);
          return { out: args?.path, names: args?.names } as T;
        }
        throw new Error(`lệnh chưa giả: ${command}`);
      },
    },
  };
  return calls;
}

beforeEach(() => setLang("vi"));

async function fillPasswords(dialog: HTMLElement, password: string, confirm = password) {
  const user = userEvent.setup();
  await user.type(within(dialog).getByLabelText("Mật khẩu"), password);
  await user.type(within(dialog).getByLabelText("Nhập lại mật khẩu"), confirm);
  return user;
}

describe("hộp xuất bí mật", () => {
  it("chọn hết mặc định, nói rõ ba cảnh báo; xuất gửi tên đã chọn và mật khẩu, rồi báo file đã ghi", async () => {
    const calls = fakeApp();
    render(<SecretExportDialog open names={NAMES} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/File chứa giá trị/)).toBeTruthy();
    expect(within(dialog).getByText(/kể cả hub/)).toBeTruthy();
    expect(within(dialog).getByText(/Giữ file ở chỗ riêng tư/)).toBeTruthy();
    for (const n of NAMES) expect((within(dialog).getByLabelText(n) as HTMLInputElement).checked).toBe(true);

    const user = await fillPasswords(dialog, PASSWORD);
    await user.click(within(dialog).getByLabelText("SENTRY_DSN"));
    await user.click(within(dialog).getByRole("button", { name: "Chọn nơi lưu và xuất 2 bí mật" }));

    expect(await within(dialog).findByText("Đã xuất bí mật")).toBeTruthy();
    expect(within(dialog).getByText("/tmp/may-cu.hivesecrets")).toBeTruthy();
    const exported = calls.find((c) => c.command === "secrets_export");
    expect(exported?.args).toEqual({
      path: "/tmp/may-cu.hivesecrets",
      password: PASSWORD,
      names: ["DATABASE_URL", "STRIPE_TEST_KEY"],
      force: true,
    });
    // Mật khẩu không còn trên màn sau khi xuất.
    expect(dialog.querySelector('input[type="password"]')).toBeNull();
  });

  it("mật khẩu ngắn hay hai lần không khớp: báo lỗi, không mở hộp lưu", async () => {
    const calls = fakeApp();
    render(<SecretExportDialog open names={NAMES} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const user = await fillPasswords(dialog, "ngan-qua");
    await user.click(within(dialog).getByRole("button", { name: /Chọn nơi lưu/ }));
    expect(within(dialog).getByText("Mật khẩu cần tối thiểu 12 ký tự.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Mật khẩu"));

    await user.clear(within(dialog).getByLabelText("Mật khẩu"));
    await user.type(within(dialog).getByLabelText("Mật khẩu"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: /Chọn nơi lưu/ }));
    expect(within(dialog).getByText("Hai lần nhập mật khẩu không khớp.")).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("bỏ chọn hết thì không xuất được", async () => {
    fakeApp();
    const user = userEvent.setup();
    render(<SecretExportDialog open names={NAMES} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Bỏ chọn hết" }));
    expect(within(dialog).getByText("Chọn ít nhất một bí mật.")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: /Chọn nơi lưu/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("huỷ hộp lưu: không gọi worker, mật khẩu còn để chọn lại", async () => {
    const calls = fakeApp({ saveTo: null });
    render(<SecretExportDialog open names={NAMES} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const user = await fillPasswords(dialog, PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: /Chọn nơi lưu/ }));
    expect(calls.map((c) => c.command)).toEqual(["plugin:dialog|save"]);
    expect((within(dialog).getByLabelText("Mật khẩu") as HTMLInputElement).value).toBe(PASSWORD);
  });

  it("worker lỗi: hiện lỗi, giữ mật khẩu để thử lại", async () => {
    fakeApp({ fail: "Không ghi được file." });
    render(<SecretExportDialog open names={NAMES} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const user = await fillPasswords(dialog, PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: /Chọn nơi lưu/ }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Không ghi được file.");
    expect((within(dialog).getByLabelText("Nhập lại mật khẩu") as HTMLInputElement).value).toBe(PASSWORD);
  });

  it("đóng rồi mở lại: ô mật khẩu trống", async () => {
    fakeApp();
    const { rerender } = render(<SecretExportDialog open names={NAMES} onClose={() => {}} />);
    await fillPasswords(await screen.findByRole("dialog"), PASSWORD);
    rerender(<SecretExportDialog open={false} names={NAMES} onClose={() => {}} />);
    rerender(<SecretExportDialog open names={NAMES} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Mật khẩu") as HTMLInputElement).value).toBe("");
  });
});
