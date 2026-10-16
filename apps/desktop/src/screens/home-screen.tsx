import { LogBuffer, type RunState } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { agentHex, HexAvatar } from "@xdev-hive/ui/hex-avatar";
import { Pill, type PillProps } from "@xdev-hive/ui/pill";
import {
  BotIcon,
  CoinsIcon,
  CpuIcon,
  FileTextIcon,
  FolderGitIcon,
  FolderIcon,
  MonitorIcon,
  PowerIcon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { ConnectHive } from "@/components/connect-hive.tsx";
import { PickFolderButton } from "@/components/pick-folder-button.tsx";
import { ScoreRing } from "@/components/score-ring.tsx";
import { profileOf, useLinkedAccount } from "@/lib/account.ts";
import { useBuildInfo } from "@/lib/build-info.ts";
import { folderName, useFolder } from "@/lib/folder.ts";
import { hub } from "@/lib/hub-rpc.ts";
import { type Dict, type Lang, useLang, useT } from "@/lib/i18n.ts";
import { type LocalProject, localProjects } from "@/lib/local-projects.ts";
import { duration, type MachineRun, machineRuns, thisMachine } from "@/lib/machine-runs.ts";
import { can, navItems, type ScreenId } from "@/lib/nav.ts";
import { CLI_NAME, DEFAULTS, type Limit, meterTone, type Plan, plans } from "@/lib/plans.ts";
import {
  onRemoteSessions,
  onRemoteState,
  type RemoteStatus,
  remoteDisable,
  remoteSessions,
  remoteStatus,
} from "@/lib/remote.ts";
import { ACTIVE, RUN_STATE_TEXT, stateTone } from "@/lib/run-state.ts";
import { type CheckItem, needsAction, readiness, scanEnvironment } from "@/lib/setup.ts";
import { errorText, setWorker, type WorkerKind, type WorkspaceMeta, workspaceMeta } from "@/lib/tauri.ts";
import { cacheRate, formatTokens, type SessionStats, sessionStats } from "@/lib/usage.ts";
import { cn } from "@/lib/utils.ts";
import { useWorkerState } from "@/lib/worker.ts";

const text: Dict<{
  workerKinds: Record<WorkerKind, string>;
  workerUnknown: string;
  noMachine: string;
  thisMachine: string;
  hubLine: (host: string) => string;
  noHub: string;
  build: (version: string) => string;
  offlineSince: (at: string) => string;
  stop: string;
  start: string;
  offlineTitle: string;
  offlineBody: string;
  localTitle: string;
  local: string;
  localItems: { plans: string; projects: string; setup: string; skills: string; tokens: string; docs: string };
  running: string;
  idle: string;
  runningNote: (key: string, mins: string) => string;
  today: string;
  todayNote: (ok: number, look: number) => string;
  noRunsToday: string;
  cost: string;
  costNote: (n: number) => string;
  tokens: string;
  cacheHits: (pct: number) => string;
  noSessions: string;
  statsFailed: string;
  needsHub: string;
  loading: string;
  current: string;
  openRuns: string;
  nothingRunning: string;
  noLog: string;
  tail: string;
  secs: (s: number) => string;
  quotas: string;
  openPlans: string;
  session: string;
  week: string;
  resetIn: (left: string) => string;
  noUsage: string;
  off: string;
  noPlans: string;
  plansFailed: string;
  env: string;
  envTodo: (n: number) => string;
  envOk: string;
  envScore: (ready: number, required: number) => string;
  envLead: (ready: number, required: number) => string;
  envAllReady: string;
  envFix: (n: number) => string;
  envOpen: string;
  envFailed: string;
  checking: string;
  needs: (need: string | null, have: string | null) => string;
  status: Record<"missing" | "outdated" | "mismatch", string>;
  remote: string;
  remoteOn: string;
  remoteOff: string;
  remoteDevices: (devices: number, viewers: number) => string;
  remoteOffHint: string;
  remoteStop: string;
  remoteOpen: string;
  remoteFailed: string;
  folder: string;
  openProjects: string;
  noFolder: string;
  fullOn: string;
  fullOff: string;
  branch: (b: string) => string;
  notGit: string;
  folderFailed: string;
}> = {
  vi: {
    workerKinds: {
      stopped: "Worker đã tắt",
      starting: "Đang bật worker",
      connecting: "Đang nối với hub",
      online: "Đang nhận việc",
      disconnected: "Mất kết nối, đang thử lại",
      stopping: "Đang dừng worker",
      failed: "Worker lỗi",
    },
    workerUnknown: "Không đọc được trạng thái worker",
    noMachine: "Máy chưa đăng ký",
    thisMachine: "Máy này",
    hubLine: (host) => `nối với ${host}`,
    noHub: "chưa đăng ký với hub nào",
    build: (v) => `app ${v}`,
    offlineSince: (at) => `mất kết nối từ ${at}`,
    stop: "Tắt worker",
    start: "Bật worker",
    offlineTitle: "Worker mất kết nối với hub hơn 1 phút. Máy này tạm không nhận việc.",
    offlineBody: "Worker tự thử nối lại; các mục trên máy vẫn dùng bình thường.",
    localTitle: "Vẫn dùng được khi không có hub",
    local:
      "Không đăng nhập vẫn dùng được các mục trên máy: gói agent, dự án, môi trường, skills, token và tài liệu từ code.",
    localItems: {
      plans: "Gói agent",
      projects: "Dự án trên máy",
      setup: "Môi trường",
      skills: "Skills",
      tokens: "Token và ngữ cảnh",
      docs: "Tài liệu từ code",
    },
    running: "Đang chạy",
    idle: "Máy đang rảnh",
    runningNote: (key, mins) => `${key} · ${mins}`,
    today: "Run hôm nay",
    todayNote: (ok, look) => `${ok} thành công · ${look} cần xem`,
    noRunsToday: "chưa có run nào hôm nay",
    cost: "Chi phí hôm nay",
    costNote: (n) => `${n} run có tính phí`,
    tokens: "Token hôm nay",
    cacheHits: (pct) => `cache trúng ${pct}%`,
    noSessions: "chưa có phiên nào hôm nay",
    statsFailed: "Không đọc được phiên trên máy",
    needsHub: "Kết nối Hive để xem run của máy này.",
    loading: "Đang đọc…",
    current: "Đang chạy trên máy",
    openRuns: "Xem lượt chạy",
    nothingRunning: "Máy chưa chạy run nào lúc này. Run hub giao cho máy sẽ hiện ở đây.",
    noLog: "Chưa có log.",
    tail: "Log gần nhất",
    secs: (s) => (s < 60 ? `${s} giây` : s < 3600 ? `${Math.round(s / 60)} phút` : `${(s / 3600).toFixed(1)} giờ`),
    quotas: "Hạn mức gói agent",
    openPlans: "Gói agent",
    session: "Phiên 5 giờ",
    week: "Tuần",
    resetIn: (left) => `làm mới sau ${left}`,
    noUsage: "chưa đọc hạn mức",
    off: "Đã tắt",
    noPlans: "Máy chưa có gói agent nào. Thêm gói để worker chia run.",
    plansFailed: "Không đọc được gói agent",
    env: "Môi trường",
    envTodo: (n) => `${n} mục cần xử lý`,
    envOk: "Đủ",
    envScore: (ready, required) => `${ready} trên ${required} mục bắt buộc đã đủ`,
    envLead: (ready, required) =>
      `${ready} trên ${required} mục bắt buộc đã đủ. Thiếu hoặc cũ thì agent có thể lỗi giữa chừng.`,
    envAllReady: "Máy đủ mọi mục bắt buộc.",
    envFix: (n) => `Xem ${n} mục cần sửa`,
    envOpen: "Mở Môi trường",
    envFailed: "Không kiểm được máy",
    checking: "Đang kiểm tra…",
    needs: (need, have) => (have ? `cần ${need ?? "—"} · máy có ${have}` : `cần ${need ?? "—"} · chưa cài`),
    status: { missing: "Thiếu", outdated: "Cũ", mismatch: "Lệch" },
    remote: "Điều khiển từ xa",
    remoteOn: "Đang bật",
    remoteOff: "Đã tắt",
    remoteDevices: (devices, viewers) =>
      viewers > 0 ? `${devices} thiết bị đã ghép · ${viewers} đang xem` : `${devices} thiết bị đã ghép`,
    remoteOffHint: "Bật ở màn Điều khiển từ xa để điện thoại xem phiên terminal của máy này.",
    remoteStop: "Tắt điều khiển từ xa ngay",
    remoteOpen: "Điều khiển từ xa",
    remoteFailed: "Không đọc được trạng thái điều khiển từ xa",
    folder: "Thư mục đang làm",
    openProjects: "Dự án trên máy",
    noFolder: "Chưa chọn thư mục làm việc.",
    fullOn: "Toàn quyền bật",
    fullOff: "Toàn quyền tắt",
    branch: (b) => `nhánh ${b}`,
    notGit: "không phải repo git",
    folderFailed: "Không đọc được thư mục",
  },
  en: {
    workerKinds: {
      stopped: "Worker is off",
      starting: "Starting the worker",
      connecting: "Connecting to the hub",
      online: "Taking tasks",
      disconnected: "Disconnected, retrying",
      stopping: "Stopping the worker",
      failed: "Worker error",
    },
    workerUnknown: "Could not read the worker status",
    noMachine: "Machine not registered",
    thisMachine: "This machine",
    hubLine: (host) => `connected to ${host}`,
    noHub: "not registered with a hub",
    build: (v) => `app ${v}`,
    offlineSince: (at) => `disconnected since ${at}`,
    stop: "Stop worker",
    start: "Start worker",
    offlineTitle: "The worker lost the hub for over a minute. This machine is not taking tasks.",
    offlineBody: "The worker keeps retrying; everything on this machine still works.",
    localTitle: "Still works without the hub",
    local:
      "Everything on this machine works without signing in: agent plans, projects, environment, skills, tokens and docs from code.",
    localItems: {
      plans: "Agent plans",
      projects: "Projects on this machine",
      setup: "Environment",
      skills: "Skills",
      tokens: "Tokens & context",
      docs: "Docs from code",
    },
    running: "Running",
    idle: "Machine is idle",
    runningNote: (key, mins) => `${key} · ${mins}`,
    today: "Runs today",
    todayNote: (ok, look) => `${ok} succeeded · ${look} to review`,
    noRunsToday: "no runs today yet",
    cost: "Cost today",
    costNote: (n) => `${n} runs with a cost`,
    tokens: "Tokens today",
    cacheHits: (pct) => `${pct}% cache hits`,
    noSessions: "no sessions today yet",
    statsFailed: "Could not read sessions on this machine",
    needsHub: "Connect to Hive to see this machine's runs.",
    loading: "Reading…",
    current: "Running on this machine",
    openRuns: "See runs",
    nothingRunning: "Nothing is running right now. Runs the hub gives this machine show up here.",
    noLog: "No log yet.",
    tail: "Latest log",
    secs: (s) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`),
    quotas: "Agent plan limits",
    openPlans: "Agent plans",
    session: "5-hour session",
    week: "Week",
    resetIn: (left) => `resets in ${left}`,
    noUsage: "limits not read yet",
    off: "Off",
    noPlans: "No agent plan on this machine yet. Add one so the worker can take runs.",
    plansFailed: "Could not read agent plans",
    env: "Environment",
    envTodo: (n) => `${n} items need action`,
    envOk: "Ready",
    envScore: (ready, required) => `${ready} of ${required} required items ready`,
    envLead: (ready, required) =>
      `${ready} of ${required} required items ready. Missing or old tools can make agents fail midway.`,
    envAllReady: "This machine has every required item.",
    envFix: (n) => `Fix ${n} items`,
    envOpen: "Open Environment",
    envFailed: "Could not check this machine",
    checking: "Checking…",
    needs: (need, have) => (have ? `needs ${need ?? "—"} · have ${have}` : `needs ${need ?? "—"} · not installed`),
    status: { missing: "Missing", outdated: "Old", mismatch: "Mismatch" },
    remote: "Remote control",
    remoteOn: "On",
    remoteOff: "Off",
    remoteDevices: (devices, viewers) =>
      viewers > 0 ? `${devices} paired devices · ${viewers} watching` : `${devices} paired devices`,
    remoteOffHint: "Turn it on in Remote control so a phone can watch this machine's terminal sessions.",
    remoteStop: "Turn off remote control now",
    remoteOpen: "Remote control",
    remoteFailed: "Could not read the remote control status",
    folder: "Working folder",
    openProjects: "Projects on this machine",
    noFolder: "No working folder chosen yet.",
    fullOn: "Full access on",
    fullOff: "Full access off",
    branch: (b) => `branch ${b}`,
    notGit: "not a git repo",
    folderFailed: "Could not read the folder",
  },
};

const LOCALE: Record<Lang, string> = { vi: "vi-VN", en: "en-GB" };

/** Mất kết nối quá chừng này thì báo, cùng ngưỡng với thông báo của Rust (worker.rs NOTIFY_AFTER_SECS). */
const OFFLINE_AFTER_MS = 60_000;
/** Run đang chạy đổi trạng thái nhanh; màn đầu của app hỏi lại hub dày hơn màn Lượt chạy. */
const RUNS_POLL_MS = 15_000;
const TAIL_POLL_MS = 3_000;
const TAIL_LINES = 4;

const WORKER_TONE: Record<WorkerKind, NonNullable<PillProps["tone"]>> = {
  stopped: "neutral",
  starting: "warn",
  connecting: "warn",
  online: "ok",
  disconnected: "warn",
  stopping: "neutral",
  failed: "bad",
};

/** Mục trên máy dùng được khi không có hub, theo thứ tự của câu nhắc. */
const LOCAL_LINKS = [
  ["plans", BotIcon],
  ["projects", FolderGitIcon],
  ["setup", CpuIcon],
  ["skills", ZapIcon],
  ["tokens", CoinsIcon],
  ["docs", FileTextIcon],
] as const;

const usd = (n: number, lang: Lang) =>
  `${n.toLocaleString(LOCALE[lang], { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;

const startOfToday = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Số liệu của các ô đầu màn tính từ run của máy, chỉ tính run tạo từ nửa đêm theo giờ máy. */
export function runsToday(runs: MachineRun[], now = Date.now()) {
  const from = startOfToday(now);
  const today = runs.filter((r) => Date.parse(r.createdAt) >= from);
  const costed = today.filter((r) => r.costUsd !== null);
  return {
    active: runs.filter((r) => ACTIVE.has(r.state)),
    count: today.length,
    ok: today.filter((r) => r.state === "succeeded" || r.state === "no_changes").length,
    look: today.filter((r) => r.state === "needs_review" || r.state === "failed" || r.state === "lost").length,
    cost: costed.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
    costed: costed.length,
  };
}

/** Token vào của các phiên Claude Code hôm nay trên máy, kèm phần đọc từ cache. */
export function tokensToday(stats: SessionStats, now = Date.now()): { input: number; cached: number } {
  const from = startOfToday(now);
  return stats.sessions
    .filter((s) => Date.parse(s.at) >= from)
    .reduce((acc, s) => ({ input: acc.input + s.input, cached: acc.cached + s.cached }), { input: 0, cached: 0 });
}

/** "3 giờ 10 phút" tới lúc làm mới; đã qua thì null. */
export function untilText(iso: string, now: number, lang: Lang): string | null {
  const mins = Math.round((Date.parse(iso) - now) / 60_000);
  if (!Number.isFinite(mins) || mins <= 0) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (lang === "en") return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
  return h ? (m ? `${h} giờ ${m} phút` : `${h} giờ`) : `${m} phút`;
}

/** Vài dòng log cuối, bỏ dòng trống. */
export const lastLines = (log: string, n = TAIL_LINES) =>
  log
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-n);

function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h3 id={id} className="text-[15px] font-semibold">
          {title}
        </h3>
        {aside}
      </div>
      <div className="flex flex-col gap-3 px-4 py-3">{children}</div>
    </section>
  );
}

function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="text-xs text-primary">
      {children}
    </a>
  );
}

function Kpi({
  label,
  value,
  note,
  dot,
  title,
}: {
  label: string;
  value: ReactNode;
  note: string;
  dot?: boolean;
  title?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border bg-card px-3.5 py-3 text-card-foreground">
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {dot && <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />}
        {label}
      </span>
      <span className="font-mono text-2xl font-semibold tracking-tight">{value}</span>
      <span title={title} className="truncate text-xs text-muted-foreground">
        {note}
      </span>
    </div>
  );
}

function Meter({ label, limit, stop, lang }: { label: string; limit: Limit; stop: number; lang: Lang }) {
  const pct = Math.max(0, Math.min(100, Math.round(limit.percent)));
  const tone = meterTone(pct, stop);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{pct.toLocaleString(LOCALE[lang])}%</span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: thẻ <meter> không tô màu theo ngưỡng dừng của gói được. */}
      <span
        role="meter"
        aria-label={label}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative block h-1.5 rounded-full bg-muted"
      >
        <span
          data-tone={tone}
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            tone === "over" ? "bg-destructive" : tone === "near" ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}

