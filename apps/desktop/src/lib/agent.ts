import { useEffect, useSyncExternalStore } from "react";
import { checkProposal, type OutboxSubmission } from "@/lib/outbox.ts";
import { invoke } from "@/lib/tauri.ts";
import type { Engine } from "@/lib/usage.ts";

/**
 * Agent CLI trên máy cho màn Tài liệu (src-tauri/src/cli.rs). Rust chạy Claude Code hoặc Codex chỉ đọc trong thư mục
 * dự án và phát sự kiện `cli:event`; ở đây gom sự kiện thành khung chat. Kho chat nằm ngoài React để lượt chạy vẫn
 * được ghi khi người dùng sang màn khác rồi quay lại.
 */
export type { Engine };

export interface Todo {
  text: string;
  status: "done" | "doing" | "todo";
}

/** Khớp `AgentEvent` trong cli.rs (serde tag "kind", camelCase). */
export type AgentEvent =
  | { kind: "session"; id: string; model: string | null }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; arg: string; paths: string[] }
  | { kind: "toolDone"; id: string; ok: boolean; lines: number | null; files: number | null; preview: string }
  | { kind: "todos"; items: Todo[] }
  | { kind: "limit"; window: string; percent: number }
  | { kind: "notice"; text: string }
  | {
      kind: "result";
      ok: boolean;
      text: string | null;
      error: string | null;
      inputTokens: number;
      cachedTokens: number;
      outputTokens: number;
      costUsd: number | null;
      durationMs: number | null;
    }
  | { kind: "exit"; code: number | null; cancelled: boolean; stderr: string };

export type ToolDone = Extract<AgentEvent, { kind: "toolDone" }>;
export type RunResult = Extract<AgentEvent, { kind: "result" }>;

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; arg: string; done: ToolDone | null }
  | { kind: "todos"; items: Todo[] }
  | { kind: "limit"; window: string; percent: number }
  | { kind: "notice"; text: string }
  | (RunResult & { proposal: string | null; docKey: string | null })
  | { kind: "stopped"; cancelled: boolean; stderr: string; code: number | null };

/** Đề xuất của agent cho một tài liệu, chờ người dùng nhận hay bỏ trong trình soạn. */
export interface Suggestion {
  key: string;
  text: string;
}

export interface ChatState {
  folder: string;
  engine: Engine;
  /** Phiên của CLI để hỏi tiếp (`--resume`, `exec resume`); null là phiên mới. */
  session: string | null;
  model: string | null;
  runId: string | null;
  /** Tài liệu đang mở khi gửi yêu cầu: đề xuất của lượt chạy thuộc về tài liệu này. */
  docKey: string | null;
  items: ChatItem[];
  /** File agent đã đọc trong phiên (chấm xanh ở cây thư mục). */
  read: string[];
  suggestion: Suggestion | null;
  error: string | null;
}

export const emptyChat = (folder = "", engine: Engine = "claude"): ChatState => ({
  folder,
  engine,
  session: null,
  model: null,
  runId: null,
  docKey: null,
  items: [],
  read: [],
  suggestion: null,
  error: null,
});

// ---------------------------------------------------------------------------------------------------------------
// Đề xuất trong câu trả lời

/**
 * Bản tài liệu agent đề xuất: khối ```markdown (hoặc ````markdown) dài nhất trong câu trả lời, kèm phần chữ trước và
 * sau khối. Khối code lồng bên trong (```go … ```) không đóng khối ngoài, kể cả khi agent quên dùng bốn dấu.
 */
export function findProposal(text: string): { body: string; before: string; after: string } | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let best: { body: string; before: string; after: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})\s*(markdown|md)\s*$/i.exec(lines[i] as string);
    if (!open) continue;
    const fence = open[1] as string;
    let depth = 0;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[j] as string);
      if (!m || (m[1] as string)[0] !== fence[0]) continue;
      if ((m[2] as string).trim()) depth++;
      else if (depth > 0) depth--;
      else if ((m[1] as string).length >= fence.length) {
        end = j;
        break;
      }
    }
    if (end < 0) continue;
    const body = lines.slice(i + 1, end).join("\n");
    if (!best || body.length > best.body.length)
      best = {
        body,
        before: lines.slice(0, i).join("\n").trim(),
        after: lines
          .slice(end + 1)
          .join("\n")
          .trim(),
      };
    i = end;
  }
  return best;
}

export const extractProposal = (text: string): string | null => findProposal(text)?.body ?? null;

