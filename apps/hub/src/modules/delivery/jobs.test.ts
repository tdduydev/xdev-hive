import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { contract } from "@xdev-hive/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Jobs } from "../platform/index.ts";
import { notImplemented } from "./deps.ts";
import {
  DELIVERY_APPROVAL_EXPIRE_QUEUE,
  DELIVERY_CI_POLL_QUEUE,
  DELIVERY_DEPLOY_QUEUE,
  DELIVERY_DEPLOY_WATCH_QUEUE,
  DELIVERY_LOG_RETENTION_QUEUE,
  DELIVERY_WEBHOOK_REFRESH_QUEUE,
  DEPLOY_WATCH_HEARTBEAT_SECONDS,
  deliveryQueues,
  registerDelivery,
} from "./jobs.ts";
import { deliveryRouter } from "./router.ts";
import { deployStreamHandler } from "./stream-route.ts";

const fakeJobs = () => ({ enqueue: vi.fn(), work: vi.fn(), schedule: vi.fn() });
const KEYS = [
  "ciConnections",
  "ciTokens",
  "infraConnections",
  "ciJobs",
  "ci",
  "servers",
  "environments",
  "deployTargets",
  "deploys",
] as const;

describe("hàng đợi delivery", () => {
  it("đủ sáu queue, tên riêng; chạy CI, triển khai và theo dõi là stately", () => {
    expect(deliveryQueues.map((q) => q.name).sort()).toEqual(
      [
        DELIVERY_CI_POLL_QUEUE,
        DELIVERY_DEPLOY_QUEUE,
        DELIVERY_DEPLOY_WATCH_QUEUE,
        DELIVERY_APPROVAL_EXPIRE_QUEUE,
        DELIVERY_LOG_RETENTION_QUEUE,
        DELIVERY_WEBHOOK_REFRESH_QUEUE,
      ].sort(),
    );
    for (const name of [DELIVERY_CI_POLL_QUEUE, DELIVERY_DEPLOY_QUEUE, DELIVERY_DEPLOY_WATCH_QUEUE])
      expect(deliveryQueues.find((q) => q.name === name)?.policy).toBe("stately");
  });

  it("job theo dõi có heartbeat, pg-boss chỉ nhận từ 10 giây", () => {
    const watch = deliveryQueues.find((q) => q.name === DELIVERY_DEPLOY_WATCH_QUEUE);
    expect(watch?.heartbeatSeconds).toBe(DEPLOY_WATCH_HEARTBEAT_SECONDS);
    expect(DEPLOY_WATCH_HEARTBEAT_SECONDS).toBeGreaterThanOrEqual(10);
    for (const q of deliveryQueues.filter((q) => q.name !== DELIVERY_DEPLOY_WATCH_QUEUE))
      expect(q.heartbeatSeconds).toBeUndefined();
  });

  it("đăng ký worker chưa làm gì khi các phần còn là khung", async () => {
    const jobs = fakeJobs();
    await registerDelivery(jobs as unknown as Jobs, {});
    expect(jobs.work).not.toHaveBeenCalled();
    expect(jobs.schedule).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe("router delivery", () => {
  it("đăng ký đủ procedure của hợp đồng", () => {
    const router = deliveryRouter({});
    for (const name of KEYS) expect(Object.keys(router[name]).sort(), name).toEqual(Object.keys(contract[name]).sort());
    expect(Object.keys(router.deploys.approvals).sort()).toEqual(Object.keys(contract.deploys.approvals).sort());
  });

  it("procedure vẫn yêu cầu đăng nhập", async () => {
    const rpc = new RPCHandler(deliveryRouter({}));
    for (const [path, input] of [
      ["ciConnections/list", undefined],
      ["deploys/create", { targetId: randomUUID() }],
      ["deploys/approvals/pending", undefined],
    ] as const) {
      const { response } = await rpc.handle(
        new Request(`http://localhost/rpc/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: input }),
        }),
        { prefix: "/rpc", context: { headers: new Headers() } },
      );
      expect(response?.status, path).toBe(401);
    }
  });

  it("phần chưa làm trả 501 với thông báo tiếng Việt", () => {
    let error: unknown;
    try {
      notImplemented();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "NOT_IMPLEMENTED", status: 501 });
    expect((error as Error).message).toMatch(/chưa được làm/);
  });

  it("luồng SSE của lần triển khai: chưa đăng nhập 401, đã đăng nhập 501", async () => {
    const mount = (session?: unknown) => {
      const app = new Hono();
      const auth = session === undefined ? undefined : ({ api: { getSession: async () => session } } as never);
      app.get("/api/v1/deploys/:id/stream", deployStreamHandler({ auth }));
      return app;
    };
    const url = `http://localhost/api/v1/deploys/${randomUUID()}/stream`;
    expect((await mount().request(url)).status).toBe(401);
    expect((await mount(null).request(url)).status).toBe(401);
    const res = await mount({ user: { id: "u" } }).request(url);
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ data: { code: "NOT_IMPLEMENTED" } });
  });
});
