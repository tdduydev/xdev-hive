import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { segments } from "@/components/doc-view.tsx";
import { type Account, AccountContext } from "@/lib/account.ts";
import {
  type AgentEvent,
  applyEvent,
  buildPrompt,
  type ChatState,
  citations,
  emptyChat,
  extractProposal,
  resetAgentStore,
} from "@/lib/agent.ts";
import { saveFolder } from "@/lib/folder.ts";
import type { HubProject } from "@/lib/hub.ts";
import { setLang } from "@/lib/i18n.ts";
import { resetTerminals } from "@/lib/pty.ts";
import { DocsScreen, slugify } from "@/screens/docs-screen.tsx";

/** xterm.js giả: jsdom không có canvas. Ghi lại thứ được vẽ và cho test gõ phím vào. */
interface FakeTerm {
  options: Record<string, unknown>;
  written: (string | Uint8Array)[];
  type: (data: string) => void;
}
const xterm = vi.hoisted(() => ({ terms: [] as FakeTerm[] }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    written: (string | Uint8Array)[] = [];
    type: (data: string) => void = () => {};
    constructor(options: Record<string, unknown>) {
      this.options = options;
      xterm.terms.push(this);
    }
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    write(data: string | Uint8Array) {
      this.written.push(data);
    }
    onData(handler: (data: string) => void) {
      this.type = handler;
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

const FOLDER = "/w/payment-api";
const KEY = "project/payment-api/architecture";
const HUB_DOC = "# Kiến trúc payment-api\n\n## 1. Tổng quan\n\nWorker là một binary Go.\n\n## 2. Kênh tới hub\n\nTODO";
const PROPOSAL =
  "# Kiến trúc payment-api\n\n## 1. Tổng quan\n\nWorker là một binary Go.\n\n## 2. Kênh tới hub\n\nWorker giữ một WebSocket tới hub, thử lại với thời gian chờ tăng dần (`internal/channel/ws.go:42`).\n\nProxy công ty: dự kiến, chưa có code.";

const ACCOUNT: Account = {
  name: "Phạm Hà",
  email: "ha@acme.vn",
  orgId: "o1",
  orgName: "Acme",
  orgRole: "member",
  teams: [{ id: "t1", name: "Thanh toán", role: "member" }],
};
const WRITER: Account = { ...ACCOUNT, teams: [{ id: "t1", name: "Thanh toán", role: "viewer" }] };
const PROJECT: HubProject = {
  key: "payment-api",
  name: "payment-api",
  state: "active",
  repo: {
    kind: "github",
    owner: "acme",
    name: "payment-api",
    httpUrl: "https://github.com/acme/payment-api.git",
    sshUrl: "git@github.com:acme/payment-api.git",
    webUrl: null,
  },
};

type Call = { command: string; args?: Record<string, unknown> | undefined };

const GUIDE = "# Hướng dẫn\n\nBản cũ.";

function fakeTauri() {
  const calls: Call[] = [];
  const listeners: Record<string, (e: { payload: unknown }) => void> = {};
  const files: Record<string, string> = {
    "docs/guide.md": GUIDE,
    "go.mod": "module example.com/w\n\ngo 1.27\n",
    "internal/channel/ws.go": "package channel\n\nfunc Dial() {}\n",
  };
  let ptys = 0;
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    workspace_meta: () => ({
      folder: FOLDER,
      name: "payment-api",
      isGit: true,
      branch: "feat/proxy",
      remote: "git@github.com:acme/payment-api.git",
    }),
    folder_tree: () => [
      { path: "internal", dir: true, depth: 0 },
      { path: "internal/channel", dir: true, depth: 1 },
      { path: "docs", dir: true, depth: 0 },
      { path: "docs/guide.md", dir: false, depth: 1 },
      { path: "go.mod", dir: false, depth: 0 },
      { path: "Makefile", dir: false, depth: 0 },
    ],
    folder_docs: () => ["docs/guide.md"],
    folder_list: (args) =>
      args?.path === "internal/channel" ? [{ path: "internal/channel/ws.go", dir: false, depth: 2 }] : [],
    read_local_file: (args) => {
      const path = String(args?.path);
      if (!(path in files)) throw `Không tìm thấy ${path}.`;
      return {
        content: files[path],
        size: files[path]?.length,
        modifiedMs: 1,
        writable: /\.(md|mdx|markdown|txt)$/.test(path),
      };
    },
    write_local_file: (args) => {
      files[String(args?.path)] = String(args?.content);
      return 2;
    },
    cli_profiles: () => ({
      path: "/Users/ha/.xdev-hive/worker.yaml",
      accounts: [
        {
          id: "claude-2",
          label: "claude-2",
          cli: "claude",
          enabled: true,
          priority: 1,
          maxConcurrent: 1,
          cooldownMinutes: 0,
          supported: true,
          loggedIn: true,
          email: "ha@acme.vn",
        },
        {
          id: "codex-1",
          label: "codex-1",
          cli: "codex",
          enabled: true,
          priority: 1,
          maxConcurrent: 1,
          cooldownMinutes: 0,
          supported: true,
          loggedIn: true,
        },
      ],
    }),
    pty_open: () => `pty-${++ptys}`,
    pty_write: () => null,
    pty_resize: () => null,
    pty_close: () => null,
    cli_accounts: () => [
      {
        engine: "claude",
        installed: true,
        version: "2.1.296",
        loggedIn: true,
        method: "claude.ai",
        email: "ha@acme.vn",
        plan: "max",
      },
      {
        engine: "codex",
        installed: true,
        version: "0.162.1",
        loggedIn: true,
        method: "ChatGPT",
        email: null,
        plan: null,
      },
    ],
    hub_tool: (args) => {
      const name = args?.name;
      if (name === "project_list") return { projects: [PROJECT] };
      if (name === "doc_list")
        return {
          docs: [{ key: KEY, title: "Kiến trúc payment-api", version: 3, updatedAt: "2026-10-12T00:00:00Z" }],
        };
      if (name === "doc_get")
        return { key: KEY, title: "Kiến trúc payment-api", version: 3, content: HUB_DOC, nextOffset: null };
      throw new Error(`tool chưa giả: ${String(name)}`);
    },
    run_cli_stream: () => "run-1",
    cancel_cli_stream: () => null,
    propose_doc: (args) => ({ proposalId: "4f1c2d3e-aaaa", status: "pending", key: args?.key, baseVersion: 3 }),
    "plugin:dialog|open": () => FOLDER,
  };
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const h = handlers[command];
        if (!h) throw new Error(`lệnh chưa giả: ${command}`);
        return (await h(args)) as T;
      },
    },
    event: {
      listen: async <T,>(event: string, handler: (e: { payload: T }) => void) => {
        listeners[event] = handler as (e: { payload: unknown }) => void;
        return () => {};
      },
    },
  };
  const push = async (...events: AgentEvent[]) => {
    for (const event of events) await act(async () => listeners["cli:event"]?.({ payload: { runId: "run-1", event } }));
  };
  const emit = (event: string, payload: unknown) => act(async () => listeners[event]?.({ payload }));
  return { calls, push, emit, files };
}

