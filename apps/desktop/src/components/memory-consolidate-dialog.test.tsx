import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryConsolidateDialog } from "@/components/memory-consolidate-dialog.tsx";
import { setLang } from "@/lib/i18n.ts";

const dir = "/home/u/.claude/projects/-app/memory";
const A = `${dir}/deploy.md`;
const B = `${dir}/release.md`;
const C = `${dir}/style.md`;
const D = `${dir}/lint.md`;

const merge = (sources: string[], target: string, content: string, newLines: number[] = []) => ({
  sources,
  target,
  reason: "cùng chủ đề",
  before: "deploy bằng pnpm\n\nrelease qua nhánh release\n",
  content,
  tokensBefore: 40,
  tokensAfter: 25,
  newLines,
});

/** Tauri giả: ghi lại lệnh; `fail` làm lệnh đó trả lỗi. */
function fakeTauri(consolidation: unknown, fail?: { command: string; message: string }) {
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (fail && fail.command === command) throw fail.message;
        if (command === "memory_consolidate") return consolidation as T;
        if (command === "memory_apply") return { entry: `bk-${calls.length}` } as T;
        throw new Error(`lệnh chưa giả: ${command}`);
      },
    },
  };
  return calls;
}

const renderDialog = (onApplied = () => {}) =>
  render(
    <MemoryConsolidateDialog open onOpenChange={() => {}} profile="claude-2" project="-app" onApplied={onApplied} />,
  );

beforeEach(() => setLang("vi"));

describe("MemoryConsolidateDialog", () => {
  it("does nothing until asked, then shows each group with its diff and new lines marked", async () => {
    const calls = fakeTauri({
      merges: [merge([A, B], A, "deploy bằng pnpm\nrelease qua nhánh release\nchạy CI trước\n", [3])],
      tokensUsed: 2048,
      warnings: ["Bỏ qua nhóm chỉ có một file: style.md"],
    });
    renderDialog();
    expect(calls).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Đánh giá" }));
    await screen.findByText("deploy.md + release.md gộp vào deploy.md");
    expect(calls[0]).toEqual({ command: "memory_consolidate", args: { profile: "claude-2", project: "-app" } });
    expect(screen.getByText("cùng chủ đề")).toBeTruthy();
    expect(screen.getByText("40 → 25 token mỗi phiên")).toBeTruthy();
    expect(screen.getByText(/Bỏ qua nhóm chỉ có một file/)).toBeTruthy();
    expect(screen.getByText(/2\.048 token/)).toBeTruthy();
    expect(document.querySelectorAll("[data-unsourced]")).toHaveLength(1);
    expect(document.querySelector("[data-unsourced]")?.textContent).toContain("chạy CI trước");
    expect(calls.some((c) => c.command === "memory_apply")).toBe(false);
  });

  it("merges only the ticked groups through memory_apply merge", async () => {
    const calls = fakeTauri({
      merges: [merge([A, B], A, "gộp 1\n"), merge([C, D], C, "gộp 2\n")],
      tokensUsed: 10,
      warnings: [],
    });
    let applied = 0;
    renderDialog(() => applied++);
    await userEvent.click(screen.getByRole("button", { name: "Đánh giá" }));
    await screen.findByText("deploy.md + release.md gộp vào deploy.md");
    await userEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "Gộp 1 nhóm" }));

    await screen.findByText(/Đã gộp 1 nhóm\. Mã khôi phục: bk-/);
    expect(calls.filter((c) => c.command === "memory_apply")).toEqual([
      {
        command: "memory_apply",
        args: { operation: { action: "merge", sources: [C, D], target: C, content: "gộp 2\n" } },
      },
    ]);
    expect(applied).toBe(1);
  });

  it("stops at the first failed merge and keeps the groups", async () => {
    const calls = fakeTauri(
      { merges: [merge([A, B], A, "1\n"), merge([C, D], C, "2\n")], tokensUsed: 10, warnings: [] },
      { command: "memory_apply", message: "file đích đã đổi trên đĩa" },
    );
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "Đánh giá" }));
    await userEvent.click(await screen.findByRole("button", { name: "Gộp 2 nhóm" }));

    await screen.findByText("file đích đã đổi trên đĩa");
    expect(calls.filter((c) => c.command === "memory_apply")).toHaveLength(1);
    expect(screen.getByText("style.md + lint.md gộp vào style.md")).toBeTruthy();
  });

  it("says when nothing is worth merging and speaks English when asked", async () => {
    setLang("en");
    fakeTauri({ merges: [], tokensUsed: 3, warnings: [] });
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByText(/found no files worth merging/);
    expect(screen.queryByRole("button", { name: /Merge/ })).toBeNull();
  });
});
