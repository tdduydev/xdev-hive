import {
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZES,
  terminalTheme,
} from "@xdev-hive/ui/terminal-theme";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useSyncExternalStore } from "react";
import { getLang } from "@/lib/i18n.ts";
import { errorText, invoke } from "@/lib/tauri.ts";

/**
 * Terminal nhúng của màn Tài liệu (src-tauri/src/pty.rs): PTY trên máy, vẽ bằng xterm.js. Kho nằm ngoài React như kho
 * chat của agent.ts: sang màn khác rồi quay lại, CLI vẫn chạy và màn hình terminal còn nguyên; chỉ đóng tab mới giết
 * tiến trình.
 */
export type TermCli = "claude" | "codex" | "antigravity" | "shell";

export interface TermOptions {
  cli: TermCli;
  /** Gói agent của worker (thư mục đăng nhập riêng); null là đăng nhập mặc định của CLI. */
  planId: string | null;
  bypass: boolean;
  folder: string;
  label: string;
}

export interface TermSession extends TermOptions {
  key: string;
  ptyId: string | null;
  status: "starting" | "running" | "exited" | "failed";
  code: number | null;
  error: string | null;
}

interface Live {
  term: Terminal;
  fit: FitAddon;
  /** Phần tử xterm vẽ vào; gắn vào khung của màn khi màn mở, tháo ra khi màn đóng. */
  host: HTMLDivElement;
  opened: boolean;
}

let sessions: TermSession[] = [];
let active: string | null = null;
const live = new Map<string, Live>();
/** Output đến trước khi `pty_open` trả id (CLI in ngay khi chạy): giữ lại rồi vẽ khi biết id. */
const early = new Map<string, Uint8Array[]>();
const listeners = new Set<() => void>();
let listeningOn: unknown = null;
let seq = 0;
let fontSize = getTermFontSize();
let snapshot: { sessions: TermSession[]; active: string | null; fontSize: number } = { sessions, active, fontSize };

function emit() {
  snapshot = { sessions, active, fontSize };
  for (const l of listeners) l();
}

function update(key: string, patch: Partial<TermSession>) {
  sessions = sessions.map((s) => (s.key === key ? { ...s, ...patch } : s));
  emit();
}

const exitText = (code: number | null) =>
  getLang() === "vi"
    ? `[Đã thoát${code === null ? "" : `, mã ${code}`}]`
    : `[Exited${code === null ? "" : `, code ${code}`}]`;

function decode(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function ensureListening() {
  const tauri = window.__TAURI__;
  if (!tauri?.event || listeningOn === tauri) return;
  listeningOn = tauri;
  const fail = () => {
    listeningOn = null;
  };
  tauri.event
    .listen<{ id: string; data: string }>("pty:data", (e) => {
      const s = sessions.find((x) => x.ptyId === e.payload.id);
      const bytes = decode(e.payload.data);
      if (!s) {
        const buf = early.get(e.payload.id) ?? [];
        // Phòng id của terminal đã đóng: không giữ mãi.
        if (buf.length < 256) buf.push(bytes);
        early.set(e.payload.id, buf);
        return;
      }
      live.get(s.key)?.term.write(bytes);
    })
    .catch(fail);
  tauri.event
    .listen<{ id: string; code: number | null }>("pty:exit", (e) => {
      const s = sessions.find((x) => x.ptyId === e.payload.id);
      if (!s) return;
      live.get(s.key)?.term.write(`\r\n\x1b[2m${exitText(e.payload.code)}\x1b[0m\r\n`);
      update(s.key, { status: "exited", code: e.payload.code });
    })
    .catch(fail);
}

/** Bảng màu theo giao diện đang dùng (sáng/tối), đọc lúc mở terminal và khi đổi giao diện. */
export function termTheme() {
  const dark = document.documentElement.classList.contains("dark");
  return terminalTheme(dark ? "dark" : "light", document.documentElement);
}

const FONT_KEY = "hive.terminal.fontSize";

export function getTermFontSize(): number {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    return (TERMINAL_FONT_SIZES as readonly number[]).includes(n) ? n : TERMINAL_DEFAULT_FONT_SIZE;
  } catch {
    return TERMINAL_DEFAULT_FONT_SIZE;
  }
}

/** Đổi cỡ chữ mọi terminal đang mở; số cột đổi theo nên fit lại (onResize báo cho PTY). */
export function setTermFontSize(size: number) {
  try {
    localStorage.setItem(FONT_KEY, String(size));
  } catch {
    /* Không lưu được thì chỉ mất lựa chọn ở lần mở sau. */
  }
  for (const l of live.values()) {
    l.term.options.fontSize = size;
    if (l.opened) {
      try {
        l.fit.fit();
      } catch {
        /* Khung đang ẩn: lần đổi cỡ khung sau fit lại. */
      }
    }
  }
  fontSize = size;
  emit();
}