/** Ô lục giác của agent CLI, cùng chữ và màu với web (CC, CX). Tên CLI đã ghi cạnh bên nên ô chỉ để nhìn. */
function CliBadge({ cli }: { cli: string }) {
  const { mark, tone } = agentHex(cli);
  return (
    <HexAvatar aria-hidden="true" size="sm" tone={tone} title={CLI_NAME[cli] ?? cli} className="font-mono">
      {mark}
    </HexAvatar>
  );
}

/** Run hub giao cho máy này, hỏi lại đều để ô Đang chạy và run hiện tại không cũ. */
function useMachineRuns(signedIn: boolean) {
  const [machine, setMachine] = useState<string | null | undefined>(undefined);
  const [runs, setRuns] = useState<MachineRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    thisMachine().then(setMachine, () => setMachine(null));
  }, []);
  useEffect(() => {
    if (!machine || !signedIn) return;
    let alive = true;
    const load = () =>
      machineRuns(machine).then(
        (list) => {
          if (!alive) return;
          setRuns(list);
          setError(null);
        },
        (e) => alive && setError(errorText(e)),
      );
    void load();
    const h = setInterval(() => void load(), RUNS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [machine, signedIn]);
  return { machine, runs, error };
}

/** Vài dòng log cuối của run đang chạy, hỏi tiếp theo con trỏ như màn chi tiết run trên web. */
function useRunTail(runId: string | null): string[] | null {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    setLines(null);
    if (!runId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const buffer = new LogBuffer();
    let after = 0;
    const tick = async () => {
      try {
        const chunks = await hub.runs.logs({ id: runId, after, limit: 500 });
        buffer.append(chunks);
        after = chunks.at(-1)?.id ?? after;
        if (!stopped) setLines(lastLines(buffer.toString()));
      } catch {
        /* Mất mạng giữa chừng: giữ dòng cũ, lần sau hỏi tiếp. */
      }
      if (!stopped) timer = setTimeout(() => void tick(), TAIL_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId]);
  return lines;
}

function useNow(every: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(h);
  }, [every]);
  return now;
}

