import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  project: vi.fn(),
  binary: vi.fn(),
}));
vi.mock("@/auth/index.ts", () => ({ auth: { token: mocks.token } }));
vi.mock("@/hub/index.ts", () => ({ workspaceProject: mocks.project }));
vi.mock("@/worker/bin.ts", () => ({ findBinary: mocks.binary }));
vi.mock("vscode", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  McpHttpServerDefinition: class {
    label: string;
    uri: { toString(): string };
    headers: Record<string, string>;
    constructor(label: string, uri: { toString(): string }, headers = {}) {
      this.label = label;
      this.uri = uri;
      this.headers = headers;
    }
  },
  McpStdioServerDefinition: class {
    label: string;
    command: string;
    args: string[];
    constructor(label: string, command: string, args: string[]) {
      this.label = label;
      this.command = command;
      this.args = args;
    }
  },
}));

import * as vscode from "vscode";

const { settings, workspace } = vscode as unknown as {
  settings: Map<string, unknown>;
  workspace: { isTrusted: boolean; workspaceFolders: unknown };
};

import { HiveMcpProvider } from "@/mcp/provider.ts";

beforeEach(() => {
  vi.resetAllMocks();
  settings.clear();
  settings.set("xdevHive.hubUrl", "https://hive.example");
  mocks.token.mockResolvedValue("hive_pat_first");
  mocks.project.mockResolvedValue("project-id");
  workspace.isTrusted = true;
  workspace.workspaceFolders = [{ uri: { fsPath: "/project" } }];
});
it("keeps discovery token-free and resolves the latest token and project", async () => {
  const provider = new HiveMcpProvider();
  const [definition] = await provider.provideMcpServerDefinitions();
  if (!definition) throw new Error("Expected a server definition");
  expect(JSON.stringify(definition)).not.toContain("hive_pat_");
  mocks.token.mockResolvedValue("hive_pat_fresh");
  const result = await provider.resolveMcpServerDefinition(definition);
  expect(result).toMatchObject({ headers: { Authorization: "Bearer hive_pat_fresh", "X-Hive-Project": "project-id" } });
  expect(JSON.stringify(definition)).not.toContain("hive_pat_");
  provider.dispose();
});
it("does not send tokens to stale or foreign URLs", async () => {
  const provider = new HiveMcpProvider();
  const [definition] = await provider.provideMcpServerDefinitions();
  if (!definition) throw new Error("Expected a server definition");
  settings.set("xdevHive.hubUrl", "https://new.example");
  expect(await provider.resolveMcpServerDefinition(definition)).toBeUndefined();
});
it("hides definitions after logout and without a hub", async () => {
  const provider = new HiveMcpProvider();
  mocks.token.mockResolvedValue(undefined);
  expect(await provider.provideMcpServerDefinitions()).toEqual([]);
  settings.clear();
  expect(await provider.provideMcpServerDefinitions()).toEqual([]);
});
it("uses keychain stdio with explicit hub and no token", async () => {
  settings.set("xdevHive.mcp.transport", "stdio");
  mocks.binary.mockResolvedValue({ path: "/safe/hive" });
  const provider = new HiveMcpProvider();
  expect(await provider.provideMcpServerDefinitions()).toMatchObject([
    { command: "/safe/hive", args: ["mcp", "--hub", "https://hive.example"] },
  ]);
  workspace.isTrusted = false;
  expect(await provider.provideMcpServerDefinitions()).toEqual([]);
});
it("notifies listeners to rediscover definitions", () => {
  const provider = new HiveMcpProvider();
  const listener = vi.fn();
  provider.onDidChangeMcpServerDefinitions(listener);
  provider.refresh();
  expect(listener).toHaveBeenCalledOnce();
});

it("ignores malformed hub URLs and URLs carrying credentials", async () => {
  const provider = new HiveMcpProvider();
  for (const hub of [
    "bad URL",
    "file:///tmp/hive",
    "https://user:password@hive.example",
    "https://hive.example?token=secret",
  ]) {
    settings.set("xdevHive.hubUrl", hub);
    expect(await provider.provideMcpServerDefinitions()).toEqual([]);
  }
});
