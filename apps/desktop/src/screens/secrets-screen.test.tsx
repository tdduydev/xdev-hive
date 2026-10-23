import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import type { LocalProjects } from "@/lib/local-projects.ts";
import type { GrantEntry, SecretItem, SecretsList, StoreStatus } from "@/lib/secrets.ts";
import { SecretsScreen } from "@/screens/secrets-screen.tsx";

const APP = { localId: "1111111111111111", name: "app", folder: "/home/dev/app" };
const API = { localId: "2222222222222222", name: "api", folder: "/home/dev/api" };

const secret = (name: string, over: Partial<SecretItem> = {}): SecretItem => ({
  name,
  description: "",
  createdAt: "2026-10-01T08:30:00Z",
  valueChangedAt: "2026-10-01T08:30:00Z",
  projects: [],
  inUseBy: 0,
  ...over,
});

const DATABASE = secret("DATABASE_URL", { description: "Postgres của môi trường thử", projects: [APP, API] });
const STRIPE = secret("STRIPE_TEST_KEY");

const RESERVED = { exact: ["PATH", "HOME"], prefixes: ["HIVE_", "GIT_"] };

const PROJECTS: LocalProjects = {
  path: "/home/dev/.xdev-hive/projects.json",
  exists: true,
  imported: 0,
  projects: [APP, API].map((p) => ({
    ...p,
    projectId: "",
    fullPermission: false,
    exists: true,
    isGit: true,
  })),
};

interface Call {
  command: string;
  args?: Record<string, unknown> | undefined;
}

export function fakeApp(opts: {
  secrets?: SecretItem[];
  status?: StoreStatus;
  log?: GrantEntry[];
  projects?: LocalProjects;
  override?: Record<string, (args?: Record<string, unknown>) => unknown>;
}) {
  const calls: Call[] = [];
  let secrets = opts.secrets ?? [];
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    secrets_status: () => opts.status ?? { available: true, locked: false, backend: "keychain", reason: "" },
    secrets_list: (): SecretsList => ({ secrets, reserved: RESERVED }),
    local_projects: () => opts.projects ?? PROJECTS,
    secret_save: (a) => {
      const item = secret(String(a?.name), { description: String(a?.description ?? "") });
      secrets = [...secrets.filter((s) => s.name !== item.name), item];
      return item;
    },
    secret_rename: (a) => {
      secrets = secrets.map((s) => (s.name === a?.name ? { ...s, name: String(a?.to) } : s));
      return secrets.find((s) => s.name === a?.to);
    },
    secret_delete: (a) => {
      secrets = secrets.filter((s) => s.name !== a?.name);
      return { deleted: a?.name, inUse: false };
    },
    secrets_log: () => ({ entries: opts.log ?? [] }),
    secrets_log_clear: () => ({ cleared: opts.log?.length ?? 0 }),
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
  return { calls };
}

const row = (name: string) => screen.getByRole("row", { name: new RegExp(name) });

beforeEach(() => setLang("vi"));

