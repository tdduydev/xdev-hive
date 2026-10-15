/// <reference lib="dom" />
// @vitest-environment jsdom

import { execFileSync } from "node:child_process";
import { runInThisContext } from "node:vm";
import type { createElement, ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { procedures } from "@/webview-host/allowlist/sdlc.ts";

interface Screen {
  SdlcScreen(): ReactElement;
  parseRoute(value: unknown): unknown;
  routeOf(link: unknown): unknown;
  canOf(permissions: readonly string[] | undefined): {
    write(): boolean;
    override: boolean;
    manageModes: boolean;
  };
  createRoot(element: Element): { render(node: ReactElement): void; unmount(): void };
  createElement: typeof createElement;
}

declare global {
  var SdlcBundle: Screen;
  var acquireVsCodeApi: () => unknown;
}

const root = process.cwd();
let bundle = "";

beforeAll(() => {
  // Dựng trong Node riêng vì jsdom và esbuild dùng hai realm Uint8Array khác nhau.
  bundle = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { build } from "esbuild";
      const result = await build({
        stdin: {
          contents: 'export * from "@/screens/sdlc.tsx"; export { createRoot } from "react-dom/client"; export { createElement } from "react";',
          resolveDir: process.cwd() + "/webview",
          loader: "ts",
        },
        bundle: true, platform: "browser", format: "iife", globalName: "SdlcBundle", write: false, logLevel: "silent",
        jsx: "automatic", splitting: false, alias: { "@": process.cwd() + "/webview" },
        loader: { ".css": "empty" },
        define: { "process.env.NODE_ENV": '"test"' },
      });
      process.stdout.write(result.outputFiles[0].text);
    `,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}, 60_000);

const ITEM = {
  id: "00000000-0000-4000-8000-000000000101",
  project: { id: "00000000-0000-4000-8000-000000000001", key: "payment-api", name: "payment-api" },
  number: 12,
  ref: "012",
  slug: "hoan-tien",
  title: "Hoàn tiền một phần",
  modeRef: "speckit",
  modeName: "Spec Kit",
  method: "speckit",
  size: "L",
  status: "active",
  phase: { id: "requirements", name: "Specify", kind: "requirements", status: "in_review", index: 0, total: 5 },
  waitingFor: null,
  waitingMachine: false,
  openQuestions: 0,
  projects: [{ id: "00000000-0000-4000-8000-000000000001", key: "payment-api", name: "payment-api", role: "home" }],
  coverage: null,
  costUsd: 0,
  owner: { userId: "u1", name: "Trần Lan" },
  createdAt: "2026-10-14T03:42:00.000Z",
  updatedAt: "2026-10-14T03:42:00.000Z",
};

interface Posted {
  type: string;
  id: string;
  path?: string;
  body?: string | null;
}

/** Đóng vai host: ghi lại mọi yêu cầu webview gửi và trả lời theo bảng thủ tục. */
function mountScreen(permissions: string[], saved?: unknown) {
  const sent: Posted[] = [];
  let state: unknown = saved;
  const handlers: Record<string, (body: unknown) => unknown> = {
    "/rpc/roles/mine": () => ({ json: { permissions } }),
    "/rpc/sdlc/board": () => ({ json: { columns: [{ kind: "requirements", items: [ITEM] }] } }),
    "/rpc/projects/list": () => ({ json: [] }),
    "/rpc/sdlc/modes/list": () => ({ json: [] }),
    "/rpc/host/sdlcInit": () => ({ route: null }),
  };
  globalThis.acquireVsCodeApi = () => ({
    postMessage: (message: Posted) => {
      sent.push(message);
      const path = (message.path ?? "").split("?")[0] ?? "";
      const handler = handlers[path];
      const reply = handler
        ? { status: 200, body: JSON.stringify(handler(message.body)) }
        : {
            status: 404,
            body: JSON.stringify({ json: { defined: false, code: "NOT_FOUND", status: 404, message: "x" } }),
          };
      queueMicrotask(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "result", id: message.id, contentType: "application/json", ...reply },
          }),
        ),
      );
    },
    getState: () => state,
    setState: (next: unknown) => {
      state = next;
      return next;
    },
  });
  runInThisContext(bundle);
  const container = document.createElement("div");
  document.body.append(container);
  const app = SdlcBundle.createRoot(container);
  app.render(SdlcBundle.createElement(SdlcBundle.SdlcScreen));
  cleanups.push(() => {
    app.unmount();
    container.remove();
  });
  return { sent, container, state: () => state, paths: () => sent.map((m) => m.path?.split("?")[0]) };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.documentElement.lang = "vi";
});

const buttons = (container: Element) => [...container.querySelectorAll("button")];
const findButton = (container: Element, label: RegExp) =>
  buttons(container).find((b) => label.test(b.textContent ?? ""));

describe("màn AI SDLC trong webview", () => {
  // Lần render đầu của bundle chậm khi CI chạy song song nhiều gói.
  it("chỉ gọi các thủ tục nằm trong allowlist của host", { timeout: 20_000 }, async () => {
    const { container, paths } = mountScreen(["sdlc.write"]);
    await vi.waitFor(() => expect(container.textContent).toContain("Hoàn tiền một phần"), { timeout: 15_000 });
    const allowed = new Set(procedures);
    for (const path of paths()) expect(allowed.has(path ?? ""), path).toBe(true);
  });

  it("quyền ghi hiện nút tạo; không có quyền thì ẩn và báo chỉ đọc", async () => {
    const writer = mountScreen(["sdlc.write"]);
    await vi.waitFor(() => expect(findButton(writer.container, /Tạo hạng mục/)).toBeTruthy());
    expect(writer.container.textContent).not.toContain("Chỉ đọc");

    const reader = mountScreen([]);
    await vi.waitFor(() => expect(reader.container.textContent).toContain("Hoàn tiền một phần"));
    expect(findButton(reader.container, /Tạo hạng mục/)).toBeUndefined();
    expect(reader.container.textContent).toContain("Chỉ đọc");
  });

  it("link `new` đổi sang màn tạo hạng mục và nhớ route qua lần nạp lại", async () => {
    const app = mountScreen(["sdlc.write"]);
    await vi.waitFor(() => expect(findButton(app.container, /Tạo hạng mục/)).toBeTruthy());
    findButton(app.container, /Tạo hạng mục/)?.click();
    await vi.waitFor(() => expect(app.state()).toEqual({ route: { kind: "new" } }));
    expect(findButton(app.container, /Tạo hạng mục/)).toBeUndefined();
  });

  it("link `item` mở chi tiết đúng hạng mục", async () => {
    const app = mountScreen(["sdlc.write"]);
    await vi.waitFor(() => expect(app.container.textContent).toContain("Hoàn tiền một phần"));
    const link = buttons(app.container).find((b) => b.textContent?.includes("Hoàn tiền một phần"));
    link?.click();
    await vi.waitFor(() =>
      expect(app.state()).toEqual({ route: { kind: "item", projectKey: "payment-api", number: 12 } }),
    );
    await vi.waitFor(() => expect(app.paths()).toContain("/rpc/sdlc/items/get"));
    const request = app.sent.find((m) => m.path?.startsWith("/rpc/sdlc/items/get"));
    expect(decodeURIComponent(request?.path ?? "")).toContain('"projectKey":"payment-api"');
  });

  it("khôi phục route đã lưu và nhận route do host đẩy tới", async () => {
    const app = mountScreen(["sdlc.write"], { route: { kind: "item", projectKey: "payment-api", number: 12 } });
    await vi.waitFor(() => expect(app.paths()).toContain("/rpc/sdlc/items/get"));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "sdlc.navigate", to: { kind: "new" } } }));
    await vi.waitFor(() => expect(app.state()).toEqual({ route: { kind: "new" } }));
  });

  it("hỏi host route chờ khi nạp xong (mở từ lệnh khác)", async () => {
    const app = mountScreen(["sdlc.write"]);
    await vi.waitFor(() => expect(app.paths()).toContain("/rpc/host/sdlcInit"));
  });
});

function loadOnly() {
  globalThis.acquireVsCodeApi = () => ({
    postMessage() {},
    getState: () => undefined,
    setState: (next: unknown) => next,
  });
  runInThisContext(bundle);
}

describe("route và quyền", () => {
  it("routeOf chỉ đổi tại chỗ cho màn của AI SDLC; trang khác của hub trả về undefined để host mở", () => {
    loadOnly();
    const { routeOf, parseRoute } = SdlcBundle;
    expect(routeOf({ kind: "board" })).toEqual({ kind: "board" });
    expect(routeOf({ kind: "questions" })).toEqual({ kind: "questions" });
    expect(routeOf({ kind: "item", projectKey: "payment-api", number: 12, tab: "trace" })).toEqual({
      kind: "item",
      projectKey: "payment-api",
      number: 12,
      tab: "trace",
    });
    for (const kind of ["doc", "review", "task", "run", "projectSettings"])
      expect(routeOf({ kind, id: "abc", key: "x", projectId: "p" }), kind).toBeUndefined();
    expect(parseRoute({ kind: "item", projectKey: "p", number: 0 })).toBeUndefined();
    expect(parseRoute({ kind: "item", projectKey: "p", number: 1, tab: "khong-co" })).toEqual({
      kind: "item",
      projectKey: "p",
      number: 1,
    });
    expect(parseRoute({ kind: "hack" })).toBeUndefined();
  });

  it("canOf lấy quyền từ mã quyền của vai trò; chưa biết quyền thì chỉ đọc", () => {
    loadOnly();
    const { canOf } = SdlcBundle;
    expect(canOf(undefined).write()).toBe(false);
    expect(canOf([]).override).toBe(false);
    const all = canOf(["sdlc.write", "sdlc.override", "sdlc.modes.write"]);
    expect([all.write(), all.override, all.manageModes]).toEqual([true, true, true]);
    expect(canOf(["sdlc.read"]).write()).toBe(false);
  });
});
