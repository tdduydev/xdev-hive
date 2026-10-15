import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeHub } from "../../test/fake-hub.ts";

const views = new Map<string, { message?: string; badge?: { value: number; tooltip: string }; dispose(): void }>();
const focus = { focused: true };

vi.mock("vscode", async (original) => {
  const base = await original<typeof import("../../test/vscode-mock.ts")>();
  return {
    ...base,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ConfigurationTarget: { Global: 1 },
    authentication: { getSession: vi.fn(), onDidChangeSessions: vi.fn(() => new base.Disposable(() => {})) },
    workspace: { ...base.workspace, onDidChangeWorkspaceFolders: vi.fn(() => new base.Disposable(() => {})) },
    window: {
      ...base.window,
      state: focus,
      onDidChangeWindowState: vi.fn(() => new base.Disposable(() => {})),
      registerWebviewViewProvider: vi.fn(() => new base.Disposable(() => {})),
      createOutputChannel: vi.fn(() => ({
        appendLine: (line: string) => base.outputLines.push(line),
        show: vi.fn(),
        clear: () => base.outputLines.splice(0),
        dispose: vi.fn(),
      })),
      showWarningMessage: vi.fn(),
      showInputBox: vi.fn(),
      createTreeView: vi.fn((id: string) => {
        const view = { dispose: vi.fn() };
        views.set(id, view);
        return view;
      }),
    },
  };
});

const vscode = await import("vscode");
const mock = await import("../../test/vscode-mock.ts");
const { register } = await import("@/views/index.ts");

const ORG = "11111111-1111-4111-8111-111111111111";
const TOKEN = `hive_pat_${ORG}_secret`;
const session = { id: "s1", accessToken: TOKEN, account: { id: "u1", label: "u" }, scopes: [] };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-14T00:00:00.000Z";

function hubRoutes() {
  return {
    tasks: {
      list: () => [
        {
          id: id(1),
          projectId: id(2),
          teamId: id(3),
          key: "HIVE-1",
          number: 1,
          title: "Việc A",
          body: "",
          type: null,
          status: "running",
          preferredCli: null,
          source: {},
          createdBy: "u",
          createdAt: at,
          updatedAt: at,
        },
      ],
    },
    codeReviews: { list: () => ({ items: [], nextCursor: null }), count: () => ({ awaitingMe: 2 }) },
    reviews: { list: () => ({ items: [], nextCursor: null }) },
    leader: {
      approvals: {
        list: () => [
          {
            id: id(10),
            threadId: id(11),
            action: { type: "run.cancel", runId: id(12) },
            status: "pending",
            expiresAt: at,
            decidedBy: null,
            reason: null,
            createdAt: at,
          },
        ],
      },
    },
    sdlc: { questions: { list: () => ({ items: [], nextCursor: null }), count: () => ({ open: 3 }) } },
    runs: { search: () => ({ items: [], nextCursor: null }) },
  };
}

