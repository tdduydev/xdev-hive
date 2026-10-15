import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeReviewComment, CodeReviewCommentThread, CodeReviewDetail } from "@xdev-hive/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { createHubClient, type HubClient } from "@/hub/index.ts";
import { ReviewController, renderComment } from "@/review/controller.ts";
import { DiffProvider, openDiffs, parseUri, reviewUri } from "@/review/diff-provider.ts";
import { findRepo, git, prepareRepo, remoteKey } from "@/review/git.ts";
import { decide, register } from "@/review/index.ts";
import "@/review/strings.ts";
import { createHubClient as transportHub } from "@/hub/client.ts";
import { attachBridge } from "@/webview-host/index.ts";

vi.mock("@/hub/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hub/index.ts")>()),
  createHubClient: vi.fn(),
  poll: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock("@/webview-host/html.ts", () => ({
  renderHtml: () => '<body data-screen="review">',
  webviewOptions: () => ({ enableScripts: true }),
}));
vi.mock("@/auth/index.ts", () => ({ auth: {} }));
vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof vscode>();
  const uri = (value: string) => {
    const url = new URL(value);
    return {
      scheme: url.protocol.slice(0, -1),
      path: decodeURIComponent(url.pathname),
      query: url.search.slice(1),
      toString: () => value,
    };
  };
  return {
    ...actual,
    Uri: {
      ...actual.Uri,
      parse: uri,
      from: (ref: { scheme: string; path: string; query: string }) => uri(`${ref.scheme}:${ref.path}?${ref.query}`),
    },
    Range: class {
      start: { line: number; character: number };
      end: { line: number; character: number };
      constructor(a: number, b: number, c: number, d: number) {
        this.start = { line: a, character: b };
        this.end = { line: c, character: d };
      }
    },
    MarkdownString: class {
      value: string;
      constructor(value: string) {
        this.value = value;
      }
    },
    CommentMode: { Preview: 0 },
    CommentThreadState: { Unresolved: 0, Resolved: 1 },
    comments: {
      createCommentController: vi.fn(() => ({
        dispose: vi.fn(),
        createCommentThread: vi.fn((uri, range, comments) => ({ uri, range, comments, dispose: vi.fn() })),
      })),
    },
    extensions: { getExtension: vi.fn() },
    workspace: {
      ...actual.workspace,
      workspaceFolders: [],
      registerTextDocumentContentProvider: vi.fn(() => new actual.Disposable(() => {})),
    },
    window: {
      ...actual.window,
      showInputBox: vi.fn(),
      onDidChangeActiveTextEditor: vi.fn(() => new actual.Disposable(() => {})),
      createWebviewPanel: vi.fn(),
    },
    ViewColumn: { Active: -1 },
  };
});
const sha = "a".repeat(40),
  other = "b".repeat(40);
const id = "00000000-0000-4000-8000-000000000001";
const detail = { id, pr: { headSha: sha }, gates: [] } as unknown as CodeReviewDetail;
const body = "[x](command:evil) <script>bad</script>";
const comment = (over: Partial<CodeReviewComment> = {}): CodeReviewComment => ({
  id: "c",
  threadId: "t",
  authorId: "me",
  authorName: "Tôi",
  body,
  origin: "hive",
  externalAuthor: null,
  createdAt: "2026-10-15T00:00:00Z",
  editedAt: null,
  deletedAt: null,
  ...over,
});
const thread = (over: Partial<CodeReviewCommentThread> = {}): CodeReviewCommentThread => ({
  id: "t",
  path: "a.ts",
  line: 2,
  side: "new",
  headSha: sha,
  outdated: false,
  resolved: false,
  resolvedAt: null,
  resolvedBy: null,
  comments: [comment()],
  ...over,
});
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
beforeEach(() => vi.clearAllMocks());

