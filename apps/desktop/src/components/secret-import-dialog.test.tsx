import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { SecretImportDialog } from "@/components/secret-import-dialog.tsx";
import { setLang } from "@/lib/i18n.ts";
import type { LocalProject } from "@/lib/local-projects.ts";
import type { ImportResult } from "@/lib/secrets.ts";

// Cùng fixture với test của worker, để bảng xem trước khớp đúng JSON worker trả.
const fixture = (name: string): ImportResult =>
  JSON.parse(
    readFileSync(resolve(process.cwd(), "../../worker/internal/secretstore/testdata/cli", name), "utf8"),
  ) as ImportResult;

const PASSWORD = "mat-khau-cua-file";

const project = (localId: string, name: string): LocalProject => ({
  localId,
  projectId: "",
  name,
  folder: `/home/dev/${name}`,
  fullPermission: false,
  exists: true,
  isGit: true,
});

interface Call {
  command: string;
  args?: Record<string, unknown> | undefined;
}

function fakeApp(opts: { picked?: string; fail?: string; failOverwrite?: string; skipPreview?: ImportResult } = {}) {
  const calls: Call[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "plugin:dialog|open") return (opts.picked ?? "/home/dev/backup.hivesecrets") as T;
        if (opts.fail) throw new Error(opts.fail);
        if (opts.failOverwrite && args?.onConflict === "overwrite") throw new Error(opts.failOverwrite);
        if (command === "secrets_import_preview")
          return (
            args?.onConflict === "skip" && opts.skipPreview ? opts.skipPreview : fixture("import-preview.json")
          ) as T;
        if (command === "secrets_import") return fixture("import.json") as T;
        if (command === "secrets_import_env") return { ...fixture("import-env.json"), dryRun: args?.dryRun } as T;
        throw new Error(`lệnh chưa giả: ${command}`);
      },
    },
  };
  return calls;
}

beforeEach(() => setLang("vi"));

