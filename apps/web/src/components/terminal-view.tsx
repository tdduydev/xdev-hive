import "@xterm/xterm/css/xterm.css";
import { TERMINAL_FONT_FAMILY, terminalTheme } from "@xdev-hive/ui/terminal-theme";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import { base64ToBytes, clampSize } from "@/lib/terminal.ts";
import { type Connection, type TerminalHandlers, TerminalSocket } from "@/lib/terminal-socket.ts";

export type ReplayStatus = "idle" | "loading" | "done" | "failed";

/** Cho trang gửi phím không đi qua bàn phím của xterm (thanh phím, ô soạn dòng trên điện thoại). */
export interface TerminalViewHandle {
  send: (data: string) => void;
  focus: () => void;
}

export interface TerminalViewProps {
  ref?: Ref<TerminalViewHandle>;
  /** Biến đổi chữ gõ trên bàn phím của xterm trước khi gửi (Ctrl/Alt đang giữ ở thanh phím). */
  transformInput?: (data: string) => string;
  sessionId: string;
  /** Cỡ lúc phiên chạy: phát lại bản ghi của phiên đã đóng dùng đúng cỡ này để TUI không bị vỡ dòng. */
  cols: number;
  rows: number;
  /** Phiên còn chạy: nối WebSocket. Đã đóng: phát lại bản ghi bằng `fetchChunks`. */
  live: boolean;
  /** Người xem (không phải chủ phiên) hay phiên đã đóng: terminal không nhận phím. */
  readOnly: boolean;
  fontSize: number;
  label: string;
  fetchTicket: () => Promise<{ ticket: string }>;
  fetchChunks: (after: number) => Promise<{ chunks: { seq: number; data: string }[]; more: boolean }>;
  /** Hỏi người dùng trước khi mở link trong output (output là chữ của CLI, không tin được). */
  confirmLink: (uri: string) => boolean;
  handlers: Omit<TerminalHandlers, "onOutput"> & { onReplay: (status: ReplayStatus) => void };
}

const isDark = () => document.documentElement.classList.contains("dark");
const themeNow = () => terminalTheme(isDark() ? "dark" : "light", document.documentElement);

/**
 * xterm.js của một phiên terminal Leader. Terminal sống suốt thời gian trang mở; kết nối WebSocket (phiên đang chạy)
 * hay phát lại bản ghi (phiên đã đóng) là hai việc riêng chạy trên cùng terminal đó, nên phiên vừa kết thúc thì
 * trang tải nốt phần output còn thiếu mà không vẽ lại từ đầu.
 */
