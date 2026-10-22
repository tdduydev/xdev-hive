import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OptimizePreviewDialog } from "@/components/optimize-preview-dialog.tsx";
import { setLang } from "@/lib/i18n.ts";
import type { OptimizePlan, OptimizeRun, PlanStep, RunStep } from "@/lib/optimize-all.ts";

type Handler = (args?: Record<string, unknown>) => unknown;

function fakeTauri(handlers: Record<string, Handler>) {
  const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const handler = handlers[command];
        if (!handler) throw new Error(`lệnh chưa giả: ${command}`);
        return (await handler(args)) as T;
      },
    },
  };
  return calls;
}

const step = (over: Partial<PlanStep> & Pick<PlanStep, "id" | "group" | "title">): PlanStep => ({
  target: "claude-2",
  changes: [],
  selected: true,
  requiresConfirm: false,
  undoable: true,
  reason: "Mặc định",
  ...over,
});

const plan = (): OptimizePlan => ({
  createdAt: "2026-10-23T09:00:00Z",
  scoreBefore: 48,
  policySources: [],
  steps: [
    step({
      id: "optimizer.enable",
      group: "cli",
      title: "Bật tối ưu balanced cho Claude 2",
      changes: [{ file: "settings.json", key: "level", before: null, after: "balanced" }],
      reason: "Theo chính sách dự án Acme Web",
    }),
    step({
      id: "optimizer.enable",
      group: "cli",
      title: "Đổi tối ưu của Claude 2 sang aggressive",
      changes: [{ file: "settings.json", key: "level", before: "balanced", after: "aggressive" }],
      selected: false,
      requiresConfirm: true,
      level: "aggressive",
    }),
    step({ id: "tool.rtk", group: "tools", target: "rtk", title: "Cài rtk", undoable: false }),
    step({ id: "context.sync", group: "context", target: "web", title: "Cập nhật khối ngữ cảnh của web" }),
    step({ id: "score.recompute", group: "score", target: "machine", title: "Tính lại điểm" }),
  ],
});

const runOf = (p: OptimizePlan, over: Partial<OptimizeRun> = {}): OptimizeRun => ({
  id: "run-1",
  startedAt: "2026-10-23T09:00:02Z",
  finishedAt: "2026-10-23T09:00:10Z",
  scoreBefore: 48,
  scoreAfter: 81,
  policySources: [],
  undoneAt: null,
  steps: p.steps.map(
    (s): RunStep => ({ ...s, status: s.selected ? "ok" : "skipped", error: null, undo: s.selected ? {} : null }),
  ),
  ...over,
});

const renderOpen = (props: Partial<Parameters<typeof OptimizePreviewDialog>[0]> = {}) => {
  const onOpenChange = vi.fn();
  render(<OptimizePreviewDialog open onOpenChange={onOpenChange} {...props} />);
  return onOpenChange;
};

beforeEach(() => setLang("vi"));

