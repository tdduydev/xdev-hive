import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { call } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { contract } from "@xdev-hive/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Jobs, loadConfig, type Tx } from "../platform/index.ts";
import { systemRouter } from "../system/index.ts";
import { handleAssetDownload, handleAssetUpload } from "./assets.ts";
import {
  DOCSYNC_PULL_QUEUE,
  DOCSYNC_PUSH_QUEUE,
  DOCSYNC_WORD_DOC_QUEUE,
  DOCSYNC_WORD_IMPORT_QUEUE,
  DOCSYNC_WORD_STAGING_QUEUE,
  docSyncQueues,
  queuePull,
  queuePush,
  queueWordDoc,
  queueWordImport,
  registerDocSync,
} from "./jobs.ts";
import { docsyncRouter } from "./router.ts";
import { handleDocsWebhook } from "./webhook.ts";
import { prepareLink } from "./word/link.ts";
import { handleWordMedia } from "./word/media.ts";
import { handleWordOriginal } from "./word/original.ts";
import { detectPandoc } from "./word/pandoc.ts";
import { stageProposal } from "./word/staging.ts";
import { detectWordTools, provideWordTools, wordImportHealth, wordTools } from "./word/tools.ts";
import { prepareUpdate } from "./word/update.ts";
import { handleWordUpload } from "./word/upload.ts";

const fakeJobs = () => ({ enqueue: vi.fn().mockResolvedValue("job-1"), work: vi.fn(), schedule: vi.fn() });
afterEach(() => {
  vi.useRealTimers();
  provideWordTools(null);
});

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

  it.each([
    ["docsync-word-import", queueWordImport, DOCSYNC_WORD_IMPORT_QUEUE],
    ["docsync-word-doc", queueWordDoc, DOCSYNC_WORD_DOC_QUEUE],
  ] as const)("%s: mỗi file một job, giữ tenant và transaction", async (name, queue, constant) => {
    expect(constant).toBe(name);
    expect(docSyncQueues.find((q) => q.name === name)?.policy).toBe("stately");
    const jobs = fakeJobs();
    const tx = {} as Tx;
    const data = { orgId: randomUUID(), fileId: randomUUID() };
    expect(await queue(jobs as unknown as Jobs, data, { tx })).toBe("job-1");
    expect(jobs.enqueue).toHaveBeenCalledWith(name, data, { tx, singletonKey: data.fileId });
  });

  it("hàng dọn đề xuất Word chạy một job mỗi lần", () => {
    expect(docSyncQueues.find((q) => q.name === DOCSYNC_WORD_STAGING_QUEUE)?.policy).toBe("singleton");
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
    for (const name of [
      "docHomes",
      "docImports",
      "docConflicts",
      "docAssets",
      "docExtracts",
      "docTree",
      "wordImports",
    ] as const) {
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
    const word = await rpc.handle(
      new Request("http://localhost/rpc/wordImports/get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { importId: randomUUID() } }),
      }),
      { prefix: "/rpc", context: { headers: new Headers() } },
    );
    expect(word.response?.status).toBe(401);
  });

  it("webhook không có database thì 503; file không có phiên đăng nhập thì 401", async () => {
    const request = new Request("http://localhost/");
    expect((await handleDocsWebhook({}, randomUUID(), request)).status).toBe(503);
    for (const response of await Promise.all([handleAssetUpload({}, request), handleAssetDownload({}, request)])) {
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
    }
  });
});

describe("khung nhập Word", () => {
  const config = loadConfig({}).wordImport;
  if (!config) throw new Error("thiếu cấu hình nhập Word");
  const ok = { ok: true, version: "3.12", reason: null };
  const missing = { ok: false, version: null, reason: "Không chạy được." };

  it("route HTTP chưa có thì trả 501, không đọc request", async () => {
    const request = new Request("http://localhost/", { method: "POST" });
    const ids = { importId: randomUUID(), fileId: randomUUID() };
    for (const response of await Promise.all([
      handleWordMedia({}, request, { ...ids, name: "a.png" }),
      handleWordOriginal({}, request, ids),
    ])) {
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ code: "NOT_IMPLEMENTED" });
    }
  });

  it("route nhận file chưa đăng nhập thì 401, không đọc request", async () => {
    const response = await handleWordUpload({}, new Request("http://localhost/", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("phần chưa làm: gắn và cập nhật bỏ qua, đề xuất báo cần quyền quản lý", async () => {
    const tx = {} as Tx;
    const file = { id: randomUUID() } as Parameters<typeof prepareLink>[1];
    await expect(prepareLink(tx, file)).resolves.toBeUndefined();
    await expect(prepareUpdate(tx, file)).resolves.toBeUndefined();
    await expect(stageProposal(tx, { kind: "user", userId: "u" }, file)).rejects.toMatchObject({
      code: "WORD_IMPORT_NEEDS_MANAGE",
    });
  });

  it("chưa dò công cụ thì tắt nhập Word", () => {
    expect(wordTools()).toBeNull();
    expect(wordImportHealth()).toEqual({ wordImport: false, wordImportDoc: false });
  });

  it.each([
    [ok, ok, { wordImport: true, wordImportDoc: true }],
    [ok, missing, { wordImport: true, wordImportDoc: false }],
    [missing, ok, { wordImport: false, wordImportDoc: false }],
  ])("dò pandoc và LibreOffice theo đường dẫn cấu hình", async (pandoc, soffice, health) => {
    const seen: string[] = [];
    const tools = await detectWordTools(
      { ...config, pandocPath: "/p/pandoc", sofficePath: "/p/soffice" },
      {
        pandoc: async (path) => {
          seen.push(String(path));
          return pandoc;
        },
        soffice: async (path) => {
          seen.push(path);
          return soffice;
        },
      },
    );
    expect(seen).toEqual(["/p/pandoc", "/p/soffice"]);
    expect(tools).toMatchObject({ pandoc, soffice, config: { pandocPath: "/p/pandoc" } });
    expect(wordTools()).toBe(tools);
    expect(wordImportHealth()).toEqual(health);
  });

  it("dò bằng pandoc giả; LibreOffice chưa hỗ trợ thì tắt .doc", async () => {
    const echo = fileURLToPath(new URL("./word/test-bin/pandoc-echo.mjs", import.meta.url));
    const tools = await detectWordTools(config, { pandoc: () => detectPandoc([process.execPath, echo]) });
    expect(tools.pandoc).toEqual(ok);
    expect(tools.soffice.ok).toBe(false);
    expect(wordImportHealth()).toEqual({ wordImport: true, wordImportDoc: false });
  });

  it("health báo nhập Word theo công cụ đã dò", async () => {
    const router = systemRouter({ port: 0, version: "1" }, undefined, wordImportHealth);
    const context = { headers: new Headers() };
    expect(await call(router.health, undefined, { context })).toMatchObject({
      wordImport: false,
      wordImportDoc: false,
    });
    provideWordTools({ config, pandoc: ok, soffice: missing });
    expect(await call(router.health, undefined, { context })).toMatchObject({
      wordImport: true,
      wordImportDoc: false,
    });
  });
});
