import { afterEach, describe, expect, it, vi } from "vitest";
import type * as VSCode from "vscode";
import { createContext, settings } from "../../test/vscode-mock.ts";

const state = vi.hoisted(() => ({
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  lensSelectors: [] as unknown[],
  token: undefined as string | undefined,
  fetch: vi.fn(() => Promise.reject(new Error("không được gọi hub"))),
}));
vi.mock("@/auth/index.ts", () => ({ auth: { token: async () => state.token, invalidate: vi.fn() } }));
vi.mock("vscode", async (original) => {
  const base = await original<typeof VSCode>();
  const extras = await import("@/codelens/test-support.ts");
  const disposable = { dispose() {} };
  return {
    ...base,
    Range: extras.Range,
    CodeLens: extras.CodeLens,
    Hover: extras.Hover,
    MarkdownString: extras.MarkdownString,
    SymbolKind: extras.SymbolKind,
    languages: {
      registerCodeLensProvider: vi.fn((selector) => {
        state.lensSelectors.push(selector);
        return disposable;
      }),
      registerHoverProvider: vi.fn(() => disposable),
    },
    authentication: { onDidChangeSessions: vi.fn(() => disposable) },
    commands: {
      ...base.commands,
      registerCommand: vi.fn((id, fn) => {
        state.commands.set(id, fn);
        return disposable;
      }),
    },
    window: {
      ...base.window,
      state: { focused: true },
      onDidChangeWindowState: vi.fn(() => disposable),
    },
    workspace: {
      ...base.workspace,
      findFiles: vi.fn(async () => []),
      createFileSystemWatcher: vi.fn(() => ({
        onDidCreate: () => disposable,
        onDidChange: () => disposable,
        onDidDelete: () => disposable,
        dispose() {},
      })),
      onDidGrantWorkspaceTrust: vi.fn(() => disposable),
      asRelativePath: (uri: { fsPath: string }) => uri.fsPath.replace("file:///repo/", ""),
      fs: { readFile: vi.fn() },
    },
  };
});

import * as vscode from "vscode";
import { register } from "@/codelens/index.ts";

afterEach(() => {
  state.commands.clear();
  state.lensSelectors.length = 0;
  state.token = undefined;
  settings.clear();
  Object.assign(vscode.workspace, { isTrusted: true });
  vi.mocked(vscode.commands.executeCommand).mockReset();
  vi.mocked(vscode.window.showInformationMessage).mockReset();
});

describe("register", () => {
  it("đăng ký hai CodeLens, hover và hai lệnh; chưa đăng nhập thì không gọi hub", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(state.fetch);
    register(createContext() as never);
    expect(state.lensSelectors).toEqual([{ pattern: "**/specs/*/tasks.md" }, { scheme: "file" }]);
    expect(vscode.languages.registerHoverProvider).toHaveBeenCalled();
    expect([...state.commands.keys()].sort()).toEqual([
      "xdevHive.codelens.assignSymbol",
      "xdevHive.codelens.assignTask",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("Giao agent mở bản nháp @hive /giao với mã task, chưa giao gì", async () => {
    register(createContext() as never);
    await state.commands.get("xdevHive.codelens.assignTask")?.({
      uri: "file:///repo/specs/017-x/tasks.md",
      code: "T023",
      spec: "017",
      title: "CodeLens và Hover",
    });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.chat.open", {
      query: "@hive /giao Làm task T023 của spec 017: CodeLens và Hover",
      isPartialQuery: true,
    });
  });

  it("không có khung Chat thì rơi về màn chat dự phòng với cùng bản nháp", async () => {
    register(createContext() as never);
    vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error("command not found"));
    await state.commands.get("xdevHive.codelens.assignSymbol")?.({
      uri: "file:///repo/src/a.ts",
      name: "main",
      kind: "function",
      startLine: 0,
      endLine: 9,
    });
    expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith("xdevHive.openChat", {
      draft: "Sửa function main trong src/a.ts, dòng 1-10.",
    });
  });

  it("Restricted Mode: lệnh giao việc không mở chat và báo lý do", async () => {
    Object.assign(vscode.workspace, { isTrusted: false });
    register(createContext() as never);
    await state.commands.get("xdevHive.codelens.assignTask")?.({ uri: "u", code: "T001", spec: "017", title: "x" });
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("chưa tin cậy"));
  });

  it("đối số lạ bị bỏ qua", async () => {
    register(createContext() as never);
    await state.commands.get("xdevHive.codelens.assignTask")?.({ code: 1 });
    await state.commands.get("xdevHive.codelens.assignSymbol")?.(undefined);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});
