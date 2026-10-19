import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import { sampleScore } from "@/lib/token-score.fixture.ts";
import {
  type ContextReport,
  cacheRate,
  formatTokens,
  type SessionStats,
  tips,
  type UsageReport,
  usedCategories,
} from "@/lib/usage.ts";
import { TokensScreen } from "@/screens/tokens-screen.tsx";

// Theo đầu ra thật của Claude Code 2.1.296 (/context, /usage) và file phiên Codex 0.162.1 trên máy dev.
const CONTEXT: ContextReport = {
  model: "claude-opus-5-5",
  used: 12_700,
  window: 1_000_000,
  categories: [
    { name: "System prompt", tokens: 2_300 },
    { name: "System tools", tokens: 6_100 },
    { name: "Skills", tokens: 4_300 },
    { name: "Free space", tokens: 954_300 },
    { name: "Autocompact buffer", tokens: 33_000 },
  ],
};
const USAGE: UsageReport = {
  session: { percent: 11, resets: "Oct 12 at 6:50pm (Asia/Saigon)" },
  week: { percent: 70, resets: "Oct 16 at 3am (Asia/Saigon)" },
  drivers: [
    { percent: 94, text: "of your usage was at >150k context" },
    { percent: 92, text: "of your usage came from subagent-heavy sessions" },
  ],
  topSubagents: "fork 33%, general-purpose 2%",
};
const now = new Date().toISOString();
const STATS: SessionStats = {
  totals: { sessions: 2, input: 2_000_000, cached: 1_900_000, output: 30_000 },
  sessions: [
    {
      id: "s1",
      at: now,
      cwd: "/Users/a/Work/payment-api",
      model: "claude-opus-5-5",
      input: 1_500_000,
      cached: 1_450_000,
      output: 20_000,
      contextUsed: null,
      contextWindow: null,
    },
    {
      id: "s2",
      at: now,
      cwd: "/Users/a/Work/payment-api",
      model: "claude-sonnet-5-5",
      input: 500_000,
      cached: 450_000,
      output: 10_000,
      contextUsed: null,
      contextWindow: null,
    },
  ],
  primary: null,
  secondary: null,
};
const CODEX: SessionStats = {
  totals: { sessions: 1, input: 50_000, cached: 20_000, output: 900 },
  sessions: [
    {
      id: "c1",
      at: now,
      cwd: "/w/api",
      model: "gpt-6.1-sol",
      input: 50_000,
      cached: 20_000,
      output: 900,
      contextUsed: 200_000,
      contextWindow: 258_400,
    },
  ],
  primary: { percent: 72, resets: "1791802453" },
  secondary: { percent: 42, resets: "1792305949" },
};

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

const claudeHandlers = {
  claude_context: () => CONTEXT,
  claude_usage: () => USAGE,
  token_score: () => sampleScore(),
  session_stats: (args?: Record<string, unknown>) => (args?.engine === "codex" ? CODEX : STATS),
};

describe("logic AppTokens", () => {
  it("định dạng token, tỉ lệ cache, bỏ Free space khỏi thanh", () => {
    expect(formatTokens(12_700, "en")).toBe("12.7k");
    expect(formatTokens(5_194_645_838, "en")).toBe("5.2B");
    expect(formatTokens(950, "en")).toBe("950");
    expect(cacheRate(2_000_000, 1_900_000)).toBe(95);
    expect(cacheRate(0, 0)).toBeNull();
    expect(usedCategories(CONTEXT).map((c) => c.name)).not.toContain("Free space");
  });

  it("gợi ý chỉ rút từ số liệu có thật", () => {
    expect(tips("claude", USAGE, STATS)).toEqual(["compact", "subagents"]);
    expect(tips("claude", { ...USAGE, drivers: [] }, STATS)).toEqual([]);
    expect(tips("codex", null, CODEX)).toEqual(["cache", "codexCompact"]);
  });
});

