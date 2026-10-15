import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubClient } from "@/hub/client.ts";
import { errorMessage } from "@/hub/errors.ts";
import { poll } from "@/hub/poll.ts";
import { streamRun } from "@/hub/sse.ts";
import { createFakeHub } from "../../test/fake-hub.ts";

const org = "11111111-1111-4111-8111-111111111111";
const token = `hive_pat_${org}_test`;
const auth = () => ({ token: async () => token, invalidate: vi.fn() });
afterEach(() => vi.useRealTimers());

describe("hub", () => {
  it("gọi RPC có kiểu qua HTTP, gắn bearer và tổ chức", async () => {
    const fake = createFakeHub({ token, rpc: { orgs: { mine: () => ({ orgs: [], canCreateOrg: false }) } } });
    const server = await fake.listen();
    try {
      const client = createHubClient({ hubUrl: () => server.url, auth: auth() });
      expect(await client.rpc.orgs.mine({})).toEqual({ orgs: [], canCreateOrg: false });
      expect(fake.requests[0]?.headers.get("x-hive-org")).toBe(org);
    } finally {
      await server.close();
    }
  });
  it("nhiều 401 chỉ gọi invalidate một lần, token mới được vô hiệu lại", async () => {
    const identity = auth();
    const client = createHubClient({
      hubUrl: () => "http://hub.test",
      auth: identity,
      fetch: async () => new Response(null, { status: 401 }),
    });
    const results = await Promise.allSettled([client.request("/a"), client.request("/b")]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(identity.invalidate).toHaveBeenCalledTimes(1);
    identity.token = async () => `${token}new`;
    await expect(client.request("/a")).rejects.toThrow("đăng nhập lại");
    expect(identity.invalidate).toHaveBeenCalledTimes(2);
    expect(errorMessage(new Error(token))).not.toContain(token);
  });
  it("SSE nhận UTF-8 và CRLF bị cắt chunk, nối lại bằng con trỏ đã xử lý", async () => {
    let connects = 0;
    const fake = createFakeHub({
      token,
      stream: (_, request) => {
        connects++;
        if (connects === 2) expect(request.headers.get("last-event-id")).toBe("1.0");
        const content =
          connects === 1
            ? ": ping\r\nid: 1.0\r\nevent: run_event\r\ndata: tiếng Việt\r\n\r\nid: 99.0\ndata: dở"
            : "id: 1.2\nevent: log\ndata: dòng 1\ndata: dòng 2\n\nevent: end\ndata: {}\n\n";
        const bytes = new TextEncoder().encode(content);
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const client = createHubClient({ hubUrl: () => "http://hub.test", auth: auth(), fetch: fake.fetch });
    const events: string[] = [];
    await streamRun(
      client,
      "run",
      (e) => {
        events.push(e.data);
      },
      { signal: AbortSignal.timeout(2000), retryMs: 1 },
    );
    expect(events).toEqual(["tiếng Việt", "dòng 1\ndòng 2", "{}"]);
    expect(connects).toBe(2);
  });
  it("SSE dừng sau 401", async () => {
    const identity = auth();
    const transport = vi.fn(async () => new Response(null, { status: 401 }));
    const client = createHubClient({ hubUrl: () => "http://hub.test", auth: identity, fetch: transport });
    await expect(streamRun(client, "run", () => {}, { signal: new AbortController().signal })).rejects.toThrow(
      "đăng nhập lại",
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("huỷ SSE trong lúc đợi nối lại", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = vi.fn(async () => {
      throw new TypeError("offline");
    });
    const running = streamRun({ request }, "run", () => {}, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await running;
    await vi.advanceTimersByTimeAsync(60000);
    expect(request).toHaveBeenCalledOnce();
  });
  it("poll huỷ yêu cầu đang chạy khi mất focus và không chạy chồng", async () => {
    vi.useFakeTimers();
    let focused = true;
    let change: (state: { focused: boolean; active: boolean }) => void = () => {};
    let signal: AbortSignal | undefined;
    const action = vi.fn((input: AbortSignal) => {
      signal = input;
      return new Promise<void>((resolve) => input.addEventListener("abort", () => resolve(), { once: true }));
    });
    const task = poll(action, {
      focused: () => focused,
      onDidChangeWindowState: (listener) => {
        change = listener;
        return { dispose() {} };
      },
    });
    change({ focused: true, active: true });
    expect(action).toHaveBeenCalledOnce();
    focused = false;
    change({ focused, active: false });
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(300000);
    expect(action).toHaveBeenCalledOnce();
    task.dispose();
  });
  it("poll dừng khi mất focus, huỷ việc đang chạy và backoff rồi phục hồi", async () => {
    vi.useFakeTimers();
    let focused = true;
    let change: (state: { focused: boolean; active: boolean }) => void = () => {};
    const action = vi.fn(async (_signal: AbortSignal) => {});
    const dispose = vi.fn();
    const task = poll(action, {
      intervalMs: 1000,
      focused: () => focused,
      onDidChangeWindowState: (listener) => {
        change = listener;
        return { dispose };
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    focused = false;
    change({ focused, active: focused });
    await vi.advanceTimersByTimeAsync(5000);
    expect(action).toHaveBeenCalledTimes(1);
    focused = true;
    change({ focused, active: focused });
    await vi.advanceTimersByTimeAsync(0);
    action.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(action).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1999);
    expect(action).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(action).toHaveBeenCalledTimes(4);
    task.dispose();
    await vi.advanceTimersByTimeAsync(10000);
    expect(action).toHaveBeenCalledTimes(4);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
