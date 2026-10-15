import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { safeLibraryPath, verifyLibrary } from "@/artifacts/libraries.ts";
import { artifactHtml, openArtifactPanel } from "@/artifacts/panel.ts";

const state = vi.hoisted(() => ({ receive: (_value: unknown) => {}, closed: () => {} }));
vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof vscode>();
  return {
    ...actual,
    ViewColumn: { Beside: -2 },
    window: {
      ...actual.window,
      createWebviewPanel: vi.fn(() => ({
        webview: {
          cspSource: "'self' https://*.resource.test",
          html: "",
          asWebviewUri: () => ({ toString: () => "https://resource.test/lib" }),
          onDidReceiveMessage: (receive: typeof state.receive) => {
            state.receive = receive;
            return { dispose: vi.fn() };
          },
        },
        onDidDispose: (closed: () => void) => {
          state.closed = closed;
          return { dispose: vi.fn() };
        },
      })),
    },
  };
});
describe("khung artifact cách ly", () => {
  it("tắt command URI, form, giới hạn tài nguyên và bỏ thông điệp lạ", () => {
    const receive = vi.fn();
    const panel = openArtifactPanel(
      "<!doctype html><html><head></head><body></body></html>",
      "/storage/artifact-lib/hash",
      receive,
    );
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      "xdev-hive.artifact-frame",
      "Artifact",
      -2,
      expect.objectContaining({
        enableCommandUris: false,
        enableForms: false,
        enableScripts: true,
        localResourceRoots: [expect.objectContaining({ fsPath: "/storage/artifact-lib/hash" })],
      }),
    );
    state.receive({ type: "rpc", path: "/rpc/tasks/create" });
    state.receive({ type: "ready", extra: "forbidden" });
    state.receive({ type: "error", kind: "runtime", message: "x".repeat(2001) });
    expect(receive).not.toHaveBeenCalled();
    state.receive({ type: "ready" });
    state.receive({ type: "resize", height: 42 });
    expect(receive).toHaveBeenCalledTimes(2);
    expect(panel.webview.html).toContain("connect-src &#39;none&#39;");
    expect(panel.webview.html).not.toContain("hive_pat_");
    expect(panel.webview.html).toContain("https://*.resource.test/lib/");
    state.closed();
  });
  it("CSP đứng trước mã không tin cậy và không còn nguồn hub HTTP", () => {
    const html = artifactHtml(
      '<!doctype html><html><head><script src="hive-artifact://localhost/lib/react@1/index.js"></script></head></html>',
      "https://local.test/lib/",
    );
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("acquireVsCodeApi"));
    expect(html).toContain("frame-src &#39;none&#39;");
    expect(html).toContain("form-action &#39;none&#39;");
    expect(html).not.toContain("hive-artifact:");
  });
});
it("thư viện phải đúng SRI và kích thước, đường dẫn không thoát thư mục", () => {
  const data = Buffer.from("export default 1");
  const entry = {
    path: "react@1/index.js",
    integrity: `sha384-${createHash("sha384").update(data).digest("base64")}`,
    bytes: data.length,
    kind: "module" as const,
  };
  expect(verifyLibrary(data, entry)).toBe(true);
  expect(verifyLibrary(Buffer.from("export default 2"), entry)).toBe(false);
  expect(verifyLibrary(data, { ...entry, bytes: 1 })).toBe(false);
  expect(safeLibraryPath(entry.path)).toBe(true);
  for (const path of ["../outside", "/etc/passwd", "a/../../b", "a\\b", "https://evil", "a/%2e%2e/b"])
    expect(safeLibraryPath(path)).toBe(false);
});
