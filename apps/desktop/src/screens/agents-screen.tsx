import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { agentHex, HexAvatar } from "@xdev-hive/ui/hex-avatar";
import { Pill } from "@xdev-hive/ui/pill";
import { ExternalLinkIcon, RefreshCwIcon, SquareIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentFeedPanel } from "@/components/agent-feed.tsx";
import { type CliProfile, cliProfiles } from "@/lib/agent.ts";
import { folderName, shortPath } from "@/lib/folder.ts";
import { type Dict, type Lang, useLang, useT } from "@/lib/i18n.ts";
import { type LocalProject, localProjects } from "@/lib/local-projects.ts";
import {
  type AgentCli,
  type AgentScan,
  type AgentSource,
  CLI_LABEL,
  formatBytes,
  type MachineAgent,
  machineAgents,
  planOf,
  projectOf,
  stopMachineAgent,
} from "@/lib/machine-agents.ts";
import { errorText, invoke } from "@/lib/tauri.ts";
import { openAgentTerminal } from "@/lib/terminal.ts";

/** Đọc lại danh sách mỗi ngần này khi màn đang mở; CPU % tính giữa hai lần đọc. */
const POLL_MS = 3_000;

type SourceKind = AgentSource["kind"];
const SOURCES: SourceKind[] = ["run", "hive", "app", "claudeDesktop", "otherApp", "terminal"];
const CLIS: AgentCli[] = ["claude", "codex", "antigravity"];

