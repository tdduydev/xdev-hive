import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { slots, TokenScoreHistory } from "@/components/token-score-history.tsx";
import { setLang } from "@/lib/i18n.ts";
import type { HistoryEntry } from "@/lib/token-score.ts";

const entry = (day: string, machine: number | null, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  ts: `${day}T08:00:00Z`,
  day,
  scoreVersion: 2,
  machine,
  coverage: 87,
  groups: {},
  profiles: [],
  criteria: {},
  ...extra,
});

const sample = [
  entry("2026-10-10", 40, { scoreVersion: 1 }),
  entry("2026-10-12", 45, { scoreVersion: 1 }),
  entry("2026-10-15", 52, { scoreVersion: 2, fixes: [{ id: "optimizer.balanced", action: "apply" }] }),
  entry("2026-10-19", null),
  entry("2026-10-20", 83),
];

beforeEach(() => setLang("vi"));

describe("slots", () => {
  it("trải 30 ngày kết thúc ở dòng cuối, ngày thiếu là ô trống", () => {
    const all = slots(sample);
    expect(all).toHaveLength(30);
    expect(all[0]?.day).toBe("2026-09-21");
    expect(all.at(-1)?.day).toBe("2026-10-20");
    expect(all.filter((s) => s.entry)).toHaveLength(5);
  });

  it("đánh dấu cột đầu của thang mới, bỏ qua ô trống ở giữa", () => {
    expect(
      slots(sample)
        .filter((s) => s.scaleStart)
        .map((s) => s.day),
    ).toEqual(["2026-10-15"]);
  });

  it("không có dòng nào thì không có cột", () => {
    expect(slots([])).toEqual([]);
  });
});

describe("TokenScoreHistory", () => {
  it("chưa có lịch sử thì nói rõ, không vẽ trục", () => {
    render(<TokenScoreHistory entries={[]} />);
    expect(screen.getByText(/Chưa có lịch sử điểm/)).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("vẽ một nút cho mỗi ngày, ngày có điểm đọc được số điểm", () => {
    render(<TokenScoreHistory entries={sample} />);
    const group = screen.getByRole("group", { name: /4 ngày có điểm/ });
    expect(within(group).getAllByRole("button")).toHaveLength(30);
    expect(screen.getByRole("button", { name: "20 tháng 10: 83,0" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "19 tháng 10: chưa có điểm" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "11 tháng 10: chưa có điểm" })).toBeTruthy();
  });

  it("đánh dấu ngày có sửa nhanh và nêu tên sửa nhanh", () => {
    const { container } = render(<TokenScoreHistory entries={sample} />);
    expect(container.querySelectorAll("[data-marker=fix]")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "15 tháng 10: 52,0 · Sửa nhanh: Bật mức cân bằng (áp dụng)" }),
    ).toBeTruthy();
  });

  it("báo đổi thang điểm và đặt vạch đứt trước cột của thang mới", () => {
    const { container } = render(<TokenScoreHistory entries={sample} />);
    expect(screen.getByText(/Đổi thang điểm\./)).toBeTruthy();
    const starts = container.querySelectorAll("[data-scale-start]");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.getAttribute("data-day")).toBe("2026-10-15");
  });

  it("không nhắc đổi thang khi mọi dòng cùng một thang", () => {
    render(<TokenScoreHistory entries={[entry("2026-10-19", 50), entry("2026-10-20", 60)]} />);
    expect(screen.queryByText(/Đổi thang điểm/)).toBeNull();
  });

  it("bảng thay thế liệt kê ngày có dòng, mới nhất trước, kèm thang và sửa nhanh", async () => {
    render(<TokenScoreHistory entries={sample} />);
    await userEvent.click(screen.getByText("Xem dạng bảng"));
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    expect(within(rows[0] as HTMLElement).getByText("20 tháng 10")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("83,0")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("—")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("thang 2")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Bật mức cân bằng (áp dụng)")).toBeTruthy();
    expect(within(rows[4] as HTMLElement).getByText("thang 1")).toBeTruthy();
  });

  it("đi giữa các ngày bằng phím mũi tên, chỉ một cột nằm trong thứ tự Tab", async () => {
    render(<TokenScoreHistory entries={sample} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    const latest = screen.getByRole("button", { name: "20 tháng 10: 83,0" });
    expect(latest.tabIndex).toBe(0);
    latest.focus();
    await userEvent.keyboard("{ArrowLeft}");
    const previous = screen.getByRole("button", { name: "19 tháng 10: chưa có điểm" });
    expect(document.activeElement).toBe(previous);
    expect(previous.tabIndex).toBe(0);
    expect(screen.getByRole("status").textContent).toBe("19 tháng 10: chưa có điểm");
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(buttons[0]);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(latest);
  });

  it("có bản tiếng Anh", () => {
    setLang("en");
    render(<TokenScoreHistory entries={sample} />);
    expect(screen.getByText("Machine score, 30 days")).toBeTruthy();
    expect(screen.getByText(/Scoring scale changed\./)).toBeTruthy();
  });
});
