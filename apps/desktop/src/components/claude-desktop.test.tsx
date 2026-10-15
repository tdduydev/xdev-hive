import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeDesktopPanel,
  ClaudeDesktopRow,
  DESKTOP_POLL_MS,
  useClaudeDesktop,
} from "@/components/claude-desktop.tsx";
import type { DesktopProfile, DesktopProfiles, Switched } from "@/lib/claude-desktop.ts";
import { setLang } from "@/lib/i18n.ts";

function profile(over: Partial<DesktopProfile> = {}): DesktopProfile {
  return {
    id: "claude-2",
    label: "Gói phụ",
    email: "phu@example.com",
    saved: true,
    active: false,
    ...over,
  };
}

function views(profiles: DesktopProfile[], over: Partial<DesktopProfiles> = {}): DesktopProfiles {
  return {
    supported: true,
    app: "/Applications/Claude.app",
    note: null,
    running: 412,
    backup: null,
    legacy: [],
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
const switched = (over: Partial<Switched> = {}): Switched => ({ status: "switched", needsLogin: false, ...over });
const SWITCH = "Chuyển Claude Desktop sang gói này";

beforeEach(() => {
  setLang("vi");
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  delete window.__TAURI__;
});

describe("dòng Claude Desktop của gói", { timeout: 20_000 }, () => {
  it("đang chạy: hỏi trước khi khởi động lại, chuyển xong thì đọc lại", async () => {
    const calls = fakeTauri({ switch_claude_desktop: () => switched() });
    const onChanged = vi.fn();
    const p = profile();
    render(<ClaudeDesktopRow plan="Gói phụ" profile={p} view={views([p])} onChanged={onChanged} />);
    await user().click(screen.getByRole("button", { name: SWITCH }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("sẽ thoát rồi mở lại");
    expect(dialog.textContent).toContain("sessions");
    expect(named(calls, "switch_claude_desktop")).toEqual([]);
    await user().click(within(dialog).getByRole("button", { name: "Khởi động lại và chuyển" }));
    expect(named(calls, "switch_claude_desktop")).toEqual([{ profileId: "claude-2", force: false }]);
    expect((await screen.findByRole("status")).textContent).toBe("Đã chuyển Claude Desktop sang Gói phụ.");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("app đang tắt: chuyển ngay; gói chưa lưu đăng nhập thì nhắc đăng nhập", async () => {
    const calls = fakeTauri({ switch_claude_desktop: () => switched({ needsLogin: true }) });
    const p = profile({ saved: false });
    const other = profile({ id: "claude-1", active: true });
    render(
      <ClaudeDesktopRow plan="Gói phụ" profile={p} view={views([other, p], { running: null })} onChanged={() => {}} />,
    );
    expect(screen.getByText(/Chưa lưu đăng nhập Claude Desktop/)).toBeTruthy();
    // Đã có gói đang dùng: không còn nút ghi nhận đăng nhập hiện tại.
    expect(screen.queryByRole("button", { name: "Claude Desktop đang đăng nhập gói này" })).toBeNull();
    await user().click(screen.getByRole("button", { name: SWITCH }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(named(calls, "switch_claude_desktop")).toEqual([{ profileId: "claude-2", force: false }]);
    expect((await screen.findByRole("status")).textContent).toContain("đăng nhập bằng tài khoản Claude của gói này");
  });

  it("app không chịu thoát: hỏi buộc thoát, đồng ý thì gọi lại với force", async () => {
    let n = 0;
    const calls = fakeTauri({
      switch_claude_desktop: () => (n++ === 0 ? switched({ status: "stillRunning" }) : switched()),
    });
    const p = profile();
    render(<ClaudeDesktopRow plan="Gói phụ" profile={p} view={views([p])} onChanged={() => {}} />);
    await user().click(screen.getByRole("button", { name: SWITCH }));
    await user().click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Khởi động lại và chuyển" }),
    );
    const force = await screen.findByRole("dialog", { name: "Claude Desktop chưa thoát" });
    await user().click(within(force).getByRole("button", { name: "Buộc thoát và chuyển" }));
    expect(named(calls, "switch_claude_desktop")).toEqual([
      { profileId: "claude-2", force: false },
      { profileId: "claude-2", force: true },
    ]);
    expect((await screen.findByRole("status")).textContent).toBe("Đã chuyển Claude Desktop sang Gói phụ.");
  });

  it("gói đang dùng: nhãn Đang dùng, không có nút chuyển hay quên", () => {
    fakeTauri({});
    const p = profile({ active: true });
    render(<ClaudeDesktopRow plan="Gói phụ" profile={p} view={views([p])} onChanged={() => {}} />);
    expect(screen.getByText("Đang dùng")).toBeTruthy();
    expect(screen.queryByRole("button", { name: SWITCH })).toBeNull();
    expect(screen.queryByRole("button", { name: "Quên đăng nhập đã lưu" })).toBeNull();
    // Claude Desktop đang chạy thì không cần nút mở.
    expect(screen.queryByRole("button", { name: "Mở Claude Desktop" })).toBeNull();
  });

  it("chưa có gói đang dùng: ghi nhận đăng nhập hiện tại cho gói", async () => {
    const calls = fakeTauri({ adopt_claude_desktop: () => views([]) });
    const onChanged = vi.fn();
    const p = profile({ saved: false });
    render(<ClaudeDesktopRow plan="Gói phụ" profile={p} view={views([p])} onChanged={onChanged} />);
    await user().click(screen.getByRole("button", { name: "Claude Desktop đang đăng nhập gói này" }));
    expect(named(calls, "adopt_claude_desktop")).toEqual([{ profileId: "claude-2" }]);
    expect((await screen.findByRole("status")).textContent).toContain("Gói phụ");
    expect(onChanged).toHaveBeenCalled();
  });

  it("quên đăng nhập phải xác nhận; lỗi của Rust hiện nguyên văn", async () => {
    const calls = fakeTauri({
      forget_claude_desktop: () => {
        throw "Gói này đang dùng Claude Desktop; chuyển sang gói khác trước.";
      },
    });
    const p = profile();
    render(<ClaudeDesktopRow plan="Gói phụ" profile={p} view={views([p])} onChanged={() => {}} />);
    await user().click(screen.getByRole("button", { name: "Quên đăng nhập đã lưu" }));
    const dialog = await screen.findByRole("dialog");
    expect(named(calls, "forget_claude_desktop")).toEqual([]);
    await user().click(within(dialog).getByRole("button", { name: "Quên đăng nhập đã lưu" }));
    expect(named(calls, "forget_claude_desktop")).toEqual([{ profileId: "claude-2" }]);
    expect((await screen.findByRole("status")).textContent).toContain("chuyển sang gói khác trước");
  });

  it("chưa cài Claude Desktop: nút tắt và ghi lý do", () => {
    fakeTauri({});
    const p = profile({ saved: false });
    const note = "Chưa thấy Claude Desktop trong /Applications hay ~/Applications. Cài Claude Desktop rồi thử lại.";
    render(<ClaudeDesktopRow plan="Gói phụ" profile={p} view={views([p], { app: null, note })} onChanged={() => {}} />);
    expect((screen.getByRole("button", { name: SWITCH }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(note)).toBeTruthy();
  });
});

describe("khung Claude Desktop chung", { timeout: 20_000 }, () => {
  it("không có bản sao lưu hay hồ sơ cũ thì không hiện", () => {
    fakeTauri({});
    const { container } = render(<ClaudeDesktopPanel view={views([])} onChanged={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("khôi phục như ban đầu luôn hỏi trước; mở thư mục sao lưu", async () => {
    const backup = "/Users/a/.xdev-hive/claude-desktop/backup-20261015-010203";
    const calls = fakeTauri({ restore_claude_desktop: () => switched(), open_folder: () => undefined });
    const onChanged = vi.fn();
    render(<ClaudeDesktopPanel view={views([], { backup, running: null })} onChanged={onChanged} />);
    await user().click(screen.getByRole("button", { name: "Mở thư mục" }));
    expect(named(calls, "open_folder")).toEqual([{ folder: backup }]);
    await user().click(screen.getByRole("button", { name: "Khôi phục như ban đầu" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(backup);
    expect(named(calls, "restore_claude_desktop")).toEqual([]);
    await user().click(within(dialog).getByRole("button", { name: "Khôi phục" }));
    expect(named(calls, "restore_claude_desktop")).toEqual([{ force: false }]);
    expect((await screen.findByRole("status")).textContent).toBe("Đã khôi phục đăng nhập Claude Desktop ban đầu.");
    expect(onChanged).toHaveBeenCalled();
  });

  it("hồ sơ riêng kiểu cũ: đổi sang cách mới sau khi xác nhận", async () => {
    const calls = fakeTauri({ migrate_claude_desktop_profiles: () => views([]) });
    render(<ClaudeDesktopPanel view={views([], { legacy: ["claude-1", "claude-2"] })} onChanged={() => {}} />);
    expect(screen.getByText("2 hồ sơ Claude Desktop riêng kiểu cũ")).toBeTruthy();
    await user().click(screen.getByRole("button", { name: "Đổi sang cách mới" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("claude-1, claude-2");
    expect(named(calls, "migrate_claude_desktop_profiles")).toEqual([]);
    await user().click(within(dialog).getByRole("button", { name: "Đổi sang cách mới" }));
    expect(named(calls, "migrate_claude_desktop_profiles")).toEqual([undefined]);
    expect((await screen.findByRole("status")).textContent).toContain("Đã đổi");
  });
});

function Probe() {
  const { view } = useClaudeDesktop();
  return (
    <span data-testid="probe">
      {view ? view.profiles.map((p) => `${p.id}:${p.active ? "on" : "-"}`).join(",") : "none"}
    </span>
  );
}

describe("useClaudeDesktop", () => {
  it("đọc lại định kỳ; lỗi thì không có dữ liệu", async () => {
    let active = false;
    const calls = fakeTauri({ claude_desktop_profiles: () => views([profile({ active })]) });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("claude-2:-"));
    active = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DESKTOP_POLL_MS);
    });
    expect(screen.getByTestId("probe").textContent).toBe("claude-2:on");
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
