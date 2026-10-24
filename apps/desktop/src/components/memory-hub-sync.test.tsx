import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryHubSync } from "@/components/memory-hub-sync.tsx";
import { type Account, AccountContext } from "@/lib/account.ts";
import { queryClient } from "@/lib/hub-query.tsx";
import { setLang } from "@/lib/i18n.ts";
import type { OutboxItem, OutboxStatus } from "@/lib/outbox.ts";

const ACCOUNT: Account = {
  name: "Phạm Hà",
  email: "ha@acme.vn",
  orgId: "o1",
  orgName: "Acme",
  orgRole: "member",
  teams: [{ id: "t1", name: "Thanh toán", role: "member" }],
};
const at = "2026-10-13T00:00:00.000Z";
const PROJECT_ID = "0a0a0a0a-0000-4000-8000-000000000001";
const by = { userId: "u1", runId: null };
const scope = { level: "project", teamId: null, projectId: PROJECT_ID };

const brief = {
  projectId: PROJECT_ID,
  content: "## Tổng quan\n\nDịch vụ thanh toán.",
  version: 2,
  commitSha: null,
  source: "user",
  updatedBy: by,
  updatedAt: at,
  headSha: null,
  commitsBehind: null,
  refreshRunId: null,
};
const approved = {
  id: "0a0a0a0a-0000-4000-8000-000000000004",
  kind: "decision",
  status: "approved",
  content: "Hoàn tiền đi qua bảng refunds.",
  files: [],
  scope,
  author: by,
  createdAt: at,
  supersededBy: null,
};
const hubProject = { id: PROJECT_ID, key: "pay", name: "Pay" };

const queuedItem: OutboxItem = {
  key: "01J9ZQ8M3K4N5P6R7S8T9V0W1X",
  kind: "memory.propose",
  stream: "memory.propose",
  source: "desktop",
  state: "pending",
  attempts: 0,
  createdAt: at,
};
const emptyStatus: OutboxStatus = { hub: "up", pending: 0, held: 0, rejected: 0, expired: 0, items: [] };

/** Hộp thư đi giả sau các lệnh `outbox_*`; mỗi lệnh có thể trả giá trị hay ném lỗi. */
type FakeOutbox = Partial<Record<"outbox_status" | "outbox_submit" | "outbox_drop", unknown>>;

/** Lệnh `outbox_*` đã gọi trong test hiện tại. */
const outboxCalls: { command: string; args?: Record<string, unknown> | undefined }[] = [];

/** Hub giả sau lệnh hub_rpc và hộp thư đi giả sau outbox_*; ghi lại thủ tục và thân request. */
function fakeHub(replies: Record<string, unknown>, outbox: FakeOutbox = {}) {
  const calls: { path: string; body: unknown }[] = [];
  outboxCalls.length = 0;
  const outboxReplies: FakeOutbox = {
    outbox_status: emptyStatus,
    outbox_submit: { key: queuedItem.key, state: "queued" },
    outbox_drop: { dropped: queuedItem.key },
    ...outbox,
  };
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        if (command.startsWith("outbox_")) {
          outboxCalls.push({ command, args });
          const reply = outboxReplies[command as keyof FakeOutbox];
          if (reply instanceof Error) throw reply;
          return reply as T;
        }
        if (command !== "hub_rpc") throw new Error(`lệnh chưa giả: ${command}`);
        const path = String(args?.path)
          .replace(/^\/rpc\//, "")
          .split("?")[0] as string;
        calls.push({ path, body: args?.body ? JSON.parse(String(args.body)).json : null });
        const body = replies[path];
        return {
          status: body === undefined ? 404 : 200,
          contentType: "application/json",
          body: JSON.stringify(
            body === undefined
              ? { json: { defined: false, code: "NOT_FOUND", status: 404, message: "x" } }
              : { json: body },
          ),
        } as T;
      },
    },
  };
  return calls;
}

const renderSync = (account: Account | null, items = [{ id: "a.md", label: "a.md", content: "Dùng pnpm." }]) =>
  render(
    <AccountContext.Provider value={account}>
      <MemoryHubSync projectKey="pay" items={items} />
    </AccountContext.Provider>,
  );