const renderDocs = (account: Account | null = ACCOUNT) =>
  render(
    <AccountContext.Provider value={account}>
      <DocsScreen />
    </AccountContext.Provider>,
  );

const RESULT: AgentEvent = {
  kind: "result",
  ok: true,
  text: null,
  error: null,
  inputTokens: 12_511,
  cachedTokens: 5_956,
  outputTokens: 941,
  costUsd: 0.0018,
  durationMs: 6400,
};

describe("đề xuất trong câu trả lời của agent", () => {
  it("lấy khối ````markdown, giữ khối code bên trong", () => {
    const text = `Tôi đã viết lại.\n\n\`\`\`\`markdown\n# A\n\n\`\`\`go\nfunc main() {}\n\`\`\`\n\nHết.\n\`\`\`\`\n\nXong.`;
    expect(extractProposal(text)).toBe("# A\n\n```go\nfunc main() {}\n```\n\nHết.");
  });

  it("khối ```markdown có code lồng vẫn lấy đủ, câu không có khối thì không có đề xuất", () => {
    const text = "```markdown\n# B\n```bash\nmake\n```\nCuối.\n```\nGhi chú.";
    expect(extractProposal(text)).toBe("# B\n```bash\nmake\n```\nCuối.");
    expect(extractProposal("Chỉ trả lời câu hỏi, không sửa tài liệu.")).toBeNull();
    expect(extractProposal("```go\nx\n```")).toBeNull();
  });

  it("trích chỗ trong code thành nhãn", () => {
    expect(citations("theo `internal/channel/ws.go:42` và `internal/cli/download.go`, không phải `go`")).toEqual([
      "internal/channel/ws.go:42",
      "internal/cli/download.go",
    ]);
  });

  it("lời nhắc có bản nháp, đòi chỉ đọc, đánh dấu dự kiến", () => {
    const p = buildPrompt("Viết tài liệu kiến trúc", { key: KEY, title: "Kiến trúc", draft: HUB_DOC }, "vi");
    expect(p.startsWith("Viết tài liệu kiến trúc\n")).toBe(true);
    expect(p).toContain("read-only");
    expect(p).toContain(`<current-doc>\n${HUB_DOC}\n</current-doc>`);
    expect(p).toContain("````markdown");
    expect(p).toContain('"dự kiến"');
    expect(buildPrompt("Có gì trong repo?", null, "en")).not.toContain("<current-doc>");
  });

  it("lời nhắc có bản đồ thư mục và danh sách tài liệu để agent không Glob cả repo lớn", () => {
    const map = {
      tree: [
        { path: "docs", dir: true, depth: 0 },
        { path: "docs/spec", dir: true, depth: 1 },
        { path: "README.md", dir: false, depth: 0 },
      ],
      docs: ["README.md", "docs/spec/srs.docx"],
    };
    const p = buildPrompt("Tóm tắt tài liệu", null, "vi", map);
    expect(p).toContain("do not Glob or Grep `**` from the root");
    expect(p).toContain("  - docs/spec/srs.docx");
    expect(p).toContain("    docs/spec/");
    const none = buildPrompt("Tóm tắt tài liệu", null, "vi", { tree: [], docs: [] });
    expect(none).toContain("No document files");
    expect(buildPrompt("x", null, "vi")).not.toContain("Glob");
  });

  it("gom sự kiện: file đã đọc, đọc lỗi bỏ chấm, kế hoạch thay chỗ, kết quả thành đề xuất", () => {
    let s: ChatState = { ...emptyChat(FOLDER, "codex"), docKey: KEY, runId: "run-1" };
    const events: AgentEvent[] = [
      { kind: "session", id: "01a12fc6-f57d-7833-bbae-a1fcd5044a11", model: null },
      { kind: "tool", id: "i1", name: "shell", arg: "cat go.mod", paths: ["go.mod"] },
      { kind: "toolDone", id: "i1", ok: true, lines: 4, files: null, preview: "module x" },
      { kind: "tool", id: "i2", name: "Read", arg: "secret.txt", paths: ["secret.txt"] },
      { kind: "toolDone", id: "i2", ok: false, lines: null, files: null, preview: "outside" },
      { kind: "todos", items: [{ text: "Đọc", status: "doing" }] },
      { kind: "todos", items: [{ text: "Đọc", status: "done" }] },
      { kind: "text", text: `Đây là bản mới.\n\`\`\`\`markdown\n${PROPOSAL}\n\`\`\`\`` },
      RESULT,
      { kind: "exit", code: 0, cancelled: false, stderr: "" },
    ];
    for (const e of events) s = applyEvent(s, e);
    expect(s.session).toBe("01a12fc6-f57d-7833-bbae-a1fcd5044a11");
    expect(s.read).toEqual(["go.mod"]);
    expect(s.items.filter((i) => i.kind === "todos")).toHaveLength(1);
    expect(s.suggestion).toEqual({ key: KEY, text: PROPOSAL });
    expect(s.runId).toBeNull();
    expect(s.items.some((i) => i.kind === "stopped")).toBe(false);
  });

  it("thoát lỗi khi chưa có kết quả thì báo; huỷ thì báo đã dừng", () => {
    const failed = applyEvent(
      { ...emptyChat(FOLDER), items: [{ kind: "user", text: "x" }] },
      { kind: "exit", code: 1, cancelled: false, stderr: "Not logged in" },
    );
    expect(failed.items.at(-1)).toEqual({ kind: "stopped", cancelled: false, stderr: "Not logged in", code: 1 });
  });

  it("so đoạn: phần thêm, phần bỏ, giữ nguyên", () => {
    expect(segments("a\nb\nc", "a\nB\nc\nd").map((s) => s.kind)).toEqual(["same", "del", "add", "same", "add"]);
  });

  it("tên tài liệu mới thành key không dấu", () => {
    expect(slugify("Kiến trúc Đường ống")).toBe("kien-truc-duong-ong");
    expect(slugify("  API v2.md ")).toBe("api-v2.md");
  });
});

