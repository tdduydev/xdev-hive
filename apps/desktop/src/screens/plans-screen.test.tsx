import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopProfiles } from "@/lib/claude-desktop.ts";
import { saveFolder } from "@/lib/folder.ts";
import { setLang } from "@/lib/i18n.ts";
import {
  cliBlocks,
  cliSummary,
  clock,
  type FoundLogin,
  machineSummary,
  meterTone,
  type Plan,
  planRows,
  planState,
  reloginOf,
} from "@/lib/plans.ts";
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

/**
 * `found` undefined: worker cũ không có lệnh `accounts discover` (lệnh lỗi như sidecar thật). `desktop` undefined: lệnh
 * Claude Desktop lỗi như ngoài macOS và Windows, màn không hiện dòng Claude Desktop.
 */
function fakeTauri(list = seed(), found?: FoundLogin[], desktop?: DesktopProfiles) {
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
    ...(desktop && { claude_desktop_profiles: () => desktop }),
    ...(found && {
      cli_profile_discover: () => ({ found }),
      cli_profile_discover_add: ({ cli, configDir }: Record<string, unknown>) => {
        const i = found.findIndex((f) => f.cli === cli && f.configDir === configDir);
        const f = found.splice(i, 1)[0] as FoundLogin;
        list = [
          ...list,
          { ...base, id: f.suggestedId, label: f.suggestedId, cli: f.cli, ...(f.email && { email: f.email }) },
        ];
        return reply();
      },
    }),
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
const block = (cli: string) => document.querySelector(`[data-cli="${cli}"]`) as HTMLElement;
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

  it("gom theo CLI và tính quota còn lại của từng CLI", () => {
    const blocks = cliBlocks(seed(), NOW);
    expect(blocks.map((b) => [b.cli, b.on.map((p) => p.id), b.off.map((p) => p.id)])).toEqual([
      ["claude", ["claude-1", "claude-2"], ["claude-3"]],
      ["codex", ["codex-2", "codex-1"], []],
    ]);
    // CLI lạ xếp sau ba CLI đã biết.
    expect(cliBlocks([{ ...base, id: "g", label: "g", cli: "gemini" }, ...seed()], NOW).map((b) => b.cli)).toEqual([
      "claude",
      "codex",
      "gemini",
    ]);
    const [claude, codex] = cliSummary(seed(), NOW) as [
      ReturnType<typeof cliSummary>[number],
      ReturnType<typeof cliSummary>[number],
    ];
    expect(claude).toMatchObject({
      cli: "claude",
      plans: 3,
      session: { lowest: 3, average: 31 },
      reset: { at: at(90) },
    });
    // Gói chỉ có phiên thì tuần tính trên các gói có số.
    expect(claude.week).toEqual({ lowest: 11, average: 11 });
    expect(codex).toMatchObject({ cli: "codex", plans: 2, session: null, week: null, reset: null });
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
    const summary = screen.getByRole("region", { name: "Cả máy" });
    expect(summary.textContent).toContain("trên 4 gói đang bật");
    expect(summary.textContent).toContain(`reset sớm nhất: Gói phụ · ${clock(at(90), NOW, "vi")}`);
    expect(screen.getByText(`cập nhật lúc ${clock(at(-3), NOW, "vi")}`)).toBeTruthy();

    expect(screen.queryByText("Gói cũ")).toBeNull();
    await user().click(within(block("claude")).getByRole("button", { name: "1 gói đang tắt" }));
    expect(within(row("claude-3")).getByText("Tắt")).toBeTruthy();
    expect(within(row("claude-3")).getByRole("button", { name: "Bật gói Gói cũ" })).toBeTruthy();
  });

  it("chỉ thẻ gói Claude có dòng Claude Desktop; gói đang dùng có nhãn, bản sao lưu hiện ở khung chung", async () => {
    const profile = (id: string, label: string) => ({
      id,
      label,
      email: null,
      saved: id === "claude-1",
      active: id === "claude-1",
      accountKnown: true,
    });
    const desktop = {
      supported: true,
      app: "/Applications/Claude.app",
      note: null,
      running: 501,
      backup: "/u/.xdev-hive/claude-desktop/backup-20261015-010203",
      legacy: [],
      profiles: [profile("claude-1", "Duy Max"), profile("claude-2", "Gói phụ")],
      signedIn: { account: "uuid-1", email: null, plan: "claude-1" },
      mismatch: null,
    };
    fakeTauri(seed(), undefined, desktop);
    render(<PlansScreen />);
    await waitFor(() => expect(row("claude-1").querySelector("[data-claude-desktop]")).not.toBeNull());
    expect(within(row("claude-1")).getByText("Đang dùng")).toBeTruthy();
    expect(within(row("claude-1")).queryByRole("button", { name: "Chuyển Claude Desktop sang gói này" })).toBeNull();
    expect(within(row("claude-2")).getByRole("button", { name: "Chuyển Claude Desktop sang gói này" })).toBeTruthy();
    expect(row("codex-1").querySelector("[data-claude-desktop]")).toBeNull();
    const panel = screen.getByRole("region", { name: "Claude Desktop" });
    expect(within(panel).getByText(desktop.backup)).toBeTruthy();
    expect(within(panel).getByText(/Claude Desktop đang đăng nhập uuid-1/).textContent).toContain("của Duy Max");
    expect(within(panel).getByRole("button", { name: "Khôi phục như ban đầu" })).toBeTruthy();
  });

  it("ngoài macOS và Windows không có dòng Claude Desktop", async () => {
    fakeTauri(seed(), undefined, {
      supported: false,
      app: null,
      note: "Chưa hỗ trợ",
      running: null,
      backup: null,
      legacy: [],
      profiles: [],
      signedIn: null,
      mismatch: null,
    });
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(document.querySelector("[data-claude-desktop]")).toBeNull();
    expect(screen.queryByRole("region", { name: "Claude Desktop" })).toBeNull();
  });

  it("nhóm theo CLI: tiêu đề, số gói, nút Thêm gói của từng CLI và ô tổng từng CLI", async () => {
    fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const claude = block("claude");
    expect(within(claude).getByRole("heading", { name: "Claude Code" })).toBeTruthy();
    expect(within(claude).getByText("3 gói")).toBeTruthy();
    expect(within(claude).getAllByRole("listitem")).toHaveLength(2);
    expect(row("claude-1").closest("[data-cli]")).toBe(claude);
    expect(row("codex-1").closest("[data-cli]")).toBe(block("codex"));
    expect(within(block("codex")).getByText("2 gói")).toBeTruthy();
    expect(within(claude).getByRole("button", { name: "Thêm gói Claude Code" })).toBeTruthy();
    expect(within(block("codex")).getByRole("button", { name: "Thêm gói Codex" })).toBeTruthy();
    expect(block("antigravity")).toBeNull();

    // Ô tổng: phiên còn thấp nhất 3% (gói 97% đã dùng), trung bình 31%; tuần chỉ có một gói còn 11%.
    const total = document.querySelector('[data-cli-summary="claude"]') as HTMLElement;
    expect(total.textContent).toContain("Phiên còn thấp nhất 3% · TB 31%");
    expect(total.textContent).toContain("Tuần còn thấp nhất 11% · TB 11%");
    expect(total.textContent).toContain(`reset sớm nhất ${clock(at(90), NOW, "vi")}`);
    const codex = document.querySelector('[data-cli-summary="codex"]') as HTMLElement;
    expect(codex.textContent).toContain("Phiên còn Chưa biết");
  });

  it("thẻ Claude có dòng tuần theo model khi worker trả `models`", async () => {
    const list = seed();
    const first = list[0] as Plan;
    first.usage = {
      ...(first.usage as NonNullable<Plan["usage"]>),
      models: [
        { name: "Sonnet", percent: 12, resetsAt: at(1440) },
        { name: "Opus", percent: 71.4, resetsAt: null },
      ],
    };
    fakeTauri(list);
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const r = row("claude-1");
    expect(within(r).getByText("Tuần theo model")).toBeTruthy();
    expect(within(r).getByRole("meter", { name: "Tuần Sonnet: Duy Max" }).getAttribute("aria-valuenow")).toBe("12");
    expect(within(r).getByRole("meter", { name: "Tuần Opus: Duy Max" }).getAttribute("aria-valuenow")).toBe("71");
    // Worker cũ không có `models`: không có khối model.
    expect(within(row("claude-2")).queryByText("Tuần theo model")).toBeNull();
  });

  it("thẻ Antigravity hiện từng nhóm; nhóm tắt phiên ghi rõ", async () => {
    const agy: Plan = {
      ...base,
      id: "antigravity-1",
      label: "Antigravity chính",
      cli: "antigravity",
      state: "ready",
      usage: {
        session: { percent: 31, resetsAt: at(60) },
        week: { percent: 18, resetsAt: at(2 * 1440) },
        checkedAt: at(-2),
        reason: null,
        groups: [
          {
            name: "Claude and GPT models",
            models: "Claude Sonnet, GPT-OSS",
            session: { percent: 31, resetsAt: at(60) },
            week: { percent: 18, resetsAt: at(2 * 1440) },
          },
          {
            name: "Gemini Models",
            models: "Gemini Flash, Gemini Pro",
            session: null,
            week: { percent: 8, resetsAt: null },
            sessionDisabled: true,
          },
        ],
      },
    };
    fakeTauri([...seed(), agy]);
    render(<PlansScreen />);
    await screen.findByText("Antigravity chính");
    const section = block("antigravity");
    expect(within(section).getByRole("heading", { name: "Antigravity" })).toBeTruthy();
    // Antigravity không đăng nhập từ app: nút ở khối chỉ mở hướng dẫn rồi tìm trên máy.
    expect(within(section).getByRole("button", { name: "Thêm gói Antigravity" })).toBeTruthy();
    const r = row("antigravity-1");
    const first = r.querySelector('[data-group="Claude and GPT models"]') as HTMLElement;
    expect(first.textContent).toContain("Claude Sonnet, GPT-OSS");
    expect(
      within(first)
        .getByRole("meter", { name: "Claude and GPT models · Phiên 5 giờ: Antigravity chính" })
        .getAttribute("aria-valuenow"),
    ).toBe("31");
    const off = r.querySelector('[data-group="Gemini Models"]') as HTMLElement;
    expect(within(off).getByText("Phiên 5 giờ của nhóm này đang tắt")).toBeTruthy();
    expect(within(off).queryByRole("meter", { name: /Phiên 5 giờ/ })).toBeNull();
    expect(
      within(off).getByRole("meter", { name: "Gemini Models · Tuần: Antigravity chính" }).getAttribute("aria-valuenow"),
    ).toBe("8");
    // Ô tổng có thêm cột Antigravity.
    expect((document.querySelector('[data-cli-summary="antigravity"]') as HTMLElement).textContent).toContain(
      "Phiên còn thấp nhất 69%",
    );
  });

  it("dòng gói: nhãn, CLI và id, email, chip trạng thái, thanh % và vạch ngưỡng", async () => {
    fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const r = row("claude-1");
    expect(r.textContent).toContain("claude-1");
    expect(r.textContent).toContain("ưu tiên 0 · 1/2 run");
    // Trạng thái có ký hiệu đi kèm chữ, không chỉ màu.
    expect(within(r).getByText("Đang chạy").querySelector("svg")).toBeTruthy();
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
    expect(within(row("codex-1")).getByText("CLI không báo")).toBeTruthy();

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
    // Đang đọc quota thì nút ⋯ của mọi dòng bị khoá (disabled), click lúc đó không mở menu; chờ đọc xong.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Đọc lại quota" }).getAttribute("aria-busy")).toBe("false"),
    );
    await u.click(screen.getByRole("button", { name: "Thao tác cho Codex chính" }));
    await u.click(await screen.findByRole("menuitem", { name: "Tắt" }));
    expect(sent(calls, "cli_profile_set")).toEqual([{ id: "codex-1", enabled: false }]);
    expect(await within(block("codex")).findByRole("button", { name: "1 gói đang tắt" })).toBeTruthy();
    expect(within(block("claude")).getByRole("button", { name: "1 gói đang tắt" })).toBeTruthy();
  });

  it("Đọc lại quota thay số của đúng từng gói, báo đang đọc rồi báo xong", async () => {
    fakeTauri();
    const invoke = window.__TAURI__?.core.invoke;
    let finish: () => void = () => {};
    window.__TAURI__ = {
      core: {
        invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
          if (command !== "cli_profile_usage") return invoke?.<T>(command, args) as Promise<T>;
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          const usage = (session: number, week: number) => ({
            session: { percent: session, resetsAt: at(60) },
            week: { percent: week, resetsAt: at(2 * 1440) },
            checkedAt: at(0),
            reason: null,
          });
          const fresh: Record<string, Plan["usage"]> = { "claude-1": usage(0, 82), "claude-2": usage(47, 8) };
          return {
            path: "/x/accounts.json",
            accounts: seed().map((p) => (fresh[p.id] ? { ...p, usage: fresh[p.id] } : p)),
          } as T;
        },
      },
    };
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    await user().click(screen.getByRole("button", { name: "Đọc lại quota" }));
    expect(screen.getByRole("button", { name: "Đang đọc quota…" }).getAttribute("aria-busy")).toBe("true");
    act(() => finish());
    expect((await screen.findByRole("status")).textContent).toBe("Đã đọc lại quota của 5 gói.");
    const meter = (id: string, name: string) =>
      within(row(id)).getByRole("meter", { name }).getAttribute("aria-valuenow");
    expect([meter("claude-1", "Phiên 5 giờ: Duy Max"), meter("claude-1", "Tuần: Duy Max")]).toEqual(["0", "82"]);
    expect([meter("claude-2", "Phiên 5 giờ: Gói phụ"), meter("claude-2", "Tuần: Gói phụ")]).toEqual(["47", "8"]);
    expect(screen.getByRole("button", { name: "Đọc lại quota" }).getAttribute("aria-busy")).toBe("false");
  });

  it("hai gói cùng một tài khoản thì mỗi thẻ ghi gói trùng với nó", async () => {
    const list = seed();
    list.push({ ...base, id: "claude-4", label: "Gói trùng", cli: "claude", email: "DUY@fpt.com ", state: "ready" });
    // Cùng email nhưng khác CLI thì không phải cùng tài khoản.
    list.push({ ...base, id: "codex-5", label: "Codex Duy", cli: "codex", email: "duy@fpt.com", state: "ready" });
    fakeTauri(list);
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    expect(within(row("claude-1")).getByRole("note").textContent).toBe(
      "Gói này trùng tài khoản với claude-4: các gói dùng chung một quota.",
    );
    expect(within(row("claude-4")).getByRole("note").textContent).toContain("trùng tài khoản với claude-1");
    expect(within(row("codex-5")).queryByRole("note")).toBeNull();
    expect(within(row("claude-2")).queryByRole("note")).toBeNull();
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
    // Bước 1: chọn CLI bằng thẻ, chưa có cách đăng nhập.
    expect(within(dialog).getByText("Bước 1/2: chọn CLI.")).toBeTruthy();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Antigravity" })).toBeTruthy();

    await u.click(within(dialog).getByRole("button", { name: "Codex" }));
    const ways = () =>
      within(dialog)
        .getAllByRole("radio")
        .map((r) => r.closest("div")?.textContent ?? "");
    expect(ways()).toHaveLength(2);
    expect(within(dialog).getByRole("radio", { name: "Trình duyệt trên máy này" })).toBeTruthy();
    expect(within(dialog).getByRole("radio", { name: "Mã thiết bị (đăng nhập ở máy khác)" })).toBeTruthy();
    expect(within(dialog).queryByLabelText("Email (tuỳ chọn)")).toBeNull();
    await u.click(within(dialog).getByRole("button", { name: "Đổi CLI" }));
    await u.click(within(dialog).getByRole("button", { name: "Claude Code" }));
    expect(within(dialog).getByText(/^Bước 2\/2/)).toBeTruthy();
    expect(within(dialog).getAllByRole("radio")).toHaveLength(3);
    expect(
      (within(dialog).getByRole("radio", { name: "Gói Claude (Pro, Max, Team)" }) as HTMLInputElement).checked,
    ).toBe(true);

    await u.type(within(dialog).getByLabelText("Tên hiển thị"), "Gói công ty");
    await u.click(within(dialog).getByRole("radio", { name: "SSO của công ty" }));
    await u.type(within(dialog).getByLabelText("Email (tuỳ chọn)"), "duy@fpt.com");
    await u.click(within(dialog).getByRole("button", { name: "Thêm và đăng nhập" }));

    expect(sent(fake.calls, "cli_profile_add")).toEqual([
      { cli: "claude", label: "Gói công ty", how: "sso", email: "duy@fpt.com" },
    ]);
    // Terminal chỉ mở sau khi cli_profile_add trả về lệnh đăng nhập.
    await waitFor(() =>
      expect(sent(fake.calls, "open_login_terminal")).toEqual([
        {
          command: "claude auth login --sso --email duy@fpt.com",
          env: { CLAUDE_CONFIG_DIR: "~/.xdev-hive/accounts/claude-9" },
        },
      ]),
    );
    expect((await screen.findByRole("status")).textContent).toContain("Đã mở Terminal để đăng nhập claude-9");
    await waitFor(() => expect(within(row("claude-9")).getByText(/Đang chờ đăng nhập xong/)).toBeTruthy());

    const reads = () => sent(fake.calls, "cli_profiles").length;
    const before = reads();
    await act(() => vi.advanceTimersByTimeAsync(LOGIN_POLL_MS));
    expect(reads()).toBe(before + 1);
    fake.signIn("claude-9");
    await act(() => vi.advanceTimersByTimeAsync(LOGIN_POLL_MS));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("claude-9 đã đăng nhập moi@fpt.com."));
    const after = reads();
    await act(() => vi.advanceTimersByTimeAsync(LOGIN_POLL_MS * 3));
    expect(reads()).toBe(after);
  });

  it("Thêm gói để trống tên thì dùng tên mặc định; Codex không gửi email", async () => {
    const { calls } = fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const u = user();
    await u.click(within(block("codex")).getByRole("button", { name: "Thêm gói Codex" }));
    // Mở từ nút của khối: CLI chọn sẵn, vào thẳng bước 2.
    const dialog = await screen.findByRole("dialog", { name: "Thêm gói" });
    expect(within(dialog).getByText(/^Bước 2\/2/)).toBeTruthy();
    await u.click(within(dialog).getByRole("radio", { name: "Mã thiết bị (đăng nhập ở máy khác)" }));
    await u.click(within(dialog).getByRole("button", { name: "Thêm và đăng nhập" }));
    expect(sent(calls, "cli_profile_add")).toEqual([{ cli: "codex", label: "Codex 3", how: "device", email: null }]);
  });

  it("nút Thêm gói Claude Code mở hộp với Claude Code chọn sẵn", async () => {
    fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    await user().click(within(block("claude")).getByRole("button", { name: "Thêm gói Claude Code" }));
    const dialog = await screen.findByRole("dialog", { name: "Thêm gói" });
    expect(within(dialog).getByText("Claude Code")).toBeTruthy();
    expect(within(dialog).getByLabelText("Email (tuỳ chọn)")).toBeTruthy();
    expect(within(dialog).getAllByRole("radio")).toHaveLength(3);
  });

  it("Dùng tiếp và Bật/Tắt cũng có trong menu ⋯", async () => {
    const { calls } = fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const u = user();
    await u.click(screen.getByRole("button", { name: "Thao tác cho Gói phụ" }));
    await u.click(await screen.findByRole("menuitem", { name: "Dùng tiếp" }));
    expect(sent(calls, "cli_profile_resume")).toEqual([{ id: "claude-2" }]);
    // Gói đang chạy bình thường không có Dùng tiếp.
    await u.click(screen.getByRole("button", { name: "Thao tác cho Duy Max" }));
    expect(await screen.findByRole("menuitem", { name: "Tắt" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Dùng tiếp" })).toBeNull();
  });

  describe("tìm đăng nhập trên máy", () => {
    const found: FoundLogin[] = [
      {
        cli: "claude",
        configDir: "~/.xdev-hive/accounts/claude-8",
        loggedIn: true,
        email: "hoa@fpt.com",
        suggestedId: "claude-8",
        note: null,
      },
      {
        cli: "codex",
        configDir: null,
        loggedIn: true,
        email: "duy@fpt.com",
        suggestedId: "codex-3",
        note: "Trùng email với codex-1",
      },
    ];

    it("có kết quả thì hiện băng; tích chọn rồi Thêm gọi discover add cho từng đăng nhập", async () => {
      const { calls } = fakeTauri(seed(), structuredClone(found));
      render(<PlansScreen />);
      await screen.findByText("Duy Max");
      const banner = await screen.findByRole("region", { name: "Tìm thấy 2 đăng nhập chưa thêm" });
      expect(sent(calls, "cli_profile_discover")).toHaveLength(1);
      const u = user();
      await u.click(within(banner).getByRole("button", { name: "Xem và thêm" }));
      const dialog = await screen.findByRole("dialog", { name: "Tìm thấy 2 đăng nhập chưa thêm" });
      // Đăng nhập nghi trùng (có ghi chú) mặc định không tích.
      const boxes = within(dialog).getAllByRole("checkbox") as HTMLInputElement[];
      expect(boxes.map((b) => b.checked)).toEqual([true, false]);
      expect(within(dialog).getByText("Trùng email với codex-1")).toBeTruthy();
      expect(within(dialog).getByText("Đăng nhập mặc định của Codex")).toBeTruthy();
      await u.click(boxes[1] as HTMLInputElement);
      await u.click(within(dialog).getByRole("button", { name: "Thêm 2 gói" }));

      // Hai đăng nhập được thêm lần lượt, cái sau chỉ gửi khi cái trước xong.
      await waitFor(() =>
        expect(sent(calls, "cli_profile_discover_add")).toEqual([
          { cli: "claude", configDir: "~/.xdev-hive/accounts/claude-8", label: null },
          { cli: "codex", configDir: null, label: null },
        ]),
      );
      expect((await screen.findByRole("status")).textContent).toBe("Đã thêm 2 gói từ đăng nhập có sẵn trên máy.");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(row("claude-8")).toBeTruthy());
      await waitFor(() => expect(row("codex-3")).toBeTruthy());
      // Thêm xong thì tìm lại: không còn gì thì băng biến mất.
      await waitFor(() => expect(screen.queryByRole("region", { name: /Tìm thấy/ })).toBeNull());
    });

    it("không có lệnh discover (worker cũ) thì ẩn im lặng, không báo lỗi", async () => {
      const { calls } = fakeTauri();
      render(<PlansScreen />);
      await screen.findByText("Duy Max");
      await waitFor(() => expect(sent(calls, "cli_profile_discover")).toHaveLength(1));
      expect(screen.queryByRole("region", { name: /Tìm thấy/ })).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("không có đăng nhập nào lạ thì không có băng", async () => {
      fakeTauri(seed(), []);
      render(<PlansScreen />);
      await screen.findByText("Duy Max");
      expect(screen.queryByRole("region", { name: /Tìm thấy/ })).toBeNull();
    });

    const agy: FoundLogin = {
      cli: "antigravity",
      configDir: null,
      loggedIn: null,
      email: null,
      suggestedId: "antigravity-1",
      note: "Antigravity giữ đăng nhập trong keyring, worker không kiểm được",
    };

    it("Thêm gói Antigravity: hướng dẫn, ghi giới hạn một tài khoản/máy, rồi mở hộp tìm đăng nhập", async () => {
      const { calls } = fakeTauri(seed(), [structuredClone(agy)]);
      render(<PlansScreen />);
      await screen.findByText("Duy Max");
      const u = user();
      await u.click(screen.getByRole("button", { name: "Thêm gói" }));
      const dialog = await screen.findByRole("dialog", { name: "Thêm gói" });
      await u.click(within(dialog).getByRole("button", { name: "Antigravity" }));
      expect(within(dialog).getByText(/Mở ứng dụng Antigravity và đăng nhập/)).toBeTruthy();
      expect(within(dialog).getByText(/mỗi máy chỉ có một gói Antigravity/)).toBeTruthy();
      // Không có form đăng nhập: Antigravity không có thư mục đăng nhập riêng.
      expect(within(dialog).queryByRole("radio")).toBeNull();
      expect(within(dialog).queryByRole("button", { name: "Thêm và đăng nhập" })).toBeNull();

      await u.click(within(dialog).getByRole("button", { name: "Tìm đăng nhập trên máy" }));
      const found = await screen.findByRole("dialog", { name: "Tìm thấy 1 đăng nhập chưa thêm" });
      expect(within(found).getByText("Đăng nhập mặc định của Antigravity")).toBeTruthy();
      expect(sent(calls, "cli_profile_discover").length).toBeGreaterThanOrEqual(2);
    });

    it("Tìm đăng nhập Antigravity mà không thấy thì báo rõ lý do", async () => {
      fakeTauri(seed(), []);
      render(<PlansScreen />);
      await screen.findByText("Duy Max");
      const u = user();
      await u.click(screen.getByRole("button", { name: "Thêm gói" }));
      const dialog = await screen.findByRole("dialog", { name: "Thêm gói" });
      await u.click(within(dialog).getByRole("button", { name: "Antigravity" }));
      await u.click(within(dialog).getByRole("button", { name: "Tìm đăng nhập trên máy" }));
      expect((await screen.findByRole("status")).textContent).toMatch(/Chưa thấy đăng nhập Antigravity nào chưa thêm/);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("Ẩn đóng băng", async () => {
      fakeTauri(seed(), structuredClone(found));
      render(<PlansScreen />);
      const banner = await screen.findByRole("region", { name: "Tìm thấy 2 đăng nhập chưa thêm" });
      await user().click(within(banner).getByRole("button", { name: "Ẩn" }));
      expect(screen.queryByRole("region", { name: /Tìm thấy/ })).toBeNull();
    });
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
    expect(sent(calls, "open_cli_terminal")).toEqual([{ id: "claude-2", folder: null, bypass: false }]);
    expect((await screen.findByRole("status")).textContent).toBe("Đã mở Terminal chạy CLI của claude-2.");

    act(() => saveFolder("/Users/duy/Work/payment-api"));
    await u.click(screen.getByRole("button", { name: "Thao tác cho Codex mới" }));
    const item = await screen.findByRole("menuitem", { name: /^Mở CLIMở trong/ });
    expect(within(item).getByText("Mở trong ~/Work/payment-api")).toBeTruthy();
    await u.click(item);
    // Gói chưa đăng nhập vẫn mở được: CLI tự đòi đăng nhập.
    expect(sent(calls, "open_cli_terminal")).toEqual([
      { id: "claude-2", folder: null, bypass: false },
      { id: "codex-2", folder: "/Users/duy/Work/payment-api", bypass: false },
    ]);
  });

  it("Mở CLI bỏ hỏi quyền: hỏi xác nhận nêu cờ của CLI, huỷ thì không mở, đồng ý thì gửi bypass", async () => {
    const { calls } = fakeTauri();
    render(<PlansScreen />);
    await screen.findByText("Duy Max");
    const u = user();
    await u.click(screen.getByRole("button", { name: "Thao tác cho Codex mới" }));
    await u.click(await screen.findByRole("menuitem", { name: "Mở CLI (bỏ hỏi quyền)" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("--dangerously-bypass-approvals-and-sandbox");
    await u.click(within(dialog).getByRole("button", { name: "Huỷ" }));
    expect(sent(calls, "open_cli_terminal")).toEqual([]);

    await u.click(screen.getByRole("button", { name: "Thao tác cho Duy Max" }));
    await u.click(await screen.findByRole("menuitem", { name: "Mở CLI (bỏ hỏi quyền)" }));
    const again = await screen.findByRole("dialog");
    expect(again.textContent).toContain("--dangerously-skip-permissions");
    await u.click(within(again).getByRole("button", { name: "Mở, bỏ hỏi quyền" }));
    expect(sent(calls, "open_cli_terminal")).toEqual([{ id: "claude-1", folder: null, bypass: true }]);
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