function CurrentRun({ run, now }: { run: MachineRun; now: number }) {
  const t = useT(text);
  const lang = useLang();
  const tail = useRunTail(run.id);
  const secs = duration(run, now);
  const meta = [
    run.cli ? (CLI_NAME[run.cli] ?? run.cli) : null,
    run.model,
    secs === null ? null : t.secs(secs),
    run.costUsd === null ? null : usd(run.costUsd, lang),
  ].filter(Boolean);
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{run.title}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {run.taskKey} · run {run.id.slice(0, 8)}
          </span>
        </div>
        <Pill tone={stateTone(run.state)} dot>
          {RUN_STATE_TEXT[lang][run.state as RunState] ?? run.state}
        </Pill>
      </div>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        {run.cli && <CliBadge cli={run.cli} />}
        {meta.join(" · ")}
      </p>
      <section aria-label={t.tail}>
        <pre className="overflow-hidden rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {tail === null ? t.loading : tail.length ? tail.join("\n") : t.noLog}
        </pre>
      </section>
    </>
  );
}

function PlanRow({ plan, now }: { plan: Plan; now: number }) {
  const t = useT(text);
  const lang = useLang();
  const name = plan.label || plan.id;
  if (!plan.enabled)
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <CliBadge cli={plan.cli} />
          <span className="truncate">{name}</span>
        </span>
        <Pill>{t.off}</Pill>
      </div>
    );
  const usage = plan.usage;
  const reset = usage?.session?.resetsAt ? untilText(usage.session.resetsAt, now, lang) : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <CliBadge cli={plan.cli} />
          <span className="truncate">{name}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {reset ? t.resetIn(reset) : !usage?.session && !usage?.week ? (usage?.reason ?? t.noUsage) : ""}
        </span>
      </div>
      {usage?.session && (
        <Meter
          label={t.session}
          limit={usage.session}
          stop={plan.stopAtSession ?? DEFAULTS.stopAtSession}
          lang={lang}
        />
      )}
      {usage?.week && (
        <Meter label={t.week} limit={usage.week} stop={plan.stopAtWeek ?? DEFAULTS.stopAtWeek} lang={lang} />
      )}
    </div>
  );
}

