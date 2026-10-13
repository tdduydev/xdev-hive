import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Textarea } from "@xdev-hive/ui/textarea";
import { ArrowUpDownIcon, FolderOpenIcon, LoaderCircleIcon, PlusIcon, UserRoundIcon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiAccountsDialog } from "@/components/ai-accounts-dialog.tsx";
import { Markdown, SuggestionView } from "@/components/doc-view.tsx";
import { FolderForm } from "@/components/folder-form.tsx";
import { Wordmark } from "@/components/logo.tsx";
import { profileOf, useLinkedAccount } from "@/lib/account.ts";
import {
  buildPrompt,
  type ChatItem,
  type CliAccount,
  cancelRun,
  cliAccounts,
  type Engine,
  findProposal,
  folderTree,
  isRead,
  proposeDoc,
  resetChat,
  setSuggestion,
  startRun,
  type ToolDone,
  type TreeEntry,
  useChat,
} from "@/lib/agent.ts";
import { diffHunks, diffStats, lineDiff } from "@/lib/diff.ts";
import { folderName, pickFolder, shortPath, useFolder } from "@/lib/folder.ts";
import { type HubDoc, type HubProject, hubTool, matchProject } from "@/lib/hub.ts";
import { type Dict, type Lang, useLang, useT } from "@/lib/i18n.ts";
import { can } from "@/lib/nav.ts";
import { errorText, type WorkspaceMeta, workspaceMeta } from "@/lib/tauri.ts";
import { formatTokens } from "@/lib/usage.ts";
import { cn } from "@/lib/utils.ts";

type Quick = { cmd: string; label: string; prompt: string };