/** Chỉ mở link web: terminal in ra đường dẫn tuỳ ý (file://, lệnh của app khác) không được bấm. */
export function openTermLink(_event: MouseEvent, uri: string) {
  if (/^https?:\/\//i.test(uri)) window.open(uri, "_blank", "noopener,noreferrer");
}

export function useTerminals() {
  useEffect(ensureListening, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** Thêm tab terminal; PTY mở khi khung của tab gắn vào màn (cần cỡ thật của khung để tính số cột, số dòng). */
export function openTerminal(options: TermOptions): string {
  ensureListening();
  seq += 1;
  const key = `term-${seq}`;
  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize,
    // Chữ đậm của CLI (tiêu đề, tên file) đã rõ nhờ màu; chỉ tô sáng khi CLI đòi màu "bright".
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 4.5,
    scrollback: 5000,
    // Unicode11 là API đề xuất của xterm: bật mới đặt được bề rộng ô.
    allowProposedApi: true,
    theme: termTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon(openTermLink));
  // Bề rộng ô theo Unicode 11: emoji và chữ Việt có dấu tổ hợp không làm lệch cột.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  const host = document.createElement("div");
  host.className = "h-full w-full";
  live.set(key, { term, fit, host, opened: false });
  term.onData((data) => {
    const s = sessions.find((x) => x.key === key);
    if (s?.ptyId && s.status === "running") void invoke("pty_write", { id: s.ptyId, data }).catch(() => {});
  });
  term.onResize(({ cols, rows }) => {
    const s = sessions.find((x) => x.key === key);
    if (s?.ptyId && s.status === "running") void invoke("pty_resize", { id: s.ptyId, cols, rows }).catch(() => {});
  });
  sessions = [...sessions, { ...options, key, ptyId: null, status: "starting", code: null, error: null }];
  active = key;
  emit();
  return key;
}

async function start(key: string) {
  const s = sessions.find((x) => x.key === key);
  const l = live.get(key);
  if (!s || !l) return;
  try {
    const ptyId = await invoke<string>("pty_open", {
      cli: s.cli,
      planId: s.planId,
      bypass: s.bypass,
      folder: s.folder,
      cols: l.term.cols,
      rows: l.term.rows,
    });
    // Đóng tab trong lúc đang mở: giết luôn tiến trình vừa chạy.
    if (!live.has(key)) {
      void invoke("pty_close", { id: ptyId }).catch(() => {});
      return;
    }
    update(key, { ptyId, status: "running" });
    for (const bytes of early.get(ptyId) ?? []) l.term.write(bytes);
    early.delete(ptyId);
    l.term.focus();
  } catch (e) {
    const error = errorText(e);
    l.term.write(`\x1b[31m${error}\x1b[0m\r\n`);
    update(key, { status: "failed", error });
  }
}

/** Gắn terminal vào khung của màn. Lần đầu thì mở xterm và PTY. Trả hàm tháo (màn đóng, đổi tab). */
export function attachTerminal(key: string, el: HTMLElement): () => void {
  const l = live.get(key);
  if (!l) return () => {};
  el.appendChild(l.host);
  const first = !l.opened;
  if (first) {
    l.term.open(l.host);
    l.opened = true;
  }
  const refit = () => {
    try {
      l.fit.fit();
    } catch {
      /* Khung chưa có cỡ (đang ẩn): lần đổi cỡ sau fit lại. */
    }
  };
  refit();
  if (first) void start(key);
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refit);
  observer?.observe(el);
  // Đổi sáng/tối khi terminal đang mở.
  const themes =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
          l.term.options.theme = termTheme();
        });
  themes?.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => {
    observer?.disconnect();
    themes?.disconnect();
    l.host.remove();
  };
}

export function selectTerminal(key: string) {
  active = key;
  emit();
}

/** Đóng tab: giết tiến trình trong PTY và bỏ xterm. */
export function closeTerminal(key: string) {
  const s = sessions.find((x) => x.key === key);
  if (s?.ptyId && s.status === "running") void invoke("pty_close", { id: s.ptyId }).catch(() => {});
  const l = live.get(key);
  live.delete(key);
  l?.host.remove();
  l?.term.dispose();
  const i = sessions.findIndex((x) => x.key === key);
  sessions = sessions.filter((x) => x.key !== key);
  if (active === key) active = (sessions[i] ?? sessions[i - 1])?.key ?? null;
  emit();
}

/** Test: đóng hết và nghe lại trên cầu nối mới. */
export function resetTerminals() {
  for (const l of live.values()) l.term.dispose();
  live.clear();
  early.clear();
  sessions = [];
  active = null;
  listeningOn = null;
  emit();
}
