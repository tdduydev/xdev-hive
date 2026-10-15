// @vitest-environment jsdom
import { mergeBlocks } from "@xdev-hive/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CONFLICT_MARK,
  type ConflictResolution,
  ConflictView,
  conflictRows,
  hasConflictMarks,
  markedMerge,
} from "./conflict-view.tsx";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const base = "# Tiêu đề\n\nMở đầu.\n\nBước một.\n\nBước hai.\n\nKết luận.\n";
const hub = "# Tiêu đề\n\nMở đầu.\n\nBước một (hub).\n\nBước hai.\n\nKết luận hub.\n";
const repo = "# Tiêu đề\n\nMở đầu.\n\nBước một (repo).\n\nBước hai.\n\nKết luận.\n";

const detail = (over: Partial<Parameters<typeof ConflictView>[0]["conflict"]> = {}) => ({
  baseContent: base,
  hubContent: hub,
  repoContent: repo,
  baseVersion: 3,
  hubVersion: 5,
  repoCommit: "0123456789abcdef0123456789abcdef01234567",
  state: "open" as const,
  ...over,
});

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return host;
}

const button = (host: HTMLElement, label: string) => {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`Không thấy nút "${label}"`);
  return found;
};

describe("conflictRows", () => {
  it("đánh dấu đúng khối xung đột và khối chỉ một bên sửa", () => {
    const rows = conflictRows(base, hub, repo);
    expect(rows.filter((r) => r.kind === "conflict").map((r) => [r.hub, r.repo])).toEqual([
      [["Bước một (hub)."], ["Bước một (repo)."]],
    ]);
    expect(rows.filter((r) => r.kind === "hub").map((r) => r.hub)).toEqual([["Kết luận hub."]]);
    expect(rows.filter((r) => r.kind === "repo")).toEqual([]);
  });

  it("số hàng xung đột khớp mergeBlocks, và bản hợp không có xung đột thì giống mergeBlocks", () => {
    const cases: [string, string, string][] = [
      [base, hub, repo],
      [base, hub, base],
      [base, base, repo],
      ["A\n\nB\n\nC\n", "A\n\nB1\n\nC\n", "A\n\nB\n\nC1\n"],
      ["A\n\nB\n\nC\n", "A\n\nC\n", "A\n\nB2\n\nC\n"],
      ["A\n\nB\n", "A\n\nB\n\nX\n", "A\n\nB\n\nY\n"],
      ["A\n\nB\n", "A\n\nB\n\nX\n", "A\n\nB\n\nX\n"],
      ["", "mới hub\n", "mới repo\n"],
    ];
    for (const [o, a, b] of cases) {
      const rows = conflictRows(o, a, b);
      const merged = mergeBlocks(o, a, b);
      expect(rows.filter((r) => r.kind === "conflict").length).toBe(merged.conflicts);
      if (!merged.conflicts) expect(markedMerge(rows)).toBe(merged.content);
    }
  });

  it("bản hợp có đánh dấu giữ cả hai bên giữa các dòng đánh dấu", () => {
    const merged = markedMerge(conflictRows(base, hub, repo));
    expect(merged).toBe(
      [
        "# Tiêu đề",
        "Mở đầu.",
        CONFLICT_MARK.hub,
        "Bước một (hub).",
        CONFLICT_MARK.split,
        "Bước một (repo).",
        CONFLICT_MARK.repo,
        "Bước hai.",
        "Kết luận hub.",
      ].join("\n\n") + "\n",
    );
    expect(hasConflictMarks(merged)).toBe(true);
    expect(hasConflictMarks("Dòng === bình thường\n\n=======\n")).toBe(false);
  });
});