function setup(threads: CodeReviewCommentThread[]) {
  const api = {
    list: vi.fn(async () => ({ threads })),
    add: vi.fn(),
    reply: vi.fn(),
    edit: vi.fn(),
    delete: vi.fn(),
    resolve: vi.fn(),
    reopen: vi.fn(),
  };
  const hub = { rpc: { codeReviews: { comments: api } } } as unknown as HubClient;
  const provider = new DiffProvider();
  for (const side of ["old", "new"] as const) provider.add({ reviewId: id, side, path: "a.ts", sha }, "/repo");
  const controller = new ReviewController(hub, provider, new Map([[id, detail]]), async () => "me");
  return { api, provider, controller };
}

describe("bình luận review", () => {
  it("hiện 4 luồng: của mình, từ PR, đã cũ và đã xử lý; markdown không được tin cậy", async () => {
    const { controller } = setup([
      thread(),
      thread({
        id: "external",
        comments: [comment({ origin: "github", externalAuthor: "login", authorId: null, syncState: "synced" })],
      }),
      thread({ id: "old", outdated: true }),
      thread({ id: "resolved", resolved: true }),
    ]);
    await controller.refresh(id);
    const calls = vi
      .mocked(controller.controller.createCommentThread)
      .mock.results.map((r) => r.value as vscode.CommentThread);
    expect(calls).toHaveLength(4);
    expect(calls[1]?.comments[0]?.author.name).toBe("login · GitHub");
    expect(calls[1]?.comments[0]?.label).toBe("Đã đồng bộ");
    expect(calls[2]?.comments[0]?.contextValue).toContain("outdated");
    expect(calls[3]?.state).toBe(vscode.CommentThreadState.Resolved);
    const markdown = calls[0]?.comments[0]?.body as vscode.MarkdownString;
    expect(markdown.value).toBe(body);
    expect(markdown.isTrusted).toBe(false);
    expect(markdown.supportHtml).toBe(false);
    controller.dispose();
  });
  it("add dùng đúng phía cũ, dòng 1-based và head PR; reply dùng threadId", async () => {
    const { controller, api, provider } = setup([thread()]);
    const uri = provider.add({ reviewId: id, side: "old", path: "a.ts", sha: other }, "/repo", false, "a.ts", sha);
    const draft = { uri, range: new vscode.Range(2, 0, 2, 0), dispose: vi.fn() } as unknown as vscode.CommentThread;
    await controller.submit({ thread: draft, text: "góp ý" });
    expect(api.add).toHaveBeenCalledWith({
      reviewId: id,
      path: "a.ts",
      line: 3,
      side: "old",
      headSha: sha,
      body: "góp ý",
    });
    const existing = [...controller.threads.keys()][0];
    if (!existing) throw new Error("Thiếu luồng bình luận");
    await controller.submit({ thread: existing, text: "trả lời" });
    expect(api.reply).toHaveBeenCalledWith({ threadId: "t", body: "trả lời" });
    await controller.resolve([...controller.threads.keys()][0] ?? existing, true);
    expect(api.resolve).toHaveBeenCalledWith({ threadId: "t" });
    const current = [...controller.threads.keys()][0];
    if (!current) throw new Error("Thiếu luồng bình luận");
    await controller.resolve(current, false);
    expect(api.reopen).toHaveBeenCalledWith({ threadId: "t" });
    controller.dispose();
  });
  it("chỉ cho sửa/xoá bình luận Hive của mình; hiện trạng thái đồng bộ", async () => {
    const { controller, api } = setup([]);
    const own = renderComment(comment({ syncState: "failed" }), false, "me");
    expect(own.contextValue).toContain("mine.syncFailed");
    expect(own.label).toBe("Đồng bộ thất bại");
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("đã sửa");
    await controller.change(own, false);
    expect(api.edit).toHaveBeenCalledWith({ commentId: "c", body: "đã sửa" });
    await controller.change(own, true);
    expect(api.delete).toHaveBeenCalledTimes(1);
    await controller.change(renderComment(comment({ origin: "gitlab", externalAuthor: "dev" }), false, "me"), true);
    expect(api.delete).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
  it("chặn quyết định khi SHA mới; gửi SHA đã xem; xử lý xung đột lúc gửi", async () => {
    const get = vi.fn(async () => ({ pr: { headSha: other } })),
      send = vi.fn();
    const hub = { rpc: { codeReviews: { get, decide: send } } } as unknown as HubClient;
    await expect(decide(hub, detail, "approve")).rejects.toThrow("PR đã có commit mới, tải lại trước khi duyệt");
    expect(send).not.toHaveBeenCalled();
    get.mockResolvedValue({ pr: { headSha: sha } });
    await decide(hub, detail, "changes", "cần sửa");
    expect(send).toHaveBeenCalledWith({ id, headSha: sha, decision: "changes", note: "cần sửa" });
    send.mockRejectedValue({ code: "CONFLICT" });
    await expect(decide(hub, detail, "approve")).rejects.toThrow("PR đã có commit mới");
  });
});

describe("Git và diff chỉ đọc", () => {
  it("fetch, merge-base, nội dung đổi tên/thêm/xoá không đổi working tree", async () => {
    const cache = join(process.cwd(), "../../.e2e/vscode-review");
    await mkdir(cache, { recursive: true });
    const root = await mkdtemp(join(cache, "git-"));
    roots.push(root);
    const repo = join(root, "repo"),
      remote = join(root, "remote.git");
    await git(root, ["init", repo]);
    await git(repo, ["config", "user.name", "Review"]);
    await git(repo, ["config", "user.email", "review@example.test"]);
    await git(repo, ["checkout", "-b", "main"]);
    await writeFile(join(repo, "old.ts"), "base\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);

    const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["checkout", "-b", "feature"]);
    await git(repo, ["mv", "old.ts", "new.ts"]);
    await git(repo, ["commit", "-m", "rename"]);
    await git(root, ["clone", "--bare", repo, remote]);
    await git(repo, ["remote", "add", "origin", remote]);
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(repo, "new.ts"), "local dirty\n");
    await writeFile(join(repo, "untracked.txt"), "keep\n");
    const status = await git(repo, ["status", "--porcelain=v1"]);
    expect(await prepareRepo(repo, "feature", "main", head)).toBe(base);
    const provider = new DiffProvider();
    const old = provider.add({ reviewId: id, side: "old", path: "new.ts", sha: base }, repo, false, "old.ts");
    expect(await provider.provideTextDocumentContent(old)).toBe("base\n");
    const added = provider.add({ reviewId: id, side: "old", path: "added.ts", sha: base }, repo, true);
    const removed = provider.add({ reviewId: id, side: "new", path: "removed.ts", sha: head }, repo, true);
    expect(await provider.provideTextDocumentContent(added)).toBe("");
    expect(await provider.provideTextDocumentContent(removed)).toBe("");
    expect(await git(repo, ["status", "--porcelain=v1"])).toBe(status);
    expect(await git(repo, ["diff"])).toContain("local dirty");
    provider.dispose();
  }, 60_000);
  it("từ chối URI và ref nguy hiểm; fallback vscode.diff", async () => {
    expect(parseUri(vscode.Uri.parse(`hive-review:/${id}/new/../secret?sha=${sha}`))).toBeUndefined();
    await expect(prepareRepo("/repo", "--upload-pack=evil", "main", sha)).rejects.toThrow();
    expect(remoteKey("git@example.test:org/repo.git")).toBe(remoteKey("https://example.test/org/repo"));
    const uri = reviewUri({ reviewId: id, side: "new", path: "a.ts", sha });
    vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error("unsupported"));
    await openDiffs("Review", [[uri, uri, uri]]);
    expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith("vscode.diff", uri, uri, "Review");
    expect(await findRepo([])).toBeUndefined();
  });
});

