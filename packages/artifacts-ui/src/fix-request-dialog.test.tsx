import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ArtifactPageError } from "@xdev-hive/contracts";
import { describe, expect, it, vi } from "vitest";
import { FixRequestDialog } from "./fix-request-dialog.tsx";
import { detail, fakeClient, ID_A, ID_B, renderWithEnv, testEnv } from "./test-fixtures.tsx";

const THREAD = "00000000-0000-4000-8000-0000000000d1";

function setup(opts: { write?: boolean; canAskLeader?: boolean } = {}) {
  const found = detail({ write: opts.write ?? true });
  const base = fakeClient({ [ID_A]: found });
  const client = {
    artifacts: {
      ...base.artifacts,
      askLeaderFix: vi.fn(async (_input: unknown) => ({ threadId: ID_B, messageId: ID_B, runId: null })),
    },
  };
  const env = testEnv(client as never, { canAskLeader: opts.canAskLeader ?? true });
  const onSent = vi.fn();
  const onOpenChange = vi.fn();
  const view = (errors: ArtifactPageError[], threadId: string | null = THREAD) => (
    <FixRequestDialog
      request={{ artifact: found.artifact, version: 1, errors }}
      threadId={threadId ?? undefined}
      open
      onOpenChange={onOpenChange}
      onSent={onSent}
    />
  );
  return { client, env, view, onSent };
}

const errs = (n: number): ArtifactPageError[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "error" as const, message: `Lỗi số ${i + 1}` }));

describe("FixRequestDialog", () => {
  it("cắt hộp lỗi ở 20 mục và chỉ gửi 20 lỗi đầu", async () => {
    const { client, env, view } = setup();
    renderWithEnv(view(errs(25)), env);
    expect(await screen.findByText(/20 lỗi sẽ được gửi \(trên tổng 25\)/)).toBeTruthy();
    expect(screen.getByText(/Chỉ gửi 20 lỗi đầu tiên/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Gửi yêu cầu sửa" }));
    await waitFor(() => expect(client.artifacts.askLeaderFix).toHaveBeenCalled());
    const sent = client.artifacts.askLeaderFix.mock.calls[0]?.[0] as { errors: ArtifactPageError[]; threadId?: string };
    expect(sent.errors).toHaveLength(20);
    expect(sent.errors[19]?.message).toBe("Lỗi số 20");
    expect(sent.threadId).toBe(THREAD);
  });

  it("bỏ lỗi, sửa lời nhắn và gửi vào cuộc trò chuyện mới", async () => {
    const { client, env, view, onSent } = setup();
    renderWithEnv(view(errs(2)), env);
    await userEvent.click((await screen.findAllByRole("button", { name: /Bỏ lỗi này/ }))[0] as HTMLElement);
    await userEvent.type(screen.getByLabelText(/Lời nhắn/), "Hiện chữ khi rỗng");
    await userEvent.click(screen.getByRole("radio", { name: /Cuộc trò chuyện mới/ }));
    await userEvent.click(screen.getByRole("button", { name: "Gửi yêu cầu sửa" }));

    await waitFor(() => expect(onSent).toHaveBeenCalledWith({ threadId: ID_B, messageId: ID_B, runId: null }));
    expect(client.artifacts.askLeaderFix.mock.calls[0]?.[0]).toEqual({
      id: ID_A,
      version: 1,
      errors: [{ kind: "error", message: "Lỗi số 2" }],
      note: "Hiện chữ khi rỗng",
    });
    expect(await screen.findByText(/Đã gửi yêu cầu/)).toBeTruthy();
  });

  it("không gửi được khi bỏ hết lỗi và không có lời nhắn", async () => {
    const { env, view } = setup();
    renderWithEnv(view(errs(1)), env);
    await userEvent.click(await screen.findByRole("button", { name: /Bỏ lỗi này/ }));
    expect(screen.getByText(/Bạn đã bỏ hết lỗi/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Gửi yêu cầu sửa" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("không có threadId thì chỉ còn đích cuộc trò chuyện mới", async () => {
    const { env, view } = setup();
    renderWithEnv(view(errs(1), null), env);
    await screen.findByRole("radio", { name: /Cuộc trò chuyện mới/ });
    expect(screen.queryByRole("radio", { name: "Cuộc trò chuyện này" })).toBeNull();
  });

  it("tắt gửi khi người xem chưa dùng được Leader; chỉ đọc thì báo sẽ nhân bản", async () => {
    const { env, view } = setup({ canAskLeader: false, write: false });
    renderWithEnv(view(errs(1)), env);
    expect(await screen.findByText("Bạn chưa dùng được Leader ở đây.")).toBeTruthy();
    expect(await screen.findByText(/nhân bản thành artifact cá nhân/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Gửi yêu cầu sửa" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