describe("ConflictView", () => {
  it("hiện ba bản kèm phiên bản, commit rút gọn và tô khối xung đột", async () => {
    const host = await render(<ConflictView conflict={detail()} onResolve={() => {}} />);
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(["Bản gốc chung" + "Phiên bản 3", "Bản hub" + "Phiên bản 5", "Bản repo" + "Commit 0123456"]);
    const conflictCells = [...host.querySelectorAll('[data-kind="conflict"]')];
    expect(conflictCells.map((c) => c.getAttribute("data-col"))).toEqual(["base", "hub", "repo"]);
    expect(host.querySelector('[data-kind="conflict"][data-col="hub"]')?.textContent).toContain("Bước một (hub).");
    expect(host.querySelector('[data-kind="conflict"][data-col="repo"]')?.textContent).toContain("Bước một (repo).");
    expect(host.textContent).toContain("cùng sửa 1 chỗ khác nhau");
  });

  it("thu gọn các khối không đổi và mở ra khi bấm Hiện", async () => {
    const host = await render(<ConflictView conflict={detail()} onResolve={() => {}} />);
    expect(host.querySelector('[data-kind="same"]')).toBeNull();
    expect(host.textContent).toContain("2 khối không đổi");
    expect(host.textContent).toContain("1 khối không đổi");
    await act(async () => button(host, "Hiện").click());
    expect(host.querySelectorAll('[data-kind="same"]').length).toBeGreaterThan(0);
  });

  it("trên màn hẹp chọn tab thì chỉ cột đó hiện, cột khác mang max-md:hidden", async () => {
    const host = await render(<ConflictView conflict={detail()} onResolve={() => {}} />);
    const cls = (col: string) => host.querySelector(`[data-kind="conflict"][data-col="${col}"]`)?.className ?? "";
    expect(cls("hub")).not.toContain("max-md:hidden");
    expect(cls("repo")).toContain("max-md:hidden");
    await act(async () => (host.querySelector('[role="tab"]:nth-child(3)') as HTMLElement).click());
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Bản repo");
    expect(cls("repo")).not.toContain("max-md:hidden");
    expect(cls("hub")).toContain("max-md:hidden");
  });

  it("Giữ bản hub và Giữ bản repo gọi onResolve với lựa chọn tương ứng", async () => {
    const onResolve = vi.fn<(r: ConflictResolution) => void>();
    const host = await render(<ConflictView conflict={detail()} onResolve={onResolve} />);
    await act(async () => button(host, "Giữ bản hub").click());
    await act(async () => button(host, "Giữ bản repo").click());
    expect(onResolve.mock.calls.map(([r]) => r)).toEqual([{ choice: "hub" }, { choice: "repo" }]);
  });

  it("Sửa tay mở bản hợp có đánh dấu, chặn lưu khi còn dấu và gửi nội dung đã sửa", async () => {
    const onResolve = vi.fn<(r: ConflictResolution) => void>();
    const host = await render(<ConflictView conflict={detail()} onResolve={onResolve} />);
    await act(async () => button(host, "Sửa tay").click());
    const area = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(area.value).toContain(CONFLICT_MARK.hub);
    expect(area.value).toContain("Bước một (repo).");
    expect(button(host, "Lưu bản đã sửa").disabled).toBe(true);
    expect(host.textContent).toContain("Còn dòng đánh dấu xung đột");

    const fixed = "# Tiêu đề\n\nBước một (gộp).\n";
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      set?.call(area, fixed);
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button(host, "Lưu bản đã sửa").disabled).toBe(false);
    await act(async () => button(host, "Lưu bản đã sửa").click());
    expect(onResolve).toHaveBeenCalledWith({ choice: "manual", content: fixed });

    await act(async () => button(host, "Huỷ").click());
    expect(host.querySelector("textarea")).toBeNull();
  });

  it("đang xử lý thì khoá nút; đã giải quyết thì ẩn nút; có lỗi thì báo", async () => {
    const busy = await render(<ConflictView conflict={detail()} onResolve={() => {}} busy error="Phiên bản đã đổi." />);
    expect(button(busy, "Giữ bản hub").disabled).toBe(true);
    expect(busy.textContent).toContain("Phiên bản đã đổi.");
    const done = await render(<ConflictView conflict={detail({ state: "resolved" })} onResolve={() => {}} />);
    expect(done.textContent).toContain("đã được giải quyết");
    expect([...done.querySelectorAll("button")].some((b) => b.textContent === "Giữ bản hub")).toBe(false);
  });

  it("dùng tiếng Anh theo prop lang", async () => {
    const host = await render(<ConflictView conflict={detail()} onResolve={() => {}} lang="en" />);
    expect(host.textContent).toContain("Keep hub version");
    expect(host.textContent).toContain("Common base");
  });
});
