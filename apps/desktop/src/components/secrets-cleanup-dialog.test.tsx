import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { SecretsCleanupDialog } from "@/components/secrets-cleanup-dialog.tsx";
import { setLang } from "@/lib/i18n.ts";
import type { PurgeResult, SecretItem } from "@/lib/secrets.ts";

const secret = (name: string): SecretItem => ({
  name,
  description: "",
  createdAt: "2026-10-01T08:30:00Z",
  valueChangedAt: "2026-10-01T08:30:00Z",
  projects: [],
  inUseBy: 0,
});

function fakeApp(names: string[], purge: () => PurgeResult = () => ({ removed: names, left: [] })) {
  const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "secrets_list")
          return { secrets: names.map(secret), reserved: { exact: [], prefixes: [] } } as T;
        if (command === "secrets_purge") return purge() as T;
        throw new Error(`lệnh chưa giả: ${command}`);
      },
    },
  };
  return calls;
}

beforeEach(() => setLang("vi"));

describe("hộp dọn bí mật khi xoá dữ liệu app", () => {
  it("liệt kê tên, Giữ lại được focus trước; xoá gửi purge --all rồi báo số đã xoá", async () => {
    const calls = fakeApp(["DATABASE_URL", "STRIPE_TEST_KEY"]);
    const user = userEvent.setup();
    render(<SecretsCleanupDialog open onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("DATABASE_URL")).toBeTruthy();
    expect(within(dialog).getByText("Sẽ xoá 2 bí mật, không khôi phục được:")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Giữ lại" })));
    expect(calls.some((c) => c.command === "secrets_purge")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Xoá mọi bí mật" }));
    expect(await within(dialog).findByText("Đã xoá 2 bí mật.")).toBeTruthy();
    expect(calls.find((c) => c.command === "secrets_purge")?.args).toEqual({ all: true });
  });

  it("không chọn xoá: nói rõ mục nào còn lại và không gọi purge", async () => {
    const calls = fakeApp(["DATABASE_URL", "STRIPE_TEST_KEY"]);
    const user = userEvent.setup();
    render(<SecretsCleanupDialog open onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("DATABASE_URL");
    await user.click(within(dialog).getByRole("button", { name: "Giữ lại" }));
    expect(await within(dialog).findByText("Các bí mật vẫn còn trong kho")).toBeTruthy();
    const list = within(dialog).getByRole("list", { name: "Tên bí mật" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["DATABASE_URL", "STRIPE_TEST_KEY"]);
    expect(calls.some((c) => c.command === "secrets_purge")).toBe(false);
  });

  it("có mục xoá không được: liệt kê các mục còn lại", async () => {
    fakeApp(["A_KEY", "B_KEY"], () => ({ removed: ["A_KEY"], left: ["B_KEY"] }));
    const user = userEvent.setup();
    render(<SecretsCleanupDialog open onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("B_KEY");
    await user.click(within(dialog).getByRole("button", { name: "Xoá mọi bí mật" }));
    expect(await within(dialog).findByText("Còn mục chưa xoá được")).toBeTruthy();
    expect(within(dialog).getByText("Đã xoá 1 bí mật.")).toBeTruthy();
    expect(within(within(dialog).getByRole("list", { name: "Tên bí mật" })).getByText("B_KEY")).toBeTruthy();
  });

  it("kho không có bí mật nào: chỉ báo và cho đóng", async () => {
    fakeApp([]);
    render(<SecretsCleanupDialog open onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Máy này chưa lưu bí mật nào.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Xoá mọi bí mật" })).toBeNull();
  });

  it("purge lỗi: hiện lỗi của worker và còn nút để thử lại", async () => {
    fakeApp(["A_KEY"], () => {
      throw new Error("Kho bí mật đang khoá.");
    });
    const user = userEvent.setup();
    render(<SecretsCleanupDialog open onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("A_KEY");
    await user.click(within(dialog).getByRole("button", { name: "Xoá mọi bí mật" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Kho bí mật đang khoá.");
    expect((within(dialog).getByRole("button", { name: "Xoá mọi bí mật" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