/** `internal/channel/ws.go:42`: chỗ trong code agent dẫn ra, hiện thành nhãn trích dẫn. */
export function citations(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([\w./-]+\.[a-z0-9]+(?::\d+(?:-\d+)?)?)`/gi)) {
    const c = m[1] as string;
    if (c.includes("/") && !out.includes(c)) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Lời nhắc

export interface PromptDoc {
  key: string;
  title: string;
  draft: string;
}

/**
 * Yêu cầu gửi cho agent: câu của người dùng, rồi bối cảnh của app (chỉ đọc, tài liệu đích, bản nháp hiện tại, cách
 * trả bản đề xuất). Agent trả cả tài liệu trong một khối ````markdown để app so với bản nháp và tô phần thêm.
 */
/** Bản đồ thư mục đưa vào prompt: hai tầng đầu (đã bỏ thư mục sinh ra) và file tài liệu tìm được. */
export interface PromptMap {
  tree: TreeEntry[];
  docs: string[];
}

const MAP_MAX = 120;

/** Bối cảnh thêm: quyền người dùng bật cho lượt chạy và file đang mở ở khung giữa. */
export interface PromptContext {
  access?: Access;
  openFile?: string | null;
}

const ACCESS_RULE: Record<Access, string> = {
  read: "- You run read-only in this project folder. Inspect the code with your read and search tools; do not edit files or run commands that change anything.",
  edit: "- The user allowed you to edit and create files inside this project folder (no shell commands). Change files only when the request asks for it.",
  bypass:
    "- The user allowed you to edit files and run commands in this project folder without asking. Stay inside this folder and change only what the request asks for.",
};

export function buildPrompt(
  request: string,
  doc: PromptDoc | null,
  lang: "vi" | "en",
  map: PromptMap | null = null,
  ctx: PromptContext = {},
): string {
  const rules = ["Context from the xDev Hive desktop app:", ACCESS_RULE[ctx.access ?? "read"]];
  if (ctx.openFile) rules.push(`- The user has \`${ctx.openFile}\` open in the editor.`);
  if (map) {
    // Repo lớn làm Glob/Grep cả thư mục quá giờ (20 giây): đưa sẵn bản đồ và danh sách tài liệu để agent tìm đúng chỗ.
    rules.push(
      "- The folder can be large: do not Glob or Grep `**` from the root. Search inside the specific folders listed below, and if a search times out, narrow the path instead of repeating it.",
    );
    if (map.docs.length > 0) {
      rules.push(
        "- Documents found in the folder (when the user mentions a document without naming it, pick from these or ask which one):",
      );
      rules.push(...map.docs.map((d) => `  - ${d}`));
    } else {
      rules.push("- No document files (.md, .pdf, .docx, .txt…) were found in the top folders.");
    }
    if (map.tree.length > 0) {
      rules.push("- Top folders and files (two levels, generated folders such as node_modules, bin, obj skipped):");
      rules.push(...map.tree.slice(0, MAP_MAX).map((e) => `  ${"  ".repeat(e.depth)}${e.path}${e.dir ? "/" : ""}`));
      if (map.tree.length > MAP_MAX) rules.push(`  … ${map.tree.length - MAP_MAX} more`);
    }
  }
  if (doc) {
    const language = doc.draft.trim() ? "the language of the current draft" : lang === "vi" ? "Vietnamese" : "English";
    rules.push(
      `- Target document: ${doc.key} ("${doc.title}"). Its current draft is between <current-doc> tags (empty means a new document).`,
      "- When you propose document text, reply with the COMPLETE updated document in one fenced block opened with ````markdown and closed with ```` (four backticks) so code blocks inside stay intact. Keep any explanation outside that block short.",
      '- Base every statement on code you actually read and cite it as `path/to/file.ext:line`. If something is not in the code yet, keep the section but mark it "dự kiến" (planned) instead of guessing.',
      `- Write in ${language}.`,
      "",
      "<current-doc>",
      doc.draft,
      "</current-doc>",
    );
  }
  return `${request.trim()}\n\n---\n${rules.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Gom sự kiện

/** Thêm sự kiện của lượt chạy vào khung chat. Hàm thuần để test bằng chuỗi sự kiện mẫu. */
export function applyEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event.kind) {
    case "session":
      return { ...state, session: event.id, model: event.model ?? state.model };
    case "text":
      return { ...state, items: [...state.items, { kind: "text", text: event.text }] };
    case "tool": {
      const read = [...state.read, ...event.paths.filter((p) => !state.read.includes(p))];
      return {
        ...state,
        read,
        items: [...state.items, { kind: "tool", id: event.id, name: event.name, arg: event.arg, done: null }],
      };
    }
    case "toolDone": {
      const items = state.items.map((it) => (it.kind === "tool" && it.id === event.id ? { ...it, done: event } : it));
      // Đọc lỗi (ngoài thư mục, không có file) thì bỏ chấm xanh của file đó.
      if (!event.ok) {
        const tool = state.items.find((it) => it.kind === "tool" && it.id === event.id);
        if (tool?.kind === "tool") return { ...state, items, read: state.read.filter((p) => p !== tool.arg) };
      }
      return { ...state, items };
    }
    case "todos": {
      // Codex gửi lại cả danh sách mỗi lần cập nhật: thay khối kế hoạch cuối thay vì thêm khối mới.
      const last = state.items.at(-1);
      const items: ChatItem[] =
        last?.kind === "todos"
          ? [...state.items.slice(0, -1), { kind: "todos", items: event.items }]
          : [...state.items, { kind: "todos", items: event.items }];
      return { ...state, items };
    }
    case "limit":
      return { ...state, items: [...state.items, { kind: "limit", window: event.window, percent: event.percent }] };
    case "notice":
      return event.text ? { ...state, items: [...state.items, { kind: "notice", text: event.text }] } : state;
    case "result": {
      // Claude trả câu cuối trong result; Codex không, lấy đoạn chữ cuối của lượt chạy.
      const lastText = [...state.items].reverse().find((it) => it.kind === "text" || it.kind === "user");
      const text = event.text ?? (lastText?.kind === "text" ? lastText.text : null);
      const proposal = event.ok && text && state.docKey ? extractProposal(text) : null;
      return {
        ...state,
        items: [...state.items, { ...event, proposal, docKey: state.docKey }],
        suggestion: proposal && state.docKey ? { key: state.docKey, text: proposal } : state.suggestion,
      };
    }
    case "exit": {
      const hasResult = state.items.some((it, i) => it.kind === "result" && i >= lastUserIndex(state.items));
      const items: ChatItem[] =
        event.cancelled || (!hasResult && event.code !== 0)
          ? [...state.items, { kind: "stopped", cancelled: event.cancelled, stderr: event.stderr, code: event.code }]
          : state.items;
      return { ...state, items, runId: null };
    }
  }
}

function lastUserIndex(items: ChatItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]?.kind === "user") return i;
  return 0;
}

/** Mục trong cây thư mục có chấm xanh: chính file đã đọc, hoặc thư mục chứa file đã đọc. */
export const isRead = (path: string, read: readonly string[]) =>
  read.some((p) => p === path || p.startsWith(`${path}/`));

// ---------------------------------------------------------------------------------------------------------------
// Kho chat và lệnh Rust

interface Envelope {
  runId: string;
  event: AgentEvent;
}

let chat: ChatState = emptyChat();
const listeners = new Set<() => void>();
let listeningOn: unknown = null;
/** Sự kiện đến trước khi `run_cli_stream` trả id lượt chạy (CLI in rất nhanh): giữ lại rồi phát khi biết id. */
let starting = false;
let early: Envelope[] = [];

function setChat(next: ChatState) {
  chat = next;
  for (const l of listeners) l();
}

export const getChat = () => chat;

/** Nghe `cli:event` một lần cho mỗi cầu nối Tauri (test thay cầu nối giữa các ca). */
function ensureListening() {
  const tauri = window.__TAURI__;
  if (!tauri?.event || listeningOn === tauri) return;
  listeningOn = tauri;
  tauri.event
    .listen<Envelope>("cli:event", (e) => {
      if (starting && !chat.runId) {
        early.push(e.payload);
        return;
      }
      // Sự kiện của lượt đã huỷ hay của phiên cũ (người dùng đã chọn phiên khác) thì bỏ.
      if (e.payload.runId !== chat.runId) return;
      setChat(applyEvent(chat, e.payload.event));
    })
    .catch(() => {
      // Không nghe được thì lần mở màn sau thử lại.
      listeningOn = null;
    });
}

export function useChat(): ChatState {
  useEffect(ensureListening, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getChat,
    getChat,
  );
}

/** Đổi thư mục, agent hay phiên: khung chat mới (phiên cũ chỉ hỏi tiếp được, app không hiện lại lượt cũ). */
export function resetChat(folder: string, engine: Engine, session: string | null = null) {
  setChat({ ...emptyChat(folder, engine), session });
}

export function setSuggestion(suggestion: Suggestion | null) {
  setChat({ ...chat, suggestion });
}

/**
 * Quyền của agent trong thư mục (`Mode` trong cli.rs): chỉ đọc là mặc định; "edit" sửa file trong thư mục, "bypass" bỏ
 * hỏi quyền và sandbox (giao diện hỏi xác nhận trước).
 */
export type Access = "read" | "edit" | "bypass";

/** Tool sửa file của Claude Code và Codex: xong thì màn tải lại cây và file đang mở. */
export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);

/** Tên model gửi cho CLI (`--model`, `-m`); Rust kiểm lại cùng mẫu. */
export const MODEL_PATTERN = /^[a-zA-Z0-9._:-]{1,64}$/;
export const validModel = (m: string) => MODEL_PATTERN.test(m) && !m.startsWith("-");

export async function startRun(input: {
  request: string;
  prompt: string;
  docKey: string | null;
  model?: string | null;
  access?: Access;
}): Promise<void> {
  const { folder, engine, session } = chat;
  setChat({
    ...chat,
    docKey: input.docKey,
    error: null,
    items: [...chat.items, { kind: "user", text: input.request }],
  });
  starting = true;
  early = [];
  try {
    const runId = await invoke<string>("run_cli_stream", {
      engine,
      folder,
      prompt: input.prompt,
      session,
      model: input.model || null,
      mode: input.access ?? "read",
    });
    let next: ChatState = { ...chat, runId };
    for (const e of early) if (e.runId === runId) next = applyEvent(next, e.event);
    setChat(next);
  } catch (e) {
    setChat({ ...chat, error: typeof e === "string" ? e : e instanceof Error ? e.message : String(e) });
  } finally {
    starting = false;
    early = [];
  }
}

export const cancelRun = () =>
  chat.runId ? invoke<void>("cancel_cli_stream", { runId: chat.runId }) : Promise.resolve();

/** Test: về trạng thái ban đầu và nghe lại trên cầu nối mới. */
export function resetAgentStore() {
  chat = emptyChat();
  listeningOn = null;
  starting = false;
  early = [];
}

export interface CliAccount {
  engine: Engine;
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  method: string | null;
  email: string | null;
  plan: string | null;
}
export const cliAccounts = () => invoke<CliAccount[]>("cli_accounts");

export interface TreeEntry {
  path: string;
  dir: boolean;
  depth: number;
}
export const folderTree = (folder: string) => invoke<TreeEntry[]>("folder_tree", { folder });
export const folderDocs = (folder: string) => invoke<string[]>("folder_docs", { folder });
/** Một tầng của thư mục con trong cây (bấm mở thư mục). */
export const folderList = (folder: string, path: string) => invoke<TreeEntry[]>("folder_list", { folder, path });

/** File trong thư mục dự án (files.rs): Rust từ chối đường dẫn ra ngoài thư mục, file nhị phân, file quá 2 MB. */
export interface LocalFile {
  content: string;
  size: number;
  modifiedMs: number;
  /** File tài liệu (.md, .mdx, .markdown, .txt) lưu được từ màn. */
  writable: boolean;
}
export const readLocalFile = (folder: string, path: string) => invoke<LocalFile>("read_local_file", { folder, path });
export const writeLocalFile = (folder: string, path: string, content: string) =>
  invoke<number>("write_local_file", { folder, path, content });

export const proposeDoc = (input: { key: string; baseVersion: number; content: string; note: string }) =>
  invoke<OutboxSubmission>("propose_doc", input).then(checkProposal);

/** Tài khoản CLI worker chọn cho run trên máy này (`hive-worker accounts`, spec 008 US13). Không có token. */
export interface CliProfile {
  id: string;
  label: string;
  cli: string;
  configDir?: string;
  enabled: boolean;
  priority: number;
  maxConcurrent: number;
  cooldownMinutes: number;
  /** Worker chọn được tài khoản của CLI này (Claude Code, Codex). */
  supported: boolean;
  /** null khi app không biết cách kiểm đăng nhập của CLI này. */
  loggedIn: boolean | null;
  email?: string;
}
export interface CliProfiles {
  path: string;
  accounts: CliProfile[];
}
export const cliProfiles = () => invoke<CliProfiles>("cli_profiles");
export const setCliProfile = (id: string, enabled: boolean) => invoke<CliProfiles>("cli_profile_set", { id, enabled });
