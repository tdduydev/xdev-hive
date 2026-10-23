import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let log = opts.log ?? [];
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
    secrets_log: (a) => ({
      entries: log.filter(
        (e) => (!a?.name || e.names.some((n) => n.name === a.name)) && (!a?.project || e.project === a.project),
      ),
    }),
    secrets_log_clear: () => {
      const cleared = log.length;
      log = [];
      return { cleared };
    },
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

const grant = (id: string, over: Partial<GrantEntry> = {}): GrantEntry => ({
  id,
  at: "2026-10-23T08:01:02Z",
  kind: "run",
  sessionId: "run_abc#1",
  project: APP.localId,
  projectName: "app",
  names: [{ name: "DATABASE_URL", deleted: false, leaked: false }],
  policy: "allow",
  outcome: "granted",
  ...over,
});

const LOG: GrantEntry[] = [
  grant("g1", { names: [{ name: "STRIPE_TEST_KEY", deleted: false, leaked: true }] }),
  grant("g2", { project: API.localId, projectName: "api", kind: "terminal", policy: "approve", outcome: "declined" }),
  grant("g3", { kind: "reveal", copy: true, names: [{ name: "OLD_KEY", deleted: true, leaked: false }] }),
];

describe("màn Bí mật: nhật ký", () => {
  async function openLog(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByText("DATABASE_URL");
    await user.click(screen.getByRole("tab", { name: "Nhật ký" }));
    return await screen.findByRole("table");
  }

  it("hiện từng lần cấp, nhãn đã xoá và nhãn giá trị xuất hiện trong output; không có giá trị", async () => {
    fakeApp({ secrets: [DATABASE, STRIPE], log: LOG });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    const table = await openLog(user);
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(within(rows[1] as HTMLElement).getByText("STRIPE_TEST_KEY")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("giá trị xuất hiện trong output")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Terminal")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Bị từ chối")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("cần duyệt")).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText("OLD_KEY")).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText("đã xoá")).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText("Sao chép")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByText("đã xoá")).toBeNull();
  });

  it("lọc theo bí mật và theo dự án gửi đúng tham số", async () => {
    const { calls } = fakeApp({ secrets: [DATABASE, STRIPE], log: LOG });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    const table = await openLog(user);
    const logCalls = () => calls.filter((c) => c.command === "secrets_log").map((c) => c.args);
    expect(logCalls().at(-1)).toEqual({ limit: 200 });

    await user.selectOptions(screen.getByLabelText("Lọc theo bí mật"), "STRIPE_TEST_KEY");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2));
    expect(logCalls().at(-1)).toEqual({ name: "STRIPE_TEST_KEY", limit: 200 });

    await user.selectOptions(screen.getByLabelText("Lọc theo bí mật"), "");
    await user.selectOptions(screen.getByLabelText("Lọc theo dự án"), APP.localId);
    await waitFor(() => expect(logCalls().at(-1)).toEqual({ project: APP.localId, limit: 200 }));
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3));
  });

  it("nhật ký trống: báo chưa có; lọc không khớp: báo không khớp", async () => {
    fakeApp({ secrets: [DATABASE], log: [] });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    await screen.findByText("DATABASE_URL");
    await user.click(screen.getByRole("tab", { name: "Nhật ký" }));
    expect(await screen.findByText("Chưa có lần cấp bí mật nào.")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Lọc theo bí mật"), "DATABASE_URL");
    expect(await screen.findByText("Không có lần cấp nào khớp bộ lọc.")).toBeTruthy();
  });

  it("xoá nhật ký phải xác nhận; Huỷ được focus trước và không xoá", async () => {
    const { calls } = fakeApp({ secrets: [DATABASE], log: LOG });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    await openLog(user);
    await user.click(screen.getByRole("button", { name: "Xoá nhật ký" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Huỷ" })));
    await user.click(within(dialog).getByRole("button", { name: "Huỷ" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.command === "secrets_log_clear")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Xoá nhật ký" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Xoá nhật ký" }));
    expect(await screen.findByText("Chưa có lần cấp bí mật nào.")).toBeTruthy();
    expect(calls.filter((c) => c.command === "secrets_log_clear")).toHaveLength(1);
  });

  it("phím mũi tên đổi tab", async () => {
    fakeApp({ secrets: [DATABASE], log: LOG });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    await screen.findByText("DATABASE_URL");
    screen.getByRole("tab", { name: "Danh sách" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Nhật ký" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Nhật ký" }));
  });
});

