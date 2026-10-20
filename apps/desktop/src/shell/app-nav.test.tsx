import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import { announceTokenScore, type HistoryEntry } from "@/lib/token-score.ts";
import { AppNav } from "@/shell/app-nav.tsx";

const entry = (machine: number | null): HistoryEntry => ({
  ts: "2026-10-20T08:00:00Z",
  day: "2026-10-20",
  scoreVersion: 2,
  machine,
  coverage: 87,
  groups: {},
  profiles: [],
  criteria: {},
});

function fakeLast(read: () => HistoryEntry[] | Error) {
  const calls: string[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string) => {
        calls.push(command);
        if (command !== "token_score_last") throw new Error(`lệnh chưa giả: ${command}`);
        const out = read();
        if (out instanceof Error) throw out;
        return { entries: out } as T;
      },
    },
  };
  // Menu còn gọi lệnh khác (phiên bản app...): chỉ đếm lệnh điểm.
  return {
    get tokenCalls() {
      return calls.filter((c) => c.startsWith("token_score"));
    },
  };
}

const tokensLink = () => screen.getByRole("link", { name: /^Token/ });

beforeEach(() => setLang("vi"));

describe("AppNav: huy hiệu điểm ở mục Token", () => {
  it("hiện điểm máy làm tròn, kèm mức màu và chữ đọc được; chỉ gọi token_score_last", async () => {
    const calls = fakeLast(() => [entry(48.7)]);
    render(<AppNav profile="dev" active="home" />);
    const badge = await screen.findByRole("img", { name: "Điểm tối ưu token của máy 49 trên 100" });
    expect(badge.textContent).toBe("49");
    expect(badge.querySelector(".bg-destructive")).toBeTruthy();
    expect(tokensLink().contains(badge)).toBe(true);
    expect(tokensLink().getAttribute("title")).toContain("Điểm tối ưu token của máy 49 trên 100");
    expect(calls.tokenCalls).toEqual(["token_score_last"]);
  });

  it("mức khá và tốt đổi màu chấm", async () => {
    fakeLast(() => [entry(85)]);
    render(<AppNav profile="dev" active="home" />);
    expect((await screen.findByRole("img")).querySelector(".bg-success")).toBeTruthy();
  });

  it("chỉ mục Token có huy hiệu", async () => {
    fakeLast(() => [entry(70)]);
    render(<AppNav profile="dev" active="home" />);
    await screen.findByRole("img");
    expect(document.querySelectorAll("[data-score-badge]")).toHaveLength(1);
  });

  it.each([
    ["chưa có dòng lịch sử nào", () => [] as HistoryEntry[]],
    ["dòng cuối chưa có điểm máy", () => [entry(null)]],
    ["lệnh lỗi (ngoài Tauri)", () => new Error("no tauri")],
  ])("không có huy hiệu khi %s", async (_name, read) => {
    const calls = fakeLast(read);
    render(<AppNav profile="dev" active="home" />);
    await waitFor(() => expect(calls.tokenCalls).toEqual(["token_score_last"]));
    expect(screen.queryByRole("img")).toBeNull();
    expect(tokensLink().getAttribute("title")).toBe("Token và ngữ cảnh");
  });

  it("đọc lại khi thẻ điểm vừa tính xong", async () => {
    let current: HistoryEntry[] = [entry(40)];
    fakeLast(() => current);
    render(<AppNav profile="dev" active="home" />);
    expect((await screen.findByRole("img")).textContent).toBe("40");
    current = [entry(62)];
    act(() => announceTokenScore());
    await waitFor(() => expect(screen.getByRole("img").textContent).toBe("62"));
  });

  it("tiếng Anh", async () => {
    setLang("en");
    fakeLast(() => [entry(90)]);
    render(<AppNav profile="dev" active="home" />);
    expect(await screen.findByRole("img", { name: "Machine token optimization score 90 out of 100" })).toBeTruthy();
  });
});
