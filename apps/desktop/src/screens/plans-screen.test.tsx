import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveFolder } from "@/lib/folder.ts";
import { setLang } from "@/lib/i18n.ts";
import { clock, machineSummary, meterTone, type Plan, planRows, planState, reloginOf } from "@/lib/plans.ts";
import { LOGIN_POLL_MS, PlansScreen } from "@/screens/plans-screen.tsx";

const NOW = Date.parse("2026-10-13T08:00:00Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const base = { priority: 0, maxConcurrent: 1, cooldownMinutes: 60, supported: true, loggedIn: true, enabled: true };

function seed(): Plan[] {
  return [
    {
      ...base,
      id: "claude-1",
      label: "Duy Max",
      cli: "claude",
      email: "duy@fpt.com",
      maxConcurrent: 2,
      active: 1,
      state: "running",
      usage: {
        session: { percent: 42, resetsAt: at(120) },
        week: { percent: 88.6, resetsAt: at(3 * 1440) },
        checkedAt: at(-3),
        reason: null,
      },
    },
    {
      ...base,
      id: "codex-1",
      label: "Codex chính",
      cli: "codex",
      state: "ready",
      usage: { session: null, week: null, checkedAt: at(-5), reason: "CLI không báo" },
    },
    {
      ...base,
      id: "claude-2",
      label: "Gói phụ",
      cli: "claude",
      configDir: "~/.xdev-hive/accounts/claude-2",
      state: "cooling",
      coolUntil: at(90),
      stopAtSession: 80,
      usage: { session: { percent: 97, resetsAt: at(90) }, week: null, checkedAt: at(-10), reason: null },
    },
    { ...base, id: "claude-3", label: "Gói cũ", cli: "claude", enabled: false, state: "disabled" },
    { ...base, id: "codex-2", label: "Codex mới", cli: "codex", loggedIn: false, state: "signedOut" },
  ];
}

type Call = { command: string; args?: Record<string, unknown> };

function fakeTauri(list = seed()) {
  const calls: Call[] = [];
  const reply = () => ({ path: "/x/accounts.json", accounts: list });
  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    cli_profiles: reply,
    cli_profile_usage: reply,
    cli_profile_set: ({ id, enabled }) => {
      list = list.map((p) => {
        if (p.id !== id) return p;
        // Bỏ state để màn tự đoán như với worker cũ, khỏi giả lại thứ tự ưu tiên.
        const { state: _, ...rest } = p;
        return { ...rest, enabled: Boolean(enabled) };
      });
      return reply();
    },
    cli_profile_resume: ({ id }) => {
      list = list.map((p) => (p.id === id ? { ...p, state: "ready", coolUntil: null, resumeUntil: at(90) } : p));
      return reply();
    },
    cli_profile_remove: ({ id }) => {
      list = list.filter((p) => p.id !== id);
      return reply();
    },
    cli_profile_update: ({ id, patch }) => {
      list = list.map((p) => (p.id === id ? { ...p, ...(patch as Partial<Plan>) } : p));
      return reply();
    },
    cli_profile_add: ({ cli, label }) => {
      const account: Plan = {
        ...base,
        id: `${cli}-9`,
        label: String(label),
        cli: String(cli),
        configDir: `~/.xdev-hive/accounts/${cli}-9`,
        loggedIn: false,
        state: "signedOut",
      };
      list = [...list, account];
      return {
        account,
        loginCommand: "claude auth login --sso --email duy@fpt.com",
        env: { CLAUDE_CONFIG_DIR: account.configDir },
      };
    },
    open_login_terminal: () => null,
    open_cli_terminal: () => null,
  };
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
  return {
    calls,
    signIn: (id: string) => {
      list = list.map((p) => (p.id === id ? { ...p, loggedIn: true, state: "ready", email: "moi@fpt.com" } : p));
    },
  };
}

const row = (id: string) => document.querySelector(`[data-plan="${id}"]`) as HTMLElement;
const sent = (calls: Call[], command: string) => calls.filter((c) => c.command === command).map((c) => c.args);