describe("màn Bí mật: trạng thái kho", () => {
  it("kho không có: banner nêu lý do của worker, khoá nút Thêm, không có giá trị nào lưu chỗ khác", async () => {
    fakeApp({
      secrets: [STRIPE],
      status: {
        available: false,
        locked: null,
        backend: "secret-service",
        reason: "Máy không có kho bí mật (Secret Service). Cài gnome-keyring hoặc KWallet rồi thử lại.",
      },
    });
    render(<SecretsScreen />);
    const banner = await screen.findByText("Máy này không có kho bí mật dùng được");
    const alert = banner.closest("[role=alert]") as HTMLElement;
    expect(within(alert).getByText(/Cài gnome-keyring/)).toBeTruthy();
    expect(within(alert).getByText(/app không lưu ở chỗ khác/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Thêm bí mật" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("kho đang khoá: banner hướng dẫn mở khoá; Kiểm tra lại đọc lại trạng thái và banner mất khi mở khoá", async () => {
    let locked = true;
    const { calls } = fakeApp({
      secrets: [STRIPE],
      override: {
        secrets_status: () => ({ available: true, locked, backend: "keychain", reason: "" }),
      },
    });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    expect(await screen.findByText("Kho bí mật của hệ điều hành đang khoá")).toBeTruthy();
    locked = false;
    await user.click(screen.getByRole("button", { name: "Kiểm tra lại" }));
    await waitFor(() => expect(screen.queryByText("Kho bí mật của hệ điều hành đang khoá")).toBeNull());
    expect(calls.filter((c) => c.command === "secrets_status")).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Thêm bí mật" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("kho dùng được hay worker cũ chưa có lệnh trạng thái: không có banner", async () => {
    fakeApp({
      secrets: [STRIPE],
      override: {
        secrets_status: () => {
          throw "không có lệnh";
        },
      },
    });
    render(<SecretsScreen />);
    await screen.findByText("STRIPE_TEST_KEY");
    expect(screen.queryByText(/kho bí mật/i)).toBeNull();
    expect((screen.getByRole("button", { name: "Thêm bí mật" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("dòng thiếu giá trị trong kho báo đặt lại; sửa thì bắt buộc nhập lại giá trị", async () => {
    const { calls } = fakeApp({ secrets: [secret("LOST_KEY", { missingInStore: true }), STRIPE] });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    await screen.findByText("LOST_KEY");
    expect(within(row("LOST_KEY")).getByText("Kho thiếu giá trị, hãy đặt lại")).toBeTruthy();
    expect(within(row("STRIPE_TEST_KEY")).queryByText(/Kho thiếu giá trị/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Sửa LOST_KEY" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));
    expect(await within(dialog).findByText("Nhập giá trị.")).toBeTruthy();
    expect(calls.some((c) => c.command === "secret_save")).toBe(false);

    await user.type(within(dialog).getByLabelText("Giá trị"), "gia-tri-moi-12345678");
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(calls.some((c) => c.command === "secret_save")).toBe(true));
  });
});

describe("màn Bí mật: Hiện và Sao chép", () => {
  const VALUE = "gia-tri-gia-0123456789";
  const reveal = () => ({ secret_reveal: () => VALUE, secret_copy: () => null });

  afterEach(() => vi.useRealTimers());

  it("Hiện hỏi xác nhận trước, nút Huỷ được focus; Huỷ thì không lấy giá trị", async () => {
    const { calls } = fakeApp({ secrets: [STRIPE], override: reveal() });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    await screen.findByText("STRIPE_TEST_KEY");
    expect(document.body.textContent).not.toContain(VALUE);

    await user.click(screen.getByRole("button", { name: "Hiện giá trị của STRIPE_TEST_KEY" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Hiện giá trị của STRIPE_TEST_KEY?")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Huỷ" })));
    expect(calls.some((c) => c.command === "secret_reveal")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Huỷ" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.command === "secret_reveal")).toBe(false);
    expect(document.body.textContent).not.toContain(VALUE);
  });

  it("xác nhận thì giá trị hiện ở dòng đó, chỉ ở dòng đó, và Ẩn xoá ngay", async () => {
    const { calls } = fakeApp({ secrets: [DATABASE, STRIPE], override: reveal() });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    await screen.findByText("STRIPE_TEST_KEY");
    await user.click(screen.getByRole("button", { name: "Hiện giá trị của STRIPE_TEST_KEY" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Hiện giá trị" }));

    expect(await within(row("STRIPE_TEST_KEY")).findByText(VALUE)).toBeTruthy();
    expect(within(row("DATABASE_URL")).queryByText(VALUE)).toBeNull();
    expect(calls.filter((c) => c.command === "secret_reveal").map((c) => c.args)).toEqual([
      { name: "STRIPE_TEST_KEY" },
    ]);
    // Chỉ hiện ra khi người dùng bấm: không lưu chỗ nào ngoài state của dòng.
    expect(JSON.stringify({ ...localStorage })).not.toContain(VALUE);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(VALUE);

    await user.click(screen.getByRole("button", { name: "Ẩn giá trị của STRIPE_TEST_KEY" }));
    expect(document.body.textContent).not.toContain(VALUE);
    expect(screen.getByRole("button", { name: "Hiện giá trị của STRIPE_TEST_KEY" })).toBeTruthy();
  });

  it("tự ẩn sau 10 giây", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fakeApp({ secrets: [STRIPE], override: reveal() });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SecretsScreen />);
    await screen.findByText("STRIPE_TEST_KEY");
    await user.click(screen.getByRole("button", { name: "Hiện giá trị của STRIPE_TEST_KEY" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Hiện giá trị" }));
    expect(await screen.findByText(VALUE)).toBeTruthy();

    vi.advanceTimersByTime(9_000);
    expect(screen.queryByText(VALUE)).not.toBeNull();
    vi.advanceTimersByTime(1_500);
    await waitFor(() => expect(screen.queryByText(VALUE)).toBeNull());
  });

  it("rời màn thì giá trị mất; vào lại không thấy", async () => {
    const { calls } = fakeApp({ secrets: [STRIPE], override: reveal() });
    const user = userEvent.setup();
    const first = render(<SecretsScreen />);
    await screen.findByText("STRIPE_TEST_KEY");
    await user.click(screen.getByRole("button", { name: "Hiện giá trị của STRIPE_TEST_KEY" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Hiện giá trị" }));
    await screen.findByText(VALUE);

    first.unmount();
    expect(document.body.textContent).not.toContain(VALUE);
    render(<SecretsScreen />);
    await screen.findByText("STRIPE_TEST_KEY");
    expect(document.body.textContent).not.toContain(VALUE);
    expect(calls.filter((c) => c.command === "secret_reveal")).toHaveLength(1);
  });

  it("Sao chép hỏi xác nhận, chỉ gửi tên và không hiện giá trị", async () => {
    const { calls } = fakeApp({ secrets: [STRIPE], override: reveal() });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    await screen.findByText("STRIPE_TEST_KEY");
    await user.click(screen.getByRole("button", { name: "Sao chép giá trị của STRIPE_TEST_KEY" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Huỷ" })));
    expect(calls.some((c) => c.command === "secret_copy")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Sao chép giá trị" }));
    expect(await screen.findByText("Đã sao chép. Clipboard tự xoá sau 30 giây.")).toBeTruthy();
    expect(calls.filter((c) => c.command === "secret_copy").map((c) => c.args)).toEqual([{ name: "STRIPE_TEST_KEY" }]);
    expect(calls.some((c) => c.command === "secret_reveal")).toBe(false);
    expect(document.body.textContent).not.toContain(VALUE);
  });

  it("worker từ chối: lỗi nằm trong hộp xác nhận và không có giá trị nào hiện", async () => {
    fakeApp({
      secrets: [STRIPE],
      override: {
        secret_reveal: () => {
          throw new Error("Kho bí mật đang khoá.");
        },
      },
    });
    const user = userEvent.setup();
    render(<SecretsScreen />);
    await screen.findByText("STRIPE_TEST_KEY");
    await user.click(screen.getByRole("button", { name: "Hiện giá trị của STRIPE_TEST_KEY" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Hiện giá trị" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Kho bí mật đang khoá.");
    expect(screen.queryByRole("region", { name: "Giá trị", hidden: true })).toBeNull();
  });

  it("kho không dùng được hay dòng thiếu giá trị: khoá Hiện và Sao chép", async () => {
    fakeApp({
      secrets: [secret("LOST_KEY", { missingInStore: true }), STRIPE],
      override: reveal(),
    });
    render(<SecretsScreen />);
    await screen.findByText("LOST_KEY");
    for (const verb of ["Hiện giá trị của", "Sao chép giá trị của"]) {
      expect((screen.getByRole("button", { name: `${verb} LOST_KEY` }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: `${verb} STRIPE_TEST_KEY` }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    }
  });
});