const text: Dict<{
  pickTitle: string;
  pickLead: string;
  openFolder: string;
  pickFailed: string;
  open: string;
  recent: string;
  linkedTo: (p: string) => string;
  notLinked: string;
  explorer: string;
  changeFolder: string;
  docs: string;
  code: string;
  readByAi: string;
  readLegend: string;
  newDoc: string;
  newDocName: string;
  noAccountDocs: string;
  noDocs: string;
  loading: string;
  aiBadge: string;
  draftBadge: string;
  newBadge: string;
  pickDoc: string;
  pending: string;
  unsent: string;
  synced: (v: number) => string;
  newOnHub: string;
  savedIn: string;
  push: string;
  pushNeedsRole: string;
  view: string;
  edit: string;
  changes: string;
  noChanges: string;
  stale: (draft: number, hub: number) => string;
  dropDraft: string;
  rejectAll: string;
  acceptAll: string;
  aiAdded: string;
  aiRemoved: string;
  editorLabel: string;
  chat: string;
  engine: string;
  manageAcc: string;
  session: string;
  newSession: string;
  sessionAt: (title: string, at: string) => string;
  modeLabel: string;
  readOnly: string;
  locked: string;
  resumed: string;
  emptyChat: string;
  placeholder: Record<Engine, string>;
  hint: string;
  ask: string;
  send: string;
  stop: string;
  running: string;
  quick: string;
  quicks: Quick[];
  updateQuick: Quick;
  readLines: (n: number) => string;
  foundFiles: (n: number) => string;
  matchFiles: (n: number) => string;
  lines: (n: number) => string;
  noOutput: string;
  failed: (why: string) => string;
  limit: (pct: number, window: string) => string;
  windows: Record<string, string>;
  done: (parts: string) => string;
  tokensIn: (n: string) => string;
  tokensOut: (n: string) => string;
  seconds: (n: string) => string;
  proposalFor: (key: string, added: number, removed: number) => string;
  reopen: string;
  stopped: string;
  exited: (code: string, why: string) => string;
  lastRun: (input: string, output: string) => string;
  proposeTitle: string;
  proposeLead: (key: string, v: number) => string;
  note: string;
  notePlaceholder: string;
  cancel: string;
  sendProposal: string;
  sent: (id: string) => string;
  needAccount: string;
}> = {
  vi: {
    pickTitle: "Chọn thư mục để viết tài liệu",
    pickLead:
      "Thư mục dự án trên máy, có thể mới có một phần code. AI đọc code ở đó để viết và cập nhật tài liệu của dự án trên hub.",
    openFolder: "Mở thư mục…",
    pickFailed: "Không mở được bộ chọn thư mục. Nhập đường dẫn thư mục dự án:",
    open: "Mở",
    recent: "Gần đây",
    linkedTo: (p) => `↔ ${p}`,
    notLinked: "Chưa nối dự án",
    explorer: "Thư mục",
    changeFolder: "Đổi thư mục",
    docs: "Tài liệu",
    code: "Code",
    readByAi: "AI đã đọc",
    readLegend: "Chấm xanh: file AI đã đọc trong phiên này",
    newDoc: "Tài liệu mới",
    newDocName: "ten-tai-lieu",
    noAccountDocs: "Liên kết tài khoản để mở tài liệu của dự án trên hub.",
    noDocs: "Chưa có tài liệu. Tạo tài liệu mới rồi nhờ AI viết từ code.",
    loading: "Đang đọc…",
    aiBadge: "AI",
    draftBadge: "nháp",
    newBadge: "mới",
    pickDoc: "Chọn một tài liệu ở cột trái, hoặc tạo tài liệu mới.",
    pending: "Có đề xuất chưa nhận",
    unsent: "Bản nháp chưa gửi",
    synced: (v) => `Khớp bản v${v} trên hub`,
    newOnHub: "Tài liệu mới, chưa có trên hub",
    savedIn: "Bản nháp lưu trên máy · chưa đẩy lên hub",
    push: "Đẩy lên hub và gửi duyệt",
    pushNeedsRole: "Người xem đội chỉ đọc tài liệu: hub không nhận đề xuất từ vai trò này.",
    view: "Xem",
    edit: "Sửa",
    changes: "So với hub",
    noChanges: "Bản nháp giống bản trên hub.",
    stale: (draft, hub) => `Bản nháp viết trên v${draft}, hub đã có v${hub}. Gửi đề xuất sẽ bị từ chối vì lệch bản.`,
    dropDraft: "Bỏ bản nháp, lấy bản hub",
    rejectAll: "Bỏ tất cả",
    acceptAll: "Nhận tất cả",
    aiAdded: "AI thêm",
    aiRemoved: "AI bỏ",
    editorLabel: "Nội dung tài liệu",
    chat: "Hỏi về thư mục này",
    engine: "Agent CLI",
    manageAcc: "Quản lý tài khoản AI…",
    session: "Phiên",
    newSession: "+ Phiên mới",
    sessionAt: (title, at) => `Phiên: ${title} · ${at}`,
    modeLabel: "Chế độ",
    readOnly: "Chỉ đọc",
    locked: "Khoá: app chỉ cho agent đọc code khi viết tài liệu",
    resumed: "Hỏi tiếp phiên đã có; app không hiện lại các lượt cũ.",
    emptyChat:
      "Hỏi về code trong thư mục, hoặc bấm / để chọn mẫu yêu cầu. Agent chỉ đọc code; bản đề xuất hiện trong trình soạn để bạn nhận hay bỏ.",
    placeholder: { claude: "Hỏi Claude về thư mục này…", codex: "Hỏi Codex về thư mục này…" },
    hint: "/ mẫu yêu cầu · Enter gửi",
    ask: "Hỏi hoặc yêu cầu viết tài liệu từ code",
    send: "Gửi",
    stop: "Dừng",
    running: "Đang chạy…",
    quick: "Mẫu yêu cầu",
    quicks: [
      {
        cmd: "/architecture",
        label: "Tài liệu kiến trúc",
        prompt: 'Viết tài liệu kiến trúc từ code hiện có. Phần nào chưa code thì đánh dấu "dự kiến".',
      },
      {
        cmd: "/readme",
        label: "README từ code",
        prompt: "Viết README từ code hiện có: dự án làm gì, cách cài, cách chạy, cấu trúc thư mục.",
      },
      {
        cmd: "/api",
        label: "Tài liệu API",
        prompt: "Viết tài liệu API từ code: endpoint hoặc hàm public, tham số, kết quả, lỗi.",
      },
      {
        cmd: "/stale",
        label: "Tìm chỗ tài liệu lệch code",
        prompt: "Tìm chỗ tài liệu đang mở nói khác code, ghi từng chỗ kèm file:dòng, rồi đề xuất bản đã sửa.",
      },
    ],
    updateQuick: {
      cmd: "/update",
      label: "Cập nhật tài liệu đang mở theo code",
      prompt: "Đọc code và cập nhật tài liệu đang mở cho khớp code: giữ phần còn đúng, sửa phần lệch, thêm phần thiếu.",
    },
    readLines: (n) => `Đọc ${n} dòng`,
    foundFiles: (n) => `Thấy ${n} file`,
    matchFiles: (n) => `Có trong ${n} file`,
    lines: (n) => `${n} dòng`,
    noOutput: "không có kết quả",
    failed: (why) => `Lỗi: ${why}`,
    limit: (pct, window) => `Đã dùng ${pct}% hạn mức ${window} của gói`,
    windows: { five_hour: "5 giờ", seven_day: "7 ngày" },
    done: (parts) => `Xong · ${parts}`,
    tokensIn: (n) => `${n} token vào`,
    tokensOut: (n) => `${n} ra`,
    seconds: (n) => `${n} giây`,
    proposalFor: (key, added, removed) => `Đề xuất cho ${key} hiện trong trình soạn: +${added} −${removed} dòng`,
    reopen: "Mở lại đề xuất",
    stopped: "Đã dừng.",
    exited: (code, why) => `Agent thoát với mã ${code}${why ? `: ${why}` : ""}`,
    lastRun: (input, output) => `${input} vào · ${output} ra`,
    proposeTitle: "Gửi đề xuất sửa tài liệu",
    proposeLead: (key, v) =>
      v ? `Đề xuất bản nháp của ${key} (sửa từ v${v}) để người duyệt quyết.` : `Đề xuất tạo tài liệu ${key}.`,
    note: "Vì sao cần sửa",
    notePlaceholder: "Ví dụ: cập nhật theo code nhánh feat/proxy, thêm mục kênh tới hub.",
    cancel: "Huỷ",
    sendProposal: "Gửi đề xuất",
    sent: (id) => `Đã gửi đề xuất ${id.slice(0, 8)}; tài liệu đổi khi được duyệt.`,
    needAccount: "Liên kết tài khoản để gửi đề xuất.",
  },
  en: {
    pickTitle: "Pick a folder to write docs in",
    pickLead:
      "A project folder on this machine, even if the code is only partly written. The AI reads the code there to write and update the project's docs on the hub.",
    openFolder: "Open folder…",
    pickFailed: "Could not open the folder picker. Enter the project folder path:",
    open: "Open",
    recent: "Recent",
    linkedTo: (p) => `↔ ${p}`,
    notLinked: "Not linked",
    explorer: "Explorer",
    changeFolder: "Change folder",
    docs: "Docs",
    code: "Code",
    readByAi: "Read by AI",
    readLegend: "Blue dot: files the AI read this session",
    newDoc: "New doc",
    newDocName: "doc-name",
    noAccountDocs: "Link your account to open the project's docs on the hub.",
    noDocs: "No docs yet. Create one and let the AI write it from the code.",
    loading: "Reading…",
    aiBadge: "AI",
    draftBadge: "draft",
    newBadge: "new",
    pickDoc: "Pick a doc on the left, or create a new one.",
    pending: "Pending suggestions",
    unsent: "Unsent draft",
    synced: (v) => `Matches v${v} on the hub`,
    newOnHub: "New doc, not on the hub yet",
    savedIn: "Draft kept on this machine · not on the hub",
    push: "Push and submit for review",
    pushNeedsRole: "Team viewers can only read docs: the hub does not take proposals from this role.",
    view: "View",
    edit: "Edit",
    changes: "Vs. hub",
    noChanges: "The draft matches the hub version.",
    stale: (draft, hub) => `The draft is based on v${draft}, the hub has v${hub}. A proposal would be rejected.`,
    dropDraft: "Drop draft, use the hub version",
    rejectAll: "Reject all",
    acceptAll: "Accept all",
    aiAdded: "Added by AI",
    aiRemoved: "Removed by AI",
    editorLabel: "Document content",
    chat: "Ask about this folder",
    engine: "Agent CLI",
    manageAcc: "Manage AI accounts…",
    session: "Session",
    newSession: "+ New session",
    sessionAt: (title, at) => `Session: ${title} · ${at}`,
    modeLabel: "Mode",
    readOnly: "Read-only",
    locked: "Locked: the app only lets the agent read code when writing docs",
    resumed: "Continuing an earlier session; the app does not show its old turns.",
    emptyChat:
      "Ask about the code in this folder, or press / for a request template. The agent only reads code; its proposal shows up in the editor for you to accept or reject.",
    placeholder: { claude: "Ask Claude about this folder…", codex: "Ask Codex about this folder…" },
    hint: "/ templates · Enter to send",
    ask: "Ask, or request docs from the code",
    send: "Send",
    stop: "Stop",
    running: "Running…",
    quick: "Request templates",
    quicks: [
      {
        cmd: "/architecture",
        label: "Architecture doc",
        prompt: 'Write the architecture doc from the current code. Mark anything not coded yet as "planned".',
      },
      {
        cmd: "/readme",
        label: "README from code",
        prompt: "Write a README from the current code: what the project does, how to install, run, and the layout.",
      },
      {
        cmd: "/api",
        label: "API reference",
        prompt: "Write the API reference from the code: endpoints or public functions, parameters, results, errors.",
      },
      {
        cmd: "/stale",
        label: "Find stale docs",
        prompt:
          "Find where the open doc disagrees with the code, list each with file:line, then propose the fixed doc.",
      },
    ],
    updateQuick: {
      cmd: "/update",
      label: "Update the open doc from the code",
      prompt:
        "Read the code and update the open doc to match it: keep what is right, fix what drifted, add what is missing.",
    },
    readLines: (n) => `Read ${n} lines`,
    foundFiles: (n) => `Found ${n} files`,
    matchFiles: (n) => `Matches in ${n} files`,
    lines: (n) => `${n} lines`,
    noOutput: "no output",
    failed: (why) => `Error: ${why}`,
    limit: (pct, window) => `${pct}% of the plan's ${window} limit used`,
    windows: { five_hour: "5-hour", seven_day: "7-day" },
    done: (parts) => `Done · ${parts}`,
    tokensIn: (n) => `${n} tokens in`,
    tokensOut: (n) => `${n} out`,
    seconds: (n) => `${n} s`,
    proposalFor: (key, added, removed) => `Proposal for ${key} is in the editor: +${added} −${removed} lines`,
    reopen: "Reopen proposal",
    stopped: "Stopped.",
    exited: (code, why) => `The agent exited with code ${code}${why ? `: ${why}` : ""}`,
    lastRun: (input, output) => `${input} in · ${output} out`,
    proposeTitle: "Propose doc changes",
    proposeLead: (key, v) =>
      v ? `Propose the draft of ${key} (based on v${v}) for review.` : `Propose creating the doc ${key}.`,
    note: "Why this change",
    notePlaceholder: "E.g. updated from the feat/proxy branch, added the hub channel section.",
    cancel: "Cancel",
    sendProposal: "Send proposal",
    sent: (id) => `Proposal ${id.slice(0, 8)} sent; the doc changes once it is approved.`,
    needAccount: "Link your account to send proposals.",
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Lưu trên máy: bản nháp, phiên, thư mục gần đây, agent mặc định

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Không lưu được thì vẫn dùng trong lần mở này. */
  }
}