describe("nối review với editor và RPC", () => {
  it("2 file, 3 phát hiện AI và 1 luồng người tạo đúng 4 luồng; hỏi lại giữ luồng người", async () => {
    const { controller, provider } = setup([thread()]);
    const gates = [
      {
        reviewers: [
          {
            cli: "codex",
            findings: [
              { file: "a.ts", line: 1, severity: "major", message: "Lỗi lớn" },
              { file: "b.ts", line: 2, severity: "minor", message: "Lỗi nhỏ" },
              { file: "b.ts", line: 3, severity: "info", message: "Góp ý" },
            ],
          },
        ],
      },
    ] as CodeReviewDetail["gates"];
    const local = new ReviewController(
      { rpc: { codeReviews: { comments: { list: async () => ({ threads: [thread()] }) } } } } as unknown as HubClient,
      provider,
      new Map([[id, { ...detail, gates }]]),
      async () => "me",
    );
    provider.add({ reviewId: id, side: "new", path: "b.ts", sha }, "/repo");
    await local.refresh(id);
    const make = vi.mocked(local.controller.createCommentThread);
    expect(make).toHaveBeenCalledTimes(4);
    const human = [...local.threads.keys()][0];
    const ai = make.mock.results.slice(1).map((result) => result.value as vscode.CommentThread);
    expect(ai.every((item) => !item.canReply)).toBe(true);
    expect(ai[0]?.comments[0]?.label).toBe("AI · Lỗi lớn");
    await local.refresh(id);
    expect([...local.threads.keys()][0]).toBe(human);
    expect(human?.dispose).not.toHaveBeenCalled();
    local.dispose();
    controller.dispose();
  });
  it("không có repo mở CodeReviewPane và giải phóng cầu nối khi đóng panel", async () => {
    const get = vi.fn(async () => ({ ...detail, project: { id } }));
    vi.mocked(createHubClient).mockReturnValue({
      rpc: {
        codeReviews: { get },
        projects: { get: async () => ({ repo: { httpUrl: null, sshUrl: null, webUrl: null } }) },
      },
    } as unknown as HubClient);
    let closed: (() => void) | undefined;
    const listener = vi.fn();
    const panel = {
      webview: { html: "", onDidReceiveMessage: vi.fn(() => ({ dispose: listener })), postMessage: vi.fn() },
      onDidDispose: vi.fn((callback: () => void) => {
        closed = callback;
        return { dispose: vi.fn() };
      }),
      dispose: vi.fn(),
    };
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as unknown as vscode.WebviewPanel);
    const ctx = { subscriptions: [], extensionUri: vscode.Uri.file("/ext") } as unknown as vscode.ExtensionContext;
    register(ctx);
    const open = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.find(([name]) => name === "xdevHive.review.open")?.[1];
    expect(open).toBeDefined();
    await open?.(id);
    expect(panel.webview.html).toContain(`data-review-id="${id}"`);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    closed?.();
    expect(listener).toHaveBeenCalled();
    for (const disposable of ctx.subscriptions) disposable.dispose();
  });
  it("cầu nối review cho phép bình luận nhưng chặn thủ tục ngoài màn", async () => {
    let receive: ((message: unknown) => Promise<void>) | undefined;
    const post = vi.fn();
    const webview = {
      onDidReceiveMessage: (callback: typeof receive) => {
        receive = callback;
        return { dispose: vi.fn() };
      },
      postMessage: post,
    } as unknown as vscode.Webview;
    const rpc = vi.fn(async () => ({ status: 200, body: '{"json":{"ok":true}}', contentType: "application/json" }));
    const bridge = attachBridge(webview, "review", { rpc });
    await receive?.({
      id: "allowed",
      type: "rpc",
      path: "/rpc/codeReviews/comments/add",
      method: "POST",
      body: '{"json":{}}',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    await receive?.({ id: "blocked", type: "rpc", path: "/rpc/tasks/create", method: "POST", body: '{"json":{}}' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ status: 403 }));
    bridge.dispose();
  });
});

it("xung đột SHA qua HTTP thật của hub client vẫn hiện thông báo tải lại", async () => {
  const hub = transportHub({
    hubUrl: () => "http://hub.test",
    auth: { token: async () => `hive_pat_${id}_test`, invalidate: vi.fn() },
    fetch: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("/get")
        ? Response.json({ json: detail })
        : Response.json({ json: { code: "CONFLICT" } }, { status: 409 });
    },
  });
  await expect(decide(hub, detail, "approve")).rejects.toThrow("PR đã có commit mới, tải lại trước khi duyệt");
});
