import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPane } from "@/components/terminal-pane.tsx";
import { setLang } from "@/lib/i18n.ts";
import type { MachineAgent } from "@/lib/machine-agents.ts";
import { openTerminal, resetTerminals, terminals } from "@/lib/pty.ts";
import { AgentsScreen } from "@/screens/agents-screen.tsx";
import { terms } from "@/test-fake-xterm.ts";

vi.mock("@xterm/xterm", () => import("@/test-fake-xterm.ts"));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

type Call = { command: string; args?: Record<string, unknown> | undefined };

const STARTED = Math.floor(Date.now() / 1000) - 600;

const agent = (over: Partial<MachineAgent>): MachineAgent => ({
  pid: 4242,
  cli: "claude",
  background: false,
  bypass: false,
  startedAt: STARTED,
  cpu: 12.5,
  memory: 734_003_200,
  cwd: "/Users/ha/shop/src",
  configDir: "/Users/ha/.xdev-hive/accounts/claude-2",
  hiveProject: null,
  source: { kind: "terminal" },
  own: true,
  children: 0,
  activity: null,
  ...over,
});

const MINE = agent({
  children: 2,
  activity: {
    title: "Sửa login",
    status: "busy",
    prompt: "Sửa lỗi đăng nhập bằng Google",
    step: "Bash: Chạy test",
    at: new Date(Date.now() - 30_000).toISOString(),
    guessed: false,
  },
});
const RUN = agent({
  pid: 5000,
  cli: "codex",
  cwd: "/Users/ha/.cache/xdev-hive/worker/runs/r-77-1",
  configDir: null,
  hiveProject: "PAY",
  source: { kind: "run", runId: "r-77" },
  activity: { title: null, status: "idle", prompt: "Viết test", step: null, at: null, guessed: true },
});
const HIVE = agent({ pid: 6000, configDir: null, source: { kind: "hive", sessionId: "s-1", hubId: "h-9" } });
const DESKTOP = agent({ pid: 7000, configDir: null, background: true, source: { kind: "claudeDesktop" } });
const FOREIGN = agent({ pid: 8000, cli: "antigravity", configDir: null, own: false });

function fakeTauri(agents: MachineAgent[]) {
  const calls: Call[] = [];
  let ptys = 0;
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    machine_agents: () => ({ agents, home: "/Users/ha" }),
    machine_agent_stop: () => null,
    machine_agent_feed: () => ({
      path: "/Users/ha/.claude/projects/-Users-ha-shop/s.jsonl",
      entries: [{ at: "2026-10-18T08:00:00Z", kind: "user", tool: null, text: "Sửa lỗi đăng nhập", cut: false }],
      start: 0,
      end: 10,
      reset: false,
      guessed: false,
      readable: true,
    }),
    remote_session_kill: () => null,
    open_hub_page: () => null,
    local_projects: () => ({
      path: "/x/projects.json",
      exists: true,
      imported: 0,
      projects: [
        { projectId: "", name: "shop", folder: "/Users/ha/shop", fullPermission: false, exists: true, isGit: true },
      ],
    }),
    cli_profiles: () => ({
      path: "/x/worker.yaml",
      accounts: [
        {
          id: "claude-2",
          label: "claude-2",
          cli: "claude",
          configDir: "~/.xdev-hive/accounts/claude-2",
          enabled: true,
          priority: 1,
          maxConcurrent: 1,
          cooldownMinutes: 0,
          supported: true,
          loggedIn: true,
          email: "ha@acme.vn",
        },
      ],
    }),
    pty_open: () => `pty-${++ptys}`,
    pty_write: () => null,
    pty_resize: () => null,
    pty_close: () => null,
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
    event: { listen: async () => () => {} },
  };
  return calls;
}

const row = (pid: number) => screen.findByRole("listitem", { name: new RegExp(`PID ${pid}\\b`) });