/** Bản nháp theo key tài liệu: nội dung và bản hub nó dựa trên (baseVersion của đề xuất; 0 là tài liệu mới). */
interface Draft {
  base: number;
  text: string;
  title?: string;
}
const DRAFTS = "hive.docs.drafts";
const SESSIONS = "hive.docs.sessions";
const RECENT = "hive.docs.recent";
const ENGINE = "hive.docs.engine";

interface StoredSession {
  id: string;
  engine: Engine;
  folder: string;
  title: string;
  at: string;
}
interface Recent {
  path: string;
  branch: string | null;
  project: string | null;
}

export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
}

/** Đọc hết tài liệu: doc_get trả từng trang tối đa 40k ký tự. */
async function readDoc(key: string): Promise<{ key: string; title: string; version: number; content: string }> {
  let content = "";
  let offset = 0;
  for (;;) {
    const page = await hubTool<{
      key: string;
      title: string;
      version: number;
      content: string;
      nextOffset: number | null;
    }>("doc_get", { key, offset, maxChars: 40_000 });
    content += page.content;
    if (page.nextOffset === null || page.nextOffset === undefined) return { ...page, content };
    offset = page.nextOffset;
  }
}

const timeOf = (iso: string, lang: Lang) =>
  new Date(iso).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });

// ---------------------------------------------------------------------------------------------------------------
// Khung chat

function toolSummary(name: string, done: ToolDone, t: (typeof text)["vi"]): string {
  if (!done.ok) return t.failed(done.preview);
  if (name === "Read" && done.lines !== null) return t.readLines(done.lines);
  if (name === "Glob" && done.files !== null) return t.foundFiles(done.files);
  if (name === "Grep") {
    if (done.lines !== null) return t.lines(done.lines);
    if (done.files !== null) return t.matchFiles(done.files);
  }
  if (name === "shell" && done.lines !== null) return done.lines ? t.lines(done.lines) : t.noOutput;
  return done.preview;
}

