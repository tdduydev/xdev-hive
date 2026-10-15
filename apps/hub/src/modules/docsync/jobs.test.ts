import { randomUUID } from "node:crypto";
import { RPCHandler } from "@orpc/server/fetch";
import { contract } from "@xdev-hive/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Jobs, Tx } from "../platform/index.ts";
import { handleAssetDownload, handleAssetUpload } from "./assets.ts";
import {
  DOCSYNC_PULL_QUEUE,
  DOCSYNC_PUSH_QUEUE,
  docSyncQueues,
  queuePull,
  queuePush,
  registerDocSync,
} from "./jobs.ts";
import { docsyncRouter } from "./router.ts";
import { handleDocsWebhook } from "./webhook.ts";

const fakeJobs = () => ({ enqueue: vi.fn().mockResolvedValue("job-1"), work: vi.fn(), schedule: vi.fn() });
afterEach(() => vi.useRealTimers());

describe("hàng đợi docsync", () => {
  it.each([
    ["push", queuePush, DOCSYNC_PUSH_QUEUE, 60_000],
    ["pull", queuePull, DOCSYNC_PULL_QUEUE, 30_000],
  ] as const)("%s gom theo nhà, giữ tenant và transaction", async (_name, queue, name, delay) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
    const jobs = fakeJobs();
    const tx = {} as Tx;
    const data = { homeId: randomUUID(), orgId: randomUUID() };
    expect(await queue(jobs as unknown as Jobs, data, { tx })).toBe("job-1");
    expect(jobs.enqueue).toHaveBeenCalledWith(name, data, {
      tx,
      singletonKey: data.homeId,
      startAfter: new Date(Date.now() + delay),
    });
    jobs.enqueue.mockResolvedValueOnce(null);
    expect(await queue(jobs as unknown as Jobs, data)).toBeNull();
    const second = { ...data, homeId: randomUUID() };
    await queue(jobs as unknown as Jobs, second);
    expect(jobs.enqueue).toHaveBeenLastCalledWith(
      name,
      second,
      expect.objectContaining({ singletonKey: second.homeId }),
    );
  });

  it("push và pull dùng stately; mọi queue có tên riêng", () => {
    expect(new Set(docSyncQueues.map((q) => q.name)).size).toBe(docSyncQueues.length);
    for (const name of [DOCSYNC_PUSH_QUEUE, DOCSYNC_PULL_QUEUE]) {
      expect(docSyncQueues.find((q) => q.name === name)?.policy).toBe("stately");
    }
  });

  it("đăng ký phần rỗng không tiêu thụ job chưa có handler", async () => {
    const jobs = fakeJobs();
    await registerDocSync(jobs as unknown as Jobs, {});
    expect(jobs.work).not.toHaveBeenCalled();
    expect(jobs.schedule).not.toHaveBeenCalled();
  });
});

describe("khung API docsync", () => {
  it("đăng ký đủ procedure của hợp đồng", () => {
    const router = docsyncRouter({});
    for (const name of ["docHomes", "docImports", "docConflicts", "docAssets", "docExtracts", "docTree"] as const) {
      expect(Object.keys(router[name]).sort()).toEqual(Object.keys(contract[name]).sort());
    }
  });

  it("procedure vẫn yêu cầu đăng nhập", async () => {
    const rpc = new RPCHandler(docsyncRouter({}));
    const { response } = await rpc.handle(
      new Request("http://localhost/rpc/docHomes/get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { scope: "org" } }),
      }),
      { prefix: "/rpc", context: { headers: new Headers() } },
    );
    expect(response?.status).toBe(401);
  });

  it("webhook không có database thì 503; file trả 501, không nhận thành công giả", async () => {
    const request = new Request("http://localhost/");
    expect((await handleDocsWebhook({}, randomUUID(), request)).status).toBe(503);
    for (const response of [handleAssetUpload({}, request), handleAssetDownload({}, request)]) {
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ code: "NOT_IMPLEMENTED" });
    }
  });
});
