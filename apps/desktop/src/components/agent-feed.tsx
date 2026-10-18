import { redactSecrets } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { agentHex, HexAvatar } from "@xdev-hive/ui/hex-avatar";
import { CheckIcon, ChevronsUpIcon, CopyIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Toggle } from "@/components/toggle.tsx";
import { shortPath } from "@/lib/folder.ts";
import { type Dict, type Lang, useLang, useT } from "@/lib/i18n.ts";
import {
  CLI_LABEL,
  type FeedEntry,
  type MachineAgent,
  machineAgentFeed,
  machineAgentFeedOlder,
} from "@/lib/machine-agents.ts";
import { errorText } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

/** Đọc tiếp file phiên mỗi ngần này khi khung đang mở. */
const FEED_MS = 1_000;
/** Cách đáy dưới ngần này (px) vẫn coi là đang ở cuối danh sách. */
const BOTTOM_SLACK = 40;

const text: Dict<{
  title: string;
  list: string;
  follow: string;
  copy: string;
  copied: string;
  older: string;
  loading: string;
  empty: string;
  unreadable: string;
  unreadableHint: string;
  switched: string;
  guessed: string;
  kinds: Record<FeedEntry["kind"], string>;
  local: string;
}> = {
  vi: {
    title: "Hoạt động",
    list: "Hoạt động của agent",
    follow: "Theo dõi",
    copy: "Sao chép",
    copied: "Đã chép",
    older: "Tải thêm",
    loading: "Đang đọc phiên…",
    empty: "Phiên chưa có hoạt động nào.",
    unreadable: "Không đọc được phiên.",
    unreadableHint: "Không thấy file phiên của agent này, hoặc định dạng file phiên của CLI đã đổi.",
    switched: "Đã chuyển sang phiên mới.",
    guessed: "Chọn phiên mới nhất của thư mục (CLI không ghi phiên theo tiến trình).",
    kinds: { user: "Lời nhắc", assistant: "Agent", tool: "Công cụ", result: "Kết quả", error: "Lỗi" },
    local: "Đọc từ file phiên trên máy này, không gửi lên hub. Bí mật dạng token được che.",
  },
  en: {
    title: "Activity",
    list: "Agent activity",
    follow: "Follow",
    copy: "Copy",
    copied: "Copied",
    older: "Load more",
    loading: "Reading the session…",
    empty: "No activity in this session yet.",
    unreadable: "Can't read the session.",
    unreadableHint: "No session file was found for this agent, or the CLI changed its session format.",
    switched: "Switched to a new session.",
    guessed: "Showing the newest session of this folder (the CLI does not record sessions per process).",
    kinds: { user: "Prompt", assistant: "Agent", tool: "Tool", result: "Result", error: "Error" },
    local: "Read from the session file on this machine, never sent to the hub. Token-like secrets are masked.",
  },
};

const LOCALE: Record<Lang, string> = { vi: "vi-VN", en: "en-GB" };

const KIND_STYLE: Record<FeedEntry["kind"], { border: string; label: string; body: string }> = {
  user: { border: "border-primary", label: "text-primary", body: "" },
  assistant: { border: "border-border", label: "text-foreground", body: "" },
  tool: { border: "border-muted-foreground/40", label: "text-muted-foreground", body: "font-mono text-xs" },
  result: { border: "border-muted-foreground/20", label: "text-muted-foreground", body: "font-mono text-xs" },
  error: { border: "border-destructive", label: "text-destructive", body: "font-mono text-xs text-destructive" },
};