function ChatLine({
  item,
  engine,
  stripProposal,
  docSuggestion,
  baseText,
  onReopen,
}: {
  item: ChatItem;
  engine: Engine;
  /** Câu trả lời có khối tài liệu đề xuất: khối đã hiện trong trình soạn, khung chat chỉ giữ phần giải thích. */
  stripProposal: boolean;
  docSuggestion: string | null;
  baseText: (key: string) => string;
  onReopen: (key: string, proposal: string) => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const claude = engine === "claude";
  const bullet = claude ? "●" : "•";
  const branch = claude ? "⎿" : "└";
  switch (item.kind) {
    case "user":
      return (
        <div className="max-w-[85%] self-end rounded-[12px_12px_4px_12px] bg-primary px-3 py-2 font-sans text-sm whitespace-pre-wrap text-primary-foreground">
          {item.text}
        </div>
      );
    case "text": {
      const found = stripProposal ? findProposal(item.text) : null;
      const parts = found ? [found.before, found.after].filter(Boolean) : [item.text];
      return (
        <div className="flex flex-col gap-1 font-sans text-sm whitespace-pre-wrap">
          {parts.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </div>
      );
    }
    case "tool": {
      const running = item.done === null;
      return (
        <div className="flex flex-col">
          <span>
            <span
              aria-hidden="true"
              className={cn(
                running
                  ? "animate-pulse text-muted-foreground"
                  : item.done?.ok
                    ? claude
                      ? "text-success"
                      : "text-primary"
                    : "text-destructive",
              )}
            >
              {bullet}
            </span>{" "}
            {claude ? (
              <>
                <strong className="font-semibold">{item.name}</strong>({item.arg})
              </>
            ) : (
              <>
                {item.name === "shell" ? "Ran" : item.name} <span className="text-foreground">{item.arg}</span>
              </>
            )}
          </span>
          <span className={cn("text-muted-foreground", item.done && !item.done.ok && "text-destructive")}>
            {"  "}
            {branch} {item.done ? toolSummary(item.name, item.done, t) : "…"}
          </span>
        </div>
      );
    }
    case "todos":
      return (
        <div className="flex flex-col gap-0.5">
          <span>
            <span aria-hidden="true" className={claude ? "text-success" : "text-primary"}>
              {bullet}
            </span>{" "}
            {claude ? "Update Todos" : "Updated Plan"}
          </span>
          {item.items.map((td) => (
            <span
              key={td.text}
              className={cn(
                td.status === "done" && "text-muted-foreground line-through",
                td.status === "doing" && "font-semibold",
              )}
            >
              {"  "}
              {branch} {claude ? (td.status === "done" ? "☒" : "☐") : td.status === "done" ? "✔" : "□"} {td.text}
            </span>
          ))}
        </div>
      );
    case "limit":
      return <span className="text-warning">! {t.limit(item.percent, t.windows[item.window] ?? item.window)}</span>;
    case "notice":
      return <span className="text-muted-foreground">! {item.text}</span>;
    case "result": {
      if (!item.ok) return <span className="font-sans text-sm text-destructive">✗ {item.error}</span>;
      const fmt = (n: number) => formatTokens(n, lang);
      const parts = [t.tokensIn(fmt(item.inputTokens)), t.tokensOut(fmt(item.outputTokens))];
      if (item.costUsd !== null) parts.push(`$${item.costUsd.toFixed(4)}`);
      if (item.durationMs !== null)
        parts.push(t.seconds((item.durationMs / 1000).toLocaleString(lang, { maximumFractionDigits: 1 })));
      return (
        <div className="flex flex-col gap-1.5">
          <span className="font-sans text-sm text-success">✓ {t.done(parts.join(" · "))}</span>
          {item.proposal && item.docKey && (
            <ProposalCard
              docKey={item.docKey}
              proposal={item.proposal}
              base={baseText(item.docKey)}
              open={docSuggestion === item.proposal}
              onReopen={() => onReopen(item.docKey ?? "", item.proposal ?? "")}
            />
          )}
        </div>
      );
    }
    case "stopped":
      return item.cancelled ? (
        <span className="text-muted-foreground">■ {t.stopped}</span>
      ) : (
        <span className="font-sans text-sm text-destructive">
          ✗ {t.exited(String(item.code ?? "?"), item.stderr.split("\n").at(-1) ?? "")}
        </span>
      );
  }
}

function ProposalCard({
  docKey,
  proposal,
  base,
  open,
  onReopen,
}: {
  docKey: string;
  proposal: string;
  base: string;
  open: boolean;
  onReopen: () => void;
}) {
  const t = useT(text);
  const { added, removed } = diffStats(lineDiff(base, proposal));
  return (
    <div className="flex flex-col gap-1 rounded-r-md border-l-2 border-success bg-success-soft px-2.5 py-2">
      <span className="font-sans text-sm">{t.proposalFor(docKey, added, removed)}</span>
      {!open && (
        <Button size="xs" variant="outline" className="self-start" onClick={onReopen}>
          {t.reopen}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Màn

type Mode = "view" | "edit" | "diff";

interface HubDocFull {
  key: string;
  title: string;
  version: number;
  content: string;
}

/**
 * Màn Tài liệu (AppDocs.dc.html, specs/008-desktop-v2 T011): chọn thư mục dự án; cột trái là tài liệu của dự án trên
 * hub và cây code (chấm xanh: file agent đã đọc); giữa là bản nháp tài liệu với đề xuất của agent tô xanh; phải là
 * khung chat chạy Claude Code hoặc Codex chỉ đọc trên máy. Bản nháp lên hub bằng đề xuất (`propose_doc`), người duyệt
 * quyết.
 */
export function DocsScreen() {
  const t = useT(text);
  const lang = useLang();
  const account = useLinkedAccount();
  const profile = profileOf(account ?? null);
  const canPropose = can(profile, "docs.propose");
  const [folder, setFolder] = useFolder();
  const [picking, setPicking] = useState(!folder);
  const [pickFailed, setPickFailed] = useState(false);
  const [typed, setTyped] = useState(folder);
  const chat = useChat();
  const [defaultEngine, setDefaultEngine] = useState<Engine>(() => readJson<Engine>(ENGINE, "claude"));
  const [recent, setRecent] = useState<Recent[]>(() => readJson<Recent[]>(RECENT, []));
  const [sessions, setSessions] = useState<StoredSession[]>(() => readJson<StoredSession[]>(SESSIONS, []));
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => readJson(DRAFTS, {}));

  const [meta, setMeta] = useState<WorkspaceMeta | null>(null);
  const [tree, setTree] = useState<TreeEntry[] | null>(null);
  const [project, setProject] = useState<HubProject | null | undefined>(undefined);
  const [docs, setDocs] = useState<HubDoc[] | null>(null);
  const [hubError, setHubError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hubDoc, setHubDoc] = useState<HubDocFull | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [accounts, setAccounts] = useState<CliAccount[] | null>(null);
  const [accOpen, setAccOpen] = useState(false);
  const [input, setInput] = useState("");
  const [slash, setSlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [proposing, setProposing] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);

  const engine = chat.engine;
  const running = busy || chat.runId !== null;
  const prefix = project ? `project/${project.key}/` : "";

  // Khung chat theo thư mục: đổi thư mục là phiên mới.
  useEffect(() => {
    if (folder && chat.folder !== folder) resetChat(folder, defaultEngine);
  }, [folder, chat.folder, defaultEngine]);

  useEffect(() => {
    let alive = true;
    setMeta(null);
    setTree(null);
    setProject(undefined);
    setDocs(null);
    setHubError(null);
    setSelected(null);
    if (!folder || picking) return;
    workspaceMeta(folder).then(
      (m) => alive && setMeta(m),
      () => {},
    );
    folderTree(folder).then(
      (tr) => alive && setTree(tr),
      () => alive && setTree([]),
    );
    return () => {
      alive = false;
    };
  }, [folder, picking]);

  useEffect(() => {
    cliAccounts().then(setAccounts, () => {});
  }, []);

  useEffect(() => {
    if (!meta || !account) return;
    let alive = true;
    (async () => {
      try {
        const { projects } = await hubTool<{ projects: HubProject[] }>("project_list");
        const found = matchProject(meta.remote, projects);
        if (!alive) return;
        setProject(found);
        // Thư mục chưa nối dự án: vẫn cho xem và viết tài liệu người dùng đọc được (tổ chức, đội).
        const list = await hubTool<{ docs: HubDoc[] }>("doc_list", {
          ...(found ? { prefix: `project/${found.key}/` } : {}),
          limit: 50,
        });
        if (alive) setDocs(list.docs);
      } catch (e) {
        if (alive) setHubError(errorText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [meta, account]);

  // Nhớ thư mục gần đây kèm nhánh và dự án để màn chọn thư mục có gì đó để nói.
  useEffect(() => {
    if (!meta || project === undefined) return;
    setRecent((prev) => {
      const next = [
        { path: meta.folder, branch: meta.branch, project: project?.name ?? null },
        ...prev.filter((r) => r.path !== meta.folder),
      ].slice(0, 5);
      writeJson(RECENT, next);
      return next;
    });
  }, [meta, project]);

  const localNew = useMemo(
    () =>
      Object.entries(drafts)
        .filter(([key, d]) => d.base === 0 && (prefix ? key.startsWith(prefix) : true))
        .filter(([key]) => !docs?.some((x) => x.key === key))
        .map(([key, d]) => ({ key, title: d.title ?? key, version: 0, updatedAt: "" })),
    [drafts, prefix, docs],
  );
  const allDocs = useMemo(() => [...(docs ?? []), ...localNew], [docs, localNew]);

  useEffect(() => {
    if (!selected && allDocs.length) setSelected(allDocs[0]?.key ?? null);
  }, [selected, allDocs]);

  // Bản nháp đổi (gõ, nhận đề xuất) không cần đọc lại hub: chỉ đọc khi đổi tài liệu hay danh sách.
  // biome-ignore lint/correctness/useExhaustiveDependencies: drafts chỉ dùng để nhận ra tài liệu mới chưa có trên hub
  useEffect(() => {
    let alive = true;
    setHubDoc(null);
    setDocError(null);
    setMode("view");
    if (!selected) return;
    const local = drafts[selected];
    if (local?.base === 0 && !docs?.some((d) => d.key === selected)) {
      setHubDoc({ key: selected, title: local.title ?? selected, version: 0, content: "" });
      return;
    }
    readDoc(selected).then(
      (d) => alive && setHubDoc(d),
      (e) => alive && setDocError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [selected, docs]);

  // Phiên mới của CLI: nhớ để hỏi tiếp sau, tên theo câu hỏi đầu.
  useEffect(() => {
    const id = chat.session;
    if (!id || sessions.some((s) => s.id === id)) return;
    const first = chat.items.find((it) => it.kind === "user");
    const title = first?.kind === "user" ? first.text.split("\n")[0]?.slice(0, 40) || id : id;
    const next = [
      { id, engine: chat.engine, folder: chat.folder, title, at: new Date().toISOString() },
      ...sessions,
    ].slice(0, 30);
    writeJson(SESSIONS, next);
    setSessions(next);
  }, [chat.session, chat.items, chat.engine, chat.folder, sessions]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: cuộn xuống khi có dòng mới
  useEffect(() => {
    transcript.current?.scrollTo?.({ top: transcript.current.scrollHeight });
  }, [chat.items.length]);

  const draft = selected ? drafts[selected] : undefined;
  const base = hubDoc ? (draft?.base ?? hubDoc.version) : 0;
  const draftText = hubDoc ? (draft?.text ?? hubDoc.content) : "";
  const stale = !!(hubDoc && draft && draft.base !== hubDoc.version && hubDoc.version !== 0);
  const changed = !!hubDoc && draftText !== hubDoc.content;
  const suggestion = chat.suggestion && chat.suggestion.key === selected ? chat.suggestion.text : null;

  const saveDraft = useCallback(
    (key: string, value: Draft | null) => {
      const next = { ...drafts };
      if (value) next[key] = value;
      else delete next[key];
      writeJson(DRAFTS, next);
      setDrafts(next);
    },
    [drafts],
  );

  const baseText = (key: string) => (key === selected ? draftText : (drafts[key]?.text ?? ""));

  async function chooseFolder() {
    try {
      const picked = await pickFolder(t.pickTitle);
      if (picked) {
        setFolder(picked);
        setPicking(false);
      }
    } catch {
      setPickFailed(true);
    }
  }

  function pickEngine(next: Engine) {
    if (running || next === engine) return;
    resetChat(folder, next);
  }

  function pickSession(value: string) {
    if (running) return;
    resetChat(folder, engine, value === "new" ? null : value);
  }

  async function send(request: string) {
    const req = request.trim();
    if (!req || running) return;
    setInput("");
    setSlash(false);
    setBusy(true);
    try {
      const doc = hubDoc ? { key: hubDoc.key, title: hubDoc.title, draft: draftText } : null;
      await startRun({ request: req, prompt: buildPrompt(req, doc, lang), docKey: doc?.key ?? null });
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  }

  function accept() {
    if (!hubDoc || !suggestion) return;
    saveDraft(hubDoc.key, { base, text: suggestion, title: hubDoc.title });
    setSuggestion(null);
  }

  function createDoc(e: FormEvent) {
    e.preventDefault();
    const slug = slugify(naming ?? "");
    if (!slug) return;
    const key = `${prefix || "org/"}${slug}`;
    if (!drafts[key] && !docs?.some((d) => d.key === key)) saveDraft(key, { base: 0, text: "", title: slug });
    setNaming(null);
    setSelected(key);
  }

  const engineInfo = accounts?.find((a) => a.engine === engine);
  const lastResult = [...chat.items].reverse().find((it) => it.kind === "result");
  const quicks = hubDoc ? [t.updateQuick, ...t.quicks] : t.quicks;
  const engineSessions = sessions.filter((s) => s.folder === folder && s.engine === engine).slice(0, 10);
  const statusLeft =
    engine === "claude"
      ? [
          chat.model ?? "Claude Code",
          engineInfo?.plan ? `Claude ${engineInfo.plan}` : engineInfo?.method,
          engineInfo?.version,
        ]
      : [`codex-cli ${engineInfo?.version ?? ""}`.trim(), engineInfo?.method, "Read only"];

  if (!folder || picking) {
    return (
      <div className="flex flex-1 items-center justify-center overflow-auto p-6">
        <div className="flex w-[560px] max-w-full flex-col gap-4.5">
          <Wordmark className="h-12 self-start" />
          <div className="flex flex-col gap-1">
            <h2 className="font-heading text-2xl font-semibold tracking-[-0.03em]">{t.pickTitle}</h2>
            <p className="text-muted-foreground">{t.pickLead}</p>
          </div>
          <Button size="lg" className="h-10 self-start px-3 text-sm" onClick={() => void chooseFolder()}>
            <FolderOpenIcon aria-hidden="true" />
            {t.openFolder}
          </Button>
          {pickFailed && (
            <FolderForm
              value={typed}
              onChange={setTyped}
              onSubmit={(f) => {
                if (!f.trim()) return;
                setFolder(f.trim());
                setPicking(false);
              }}
              submitLabel={t.open}
              hint={t.pickFailed}
              busy={false}
            />
          )}
          {recent.length > 0 && (
            <div className="overflow-hidden rounded-xl border bg-card">
              <div className="border-b px-3 py-2 text-xs text-muted-foreground">{t.recent}</div>
              {recent.map((r) => (
                <button
                  key={r.path}
                  type="button"
                  onClick={() => {
                    setFolder(r.path);
                    setPicking(false);
                  }}
                  className="flex w-full cursor-pointer items-center gap-2.5 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/50"
                >
                  <span className="flex min-w-0 flex-1 flex-col leading-snug">
                    <span className="truncate font-mono text-sm font-medium">{shortPath(r.path)}</span>
                    {r.branch && <span className="text-xs text-muted-foreground">⎇ {r.branch}</span>}
                  </span>
                  <span
                    className={cn(
                      "inline-flex h-5 items-center rounded-full px-1.75 text-xs font-medium whitespace-nowrap",
                      r.project ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {r.project ? t.linkedTo(r.project) : t.notLinked}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const docName = (key: string) => (prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key);
  const docItems = account ? allDocs : [];

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside
        aria-label={t.explorer}
        className="flex w-[230px] shrink-0 flex-col border-r bg-sidebar max-[1180px]:w-[200px] max-[900px]:hidden"
      >
        <div className="flex flex-col gap-1.5 border-b px-3 py-2.5">
          <button
            type="button"
            title={t.changeFolder}
            onClick={() => setPicking(true)}
            className="flex cursor-pointer items-center gap-2 rounded-lg border bg-card px-2 py-1.5 text-left hover:bg-muted"
          >
            <FolderOpenIcon aria-hidden="true" className="size-3.75 shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-sm font-semibold">{folderName(folder)}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">{shortPath(folder)}</span>
            </span>
            <ArrowUpDownIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          </button>
          <div className="flex flex-wrap gap-1">
            {meta?.branch && (
              <span className="inline-flex h-5 items-center rounded-full bg-secondary px-1.75 font-mono text-xs text-secondary-foreground">
                ⎇ {meta.branch}
              </span>
            )}
            {project !== undefined && (
              <span
                className={cn(
                  "inline-flex h-5 items-center rounded-full px-1.75 text-xs font-medium",
                  project ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground",
                )}
              >
                {project ? t.linkedTo(project.name) : t.notLinked}
              </span>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-1.5 py-2">
          <div className="flex items-center justify-between px-1.5 py-1">
            <span className="text-xs font-medium text-muted-foreground">{t.docs}</span>
            {account && (
              <button
                type="button"
                title={t.newDoc}
                aria-label={t.newDoc}
                onClick={() => setNaming("")}
                className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <PlusIcon aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </div>
          {naming !== null && (
            <form onSubmit={createDoc} className="px-1.5 pb-1">
              <Input
                autoFocus
                aria-label={t.newDoc}
                placeholder={t.newDocName}
                value={naming}
                onChange={(e) => setNaming(e.target.value)}
                onBlur={() => !naming && setNaming(null)}
                className="h-7 font-mono text-xs md:text-xs"
              />
            </form>
          )}
          {!account ? (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">{t.noAccountDocs}</p>
          ) : hubError ? (
            <p className="px-1.5 py-1 text-xs text-destructive">{hubError}</p>
          ) : docs === null ? (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">{t.loading}</p>
          ) : docItems.length === 0 ? (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">{t.noDocs}</p>
          ) : (
            <ul>
              {docItems.map((d) => {
                const hasSuggestion = chat.suggestion?.key === d.key;
                const isDraft = !!drafts[d.key] && (d.version !== 0 || !!drafts[d.key]?.text);
                return (
                  <li key={d.key}>
                    <button
                      type="button"
                      title={d.key}
                      aria-current={selected === d.key ? "true" : undefined}
                      onClick={() => setSelected(d.key)}
                      className={cn(
                        "flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 text-left font-mono text-xs whitespace-nowrap hover:bg-muted",
                        selected === d.key && "bg-accent font-semibold text-accent-foreground hover:bg-accent",
                      )}
                    >
                      <span aria-hidden="true" className="w-3" />▤
                      <span className="min-w-0 flex-1 truncate">{docName(d.key)}</span>
                      {(hasSuggestion || isDraft || d.version === 0) && (
                        <span
                          className={cn(
                            "inline-flex h-4 items-center rounded-full px-1.5 font-sans text-xs font-medium",
                            hasSuggestion ? "bg-success-soft text-success" : "bg-warning-soft text-warning",
                          )}
                        >
                          {hasSuggestion ? t.aiBadge : d.version === 0 ? t.newBadge : t.draftBadge}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="px-1.5 pt-2.5 pb-1 font-mono text-xs tracking-[.06em] text-muted-foreground uppercase">
            {t.code}
          </div>
          {tree === null ? (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">{t.loading}</p>
          ) : (
            <ul>
              {tree.map((e) => {
                const name = e.path.split("/").at(-1) ?? e.path;
                const read = isRead(e.path, chat.read);
                return (
                  <li
                    key={e.path}
                    title={e.path}
                    className="flex h-6 items-center gap-1.5 rounded-[5px] pr-1.5 font-mono text-xs whitespace-nowrap hover:bg-muted"
                    style={{ paddingLeft: `${6 + e.depth * 14}px` }}
                  >
                    <span className="min-w-0 truncate">{e.dir ? `${e.depth === 0 ? "▾" : "▸"} ${name}/` : name}</span>
                    {read && (
                      <span title={t.readByAi} className="ml-auto size-1.5 shrink-0 rounded-full bg-primary">
                        <span className="sr-only">{t.readByAi}</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex items-center gap-1.5 border-t px-3 py-2 text-xs text-muted-foreground">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />
          {t.readLegend}
        </div>
      </aside>

      <section aria-label={t.editorLabel} className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b px-3.5 py-2">
          {allDocs.length > 0 && (
            <select
              aria-label={t.docs}
              className="hidden h-7 max-w-48 rounded-md border bg-background font-mono text-xs max-[900px]:block"
              value={selected ?? ""}
              onChange={(e) => setSelected(e.target.value)}
            >
              {allDocs.map((d) => (
                <option key={d.key} value={d.key}>
                  {docName(d.key)}
                </option>
              ))}
            </select>
          )}
          {hubDoc && (
            <>
              <span title={hubDoc.key} className="truncate font-mono text-sm font-medium max-[900px]:hidden">
                {docName(hubDoc.key)}
              </span>
              {suggestion ? (
                <StatePill tone="warn">{t.pending}</StatePill>
              ) : changed ? (
                <StatePill tone="warn">{t.unsent}</StatePill>
              ) : hubDoc.version ? (
                <StatePill tone="ok">{t.synced(hubDoc.version)}</StatePill>
              ) : (
                <StatePill tone="warn">{t.newOnHub}</StatePill>
              )}
              <div role="tablist" aria-label={t.editorLabel} className="inline-flex rounded-lg bg-muted p-0.5">
                {(
                  [
                    ["view", t.view],
                    ["edit", t.edit],
                    ["diff", t.changes],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={mode === m}
                    onClick={() => setMode(m)}
                    className={cn(
                      "h-6 cursor-pointer rounded-md px-2 text-xs",
                      mode === m
                        ? "bg-card font-semibold text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="flex-1" />
              {changed && <span className="text-xs text-muted-foreground max-[1180px]:hidden">{t.savedIn}</span>}
              <Button
                size="sm"
                disabled={!changed || !canPropose || !draftText.trim()}
                title={canPropose ? undefined : t.pushNeedsRole}
                onClick={() => setProposing(true)}
              >
                {t.push}
              </Button>
            </>
          )}
        </div>
        {stale && hubDoc && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-warning-soft px-3.5 py-1.5 text-sm text-warning">
            <span className="flex-1">{t.stale(draft?.base ?? 0, hubDoc.version)}</span>
            <Button size="xs" variant="outline" onClick={() => saveDraft(hubDoc.key, null)}>
              {t.dropDraft}
            </Button>
          </div>
        )}
        {!hubDoc ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
            {docError ? (
              <span className="text-destructive">{docError}</span>
            ) : selected ? (
              t.loading
            ) : account ? (
              t.pickDoc
            ) : (
              t.noAccountDocs
            )}
          </div>
        ) : mode === "edit" ? (
          <Textarea
            aria-label={t.editorLabel}
            value={draftText}
            onChange={(e) => saveDraft(hubDoc.key, { base, text: e.target.value, title: hubDoc.title })}
            className="min-h-0 flex-1 resize-none rounded-none border-0 px-9 py-6 font-mono text-sm [field-sizing:fixed] focus-visible:ring-0 md:text-sm"
          />
        ) : mode === "diff" ? (
          <div className="flex-1 overflow-y-auto px-9 py-6 font-mono text-sm leading-relaxed">
            {changed ? (
              diffHunks(lineDiff(hubDoc.content, draftText), 2).map((line, i) =>
                line === null ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: dòng diff dựng lại mỗi lần vẽ
                  <div key={i} className="py-1 text-muted-foreground">
                    ⋯
                  </div>
                ) : (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: dòng diff dựng lại mỗi lần vẽ
                    key={i}
                    className={cn(
                      "px-2 whitespace-pre-wrap",
                      line.kind === "add" && "bg-success-soft text-success",
                      line.kind === "del" && "bg-destructive-soft text-destructive",
                    )}
                  >
                    {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
                    {line.text}
                  </div>
                ),
              )
            ) : (
              <p className="font-sans text-sm text-muted-foreground">{t.noChanges}</p>
            )}
          </div>
        ) : (
          <article className="flex-1 overflow-y-auto px-9 py-6 text-[15px] leading-[1.75]">
            {suggestion ? (
              <>
                <SuggestionView
                  base={draftText}
                  proposal={suggestion}
                  labels={{ added: t.aiAdded, removed: t.aiRemoved }}
                />
                <div className="flex justify-end gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => setSuggestion(null)}>
                    {t.rejectAll}
                  </Button>
                  <Button size="sm" onClick={accept}>
                    {t.acceptAll}
                  </Button>
                </div>
              </>
            ) : draftText.trim() ? (
              <Markdown text={draftText} />
            ) : (
              <p className="text-sm text-muted-foreground">{t.emptyChat}</p>
            )}
          </article>
        )}
      </section>

      <aside
        aria-label={t.chat}
        className="flex w-[420px] shrink-0 flex-col border-l bg-background max-[1240px]:w-[360px] max-[900px]:w-[300px]"
      >
        <div className="flex flex-col gap-2 border-b px-3 py-2">
          <div className="flex items-center gap-2">
            <div role="tablist" aria-label={t.engine} className="inline-flex rounded-lg bg-muted p-0.5">
              {(
                [
                  ["claude", "Claude Code", "bg-[#D97757]"],
                  ["codex", "Codex", "bg-foreground"],
                ] as const
              ).map(([id, label, dot]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={engine === id}
                  disabled={running && engine !== id}
                  onClick={() => pickEngine(id)}
                  className={cn(
                    "inline-flex h-6.5 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-sm disabled:cursor-not-allowed",
                    engine === id ? "bg-card font-semibold text-foreground shadow-sm" : "text-muted-foreground",
                  )}
                >
                  <span aria-hidden="true" className={cn("size-1.75 rounded-full", dot)} />
                  {label}
                </button>
              ))}
            </div>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t.manageAcc}
              title={t.manageAcc}
              onClick={() => setAccOpen(true)}
            >
              <UserRoundIcon aria-hidden="true" className="size-3.75" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <select
              aria-label={t.session}
              disabled={running}
              value={chat.session ?? "new"}
              onChange={(e) => pickSession(e.target.value)}
              className="h-6.5 max-w-52.5 rounded-md border bg-background text-xs"
            >
              {chat.session && !engineSessions.some((s) => s.id === chat.session) && (
                <option value={chat.session}>{t.sessionAt(chat.session.slice(0, 8), "")}</option>
              )}
              {engineSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {t.sessionAt(s.title, timeOf(s.at, lang))}
                </option>
              ))}
              <option value="new">{t.newSession}</option>
            </select>
            <span className="text-muted-foreground">{t.modeLabel}</span>
            <fieldset className="inline-flex gap-0.5 rounded-[7px] bg-muted p-0.5">
              <legend className="sr-only">{t.modeLabel}</legend>
              {(engine === "claude"
                ? [t.readOnly, "Accept edits", "Bypass"]
                : ["Read Only", "Workspace", "Full Access"]
              ).map((label, i) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={i === 0}
                  disabled={i > 0}
                  title={
                    i > 0 ? t.locked : engine === "claude" ? "--restricted · Read, Glob, Grep" : "--sandbox read-only"
                  }
                  className={cn(
                    "h-5.5 rounded-[5px] px-2 text-xs",
                    i === 0
                      ? "bg-card font-semibold text-foreground"
                      : "cursor-not-allowed text-muted-foreground opacity-45",
                  )}
                >
                  {label}
                </button>
              ))}
            </fieldset>
          </div>
        </div>

        <div
          ref={transcript}
          aria-live="polite"
          className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-3.5 py-3 font-mono text-sm leading-[1.55]"
        >
          {chat.items.length === 0 && (
            <p className="font-sans text-sm text-muted-foreground">{chat.session ? t.resumed : t.emptyChat}</p>
          )}
          {chat.items.map((item, i) => (
            <ChatLine
              // biome-ignore lint/suspicious/noArrayIndexKey: dòng chat chỉ thêm vào cuối
              key={i}
              item={item}
              engine={engine}
              stripProposal={!!chat.docKey}
              docSuggestion={chat.suggestion?.text ?? null}
              baseText={baseText}
              onReopen={(key, proposal) => {
                setSelected(key);
                setMode("view");
                setSuggestion({ key, text: proposal });
              }}
            />
          ))}
          {running && (
            <span className="flex items-center gap-1.5 font-sans text-sm text-muted-foreground">
              <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />
              {t.running}
            </span>
          )}
          {chat.error && <p className="font-sans text-sm text-destructive">{chat.error}</p>}
        </div>

        <div className="flex flex-col gap-1.5 border-t px-3 py-2.5">
          {slash && (
            <div role="menu" aria-label={t.quick} className="rounded-xl border bg-card p-1 shadow-lg">
              {quicks.map((q) => (
                <button
                  key={q.cmd}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setInput(q.prompt);
                    setSlash(false);
                  }}
                  className="flex w-full cursor-pointer gap-2.5 rounded-md px-2 py-1.25 text-left text-sm hover:bg-muted"
                >
                  <span className="w-23 shrink-0 font-mono text-primary">{q.cmd}</span>
                  <span className="text-muted-foreground">{q.label}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-1.5 rounded-[10px] border border-input p-2">
            <div className="flex flex-wrap gap-1">
              <span className="inline-flex h-5 items-center rounded-[5px] bg-secondary px-1.5 font-mono text-xs text-secondary-foreground">
                @{folderName(folder)}/
              </span>
              {hubDoc && (
                <span className="inline-flex h-5 items-center rounded-[5px] bg-secondary px-1.5 font-mono text-xs text-secondary-foreground">
                  @{docName(hubDoc.key)}
                </span>
              )}
            </div>
            <textarea
              aria-label={t.ask}
              placeholder={t.placeholder[engine]}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setSlash(e.target.value === "/");
              }}
              onKeyDown={onKey}
              className="h-11 resize-none border-0 bg-transparent font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="xs"
                aria-label={t.quick}
                aria-expanded={slash}
                onClick={() => setSlash((s) => !s)}
                className="font-mono"
              >
                /
              </Button>
              <span className="flex-1 truncate text-xs text-muted-foreground">{t.hint}</span>
              {running ? (
                <Button size="sm" variant="outline" className="h-6.5" onClick={() => void cancelRun()}>
                  {t.stop}
                </Button>
              ) : (
                <Button size="sm" className="h-6.5" disabled={!input.trim()} onClick={() => void send(input)}>
                  {t.send}
                </Button>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2.5 font-mono text-xs text-muted-foreground">
            <span>{statusLeft.filter(Boolean).join(" · ")}</span>
            {lastResult?.kind === "result" && lastResult.ok && (
              <span className="ml-auto">
                {t.lastRun(formatTokens(lastResult.inputTokens, lang), formatTokens(lastResult.outputTokens, lang))}
              </span>
            )}
          </div>
        </div>
      </aside>

      <AiAccountsDialog
        open={accOpen}
        onOpenChange={setAccOpen}
        defaultEngine={defaultEngine}
        onDefault={(e) => {
          writeJson(ENGINE, e);
          setDefaultEngine(e);
          pickEngine(e);
        }}
      />
      {hubDoc && (
        <ProposeDialog
          open={proposing}
          onOpenChange={setProposing}
          docKey={hubDoc.key}
          base={base}
          content={draftText}
          hubContent={hubDoc.content}
          linked={!!account}
        />
      )}
    </div>
  );
}

function StatePill({ tone, children }: { tone: "ok" | "warn"; children: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-full px-1.75 text-xs font-medium whitespace-nowrap",
        tone === "ok" ? "bg-success-soft text-success" : "bg-warning-soft text-warning",
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

function ProposeDialog({
  open,
  onOpenChange,
  docKey,
  base,
  content,
  hubContent,
  linked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  docKey: string;
  base: number;
  content: string;
  hubContent: string;
  linked: boolean;
}) {
  const t = useT(text);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const stats = useMemo(() => (open ? diffStats(lineDiff(hubContent, content)) : null), [open, hubContent, content]);

  useEffect(() => {
    if (open) {
      setError(null);
      setSent(null);
    }
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;
    setSending(true);
    setError(null);
    try {
      const r = await proposeDoc({ key: docKey, baseVersion: base, content, note: note.trim() });
      setSent(r.proposalId);
      setNote("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.proposeTitle}</DialogTitle>
          <DialogDescription>
            {t.proposeLead(docKey, base)}
            {stats && (
              <span className="ml-1 font-mono">
                <span className="text-success">+{stats.added}</span>{" "}
                <span className="text-destructive">−{stats.removed}</span>
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        {sent ? (
          <p className="text-sm text-success">{t.sent(sent)}</p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Textarea
              aria-label={t.note}
              placeholder={t.notePlaceholder}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="min-h-20 text-sm"
            />
            {!linked && <p className="text-sm text-destructive">{t.needAccount}</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogActions>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t.cancel}
              </Button>
              <Button type="submit" disabled={sending || !note.trim() || !linked}>
                {t.sendProposal}
              </Button>
            </DialogActions>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
