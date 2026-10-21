// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run, TREE } from "./delegation-tree.fixture.ts";
import { DelegationTree } from "./delegation-tree.tsx";
import type { DelegationTreeData } from "./delegation-tree-model.ts";

afterEach(cleanup);

const NOW = Date.parse("2026-10-21T01:10:00.000Z");
const item = (name: RegExp | string) => screen.getByRole("treeitem", { name });

describe("DelegationTree", () => {
  it("vẽ phiên, task, run, run con và sub-agent với số liệu", () => {
    render(<DelegationTree tree={TREE} onOpenRun={() => {}} now={NOW} />);
    const tree = screen.getByRole("tree", { name: "Cây giao việc: Phân quyền menu" });
    expect(within(tree).getAllByRole("treeitem")).toHaveLength(10);
    const root = item("Phiên Leader: Phân quyền menu");
    expect(root.getAttribute("aria-level")).toBe("1");
    expect(root.getAttribute("aria-expanded")).toBe("true");

    const task = item(/^PAY-1 Bảng quyền/);
    expect(task.getAttribute("aria-level")).toBe("2");
    expect(task.textContent).toContain("Leader tạo");
    expect(item(/^PAY-2/).textContent).toContain("Người tạo, Leader giao");

    const code = item("Run Viết code, Đang chạy, máy mac-ha");
    expect(code.getAttribute("aria-level")).toBe("3");
    // Run đang chạy: thời gian tính tới `now`.
    expect(code.textContent).toContain("10 phút");
    expect(code.textContent).toContain("Gói Pro Hà");
    expect(code.textContent).toContain("$0.42");
    const review = item("Run Review chéo, Thành công, máy mac-ha");
    expect(review.getAttribute("aria-level")).toBe("4");
    expect(review.parentElement?.closest('[role="treeitem"]')).toBe(code);

    const nested = item(/^Sub-agent test-runner/);
    expect(nested.getAttribute("aria-level")).toBe("5");
    expect(nested.textContent).toContain("chưa có số token");
    expect(item(/^Sub-agent Explore/).textContent).toContain("1,2k token");
    expect(item(/^Run Viết code, Lỗi/).textContent).toContain("Test hỏng");
  });

  it("ghi rõ CLI không theo dõi được sub-agent, đếm mục ẩn do quyền và đánh dấu máy này", () => {
    const tree: DelegationTreeData = {
      ...TREE,
      hidden: 2,
      tasks: [
        {
          ...(TREE.tasks[1] as DelegationTreeData["tasks"][number]),
          runs: [run({ id: "x", cli: "codex", subagents: null, subagentsUnsupported: true })],
        },
      ],
    };
    render(<DelegationTree tree={tree} onOpenRun={() => {}} isThisMachine={(id) => id === "m1"} />);
    expect(screen.getByText("2 mục bị ẩn do quyền")).toBeTruthy();
    const node = item("Run Viết code, Thành công, máy mac-ha (máy này)");
    expect(node.textContent).toContain("Không theo dõi được sub-agent của CLI này");
    expect(within(node).getByText("máy này")).toBeTruthy();
  });

  it("bấm hay Enter trên run gọi onOpenRun", () => {
    const onOpenRun = vi.fn();
    render(<DelegationTree tree={TREE} onOpenRun={onOpenRun} />);
    fireEvent.click(within(item(/^Run Review chéo/)).getByRole("button", { name: "Review chéo" }));
    expect(onOpenRun).toHaveBeenLastCalledWith(expect.objectContaining({ id: "r2" }));
    const failed = item(/^Run Viết code, Lỗi/);
    failed.focus();
    fireEvent.keyDown(failed, { key: "Enter" });
    expect(onOpenRun).toHaveBeenLastCalledWith(expect.objectContaining({ id: "r4" }));
  });

  it("phím mũi tên đi theo WAI-ARIA tree, chỉ một nút có tabindex 0", () => {
    render(<DelegationTree tree={TREE} onOpenRun={() => {}} />);
    const root = item(/^Phiên Leader/);
    expect(root.tabIndex).toBe(0);
    expect(item(/^PAY-1/).tabIndex).toBe(-1);
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item(/^PAY-1/));
    expect(item(/^PAY-1/).tabIndex).toBe(0);
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(item(/^PAY-1/).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: /^Run Viết code, Đang chạy/ })).toBeNull();
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(item(/^PAY-1/).getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(document.activeElement).toBe(item(/^Run Viết code, Đang chạy/));
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(document.activeElement).toBe(item(/^Run Viết code, Lỗi/));
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(document.activeElement).toBe(root);
  });

  it("thu gọn bằng nút chuột, lọc đang chạy hoặc lỗi, tìm theo task", () => {
    render(<DelegationTree tree={TREE} onOpenRun={() => {}} />);
    fireEvent.click(within(item(/^PAY-2/)).getByRole("button", { name: "Thu gọn" }));
    expect(item(/^PAY-2/).getAttribute("aria-expanded")).toBe("false");

    const toggle = screen.getByRole("button", { name: "Chỉ đang chạy hoặc lỗi" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("treeitem", { name: /^PAY-2/ })).toBeNull();
    expect(screen.queryByRole("treeitem", { name: /^Run Review chéo/ })).toBeNull();
    expect(item(/^PAY-3/)).toBeTruthy();
    fireEvent.click(toggle);

    fireEvent.change(screen.getByRole("searchbox", { name: "Tìm theo tên hoặc mã task" }), {
      target: { value: "menu theo" },
    });
    // Nhánh người xem đã tự đóng vẫn đóng khi tìm.
    expect(screen.getAllByRole("treeitem").map((el) => el.getAttribute("aria-label"))).toEqual([
      "Phiên Leader: Phân quyền menu",
      "PAY-2 Menu theo vai trò, Xong",
    ]);
    expect(item(/^PAY-2/).getAttribute("aria-expanded")).toBe("false");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "không có" } });
    expect(screen.getByText("Không có việc phù hợp với bộ lọc.")).toBeTruthy();
  });

  it("cây hơn 200 nút đóng sẵn nhánh đã xong", () => {
    const done = Array.from({ length: 70 }, (_, i) => ({
      id: `d${i}`,
      key: `PAY-${100 + i}`,
      title: `Việc xong ${i}`,
      status: "done",
      projectKey: "PAY",
      createdBy: "leader" as const,
      runs: [run({ id: `dr${i}` }), run({ id: `dv${i}`, kind: "review", parentRunId: `dr${i}` })],
    }));
    render(<DelegationTree tree={{ ...TREE, tasks: [...TREE.tasks, ...done] }} onOpenRun={() => {}} />);
    expect(item(/^PAY-100 /).getAttribute("aria-expanded")).toBe("false");
    expect(item(/^PAY-1 Bảng quyền/).getAttribute("aria-expanded")).toBe("true");
    expect(item(/^Sub-agent test-runner/)).toBeTruthy();
  });

  it("phiên chưa giao việc", () => {
    render(<DelegationTree tree={{ ...TREE, tasks: [] }} onOpenRun={() => {}} />);
    expect(screen.getByText("Phiên này chưa giao việc nào.")).toBeTruthy();
  });
});