beforeEach(() => {
  setLang("vi");
  saveFolder("");
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

describe("hàm của màn Gói agent", () => {
  it("trạng thái: dùng của worker, worker cũ thì đoán theo thứ tự của app v1", () => {
    const old = { ...base, id: "a", label: "a", cli: "claude" };
    expect(planState({ ...old, state: "near" }, NOW)).toBe("near");
    expect(planState({ ...old, enabled: false, supported: false }, NOW)).toBe("disabled");
    expect(planState({ ...old, supported: false, loggedIn: false }, NOW)).toBe("noCli");
    expect(planState({ ...old, loggedIn: false, active: 1 }, NOW)).toBe("signedOut");
    expect(planState({ ...old, active: 1, coolUntil: at(5) }, NOW)).toBe("running");
    expect(planState({ ...old, coolUntil: at(5) }, NOW)).toBe("cooling");
    expect(planState({ ...old, coolUntil: at(-5) }, NOW)).toBe("ready");
  });

  it("tóm tắt và thứ tự dòng", () => {
    const s = machineSummary(seed(), NOW);
    expect(s).toMatchObject({ enabled: 4, ready: 2, running: 1, slots: 2 });
    expect(s.reset).toEqual({ at: at(90), label: "Gói phụ" });
    const { on, off } = planRows(seed(), NOW);
    expect(on.map((p) => p.id)).toEqual(["codex-2", "claude-1", "codex-1", "claude-2"]);
    expect(off.map((p) => p.id)).toEqual(["claude-3"]);
  });

  it("màu thanh theo ngưỡng dừng, lệnh đăng nhập lại theo thư mục của gói", () => {
    expect(meterTone(70, 90)).toBe("ok");
    expect(meterTone(80, 90)).toBe("near");
    expect(meterTone(90, 90)).toBe("over");
    expect(reloginOf({ ...seed()[2] } as Plan)).toEqual({
      command: "claude auth login",
      env: { CLAUDE_CONFIG_DIR: "~/.xdev-hive/accounts/claude-2" },
    });
    expect(reloginOf({ ...base, id: "codex-1", label: "", cli: "codex" })).toEqual({ command: "codex login", env: {} });
    expect(reloginOf({ ...base, id: "g", label: "", cli: "gemini" })).toBeNull();
  });
});

// userEvent gõ từng ký tự vào nhiều ô; máy CI bận thì vượt 5 giây mặc định.
describe("màn Gói agent", { timeout: 20_000 }, () => {
  it("dải tóm tắt, thời điểm cập nhật và gói tắt gom riêng", async () => {
    fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const summary = screen.getByRole("region", { name: "Gói sẵn sàng" });
    expect(summary.textContent).toContain("trên 4 gói đang bật");
    expect(summary.textContent).toContain(`reset sớm nhất: Gói phụ · ${clock(at(90), NOW, "vi")}`);
    expect(screen.getByText(`cập nhật lúc ${clock(at(-3), NOW, "vi")}`)).toBeTruthy();

    expect(screen.queryByText("Gói cũ")).toBeNull();
    await user().click(screen.getByRole("button", { name: "1 gói đang tắt" }));
    expect(within(row("claude-3")).getByText("Tắt")).toBeTruthy();
  });

  it("dòng gói: nhãn, CLI và id, email, chip trạng thái, thanh % và vạch ngưỡng", async () => {
    fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const r = row("claude-1");
    expect(r.textContent).toContain("Claude Code · claude-1");
    expect(within(r).getByText("duy@fpt.com")).toBeTruthy();
    expect(within(r).getByText("Đang chạy")).toBeTruthy();
    const session = within(r).getByRole("meter", { name: "Phiên 5 giờ: Duy Max" });
    expect(session.getAttribute("aria-valuenow")).toBe("42");
    expect(session.querySelector("[data-stop]")?.getAttribute("data-stop")).toBe("95");
    const week = within(r).getByRole("meter", { name: "Tuần: Duy Max" });
    expect(week.getAttribute("aria-valuenow")).toBe("89");
    expect(week.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("near");
    expect(within(r).getByText(`reset ${clock(at(120), NOW, "vi")}`)).toBeTruthy();

    expect(within(row("codex-1")).getByText("Sẵn sàng")).toBeTruthy();
    expect(within(row("codex-1")).getAllByText("Chưa biết")).toHaveLength(2);
    expect(within(row("codex-1")).getAllByText("CLI không báo")).toHaveLength(2);

    const cooling = row("claude-2");
    expect(within(cooling).getByText("Đang nghỉ", { exact: true })).toBeTruthy();
    const over = within(cooling).getByRole("meter", { name: "Phiên 5 giờ: Gói phụ" });
    expect(over.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("over");
    expect(over.querySelector("[data-stop]")?.getAttribute("data-stop")).toBe("80");

    const signedOut = row("codex-2");
    expect(within(signedOut).getByText("Chưa đăng nhập")).toBeTruthy();
    expect(within(signedOut).getByRole("button", { name: "Đăng nhập" })).toBeTruthy();
  });

  it("chip cho mọi trạng thái của worker", async () => {
    const states = ["noCli", "overLimit", "near"] as const;
    fakeTauri(states.map((state, i) => ({ ...base, id: `claude-${i}`, label: state, cli: "claude", state })));
    render(<PlansScreen />);
    await screen.findByText("noCli");
    expect(within(row("claude-0")).getByText("Chưa có CLI")).toBeTruthy();
    expect(within(row("claude-1")).getByText("Chạm ngưỡng")).toBeTruthy();
    expect(within(row("claude-2")).getByText("Gần ngưỡng")).toBeTruthy();
  });

  it("Đọc lại quota gọi accounts usage; Bật/Tắt gọi accounts set", async () => {
    const { calls } = fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const u = user();
    await u.click(screen.getByRole("button", { name: "Đọc lại quota" }));
    expect(sent(calls, "cli_profile_usage")).toEqual([{ id: null }]);
    await u.click(screen.getByRole("button", { name: "Tắt gói Codex chính" }));
    expect(sent(calls, "cli_profile_set")).toEqual([{ id: "codex-1", enabled: false }]);
    expect(await screen.findByRole("button", { name: "2 gói đang tắt" })).toBeTruthy();
  });

  it("Đang nghỉ tới {giờ} và Dùng tiếp gọi accounts resume", async () => {
    const { calls } = fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const r = row("claude-2");
    expect(within(r).getByText(`Đang nghỉ tới ${clock(at(90), NOW, "vi")}`)).toBeTruthy();
    await user().click(within(r).getByRole("button", { name: "Dùng tiếp Gói phụ" }));
    expect(sent(calls, "cli_profile_resume")).toEqual([{ id: "claude-2" }]);
    expect(await within(row("claude-2")).findByText("Sẵn sàng")).toBeTruthy();
    expect(within(row("claude-2")).queryByRole("button", { name: "Dùng tiếp Gói phụ" })).toBeNull();
  });

  it("Thêm gói gửi đúng tham số, mở Terminal với lệnh đăng nhập và kiểm lại tới khi đăng nhập xong", async () => {
    const fake = fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const u = user();
    await u.click(screen.getByRole("button", { name: "Thêm gói" }));
    const dialog = await screen.findByRole("dialog", { name: "Thêm gói" });
    const how = within(dialog).getByLabelText("Cách đăng nhập");
    expect([...how.querySelectorAll("option")].map((o) => o.value)).toEqual(["plan", "sso", "console"]);

    await u.selectOptions(within(dialog).getByLabelText("CLI"), "codex");
    expect([...how.querySelectorAll("option")].map((o) => o.value)).toEqual(["browser", "device"]);
    expect(within(dialog).queryByLabelText("Email (tuỳ chọn)")).toBeNull();
    await u.selectOptions(within(dialog).getByLabelText("CLI"), "claude");

    await u.type(within(dialog).getByLabelText("Tên hiển thị"), "Gói công ty");
    await u.selectOptions(how, "sso");
    await u.type(within(dialog).getByLabelText("Email (tuỳ chọn)"), "duy@fpt.com");
    await u.click(within(dialog).getByRole("button", { name: "Thêm và đăng nhập" }));

    expect(sent(fake.calls, "cli_profile_add")).toEqual([
      { cli: "claude", label: "Gói công ty", how: "sso", email: "duy@fpt.com" },
    ]);
    expect(sent(fake.calls, "open_login_terminal")).toEqual([
      {
        command: "claude auth login --sso --email duy@fpt.com",
        env: { CLAUDE_CONFIG_DIR: "~/.xdev-hive/accounts/claude-9" },
      },
    ]);
    expect((await screen.findByRole("status")).textContent).toContain("Đã mở Terminal để đăng nhập claude-9");
    expect(await within(row("claude-9")).findByText(/Đang chờ đăng nhập xong/)).toBeTruthy();

    const reads = () => sent(fake.calls, "cli_profiles").length;
    const before = reads();
    await act(() => vi.advanceTimersByTimeAsync(LOGIN_POLL_MS));
    expect(reads()).toBe(before + 1);
    fake.signIn("claude-9");
    await act(() => vi.advanceTimersByTimeAsync(LOGIN_POLL_MS));
    expect(screen.getByRole("status").textContent).toBe("claude-9 đã đăng nhập moi@fpt.com.");
    const after = reads();
    await act(() => vi.advanceTimersByTimeAsync(LOGIN_POLL_MS * 3));
    expect(reads()).toBe(after);
  });

  it("Thêm gói để trống tên thì dùng tên mặc định; Codex không gửi email", async () => {
    const { calls } = fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const u = user();
    await u.click(screen.getByRole("button", { name: "Thêm gói" }));
    const dialog = await screen.findByRole("dialog", { name: "Thêm gói" });
    await u.selectOptions(within(dialog).getByLabelText("CLI"), "codex");
    await u.selectOptions(within(dialog).getByLabelText("Cách đăng nhập"), "device");
    await u.click(within(dialog).getByRole("button", { name: "Thêm và đăng nhập" }));
    expect(sent(calls, "cli_profile_add")).toEqual([{ cli: "codex", label: "Codex 3", how: "device", email: null }]);
  });

  it("Đăng nhập lại từ menu ⋯ mở Terminal với thư mục của gói", async () => {
    const { calls } = fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const u = user();
    await u.click(screen.getByRole("button", { name: "Thao tác cho Gói phụ" }));
    await u.click(await screen.findByRole("menuitem", { name: "Đăng nhập lại" }));
    expect(sent(calls, "open_login_terminal")).toEqual([
      { command: "claude auth login", env: { CLAUDE_CONFIG_DIR: "~/.xdev-hive/accounts/claude-2" } },
    ]);
  });

  it("Mở CLI từ menu ⋯ gửi id gói; có thư mục làm việc thì mở ở đó và ghi dòng phụ", async () => {
    const { calls } = fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const u = user();
    await u.click(screen.getByRole("button", { name: "Thao tác cho Gói phụ" }));
    const plain = await screen.findByRole("menuitem", { name: "Mở CLI" });
    expect(within(plain).queryByText(/Mở trong/)).toBeNull();
    await u.click(plain);
    expect(sent(calls, "open_cli_terminal")).toEqual([{ id: "claude-2", folder: null }]);
    expect((await screen.findByRole("status")).textContent).toBe("Đã mở Terminal chạy CLI của claude-2.");

    act(() => saveFolder("/Users/duy/Work/payment-api"));
    await u.click(screen.getByRole("button", { name: "Thao tác cho Codex mới" }));
    const item = await screen.findByRole("menuitem", { name: /Mở CLI/ });
    expect(within(item).getByText("Mở trong ~/Work/payment-api")).toBeTruthy();
    await u.click(item);
    // Gói chưa đăng nhập vẫn mở được: CLI tự đòi đăng nhập.
    expect(sent(calls, "open_cli_terminal")).toEqual([
      { id: "claude-2", folder: null },
      { id: "codex-2", folder: "/Users/duy/Work/payment-api" },
    ]);
  });

  it("Mở CLI lỗi thì hiện lỗi tiếng Việt", async () => {
    const fake = fakeTauri();
    const invoke = window.__TAURI__?.core?.invoke;
    window.__TAURI__ = {
      core: {
        invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
          if (command === "open_cli_terminal") throw "Thư mục làm việc không có hoặc không phải thư mục: /x";
          return (invoke as (c: string, a?: Record<string, unknown>) => Promise<T>)(command, args);
        },
      },
    };
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const u = user();
    await u.click(screen.getByRole("button", { name: "Thao tác cho Duy Max" }));
    await u.click(await screen.findByRole("menuitem", { name: "Mở CLI" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Thư mục làm việc không có hoặc không phải thư mục: /x",
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(fake.calls.some((c) => c.command === "open_cli_terminal")).toBe(false);
  });

  it("Sửa gửi đúng tham số", async () => {
    const { calls } = fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const u = user();
    await u.click(screen.getByRole("button", { name: "Thao tác cho Duy Max" }));
    await u.click(await screen.findByRole("menuitem", { name: "Sửa" }));
    const dialog = await screen.findByRole("dialog", { name: "Sửa claude-1" });
    const set = async (label: string, value: string) => {
      const input = within(dialog).getByLabelText(label);
      await u.clear(input);
      await u.type(input, value);
    };
    await set("Tên", "Gói Max");
    await set("Ưu tiên", "30");
    await set("Song song tối đa", "3");
    await set("Nghỉ mặc định (phút)", "45");
    await set("Giới hạn mỗi run (phút)", "90");
    await set("Dừng khi phiên đạt (%)", "80");
    await set("Dừng khi tuần đạt (%)", "70");
    await u.click(within(dialog).getByLabelText("Làm task"));
    await u.click(within(dialog).getByRole("button", { name: "Lưu" }));

    expect(sent(calls, "cli_profile_update")).toEqual([
      {
        id: "claude-1",
        patch: {
          label: "Gói Max",
          priority: 30,
          maxConcurrent: 3,
          cooldownMinutes: 45,
          timeoutMinutes: 90,
          stopAtSession: 80,
          stopAtWeek: 70,
          roles: ["plan", "review"],
        },
      },
    ]);
    expect(await screen.findByText("Gói Max")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("form Sửa kiểm khoảng giá trị và vai trò trước khi gửi", async () => {
    const { calls } = fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const u = user();
    await u.click(screen.getByRole("button", { name: "Thao tác cho Duy Max" }));
    await u.click(await screen.findByRole("menuitem", { name: "Sửa" }));
    const dialog = await screen.findByRole("dialog", { name: "Sửa claude-1" });
    const set = async (label: string, value: string) => {
      const input = within(dialog).getByLabelText(label);
      await u.clear(input);
      if (value) await u.type(input, value);
    };
    await set("Tên", "");
    await set("Ưu tiên", "101");
    await set("Song song tối đa", "0");
    await set("Nghỉ mặc định (phút)", "1441");
    await set("Giới hạn mỗi run (phút)", "721");
    await set("Dừng khi phiên đạt (%)", "0");
    await set("Dừng khi tuần đạt (%)", "2.5");
    for (const role of ["Lập kế hoạch", "Làm task", "Review"]) await u.click(within(dialog).getByLabelText(role));
    await u.click(within(dialog).getByRole("button", { name: "Lưu" }));

    for (const msg of [
      "Nhập tên của gói.",
      "Ưu tiên: nhập số nguyên từ 0 đến 100.",
      "Song song tối đa: nhập số nguyên từ 1 đến 8.",
      "Nghỉ mặc định (phút): nhập số nguyên từ 1 đến 1440.",
      "Giới hạn mỗi run (phút): nhập số nguyên từ 1 đến 720.",
      "Dừng khi phiên đạt (%): nhập số nguyên từ 1 đến 100.",
      "Dừng khi tuần đạt (%): nhập số nguyên từ 1 đến 100.",
      "Chọn ít nhất một vai trò.",
    ]) {
      expect(within(dialog).getByText(msg)).toBeTruthy();
    }
    expect(within(dialog).getByLabelText("Ưu tiên").getAttribute("aria-invalid")).toBe("true");
    expect(sent(calls, "cli_profile_update")).toEqual([]);
  });

  it("Xoá hỏi xác nhận; Giữ lại không xoá, Xoá gọi accounts remove", async () => {
    const { calls } = fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const u = user();
    const openRemove = async () => {
      await u.click(screen.getByRole("button", { name: "Thao tác cho Codex chính" }));
      await u.click(await screen.findByRole("menuitem", { name: "Xoá" }));
      return screen.findByRole("dialog", { name: "Xoá gói" });
    };
    let dialog = await openRemove();
    expect(within(dialog).getByText("Xoá gói codex-1? Lịch sử run vẫn giữ.")).toBeTruthy();
    await u.click(within(dialog).getByRole("button", { name: "Giữ lại" }));
    expect(sent(calls, "cli_profile_remove")).toEqual([]);

    dialog = await openRemove();
    await u.click(within(dialog).getByRole("button", { name: "Xoá" }));
    expect(sent(calls, "cli_profile_remove")).toEqual([{ id: "codex-1" }]);
    expect(await screen.findByText(/Đã xoá gói codex-1/)).toBeTruthy();
    expect(row("codex-1")).toBeNull();
  });

  it("lỗi của worker hiện bằng tiếng Việt", async () => {
    fakeTauri();
    const invoke = window.__TAURI__?.core.invoke;
    window.__TAURI__ = {
      core: {
        invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
          if (command === "cli_profile_usage") throw new Error("Không đọc được kết quả của worker: hỏng");
          return invoke?.<T>(command, args) as Promise<T>;
        },
      },
    };
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    await user().click(screen.getByRole("button", { name: "Đọc lại quota" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Không đọc được kết quả của worker");
  });
});