function PlanQuotas({ now }: { now: number }) {
  const t = useT(text);
  const [list, setList] = useState<Plan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    plans().then(
      // Worker cũ hay cầu nối giả có thể trả rỗng: coi như chưa có gói thay vì làm hỏng màn.
      (p) => setList(p?.accounts ?? []),
      (e) => setError(errorText(e)),
    );
  }, []);
  // Gói đang bật lên trước; gói tắt chỉ còn một dòng ở cuối.
  const sorted = [...(list ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  return (
    <Card title={t.quotas} aside={<CardLink href="#/plans">{t.openPlans}</CardLink>}>
      {error ? (
        <p className="text-sm text-muted-foreground" title={error}>
          {t.plansFailed}
        </p>
      ) : list === null ? (
        <p className="text-sm text-muted-foreground">{t.loading}</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.noPlans}</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {sorted.map((p) => (
            <li key={p.id} className="py-2.5 first:pt-0 last:pb-0">
              <PlanRow plan={p} now={now} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function EnvironmentCard({ folder }: { folder: string }) {
  const t = useT(text);
  const [checks, setChecks] = useState<CheckItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Chưa chọn thư mục thì Rust chỉ kiểm công cụ chung của máy.
  useEffect(() => {
    let alive = true;
    setChecks(null);
    setError(null);
    scanEnvironment(folder).then(
      (c) => alive && setChecks(c),
      (e) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [folder]);
  const env = checks ? readiness(checks) : null;
  const todo = checks?.filter(needsAction) ?? [];
  return (
    <Card
      title={t.env}
      aside={
        env &&
        (todo.length ? (
          <Pill tone="warn">
            <TriangleAlertIcon aria-hidden="true" className="size-3" />
            {t.envTodo(todo.length)}
          </Pill>
        ) : (
          <Pill tone="ok">{t.envOk}</Pill>
        ))
      }
    >
      {error ? (
        <p className="text-sm text-destructive" title={error}>
          {t.envFailed}
        </p>
      ) : !env ? (
        <p className="text-sm text-muted-foreground">{t.checking}</p>
      ) : (
        <>
          <div className="flex items-center gap-3.5">
            <ScoreRing small ready={env.ready} required={env.required} label={t.envScore(env.ready, env.required)} />
            <p className="text-sm text-muted-foreground">
              {todo.length ? t.envLead(env.ready, env.required) : t.envAllReady}
            </p>
          </div>
          {todo.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {todo.slice(0, 3).map((c) => (
                <li key={c.id} className="flex items-center gap-2.5 text-sm">
                  <span className="w-28 shrink-0 truncate font-mono">{c.name}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {t.needs(c.need, c.have)}
                  </span>
                  <Pill tone={c.status === "missing" ? "bad" : "warn"}>
                    {t.status[c.status as "missing" | "outdated" | "mismatch"]}
                  </Pill>
                </li>
              ))}
            </ul>
          )}
          {/* Nút chính duy nhất của màn: môi trường thiếu là thứ làm máy nhận việc rồi lỗi giữa chừng. */}
          <Button
            nativeButton={false}
            role="link"
            render={<a href="#/setup" />}
            variant={todo.length ? "default" : "outline"}
            size="sm"
            className="self-start"
          >
            <CpuIcon aria-hidden="true" />
            {todo.length ? t.envFix(todo.length) : t.envOpen}
          </Button>
        </>
      )}
    </Card>
  );
}

function RemoteCard() {
  const t = useT(text);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [viewers, setViewers] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    remoteStatus().then(setStatus, (e) => setError(errorText(e)));
    remoteSessions().then(
      (list) => setViewers((list ?? []).reduce((n, s) => n + s.viewers, 0)),
      () => {},
    );
    const offs = [
      onRemoteState(setStatus),
      onRemoteSessions((e) => setViewers((e.sessions ?? []).reduce((n, s) => n + s.viewers, 0))),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);
  async function stop() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await remoteDisable());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const on = !!status?.enabled;
  return (
    <Card
      title={t.remote}
      aside={
        status && (
          <Pill tone={on ? "ok" : "neutral"} dot={on}>
            {on ? t.remoteOn : t.remoteOff}
          </Pill>
        )
      }
    >
      {!status ? (
        <p className="text-sm text-muted-foreground" title={error ?? undefined}>
          {error ? t.remoteFailed : t.loading}
        </p>
      ) : on ? (
        <>
          <p className="text-sm text-muted-foreground">{t.remoteDevices(status.devices.length, viewers)}</p>
          {/* Bật lại phải qua màn Điều khiển từ xa (hỏi xác nhận); tắt thì làm ngay được ở đây. */}
          <Button variant="destructive" size="sm" className="self-start" disabled={busy} onClick={() => void stop()}>
            {t.remoteStop}
          </Button>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-48 flex-1 text-sm text-muted-foreground">{t.remoteOffHint}</p>
          <Button nativeButton={false} role="link" render={<a href="#/remote" />} variant="outline" size="sm">
            {t.remoteOpen}
          </Button>
        </div>
      )}
      {error && status && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </Card>
  );
}

function FolderCard({ folder }: { folder: string }) {
  const t = useT(text);
  const [meta, setMeta] = useState<WorkspaceMeta | null>(null);
  const [local, setLocal] = useState<LocalProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setMeta(null);
    setLocal(null);
    setError(null);
    if (!folder) return;
    workspaceMeta(folder).then(
      (m) => alive && setMeta(m),
      (e) => alive && setError(errorText(e)),
    );
    localProjects().then(
      (l) => alive && setLocal(l?.projects.find((p) => p.folder === folder && p.projectId) ?? null),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [folder]);
  return (
    <Card title={t.folder} aside={<CardLink href="#/projects">{t.openProjects}</CardLink>}>
      {!folder ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex-1 text-sm text-muted-foreground">{t.noFolder}</p>
          <PickFolderButton />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <FolderIcon aria-hidden="true" className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">{folderName(folder)}</span>
            {local && (
              <>
                <span className="rounded-md border px-1.5 font-mono text-xs">{local.name}</span>
                <span className="rounded-md border px-1.5 text-xs text-muted-foreground">
                  {local.fullPermission ? t.fullOn : t.fullOff}
                </span>
              </>
            )}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground" title={error ?? folder}>
            {folder}
            {error
              ? ` · ${t.folderFailed}`
              : meta
                ? ` · ${meta.isGit ? (meta.branch ? t.branch(meta.branch) : "") : t.notGit}`
                : ""}
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * Màn đầu của app (Máy này): worker, run đang chạy, hạn mức gói, môi trường, điều khiển từ xa và thư mục đang làm của
 * chính máy này. Việc của đội không còn trong app; "Mở hub trên web" ở chân menu và thông báo Windows dẫn sang web.
 * Phần cần hub (run của máy) chờ đăng nhập; phần còn lại đọc ngay trên máy.
 */
export function HomeScreen() {
  const t = useT(text);
  const lang = useLang();
  const account = useLinkedAccount();
  const profile = profileOf(account ?? null);
  const runsLocal = can(profile, "runs.local");
  const [folder] = useFolder();
  const worker = useWorkerState();
  const build = useBuildInfo();
  const now = useNow(15_000);
  const { machine, runs, error: runsError } = useMachineRuns(!!account && runsLocal);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  useEffect(() => {
    sessionStats("claude", "").then(setStats, (e) => setStatsError(errorText(e)));
  }, []);

  const offline =
    !!worker?.offlineSince &&
    (worker.kind === "connecting" || worker.kind === "disconnected") &&
    now - worker.offlineSince * 1000 >= OFFLINE_AFTER_MS;
  const today = runs ? runsToday(runs, now) : null;
  const current = today?.active[0] ?? null;
  const tokens = stats ? tokensToday(stats, now) : null;
  const rate = tokens ? cacheRate(tokens.input, tokens.cached) : null;
  // Ô cần hub mà chưa có số thì nói lý do ngắn, không để "Đang đọc…" mãi.
  const runsNote = !account ? t.needsHub : machine === null ? t.noHub : runsError ? runsError : null;

  async function toggleWorker() {
    setToggling(true);
    setToggleError(null);
    try {
      await setWorker(!worker?.wanted);
    } catch (e) {
      setToggleError(errorText(e));
    } finally {
      setToggling(false);
    }
  }

  const host = hostOf(worker?.hub);
  const since = worker?.offlineSince
    ? new Date(worker.offlineSince * 1000).toLocaleTimeString(LOCALE[lang], { hour: "2-digit", minute: "2-digit" })
    : null;
  const workerLine = [
    host ? t.hubLine(host) : t.noHub,
    build.version ? t.build(build.version) : null,
    offline && since ? t.offlineSince(since) : null,
    worker?.kind === "failed" ? worker.detail : null,
  ].filter(Boolean);

  // Chỉ mời vào mục người dùng thấy trên menu (người xem đội không có Gói agent, Môi trường).
  const visible = new Set<ScreenId>(navItems(profile).map((i) => i.id));
  const localUse = (
    <Card title={t.localTitle}>
      <p className="text-sm text-muted-foreground">{t.local}</p>
      <div className="flex flex-wrap gap-2">
        {LOCAL_LINKS.filter(([id]) => visible.has(id)).map(([id, Icon]) => (
          <a
            key={id}
            href={`#/${id}`}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-background px-2.5 text-xs text-foreground no-underline hover:bg-muted"
          >
            <Icon aria-hidden="true" className="size-3.5" />
            {t.localItems[id]}
          </a>
        ))}
      </div>
    </Card>
  );

  return (
    <div className="flex flex-col gap-3.5">
      {offline && (
        <div role="alert" className="flex items-start gap-2.5 rounded-xl border bg-warning-soft px-4 py-3 text-sm">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>
            <strong className="font-semibold">{t.offlineTitle}</strong>
            <br />
            <span className="text-muted-foreground">{worker?.detail ?? t.offlineBody}</span>
          </p>
        </div>
      )}

      {runsLocal && (
        <section
          aria-label={t.thisMachine}
          className="flex flex-wrap items-center gap-3.5 rounded-xl border bg-card px-4 py-3.5"
        >
          <HexAvatar aria-hidden="true" size="lg" tone={offline ? "warning" : "navy"}>
            <MonitorIcon />
          </HexAvatar>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-base font-semibold">{machine || t.noMachine}</span>
              <Pill tone={worker ? WORKER_TONE[worker.kind] : "neutral"} dot={worker?.kind === "online"}>
                {worker ? t.workerKinds[worker.kind] : t.workerUnknown}
              </Pill>
            </div>
            <span className="truncate text-xs text-muted-foreground">{workerLine.join(" · ")}</span>
            {toggleError && (
              <span role="alert" className="text-xs text-destructive">
                {toggleError}
              </span>
            )}
          </div>
          {worker && (
            <Button
              variant="outline"
              size="sm"
              disabled={toggling || worker.kind === "stopping"}
              onClick={() => void toggleWorker()}
            >
              <PowerIcon aria-hidden="true" />
              {worker.wanted ? t.stop : t.start}
            </Button>
          )}
        </section>
      )}

      {(offline || !account) && localUse}

      <section className="grid grid-cols-2 gap-3 min-[1000px]:grid-cols-4">
        {runsLocal && (
          <>
            <Kpi
              label={t.running}
              dot={!!current}
              value={today ? today.active.length : "—"}
              note={
                runsNote ??
                (!today
                  ? t.loading
                  : current
                    ? t.runningNote(current.taskKey, t.secs(duration(current, now) ?? 0))
                    : t.idle)
              }
              title={runsError ?? undefined}
            />
            <Kpi
              label={t.today}
              value={today ? today.count : "—"}
              note={runsNote ?? (!today ? t.loading : today.count ? t.todayNote(today.ok, today.look) : t.noRunsToday)}
              title={runsError ?? undefined}
            />
            <Kpi
              label={t.cost}
              value={today ? usd(today.cost, lang) : "—"}
              note={runsNote ?? (!today ? t.loading : t.costNote(today.costed))}
              title={runsError ?? undefined}
            />
          </>
        )}
        <Kpi
          label={t.tokens}
          value={tokens ? formatTokens(tokens.input, lang) : "—"}
          note={statsError ? t.statsFailed : !tokens ? t.loading : rate === null ? t.noSessions : t.cacheHits(rate)}
          title={statsError ?? undefined}
        />
      </section>

      {runsLocal && (
        <div className="grid grid-cols-1 items-start gap-3.5 min-[1000px]:grid-cols-2">
          <Card title={t.current} aside={<CardLink href="#/runs">{t.openRuns}</CardLink>}>
            {!account ? (
              <div className="-mx-4 -my-3">
                <ConnectHive inline note={t.needsHub} />
              </div>
            ) : runsNote ? (
              <p className="text-sm text-muted-foreground">{runsNote}</p>
            ) : !today ? (
              <p className="text-sm text-muted-foreground">{t.loading}</p>
            ) : current ? (
              <CurrentRun run={current} now={now} />
            ) : (
              <p className="text-sm text-muted-foreground">{t.nothingRunning}</p>
            )}
          </Card>
          <PlanQuotas now={now} />
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-3.5 min-[1000px]:grid-cols-2">
        {can(profile, "env.manage") && <EnvironmentCard folder={folder} />}
        <div className="flex min-w-0 flex-col gap-3.5">
          {runsLocal && <RemoteCard />}
          <FolderCard folder={folder} />
        </div>
      </div>
    </div>
  );
}
