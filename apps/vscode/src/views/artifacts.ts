import { join, relative } from "node:path";
import * as vscode from "vscode";
import { ArtifactCache, sha256 } from "@/artifacts/cache.ts";
import { loadLibraries, verifyCachedLibraries } from "@/artifacts/libraries.ts";
import { openArtifactPanel } from "@/artifacts/panel.ts";
import { auth } from "@/auth/index.ts";
import { createHubClient, orgFromToken } from "@/hub/client.ts";
import { HubError } from "@/hub/errors.ts";
import { config } from "@/lib/config.ts";
import { attachBridge } from "@/webview-host/bridge.ts";
import { renderHtml, webviewOptions } from "@/webview-host/html.ts";
import type { RpcTransport } from "@/webview-host/types.ts";

export function register(ctx: vscode.ExtensionContext): void {
  const cache = new ArtifactCache(join(ctx.globalStorageUri.fsPath, "artifacts"));
  const libRoot = join(ctx.globalStorageUri.fsPath, "artifact-lib");
  const client = createHubClient({ hubUrl: config.hubUrl, auth });
  const panels = new Set<vscode.WebviewPanel>();
  const active = new Set<vscode.Disposable>();
  const views = new Set<vscode.WebviewView>();
  let generation = 0;
  let opening = false;
  const clear = async () => {
    generation++;
    for (const panel of panels) panel.dispose();
    panels.clear();
    for (const view of views) view.webview.html = renderHtml(view.webview, ctx.extensionUri, "artifacts");
    await cache.clear();
  };
  const open = async (input: unknown) => {
    if (opening || !input || typeof input !== "object") return false;
    const ref = input as { id?: unknown; version?: unknown };
    if (
      typeof ref.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(ref.id) ||
      !Number.isSafeInteger(ref.version) ||
      Number(ref.version) < 1
    )
      return false;
    if (!config.hubUrl()) throw new Error("Chưa cấu hình hub xDev Hive.");
    const epoch = generation;
    const token = await auth.token();
    if (!token) throw new Error("Vui lòng đăng nhập xDev Hive.");
    if (opening || epoch !== generation) return false;
    opening = true;
    try {
      const id = ref.id;
      const version = Number(ref.version);
      const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ? "light" : "dark";
      const key = `${config.hubUrl()}:${sha256(token)}:${orgFromToken(token)}:${id}:${version}:${theme}`;
      let document: { html: string; libraries: string };
      try {
        const frame = await client.rpc.artifacts.frameDocument({ id, version, theme });
        const libraries = await loadLibraries(libRoot, config.hubUrl());
        document = { html: frame.html, libraries };
        if (epoch !== generation) return false;
        await cache.put(key, JSON.stringify(document));
      } catch (error) {
        // Không dùng cache để vượt qua quyền vừa bị thu hồi hoặc artifact vừa bị xoá.
        if (
          error &&
          typeof error === "object" &&
          "status" in error &&
          Number(error.status) >= 400 &&
          Number(error.status) < 500
        )
          throw error;
        const cached = await cache.get(key);
        if (!cached) throw error;
        document = JSON.parse(cached) as typeof document;
        if (!/^[a-f0-9]{64}$/.test(relative(libRoot, document.libraries)))
          throw new Error("Bộ đệm artifact không hợp lệ.");
        await verifyCachedLibraries(document.libraries);
      }
      if (epoch !== generation) return false;
      const panel = openArtifactPanel(document.html, document.libraries);
      panels.add(panel);
      panel.onDidDispose(() => panels.delete(panel));
      return true;
    } finally {
      opening = false;
    }
  };
  const transport: RpcTransport = async (request, signal) => {
    if (request.path === "/rpc/artifacts/openFrame" && request.method === "POST") {
      const result = await open(JSON.parse(request.body ?? "null"));
      return { status: 200, contentType: "application/json", body: JSON.stringify(result) };
    }
    const epoch = generation;
    const token = config.hubUrl() ? await auth.token() : undefined;
    if (!token) throw new HubError(401);
    const key = `rpc:${config.hubUrl()}:${sha256(token)}:${request.method}:${request.path}:${request.body}`;
    try {
      const response = await client.request(request.path, {
        method: request.method,
        signal,
        headers: { "content-type": "application/json" },
        ...(request.body === null ? {} : { body: request.body }),
      });
      const reply = {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/json",
        body: await response.text(),
      };
      if (epoch !== generation) throw new HubError(401);
      await cache.put(key, JSON.stringify(reply));
      return reply;
    } catch (error) {
      if (epoch !== generation || (error instanceof HubError && error.status >= 400 && error.status < 500)) throw error;
      const cached = await cache.get(key);
      if (!cached) throw error;
      return JSON.parse(cached) as Awaited<ReturnType<RpcTransport>>;
    }
  };
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("xdev-hive.artifacts", {
      resolveWebviewView(view) {
        views.add(view);
        view.webview.options = webviewOptions(ctx.extensionUri);
        const bridge = attachBridge(view.webview, "artifacts", { rpc: transport });
        active.add(bridge);
        view.onDidDispose(() => {
          bridge.dispose();
          active.delete(bridge);
          views.delete(view);
        });
        view.webview.html = renderHtml(view.webview, ctx.extensionUri, "artifacts");
      },
    }),
    vscode.commands.registerCommand("xdevHive.artifact.open", (ref: unknown) =>
      open(ref).catch(() => vscode.window.showErrorMessage("Không mở được artifact.")),
    ),
    vscode.commands.registerCommand("xdevHive.artifact.clearCache", clear),
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id === "xdev-hive") void clear();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("xdevHive.hubUrl")) void clear();
    }),
    {
      dispose() {
        generation++;
        for (const panel of panels) panel.dispose();
        for (const item of active) item.dispose();
      },
    },
  );
}