const rows = (dialog: HTMLElement) =>
  within(within(dialog).getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((r) =>
      within(r)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    );

describe("hộp nhập bí mật", () => {
  it("file .hivesecrets: chọn file, nhập mật khẩu, xem trước theo trạng thái rồi nhập", async () => {
    const preview = fixture("import-preview.json");
    // Bỏ qua tên trùng: chỉ bí mật mới được ghi.
    const skipPreview: ImportResult = {
      ...preview,
      items: preview.items.map((i) => (i.status === "new" ? i : { ...i, action: "skip" })),
    };
    const calls = fakeApp({ skipPreview });
    let imported = 0;
    const user = userEvent.setup();
    render(<SecretImportDialog open projects={[]} onClose={() => {}} onImported={() => imported++} />);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Chọn file/ }));
    expect(within(dialog).getByText("~/backup.hivesecrets")).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Mật khẩu của file"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Xem trước" }));

    expect(await within(dialog).findByText("Xem trước khi nhập")).toBeTruthy();
    expect(rows(dialog)).toEqual([
      ["DATABASE_URL", "Trùng tên", "Bỏ qua", "Không khớp dự án trên máy: api"],
      ["SENTRY_DSN", "Trùng cả giá trị", "Bỏ qua", "Mọi dự án"],
      ["STRIPE_TEST_KEY", "Mới", "Thêm", "Không gán thêm"],
    ]);
    expect(within(dialog).getByText("Sẽ ghi 1 bí mật, bỏ qua 2.")).toBeTruthy();
    expect(calls.find((c) => c.command === "secrets_import_preview")?.args).toEqual({
      path: "/home/dev/backup.hivesecrets",
      password: PASSWORD,
      onConflict: "skip",
    });

    // Đổi sang ghi đè thì xem trước lại để bảng đúng với lần nhập thật.
    await user.click(within(dialog).getByLabelText(/Ghi đè giá trị và mô tả/));
    expect(await within(dialog).findByRole("button", { name: "Nhập 3 bí mật" })).toBeTruthy();
    expect(rows(dialog).map((r) => r[2])).toEqual(["Ghi đè", "Ghi đè", "Thêm"]);

    await user.click(within(dialog).getByRole("button", { name: "Nhập 3 bí mật" }));
    expect(await within(dialog).findByText("Đã nhập bí mật")).toBeTruthy();
    expect(rows(dialog).map((r) => r[2])).toEqual(["Đã ghi đè", "Đã ghi đè", "Đã thêm"]);
    expect(within(dialog).getByText(/Dự án không khớp chưa được gán/)).toBeTruthy();
    expect(calls.find((c) => c.command === "secrets_import")?.args).toEqual({
      path: "/home/dev/backup.hivesecrets",
      password: PASSWORD,
      onConflict: "overwrite",
    });
    expect(imported).toBe(1);
    // Kết quả không mang giá trị, và mật khẩu không còn trên màn.
    expect(dialog.textContent).not.toContain(PASSWORD);
    expect(dialog.querySelector('input[type="password"]')).toBeNull();
  });

  it("thiếu file hay mật khẩu: báo ngay, không gọi worker", async () => {
    const calls = fakeApp();
    const user = userEvent.setup();
    render(<SecretImportDialog open projects={[]} onClose={() => {}} onImported={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Xem trước" }));
    expect(within(dialog).getByText("Chọn file để nhập.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: /Chọn file/ }));
    await user.click(within(dialog).getByRole("button", { name: /Chọn file/ }));
    await user.click(within(dialog).getByRole("button", { name: "Xem trước" }));
    expect(within(dialog).getByText("Nhập mật khẩu của file.")).toBeTruthy();
    expect(calls.map((c) => c.command)).toEqual(["plugin:dialog|open"]);
  });

  it("sai mật khẩu hay file bị sửa: hiện lỗi của worker, ở lại bước chọn file", async () => {
    fakeApp({ fail: "Sai mật khẩu hoặc file đã bị sửa." });
    const user = userEvent.setup();
    render(<SecretImportDialog open projects={[]} onClose={() => {}} onImported={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Chọn file/ }));
    await user.type(within(dialog).getByLabelText("Mật khẩu của file"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Xem trước" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Sai mật khẩu hoặc file đã bị sửa.");
    expect(within(dialog).getByRole("button", { name: "Xem trước" })).toBeTruthy();
  });

  it("đổi cách xử lý tên trùng mà xem trước lại lỗi: trả lại lựa chọn cũ, nhập theo đúng bảng đang hiện", async () => {
    const preview = fixture("import-preview.json");
    const skipPreview: ImportResult = {
      ...preview,
      items: preview.items.map((i) => (i.status === "new" ? i : { ...i, action: "skip" })),
    };
    const calls = fakeApp({ skipPreview, failOverwrite: "File vừa bị đổi, chọn lại file." });
    const user = userEvent.setup();
    render(<SecretImportDialog open projects={[]} onClose={() => {}} onImported={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Chọn file/ }));
    await user.type(within(dialog).getByLabelText("Mật khẩu của file"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Xem trước" }));
    await user.click(await within(dialog).findByLabelText(/Ghi đè giá trị và mô tả/));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("File vừa bị đổi");
    expect((within(dialog).getByLabelText(/Bỏ qua, giữ bí mật đang có/) as HTMLInputElement).checked).toBe(true);
    expect(rows(dialog).map((r) => r[2])).toEqual(["Bỏ qua", "Bỏ qua", "Thêm"]);
    await user.click(within(dialog).getByRole("button", { name: "Nhập 1 bí mật" }));
    expect(await within(dialog).findByText("Đã nhập bí mật")).toBeTruthy();
    expect(calls.find((c) => c.command === "secrets_import")?.args?.onConflict).toBe("skip");
  });

  it("file .env: không hỏi mật khẩu, gán cho dự án đã chọn, dòng sai được liệt kê", async () => {
    const calls = fakeApp({ picked: "/home/dev/app/.env" });
    const user = userEvent.setup();
    render(
      <SecretImportDialog
        open
        projects={[project("1111111111111111", "app"), project("2222222222222222", "api")]}
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByLabelText("File .env"));
    expect(within(dialog).queryByLabelText("Mật khẩu của file")).toBeNull();
    await user.selectOptions(within(dialog).getByLabelText("Gán cho"), "1111111111111111");
    await user.click(within(dialog).getByRole("button", { name: /Chọn file/ }));
    await user.click(within(dialog).getByRole("button", { name: "Xem trước" }));

    expect(await within(dialog).findByText("Xem trước khi nhập")).toBeTruthy();
    const got = rows(dialog);
    expect(got[0]).toEqual(["NEW_TOKENdòng 1", "Mới", "Thêm", "app"]);
    expect(got[2]?.[0]).toBe("dòng 3");
    expect(got[2]?.[3]).toMatch(/Tên biến chỉ gồm chữ in hoa/);
    expect(calls.find((c) => c.command === "plugin:dialog|open")?.args).toEqual({
      options: { title: "Chọn file bí mật", multiple: false, directory: false },
    });
    expect(calls.find((c) => c.command === "secrets_import_env")?.args).toEqual({
      path: "/home/dev/app/.env",
      dryRun: true,
      onConflict: "skip",
      project: "1111111111111111",
    });

    await user.click(within(dialog).getByRole("button", { name: "Nhập 1 bí mật" }));
    expect(await within(dialog).findByText("Đã nhập bí mật")).toBeTruthy();
    expect(calls.filter((c) => c.command === "secrets_import_env").map((c) => c.args?.dryRun)).toEqual([true, false]);
  });

  it("quay lại từ xem trước giữ file và mật khẩu; đóng rồi mở lại thì trống", async () => {
    fakeApp();
    const user = userEvent.setup();
    const props = { projects: [], onClose: () => {}, onImported: () => {} };
    const { rerender } = render(<SecretImportDialog open {...props} />);
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Chọn file/ }));
    await user.type(within(dialog).getByLabelText("Mật khẩu của file"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Xem trước" }));
    await user.click(await within(dialog).findByRole("button", { name: "Quay lại" }));
    expect((within(dialog).getByLabelText("Mật khẩu của file") as HTMLInputElement).value).toBe(PASSWORD);

    rerender(<SecretImportDialog open={false} {...props} />);
    rerender(<SecretImportDialog open {...props} />);
    dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Mật khẩu của file") as HTMLInputElement).value).toBe("");
    expect(within(dialog).getByText("Chưa chọn file")).toBeTruthy();
  });
});