describe("DocsScreen", () => {
  beforeEach(() => {
    setLang("vi");
    resetAgentStore();
    resetTerminals();
    xterm.terms.length = 0;
    saveFolder(FOLDER);
  });

  it("chạy Claude Code, hiện luồng, nhận đề xuất rồi gửi lên hub", async () => {
    const { calls, push } = fakeTauri();
    const user = userEvent.setup();
    renderDocs();

    // Cột trái: tài liệu của dự án trên hub và cây code; giữa: bản trên hub.
    const explorer = screen.getByRole("complementary", { name: "Thư mục" });
    expect(await within(explorer).findByRole("button", { name: /architecture/ })).toBeTruthy();
    expect(within(explorer).getByText("↔ payment-api")).toBeTruthy();
    expect(within(explorer).getByText("⎇ feat/proxy")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Kiến trúc payment-api" })).toBeTruthy();
    expect(screen.getByText("Khớp bản v3 trên hub")).toBeTruthy();
    expect(calls.find((c) => c.args?.name === "doc_list")?.args).toEqual({
      name: "doc_list",
      args: { prefix: "project/payment-api/", limit: 50 },
    });
    expect(await screen.findByText("Claude Code · Claude max · 2.1.296")).toBeTruthy();

    await user.type(
      screen.getByRole("textbox", { name: "Hỏi hoặc yêu cầu viết tài liệu từ code" }),
      "Viết mục kênh tới hub",
    );
    await user.click(screen.getByRole("button", { name: "Gửi" }));
    const run = calls.find((c) => c.command === "run_cli_stream");
    expect(run?.args?.engine).toBe("claude");
    expect(run?.args?.folder).toBe(FOLDER);
    expect(run?.args?.session).toBeNull();
    expect(String(run?.args?.prompt)).toContain("Viết mục kênh tới hub");
    expect(String(run?.args?.prompt)).toContain(`<current-doc>\n${HUB_DOC}\n</current-doc>`);
    expect(screen.getByRole("button", { name: "Dừng" })).toBeTruthy();

    await push(
      { kind: "session", id: "7854d262-d8c6-4701-964c-dee4af8a1f1b", model: "claude-opus-5-5" },
      { kind: "tool", id: "t1", name: "Read", arg: "go.mod", paths: ["go.mod"] },
    );
    // Tool đang chạy: dòng kết quả còn chờ.
    expect(screen.getByText(/⎿ …/)).toBeTruthy();
    expect(screen.getByText("Read").parentElement?.textContent).toContain("Read(go.mod)");
    await push({ kind: "toolDone", id: "t1", ok: true, lines: 4, files: null, preview: "1\tmodule" });
    expect(screen.getByText(/Đọc 4 dòng/)).toBeTruthy();
    // Chấm xanh ở go.mod trong cây code.
    const goMod = within(explorer).getByTitle("go.mod");
    expect(within(goMod).getByText("AI đã đọc")).toBeTruthy();
    expect(within(within(explorer).getByTitle("Makefile")).queryByText("AI đã đọc")).toBeNull();

    await push(
      { kind: "text", text: `Tôi đã viết mục Kênh tới hub.\n\n\`\`\`\`markdown\n${PROPOSAL}\n\`\`\`\`` },
      { ...RESULT, text: `Tôi đã viết mục Kênh tới hub.\n\n\`\`\`\`markdown\n${PROPOSAL}\n\`\`\`\`` },
      { kind: "exit", code: 0, cancelled: false, stderr: "" },
    );
    expect(screen.getByText(/Xong · 12,5k token vào · 941 ra · \$0\.0018 · 6,4 giây/)).toBeTruthy();
    expect(screen.getByText(`Đề xuất cho ${KEY} hiện trong trình soạn: +3 −1 dòng`)).toBeTruthy();
    // Khối tài liệu không lặp lại trong khung chat, chỉ còn câu giải thích.
    expect(screen.getByText("Tôi đã viết mục Kênh tới hub.")).toBeTruthy();

    // Trình soạn: phần AI thêm tô xanh kèm chỗ trong code, phần chưa có code tô vàng.
    expect(screen.getByText("Có đề xuất chưa nhận")).toBeTruthy();
    const added = screen.getAllByTestId("ins");
    expect(within(added[0] as HTMLElement).getByText("AI thêm")).toBeTruthy();
    expect(screen.getAllByText("internal/channel/ws.go:42").length).toBeGreaterThan(0);
    expect(screen.getByTestId("del").textContent).toContain("TODO");
    expect(screen.getByText(/Proxy công ty: dự kiến/).className).toContain("text-warning");
    // Chưa liên kết phiên trước đó: phiên mới được nhớ cho lần hỏi tiếp.
    expect(JSON.parse(localStorage.getItem("hive.docs.sessions") ?? "[]")[0]).toMatchObject({
      id: "7854d262-d8c6-4701-964c-dee4af8a1f1b",
      engine: "claude",
      folder: FOLDER,
      title: "Viết mục kênh tới hub",
    });

    await user.click(screen.getByRole("button", { name: "Nhận tất cả" }));
    expect(screen.getByText("Bản nháp chưa gửi")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("hive.docs.drafts") ?? "{}")[KEY]).toMatchObject({
      base: 3,
      text: PROPOSAL,
    });

    await user.click(screen.getByRole("tab", { name: "So với hub" }));
    expect(screen.getByText("- TODO")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Đẩy lên hub và gửi duyệt" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Vì sao cần sửa" }), "Viết theo code nhánh feat/proxy");
    await user.click(within(dialog).getByRole("button", { name: "Gửi đề xuất" }));
    expect(calls.find((c) => c.command === "propose_doc")?.args).toEqual({
      key: KEY,
      baseVersion: 3,
      content: PROPOSAL,
      note: "Viết theo code nhánh feat/proxy",
    });
    expect(await within(dialog).findByText(/Đã gửi đề xuất 4f1c2d3e/)).toBeTruthy();
    // Không lệnh nào gọi tool ghi qua hub_tool.
    expect(calls.filter((c) => c.command === "hub_tool").map((c) => c.args?.name)).not.toContain("doc_propose");
  });

  it("bỏ đề xuất thì bản nháp giữ nguyên; mở lại được từ khung chat", async () => {
    const { push } = fakeTauri();
    const user = userEvent.setup();
    renderDocs();
    await screen.findByRole("heading", { name: "Kiến trúc payment-api" });
    await user.type(screen.getByRole("textbox", { name: "Hỏi hoặc yêu cầu viết tài liệu từ code" }), "Cập nhật{Enter}");
    await push(
      { ...RESULT, text: `\`\`\`\`markdown\n${PROPOSAL}\n\`\`\`\`` },
      {
        kind: "exit",
        code: 0,
        cancelled: false,
        stderr: "",
      },
    );
    await user.click(screen.getByRole("button", { name: "Bỏ tất cả" }));
    expect(screen.queryByText("Có đề xuất chưa nhận")).toBeNull();
    expect(screen.getByText("Khớp bản v3 trên hub")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Mở lại đề xuất" }));
    expect(screen.getByText("Có đề xuất chưa nhận")).toBeTruthy();
  });

  it("Codex: chạy chỉ đọc, hiện lệnh shell theo kiểu Codex; huỷ thì dừng", async () => {
    const { calls, push } = fakeTauri();
    const user = userEvent.setup();
    renderDocs();
    await screen.findByRole("heading", { name: "Kiến trúc payment-api" });
    await user.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByRole("button", { name: "Read Only" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Full Access" }).getAttribute("aria-pressed")).toBe("false");
    await user.type(
      screen.getByRole("textbox", { name: "Hỏi hoặc yêu cầu viết tài liệu từ code" }),
      "Đọc go.mod{Enter}",
    );
    expect(calls.find((c) => c.command === "run_cli_stream")?.args).toMatchObject({
      engine: "codex",
      model: null,
      mode: "read",
    });
    await push(
      { kind: "tool", id: "item_1", name: "shell", arg: "cat go.mod", paths: ["go.mod"] },
      { kind: "toolDone", id: "item_1", ok: true, lines: 4, files: null, preview: "module x" },
      {
        kind: "todos",
        items: [
          { text: "Đọc go.mod", status: "done" },
          { text: "Viết tài liệu", status: "doing" },
        ],
      },
    );
    expect(screen.getByText("Ran")).toBeTruthy();
    expect(screen.getByText(/└ 4 dòng/)).toBeTruthy();
    expect(screen.getByText("Updated Plan")).toBeTruthy();
    expect(screen.getByText(/✔ Đọc go\.mod/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dừng" }));
    expect(calls.find((c) => c.command === "cancel_cli_stream")?.args).toEqual({ runId: "run-1" });
    await push({ kind: "exit", code: null, cancelled: true, stderr: "" });
    expect(screen.getByText(/Đã dừng\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gửi" })).toBeTruthy();
  });

  it("người xem đội: đọc và nhờ AI viết được, không gửi đề xuất", async () => {
    const { push } = fakeTauri();
    const user = userEvent.setup();
    renderDocs(WRITER);
    await screen.findByRole("heading", { name: "Kiến trúc payment-api" });
    await user.type(screen.getByRole("textbox", { name: "Hỏi hoặc yêu cầu viết tài liệu từ code" }), "Viết{Enter}");
    await push({ ...RESULT, text: `\`\`\`\`markdown\n${PROPOSAL}\n\`\`\`\`` });
    await user.click(screen.getByRole("button", { name: "Nhận tất cả" }));
    const pushButton = screen.getByRole("button", { name: "Đẩy lên hub và gửi duyệt" });
    expect(pushButton).toHaveProperty("disabled", true);
    expect(pushButton.getAttribute("title")).toContain("Người xem đội chỉ đọc");
  });

  it("chưa liên kết tài khoản: không gọi hub, vẫn hỏi agent được", async () => {
    const { calls } = fakeTauri();
    renderDocs(null);
    expect(
      (await screen.findAllByText("Liên kết tài khoản để mở tài liệu của dự án trên hub.")).length,
    ).toBeGreaterThan(0);
    expect(calls.some((c) => c.command === "hub_tool")).toBe(false);
    expect(screen.getByRole("textbox", { name: "Hỏi hoặc yêu cầu viết tài liệu từ code" })).toBeTruthy();
  });

  it("mẫu yêu cầu bằng /, lỗi chạy CLI hiện trong khung chat", async () => {
    const { calls } = fakeTauri();
    window.__TAURI__ = {
      ...(window.__TAURI__ as NonNullable<typeof window.__TAURI__>),
      core: {
        invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
          calls.push({ command, args });
          if (command === "run_cli_stream") throw "Chưa cài Claude Code trên máy (không thấy lệnh claude).";
          if (command === "cli_accounts") return [] as T;
          if (command === "folder_tree") return [] as T;
          throw new Error(`lệnh chưa giả: ${command}`);
        },
      },
    };
    const user = userEvent.setup();
    renderDocs(null);
    await user.click(screen.getByRole("button", { name: "Mẫu yêu cầu" }));
    await user.click(screen.getByRole("menuitem", { name: /Tài liệu kiến trúc/ }));
    const box = screen.getByRole("textbox", { name: "Hỏi hoặc yêu cầu viết tài liệu từ code" }) as HTMLTextAreaElement;
    expect(box.value).toContain("Viết tài liệu kiến trúc từ code hiện có");
    await user.click(screen.getByRole("button", { name: "Gửi" }));
    expect(await screen.findByText(/Chưa cài Claude Code trên máy/)).toBeTruthy();
  });

  it("chưa chọn thư mục: vẫn xem tài liệu trên hub; chỉ khung chat và cây code mời chọn thư mục", async () => {
    saveFolder("");
    const { calls } = fakeTauri();
    renderDocs();
    const explorer = screen.getByRole("complementary", { name: "Thư mục" });
    expect(await within(explorer).findByRole("button", { name: /architecture/ })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Kiến trúc payment-api" })).toBeTruthy();
    expect(within(explorer).getByText("Chưa chọn thư mục")).toBeTruthy();
    expect(within(explorer).getByText("Chọn thư mục để xem code.")).toBeTruthy();
    const chat = screen.getByRole("complementary", { name: "Hỏi về thư mục này" });
    expect(within(chat).getByText(/Chọn thư mục dự án để hỏi AI về code/)).toBeTruthy();
    expect(within(chat).getByRole("textbox", { name: "Hỏi hoặc yêu cầu viết tài liệu từ code" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.queryByText("Đang đọc…")).toBeNull();
    expect(calls.find((c) => c.args?.name === "doc_list")?.args).toEqual({ name: "doc_list", args: { limit: 50 } });
    expect(calls.some((c) => ["workspace_meta", "folder_tree"].includes(c.command))).toBe(false);
    expect(calls.some((c) => c.args?.name === "project_list")).toBe(false);
  });

  it("chọn thư mục từ khung chat thì đọc dự án của thư mục; màn chọn thư mục có nút quay lại; tiếng Anh", async () => {
    saveFolder("");
    setLang("en");
    const { calls } = fakeTauri();
    const user = userEvent.setup();
    renderDocs();
    const explorer = screen.getByRole("complementary", { name: "Explorer" });
    await user.click(within(explorer).getByRole("button", { name: /No folder chosen/ }));
    expect(screen.getByRole("heading", { name: "Pick a folder to write docs in" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back" }));
    const chat = screen.getByRole("complementary", { name: "Ask about this folder" });
    await user.click(within(chat).getByRole("button", { name: "Open folder…" }));
    expect(localStorage.getItem("hive.folder")).toBe(FOLDER);
    expect(await screen.findByText("↔ payment-api")).toBeTruthy();
    expect(calls.filter((c) => c.args?.name === "doc_list").at(-1)?.args).toEqual({
      name: "doc_list",
      args: { prefix: "project/payment-api/", limit: 50 },
    });
    expect(screen.getByRole("textbox", { name: "Ask, or request docs from the code" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("cây: mở thư mục, xem file code, sửa rồi lưu file tài liệu mà không cần hub", async () => {
    const { calls, files } = fakeTauri();
    const user = userEvent.setup();
    renderDocs(null);
    const explorer = screen.getByRole("complementary", { name: "Thư mục" });
    expect(await screen.findByText(/Chọn file ở cột trái để xem code hay sửa tài liệu/)).toBeTruthy();

    // Thư mục cấp 1 có sẵn trong cây; cấp sâu hơn đọc khi bấm.
    const internal = await within(explorer).findByTitle("internal");
    expect(internal.getAttribute("aria-expanded")).toBe("false");
    expect(within(explorer).queryByTitle("internal/channel")).toBeNull();
    await user.click(internal);
    expect(internal.getAttribute("aria-expanded")).toBe("true");
    await user.click(within(explorer).getByTitle("internal/channel"));
    expect(calls.find((c) => c.command === "folder_list")?.args).toEqual({ folder: FOLDER, path: "internal/channel" });
    await user.click(await within(explorer).findByTitle("internal/channel/ws.go"));
    const code = await screen.findByTestId("code");
    expect(code.textContent).toContain("func Dial() {}");
    expect(screen.getByText("Chỉ xem")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lưu vào file" })).toBeNull();
    // Thu thư mục lại thì con biến mất.
    await user.click(internal);
    expect(within(explorer).queryByTitle("internal/channel")).toBeNull();

    await user.click(within(explorer).getByTitle("docs"));
    await user.click(within(explorer).getByTitle("docs/guide.md"));
    expect(await screen.findByRole("heading", { name: "Hướng dẫn" })).toBeTruthy();
    expect(screen.getByText("Tài liệu trên máy")).toBeTruthy();
    expect(within(explorer).getByTitle("docs/guide.md").getAttribute("aria-current")).toBe("true");
    await user.click(screen.getByRole("tab", { name: "Sửa" }));
    const editor = screen.getByRole("textbox", { name: "docs/guide.md" });
    await user.clear(editor);
    await user.type(editor, "# Hướng dẫn{Enter}{Enter}Bản mới.");
    expect(screen.getByText("Chưa lưu")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Lưu vào file" }));
    expect(calls.find((c) => c.command === "write_local_file")?.args).toEqual({
      folder: FOLDER,
      path: "docs/guide.md",
      content: "# Hướng dẫn\n\nBản mới.",
    });
    expect(files["docs/guide.md"]).toBe("# Hướng dẫn\n\nBản mới.");
    expect(await screen.findByText("Đã lưu vào file")).toBeTruthy();
    expect(calls.some((c) => c.command === "hub_tool")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Đóng file" }));
    expect(screen.queryByRole("region", { name: "File trong thư mục" })).toBeNull();
  });

  it("chọn model, bật Accept edits; agent sửa file thì file đang mở đọc lại; Bypass phải xác nhận", async () => {
    const { calls, push, files } = fakeTauri();
    const user = userEvent.setup();
    renderDocs();
    await screen.findByRole("heading", { name: "Kiến trúc payment-api" });
    const explorer = screen.getByRole("complementary", { name: "Thư mục" });
    await user.click(await within(explorer).findByTitle("docs"));
    await user.click(within(explorer).getByTitle("docs/guide.md"));
    expect(await screen.findByText("Bản cũ.")).toBeTruthy();

    await user.selectOptions(screen.getByRole("combobox", { name: "Model" }), "opus");
    expect(JSON.parse(localStorage.getItem("hive.docs.models") ?? "{}")).toMatchObject({ claude: "opus" });
    await user.click(screen.getByRole("button", { name: "Accept edits" }));
    expect(screen.getByRole("button", { name: "Accept edits" }).getAttribute("aria-pressed")).toBe("true");
    await user.type(
      screen.getByRole("textbox", { name: "Hỏi hoặc yêu cầu viết tài liệu từ code" }),
      "Sửa guide{Enter}",
    );
    const run = calls.find((c) => c.command === "run_cli_stream");
    expect(run?.args).toMatchObject({ engine: "claude", model: "opus", mode: "edit" });
    expect(String(run?.args?.prompt)).toContain("allowed you to edit and create files");
    expect(String(run?.args?.prompt)).toContain("`docs/guide.md` open in the editor");
    // File trên máy đang mở: không đề xuất cho tài liệu hub.
    expect(String(run?.args?.prompt)).not.toContain("<current-doc>");

    files["docs/guide.md"] = "# Hướng dẫn\n\nAgent đã sửa.";
    await push(
      { kind: "tool", id: "t1", name: "Edit", arg: "docs/guide.md", paths: [] },
      { kind: "toolDone", id: "t1", ok: true, lines: null, files: null, preview: "" },
    );
    expect(await screen.findByText("Agent đã sửa.")).toBeTruthy();
    await push({ ...RESULT, text: "Xong." }, { kind: "exit", code: 0, cancelled: false, stderr: "" });

    // Bypass: hỏi trước; huỷ thì giữ chế độ cũ.
    await user.click(screen.getByRole("button", { name: "Bypass" }));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/tự chạy lệnh, sửa và xoá file/)).toBeTruthy();
    expect(within(dialog).getByText(/bypassPermissions/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Huỷ" }));
    expect(screen.getByRole("button", { name: "Accept edits" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Bypass" }));
    dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Bật Bypass" }));
    expect(screen.getByRole("button", { name: "Bypass" }).getAttribute("aria-pressed")).toBe("true");
    await user.type(
      screen.getByRole("textbox", { name: "Hỏi hoặc yêu cầu viết tài liệu từ code" }),
      "Chạy test{Enter}",
    );
    expect(calls.filter((c) => c.command === "run_cli_stream").at(-1)?.args).toMatchObject({ mode: "bypass" });
    await push({ kind: "exit", code: 0, cancelled: false, stderr: "" });

    // Đổi agent là phiên mới: Bypass về chỉ đọc. Codex nhập tên model; tên lạ thì không gửi.
    await user.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByRole("button", { name: "Read Only" }).getAttribute("aria-pressed")).toBe("true");
    const codexModel = screen.getByRole("textbox", { name: "Model" });
    await user.type(codexModel, "gpt 5");
    expect(screen.getByText(/Tên model chỉ gồm chữ, số/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gửi" })).toHaveProperty("disabled", true);
    await user.clear(codexModel);
    await user.type(codexModel, "gpt-5.5-codex");
    await user.click(screen.getByRole("button", { name: "Workspace" }));
    await user.type(screen.getByRole("textbox", { name: "Hỏi hoặc yêu cầu viết tài liệu từ code" }), "Sửa{Enter}");
    expect(calls.filter((c) => c.command === "run_cli_stream").at(-1)?.args).toMatchObject({
      engine: "codex",
      model: "gpt-5.5-codex",
      mode: "edit",
    });
  });

  it("tab Terminal: mở PTY trong thư mục bằng gói đã chọn, gõ phím, bỏ hỏi quyền phải xác nhận, đóng tab", async () => {
    const { calls, emit } = fakeTauri();
    const user = userEvent.setup();
    renderDocs();
    const panel = screen.getByRole("complementary", { name: "Hỏi về thư mục này" });
    await user.click(within(panel).getByRole("tab", { name: "Terminal" }));
    expect(within(panel).getByText(/Mở terminal để chạy Claude Code, Codex, Antigravity hay shell/)).toBeTruthy();
    await within(panel).findByRole("option", { name: /claude-2 · ha@acme\.vn/ });
    // Gói của CLI khác không hiện.
    expect(within(panel).queryByRole("option", { name: /codex-1/ })).toBeNull();
    await user.selectOptions(within(panel).getByRole("combobox", { name: "Gói agent" }), "claude-2");
    await user.click(within(panel).getAllByRole("button", { name: "Mở terminal" })[0] as HTMLElement);
    await waitFor(() =>
      expect(calls.find((c) => c.command === "pty_open")?.args).toEqual({
        cli: "claude",
        planId: "claude-2",
        bypass: false,
        folder: FOLDER,
        cols: 80,
        rows: 24,
      }),
    );
    const term = xterm.terms[0] as FakeTerm;
    await waitFor(() => expect(within(panel).getByRole("tab", { name: /Claude Code · claude-2/ })).toBeTruthy());
    await emit("pty:data", { id: "pty-1", data: btoa("Welcome to Claude Code") });
    expect(new TextDecoder().decode(term.written.at(-1) as Uint8Array)).toBe("Welcome to Claude Code");
    term.type("/help\r");
    expect(calls.find((c) => c.command === "pty_write")?.args).toEqual({ id: "pty-1", data: "/help\r" });

    // Bỏ hỏi quyền: hộp xác nhận, rồi terminal mới (tab con) chạy với cờ cố định của Rust.
    await user.selectOptions(within(panel).getByRole("combobox", { name: "Chạy" }), "codex");
    await user.click(within(panel).getByRole("checkbox", { name: "Bỏ hỏi quyền" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/--dangerously-bypass-approvals-and-sandbox/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Mở không hỏi quyền" }));
    expect(within(panel).getByRole("checkbox", { name: "Bỏ hỏi quyền" })).toHaveProperty("checked", true);
    await user.click(within(panel).getByRole("button", { name: "Terminal mới" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.command === "pty_open").at(-1)?.args).toMatchObject({
        cli: "codex",
        planId: null,
        bypass: true,
      }),
    );
    // Mỗi terminal bỏ hỏi quyền phải xác nhận lại.
    expect(within(panel).getByRole("checkbox", { name: "Bỏ hỏi quyền" })).toHaveProperty("checked", false);
    expect(
      within(panel)
        .getByRole("tab", { name: /Codex.*bỏ hỏi quyền/ })
        .getAttribute("aria-selected"),
    ).toBe("true");

    await emit("pty:exit", { id: "pty-2", code: 0 });
    expect(within(panel).getByRole("tab", { name: /Codex.*đã thoát/ })).toBeTruthy();
    await user.click(within(panel).getByRole("button", { name: "Đóng Claude Code · claude-2" }));
    expect(calls.find((c) => c.command === "pty_close")?.args).toEqual({ id: "pty-1" });
    expect(within(panel).queryByRole("tab", { name: /claude-2/ })).toBeNull();

    // Sang Chat rồi quay lại: terminal còn đó.
    await user.click(within(panel).getByRole("tab", { name: "Chat" }));
    await user.click(within(panel).getByRole("tab", { name: "Terminal" }));
    expect(within(panel).getByRole("tab", { name: /Codex/ })).toBeTruthy();
  });
});
