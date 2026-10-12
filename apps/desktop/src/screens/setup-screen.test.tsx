import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import { type CheckItem, readiness, sortChecks } from "@/lib/setup.ts";
import { SetupScreen } from "@/screens/setup-screen.tsx";

const item = (over: Partial<CheckItem> & Pick<CheckItem, "id" | "name">): CheckItem => ({
  kind: "tool",
  required: false,
  need: null,
  have: null,
  status: "ok",
  source: "",
  install: null,
  ...over,
});

const ITEMS: CheckItem[] = [
  item({ id: "git", name: "Git", required: true, have: "2.50.1" }),
  item({
    id: "go",
    name: "Go",
    kind: "runtime",
    required: true,
    need: "≥ 1.27",
    have: "1.25.4",
    status: "outdated",
    source: "go.mod",
    install: { command: "brew install go", runnable: true, admin: false },
  }),
  item({
    id: "node",
    name: "Node.js",
    kind: "runtime",
    required: true,
    need: "24.x",
    status: "missing",
    source: ".nvmrc",
    install: { command: "nvm install 24", runnable: false, admin: false },
  }),
  item({
    id: "gemini",
    name: "Gemini CLI",
    kind: "cli",
    status: "optional",
    install: { command: "npm install -g @google/gemini-cli", runnable: true, admin: false },
  }),
];

function fakeTauri(handlers: Record<string, (args?: Record<string, unknown>) => unknown>) {
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

describe("logic AppSetup", () => {
  it("xếp mục cần xử lý lên đầu và tính điểm trên mục bắt buộc", () => {
    expect(sortChecks(ITEMS).map((i) => i.id)).toEqual(["node", "go", "gemini", "git"]);
    expect(readiness(ITEMS)).toEqual({ ready: 1, required: 3 });
  });
});

describe("SetupScreen", () => {
  beforeEach(() => setLang("vi"));

  it("quét khi mở, hiện điểm, mục thiếu đầu tiên và lệnh chỉ chép được", async () => {
    const calls = fakeTauri({ scan_environment: () => ITEMS });
    render(<SetupScreen />);
    expect(await screen.findByRole("img", { name: "1 trên 3 mục bắt buộc đã đủ" })).toBeTruthy();
    expect(calls[0]).toEqual({ command: "scan_environment", args: { folder: null } });
    const detail = screen.getByRole("heading", { level: 2 });
    expect(detail.textContent).toBe("Node.js");
    expect(screen.getByText("nvm install 24")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Chạy" })).toBeNull();
    expect(screen.getByText(/cần quyền quản trị hoặc cần shell/)).toBeTruthy();
  });

  it("lọc Cần xử lý chỉ còn mục thiếu và cũ", async () => {
    fakeTauri({ scan_environment: () => ITEMS });
    render(<SetupScreen />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Cần xử lý (2)" }));
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]?.textContent)).toEqual(["Node.js.nvmrc", "Gogo.mod"]);
  });

  it("Chạy phải xác nhận, chỉ gửi id rồi quét lại", async () => {
    let scans = 0;
    const calls = fakeTauri({
      scan_environment: () => {
        scans++;
        return ITEMS;
      },
      run_install: () => ({ ok: true, code: 0, output: "==> Pouring go" }),
    });
    render(<SetupScreen />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Go/ }));
    await user.click(screen.getByRole("button", { name: "Chạy" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("brew install go")).toBeTruthy();
    expect(calls.some((c) => c.command === "run_install")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Chạy" }));
    expect(await screen.findByText("Lệnh chạy xong. Đã kiểm tra lại.")).toBeTruthy();
    expect(calls.find((c) => c.command === "run_install")?.args).toEqual({ id: "go", folder: null });
    expect(scans).toBe(2);
    expect(screen.getByText("==> Pouring go")).toBeTruthy();
  });

  it("nhớ thư mục dự án và gửi khi bấm Kiểm tra", async () => {
    const calls = fakeTauri({ scan_environment: () => ITEMS });
    render(<SetupScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Thư mục dự án"), "/tmp/du-an");
    await user.click(screen.getByRole("button", { name: "Kiểm tra" }));
    await screen.findByRole("img", { name: /mục bắt buộc/ });
    expect(calls.at(-1)).toEqual({ command: "scan_environment", args: { folder: "/tmp/du-an" } });
    expect(localStorage.getItem("hive.setup.folder")).toBe("/tmp/du-an");
  });

  it("thư mục sai: hiện lỗi của Rust", async () => {
    fakeTauri({ scan_environment: () => Promise.reject("Không tìm thấy thư mục /khong-co.") });
    render(<SetupScreen />);
    expect((await screen.findByRole("alert")).textContent).toBe("Không tìm thấy thư mục /khong-co.");
  });

  it("tiếng Anh", async () => {
    setLang("en");
    fakeTauri({ scan_environment: () => ITEMS });
    render(<SetupScreen />);
    expect(await screen.findByRole("img", { name: "1 of 3 required items ready" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Needs action (2)" })).toBeTruthy();
    expect(screen.getAllByText("Missing").length).toBeGreaterThan(0);
  });
});
