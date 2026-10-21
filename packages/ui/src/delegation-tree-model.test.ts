import { describe, expect, it } from "vitest";
import { run, TREE } from "./delegation-tree.fixture.ts";
import {
  buildTree,
  countNodes,
  type DelegationTreeData,
  defaultCollapsed,
  filterTree,
  formatCost,
  formatDuration,
  formatTokens,
  normalize,
  runDurationMs,
  type TreeNode,
  treeKeyAction,
  treeRefetchMs,
  visibleNodes,
} from "./delegation-tree-model.ts";

const ids = (node: TreeNode): string[] => [node.id, ...node.children.flatMap(ids)];

describe("buildTree", () => {
  it("đặt run con dưới run cha và sub-agent theo parentId", () => {
    const root = buildTree(TREE);
    expect(root.id).toBe("thread:t1");
    const task = root.children[0] as TreeNode;
    expect(task.children.map((c) => c.id)).toEqual(["run:r1"]);
    const code = task.children[0] as TreeNode;
    expect(code.children.map((c) => c.id)).toEqual(["sub:r1:s1", "run:r2"]);
    expect(code.children[0]?.children.map((c) => c.id)).toEqual(["sub:r1:s2"]);
    expect(countNodes(root)).toBe(10);
  });

  it("run cha không thuộc task và sub-agent mất cha thì đứng ngay dưới cấp trên", () => {
    const root = buildTree({
      ...TREE,
      tasks: [
        {
          ...(TREE.tasks[0] as DelegationTreeData["tasks"][number]),
          runs: [
            run({
              id: "x",
              parentRunId: "khac",
              subagents: [
                {
                  id: "a",
                  parentId: "mat",
                  type: "Explore",
                  description: "",
                  status: "unknown",
                  depth: 2,
                  tokens: null,
                  toolUses: null,
                  durationMs: null,
                },
              ],
            }),
          ],
        },
      ],
    });
    expect(ids(root)).toEqual(["thread:t1", "task:k1", "run:x", "sub:x:a"]);
  });
});

describe("filterTree", () => {
  const root = buildTree(TREE);

  it("tìm theo tên không dấu hay mã task", () => {
    expect(filterTree(root, { hotOnly: false, query: "bang quyen" }).children.map((c) => c.id)).toEqual(["task:k1"]);
    expect(filterTree(root, { hotOnly: false, query: "pay-2" }).children.map((c) => c.id)).toEqual(["task:k2"]);
    expect(filterTree(root, { hotOnly: false, query: "không có" }).children).toEqual([]);
  });

  it("chỉ đang chạy hoặc lỗi bỏ nhánh đã xong, giữ đường tới nút nóng", () => {
    const hot = filterTree(root, { hotOnly: true, query: "" });
    expect(ids(hot)).toEqual(["thread:t1", "task:k1", "run:r1", "sub:r1:s1", "sub:r1:s2", "task:k3", "run:r4"]);
  });
});

describe("defaultCollapsed", () => {
  it("cây nhỏ thì mở hết", () => {
    expect(defaultCollapsed(buildTree(TREE)).size).toBe(0);
  });

  it("cây lớn hơn ngưỡng thì đóng nhánh đã xong, giữ nhánh đang chạy", () => {
    const collapsed = defaultCollapsed(buildTree(TREE), 5);
    expect([...collapsed]).toEqual(["task:k2", "task:k3"]);
  });
});

describe("bàn phím", () => {
  const root = buildTree(TREE);
  const closed = new Set(["task:k2"]);
  const open = (id: string) => !closed.has(id);
  const flat = visibleNodes(root, open);

  it("làm phẳng theo thứ tự trên màn, bỏ con của nút đóng", () => {
    expect(flat.map((f) => f.node.id)).toEqual([
      "thread:t1",
      "task:k1",
      "run:r1",
      "sub:r1:s1",
      "sub:r1:s2",
      "run:r2",
      "task:k2",
      "task:k3",
      "run:r4",
    ]);
    expect(flat[3]?.level).toBe(4);
    expect(flat[3]?.parentId).toBe("run:r1");
  });

  it("lên, xuống, Home, End", () => {
    expect(treeKeyAction(flat, "task:k1", "ArrowDown", open)).toEqual({ type: "focus", id: "run:r1" });
    expect(treeKeyAction(flat, "task:k1", "ArrowUp", open)).toEqual({ type: "focus", id: "thread:t1" });
    expect(treeKeyAction(flat, "thread:t1", "ArrowUp", open)).toBeNull();
    expect(treeKeyAction(flat, "run:r2", "Home", open)).toEqual({ type: "focus", id: "thread:t1" });
    expect(treeKeyAction(flat, "run:r2", "End", open)).toEqual({ type: "focus", id: "run:r4" });
  });

  it("phải mở nút đóng rồi vào con đầu; trái đóng nút mở rồi về cha", () => {
    expect(treeKeyAction(flat, "task:k2", "ArrowRight", open)).toEqual({ type: "expand", id: "task:k2" });
    expect(treeKeyAction(flat, "task:k1", "ArrowRight", open)).toEqual({ type: "focus", id: "run:r1" });
    expect(treeKeyAction(flat, "run:r2", "ArrowRight", open)).toBeNull();
    expect(treeKeyAction(flat, "task:k1", "ArrowLeft", open)).toEqual({ type: "collapse", id: "task:k1" });
    expect(treeKeyAction(flat, "run:r2", "ArrowLeft", open)).toEqual({ type: "focus", id: "run:r1" });
    expect(treeKeyAction(flat, "task:k2", "ArrowLeft", open)).toEqual({ type: "focus", id: "thread:t1" });
    expect(treeKeyAction(flat, "run:r4", "Enter", open)).toEqual({ type: "activate", id: "run:r4" });
    expect(treeKeyAction(flat, "run:r4", "a", open)).toBeNull();
  });
});

describe("định dạng", () => {
  it("thời gian", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(400)).toBe("dưới 1 giây");
    expect(formatDuration(45_000)).toBe("45 giây");
    expect(formatDuration(180_000)).toBe("3 phút");
    expect(formatDuration(185_000)).toBe("3 phút 5 giây");
    expect(formatDuration(3_600_000)).toBe("1 giờ");
    expect(formatDuration(3_900_000)).toBe("1 giờ 5 phút");
  });

  it("thời gian run: xong thì tới lúc kết thúc, đang chạy thì tới bây giờ", () => {
    expect(runDurationMs(run({ id: "a" }), 0)).toBe(300_000);
    expect(runDurationMs(run({ id: "a", endedAt: null }), Date.parse("2026-10-21T01:01:00.000Z"))).toBe(60_000);
    expect(runDurationMs(run({ id: "a", startedAt: null }), 0)).toBeNull();
  });

  it("chi phí, token, bỏ dấu", () => {
    expect(formatCost(null)).toBe("—");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatTokens(null)).toBe("chưa có số token");
    expect(formatTokens(800)).toBe("800 token");
    expect(formatTokens(12_345)).toBe("12,3k token");
    expect(formatTokens(2_500_000)).toBe("2,5M token");
    expect(normalize("  Đổi Phân Quyền ")).toBe("doi phan quyen");
  });
});

describe("treeRefetchMs", () => {
  it("cây còn việc đang chạy thì hỏi 3 giây một lần, xong hết hay chưa có dữ liệu thì 30 giây", () => {
    expect(treeRefetchMs({ active: true })).toBe(3000);
    expect(treeRefetchMs({ active: false })).toBe(30_000);
    expect(treeRefetchMs(undefined)).toBe(30_000);
  });
});
