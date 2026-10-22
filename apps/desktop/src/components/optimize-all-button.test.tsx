import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OptimizeAllButton } from "@/components/optimize-all-button.tsx";
import { setLang } from "@/lib/i18n.ts";
import type { OptimizePlan, OptimizeRun, PlanStep } from "@/lib/optimize-all.ts";

const only: PlanStep = {
  id: "score.recompute",
  group: "score",
  target: "machine",
  title: "Tính lại điểm",
  changes: [],
  selected: true,
  requiresConfirm: false,
  undoable: true,
  reason: "Mặc định",
};

const plan: OptimizePlan = {
  createdAt: "2026-10-23T09:00:00Z",
  scoreBefore: 48,
  policySources: [],
  steps: [only],
};

function fakeTauri(run?: OptimizeRun) {
  const calls: string[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string) => {
        calls.push(command);
        if (command === "optimize_all_preview") return plan as T;
        if (command === "optimize_all_apply" && run) return run as T;
        throw new Error(`lệnh chưa giả: ${command}`);
      },
    },
  };
  return calls;
}

beforeEach(() => setLang("vi"));

describe("OptimizeAllButton", () => {
  it("chưa bấm thì không gọi gì; bấm mở hộp xem trước, vẫn chưa ghi gì", async () => {
    const user = userEvent.setup();
    const calls = fakeTauri();
    render(<OptimizeAllButton />);
    expect(calls).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Tối ưu" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(await screen.findByText("Tính lại điểm")).toBeTruthy();
    expect(calls).toEqual(["optimize_all_preview"]);
  });

  it("áp dụng xong thì gọi onDone để thẻ điểm đọc lại", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    fakeTauri({
      id: "r1",
      startedAt: "x",
      finishedAt: "y",
      scoreBefore: 48,
      scoreAfter: 60,
      policySources: [],
      undoneAt: null,
      steps: [{ ...only, status: "ok", error: null, undo: {} }],
    });
    render(<OptimizeAllButton onDone={onDone} />);
    await user.click(screen.getByRole("button", { name: "Tối ưu" }));
    await user.click(await screen.findByRole("button", { name: "Áp dụng 1 dòng" }));
    await screen.findByText("Điểm sau");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("disabled thì không mở hộp", async () => {
    const user = userEvent.setup();
    const calls = fakeTauri();
    render(<OptimizeAllButton disabled />);
    await user.click(screen.getByRole("button", { name: "Tối ưu" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toEqual([]);
  });
});
