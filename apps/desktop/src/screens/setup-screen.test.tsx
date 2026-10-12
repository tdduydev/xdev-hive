import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { type Account, AccountContext } from "@/lib/account.ts";
import { saveFolder } from "@/lib/folder.ts";
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
    expect(calls[0]).toEqual({ command: "scan_environment", args: { folder: null, project: null } });
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
    expect(calls.find((c) => c.command === "run_install")?.args).toEqual({ id: "go", folder: null, project: null });
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
    expect(calls.at(-1)).toEqual({ command: "scan_environment", args: { folder: "/tmp/du-an", project: null } });
    expect(localStorage.getItem("hive.folder")).toBe("/tmp/du-an");
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

  it("thư mục khớp dự án trên hub: gửi project key, hiện MCP được phép và token MCP", async () => {
    saveFolder("/w/payment-api");
    const account: Account = {
      name: "Hà",
      email: "ha@acme.vn",
      orgId: "o1",
      orgName: "Acme",
      orgRole: "member",
      teams: [{ id: "t1", name: "Thanh toán", role: "member" }],
    };
    const calls = fakeTauri({
      workspace_meta: () => ({
        folder: "/w/payment-api",
        name: "payment-api",
        isGit: true,
        branch: "main",
        remote: "git@github.com:acme/payment-api.git",
      }),
      hub_tool: () => ({
        projects: [
          {
            key: "PAY",
            name: "payment-api",
            state: "active",
            repo: {
              kind: "github",
              owner: "acme",
              name: "payment-api",
              httpUrl: "https://github.com/acme/payment-api.git",
              sshUrl: null,
              webUrl: null,
            },
          },
        ],
      }),
      scan_environment: () => [
        item({ id: "git", name: "Git", required: true, have: "2.50.1" }),
        item({
          id: "hive-token",
          name: "Token MCP xDev Hive",
          kind: "mcp",
          required: true,
          status: "missing",
          source: "hub",
        }),
        item({
          id: "mcp:github",
          name: "MCP github",
          kind: "mcp",
          need: "stdio",
          status: "optional",
          source: "hub",
          install: {
            command: "claude mcp add --scope user github -- npx -y @modelcontextprotocol/server-github",
            runnable: true,
            admin: false,
          },
        }),
        item({
          id: "setup:golangci-lint",
          name: "golangci-lint",
          required: true,
          status: "missing",
          source: ".hive/setup.sh",
        }),
      ],
    });
    render(
      <AccountContext.Provider value={account}>
        <SetupScreen />
      </AccountContext.Provider>,
    );
    const mcp = (await screen.findByText("MCP github")).closest("tr") as HTMLElement;
    expect(within(mcp).getByText("MCP được phép")).toBeTruthy();
    expect(within(mcp).getByText("MCP server")).toBeTruthy();
    expect(calls.find((c) => c.command === "scan_environment")?.args).toEqual({
      folder: "/w/payment-api",
      project: "PAY",
    });
    const golang = (await screen.findAllByText("golangci-lint"))
      .map((e) => e.closest("tr"))
      .find(Boolean) as HTMLElement;
    expect(within(golang).getByText(".hive/setup.sh")).toBeTruthy();
    await userEvent
      .setup()
      .click((await screen.findAllByText("Token MCP xDev Hive")).find((e) => e.closest("tr")) as HTMLElement);
    expect(await screen.findByText(/Liên kết tài khoản ở thẻ người dùng/)).toBeTruthy();
  });
});