describe("MemoryHubSync", () => {
  beforeEach(() => {
    setLang("vi");
    queryClient.clear();
  });

  it("chưa đăng nhập thì ẩn hẳn và không gọi hub", () => {
    const calls = fakeHub({});
    const { container } = renderSync(null);
    expect(container.innerHTML).toBe("");
    expect(calls).toEqual([]);
    expect(outboxCalls).toEqual([]);
  });

  it("hiện brief và memory của dự án để đọc", async () => {
    fakeHub({ "briefs/get": brief, "memory/list": [approved], "projects/list": [hubProject] });
    renderSync(ACCOUNT, []);
    expect(await screen.findByText("Dịch vụ thanh toán.")).toBeTruthy();
    expect(await screen.findByText("Hoàn tiền đi qua bảng refunds.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Gửi lên hub" })).toBeNull();
  });

  it("dự án chưa có brief thì báo chưa có", async () => {
    fakeHub({ "briefs/get": null, "memory/list": [], "projects/list": [hubProject] });
    renderSync(ACCOUNT, []);
    expect(await screen.findByText("Dự án chưa có brief.")).toBeTruthy();
    expect(await screen.findByText("Chưa có memory.")).toBeTruthy();
  });

  const hubReplies = { "briefs/get": null, "memory/list": [], "projects/list": [hubProject] };

  /** Bấm "Gửi lên hub" cho mục đầu tiên sau khi dự án đã khớp trên hub. */
  async function clickSend() {
    const user = userEvent.setup();
    const send = await screen.findByRole("button", { name: "Gửi lên hub" });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    await user.click(send);
    return send as HTMLButtonElement;
  }

  it("Gửi lên hub xếp đề xuất memory vào hộp thư đi của dự án, không ghi thẳng lên hub", async () => {
    const calls = fakeHub(hubReplies, { outbox_submit: { key: queuedItem.key, state: "accepted" } });
    renderSync(ACCOUNT);
    const send = await clickSend();
    expect(await screen.findByText("Đã gửi, đang chờ người trong đội duyệt.")).toBeTruthy();
    expect(outboxCalls.find((c) => c.command === "outbox_submit")?.args).toEqual({
      kind: "memory.propose",
      payload: { projectId: PROJECT_ID, kind: "note", content: "Dùng pnpm." },
    });
    expect(calls.some((c) => c.path === "memory/write")).toBe(false);
    expect(send.disabled).toBe(true);
  });

  it("mất mạng khi gửi thì báo đã xếp hàng và vẫn giữ việc trong hàng đợi", async () => {
    fakeHub(hubReplies);
    renderSync(ACCOUNT);
    await clickSend();
    expect(await screen.findByText("Đã xếp hàng, sẽ gửi khi có mạng.")).toBeTruthy();
    expect(screen.queryByText(/Không gọi được hub/)).toBeNull();
  });

  it("hub vắng (offline) thì cũng báo đã xếp hàng", async () => {
    fakeHub(hubReplies, { outbox_submit: { key: queuedItem.key, state: "queued", hub: "down" } });
    renderSync(ACCOUNT);
    await clickSend();
    expect(await screen.findByText("Đã xếp hàng, sẽ gửi khi có mạng.")).toBeTruthy();
  });

  it("hub từ chối thì hiện lý do của hub trên dòng vừa gửi", async () => {
    fakeHub(hubReplies, {
      outbox_submit: {
        key: queuedItem.key,
        state: "rejected",
        result: { code: "FORBIDDEN", reason: "Không có quyền." },
      },
    });
    renderSync(ACCOUNT);
    await clickSend();
    expect(await screen.findByText("Hub không nhận: Không có quyền.")).toBeTruthy();
  });

  it("mục đang giữ hướng người dùng tới Hộp thư đi, không báo đã gửi", async () => {
    fakeHub(hubReplies, { outbox_submit: { key: queuedItem.key, state: "held", heldReason: "login_required" } });
    renderSync(ACCOUNT);
    await clickSend();
    expect(await screen.findByText("Đang giữ trên máy; mở Hộp thư đi để xem lý do và gửi lại.")).toBeTruthy();
    expect(screen.queryByText("Đã gửi, đang chờ người trong đội duyệt.")).toBeNull();
  });

  it("xếp hàng hỏng (máy chưa đăng ký) thì báo lỗi, không báo đã xếp hàng", async () => {
    fakeHub(hubReplies, { outbox_submit: new Error("Sidecar hive-worker không chạy; mở worker rồi thử lại.") });
    renderSync(ACCOUNT);
    await clickSend();
    expect(await screen.findByText("Sidecar hive-worker không chạy; mở worker rồi thử lại.")).toBeTruthy();
    expect(screen.queryByText("Đã xếp hàng, sẽ gửi khi có mạng.")).toBeNull();
  });

  it("mở màn chỉ đọc hộp thư đi; worker tự gửi phần còn đọng", async () => {
    fakeHub(hubReplies);
    renderSync(ACCOUNT, []);
    await waitFor(() => expect(outboxCalls.some((c) => c.command === "outbox_status")).toBe(true));
  });

  it("thẻ Đang chờ gửi hiện số việc chờ", async () => {
    fakeHub(hubReplies, {
      outbox_status: {
        ...emptyStatus,
        pending: 2,
        items: [queuedItem, { ...queuedItem, key: "01J9ZQ8M3K4N5P6R7S8T9V0W2Y", state: "sending" }],
      },
    });
    renderSync(ACCOUNT, []);
    const card = await screen.findByRole("region", { name: "Đang chờ gửi" });
    expect(within(card).getByText("2 việc đang chờ gửi lên hub, sẽ gửi khi có mạng.")).toBeTruthy();
  });

  it("không có việc nào thì không vẽ thẻ chờ gửi hay thẻ bị từ chối", async () => {
    fakeHub(hubReplies);
    renderSync(ACCOUNT, []);
    await screen.findByText("Dự án chưa có brief.");
    expect(screen.queryByRole("region", { name: "Đang chờ gửi" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Hub không nhận" })).toBeNull();
  });

  it("việc bị từ chối hiện lý do và bỏ được", async () => {
    const rejected: OutboxItem = {
      ...queuedItem,
      state: "rejected",
      code: "CONFLICT",
      reason: "Memory này trùng với memory đã duyệt.",
    };
    fakeHub(hubReplies, { outbox_status: { ...emptyStatus, rejected: 1, items: [rejected] } });
    renderSync(ACCOUNT, []);
    const card = await screen.findByRole("region", { name: "Hub không nhận" });
    expect(within(card).getByText("Memory này trùng với memory đã duyệt.")).toBeTruthy();
    await userEvent.setup().click(within(card).getByRole("button", { name: "Bỏ: Đề xuất memory" }));
    await waitFor(() =>
      expect(outboxCalls.find((c) => c.command === "outbox_drop")?.args).toEqual({ key: queuedItem.key }),
    );
  });

  it("việc quá hạn báo hãy gửi lại", async () => {
    fakeHub(hubReplies, {
      outbox_status: { ...emptyStatus, expired: 1, items: [{ ...queuedItem, state: "expired" }] },
    });
    renderSync(ACCOUNT, []);
    const card = await screen.findByRole("region", { name: "Hub không nhận" });
    expect(within(card).getByText("Quá hạn chưa gửi được, hãy gửi lại.")).toBeTruthy();
  });

  it("đọc hàng đợi hỏng thì vẫn hiện brief và memory", async () => {
    fakeHub({ ...hubReplies, "briefs/get": brief }, { outbox_status: new Error("worker chưa chạy") });
    renderSync(ACCOUNT, []);
    expect(await screen.findByText("Dịch vụ thanh toán.")).toBeTruthy();
    expect(screen.queryByText(/worker chưa chạy/)).toBeNull();
  });

  it("file dài quá giới hạn thì không cho gửi", async () => {
    fakeHub({ "briefs/get": null, "memory/list": [], "projects/list": [hubProject] });
    renderSync(ACCOUNT, [{ id: "big.md", label: "big.md", content: "x".repeat(2001) }]);
    const row = (await screen.findByText("big.md")).closest("li") as HTMLElement;
    expect(within(row).getByText(/Dài quá 2000 ký tự/)).toBeTruthy();
    expect((within(row).getByRole("button", { name: "Gửi lên hub" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("dự án chưa có trên hub thì báo và không cho gửi", async () => {
    fakeHub({ "briefs/get": null, "memory/list": [], "projects/list": [] });
    renderSync(ACCOUNT);
    expect(await screen.findByText("Dự án này chưa có trên hub, nên chưa gửi được.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Gửi lên hub" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