const text: Dict<{
  counts: string;
  list: string;
  source: string;
  allSources: string;
  sources: Record<SourceKind, string>;
  refresh: string;
  loading: string;
  empty: string;
  busy: string;
  idle: string;
  background: string;
  bypass: string;
  started: (time: string) => string;
  project: string;
  plan: string;
  defaultPlan: string;
  doing: string;
  lastPrompt: string;
  guessed: string;
  openRun: string;
  openSession: string;
  terminalHere: string;
  openFeed: string;
  stop: string;
  stopTitle: (cli: string, pid: number) => string;
  stopLead: string;
  stopRun: string;
  stopDesktop: string;
  stopHive: string;
  stopChildren: (n: number) => string;
  stopOk: string;
  cancel: string;
  ago: (secs: number) => string;
  note: string;
}> = {
  vi: {
    counts: "Số agent theo CLI",
    list: "Agent đang chạy",
    source: "Nguồn",
    allSources: "Tất cả nguồn",
    sources: {
      run: "Hive run",
      hive: "Phiên hive",
      app: "Trong app",
      claudeDesktop: "Claude Desktop",
      otherApp: "App khác",
      terminal: "Terminal của bạn",
    },
    refresh: "Làm mới",
    loading: "Đang đọc tiến trình trên máy…",
    empty: "Không có Claude Code, Codex hay Antigravity nào đang chạy trên máy.",
    busy: "Đang làm",
    idle: "Đang chờ",
    background: "chạy nền",
    bypass: "bỏ hỏi quyền",
    started: (time) => `bắt đầu ${time}`,
    project: "Dự án",
    plan: "Gói",
    defaultPlan: "Đăng nhập mặc định",
    doing: "Đang làm",
    lastPrompt: "Lời nhắc cuối",
    guessed: "(đoán theo thư mục)",
    openRun: "Mở run trên web",
    openSession: "Mở phiên trên web",
    terminalHere: "Terminal ở thư mục này",
    openFeed: "Xem hoạt động:",
    stop: "Dừng…",
    stopTitle: (cli, pid) => `Dừng ${cli} (PID ${pid})?`,
    stopLead: "Agent và mọi tiến trình nó mở sẽ dừng ngay. Việc đang làm dở không được lưu.",
    stopRun: "Run của Hive sẽ báo lỗi. Muốn dừng gọn thì huỷ run trên web.",
    stopDesktop: "Phiên trong Claude Desktop sẽ ngắt.",
    stopHive: "Phiên hive sẽ đóng; thiết bị đang xem từ xa cũng mất phiên.",
    stopChildren: (n) => `Cũng dừng ${n} agent con chạy bên dưới.`,
    stopOk: "Dừng",
    cancel: "Huỷ",
    ago: (s) =>
      s < 60 ? `${s} giây trước` : s < 3600 ? `${Math.floor(s / 60)} phút trước` : `${Math.floor(s / 3600)} giờ trước`,
    note: "Việc đang làm đọc từ file phiên của chính CLI trên máy này, không gửi lên hub.",
  },
  en: {
    counts: "Agents per CLI",
    list: "Running agents",
    source: "Source",
    allSources: "All sources",
    sources: {
      run: "Hive run",
      hive: "Hive session",
      app: "In the app",
      claudeDesktop: "Claude Desktop",
      otherApp: "Other app",
      terminal: "Your terminal",
    },
    refresh: "Refresh",
    loading: "Reading processes on this machine…",
    empty: "No Claude Code, Codex or Antigravity is running on this machine.",
    busy: "Working",
    idle: "Waiting",
    background: "background",
    bypass: "no prompts",
    started: (time) => `started ${time}`,
    project: "Project",
    plan: "Plan",
    defaultPlan: "Default sign-in",
    doing: "Doing",
    lastPrompt: "Last prompt",
    guessed: "(guessed from the folder)",
    openRun: "Open run on the web",
    openSession: "Open session on the web",
    terminalHere: "Terminal in this folder",
    openFeed: "View activity:",
    stop: "Stop…",
    stopTitle: (cli, pid) => `Stop ${cli} (PID ${pid})?`,
    stopLead: "The agent and every process it started stop now. Unsaved work is lost.",
    stopRun: "The Hive run will fail. To stop it cleanly, cancel the run on the web.",
    stopDesktop: "The Claude Desktop session will be cut off.",
    stopHive: "The hive session closes; remote viewers lose it too.",
    stopChildren: (n) => `Also stops ${n} child ${n === 1 ? "agent" : "agents"} below it.`,
    stopOk: "Stop",
    cancel: "Cancel",
    ago: (s) => (s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`),
    note: "What each agent is doing comes from the CLI's own session files on this machine and is never sent to the hub.",
  },
};

const LOCALE: Record<Lang, string> = { vi: "vi-VN", en: "en-GB" };

function AgentRow({
  agent: a,
  scan,
  projects,
  plans,
  onStop,
  onError,
  onOpen,
}: {
  agent: MachineAgent;
  scan: AgentScan;
  projects: LocalProject[];
  plans: CliProfile[];
  onStop: (a: MachineAgent) => void;
  onError: (e: string) => void;
  onOpen: (a: MachineAgent, title: string) => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const { mark, tone } = agentHex(a.cli);
  const project = projectOf(a, projects, scan.home);
  const plan = planOf(a, plans, scan.home);
  const act = a.activity;
  const title = act?.title ?? project?.name ?? (a.cwd ? folderName(a.cwd) : CLI_LABEL[a.cli]);
  const source = a.source.kind === "otherApp" ? a.source.name : t.sources[a.source.kind];
  const started = new Date(a.startedAt * 1000).toLocaleTimeString(LOCALE[lang], { hour: "2-digit", minute: "2-digit" });
  const cpu = a.cpu.toLocaleString(LOCALE[lang], { maximumFractionDigits: 1 });
  const planText =
    plan === "default"
      ? t.defaultPlan
      : plan
        ? `${plan.label || plan.id}${plan.email ? ` · ${plan.email}` : ""}`
        : a.configDir
          ? shortPath(a.configDir)
          : t.defaultPlan;
  const projectText = a.source.kind === "run" ? (a.hiveProject ?? "—") : (project?.name ?? "—");
  const since = act?.at ? Math.max(0, Math.round((Date.now() - Date.parse(act.at)) / 1000)) : null;
  const runId = a.source.kind === "run" ? a.source.runId : null;
  const hubId = a.source.kind === "hive" ? a.source.hubId : null;
  const openHub = (path: string) => invoke("open_hub_page", { path }).catch((e) => onError(errorText(e)));

  return (
    <li aria-label={`${CLI_LABEL[a.cli]} PID ${a.pid}`} className="flex flex-col gap-2 px-4 py-3">
      <button
        type="button"
        onClick={() => onOpen(a, title)}
        className="-mx-2 -my-1.5 flex cursor-pointer flex-col items-stretch gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          {/* Tên của nút là cả nội dung thẻ (trạng thái, việc đang làm), mở đầu bằng lời nói nút làm gì. */}
          <span className="sr-only">{t.openFeed}</span>{" "}
          <HexAvatar aria-hidden="true" size="sm" tone={tone} className="font-mono">
            {mark}
          </HexAvatar>
          <span className="min-w-0 truncate text-sm font-semibold">{title}</span>{" "}
          {act?.status === "busy" && (
            <Pill tone="ok" dot>
              {t.busy}
            </Pill>
          )}
          {act?.status === "idle" && <Pill>{t.idle}</Pill>}
          <Pill tone="sel">{source}</Pill>
          {a.background && <Pill>{t.background}</Pill>}
          {a.bypass && <Pill tone="bad">{t.bypass}</Pill>}
        </span>
        <span className="block text-xs text-muted-foreground">
          {[
            CLI_LABEL[a.cli],
            `PID ${a.pid}`,
            t.started(started),
            `CPU ${cpu}%`,
            `RAM ${formatBytes(a.memory, lang)}`,
          ].join(" · ")}
        </span>
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
          {a.cwd && <span className="truncate font-mono text-muted-foreground">{shortPath(a.cwd)}</span>}
          <span>
            {t.project}: {projectText}
          </span>
          <span>
            {t.plan}: {planText}
          </span>
        </span>
        {act && (act.step || act.prompt) && (
          <span className="flex flex-col gap-0.5 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">
            {act.step && (
              <span className="truncate">
                <span className="text-muted-foreground">{t.doing}: </span>
                {act.step}
                {since !== null && <span className="text-muted-foreground"> · {t.ago(since)}</span>}
              </span>
            )}
            {act.prompt && (
              <span className="line-clamp-2" title={act.prompt}>
                <span className="text-muted-foreground">{t.lastPrompt}: </span>
                {act.prompt}
              </span>
            )}
            {act.guessed && <span className="text-muted-foreground">{t.guessed}</span>}
          </span>
        )}
      </button>
      <div className="flex flex-wrap gap-1.5">
        {runId && (
          <Button size="xs" variant="outline" onClick={() => void openHub(`/runs/${runId}`)}>
            <ExternalLinkIcon aria-hidden="true" />
            {t.openRun}
          </Button>
        )}
        {hubId && (
          <Button size="xs" variant="outline" onClick={() => void openHub(`/leader/terminal/${hubId}`)}>
            <ExternalLinkIcon aria-hidden="true" />
            {t.openSession}
          </Button>
        )}
        {a.cwd && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              const cwd = a.cwd as string;
              openAgentTerminal({ cli: "shell", planId: null, bypass: false, folder: cwd }).catch((e: unknown) =>
                onError(errorText(e)),
              );
            }}
          >
            <SquareTerminalIcon aria-hidden="true" />
            {t.terminalHere}
          </Button>
        )}
        {a.own && (
          <Button size="xs" variant="destructive" onClick={() => onStop(a)}>
            <SquareIcon aria-hidden="true" />
            {t.stop}
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * Agent trên máy (spec 021): mọi Claude Code, Codex, Antigravity đang chạy trên máy, ai mở cũng thấy (Hive run, phiên
 * hive, terminal của app, Claude Desktop, terminal của người dùng). Đọc lại mỗi 3 giây khi màn mở; rời màn thì thôi.
 */
export function AgentsScreen() {
  const t = useT(text);
  const [scan, setScan] = useState<AgentScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [plans, setPlans] = useState<CliProfile[]>([]);
  const [filter, setFilter] = useState<SourceKind | "">("");
  const [stopping, setStopping] = useState<MachineAgent | null>(null);
  const [viewing, setViewing] = useState<{ agent: MachineAgent; title: string } | null>(null);
  /** "Làm mới" và sau khi dừng: đọc ngay và bắt đầu lại nhịp 3 giây. */
  const refresh = useRef<() => void>(() => {});
  /** Mở từ Cây giao việc (`#/agents/<runId>`, specs/028 R8): mở sẵn bảng theo dõi của agent đang chạy run đó. */
  const wantedRun = useRef(location.hash.split("/")[2] || null);

  useEffect(() => {
    const runId = wantedRun.current;
    if (!runId || !scan) return;
    const agent = scan.agents.find((a) => a.source.kind === "run" && a.source.runId === runId);
    if (!agent) return;
    wantedRun.current = null;
    setViewing({ agent, title: agent.activity?.title ?? agent.hiveProject ?? CLI_LABEL[agent.cli] });
  }, [scan]);

  useEffect(() => {
    // Hai danh sách chỉ để đặt tên dự án và gói; đọc lỗi thì dòng vẫn hiện thư mục.
    localProjects().then(
      (r) => setProjects(r.projects),
      () => setProjects([]),
    );
    cliProfiles().then(
      (r) => setPlans(r.accounts),
      () => setPlans([]),
    );
  }, []);

  useEffect(() => {
    let alive = true;
    // Mỗi lần làm mới là một lượt mới: lượt cũ đang chờ kết quả thì bỏ, không chạy hai nhịp song song.
    let round = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (mine: number) => {
      const current = () => alive && mine === round;
      try {
        const next = await machineAgents();
        if (current()) {
          setScan(next);
          setError(null);
        }
      } catch (e) {
        if (current()) setError(errorText(e));
      }
      if (current()) timer = setTimeout(() => void tick(mine), POLL_MS);
    };
    refresh.current = () => {
      round += 1;
      clearTimeout(timer);
      void tick(round);
    };
    refresh.current();
    return () => {
      alive = false;
      clearTimeout(timer);
      refresh.current = () => {};
    };
  }, []);

  const agents = scan?.agents ?? [];
  const shown = filter ? agents.filter((a) => a.source.kind === filter) : agents;
  const counts = Object.fromEntries(CLIS.map((c) => [c, agents.filter((a) => a.cli === c).length])) as Record<
    AgentCli,
    number
  >;

  async function confirmStop(a: MachineAgent) {
    setStopping(null);
    try {
      if (a.source.kind === "hive" && a.source.sessionId)
        await invoke("remote_session_kill", { id: a.source.sessionId });
      else await stopMachineAgent(a.pid, a.startedAt);
    } catch (e) {
      setError(errorText(e));
    }
    refresh.current();
  }

  const warnings = (a: MachineAgent) => {
    const out: string[] = [];
    if (a.source.kind === "run") out.push(t.stopRun);
    if (a.source.kind === "claudeDesktop") out.push(t.stopDesktop);
    if (a.source.kind === "hive" && a.source.sessionId) out.push(t.stopHive);
    if (a.children > 0) out.push(t.stopChildren(a.children));
    return out;
  };

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <ul aria-label={t.counts} className="flex flex-wrap gap-2">
          {CLIS.map((c) => {
            const { mark, tone } = agentHex(c);
            return (
              <li key={c} className="flex items-center gap-2 rounded-full border bg-card py-1 pr-3 pl-1 text-sm">
                <HexAvatar aria-hidden="true" size="sm" tone={tone} className="font-mono">
                  {mark}
                </HexAvatar>
                <span>{CLI_LABEL[c]}</span> <span className="font-mono font-semibold">{counts[c]}</span>
              </li>
            );
          })}
        </ul>
        <span className="flex-1" />
        <select
          aria-label={t.source}
          value={filter}
          onChange={(e) => setFilter(e.target.value as SourceKind | "")}
          className="h-7 rounded-md border bg-background px-1.5 text-xs"
        >
          <option value="">{t.allSources}</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {t.sources[s]}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" onClick={() => refresh.current()}>
          <RefreshCwIcon aria-hidden="true" />
          {t.refresh}
        </Button>
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
      <section aria-label={t.list} className="overflow-hidden rounded-xl border bg-card">
        {!scan ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t.loading}</p>
        ) : shown.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t.empty}</p>
        ) : (
          <ul className="divide-y">
            {shown.map((a) => (
              <AgentRow
                key={`${a.pid}-${a.startedAt}`}
                agent={a}
                scan={scan}
                projects={projects}
                plans={plans}
                onStop={setStopping}
                onError={setError}
                onOpen={(agent, title) => setViewing({ agent, title })}
              />
            ))}
          </ul>
        )}
      </section>
      <p className="text-xs text-muted-foreground">{t.note}</p>

      <AgentFeedPanel agent={viewing?.agent ?? null} title={viewing?.title ?? ""} onClose={() => setViewing(null)} />

      <Dialog open={stopping !== null} onOpenChange={(open) => !open && setStopping(null)}>
        <DialogContent>
          {stopping && (
            <>
              <DialogHeader>
                <DialogTitle>{t.stopTitle(CLI_LABEL[stopping.cli], stopping.pid)}</DialogTitle>
                <DialogDescription>{t.stopLead}</DialogDescription>
              </DialogHeader>
              {stopping.cwd && <p className="font-mono text-xs text-muted-foreground">{shortPath(stopping.cwd)}</p>}
              {warnings(stopping).map((w) => (
                <p key={w} className="text-sm text-destructive">
                  {w}
                </p>
              ))}
              <DialogActions>
                <Button type="button" variant="outline" onClick={() => setStopping(null)}>
                  {t.cancel}
                </Button>
                <Button type="button" variant="destructive-solid" onClick={() => void confirmStop(stopping)}>
                  {t.stopOk}
                </Button>
              </DialogActions>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
