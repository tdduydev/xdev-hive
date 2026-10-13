import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DecisionForm, OverrideForm } from "./decision-form.tsx";
import { detail, HEAD, NEW_HEAD } from "./test-fixtures.ts";
import { codeReviewText } from "./text.ts";

const t = codeReviewText.vi;
const props = { pending: false, t };

describe("DecisionForm", () => {
  it("duyệt gắn headSha đã xem", async () => {
    const onDecide = vi.fn();
    render(<DecisionForm detail={detail()} onDecide={onDecide} {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Duyệt" }));
    expect(onDecide).toHaveBeenCalledWith({ headSha: HEAD, decision: "approve" });
    expect(screen.getByText("Đã duyệt 1/2")).toBeTruthy();
  });

  it("trả lại mà thiếu ghi chú thì không gửi và báo lỗi", async () => {
    const onDecide = vi.fn();
    render(<DecisionForm detail={detail()} onDecide={onDecide} {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Trả lại" }));
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByText("Ghi góp ý khi trả lại.")).toBeTruthy();
    expect(screen.getByLabelText("Góp ý").getAttribute("aria-invalid")).toBe("true");
  });

  it("trả lại theo hướng mặc định của checkpoint, đổi được hướng", async () => {
    const onDecide = vi.fn();
    render(<DecisionForm detail={detail()} onDecide={onDecide} {...props} />);
    await userEvent.type(screen.getByLabelText("Góp ý"), "Thiếu test hoàn tiền");
    await userEvent.click(screen.getByRole("button", { name: "Trả lại" }));
    expect(onDecide).toHaveBeenLastCalledWith({
      headSha: HEAD,
      decision: "changes",
      note: "Thiếu test hoàn tiền",
      route: "agent",
    });

    await userEvent.selectOptions(screen.getByLabelText("Nếu trả lại"), "previous");
    await userEvent.click(screen.getByRole("button", { name: "Trả lại" }));
    expect(onDecide).toHaveBeenLastCalledWith(expect.objectContaining({ route: "previous" }));
  });

  it("không có checkpoint trước thì không chọn được 'về checkpoint trước'", () => {
    render(<DecisionForm detail={detail({ previousGate: null })} onDecide={vi.fn()} {...props} />);
    expect((screen.getByRole("option", { name: "Về checkpoint trước" }) as HTMLOptionElement).disabled).toBe(true);
  });

  it("hết lượt agent sửa thì báo sẽ về người giao việc", () => {
    render(<DecisionForm detail={detail({ agentRevisions: 2 })} onDecide={vi.fn()} {...props} />);
    expect(screen.getByText(/Hết lượt agent sửa/)).toBeTruthy();
  });

  it("PR có commit mới: báo, chặn quyết định, nút tải lại", async () => {
    const onDecide = vi.fn();
    const onReload = vi.fn();
    render(
      <DecisionForm detail={detail()} latestHeadSha={NEW_HEAD} onDecide={onDecide} onReload={onReload} {...props} />,
    );
    expect(screen.getByText(/PR đã có commit mới \(a91c3d2\)/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Duyệt" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Tải lại" }));
    expect(onReload).toHaveBeenCalled();
  });

  it("không đủ quyền: báo và khoá nút", () => {
    render(<DecisionForm detail={detail({ canDecide: false })} onDecide={vi.fn()} {...props} />);
    expect(screen.getByRole("status").textContent).toContain("Bạn không có quyền quyết định");
    expect((screen.getByRole("button", { name: "Trả lại" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hiện lỗi của hub", () => {
    render(<DecisionForm detail={detail()} error="PR đã đổi." onDecide={vi.fn()} {...props} />);
    expect(screen.getByText("PR đã đổi.")).toBeTruthy();
  });

  it("chữ tiếng Anh theo từ điển", () => {
    render(<DecisionForm detail={detail()} onDecide={vi.fn()} pending={false} t={codeReviewText.en} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Return" })).toBeTruthy();
  });
});

describe("OverrideForm", () => {
  it("bắt buộc lý do", async () => {
    const onOverride = vi.fn();
    render(<OverrideForm detail={detail()} onOverride={onOverride} {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Quyết thay: cho đạt" }));
    expect(onOverride).not.toHaveBeenCalled();
    expect(screen.getByText("Ghi lý do khi quyết thay checkpoint tự động.")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Lý do *"), "Máy codex hỏng");
    await userEvent.click(screen.getByRole("button", { name: "Quyết thay: trả lại" }));
    expect(onOverride).toHaveBeenCalledWith({ headSha: HEAD, passed: false, note: "Máy codex hỏng" });
  });

  it("nút chạy lại chỉ hiện khi được phép", () => {
    const { rerender } = render(<OverrideForm detail={detail()} onRecheck={vi.fn()} onOverride={vi.fn()} {...props} />);
    expect(screen.queryByRole("button", { name: "Chạy lại checkpoint này" })).toBeNull();
    rerender(
      <OverrideForm detail={detail({ canRecheck: true })} onRecheck={vi.fn()} onOverride={vi.fn()} {...props} />,
    );
    expect(screen.getByRole("button", { name: "Chạy lại checkpoint này" })).toBeTruthy();
  });
});