const clock = (at: string | null, lang: Lang) =>
  at ? new Date(at).toLocaleTimeString(LOCALE[lang], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";

/** Mục kèm số thứ tự nhận ở giao diện, làm khoá ổn định khi chèn trang cũ lên đầu. */
type Row = FeedEntry & { id: number };

const withIds = (seq: { current: number }, list: FeedEntry[]): Row[] => list.map((e) => ({ ...e, id: ++seq.current }));

/** Nội dung khung của một agent; đổi agent thì dựng lại từ đầu (key theo pid và giờ bắt đầu). */
function FeedBody({ agent, title }: { agent: MachineAgent; title: string }) {
  const t = useT(text);
  const lang = useLang();
  const [entries, setEntries] = useState<Row[]>([]);
  const [start, setStart] = useState(0);
  const [readable, setReadable] = useState<boolean | null>(null);
  const [guessed, setGuessed] = useState(false);
  const [switched, setSwitched] = useState(false);
  const [gone, setGone] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const [copied, setCopied] = useState(false);
  const path = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** Chiều cao trước khi chèn trang cũ lên đầu, để giữ nguyên chỗ người dùng đang đọc. */
  const prepended = useRef<number | null>(null);
  const seq = useRef(0);
  const { pid, startedAt } = agent;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor: { path: string; end: number } | null = null;
    const tick = async () => {
      try {
        const f = await machineAgentFeed(pid, startedAt, cursor);
        if (!alive) return;
        if (!cursor || f.reset) {
          setEntries(withIds(seq, f.entries));
          setStart(f.start);
          if (cursor && f.reset) setSwitched(true);
        } else if (f.entries.length > 0) {
          setEntries((prev) => [...prev, ...withIds(seq, f.entries)]);
        }
        cursor = f.path ? { path: f.path, end: f.end } : null;
        path.current = f.path;
        setReadable(f.readable);
        setGuessed(f.guessed);
      } catch (e) {
        // Agent thoát hay pid đã thuộc tiến trình khác: giữ mục đã đọc, thôi đọc tiếp.
        if (alive) setGone(errorText(e));
        return;
      }
      if (alive) timer = setTimeout(() => void tick(), FEED_MS);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pid, startedAt]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prepended.current !== null) {
      el.scrollTop += el.scrollHeight - prepended.current;
      prepended.current = null;
    } else if (following) {
      el.scrollTop = el.scrollHeight;
    }
  });

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    if (!atBottom && following) setFollowing(false);
  }

  function follow(next: boolean) {
    setFollowing(next);
    const el = scroller.current;
    if (next && el) el.scrollTop = el.scrollHeight;
  }

  async function loadOlder() {
    const file = path.current;
    if (!file || start === 0) return;
    try {
      const f = await machineAgentFeedOlder(pid, startedAt, file, start);
      prepended.current = scroller.current?.scrollHeight ?? null;
      if (f.reset) {
        prepended.current = null;
        setEntries(withIds(seq, f.entries));
      } else {
        setEntries((prev) => [...withIds(seq, f.entries), ...prev]);
      }
      setStart(f.start);
    } catch (e) {
      setGone(errorText(e));
    }
  }

  async function copy() {
    const lines = entries.map(
      (e) => `[${clock(e.at, lang)}] ${t.kinds[e.kind]}${e.tool ? ` (${e.tool})` : ""}: ${redactSecrets(e.text)}`,
    );
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      /* Không chép được (quyền clipboard): nút giữ nguyên. */
    }
  }

  const { mark, tone } = agentHex(agent.cli);
  return (
    <>
      <div className="flex flex-col gap-2 border-b px-4 py-3 pr-12">
        <DialogTitle className="flex min-w-0 items-center gap-2 text-base font-semibold">
          <HexAvatar aria-hidden="true" size="sm" tone={tone} className="font-mono">
            {mark}
          </HexAvatar>
          <span className="truncate">
            {t.title} · {title}
          </span>
        </DialogTitle>
        <DialogDescription className="text-xs">
          {CLI_LABEL[agent.cli]} · PID {agent.pid}
          {agent.cwd ? ` · ${shortPath(agent.cwd)}` : ""}
        </DialogDescription>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-2">
            <Toggle on={following} label={t.follow} onChange={follow} />
            <span aria-hidden="true">{t.follow}</span>
          </span>
          <Button size="xs" variant="outline" onClick={() => void copy()} disabled={entries.length === 0}>
            {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            {copied ? t.copied : t.copy}
          </Button>
        </div>
      </div>
      <div
        ref={scroller}
        data-testid="feed-scroll"
        onScroll={onScroll}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3"
      >
        {gone && <Alert variant="destructive">{gone}</Alert>}
        {switched && <p className="text-xs text-muted-foreground">{t.switched}</p>}
        {guessed && <p className="text-xs text-muted-foreground">{t.guessed}</p>}
        {readable === true && start > 0 && (
          <Button size="xs" variant="ghost" className="self-center" onClick={() => void loadOlder()}>
            <ChevronsUpIcon aria-hidden="true" />
            {t.older}
          </Button>
        )}
        {readable === null && !gone && <p className="text-sm text-muted-foreground">{t.loading}</p>}
        {readable === false && (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{t.unreadable}</p>
            <p className="text-xs text-muted-foreground">{t.unreadableHint}</p>
          </div>
        )}
        {readable === true && entries.length === 0 && <p className="text-sm text-muted-foreground">{t.empty}</p>}
        {entries.length > 0 && (
          <ol aria-label={t.list} className="flex flex-col gap-2.5">
            {entries.map((e) => {
              const style = KIND_STYLE[e.kind];
              return (
                <li key={e.id} data-kind={e.kind} className={cn("border-l-2 pl-2.5", style.border)}>
                  <span className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className={cn("font-semibold", style.label)}>{t.kinds[e.kind]}</span>
                    {e.tool && <code className="rounded bg-muted px-1 font-mono text-[11px]">{e.tool}</code>}
                    {e.at && (
                      <time dateTime={e.at} className="text-muted-foreground">
                        {clock(e.at, lang)}
                      </time>
                    )}
                  </span>
                  <p className={cn("mt-0.5 text-sm break-words whitespace-pre-wrap", style.body)}>
                    {redactSecrets(e.text)}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">{t.local}</p>
    </>
  );
}

/**
 * Khung Hoạt động (spec 021 phần 3): xem trực tiếp một agent đang làm gì, đọc theo đuôi file phiên của chính CLI trên
 * máy. Mở dạng khung bên phải; Esc hay nút đóng thì thôi đọc.
 */
export function AgentFeedPanel({
  agent,
  title,
  onClose,
}: {
  agent: MachineAgent | null;
  title: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={agent !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="top-0 right-0 left-auto flex h-svh max-h-svh w-full max-w-[min(44rem,100%)] translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:max-w-[min(44rem,100%)] data-open:zoom-in-100 data-closed:zoom-out-100">
        {agent && <FeedBody key={`${agent.pid}-${agent.startedAt}`} agent={agent} title={title} />}
      </DialogContent>
    </Dialog>
  );
}
