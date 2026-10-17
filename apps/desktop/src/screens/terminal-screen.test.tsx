import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import type { LocalProject } from "@/lib/local-projects.ts";
import { openTerminal, resetTerminals, terminals } from "@/lib/pty.ts";
import { TerminalScreen } from "@/screens/terminal-screen.tsx";
import { terms } from "@/test-fake-xterm.ts";

vi.mock("@xterm/xterm", () => import("@/test-fake-xterm.ts"));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

type Call = { command: string; args?: Record<string, unknown> | undefined };

const entry = (name: string, folder: string, exists = true): LocalProject => ({
  projectId: "",
  name,
  folder,
  fullPermission: false,
  exists,
  isGit: true,
});

function fakeTauri() {
  const calls: Call[] = [];
  let ptys = 0;
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    local_projects: () => ({
      path: "/x/projects.json",
      exists: true,
      imported: 0,
      projects: [entry("shop", "/Users/ha/shop"), entry("gone", "/Users/ha/gone", false)],
    }),
    cli_profiles: () => ({ path: "/x/worker.yaml", accounts: [] }),
    pty_open: () => `pty-${++ptys}`,
    pty_write: () => null,
    pty_resize: () => null,
    pty_close: () => null,
    "plugin:dialog|open": () => "/Users/ha/other",
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

describe("TerminalScreen", () => {
  beforeEach(() => {
    setLang("vi");
    resetTerminals();
    terms.length = 0;
  });

  it("liệt kê dự án còn thư mục và thư mục đang có tab", async () => {
    fakeTauri();
    openTerminal({ cli: "shell", planId: null, bypass: false, folder: "/tmp/scratch", label: "Shell" });
    render(<TerminalScreen />);
    const list = screen.getByRole("navigation", { name: "Dự án" });
    expect(await within(list).findByRole("button", { name: /shop/ })).toBeTruthy();
    expect(within(list).queryByRole("button", { name: /gone/ })).toBeNull();
    expect(within(list).getByRole("button", { name: /scratch.*1 tab/ })).toBeTruthy();
  });

  it("chọn dự án thì hiện terminal của dự án; Thư mục khác mở bộ chọn thư mục", async () => {
    const calls = fakeTauri();
    const user = userEvent.setup();
    render(<TerminalScreen />);
    expect(screen.getByText("Chọn một dự án bên trái để mở terminal trong thư mục của nó.")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: /shop/ }));
    expect(terminals().folder).toBe("/Users/ha/shop");
    expect(screen.getByText(/Mở terminal để chạy Claude Code, Codex, Antigravity hay shell/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Thư mục khác…" }));
    await waitFor(() => expect(terminals().folder).toBe("/Users/ha/other"));
    expect(calls.some((c) => c.command === "plugin:dialog|open")).toBe(true);
  });

  it("tab còn nguyên khi rời màn rồi quay lại, không mở PTY mới", async () => {
    const calls = fakeTauri();
    const user = userEvent.setup();
    const first = render(<TerminalScreen />);
    await user.click(await screen.findByRole("button", { name: /shop/ }));
    await user.click(screen.getAllByRole("button", { name: "Mở terminal" })[0] as HTMLElement);
    await waitFor(() => expect(calls.filter((c) => c.command === "pty_open")).toHaveLength(1));
    first.unmount();
    render(<TerminalScreen />);
    expect(await screen.findByRole("tab", { name: /Claude Code/ })).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Dự án" })).getByRole("button", { name: /shop.*1 tab/ }))
      .toBeTruthy();
    expect(calls.filter((c) => c.command === "pty_open")).toHaveLength(1);
    expect(calls.some((c) => c.command === "pty_close")).toBe(false);
  });
});
