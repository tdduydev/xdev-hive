import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  remove: vi.fn(),
  binary: vi.fn(),
  access: vi.fn(),
  exec: vi.fn(),
  registerServer: vi.fn(),
  unregisterServer: vi.fn(),
  provider: vi.fn(),
  sessionChanged: vi.fn(),
  refresh: vi.fn(),
  quickPick: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ constants: { X_OK: 1 }, access: mocks.access }));
vi.mock("@/lib/exec.ts", () => ({ exec: mocks.exec }));
vi.mock("@/mcp/files.ts", () => ({
  McpFiles: class {
    add = mocks.add;
    remove = mocks.remove;
  },
}));
vi.mock("@/mcp/provider.ts", () => ({
  HiveMcpProvider: class {
    refresh = mocks.refresh;
    dispose() {}
  },
}));
vi.mock("@/worker/bin.ts", () => ({ findBinary: mocks.binary }));
vi.mock("vscode", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  cursor: { mcp: { registerServer: mocks.registerServer, unregisterServer: mocks.unregisterServer } },
  lm: { registerMcpServerDefinitionProvider: mocks.provider },
  authentication: { onDidChangeSessions: mocks.sessionChanged },
}));

import * as vscode from "vscode";
import { register } from "@/mcp/index.ts";

function setup() {
  const state = new Map<string, unknown>();
  const ctx = {
    subscriptions: [],
    globalState: {
      get: (key: string) => state.get(key),
      update: vi.fn(async (key: string, value: unknown) => {
        state.set(key, value);
      }),
    },
  } as unknown as vscode.ExtensionContext;
  register(ctx);
  const command = (name: string) => {
    const entry = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === name);
    if (!entry) throw new Error(`Missing command ${name}`);
    return entry[1]();
  };
  return { ctx, command };
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(vscode.env, { uriScheme: "vscode" });
  Object.assign(vscode.workspace, { isTrusted: true });
  Object.assign(vscode.window, { showQuickPick: mocks.quickPick });
  vi.mocked(vscode.window.showInformationMessage).mockImplementation(
    async (_message, ...items) => items.at(-1) as never,
  );
  mocks.binary.mockResolvedValue({ path: "/safe path/hive" });
  mocks.registerServer.mockResolvedValue(undefined);
  mocks.unregisterServer.mockResolvedValue(undefined);
  mocks.access.mockRejectedValue(new Error("ENOENT"));
  mocks.add.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
});
it("registers the declared provider and refreshes after auth/config changes", () => {
  const { ctx } = setup();
  expect(mocks.provider).toHaveBeenCalledWith("xdev-hive.mcp", expect.anything());
  mocks.sessionChanged.mock.calls[0]?.[0]({ provider: { id: "xdev-hive" } });
  const callback = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls.at(-1)?.[0];
  callback?.({ affectsConfiguration: () => true });
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  for (const sub of ctx.subscriptions) sub?.dispose();
});
it("requires separate approval before writing each tool", async () => {
  const { command } = setup();
  vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(undefined);
  await command("xdevHive.mcp.addWindsurf");
  expect(mocks.add).not.toHaveBeenCalled();
  await command("xdevHive.mcp.addWindsurf");
  expect(mocks.add).toHaveBeenCalledWith("Windsurf", { command: "/safe path/hive", args: ["mcp"] }, undefined);
  expect(JSON.stringify(mocks.add.mock.calls)).not.toContain("hive_pat_");
});
it("prefers Cursor API and unregisters the server on request", async () => {
  Object.assign(vscode.env, { uriScheme: "cursor" });
  const { command } = setup();
  await command("xdevHive.mcp.addCursor");
  expect(mocks.registerServer).toHaveBeenCalledWith({
    name: "xdev-hive",
    server: { command: "/safe path/hive", args: ["mcp"], env: {} },
  });
  expect(mocks.add).not.toHaveBeenCalled();
  mocks.quickPick.mockResolvedValueOnce("Cursor");
  await command("xdevHive.mcp.remove");
  expect(mocks.unregisterServer).toHaveBeenCalledWith("xdev-hive");
});
it("falls back to Cursor file when its private API fails", async () => {
  Object.assign(vscode.env, { uriScheme: "cursor" });
  mocks.registerServer.mockRejectedValueOnce(new Error("changed API"));
  const { command } = setup();
  await command("xdevHive.mcp.addCursor");
  expect(mocks.add).toHaveBeenCalledWith("Cursor", expect.anything(), undefined);
});
it("supports Devin via file configuration without assuming the Windsurf name", async () => {
  Object.assign(vscode.env, { uriScheme: "devin" });
  const { command } = setup();
  await command("xdevHive.mcp.addWindsurf");
  expect(mocks.add).toHaveBeenCalledWith("Windsurf", expect.anything(), undefined);
  expect(mocks.registerServer).not.toHaveBeenCalled();
});
it("uses Claude CLI when available and wraps it with file ownership tracking", async () => {
  mocks.access.mockResolvedValue(undefined);
  mocks.exec.mockResolvedValue({ code: 0 });
  mocks.add.mockImplementationOnce(async (_tool, _server, install) => {
    await install();
  });
  const { command } = setup();
  await command("xdevHive.mcp.addClaudeCode");
  expect(mocks.exec).toHaveBeenCalledWith(expect.stringMatching(/claude(?:\.exe)?$/), [
    "mcp",
    "add",
    "--scope",
    "user",
    "xdev-hive",
    "--",
    "/safe path/hive",
    "mcp",
  ]);
});
it("does not execute tools in Restricted Mode or when hive is missing", async () => {
  const { command } = setup();
  Object.assign(vscode.workspace, { isTrusted: false });
  await command("xdevHive.mcp.addClaudeCode");
  expect(mocks.binary).not.toHaveBeenCalled();
  Object.assign(vscode.workspace, { isTrusted: true });
  mocks.binary.mockResolvedValueOnce(undefined);
  await command("xdevHive.mcp.addClaudeCode");
  expect(mocks.exec).not.toHaveBeenCalled();
  expect(mocks.add).not.toHaveBeenCalled();
});
it("never displays raw errors containing secrets", async () => {
  mocks.add.mockRejectedValueOnce(new Error("hive_pat_do_not_display"));
  const { command } = setup();
  await command("xdevHive.mcp.addWindsurf");
  expect(JSON.stringify(vi.mocked(vscode.window.showErrorMessage).mock.calls)).not.toContain("hive_pat_");
});
