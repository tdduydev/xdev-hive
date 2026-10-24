import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutboxBanner, OutboxPanel } from "@/components/outbox-panel.tsx";
import { queryClient } from "@/lib/hub-query.tsx";
import { setLang } from "@/lib/i18n.ts";
import type { OutboxItem, OutboxStatus } from "@/lib/outbox.ts";

const item = (state: OutboxItem["state"]): OutboxItem => ({
  key: `0123456789abcdef-${state}`,
  kind: "doc_propose",
  title: `Tài liệu ${state}`,
  state,
  attempts: 1,
  createdAt: "2026-10-23T00:00:00Z",
});
const empty: OutboxStatus = { hub: "up", pending: 0, held: 0, rejected: 0, expired: 0, items: [] };
beforeEach(() => {
  setLang("vi");
  queryClient.clear();
});
afterEach(() => {
  vi.useRealTimers();
  queryClient.clear();
});

function fake(status: OutboxStatus = empty) {
  let data = status;
  let changed: (() => void) | undefined;
  const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>): Promise<unknown> => {
    if (command === "outbox_status") return data;
    if (command === "outbox_export") return { path: "E:/outbox.json", count: 1 };
    data = empty;
    return {};
  });
  window.__TAURI__ = {
    core: { invoke: invoke as <T>(command: string, args?: Record<string, unknown>) => Promise<T> },
    event: {
      listen: async (event, handler) => {
        if (event === "outbox-changed") changed = () => handler({ payload: {} as never });
        return () => {
          changed = undefined;
        };
      },
    },
  };
  return {
    invoke,
    update: (next: OutboxStatus) => {
      data = next;
      changed?.();
    },
  };
}

describe("Hộp thư đi", () => {
  it("hiện held, rejected, expired cùng khoá, mã và lý do", async () => {
    fake({
      ...empty,
      held: 1,
      rejected: 1,
      expired: 1,
      items: [
        { ...item("held"), heldReason: "login_required" },
        { ...item("rejected"), code: "DOC_VERSION_CONFLICT", reason: "Phiên bản đã đổi." },
        item("expired"),
      ],
    });
    render(<OutboxPanel />);
    expect(await screen.findByText("DOC_VERSION_CONFLICT")).toBeTruthy();
    expect(screen.getByText("Phiên bản đã đổi.")).toBeTruthy();
    expect(screen.getByText("Cần đăng nhập lại.")).toBeTruthy();
    expect(screen.getByText(item("expired").key)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: `Gửi lại: ${item("rejected").key}` }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it.each(["drop", "retry", "export"])("%s dùng đúng khoá và cập nhật màn", async (kind) => {
    const { invoke } = fake({ ...empty, held: 1, items: [item("held")] });
    render(<OutboxPanel />);
    const label = { drop: "Bỏ", retry: "Gửi lại", export: "Xuất" }[kind];
    await userEvent.setup().click(await screen.findByRole("button", { name: `${label}: ${item("held").key}` }));
    expect(invoke).toHaveBeenCalledWith(`outbox_${kind}`, { key: item("held").key });
    if (kind === "export") expect(await screen.findByText("Đã xuất ra E:/outbox.json")).toBeTruthy();
    else expect(await screen.findByText("Không có mục nào trong hộp thư đi.")).toBeTruthy();
  });

  it("huỷ chọn file không báo xuất thành công", async () => {
    const { invoke } = fake({ ...empty, items: [item("held")] });
    render(<OutboxPanel />);
    const button = await screen.findByRole("button", { name: /^Xuất:/ });
    invoke.mockResolvedValueOnce(null);
    await userEvent.setup().click(button);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("outbox_export", { key: item("held").key }));
    expect(screen.queryByText(/Đã xuất ra/)).toBeNull();
  });

  it.each(["down", "retrying"] as const)(
    "thanh trạng thái khi hub %s nhận sự kiện và hỏi lại sau 5 giây",
    async (hub) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const { invoke, update } = fake({ ...empty, hub, pending: 3 });
      const view = render(<OutboxBanner />);
      expect(await screen.findByText("Hub đang vắng – 3 mục chờ gửi")).toBeTruthy();
      await waitFor(() => expect(window.__TAURI__?.event).toBeTruthy());
      await act(async () => {
        update({ ...empty, hub, pending: 2 });
      });
      expect(await screen.findByText("Hub đang vắng – 2 mục chờ gửi")).toBeTruthy();
      const calls = invoke.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(invoke.mock.calls.length).toBeGreaterThan(calls);
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("lỗi thao tác hiện tiếng Việt và giữ mục để thử lại", async () => {
    const { invoke } = fake({ ...empty, items: [item("held")] });
    render(<OutboxPanel />);
    const button = await screen.findByRole("button", { name: /^Bỏ:/ });
    invoke.mockRejectedValueOnce(new Error("Không bỏ được mục đang gửi."));
    await userEvent.setup().click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("Không bỏ được mục đang gửi.");
    expect(screen.getByText(item("held").key)).toBeTruthy();
  });

  it("lỗi đọc có nút làm mới", async () => {
    const { invoke } = fake();
    invoke.mockRejectedValue(new Error("Sidecar hive-worker không chạy."));
    render(<OutboxPanel />);
    expect((await screen.findByRole("alert")).textContent).toContain("Sidecar hive-worker không chạy.");
    invoke.mockResolvedValue(empty);
    await userEvent.setup().click(screen.getByRole("button", { name: "Làm mới" }));
    expect(await screen.findByText("Không có mục nào trong hộp thư đi.")).toBeTruthy();
  });

  it("tiếng Anh và trạng thái rỗng", async () => {
    fake();
    setLang("en");
    render(<OutboxPanel />);
    const panel = screen.getByRole("region", { name: "Outbox" });
    expect(await within(panel).findByText("The outbox is empty.")).toBeTruthy();
  });
});
