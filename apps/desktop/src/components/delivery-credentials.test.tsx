import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { DeliveryCredential } from "@/lib/delivery-credentials.ts";
import { setLang } from "@/lib/i18n.ts";
import type { StoreStatus } from "@/lib/secrets.ts";
import { SecretsScreen } from "@/screens/secrets-screen.tsx";

const VALUE = "bot:gia-tri-gia-0123456789";
const OK: StoreStatus = { available: true, locked: false, backend: "keychain", reason: "" };

const cred = (name: string): DeliveryCredential => ({
  name,
  createdAt: "2026-10-01T08:30:00Z",
  valueChangedAt: "2026-10-02T09:15:00Z",
});

interface Call {
  command: string;
  args?: Record<string, unknown> | undefined;
}

function fakeApp(opts: {
  creds?: DeliveryCredential[];
  status?: StoreStatus;
  override?: Record<string, (args?: Record<string, unknown>) => unknown>;
}) {
  const calls: Call[] = [];
  let creds = opts.creds ?? [];
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    secrets_status: () => OK,
    secrets_list: () => ({ secrets: [], reserved: { exact: [], prefixes: [] } }),
    local_projects: () => ({ path: "", exists: false, imported: 0, projects: [] }),
    delivery_creds_status: () => opts.status ?? OK,
    delivery_creds_list: () => ({ registration: "reg_abcdefgh", credentials: creds }),
    delivery_cred_save: (a) => {
      const item = cred(String(a?.name));
      creds = [...creds.filter((c) => c.name !== item.name), item];
      return item;
    },
    delivery_cred_delete: (a) => {
      creds = creds.filter((c) => c.name !== a?.name);
      return { deleted: a?.name };
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

async function openTab(user: ReturnType<typeof userEvent.setup>) {
  render(<SecretsScreen />);
  await user.click(await screen.findByRole("tab", { name: "Credential triển khai" }));
}

const row = (name: string) => screen.getByRole("row", { name: new RegExp(name) });

beforeEach(() => {
  setLang("vi");
  location.hash = "#/secrets";
});

describe("màn Bí mật: tab Credential triển khai", () => {
  it("liệt kê tên và lúc đổi giá trị; không có nút Hiện hay Sao chép, không có nút của bí mật dự án", async () => {
    fakeApp({ creds: [cred("jenkins-prod"), cred("argocd")] });
    const user = userEvent.setup();
    await openTab(user);
    expect(await screen.findByText("jenkins-prod")).toBeTruthy();
    expect(within(row("jenkins-prod")).getByText(/2026/)).toBeTruthy();
    expect(screen.getByText(/reg_abcdefgh/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Hiện|Sao chép/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Thêm bí mật" })).toBeNull();
    expect(screen.getByText(/không gán cho dự án/)).toBeTruthy();
  });

  it("chưa có credential: báo cách thêm", async () => {
    fakeApp({ creds: [] });
    const user = userEvent.setup();
    await openTab(user);
    expect(await screen.findByText(/Chưa có credential triển khai nào/)).toBeTruthy();
  });

  it("thêm: ô giá trị là password, có gợi ý định dạng; lưu gửi tên chữ thường; giá trị không còn trong DOM", async () => {
    const { calls } = fakeApp({ creds: [] });
    const user = userEvent.setup();
    await openTab(user);
    await screen.findByText(/Chưa có credential/);
    await user.click(screen.getByRole("button", { name: "Thêm credential" }));
    const dialog = await screen.findByRole("dialog");
    const value = within(dialog).getByLabelText("Giá trị") as HTMLInputElement;
    expect(value.type).toBe("password");
    expect(value.autocomplete).toBe("off");
    expect(within(dialog).getByText(/user:token/)).toBeTruthy();
    expect(within(dialog).getByText(/token trần/)).toBeTruthy();

    await user.type(within(dialog).getByLabelText("Tên"), " Jenkins-Prod ");
    await user.type(value, VALUE);
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.command === "delivery_cred_save")?.args).toEqual({ name: "jenkins-prod", value: VALUE });
    expect(await screen.findByText("jenkins-prod")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(VALUE);
  });

  it("tên sai, trùng tên, thiếu giá trị: báo cạnh ô và không gọi worker", async () => {
    const { calls } = fakeApp({ creds: [cred("argocd")] });
    const user = userEvent.setup();
    await openTab(user);
    await screen.findByText("argocd");
    await user.click(screen.getByRole("button", { name: "Thêm credential" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText("Tên");

    await user.type(name, "a_b");
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));
    expect(within(dialog).getByText(/chỉ gồm chữ thường/)).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");

    await user.clear(name);
    await user.type(name, "argocd");
    expect(within(dialog).getByText(/Đã có credential tên argocd/)).toBeTruthy();

    await user.clear(name);
    await user.type(name, "jenkins");
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));
    expect(within(dialog).getByText("Nhập giá trị.")).toBeTruthy();
    expect(calls.some((c) => c.command === "delivery_cred_save")).toBe(false);
  });

  it("thay giá trị: giữ tên, chỉ hỏi giá trị; worker từ chối thì hiện lỗi và ô giá trị đã được xoá", async () => {
    let fail = true;
    const { calls } = fakeApp({
      creds: [cred("argocd")],
      override: {
        delivery_cred_save: (a) => {
          if (fail) throw "Giá trị quá ngắn.";
          return cred(String(a?.name));
        },
      },
    });
    const user = userEvent.setup();
    await openTab(user);
    await user.click(await screen.findByRole("button", { name: "Thay giá trị của argocd" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("Tên")).toBeNull();
    const value = within(dialog).getByLabelText("Giá trị") as HTMLInputElement;
    await user.type(value, VALUE);
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));
    expect(await within(dialog).findByText("Giá trị quá ngắn.")).toBeTruthy();
    expect(value.value).toBe("");

    fail = false;
    await user.type(value, VALUE);
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.command === "delivery_cred_save").map((c) => c.args?.name)).toEqual([
      "argocd",
      "argocd",
    ]);
  });

  it("xoá có xác nhận; Huỷ được focus trước và không xoá", async () => {
    const { calls } = fakeApp({ creds: [cred("jenkins-prod"), cred("argocd")] });
    const user = userEvent.setup();
    await openTab(user);
    await user.click(await screen.findByRole("button", { name: "Xoá jenkins-prod" }));
    let dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Huỷ" })));
    await user.click(within(dialog).getByRole("button", { name: "Huỷ" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.command === "delivery_cred_delete")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Xoá jenkins-prod" }));
    dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Xoá credential" }));
    await waitFor(() => expect(screen.queryByText("jenkins-prod")).toBeNull());
    expect(calls.find((c) => c.command === "delivery_cred_delete")?.args).toEqual({ name: "jenkins-prod" });
    expect(screen.getByText("argocd")).toBeTruthy();
  });

  it("kho không có (Linux thiếu Secret Service): banner nêu lý do, khoá Thêm và Thay giá trị", async () => {
    fakeApp({
      creds: [cred("argocd")],
      status: {
        available: false,
        locked: null,
        backend: "secret-service",
        reason: "Máy không có kho bí mật (Secret Service). Cài gnome-keyring hoặc KWallet rồi thử lại.",
      },
    });
    const user = userEvent.setup();
    await openTab(user);
    const banner = await screen.findByText("Máy này không có kho bí mật dùng được");
    const alert = banner.closest("[role=alert]") as HTMLElement;
    expect(within(alert).getByText(/Cài gnome-keyring/)).toBeTruthy();
    expect(within(alert).getByText(/app không lưu ở chỗ khác/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Thêm credential" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Thay giá trị của argocd" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("kho đang khoá: Kiểm tra lại đọc lại trạng thái", async () => {
    let locked = true;
    const { calls } = fakeApp({
      creds: [],
      override: { delivery_creds_status: () => ({ ...OK, locked }) },
    });
    const user = userEvent.setup();
    await openTab(user);
    expect(await screen.findByText("Kho bí mật của hệ điều hành đang khoá")).toBeTruthy();
    locked = false;
    await user.click(screen.getByRole("button", { name: "Kiểm tra lại" }));
    await waitFor(() => expect(screen.queryByText("Kho bí mật của hệ điều hành đang khoá")).toBeNull());
    expect(calls.filter((c) => c.command === "delivery_creds_status")).toHaveLength(2);
  });

  it("lỗi đọc danh sách: hiện lỗi của worker và nút thử lại", async () => {
    let fail = true;
    fakeApp({
      override: {
        delivery_creds_list: () => {
          if (fail) throw "Danh mục credential triển khai hỏng.";
          return { registration: "reg_legacy", credentials: [cred("argocd")] };
        },
      },
    });
    const user = userEvent.setup();
    await openTab(user);
    expect(await screen.findByText("Danh mục credential triển khai hỏng.")).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(await screen.findByText("argocd")).toBeTruthy();
  });

  it("phím mũi tên đi vòng qua ba tab", async () => {
    fakeApp({});
    const user = userEvent.setup();
    render(<SecretsScreen />);
    const list = await screen.findByRole("tab", { name: "Danh sách" });
    list.focus();
    await user.keyboard("{ArrowLeft}");
    const delivery = screen.getByRole("tab", { name: "Credential triển khai" });
    expect(delivery.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(delivery);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Danh sách" }).getAttribute("aria-selected")).toBe("true");
  });
});