describe("TokensScreen", () => {
  beforeEach(() => setLang("vi"));

  it("Claude: ô số liệu, ngữ cảnh theo nhóm, thứ tiêu hạn mức, gợi ý và phiên", async () => {
    const calls = fakeTauri(claudeHandlers);
    render(<TokensScreen />);
    const user = userEvent.setup();
    // Ngữ cảnh, hạn mức và thống kê phiên tải bằng ba lệnh riêng, về không theo thứ tự.
    expect(await screen.findByText("12,7k", { selector: "span.text-2xl" })).toBeTruthy();
    expect(await screen.findByText("95%")).toBeTruthy();
    expect(await screen.findByText("11%")).toBeTruthy();
    expect(await screen.findByText("trên 1M của claude-opus-5-5")).toBeTruthy();
    expect(await screen.findByText("hạn mức tiêu ở mức ngữ cảnh trên 150k")).toBeTruthy();
    // Gợi ý cũ nằm dưới tiêu chí liên quan của điểm; subagent không có tiêu chí riêng nên hiện ở thẻ điểm.
    expect(await screen.findByText("Bớt subagent cho việc nhỏ")).toBeTruthy();
    expect(screen.queryByText("Gợi ý tối ưu")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Xem chi tiết" }));
    const claude = screen.getByRole("region", { name: "Claude Code Gói Max" });
    const peak = within(claude).getByText("Ngữ cảnh đỉnh").closest("li") as HTMLElement;
    expect(within(peak).getByText("Gọn ngữ cảnh sớm hơn.")).toBeTruthy();
    expect(screen.queryByText("Free space")).toBeNull();
    const table = await screen.findByRole("table");
    expect(within(table).getAllByText("payment-api")).toHaveLength(2);
    expect(calls.find((c) => c.command === "session_stats")?.args).toEqual({ engine: "claude", folder: null });
  });

  it("Codex: không gọi lệnh của Claude, hiện hạn mức và ngữ cảnh lượt cuối", async () => {
    const calls = fakeTauri(claudeHandlers);
    render(<TokensScreen />);
    const user = userEvent.setup();
    await screen.findByText("hạn mức tiêu ở mức ngữ cảnh trên 150k");
    await user.click(await screen.findByRole("button", { name: "Xem chi tiết" }));
    const before = calls.length;
    await user.click(screen.getByRole("button", { name: "Codex" }));
    expect(await screen.findByText("72%")).toBeTruthy();
    expect(screen.getByText("77%")).toBeTruthy();
    const codex = screen.getByRole("region", { name: "Codex codex-1" });
    const a1 = within(codex).getByText("Trần ngữ cảnh, nén sớm").closest("li") as HTMLElement;
    expect(within(a1).getByText("Dùng /compact trong Codex.")).toBeTruthy();
    const b4 = within(codex).getByText("Cache trúng").closest("li") as HTMLElement;
    expect(within(b4).getByText("Giữ phiên liền mạch để trúng cache.")).toBeTruthy();
    expect(calls.slice(before).map((c) => c.command)).toEqual(["session_stats"]);
    expect(screen.queryByText("Thứ đang tiêu hạn mức")).toBeNull();
  });

  it("thư mục: gửi cho cả ngữ cảnh và phiên", async () => {
    const calls = fakeTauri(claudeHandlers);
    render(<TokensScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Thư mục dự án"), "/w/api");
    const submit = screen.getAllByRole("button", { name: "Đọc lại" }).at(-1) as HTMLButtonElement;
    // Nút gửi của ô thư mục khoá trong lúc màn đang đọc lần đầu; bấm lúc đó không làm gì.
    await waitFor(() => expect(submit.disabled).toBe(false));
    await user.click(submit);
    // 95% đã hiện từ lần đọc lúc mở màn, chưa chứng tỏ lần đọc theo thư mục xong.
    await waitFor(() =>
      expect(
        calls
          .filter((c) => c.args?.folder === "/w/api")
          .map((c) => c.command)
          .sort(),
      ).toEqual(["claude_context", "session_stats"]),
    );
    expect(localStorage.getItem("hive.folder")).toBe("/w/api");
  });

  it("thẻ điểm ở đầu màn, trên bộ tối ưu và các ô số liệu", async () => {
    fakeTauri(claudeHandlers);
    render(<TokensScreen />);
    const card = await screen.findByRole("region", { name: "Điểm tối ưu token" });
    expect(await within(card).findByText("55,0")).toBeTruthy();
    const tokens = screen.getByText("Token vào 7 ngày");
    expect(card.compareDocumentPosition(tokens) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lỗi của từng phần hiện riêng, phần khác vẫn chạy", async () => {
    fakeTauri({ ...claudeHandlers, claude_context: () => Promise.reject("Không chạy được Claude Code.") });
    render(<TokensScreen />);
    expect(await screen.findByText("Không chạy được Claude Code.")).toBeTruthy();
    expect(await screen.findByText("hạn mức tiêu ở mức ngữ cảnh trên 150k")).toBeTruthy();
  });

  it("chưa chọn thư mục: tính mọi phiên trên máy; phần lỗi hiện — và lý do, không kẹt Đang đọc", async () => {
    const calls = fakeTauri({ ...claudeHandlers, session_stats: () => Promise.reject("Không đọc được ~/.claude.") });
    render(<TokensScreen />);
    expect(await screen.findByText("Không đọc được ~/.claude.")).toBeTruthy();
    expect(await screen.findByText("hạn mức tiêu ở mức ngữ cảnh trên 150k")).toBeTruthy();
    expect(await screen.findByText("12,7k", { selector: "span.text-2xl" })).toBeTruthy();
    const input = screen.getByText("Token vào 7 ngày").parentElement as HTMLElement;
    expect(within(input).getByText("—")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Đang đọc…")).toBeNull());
    expect(
      calls
        .filter((c) => ["claude_context", "session_stats"].includes(c.command))
        .every((c) => c.args?.folder === null),
    ).toBe(true);
  });

  it("tiếng Anh", async () => {
    setLang("en");
    fakeTauri(claudeHandlers);
    render(<TokensScreen />);
    const user = userEvent.setup();
    expect(await screen.findByText("of your usage was at >150k context")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Show details" }));
    expect(await screen.findByText("Compact context earlier.")).toBeTruthy();
    expect(screen.getByText("Use fewer subagents for small tasks")).toBeTruthy();
    expect(await screen.findByText("12.7k", { selector: "span.text-2xl" })).toBeTruthy();
  });
});
