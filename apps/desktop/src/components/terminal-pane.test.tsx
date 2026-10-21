import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPane } from "@/components/terminal-pane.tsx";
import { setLang } from "@/lib/i18n.ts";
import { openTerminal, resetTerminals } from "@/lib/pty.ts";
import { rememberTermDefault, termDefault } from "@/lib/term-defaults.ts";
import { screenText, terms } from "@/test-fake-xterm.ts";

vi.mock("@xterm/xterm", () => import("@/test-fake-xterm.ts"));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

const SHOP = "/Users/ha/shop";
const BLOG = "/Users/ha/blog";

type Call = { command: string; args?: Record<string, unknown> | undefined };

const plan = (id: string, cli: string, extra: { enabled?: boolean; loggedIn?: boolean; priority?: number } = {}) => ({
  id,
  label: id,
  cli,
  enabled: true,
  priority: 1,
  maxConcurrent: 1,
  cooldownMinutes: 0,
  supported: true,
  loggedIn: true,
  ...extra,
});

function fakeTauri(accounts = [plan("claude-2", "claude"), plan("claude-3", "claude"), plan("codex-1", "codex")]) {
  const calls: Call[] = [];
  const listeners: Record<string, (e: { payload: unknown }) => void> = {};
  let ptys = 0;
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    cli_profiles: () => ({
      path: "/Users/ha/.xdev-hive/worker.yaml",
      accounts,
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
    event: {
      listen: async <T,>(event: string, handler: (e: { payload: T }) => void) => {
        listeners[event] = handler as (e: { payload: unknown }) => void;
        return () => {};
      },
    },
  };
  const emit = (event: string, payload: unknown) => act(async () => listeners[event]?.({ payload }));
  return { calls, emit };
}

describe("TerminalPane", () => {
  beforeEach(() => {
    setLang("vi");
    resetTerminals();
    terms.length = 0;
  });

  it("chỉ hiện tab của thư mục đang mở", async () => {
    fakeTauri();
    openTerminal({ cli: "shell", planId: null, bypass: false, folder: BLOG, label: "Shell blog" });
    openTerminal({ cli: "shell", planId: null, bypass: false, folder: SHOP, label: "Shell shop" });
    render(<TerminalPane folder={SHOP} onPickFolder={() => {}} />);
    expect(await screen.findByRole("tab", { name: /Shell shop/ })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /Shell blog/ })).toBeNull();
  });

  it("mở tab thì nhớ CLI và gói cho thư mục, không nhớ bỏ hỏi quyền", async () => {
    fakeTauri();
    const user = userEvent.setup();
    render(<TerminalPane folder={SHOP} onPickFolder={() => {}} />);
    await screen.findByRole("option", { name: "claude-3" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Gói agent" }), "claude-3");
    await user.click(screen.getAllByRole("button", { name: "Mở terminal" })[0] as HTMLElement);
    expect(termDefault(SHOP)).toEqual({ cli: "claude", planId: "claude-3" });

    await user.selectOptions(screen.getByRole("combobox", { name: "Chạy" }), "codex");
    await user.click(screen.getByRole("checkbox", { name: "Bỏ hỏi quyền" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Mở không hỏi quyền" }));
    await user.click(screen.getByRole("button", { name: "Terminal mới" }));
    // Đổi CLI thì chọn sẵn gói đang bật của CLI đó.
    expect(termDefault(SHOP)).toEqual({ cli: "codex", planId: "codex-1" });
    expect(JSON.stringify(localStorage)).not.toContain("bypass");
    expect(termDefault(BLOG)).toBeNull();
  });

  it("Đổi gói mở lại CLI trong cùng tab bằng gói khác, không giữ bỏ hỏi quyền", async () => {
    const { calls, emit } = fakeTauri();
    const user = userEvent.setup();
    openTerminal({ cli: "claude", planId: "claude-2", bypass: true, folder: SHOP, label: "Claude Code · claude-2" });
    render(<TerminalPane folder={SHOP} onPickFolder={() => {}} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /claude-2/ }).textContent).not.toMatch(/đang mở/));
    const term = terms[0] as (typeof terms)[number];

    await user.selectOptions(await screen.findByRole("combobox", { name: "Đổi gói" }), "claude-3");
    await waitFor(() =>
      expect(calls.filter((c) => c.command === "pty_open").at(-1)?.args).toMatchObject({
        cli: "claude",
        planId: "claude-3",
        bypass: false,
        folder: SHOP,
      }),
    );
    const closeAt = calls.findIndex((c) => c.command === "pty_close");
    expect(calls[closeAt]?.args).toEqual({ id: "pty-1" });
    expect(closeAt).toBeLessThan(calls.map((c) => c.command).lastIndexOf("pty_open"));
    expect(screen.getByRole("tab", { name: /Claude Code · claude-3/ })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /bỏ hỏi quyền/ })).toBeNull();
    expect(screenText(term)).toContain("Đổi gói: Claude Code · claude-3");
    expect(termDefault(SHOP)).toEqual({ cli: "claude", planId: "claude-3" });

    // CLI cũ thoát muộn hay in thêm: tab vẫn chạy, không vẽ output của CLI cũ.
    await waitFor(() => expect(screen.getByRole("tab", { name: /claude-3/ }).textContent).not.toMatch(/đang mở/));
    const before = term.written.length;
    await emit("pty:data", { id: "pty-1", data: btoa("cu") });
    await emit("pty:exit", { id: "pty-1", code: 0 });
    expect(term.written.length).toBe(before);
    expect(screen.getByRole("tab", { name: /claude-3/ }).textContent).not.toMatch(/đã thoát/);
  });

  it("tab shell không có Đổi gói", async () => {
    fakeTauri();
    openTerminal({ cli: "shell", planId: null, bypass: false, folder: SHOP, label: "Shell" });
    render(<TerminalPane folder={SHOP} onPickFolder={() => {}} />);
    await screen.findByRole("tab", { name: /Shell/ });
    expect(screen.queryByRole("combobox", { name: "Đổi gói" })).toBeNull();
  });

  it("thanh công cụ chọn sẵn CLI và gói dùng lần cuối ở dự án", async () => {
    fakeTauri();
    rememberTermDefault(SHOP, { cli: "codex", planId: "codex-1" });
    render(<TerminalPane folder={SHOP} onPickFolder={() => {}} />);
    await screen.findByRole("option", { name: "codex-1" });
    expect((screen.getByRole("combobox", { name: "Chạy" }) as HTMLSelectElement).value).toBe("codex");
    expect((screen.getByRole("combobox", { name: "Gói agent" }) as HTMLSelectElement).value).toBe("codex-1");
  });

  it("chỉ cho chọn gói đã đăng nhập và đang bật, mặc định gói ưu tiên cao nhất", async () => {
    fakeTauri([
      plan("claude-2", "claude", { priority: 10 }),
      plan("claude-3", "claude", { priority: 50 }),
      plan("claude-4", "claude", { enabled: false, priority: 99 }),
      plan("claude-5", "claude", { loggedIn: false, priority: 99 }),
    ]);
    render(<TerminalPane folder={SHOP} onPickFolder={() => {}} />);
    await screen.findByRole("option", { name: "claude-3" });
    const picker = screen.getByRole("combobox", { name: "Gói agent" }) as HTMLSelectElement;
    // Gói mặc định được chọn trong effect chạy sau khi danh sách gói đọc xong.
    await waitFor(() => expect(picker.value).toBe("claude-3"));
    expect([...picker.options].map((o) => o.value)).toEqual(["", "claude-3", "claude-2"]);
  });

  it("gói nhớ ở dự án đã tắt thì đổi sang gói dùng được; đã chọn đăng nhập mặc định thì giữ", async () => {
    fakeTauri([plan("claude-2", "claude", { enabled: false }), plan("claude-3", "claude")]);
    rememberTermDefault(SHOP, { cli: "claude", planId: "claude-2" });
    rememberTermDefault(BLOG, { cli: "claude", planId: null });
    const { rerender } = render(<TerminalPane folder={SHOP} onPickFolder={() => {}} />);
    await screen.findByRole("option", { name: "claude-3" });
    await waitFor(() =>
      expect((screen.getByRole("combobox", { name: "Gói agent" }) as HTMLSelectElement).value).toBe("claude-3"),
    );
    rerender(<TerminalPane folder={BLOG} onPickFolder={() => {}} />);
    await waitFor(() =>
      expect((screen.getByRole("combobox", { name: "Gói agent" }) as HTMLSelectElement).value).toBe(""),
    );
  });
});
