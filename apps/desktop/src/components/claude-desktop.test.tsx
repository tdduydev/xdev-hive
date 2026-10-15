import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeDesktopPanel,
  ClaudeDesktopRow,
  DESKTOP_POLL_MS,
  PROGRESS_POLL_MS,
  useClaudeDesktop,
} from "@/components/claude-desktop.tsx";
import type { DesktopProfile, DesktopProfiles, Switched, SwitchProgress } from "@/lib/claude-desktop.ts";
import { setLang } from "@/lib/i18n.ts";

function profile(over: Partial<DesktopProfile> = {}): DesktopProfile {
  return {
    id: "claude-2",
    label: "Gói phụ",
    email: "phu@example.com",
    saved: true,
    active: false,
    accountKnown: true,
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
    signedIn: null,
    mismatch: null,
    switching: null,
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
const progress = (over: Partial<SwitchProgress> = {}): SwitchProgress => ({
  step: "quitting",
  target: "claude-2",
  percent: null,
  elapsed: 3,
  cancelling: false,
  cancellable: true,
  ...over,
});
const tick = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(PROGRESS_POLL_MS);
  });
const CANCELLED = "Đã huỷ chuyển Claude Desktop; đăng nhập giữ như trước.";

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
    expect(screen.getByText(/cần đăng nhập 1 lần/)).toBeTruthy();
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

  it("gói đang dùng chưa lưu đăng nhập: chờ đăng nhập, Hive tự lưu", () => {
    fakeTauri({});
    const p = profile({ saved: false, active: true });
    render(<ClaudeDesktopRow plan="Gói phụ" profile={p} view={views([p])} onChanged={() => {}} />);
    expect(screen.getByText(/Claude Desktop chưa đăng nhập: đăng nhập bằng tài khoản của gói này/)).toBeTruthy();
    expect(screen.queryByText(/cần đăng nhập 1 lần/)).toBeNull();
  });

  it("gói biết tài khoản: đăng nhập tự gắn, không có nút ghi nhận tay", () => {
    fakeTauri({});
    const p = profile({ saved: false });
    const signedIn = { account: "296f5a0d-aaaa", email: null, plan: null };
    render(<ClaudeDesktopRow plan="Gói phụ" profile={p} view={views([p], { signedIn })} onChanged={() => {}} />);
    expect(screen.queryByRole("button", { name: "Claude Desktop đang đăng nhập gói này" })).toBeNull();
  });

  it("gói không biết tài khoản: ghi nhận tay đăng nhập chưa gói nào nhận", async () => {
    const calls = fakeTauri({ adopt_claude_desktop: () => views([]) });
    const onChanged = vi.fn();
    const p = profile({ saved: false, accountKnown: false });
    const signedIn = { account: "296f5a0d-aaaa", email: null, plan: null };
    const { rerender } = render(
      <ClaudeDesktopRow plan="Gói phụ" profile={p} view={views([p])} onChanged={onChanged} />,
    );
    // Claude Desktop chưa đăng nhập thì không có gì để ghi nhận.
    expect(screen.queryByRole("button", { name: "Claude Desktop đang đăng nhập gói này" })).toBeNull();
    rerender(<ClaudeDesktopRow plan="Gói phụ" profile={p} view={views([p], { signedIn })} onChanged={onChanged} />);
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

  it("đang chuyển: hiện từng bước và phần trăm sao lưu; Huỷ thì trả lại đăng nhập cũ", async () => {
    let now: SwitchProgress | null = progress();
    let finish: (e: string) => void = () => {};
    const calls = fakeTauri({
      switch_claude_desktop: () =>
        new Promise((_, reject) => {
          finish = reject;
        }),
      claude_desktop_switch_progress: () => now,
      cancel_claude_desktop_switch: () => {
        now = now && { ...now, cancelling: true };
        return true;
      },
    });
    const p = profile();
    render(<ClaudeDesktopRow plan="Gói phụ" profile={p} view={views([p], { running: null })} onChanged={() => {}} />);
    await user().click(screen.getByRole("button", { name: SWITCH }));
    const line = () => document.querySelector("[data-switch-progress]") as HTMLElement;
    expect(line().textContent).toContain("Đang chuẩn bị chuyển Claude Desktop");
    expect((screen.getByRole("button", { name: SWITCH }) as HTMLButtonElement).disabled).toBe(true);
    await tick();
    expect(line().textContent).toContain("Đang chờ Claude Desktop thoát");
    expect(line().textContent).toContain("3 giây");
    now = progress({ step: "backingUp", percent: 42, elapsed: 30 });
    await tick();
    expect(line().textContent).toContain("Đang sao lưu hồ sơ Claude Desktop (lần đầu) 42%");
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("42");
    await user().click(within(line()).getByRole("button", { name: "Huỷ" }));
    expect(named(calls, "cancel_claude_desktop_switch")).toEqual([undefined]);
    await waitFor(() => expect(line().textContent).toContain("Đang huỷ"));
    expect((within(line()).getByRole("button", { name: "Huỷ" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(CANCELLED));
    expect((await screen.findByRole("status")).textContent).toBe(CANCELLED);
    expect(document.querySelector("[data-switch-progress]")).toBeNull();
    expect((screen.getByRole("button", { name: SWITCH }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("hỏi tiến độ không trả lời: bộ đếm vẫn chạy, không hỏi chồng lên nhau", async () => {
    let asked = 0;
    let answer = true;
    fakeTauri({
      switch_claude_desktop: () => new Promise(() => {}),
      claude_desktop_switch_progress: () => {
        asked += 1;
        return answer ? progress({ elapsed: 8 }) : new Promise(() => {});
      },
    });
    const p = profile();
    render(<ClaudeDesktopRow plan="Gói phụ" profile={p} view={views([p], { running: null })} onChanged={() => {}} />);
    await user().click(screen.getByRole("button", { name: SWITCH }));
    const line = () => document.querySelector("[data-switch-progress]") as HTMLElement;
    await tick();
    expect(line().textContent).toContain("8 giây");
    answer = false;
    const before = asked;
    await tick();
    await tick();
    await tick();
    expect(line().textContent).toMatch(/1[01] giây/);
    expect(asked).toBe(before + 1);
  });

  it("lần chuyển chạy từ chỗ khác: dòng của gói đích hiện tiến độ, các dòng khác tắt nút", async () => {
    let now: SwitchProgress | null = progress({ step: "launching", cancellable: false });
    fakeTauri({ claude_desktop_switch_progress: () => now });
    const onChanged = vi.fn();
    const target = profile();
    const other = profile({ id: "claude-3", label: "Gói ba" });
    const view = views([target, other], { switching: now });
    render(
      <>
        <ClaudeDesktopRow plan="Gói phụ" profile={target} view={view} onChanged={onChanged} />
        <ClaudeDesktopRow plan="Gói ba" profile={other} view={view} onChanged={onChanged} />
      </>,
    );
    const lines = document.querySelectorAll("[data-switch-progress]");
    expect(lines.length).toBe(1);
    expect(lines[0]?.closest("[data-claude-desktop]")?.getAttribute("data-claude-desktop")).toBe("claude-2");
    expect(lines[0]?.textContent).toContain("Đang mở lại Claude Desktop");
    // Đang mở lại app: đã đổi xong, không còn gì để huỷ.
    expect((within(lines[0] as HTMLElement).getByRole("button", { name: "Huỷ" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    for (const b of screen.getAllByRole("button", { name: SWITCH }))
      expect((b as HTMLButtonElement).disabled).toBe(true);
    now = null;
    await tick();
    expect(onChanged).toHaveBeenCalled();
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
  it("chưa có gì: chỉ có nút chép chẩn đoán; chưa hỗ trợ thì không hiện", () => {
    fakeTauri({});
    const { container, rerender } = render(<ClaudeDesktopPanel view={views([])} onChanged={() => {}} />);
    expect(container.textContent).toBe("Chép thông tin chẩn đoán");
    rerender(<ClaudeDesktopPanel view={views([], { supported: false })} onChanged={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("chép thông tin chẩn đoán vào clipboard; lỗi thì báo", async () => {
    const report = "xDev Hive 0.2.17 · windows x86_64\nHồ sơ đang chọn: C:\\Users\\a\\AppData\\Local\\Packages";
    const calls = fakeTauri({ claude_desktop_diagnose: () => report });
    const u = user();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<ClaudeDesktopPanel view={views([])} onChanged={() => {}} />);
    await u.click(screen.getByRole("button", { name: "Chép thông tin chẩn đoán" }));
    expect((await screen.findByRole("status")).textContent).toContain("Đã chép thông tin chẩn đoán");
    expect(named(calls, "claude_desktop_diagnose")).toEqual([undefined]);
    expect(writeText).toHaveBeenCalledWith(report);
    writeText.mockRejectedValueOnce(new Error("denied"));
    await u.click(screen.getByRole("button", { name: "Chép thông tin chẩn đoán" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Không chép được thông tin chẩn đoán vào clipboard."),
    );
    writeText.mockRestore();
  });

  it("đang khôi phục: khung chung hiện tiến độ và Huỷ", async () => {
    const backup = "/Users/a/.xdev-hive/claude-desktop/backup-20261015-010203";
    let finish: (s: Switched) => void = () => {};
    const calls = fakeTauri({
      restore_claude_desktop: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      claude_desktop_switch_progress: () => progress({ step: "swapping", target: null }),
      cancel_claude_desktop_switch: () => true,
    });
    render(<ClaudeDesktopPanel view={views([], { backup, running: null })} onChanged={() => {}} />);
    await user().click(screen.getByRole("button", { name: "Khôi phục như ban đầu" }));
    await user().click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Khôi phục" }));
    await tick();
    const line = document.querySelector("[data-switch-progress]") as HTMLElement;
    expect(line.textContent).toContain("Đang đổi đăng nhập");
    expect((screen.getByRole("button", { name: "Khôi phục như ban đầu" }) as HTMLButtonElement).disabled).toBe(true);
    await user().click(within(line).getByRole("button", { name: "Huỷ" }));
    expect(named(calls, "cancel_claude_desktop_switch")).toEqual([undefined]);
    await act(async () => finish(switched()));
    expect(document.querySelector("[data-switch-progress]")).toBeNull();
  });

  it("hiện tài khoản Claude Desktop đang đăng nhập và gói của nó", () => {
    fakeTauri({});
    const p = profile();
    const { rerender } = render(
      <ClaudeDesktopPanel
        view={views([p], { signedIn: { account: "uuid-b", email: "phu@example.com", plan: "claude-2" } })}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText(/Claude Desktop đang đăng nhập phu@example.com/).textContent).toContain("của Gói phụ");
    rerender(
      <ClaudeDesktopPanel
        view={views([p], { signedIn: { account: "296f5a0d-1111-2222", email: null, plan: null } })}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText(/Claude Desktop đang đăng nhập 296f5a0d…/).textContent).toContain("không thuộc gói nào");
  });

  it("đăng nhập nhầm tài khoản: báo gói nào đã nhận, đóng thông báo", async () => {
    const calls = fakeTauri({ dismiss_claude_desktop_mismatch: () => views([]) });
    const onChanged = vi.fn();
    const main = profile({ id: "claude-1", label: "Gói chính", active: true });
    const third = profile({ id: "claude-3", label: "Gói ba", saved: false });
    render(
      <ClaudeDesktopPanel
        view={views([main, third], {
          mismatch: { account: "chinh@example.com", expected: "claude-3", adopted: "claude-1" },
        })}
        onChanged={onChanged}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Bạn vừa đăng nhập tài khoản chinh@example.com, không phải của Gói ba.");
    expect(alert.textContent).toContain("Hive đã lưu đăng nhập này cho Gói chính");
    await user().click(within(alert).getByRole("button", { name: "Đã hiểu" }));
    expect(named(calls, "dismiss_claude_desktop_mismatch")).toEqual([undefined]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("đăng nhập tài khoản lạ: chưa lưu cho gói nào", () => {
    fakeTauri({});
    const third = profile({ id: "claude-3", label: "Gói ba", saved: false, active: true });
    render(
      <ClaudeDesktopPanel
        view={views([third], { mismatch: { account: "296f5a0d…", expected: "claude-3", adopted: null } })}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "chưa được lưu cho gói nào. Đăng xuất trong Claude Desktop rồi đăng nhập tài khoản của Gói ba.",
    );
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