describe("AgentsScreen", () => {
  beforeEach(() => {
    setLang("vi");
    resetTerminals();
    terms.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mỗi agent một dòng: CLI, PID, dự án, gói, nguồn, CPU, RAM và việc đang làm", async () => {
    fakeTauri([MINE, RUN]);
    render(<AgentsScreen />);
    const mine = await row(4242);
    expect(within(mine).getByText("Sửa login")).toBeTruthy();
    expect(within(mine).getByText("Đang làm")).toBeTruthy();
    await within(mine).findByText(/claude-2 · ha@acme\.vn/);
    for (const text of ["Claude Code", "Terminal của bạn", "CPU 12,5%", "RAM 700 MB", "shop"]) {
      expect(within(mine).getAllByText(new RegExp(text)).length).toBeGreaterThan(0);
    }
    expect(within(mine).getByText(/Bash: Chạy test/)).toBeTruthy();
    expect(within(mine).getByText(/Sửa lỗi đăng nhập bằng Google/)).toBeTruthy();
    const run = await row(5000);
    expect(within(run).getByText("Hive run")).toBeTruthy();
    expect(within(run).getByText(/PAY/)).toBeTruthy();
    expect(within(run).getByText(/Đăng nhập mặc định/)).toBeTruthy();
    expect(within(run).getByText(/đoán theo thư mục/)).toBeTruthy();
  });

  it("bấm vào thẻ agent (hay Enter) mở khung Hoạt động của đúng tiến trình", async () => {
    const calls = fakeTauri([MINE, RUN]);
    const user = userEvent.setup();
    render(<AgentsScreen />);
    const card = within(await row(4242)).getByRole("button", { name: /^Xem hoạt động: Sửa login/ });
    // Tên của nút gồm cả nội dung thẻ: trình đọc màn hình vẫn nghe trạng thái, việc đang làm, lời nhắc cuối.
    expect(card.textContent).toContain("Bash: Chạy test");
    expect(card.getAttribute("aria-label")).toBeNull();
    card.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: /Hoạt động · Sửa login/ });
    expect(await within(dialog).findByText("Sửa lỗi đăng nhập")).toBeTruthy();
    expect(calls.find((c) => c.command === "machine_agent_feed")?.args).toMatchObject({
      pid: 4242,
      startedAt: STARTED,
      cursor: null,
    });
    // Nút trên thẻ vẫn làm việc riêng của nó, không mở khung.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(
      within(await row(5000))
        .getByRole("button", { name: "Mở run trên web" })
        .closest("button") as HTMLElement,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("đếm theo CLI và lọc theo nguồn", async () => {
    fakeTauri([MINE, RUN, HIVE]);
    const user = userEvent.setup();
    render(<AgentsScreen />);
    await row(4242);
    const counts = screen.getByRole("list", { name: "Số agent theo CLI" });
    expect(within(counts).getByText("Claude Code").parentElement?.textContent).toContain("2");
    expect(within(counts).getByText("Codex").parentElement?.textContent).toContain("1");
    expect(within(counts).getByText("Antigravity").parentElement?.textContent).toContain("0");
    await user.selectOptions(screen.getByRole("combobox", { name: "Nguồn" }), "run");
    expect(screen.getAllByRole("listitem", { name: /PID/ })).toHaveLength(1);
    expect(screen.getByRole("listitem", { name: /PID 5000/ })).toBeTruthy();
  });

  it("mở run và phiên hive trên web", async () => {
    const calls = fakeTauri([RUN, HIVE]);
    const user = userEvent.setup();
    render(<AgentsScreen />);
    await user.click(within(await row(5000)).getByRole("button", { name: "Mở run trên web" }));
    await user.click(within(await row(6000)).getByRole("button", { name: "Mở phiên trên web" }));
    expect(calls.filter((c) => c.command === "open_hub_page").map((c) => c.args)).toEqual([
      { path: "/runs/r-77" },
      { path: "/leader/terminal/h-9" },
    ]);
  });

  it("Terminal ở thư mục này mở tab shell ở thư mục của agent", async () => {
    fakeTauri([MINE]);
    const user = userEvent.setup();
    render(<AgentsScreen />);
    await user.click(within(await row(4242)).getByRole("button", { name: "Terminal ở thư mục này" }));
    expect(location.hash).toBe("#/terminal");
    expect(terminals().folder).toBe("/Users/ha/shop/src");
    expect(terminals().sessions.at(-1)).toMatchObject({ cli: "shell", folder: "/Users/ha/shop/src", bypass: false });
  });

  it("agent trong tab của app: Mở tab chọn đúng tab; Dừng đóng tab CLI, tab shell chỉ dừng agent", async () => {
    const calls = fakeTauri([]);
    openTerminal({ cli: "claude", planId: null, bypass: false, folder: "/Users/ha/shop", label: "Claude Code" });
    openTerminal({ cli: "shell", planId: null, bypass: false, folder: "/Users/ha/blog", label: "Shell" });
    const shopPane = render(<TerminalPane folder="/Users/ha/shop" onPickFolder={() => {}} />);
    await waitFor(() => expect(terminals().sessions[0]?.status).toBe("running"));
    shopPane.unmount();
    const blogPane = render(<TerminalPane folder="/Users/ha/blog" onPickFolder={() => {}} />);
    await waitFor(() => expect(terminals().sessions[1]?.status).toBe("running"));
    blogPane.unmount();
    const [cliTab, shellTab] = terminals().sessions;
    expect(calls.filter((c) => c.command === "pty_open")).toHaveLength(2);
    const later = fakeTauri([
      agent({ pid: 9000, configDir: null, source: { kind: "app", pty: cliTab?.ptyId ?? null } }),
      agent({ pid: 9100, configDir: null, source: { kind: "app", pty: shellTab?.ptyId ?? null } }),
    ]);
    const user = userEvent.setup();
    render(<AgentsScreen />);
    await user.click(within(await row(9000)).getByRole("button", { name: "Mở tab" }));
    expect(location.hash).toBe("#/terminal");
    expect(terminals().active).toBe(cliTab?.key);
    expect(terminals().folder).toBe("/Users/ha/shop");

    // Agent là CLI chính của tab: đóng PTY để tab chuyển sang đã thoát, tab vẫn còn.
    await user.click(within(await row(9000)).getByRole("button", { name: "Dừng…" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Dừng" }));
    await waitFor(() => expect(later.find((c) => c.command === "pty_close")?.args).toEqual({ id: cliTab?.ptyId }));
    expect(terminals().sessions).toHaveLength(2);
    // Agent chạy trong tab shell: chỉ dừng agent, shell còn mở.
    await user.click(within(await row(9100)).getByRole("button", { name: "Dừng…" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Dừng" }));
    await waitFor(() =>
      expect(later.find((c) => c.command === "machine_agent_stop")?.args).toEqual({ pid: 9100, startedAt: STARTED }),
    );
    expect(later.filter((c) => c.command === "pty_close")).toHaveLength(1);
  });

  it("Dừng: chỉ agent của mình, cảnh báo theo nguồn, kiểm lại pid và giờ bắt đầu", async () => {
    const calls = fakeTauri([MINE, RUN, HIVE, DESKTOP, FOREIGN]);
    const user = userEvent.setup();
    render(<AgentsScreen />);
    expect(within(await row(8000)).queryByRole("button", { name: "Dừng…" })).toBeNull();

    await user.click(within(await row(4242)).getByRole("button", { name: "Dừng…" }));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/dừng 2 agent con/i)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Dừng" }));
    await waitFor(() =>
      expect(calls.find((c) => c.command === "machine_agent_stop")?.args).toEqual({ pid: 4242, startedAt: STARTED }),
    );

    await user.click(within(await row(5000)).getByRole("button", { name: "Dừng…" }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Run của Hive sẽ báo lỗi/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Huỷ" }));

    await user.click(within(await row(7000)).getByRole("button", { name: "Dừng…" }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Phiên trong Claude Desktop sẽ ngắt/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Huỷ" }));

    await user.click(within(await row(6000)).getByRole("button", { name: "Dừng…" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Dừng" }));
    await waitFor(() => expect(calls.find((c) => c.command === "remote_session_kill")?.args).toEqual({ id: "s-1" }));
  });

  it("đọc lại mỗi 3 giây, rời màn thì thôi", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = fakeTauri([MINE]);
    const view = render(<AgentsScreen />);
    await row(4242);
    const count = () => calls.filter((c) => c.command === "machine_agents").length;
    const before = count();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(count()).toBe(before + 1);
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(count()).toBe(before + 1);
  });
});