describe("OptimizePreviewDialog: xem trước", () => {
  it("chỉ gọi xem trước, nhóm theo group và ghi lý do, không ghi gì", async () => {
    const calls = fakeTauri({ optimize_all_preview: () => plan() });
    renderOpen();
    expect(await screen.findByRole("heading", { name: "Cấu hình CLI" })).toBeTruthy();
    for (const name of ["Công cụ", "Ngữ cảnh", "Điểm"]) expect(screen.getByRole("heading", { name })).toBeTruthy();
    expect(screen.getByText("Lý do: Theo chính sách dự án Acme Web")).toBeTruthy();
    expect(screen.getByText("settings.json · level: (chưa có) → balanced")).toBeTruthy();
    expect(calls.map((c) => c.command)).toEqual(["optimize_all_preview"]);
    expect(calls[0]?.args).toEqual({ policy: null });
  });

  it("chuyển chính sách dự án cho xem trước", async () => {
    const calls = fakeTauri({ optimize_all_preview: () => plan() });
    renderOpen({ policy: { p1: { level: "balanced" } } });
    await screen.findByRole("heading", { name: "Công cụ" });
    expect(calls[0]?.args).toEqual({ policy: { p1: { level: "balanced" } } });
  });

  it("dòng aggressive không chọn sẵn, có cảnh báo, và số dòng đã chọn đúng", async () => {
    fakeTauri({ optimize_all_preview: () => plan() });
    renderOpen();
    const aggressive = (await screen.findByRole("checkbox", {
      name: "Chọn: Đổi tối ưu của Claude 2 sang aggressive",
    })) as HTMLInputElement;
    expect(aggressive.checked).toBe(false);
    expect(screen.getByText(/Mức Mạnh: Claude dùng Sonnet/)).toBeTruthy();
    expect(screen.getByText("Đã chọn 4/5 dòng")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Áp dụng 4 dòng" })).toBeTruthy();
  });

  it("cảnh báo dòng cần chọn tay khi không phải aggressive", async () => {
    const p = plan();
    p.steps[1] = { ...(p.steps[1] as PlanStep), level: "balanced", title: "Đổi mô hình" };
    fakeTauri({ optimize_all_preview: () => p });
    renderOpen();
    expect(await screen.findByText(/Cần bạn chọn tay/)).toBeTruthy();
  });

  it("công cụ đã cài ghi rõ không hoàn tác được", async () => {
    fakeTauri({ optimize_all_preview: () => plan() });
    renderOpen();
    expect(await screen.findByText("Không hoàn tác được: công cụ đã cài không gỡ.")).toBeTruthy();
  });

  it("bỏ chọn một dòng thì chỉ gửi các dòng còn chọn, các trường khác giữ nguyên", async () => {
    const user = userEvent.setup();
    const p = plan();
    const calls = fakeTauri({ optimize_all_preview: () => p, optimize_all_apply: () => runOf(p) });
    renderOpen();
    await user.click(await screen.findByRole("checkbox", { name: "Chọn: Cài rtk" }));
    await user.click(screen.getByRole("checkbox", { name: "Chọn: Đổi tối ưu của Claude 2 sang aggressive" }));
    await user.click(screen.getByRole("button", { name: "Áp dụng 4 dòng" }));
    await screen.findByText("Điểm trước");
    const sent = calls.find((c) => c.command === "optimize_all_apply")?.args?.plan as OptimizePlan;
    expect(sent.steps.map((s) => s.selected)).toEqual([true, true, false, true, true]);
    expect(sent.steps.map((s) => ({ ...s, selected: true }))).toEqual(p.steps.map((s) => ({ ...s, selected: true })));
  });

  it("bỏ chọn hết thì không áp dụng được", async () => {
    const user = userEvent.setup();
    fakeTauri({ optimize_all_preview: () => ({ ...plan(), steps: [plan().steps[0] as PlanStep] }) });
    renderOpen();
    await user.click(await screen.findByRole("checkbox", { name: /Chọn: Bật tối ưu/ }));
    expect((screen.getByRole("button", { name: "Áp dụng 0 dòng" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("kế hoạch rỗng thì báo máy đã tối ưu và không có nút áp dụng", async () => {
    fakeTauri({ optimize_all_preview: () => ({ ...plan(), steps: [] }) });
    renderOpen();
    expect(await screen.findByText(/không có thay đổi nào cần làm/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Áp dụng/ })).toBeNull();
  });

  it("Huỷ đóng hộp mà không gọi áp dụng", async () => {
    const user = userEvent.setup();
    const calls = fakeTauri({ optimize_all_preview: () => plan() });
    const onOpenChange = renderOpen();
    await screen.findByRole("heading", { name: "Công cụ" });
    await user.click(screen.getByRole("button", { name: "Huỷ" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(calls.map((c) => c.command)).toEqual(["optimize_all_preview"]);
  });

  it("lỗi xem trước hiện bằng chữ và Thử lại dựng lại kế hoạch", async () => {
    const user = userEvent.setup();
    let fail = true;
    const calls = fakeTauri({
      optimize_all_preview: () => {
        if (fail) throw "Không chạy được worker.";
        return plan();
      },
    });
    renderOpen();
    expect(await screen.findByText("Không chạy được worker.")).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(await screen.findByRole("heading", { name: "Công cụ" })).toBeTruthy();
    expect(calls.filter((c) => c.command === "optimize_all_preview")).toHaveLength(2);
    expect(screen.queryByText("Không chạy được worker.")).toBeNull();
  });
});

describe("OptimizePreviewDialog: kết quả và hoàn tác", () => {
  it("hiện điểm trước → sau, từng dòng kèm trạng thái, lý do, và gọi onDone", async () => {
    const user = userEvent.setup();
    const p = plan();
    const onDone = vi.fn();
    fakeTauri({ optimize_all_preview: () => p, optimize_all_apply: () => runOf(p) });
    renderOpen({ onDone });
    await user.click(await screen.findByRole("button", { name: "Áp dụng 4 dòng" }));
    expect(await screen.findByText("Điểm trước")).toBeTruthy();
    expect(screen.getByText("48,0")).toBeTruthy();
    expect(screen.getByText("81,0")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Kết quả" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(within(rows[0] as HTMLElement).getByText("Xong")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Theo chính sách dự án Acme Web")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Bỏ qua")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Không hoàn tác được: công cụ đã cài không gỡ.")).toBeTruthy();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("một dòng lỗi hiện ✗ kèm lý do lỗi, các dòng khác vẫn xong", async () => {
    const user = userEvent.setup();
    const p = plan();
    const run = runOf(p);
    run.steps[3] = {
      ...(run.steps[3] as RunStep),
      status: "failed",
      error: "Khối ngữ cảnh đang bị sửa tay.",
      undo: null,
    };
    fakeTauri({ optimize_all_preview: () => p, optimize_all_apply: () => run });
    renderOpen();
    await user.click(await screen.findByRole("button", { name: "Áp dụng 4 dòng" }));
    const rows = within(await screen.findByRole("list", { name: "Kết quả" })).getAllByRole("listitem");
    expect(within(rows[3] as HTMLElement).getByText("Lỗi")).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText("Khối ngữ cảnh đang bị sửa tay.")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Xong")).toBeTruthy();
    expect(within(rows[4] as HTMLElement).getByText("Xong")).toBeTruthy();
    expect(screen.getByText("1 dòng lỗi, các dòng khác vẫn chạy.")).toBeTruthy();
  });

  it("Hoàn tác lần này gọi đúng id lần chạy, hiện bản đã hoàn tác và ẩn nút", async () => {
    const user = userEvent.setup();
    const p = plan();
    const run = runOf(p);
    const undone = runOf(p, {
      undoneAt: "2026-10-23T09:05:00Z",
      steps: run.steps.map((s) => (s.status === "ok" && s.undoable ? { ...s, status: "undone" as const } : s)),
    });
    const onDone = vi.fn();
    const calls = fakeTauri({
      optimize_all_preview: () => p,
      optimize_all_apply: () => run,
      optimize_all_undo: () => undone,
    });
    renderOpen({ onDone });
    await user.click(await screen.findByRole("button", { name: "Áp dụng 4 dòng" }));
    await user.click(await screen.findByRole("button", { name: "Hoàn tác lần này" }));
    expect(await screen.findByText(/Đã đảo các bước thành công/)).toBeTruthy();
    expect(calls.find((c) => c.command === "optimize_all_undo")?.args).toEqual({ runId: "run-1" });
    expect(screen.queryByRole("button", { name: "Hoàn tác lần này" })).toBeNull();
    expect(screen.getAllByText("Đã hoàn tác").length).toBeGreaterThan(1);
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it("không có bước nào hoàn tác được thì không hiện nút Hoàn tác", async () => {
    const user = userEvent.setup();
    const p: OptimizePlan = { ...plan(), steps: [plan().steps[2] as PlanStep] };
    fakeTauri({ optimize_all_preview: () => p, optimize_all_apply: () => runOf(p) });
    renderOpen();
    await user.click(await screen.findByRole("button", { name: "Áp dụng 1 dòng" }));
    await screen.findByText("Điểm trước");
    expect(screen.queryByRole("button", { name: "Hoàn tác lần này" })).toBeNull();
  });

  it("lỗi hoàn tác giữ kết quả và nút để thử lại", async () => {
    const user = userEvent.setup();
    const p = plan();
    fakeTauri({
      optimize_all_preview: () => p,
      optimize_all_apply: () => runOf(p),
      optimize_all_undo: () => {
        throw "Không hoàn tác được.";
      },
    });
    renderOpen();
    await user.click(await screen.findByRole("button", { name: "Áp dụng 4 dòng" }));
    await user.click(await screen.findByRole("button", { name: "Hoàn tác lần này" }));
    expect(await screen.findByText("Không hoàn tác được.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hoàn tác lần này" })).toBeTruthy();
  });
});

describe("OptimizePreviewDialog: khoá ở cửa sổ khác", () => {
  it("áp dụng bị khoá thì báo đang tối ưu ở cửa sổ khác, giữ lựa chọn và thử lại được", async () => {
    const user = userEvent.setup();
    const p = plan();
    let locked = true;
    const calls = fakeTauri({
      optimize_all_preview: () => p,
      optimize_all_apply: () => {
        if (locked) throw "Đang tối ưu ở cửa sổ khác.";
        return runOf(p);
      },
    });
    renderOpen();
    await user.click(await screen.findByRole("checkbox", { name: "Chọn: Cài rtk" }));
    await user.click(screen.getByRole("button", { name: "Áp dụng 3 dòng" }));
    expect(await screen.findByText(/Đang tối ưu ở cửa sổ khác/)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Chọn: Cài rtk" }) as HTMLInputElement).checked).toBe(false);
    locked = false;
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    await screen.findByText("Điểm trước");
    const applies = calls.filter((c) => c.command === "optimize_all_apply");
    expect(applies).toHaveLength(2);
    expect((applies[1]?.args?.plan as OptimizePlan | undefined)?.steps.map((s) => s.selected)).toEqual([
      true,
      false,
      false,
      true,
      true,
    ]);
    expect(calls.filter((c) => c.command === "optimize_all_preview")).toHaveLength(1);
  });

  it("xem trước bị khoá cũng báo cửa sổ khác", async () => {
    fakeTauri({
      optimize_all_preview: () => {
        throw "Đang tối ưu ở cửa sổ khác";
      },
    });
    renderOpen();
    expect(await screen.findByText(/Đang tối ưu ở cửa sổ khác/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Thử lại" })).toBeTruthy());
  });
});

describe("OptimizePreviewDialog: tiếng Anh", () => {
  it("đổi nhãn theo ngôn ngữ", async () => {
    setLang("en");
    fakeTauri({ optimize_all_preview: () => plan() });
    renderOpen();
    expect(await screen.findByRole("heading", { name: "CLI configuration" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply 4 rows" })).toBeTruthy();
  });
});