const runItem = {
  id: id(20),
  taskId: id(1),
  projectId: id(2),
  teamId: id(3),
  kind: "code",
  parentRunId: null,
  state: "running",
  attempt: 1,
  maxAttempts: 2,
  machineId: null,
  machineName: null,
  cli: null,
  model: null,
  pinnedMachineId: null,
  branch: "ai/HIVE-1",
  policySnapshot: [],
  result: null,
  headSha: null,
  prUrl: null,
  timeoutSec: 60,
  explore: null,
  rtk: null,
  cost: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, turns: null, accountId: null },
  createdBy: "u",
  ownerUserId: "u1",
  createdAt: at,
  startedAt: at,
  finishedAt: null,
  updatedAt: at,
  taskKey: "HIVE-1",
  taskTitle: "Việc A",
};
const sse = (event: string, data: unknown, eventId: number) =>
  `id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const chunk = (text: string, n: number) => ({
  id: n,
  attempt: 1,
  offset: 0,
  bytes: Buffer.from(text).toString("base64"),
  createdAt: at,
});

const runsTree = () =>
  vi.mocked(vscode.window.createTreeView).mock.calls.find(([viewId]) => viewId === "xdev-hive.runs")?.[1]
    .treeDataProvider;
const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("views", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    views.clear();
    mock.settings.clear();
    mock.workspace.workspaceFolders = undefined;
    focus.focused = true;
    vi.mocked(vscode.authentication.getSession).mockReset();
    vi.stubEnv("HIVE_CLI_CONFIG", "/nonexistent/hive.json");
    vi.stubEnv("HIVE_WORKER_CONFIG", "/nonexistent/worker.json");
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("badge Chờ duyệt bằng tổng PR, đề xuất Leader và câu hỏi đang chờ", async () => {
    const hub = createFakeHub({ token: TOKEN, rpc: hubRoutes() as never });
    const server = await hub.listen();
    mock.settings.set("xdevHive.hubUrl", server.url);
    vi.mocked(vscode.authentication.getSession).mockResolvedValue(session as never);
    const ctx = mock.createContext();
    register(ctx as never);
    await vi.waitFor(() => expect(views.get("xdev-hive.approvals")?.badge).toBeDefined(), { timeout: 5000 });
    expect(views.get("xdev-hive.approvals")?.badge).toEqual({ value: 6, tooltip: "6 mục đang chờ bạn" });
    expect(views.get("xdev-hive.mine")?.message).toBeUndefined();
    expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledWith(
      "xdev-hive.sdlc",
      expect.objectContaining({ resolveWebviewView: expect.any(Function) }),
    );
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith("xdevHive.sdlc.open", expect.any(Function));
    for (const item of ctx.subscriptions) item.dispose();
    await server.close();
  });

  it("chưa có hub URL thì hiện 'Chưa cấu hình hub xDev Hive' và không gọi mạng", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;
    const ctx = mock.createContext();
    register(ctx as never);
    await flush();
    for (const key of ["mine", "approvals", "runs", "mergeQueue"])
      expect(views.get(`xdev-hive.${key}`)?.message).toBe("Chưa cấu hình hub xDev Hive");
    expect(vscode.authentication.getSession).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const item of ctx.subscriptions) item.dispose();
  });

  it("chưa đăng nhập thì mời kết nối và không gọi mạng", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;
    mock.settings.set("xdevHive.hubUrl", "https://hive.test");
    vi.mocked(vscode.authentication.getSession).mockResolvedValue(undefined as never);
    const ctx = mock.createContext();
    register(ctx as never);
    await flush();
    expect(vscode.authentication.getSession).toHaveBeenCalledWith("xdev-hive", [], { silent: true });
    expect(views.get("xdev-hive.mine")?.message).toBe("Kết nối xDev Hive để xem việc");
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const item of ctx.subscriptions) item.dispose();
  });

  it("cửa sổ mất focus thì không gọi mạng", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;
    mock.settings.set("xdevHive.hubUrl", "https://hive.test");
    focus.focused = false;
    const ctx = mock.createContext();
    register(ctx as never);
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const item of ctx.subscriptions) item.dispose();
  });

  it("log run đi qua SSE vào Output, che token và giữ dòng bị cắt giữa hai chunk", async () => {
    const secret = `hive_pat_${ORG}_abcdef`;
    const body = [
      sse("log", chunk(`xin chào\ntoken ${secret.slice(0, 20)}`, 1), 1),
      sse("log", chunk(`${secret.slice(20)} xong\n`, 2), 2),
      sse("end", {}, 3),
    ].join("");
    const hub = createFakeHub({
      token: TOKEN,
      rpc: { ...hubRoutes(), runs: { search: () => ({ items: [runItem], nextCursor: null, machines: [] }) } } as never,
      stream: () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    });
    const server = await hub.listen();
    mock.settings.set("xdevHive.hubUrl", server.url);
    vi.mocked(vscode.authentication.getSession).mockResolvedValue(session as never);
    const registered = new Map<string, (node?: unknown) => Promise<void>>();
    vi.mocked(vscode.commands.registerCommand).mockImplementation(((name: string, fn: never) => {
      registered.set(name, fn);
      return new mock.Disposable(() => {});
    }) as never);
    const ctx = mock.createContext();
    register(ctx as never);
    await vi.waitFor(() => expect(runsTree()?.getChildren()).toHaveLength(1), { timeout: 5000 });
    const [node] = (runsTree()?.getChildren() ?? []) as unknown[];
    expect(node).toMatchObject({ label: "HIVE-1 · Việc A", description: "Đang chạy" });
    await registered.get("xdevHive.run.openLog")?.(node);
    await vi.waitFor(() => expect(mock.outputLines).toContain("Lượt chạy đã kết thúc"), { timeout: 5000 });
    expect(mock.outputLines).toEqual(["HIVE-1 · Việc A", "xin chào", "token *** xong", "Lượt chạy đã kết thúc"]);
    expect(mock.outputLines.join("\n")).not.toContain("abcdef");
    for (const item of ctx.subscriptions) item.dispose();
    await server.close();
  });
});
