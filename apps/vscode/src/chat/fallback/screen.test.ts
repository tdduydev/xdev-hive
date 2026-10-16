/// <reference lib="dom" />
// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { runInThisContext } from "node:vm";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const THREAD = "00000000-0000-4000-8000-0000000000a1";
const PROJECT = "00000000-0000-4000-8000-0000000000b1";
const TASK = "00000000-0000-4000-8000-0000000000c1";
const APPROVAL = "00000000-0000-4000-8000-0000000000d1";
const AT = "2026-10-15T08:00:00.000Z";

const message = (id: string, role: "user" | "leader", content: string) => ({
  id: `00000000-0000-4000-8000-0000000000${id}`,
  role,
  content,
  runId: null,
  createdAt: AT,
  artifact: null,
  pageErrors: null,
});

const state = { saved: undefined as unknown };
const hub = {
  leader: {
    threads: { list: vi.fn(), create: vi.fn(), get: vi.fn(), send: vi.fn() },
    approvals: { list: vi.fn(), approve: vi.fn(), reject: vi.fn() },
  },
  projects: { list: vi.fn() },
  tasks: { create: vi.fn() },
  runs: { start: vi.fn() },
};

let bundle = "";
let unmount: (() => void) | undefined;

beforeAll(() => {
  // Webview import `@/bridge.ts` (cầu nối tới host) và alias `@` trỏ vào webview/; vitest của extension trỏ `@` vào
  // src/ nên dựng riêng bằng esbuild, thay cầu nối bằng bản giả đọc từ globalThis.
  bundle = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { build } from "esbuild";
      const fakeBridge = {
        name: "fake-bridge",
        setup(b) {
          b.onResolve({ filter: /^@\\/bridge\\.ts$/ }, () => ({ path: "bridge", namespace: "fake" }));
          b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({
            contents: "export const hub = globalThis.__chat.hub; export const bridge = globalThis.__chat.bridge;",
            resolveDir: process.cwd(),
          }));
        },
      };
      const result = await build({
        stdin: {
          contents: 'import { createElement } from "react"; import { createRoot } from "react-dom/client"; import { ChatScreen } from "./webview/screens/chat.tsx"; globalThis.__mountChat = (el) => { const root = createRoot(el); root.render(createElement(ChatScreen)); return () => root.unmount(); };',
          resolveDir: process.cwd(),
          loader: "tsx",
        },
        bundle: true,
        platform: "browser",
        format: "iife",
        write: false,
        logLevel: "silent",
        define: { "process.env.NODE_ENV": '"production"' },
        plugins: [fakeBridge],
      });
      process.stdout.write(result.outputFiles[0].text);
    `,
    ],
    { cwd: process.cwd(), encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
}, 60_000);

const proposal = {
  id: APPROVAL,
  threadId: THREAD,
  action: { type: "task.create", projectId: PROJECT, title: "Làm màn hoàn tiền", body: "", tier: "medium" },
  status: "pending",
  expiresAt: "2099-01-01T00:00:00.000Z",
  decidedBy: null,
  reason: null,
  createdAt: AT,
};

let messages: ReturnType<typeof message>[];
let approvals: (typeof proposal)[];

async function mount() {
  Object.assign(globalThis, {
    __chat: { hub, bridge: { getState: () => state.saved, setState: (next: unknown) => (state.saved = next) } },
  });
  runInThisContext(bundle);
  unmount = (globalThis as unknown as { __mountChat(el: HTMLElement): () => void }).__mountChat(
    document.body.appendChild(document.createElement("div")),
  );
}

beforeEach(() => {
  state.saved = undefined;
  messages = [message("e1", "user", "Chào"), message("e2", "leader", "Xin chào, cần giúp gì?")];
  approvals = [];
  hub.projects.list.mockResolvedValue([{ id: PROJECT, key: "shop", name: "Shop" }]);
  hub.leader.threads.list.mockResolvedValue([
    { id: THREAD, projectId: PROJECT, title: "Thanh toán", createdAt: AT, updatedAt: AT },
  ]);
  hub.leader.threads.get.mockImplementation(async () => ({
    thread: { id: THREAD, projectId: PROJECT, title: "Thanh toán", createdAt: AT, updatedAt: AT },
    messages,
  }));
  hub.leader.approvals.list.mockImplementation(async () => approvals);
});

afterEach(() => {
  unmount?.();
  document.body.innerHTML = "";
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("màn chat dự phòng", () => {
  it("hiện lịch sử và gửi tin nhắn mới", async () => {
    hub.leader.threads.send.mockImplementation(async ({ content }: { content: string }) => {
      messages = [...messages, message("e3", "user", content)];
      return { message: messages.at(-1), runId: null };
    });
    await mount();
    expect(await screen.findByText("Xin chào, cần giúp gì?")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Nhắn cho Leader"), { target: { value: "Chia việc thanh toán" } });
    fireEvent.click(screen.getByRole("button", { name: "Gửi" }));

    await waitFor(() =>
      expect(hub.leader.threads.send).toHaveBeenCalledWith({ id: THREAD, content: "Chia việc thanh toán" }),
    );
    // Tin cuối là của người dùng nên màn hình báo Leader đang trả lời.
    expect(await screen.findByText("Leader đang trả lời…")).toBeTruthy();
    expect(await screen.findByText("Chia việc thanh toán")).toBeTruthy();
  });

  it("hỏi lại hub tới khi Leader trả lời", async () => {
    messages = [message("e1", "user", "Chào")];
    await mount();
    expect(await screen.findByText("Leader đang trả lời…")).toBeTruthy();
    const calls = hub.leader.threads.get.mock.calls.length;
    messages = [...messages, message("e2", "leader", "Đây là câu trả lời")];
    expect(await screen.findByText("Đây là câu trả lời", {}, { timeout: 4000 })).toBeTruthy();
    expect(hub.leader.threads.get.mock.calls.length).toBeGreaterThan(calls);
    await waitFor(() => expect(screen.queryByText("Leader đang trả lời…")).toBeNull());
  });

  it("hiện đề xuất chờ duyệt và nút Duyệt gọi approve", async () => {
    approvals = [proposal];
    hub.leader.approvals.approve.mockResolvedValue({ approval: { ...proposal, status: "approved" }, result: null });
    await mount();
    expect(await screen.findByText('Tạo việc "Làm màn hoàn tiền" trong dự án shop')).toBeTruthy();
    expect(screen.getByText(/Leader chọn cấp: Vừa/)).toBeTruthy();

    approvals = [];
    fireEvent.click(screen.getByRole("button", { name: "Duyệt" }));
    await waitFor(() => expect(hub.leader.approvals.approve).toHaveBeenCalledWith({ id: APPROVAL }));
    await waitFor(() => expect(screen.queryByText(/Làm màn hoàn tiền/)).toBeNull());
  });

  it("Từ chối cần lý do rồi gọi reject", async () => {
    approvals = [proposal];
    hub.leader.approvals.reject.mockResolvedValue({ ...proposal, status: "rejected" });
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Từ chối…" }));
    const submit = (await screen.findByRole("button", { name: "Từ chối" })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Lý do từ chối"), { target: { value: "  Chưa đủ rõ  " } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(hub.leader.approvals.reject).toHaveBeenCalledWith({ id: APPROVAL, reason: "Chưa đủ rõ" }),
    );
    expect(hub.leader.approvals.approve).not.toHaveBeenCalled();
  });

  it("tạo cuộc trò chuyện mới khi chưa có", async () => {
    hub.leader.threads.list.mockResolvedValue([]);
    hub.leader.threads.create.mockResolvedValue({
      id: THREAD,
      projectId: null,
      title: "Hỏi nhanh",
      createdAt: AT,
      updatedAt: AT,
    });
    await mount();
    expect(await screen.findByText("Chưa có cuộc trò chuyện nào")).toBeTruthy();
    fireEvent.change(
      screen.getAllByLabelText("Cuộc trò chuyện mới").find((e) => e.tagName === "INPUT") as HTMLElement,
      {
        target: { value: "Hỏi nhanh" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Tạo" }));
    await waitFor(() =>
      expect(hub.leader.threads.create).toHaveBeenCalledWith({ title: "Hỏi nhanh", projectId: null }),
    );
  });

  it("form Giao việc gọi tasks.create và không giao khi không chọn", async () => {
    hub.tasks.create.mockResolvedValue({ id: TASK, key: "shop-7" });
    await mount();
    fireEvent.click(await screen.findByRole("tab", { name: "Giao việc" }));
    await screen.findByRole("option", { name: "shop · Shop" });

    // Thiếu tiêu đề thì không gọi hub.
    fireEvent.change(screen.getByLabelText("Dự án"), { target: { value: PROJECT } });
    fireEvent.click(screen.getByRole("button", { name: "Tạo việc" }));
    expect(hub.tasks.create).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Tiêu đề"), { target: { value: "Thêm nút hoàn tiền" } });
    fireEvent.change(screen.getByLabelText("Mô tả"), { target: { value: "Có xác nhận" } });
    fireEvent.click(screen.getByRole("button", { name: "Tạo việc" }));

    await waitFor(() =>
      expect(hub.tasks.create).toHaveBeenCalledWith({
        projectId: PROJECT,
        title: "Thêm nút hoàn tiền",
        body: "Có xác nhận",
      }),
    );
    expect(await screen.findByText("Đã tạo việc shop-7.")).toBeTruthy();
    expect(hub.runs.start).not.toHaveBeenCalled();
  });

  it("chọn giao ngay thì gọi runs.start, lỗi giao không tạo task trùng", async () => {
    hub.tasks.create.mockResolvedValue({ id: TASK, key: "shop-8" });
    hub.runs.start.mockRejectedValue(new Error("Không có máy"));
    await mount();
    fireEvent.click(await screen.findByRole("tab", { name: "Giao việc" }));
    await screen.findByRole("option", { name: "shop · Shop" });
    fireEvent.change(screen.getByLabelText("Dự án"), { target: { value: PROJECT } });
    fireEvent.change(screen.getByLabelText("Tiêu đề"), { target: { value: "Sửa lỗi" } });
    fireEvent.click(screen.getByLabelText("Giao cho agent ngay"));
    fireEvent.click(screen.getByRole("button", { name: "Tạo việc" }));

    await waitFor(() => expect(hub.runs.start).toHaveBeenCalledWith({ taskId: TASK }));
    expect(await screen.findByText(/Đã tạo việc shop-8 nhưng chưa giao được/)).toBeTruthy();
    expect(hub.tasks.create).toHaveBeenCalledTimes(1);
  });

  it("nhớ tab và cuộc trò chuyện qua state của VS Code", async () => {
    await mount();
    fireEvent.click(await screen.findByRole("tab", { name: "Giao việc" }));
    expect(state.saved).toEqual({ tab: "assign", threadId: null });
  });
});
