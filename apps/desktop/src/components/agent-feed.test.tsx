import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentFeedPanel } from "@/components/agent-feed.tsx";
import { setLang } from "@/lib/i18n.ts";
import type { AgentFeed, FeedEntry, MachineAgent } from "@/lib/machine-agents.ts";

type Call = { command: string; args?: Record<string, unknown> | undefined };

const AGENT: MachineAgent = {
  pid: 4242,
  cli: "claude",
  background: false,
  bypass: false,
  startedAt: 1_792_000_000,
  cpu: 1,
  memory: 1,
  cwd: "/Users/ha/shop",
  configDir: null,
  hiveProject: null,
  source: { kind: "terminal" },
  own: true,
  children: 0,
  activity: null,
};

const entry = (kind: FeedEntry["kind"], text: string, tool: string | null = null): FeedEntry => ({
  at: "2026-10-18T08:01:02Z",
  kind,
  tool,
  text,
  cut: false,
});

const feed = (over: Partial<AgentFeed>): AgentFeed => ({
  path: "/Users/ha/.claude/projects/-Users-ha-shop/s.jsonl",
  entries: [],
  start: 0,
  end: 100,
  reset: false,
  guessed: false,
  readable: true,
  ...over,
});

/** Tauri giả: mỗi lần gọi machine_agent_feed lấy kết quả kế tiếp trong `feeds` (hết thì trả trang rỗng). */
function fakeTauri(feeds: (AgentFeed | Error)[], older: AgentFeed = feed({})) {
  const calls: Call[] = [];
  const queue = [...feeds];
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    machine_agent_feed: () => {
      const next = queue.shift() ?? feed({ end: 100 });
      if (next instanceof Error) throw next;
      return next;
    },
    machine_agent_feed_older: () => older,
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
  };
  return calls;
}

const feedCalls = (calls: Call[]) => calls.filter((c) => c.command === "machine_agent_feed");

