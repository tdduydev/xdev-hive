import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeDesktopRow,
  DESKTOP_POLL_MS,
  DESKTOP_SETTLE_MS,
  useClaudeDesktop,
} from "@/components/claude-desktop.tsx";
import { type DesktopProfile, type DesktopProfiles, formatBytes } from "@/lib/claude-desktop.ts";
import { setLang } from "@/lib/i18n.ts";

const MB = 1024 * 1024;

function profile(over: Partial<DesktopProfile> = {}): DesktopProfile {
  return {
    id: "claude-1",
    label: "Duy Max",
    email: "duy@fpt.com",
    dir: "/Users/a/.xdev-hive/claude-desktop/claude-1",
    used: true,
    bytes: 612 * MB,
    cacheBytes: 300 * MB,
    pid: null,
    ...over,
  };
}

function views(profiles: DesktopProfile[], over: Partial<DesktopProfiles> = {}): DesktopProfiles {
  return {
    supported: true,
    app: "/Applications/Claude.app",
    root: "/Users/a/.xdev-hive/claude-desktop",
    note: null,
    profiles,
    ...over,
  };
}

type Call = { command: string; args?: Record<string, unknown> };

function fakeTauri(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: Call[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, ...(args ? { args } : {}) });
        const h = handlers[command];
        if (!h) throw new Error(`lệnh chưa giả: ${command}`);
        return h(args ?? {}) as T;
      },
    },
  };
  return calls;
}

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
const named = (calls: Call[], command: string) => calls.filter((c) => c.command === command).map((c) => c.args);

beforeEach(() => {
  setLang("vi");
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  delete window.__TAURI__;
});

describe("formatBytes", () => {
  it("đơn vị và dấu thập phân theo ngôn ngữ", () => {
    expect(formatBytes(0, "vi")).toBe("0 B");
    expect(formatBytes(812 * 1024, "vi")).toBe("812 KB");
    expect(formatBytes(1.4 * 1024 * MB, "vi")).toBe("1,4 GB");
    expect(formatBytes(1.4 * 1024 * MB, "en")).toBe("1.4 GB");
    expect(formatBytes(-5, "en")).toBe("0 B");
  });
});

describe("dòng Claude Desktop của gói", { timeout: 20_000 }, () => {
  it("lần đầu: nút đăng nhập, mở rồi nhắc Keychain, đọc lại để thấy PID", async () => {
    const calls = fakeTauri({ open_claude_desktop: () => ({ already: false, pid: null }) });
    const onChanged = vi.fn();
    const p = profile({ used: false, bytes: 0, cacheBytes: 0 });
    render(<ClaudeDesktopRow plan="Duy Max" profile={p} view={views([p])} onChanged={onChanged} />);
    expect(screen.queryByRole("button", { name: "Dọn cache" })).toBeNull();
    await user().click(screen.getByRole("button", { name: "Đăng nhập Claude Desktop cho gói này" }));
    expect(named(calls, "open_claude_desktop")).toEqual([{ profileId: "claude-1" }]);
    expect((await screen.findByRole("status")).textContent).toContain("Claude Safe Storage");
    expect(onChanged).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(DESKTOP_SETTLE_MS));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("đã dùng: dung lượng, dọn cache báo số đã giải phóng", async () => {
    const calls = fakeTauri({ claude_desktop_cleanup_cache: () => 300 * MB });
    const onChanged = vi.fn();
    const p = profile();
    render(<ClaudeDesktopRow plan="Duy Max" profile={p} view={views([p])} onChanged={onChanged} />);
    expect(screen.getByRole("button", { name: "Claude Desktop" })).toBeTruthy();
    expect(screen.getByText("Hồ sơ 612 MB · cache 300 MB")).toBeTruthy();
    await user().click(screen.getByRole("button", { name: "Dọn cache" }));
    expect(named(calls, "claude_desktop_cleanup_cache")).toEqual([{ profileId: "claude-1" }]);
    expect((await screen.findByRole("status")).textContent).toBe("Đã dọn 300 MB cache.");
    expect(onChanged).toHaveBeenCalled();
  });

  it("đang mở: hiện nhãn, khoá dọn cache và xoá hồ sơ; mở lại thì báo đang mở", async () => {
    fakeTauri({ open_claude_desktop: () => ({ already: true, pid: 4242 }) });
    const p = profile({ pid: 4242 });
    render(<ClaudeDesktopRow plan="Duy Max" profile={p} view={views([p])} onChanged={() => {}} />);
    expect(screen.getByText("Đang mở").getAttribute("title")).toContain("PID 4242");
    expect((screen.getByRole("button", { name: "Dọn cache" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Xoá hồ sơ" }) as HTMLButtonElement).disabled).toBe(true);
    await user().click(screen.getByRole("button", { name: "Claude Desktop" }));
    expect((await screen.findByRole("status")).textContent).toContain("đang mở");
  });

  it("xoá hồ sơ phải xác nhận; lỗi của Rust hiện nguyên văn", async () => {
    const calls = fakeTauri({
      reset_claude_desktop_profile: () => {
        throw "Claude Desktop của gói này đang mở. Thoát nó (Cmd+Q) rồi thử lại.";
      },
    });
    const p = profile();
    render(<ClaudeDesktopRow plan="Duy Max" profile={p} view={views([p])} onChanged={() => {}} />);
    await user().click(screen.getByRole("button", { name: "Xoá hồ sơ" }));
    const dialog = await screen.findByRole("dialog");
    expect(named(calls, "reset_claude_desktop_profile")).toEqual([]);
    await user().click(within(dialog).getByRole("button", { name: "Xoá hồ sơ" }));
    expect(named(calls, "reset_claude_desktop_profile")).toEqual([{ profileId: "claude-1" }]);
    expect((await screen.findByRole("status")).textContent).toContain("Thoát nó (Cmd+Q)");
  });

  it("chưa cài Claude Desktop: nút tắt và ghi lý do", () => {
    fakeTauri({});
    const p = profile({ used: false });
    const note = "Chưa thấy Claude Desktop trong /Applications hay ~/Applications. Cài Claude Desktop rồi thử lại.";
    render(<ClaudeDesktopRow plan="Duy Max" profile={p} view={views([p], { app: null, note })} onChanged={() => {}} />);
    const button = screen.getByRole("button", { name: "Đăng nhập Claude Desktop cho gói này" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(note)).toBeTruthy();
  });
});

function Probe() {
  const { view } = useClaudeDesktop();
  return (
    <span data-testid="probe">{view ? view.profiles.map((p) => `${p.id}:${p.pid ?? "-"}`).join(",") : "none"}</span>
  );
}

describe("useClaudeDesktop", () => {
  it("đọc lại định kỳ; lỗi thì không có dữ liệu", async () => {
    let pid: number | null = null;
    const calls = fakeTauri({ claude_desktop_profiles: () => views([profile({ pid })]) });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("claude-1:-"));
    pid = 77;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DESKTOP_POLL_MS);
    });
    expect(screen.getByTestId("probe").textContent).toBe("claude-1:77");
    expect(named(calls, "claude_desktop_profiles").length).toBeGreaterThanOrEqual(2);
  });

  it("worker cũ hay ngoài Tauri: none", async () => {
    fakeTauri({});
    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId("probe").textContent).toBe("none");
  });
});
