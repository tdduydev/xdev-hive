import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_POLL_MS, SecretApprovalDialog } from "@/components/secret-approval-dialog.tsx";
import { setLang } from "@/lib/i18n.ts";
import type { ApprovalRequest } from "@/lib/secrets.ts";

const request = (id: string, over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id,
  runId: `run_${id}#1`,
  project: "3f9a1c0e7b2d4a55",
  projectName: "shop-api",
  names: ["STRIPE_TEST_KEY", "DATABASE_URL"],
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  ...over,
});

interface Call {
  command: string;
  args?: Record<string, unknown> | undefined;
}

/** Worker giả: `queue` là các yêu cầu đang chờ; trả lời xong thì yêu cầu rời hàng. */
function fakeApp(queue: ApprovalRequest[], failApprove?: string) {
  const calls: Call[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "secret_approvals") return { pending: [...queue] } as T;
        if (command === "secret_approve") {
          if (failApprove) throw failApprove;
          const at = queue.findIndex((r) => r.id === args?.id);
          if (at >= 0) queue.splice(at, 1);
          return null as T;
        }
        throw new Error(`lệnh chưa giả: ${command}`);
      },
    },
  };
  return calls;
}

const tick = (ms = APPROVAL_POLL_MS) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("hộp thoại duyệt bí mật", () => {
  beforeEach(() => {
    setLang("vi");
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  it("hỏi mỗi 2 giây; không có yêu cầu thì không hiện gì", async () => {
    const calls = fakeApp([]);
    render(<SecretApprovalDialog />);
    await tick(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    const asked = () => calls.filter((c) => c.command === "secret_approvals").length;
    expect(asked()).toBe(1);
    await tick();
    expect(asked()).toBe(2);
    await tick();
    expect(asked()).toBe(3);
  });

  it("hiện tên và dự án, không giá trị; nút Từ chối được focus trước; Từ chối gửi allow=false", async () => {
    const queue = [request("a1")];
    const calls = fakeApp(queue);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SecretApprovalDialog />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/dự án shop-api/)).toBeTruthy();
    expect(within(dialog).getByText("STRIPE_TEST_KEY")).toBeTruthy();
    expect(within(dialog).getByText("DATABASE_URL")).toBeTruthy();
    expect(within(dialog).getByText(/run_a1#1/)).toBeTruthy();
    const deny = within(dialog).getByRole("button", { name: "Từ chối" });
    await waitFor(() => expect(document.activeElement).toBe(deny));
    expect(calls.some((c) => c.command === "secret_approve")).toBe(false);

    await user.click(deny);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.command === "secret_approve")?.args).toEqual({ id: "a1", allow: false });
    // Lượt hỏi sau không hiện lại yêu cầu đã trả lời.
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Cho phép gửi allow=true; yêu cầu tiếp theo hiện sau đó", async () => {
    const queue = [request("a1"), request("a2", { names: ["API_TOKEN"], projectName: "web" })];
    const calls = fakeApp(queue);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SecretApprovalDialog />);
    const first = await screen.findByRole("dialog");
    expect(within(first).getByText("Còn 1 yêu cầu khác đang chờ.")).toBeTruthy();
    await user.click(within(first).getByRole("button", { name: "Cho phép" }));
    expect(await screen.findByText("API_TOKEN")).toBeTruthy();
    expect(calls.find((c) => c.command === "secret_approve")?.args).toEqual({ id: "a1", allow: true });
    expect(screen.queryByText("Còn 1 yêu cầu khác đang chờ.")).toBeNull();
  });

  it("Esc là Từ chối", async () => {
    const calls = fakeApp([request("a1")]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SecretApprovalDialog />);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(calls.find((c) => c.command === "secret_approve")?.args).toEqual({ id: "a1", allow: false }),
    );
  });

  it("worker từ chối trả lời: hiện lỗi và cho thử lại", async () => {
    fakeApp([request("a1")], "Yêu cầu đã hết hạn.");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SecretApprovalDialog />);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Từ chối" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(within(dialog).getByText("Yêu cầu đã hết hạn.")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Từ chối" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("yêu cầu đã quá hạn không hiện; worker cũ chưa có lệnh thì im lặng", async () => {
    fakeApp([request("old", { expiresAt: new Date(Date.now() - 1000).toISOString() })]);
    render(<SecretApprovalDialog />);
    await tick(0);
    expect(screen.queryByRole("dialog")).toBeNull();

    window.__TAURI__ = {
      core: {
        invoke: async () => {
          throw new Error("lệnh chưa có");
        },
      },
    };
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