export function TerminalView(props: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const socketRef = useRef<TerminalSocket | null>(null);
  const lastSeqRef = useRef(-1);
  /** Đang phát lại bản ghi ở cỡ cố định của phiên: không fit theo khung. */
  const fixedRef = useRef(false);
  const fitRef = useRef<FitAddon | null>(null);
  // Props đổi mỗi lần vẽ (hàm, đối tượng): effect đọc qua ref để không dựng lại terminal hay socket.
  const latest = useRef(props);
  latest.current = props;

  useImperativeHandle(
    props.ref,
    () => ({
      send: (data) => socketRef.current?.sendInput(data),
      focus: () => termRef.current?.focus(),
    }),
    [],
  );

  // 1. Terminal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dựng lại chỉ khi đổi phiên; mọi thứ khác đọc qua `latest`.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: latest.current.fontSize,
      // Chữ đậm của CLI đã rõ nhờ màu; chỉ tô sáng khi CLI đòi màu "bright".
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 4.5,
      scrollback: 5000,
      // Unicode11 là API đề xuất của xterm: bật mới đặt được bề rộng ô cho emoji và chữ Việt.
      allowProposedApi: true,
      disableStdin: latest.current.readOnly,
      theme: themeNow(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    // Link trong output chỉ mở sau khi người dùng đồng ý, và luôn tách khỏi trang (noopener).
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        if (latest.current.confirmLink(uri)) window.open(uri, "_blank", "noopener,noreferrer");
      }),
    );
    // OSC 52 cho CLI ghi vào clipboard của người dùng: không nạp addon clipboard và nuốt luôn chuỗi này.
    term.parser.registerOscHandler(52, () => true);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    const refit = () => {
      if (fixedRef.current) return;
      try {
        fit.fit();
      } catch {
        /* Khung chưa có kích thước (ẩn): bỏ qua, ResizeObserver gọi lại khi hiện. */
      }
    };
    refit();
    const data = term.onData((input) => {
      const transform = latest.current.transformInput;
      socketRef.current?.sendInput(transform ? transform(input) : input);
    });
    const resized = term.onResize(({ cols, rows }) => socketRef.current?.resize(cols, rows));
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    // Đổi sáng/tối bằng class `.dark` ở <html>.
    const theme = new MutationObserver(() => {
      term.options.theme = themeNow();
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    lastSeqRef.current = -1;
    fixedRef.current = false;
    return () => {
      observer.disconnect();
      theme.disconnect();
      data.dispose();
      resized.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [props.sessionId]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.disableStdin = props.readOnly;
  }, [props.readOnly]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = props.fontSize;
    if (!fixedRef.current) {
      try {
        fitRef.current?.fit();
      } catch {
        /* Như trên. */
      }
    }
  }, [props.fontSize]);

  // 2. Kết nối trực tiếp khi phiên còn chạy.
  // biome-ignore lint/correctness/useExhaustiveDependencies: đọc props qua `latest`; chỉ nối lại khi đổi phiên hoặc phiên thôi chạy.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !props.live) return;
    const handlers = latest.current.handlers;
    const socket = new TerminalSocket({
      fetchTicket: () => latest.current.fetchTicket(),
      afterSeq: lastSeqRef.current,
      handlers: {
        onConnection: (connection: Connection) => handlers.onConnection(connection),
        onHello: (session, canInput) => handlers.onHello(session, canInput),
        onState: (session) => handlers.onState(session),
        onActivity: () => handlers.onActivity(),
        onError: (code, message) => handlers.onError(code, message),
        onOutput: (bytes, seq) => {
          lastSeqRef.current = seq;
          term.write(bytes);
        },
      },
    });
    socketRef.current = socket;
    socket.start();
    socket.resize(term.cols, term.rows);
    return () => {
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [props.sessionId, props.live]);

  // 3. Phát lại bản ghi khi phiên đã đóng (kể cả phần còn thiếu sau khi vừa mất kết nối).
  // biome-ignore lint/correctness/useExhaustiveDependencies: như trên.
  useEffect(() => {
    const term = termRef.current;
    if (!term || props.live) return;
    let cancelled = false;
    const { fetchChunks, handlers, cols, rows } = latest.current;
    void (async () => {
      handlers.onReplay("loading");
      if (lastSeqRef.current === -1) {
        const size = clampSize(cols, rows);
        fixedRef.current = true;
        term.resize(size.cols, size.rows);
      }
      try {
        let more = true;
        while (more && !cancelled) {
          const page = await fetchChunks(lastSeqRef.current);
          if (cancelled) return;
          for (const chunk of page.chunks) {
            term.write(base64ToBytes(chunk.data));
            lastSeqRef.current = chunk.seq;
          }
          // Trang rỗng mà `more` vẫn true là hub lỗi: dừng thay vì hỏi mãi.
          more = page.more && page.chunks.length > 0;
        }
        if (!cancelled) handlers.onReplay("done");
      } catch {
        if (!cancelled) handlers.onReplay("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.sessionId, props.live]);

  return (
    <section
      ref={hostRef}
      aria-label={props.label}
      className="size-full min-h-0 overflow-auto rounded-lg border border-border bg-card p-2"
    />
  );
}