describe("màn Bí mật: danh sách", () => {
  it("hiện tên, mô tả, dự án được gán và ngày đổi giá trị; không có giá trị nào", async () => {
    fakeApp({ secrets: [DATABASE, STRIPE] });
    render(<SecretsScreen />);
    expect(await screen.findByText("DATABASE_URL")).toBeTruthy();
    const db = row("DATABASE_URL");
    expect(within(db).getByText("Postgres của môi trường thử")).toBeTruthy();
    expect(within(db).getByText("app")).toBeTruthy();
    expect(within(db).getByText("api")).toBeTruthy();
    expect(within(db).getByText(/2026/)).toBeTruthy();
    expect(within(row("STRIPE_TEST_KEY")).getByText("Chưa gán")).toBeTruthy();
  });

  it("chưa có bí mật: báo cách thêm", async () => {
    fakeApp({ secrets: [] });
    render(<SecretsScreen />);
    expect(await screen.findByText(/Chưa có bí mật nào/)).toBeTruthy();
  });

  it("lỗi đọc danh sách: hiện lỗi của worker và nút thử lại", async () => {
    let fail = true;
    fakeApp({
      override: {
        secrets_list: () => {
          if (fail) throw "Kho bí mật của máy đang khoá.";
          return { secrets: [STRIPE], reserved: RESERVED };
        },
      },
    });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    expect(await screen.findByText("Kho bí mật của máy đang khoá.")).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(await screen.findByText("STRIPE_TEST_KEY")).toBeTruthy();
  });

  it("lọc theo dự án qua địa chỉ #/secrets/<localId>", async () => {
    fakeApp({ secrets: [DATABASE, STRIPE] });
    location.hash = `#/secrets/${APP.localId}`;
    render(<SecretsScreen />);
    expect(await screen.findByText("DATABASE_URL")).toBeTruthy();
    expect(screen.queryByText("STRIPE_TEST_KEY")).toBeNull();
    const select = screen.getByLabelText("Lọc theo dự án") as HTMLSelectElement;
    expect(select.value).toBe(APP.localId);
  });

  it("danh sách tên dành riêng xem được", async () => {
    fakeApp({ secrets: [STRIPE] });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    await screen.findByText("STRIPE_TEST_KEY");
    await user.click(screen.getByRole("button", { name: "Tên dành riêng" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("PATH")).toBeTruthy();
    expect(within(dialog).getByText("HIVE_…")).toBeTruthy();
  });
});

describe("màn Bí mật: thêm và sửa", () => {
  it("ô giá trị là password, tắt tự điền; lưu gửi tên chuẩn hoá, dự án đã chọn; form đóng và giá trị không còn", async () => {
    const { calls } = fakeApp({ secrets: [] });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    await screen.findByText(/Chưa có bí mật nào/);
    await user.click(screen.getByRole("button", { name: "Thêm bí mật" }));
    const dialog = await screen.findByRole("dialog");
    const value = within(dialog).getByLabelText("Giá trị") as HTMLInputElement;
    expect(value.type).toBe("password");
    expect(value.autocomplete).toBe("off");

    await user.type(within(dialog).getByLabelText("Tên biến"), "stripe_key");
    await user.type(within(dialog).getByLabelText("Mô tả"), "Khoá thử của Stripe");
    await user.type(value, "gia-tri-gia-12345678");
    await user.click(within(dialog).getByRole("checkbox", { name: /api/ }));
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const save = calls.find((c) => c.command === "secret_save");
    expect(save?.args).toEqual({
      name: "STRIPE_KEY",
      description: "Khoá thử của Stripe",
      value: "gia-tri-gia-12345678",
      projects: [API.localId],
    });
    // Giá trị không còn ở đâu trong cây DOM.
    expect(document.body.innerHTML).not.toContain("gia-tri-gia-12345678");
    expect(await screen.findByText("STRIPE_KEY")).toBeTruthy();
  });

  it("tên sai hay dành riêng, trùng tên, thiếu giá trị: báo ngay cạnh ô và không gọi worker", async () => {
    const { calls } = fakeApp({ secrets: [STRIPE] });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    await screen.findByText("STRIPE_TEST_KEY");
    await user.click(screen.getByRole("button", { name: "Thêm bí mật" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText("Tên biến");

    await user.type(name, "1abc");
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));
    expect(within(dialog).getByText(/không bắt đầu bằng số/, { selector: "span" })).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");

    await user.clear(name);
    await user.type(name, "path");
    expect(within(dialog).getByText(/dành riêng cho hệ thống/)).toBeTruthy();

    await user.clear(name);
    await user.type(name, "stripe_test_key");
    expect(within(dialog).getByText("Đã có bí mật tên STRIPE_TEST_KEY.")).toBeTruthy();

    await user.clear(name);
    await user.type(name, "NEW_ONE");
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));
    expect(within(dialog).getByText("Nhập giá trị.")).toBeTruthy();
    expect(calls.some((c) => c.command === "secret_save")).toBe(false);
  });

  it("worker từ chối: hiện lỗi, form giữ lại và ô giá trị đã được xoá", async () => {
    fakeApp({
      secrets: [],
      override: {
        secret_save: () => {
          throw "Mô tả trông giống một giá trị bí mật; hãy bỏ giá trị ra khỏi mô tả.";
        },
      },
    });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    await screen.findByText(/Chưa có bí mật nào/);
    await user.click(screen.getByRole("button", { name: "Thêm bí mật" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Tên biến"), "TOKEN");
    const value = within(dialog).getByLabelText("Giá trị") as HTMLInputElement;
    await user.type(value, "gia-tri-gia-12345678");
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));
    expect(await within(dialog).findByText(/trông giống một giá trị bí mật/)).toBeTruthy();
    expect(value.value).toBe("");
  });

  it("sửa: để trống giá trị thì không gửi giá trị; đổi tên thì đổi tên trước", async () => {
    const { calls } = fakeApp({ secrets: [DATABASE] });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    await screen.findByText("DATABASE_URL");
    await user.click(screen.getByRole("button", { name: "Sửa DATABASE_URL" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText("Tên biến") as HTMLInputElement;
    expect(name.value).toBe("DATABASE_URL");
    // Đã gán cho cả hai dự án.
    expect((within(dialog).getByRole("checkbox", { name: /app/ }) as HTMLInputElement).checked).toBe(true);
    await user.clear(name);
    await user.type(name, "DB_URL");
    await user.click(within(dialog).getByRole("checkbox", { name: /api/ }));
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.command === "secret_rename" || c.command === "secret_save")).toEqual([
      { command: "secret_rename", args: { name: "DATABASE_URL", to: "DB_URL" } },
      {
        command: "secret_save",
        args: {
          name: "DB_URL",
          description: "Postgres của môi trường thử",
          value: undefined,
          projects: [APP.localId],
        },
      },
    ]);
  });
});

describe("màn Bí mật: xoá", () => {
  it("xoá có xác nhận; nút Huỷ được focus trước; bí mật đang được run dùng thì cảnh báo", async () => {
    const { calls } = fakeApp({ secrets: [secret("OLD_KEY", { inUseBy: 2, projects: [APP] }), STRIPE] });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    await screen.findByText("OLD_KEY");
    await user.click(screen.getByRole("button", { name: "Xoá OLD_KEY" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Xoá OLD_KEY?")).toBeTruthy();
    expect(within(dialog).getByText("Đang có 2 run dùng bí mật này.")).toBeTruthy();
    expect(calls.some((c) => c.command === "secret_delete")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Huỷ" })));

    await user.click(within(dialog).getByRole("button", { name: "Xoá bí mật" }));
    await waitFor(() => expect(screen.queryByText("OLD_KEY")).toBeNull());
    expect(calls.find((c) => c.command === "secret_delete")?.args).toEqual({ name: "OLD_KEY" });
    expect(screen.getByText("STRIPE_TEST_KEY")).toBeTruthy();
  });

  it("Huỷ thì không xoá", async () => {
    const { calls } = fakeApp({ secrets: [STRIPE] });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    await screen.findByText("STRIPE_TEST_KEY");
    await user.click(screen.getByRole("button", { name: "Xoá STRIPE_TEST_KEY" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(/Đang có/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Huỷ" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.command === "secret_delete")).toBe(false);
  });
});
