import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeReviewPane } from "./code-review-pane.tsx";
import { aiGate, detail, files, gate, NEW_HEAD } from "./test-fixtures.ts";
import { codeReviewText } from "./text.ts";

const now = Date.parse("2026-10-13T01:00:00.000Z");
const base = { now, t: codeReviewText.vi, onDecide: vi.fn() };

// delay mặc định chờ một macrotask sau mỗi thao tác; máy tải cao thì mỗi lần chờ kéo dài và test chạm trần thời gian.
const user = userEvent.setup({ delay: null });

describe("CodeReviewPane", () => {
  it("ghép tiêu đề, máy đã kiểm, AI, diff, các vòng và quyết định", () => {
    render(<CodeReviewPane detail={detail()} files={{ status: "ready", data: files() }} {...base} />);
    expect(screen.getByText("Hoàn tiền một phần")).toBeTruthy();
    expect(screen.getByText("#128")).toBeTruthy();
    expect(screen.getByText("ai/PAY-142 → main")).toBeTruthy();
    expect(screen.getByText("pnpm test", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("Review AI", { selector: "h2" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Danh sách file" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Các bước của quy trình" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Quyết định của bạn" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mở PR" }).getAttribute("href")).toBe(detail().pr.url);
    const rounds = screen.getByRole("heading", { name: "Các vòng review" }).closest("div")?.parentElement;
    expect(within(rounds as HTMLElement).getAllByRole("listitem")).toHaveLength(2);
  });

  it("link tới run và task do app chủ dựng", () => {
    const link = vi.fn(({ to, children }) => (
      <a href={to.kind === "run" ? `#/runs/${to.id}` : `#/tasks/${to.key}`}>{children}</a>
    ));
    render(<CodeReviewPane detail={detail()} files={{ status: "loading" }} link={link} {...base} />);
    expect(screen.getByRole("link", { name: "PAY-142" }).getAttribute("href")).toBe("#/tasks/PAY-142");
    expect(screen.getByRole("link", { name: "Mở run" })).toBeTruthy();
  });

  it("diff đang tải hoặc lỗi", async () => {
    const retry = vi.fn();
    const { rerender } = render(<CodeReviewPane detail={detail()} files={{ status: "loading" }} {...base} />);
    expect(screen.getByText("Đang tải diff…")).toBeTruthy();
    rerender(<CodeReviewPane detail={detail()} files={{ status: "error", message: "Hub lỗi.", retry }} {...base} />);
    await userEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(retry).toHaveBeenCalled();
  });

  it("commit mới: báo ở cả khung và chặn nút duyệt", () => {
    render(<CodeReviewPane detail={detail()} files={{ status: "loading" }} latestHeadSha={NEW_HEAD} {...base} />);
    expect(screen.getAllByText(/PR đã có commit mới/)).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Duyệt" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("checkpoint tự động đang chờ: không có form duyệt, có quyết thay khi đủ quyền", () => {
    const autoGate = {
      id: "ai",
      name: "Review AI",
      kind: "ai" as const,
      phase: "AI",
      index: 1,
      total: 2,
      dueAt: null,
      sla: "none" as const,
    };
    const waiting = gate({ gateId: "ai", kind: "ai", status: "waiting", reviewers: aiGate.reviewers });
    const d = detail({ gate: autoGate, gates: [waiting], canDecide: false, canOverride: true });
    const { rerender } = render(
      <CodeReviewPane detail={d} files={{ status: "loading" }} onOverride={vi.fn()} {...base} />,
    );
    expect(screen.queryByRole("heading", { name: "Quyết định của bạn" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Quyết thay checkpoint tự động" })).toBeTruthy();
    rerender(
      <CodeReviewPane
        detail={{ ...d, canOverride: false }}
        files={{ status: "loading" }}
        onOverride={vi.fn()}
        {...base}
      />,
    );
    expect(screen.queryByRole("heading", { name: "Quyết thay checkpoint tự động" })).toBeNull();
  });

  it("đã duyệt, merge tay: nút đưa vào hàng merge theo quyền", async () => {
    const onEnqueue = vi.fn();
    const d = detail({ status: "approved", gate: null, canDecide: false, canEnqueue: true, currentGate: null });
    render(<CodeReviewPane detail={d} files={{ status: "loading" }} onEnqueue={onEnqueue} {...base} />);
    expect(screen.queryByRole("heading", { name: "Quyết định của bạn" })).toBeNull();
    expect(screen.getByText("PR đã qua mọi checkpoint.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Đưa vào hàng merge" }));
    expect(onEnqueue).toHaveBeenCalled();
  });

  it("SLA quá hạn hiện ở tiêu đề", () => {
    const d = detail({
      gate: {
        id: "po",
        name: "PO duyệt",
        kind: "human",
        phase: "p",
        index: 2,
        total: 3,
        dueAt: "2026-10-12T22:00:00.000Z",
        sla: "overdue",
      },
    });
    render(<CodeReviewPane detail={d} files={{ status: "loading" }} {...base} />);
    expect(screen.getByText("Quá hạn 3 giờ")).toBeTruthy();
  });
});
