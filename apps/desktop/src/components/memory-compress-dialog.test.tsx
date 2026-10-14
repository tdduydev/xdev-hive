import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryCompressDialog } from "@/components/memory-compress-dialog.tsx";
import { setLang } from "@/lib/i18n.ts";

const A = "/home/u/.claude/projects/-app/memory/deploy.md";
const B = "/home/u/.claude/projects/-app/memory/style.md";

const proposal = (path: string, before: string, content: string, newLines: number[]) => ({
  path,
  before,
  content,
  tokensBefore: 30,
  tokensAfter: 12,
  newLines,
});

/** Tauri giả: ghi lại lệnh; `fail` làm lệnh đó trả lỗi. */
function fakeTauri(compression: unknown, fail?: { command: string; message: string }) {
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (fail && fail.command === command) throw fail.message;
        if (command === "memory_compress") return compression as T;
        if (command === "memory_apply") return { entry: `bk-${calls.length}` } as T;
        throw new Error(`lệnh chưa giả: ${command}`);
      },
    },
  };
  return calls;
}

const renderDialog = (onApplied = () => {}) =>
  render(<MemoryCompressDialog open onOpenChange={() => {}} profile="claude-2" project="-app" onApplied={onApplied} />);

beforeEach(() => setLang("vi"));

describe("MemoryCompressDialog", () => {
  it("does nothing until asked, then shows the diff with unsourced lines marked", async () => {
    const calls = fakeTauri({
      files: [proposal(A, "deploy bằng pnpm\nlặp lại\n", "deploy bằng pnpm\nluôn dùng Node 24\n", [2])],
      tokensUsed: 1234,
      warnings: ["Bỏ qua đề xuất rỗng cho /x.md"],
    });
    renderDialog();
    expect(calls).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Gợi ý nén" }));
    await screen.findByText(A);
    expect(calls[0]).toEqual({
      command: "memory_compress",
      args: { profile: "claude-2", project: "-app", files: [] },
    });
    expect(screen.getByText("30 → 12 token mỗi phiên")).toBeTruthy();
    expect(screen.getByText(/Bỏ qua đề xuất rỗng/)).toBeTruthy();
    expect(screen.getByText(/1\.234 token/)).toBeTruthy();
    const fresh = document.querySelector("[data-unsourced]");
    expect(fresh?.textContent).toContain("luôn dùng Node 24");
    expect(document.querySelectorAll("[data-unsourced]")).toHaveLength(1);
    // Chỉ xem: chưa ghi gì.
    expect(calls.some((c) => c.command === "memory_apply")).toBe(false);
  });

  it("applies only the ticked files through memory_apply edit", async () => {
    const calls = fakeTauri({
      files: [proposal(A, "a\nb\n", "a\n", []), proposal(B, "x\ny\n", "x\n", [])],
      tokensUsed: 10,
      warnings: [],
    });
    let applied = 0;
    renderDialog(() => applied++);
    await userEvent.click(screen.getByRole("button", { name: "Gợi ý nén" }));
    await screen.findByText(A);
    await userEvent.click(screen.getAllByRole("checkbox")[1] as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "Áp dụng 1 file" }));

    await screen.findByText(/Đã áp dụng 1 file\. Mã khôi phục: bk-/);
    const edits = calls.filter((c) => c.command === "memory_apply");
    expect(edits).toEqual([
      { command: "memory_apply", args: { operation: { action: "edit", path: A, content: "a\n" } } },
    ]);
    expect(applied).toBe(1);
  });

  it("stops at the first failed write and keeps the proposals", async () => {
    const calls = fakeTauri(
      { files: [proposal(A, "a\nb\n", "a\n", []), proposal(B, "x\ny\n", "x\n", [])], tokensUsed: 10, warnings: [] },
      { command: "memory_apply", message: "không phải file memory mà app đã quét" },
    );
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "Gợi ý nén" }));
    await screen.findByText(A);
    await userEvent.click(screen.getByRole("button", { name: "Áp dụng 2 file" }));

    await screen.findByText("không phải file memory mà app đã quét");
    expect(calls.filter((c) => c.command === "memory_apply")).toHaveLength(1);
    expect(screen.getByText(B)).toBeTruthy();
  });

  it("shows the worker error and lets the user retry; empty result says nothing to compress", async () => {
    fakeTauri(null, { command: "memory_compress", message: "không tìm thấy lệnh claude trên máy" });
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "Gợi ý nén" }));
    await screen.findByText("không tìm thấy lệnh claude trên máy");
    expect(screen.getByRole("button", { name: "Gợi ý lại" })).toBeTruthy();

    fakeTauri({ files: [], tokensUsed: 5, warnings: [] });
    await userEvent.click(screen.getByRole("button", { name: "Gợi ý lại" }));
    await waitFor(() => expect(screen.getByText(/không thấy gì cần nén/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Áp dụng/ })).toBeNull();
  });

  it("passes chosen files to the worker and speaks English when asked", async () => {
    setLang("en");
    const calls = fakeTauri({ files: [], tokensUsed: 0, warnings: [] });
    render(<MemoryCompressDialog open onOpenChange={() => {}} profile="claude-2" project="-app" files={[A]} />);
    await userEvent.click(screen.getByRole("button", { name: "Suggest compression" }));
    await screen.findByText(/found nothing to compress/);
    expect(calls[0]?.args).toEqual({ profile: "claude-2", project: "-app", files: [A] });
  });
});