describe("AgentFeedPanel", () => {
  beforeEach(() => setLang("vi"));
  afterEach(() => vi.useRealTimers());

  it("mở thì hiện trang cuối: lời nhắc, trả lời, công cụ, kết quả, lỗi; bí mật được che", async () => {
    fakeTauri([
      feed({
        entries: [
          entry("user", "Sửa lỗi đăng nhập"),
          entry("assistant", "Tôi sẽ chạy test."),
          entry("tool", "pnpm test", "Bash"),
          entry("result", `token=ghp_${"a1".repeat(18)}`),
          entry("error", "command not found"),
        ],
      }),
    ]);
    render(<AgentFeedPanel agent={AGENT} title="Sửa login" onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: /Hoạt động/ });
    const list = await within(dialog).findByRole("list", { name: "Hoạt động của agent" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((i) => i.dataset.kind)).toEqual(["user", "assistant", "tool", "result", "error"]);
    expect(within(items[0] as HTMLElement).getByText("Lời nhắc")).toBeTruthy();
    expect(within(items[2] as HTMLElement).getByText("Bash")).toBeTruthy();
    expect(within(items[4] as HTMLElement).getByText("Lỗi")).toBeTruthy();
    expect(list.textContent).not.toContain("ghp_");
    expect(list.textContent).toContain("token=••••••");
    expect(within(dialog).getByText(/Sửa login/)).toBeTruthy();
  });

  it("mỗi giây đọc tiếp từ vị trí đã có; phiên mới thì thay danh sách và báo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = fakeTauri([
      feed({ entries: [entry("user", "một")], end: 100 }),
      feed({ entries: [entry("assistant", "hai")], end: 180 }),
      feed({
        path: "/Users/ha/.claude/projects/-Users-ha-shop/moi.jsonl",
        entries: [entry("user", "ba")],
        reset: true,
      }),
    ]);
    render(<AgentFeedPanel agent={AGENT} title="x" onClose={() => {}} />);
    await screen.findByText("một");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(await screen.findByText("hai")).toBeTruthy();
    expect(feedCalls(calls)[1]?.args).toEqual({
      pid: 4242,
      startedAt: AGENT.startedAt,
      cursor: { path: "/Users/ha/.claude/projects/-Users-ha-shop/s.jsonl", end: 100 },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(await screen.findByText("ba")).toBeTruthy();
    expect(screen.queryByText("một")).toBeNull();
    expect(screen.getByText("Đã chuyển sang phiên mới.")).toBeTruthy();
  });

  it("Tải thêm đọc trang trước của đúng file và đặt lên đầu; tới đầu file thì ẩn nút", async () => {
    const user = userEvent.setup();
    const calls = fakeTauri(
      [feed({ entries: [entry("user", "mới")], start: 500 })],
      feed({ entries: [entry("user", "cũ")], start: 0, end: 500 }),
    );
    render(<AgentFeedPanel agent={AGENT} title="x" onClose={() => {}} />);
    await screen.findByText("mới");
    await user.click(screen.getByRole("button", { name: "Tải thêm" }));
    await screen.findByText("cũ");
    expect(calls.find((c) => c.command === "machine_agent_feed_older")?.args).toEqual({
      pid: 4242,
      startedAt: AGENT.startedAt,
      path: "/Users/ha/.claude/projects/-Users-ha-shop/s.jsonl",
      before: 500,
    });
    const texts = within(screen.getByRole("list", { name: "Hoạt động của agent" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(texts[0]).toContain("cũ");
    expect(screen.queryByRole("button", { name: "Tải thêm" })).toBeNull();
  });

  it("Sao chép chép các mục đang có, đã che bí mật", async () => {
    const user = userEvent.setup();
    fakeTauri([feed({ entries: [entry("user", "chạy"), entry("result", `sk-ant-${"x9".repeat(15)}`)] })]);
    render(<AgentFeedPanel agent={AGENT} title="x" onClose={() => {}} />);
    await screen.findByText("chạy");
    await user.click(screen.getByRole("button", { name: "Sao chép" }));
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain("Lời nhắc: chạy");
    expect(copied).toContain("Kết quả: ••••••");
    expect(copied).not.toContain("sk-ant-");
    expect(await screen.findByRole("button", { name: "Đã chép" })).toBeTruthy();
  });

  it("cuộn lên thì tắt Theo dõi; bật lại thì cuộn xuống cuối", async () => {
    const user = userEvent.setup();
    fakeTauri([feed({ entries: [entry("user", "a"), entry("assistant", "b")] })]);
    render(<AgentFeedPanel agent={AGENT} title="x" onClose={() => {}} />);
    await screen.findByText("b");
    const follow = screen.getByRole("switch", { name: "Theo dõi" });
    expect(follow.getAttribute("aria-checked")).toBe("true");
    const scroller = screen.getByTestId("feed-scroll");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    expect(follow.getAttribute("aria-checked")).toBe("false");
    await user.click(follow);
    expect(follow.getAttribute("aria-checked")).toBe("true");
    expect(scroller.scrollTop).toBe(2000);
  });

  it("che bí mật trên chữ còn nguyên rồi mới cắt cho gọn", async () => {
    fakeTauri([
      feed({
        entries: [
          // Lệnh nhiều dòng: dòng KEY=value chỉ khớp mẫu khi còn xuống dòng; hiện thành một dòng sau khi che.
          entry("tool", "cat <<EOF\nDB_PASSWORD=hunter2abc9\nEOF", "Bash"),
          // Rust chặn trên giữa chừng một bí mật: phần dở cuối cùng không được hiện.
          { ...entry("result", 'ok "password":"hunter2abcdefgh'), cut: true },
          entry("user", "á".repeat(5000)),
        ],
      }),
    ]);
    render(<AgentFeedPanel agent={AGENT} title="x" onClose={() => {}} />);
    const list = await screen.findByRole("list", { name: "Hoạt động của agent" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("cat <<EOF DB_PASSWORD=•••••• EOF");
    expect(list.textContent).not.toContain("hunter2");
    expect(items[1]?.textContent).toContain("ok …");
    const long = items[2]?.querySelector("p")?.textContent ?? "";
    expect(long.length).toBe(4000);
    expect(long.endsWith("…")).toBe(true);
  });

  it("giữ tối đa 2000 mục: bỏ mục cũ nhất, thôi Tải thêm và báo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const many = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => entry("assistant", `mục ${from + i}`));
    fakeTauri([feed({ entries: many(1990, 0), start: 900 }), feed({ entries: many(20, 1990), end: 200 })]);
    render(<AgentFeedPanel agent={AGENT} title="x" onClose={() => {}} />);
    await screen.findByText("mục 1989");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    await screen.findByText("mục 2009");
    const list = screen.getByRole("list", { name: "Hoạt động của agent" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2000);
    expect(screen.queryByText("mục 9")).toBeNull();
    expect(screen.getByText(/Đã bỏ các mục cũ/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tải thêm" })).toBeNull();
  });

  it("định dạng lạ hay không có file phiên: báo Không đọc được phiên", async () => {
    fakeTauri([feed({ path: null, readable: false })]);
    render(<AgentFeedPanel agent={{ ...AGENT, cli: "antigravity" }} title="x" onClose={() => {}} />);
    expect(await screen.findByText("Không đọc được phiên.")).toBeTruthy();
  });

  it("agent thoát thì báo và thôi đọc", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = fakeTauri([feed({ entries: [entry("user", "a")] }), new Error("Agent đã thoát.")]);
    render(<AgentFeedPanel agent={AGENT} title="x" onClose={() => {}} />);
    await screen.findByText("a");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(await screen.findByText("Agent đã thoát.")).toBeTruthy();
    const count = feedCalls(calls).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(feedCalls(calls)).toHaveLength(count);
    // Mục đã đọc vẫn còn để xem lại.
    expect(screen.getByText("a")).toBeTruthy();
  });

  it("đóng khung thì thôi đọc", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = fakeTauri([feed({ entries: [entry("user", "a")] })]);
    const view = render(<AgentFeedPanel agent={AGENT} title="x" onClose={() => {}} />);
    await screen.findByText("a");
    view.rerender(<AgentFeedPanel agent={null} title="x" onClose={() => {}} />);
    const count = feedCalls(calls).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(feedCalls(calls)).toHaveLength(count);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
