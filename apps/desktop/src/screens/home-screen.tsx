import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { type ReactNode, useEffect, useState } from "react";
import { ConnectHive } from "@/components/connect-hive.tsx";
import { PickFolderButton } from "@/components/pick-folder-button.tsx";
import { profileOf, useLinkedAccount } from "@/lib/account.ts";
import { folderName, useFolder } from "@/lib/folder.ts";
import { type HubDoc, type HubProject, type HubSkill, hubTool, matchProject } from "@/lib/hub.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { type CheckItem, needsAction, readiness, scanEnvironment } from "@/lib/setup.ts";
import { errorText, type WorkerKind, type WorkspaceMeta, workspaceMeta } from "@/lib/tauri.ts";
import { cacheRate, formatTokens, type SessionStats, sessionStats } from "@/lib/usage.ts";
import { cn } from "@/lib/utils.ts";
import { useWorkerState } from "@/lib/worker.ts";

const text: Dict<{
  hello: (name: string) => string;
  helloAnon: string;
  linked: (project: string) => string;
  unmatched: (folder: string) => string;
  noFolder: string;
  metaFailed: (folder: string) => string;
  noAccount: string;
  writeDocs: string;
  machine: string;
  toInstall: (n: number) => string;
  allReady: string;
  checking: string;
  envFailed: string;
  worker: string;
  workerKinds: Record<WorkerKind, string>;
  workerUnknown: string;
  skills: string;
  fromHub: string;
  pickForSkills: string;
  unmatchedShort: string;
  hubFailed: string;
  docsChanged: string;
  firstRead: string;
  unchanged: string;
  tokens: string;
  cacheHits: (pct: number) => string;
  noSessions: string;
  statsFailed: string;
  digest: string;
  digestAll: string;
  digestSub: string;
  markRead: string;
  noDocs: string;
  changedFrom: (v: number) => string;
  isNew: string;
  env: string;
  fix: string;
  envOk: string;
  envOkMachine: string;
  envNoFolder: string;
  tokens7d: string;
  detail: string;
  needs: (need: string | null, have: string | null) => string;
  loading: string;
}> = {
  vi: {
    hello: (name) => `Chào ${name}`,
    helloAnon: "Chào bạn",
    linked: (project) => `đã nối với dự án ${project} trên hub`,
    unmatched: (folder) => `thư mục ${folder} chưa khớp dự án nào trên hub (so remote origin với repo của dự án)`,
    noFolder: "Chưa chọn thư mục làm việc: số liệu dưới đây tính trên cả máy.",
    metaFailed: (folder) => `Không đọc được thư mục ${folder}.`,
    noAccount: "Kết nối Hive để xem tài liệu và skill của dự án.",
    writeDocs: "Viết tài liệu",
    machine: "Máy sẵn sàng",
    toInstall: (n) => `${n} mục cần cài`,
    allReady: "đủ mọi mục bắt buộc",
    checking: "Đang kiểm tra…",
    envFailed: "Không kiểm được máy",
    worker: "Worker",
    workerKinds: {
      stopped: "Đã tắt",
      starting: "Đang bật",
      connecting: "Đang nối",
      online: "Đang chạy",
      disconnected: "Mất nối",
      stopping: "Đang tắt",
      failed: "Lỗi",
    },
    workerUnknown: "không đọc được trạng thái",
    skills: "Skill áp cho thư mục",
    fromHub: "từ hub, theo dự án",
    pickForSkills: "Chọn thư mục để xem skill của dự án",
    unmatchedShort: "thư mục chưa khớp dự án nào",
    hubFailed: "Không đọc được hub",
    docsChanged: "Tài liệu đổi từ lần trước",
    firstRead: "lần đầu mở trên máy này",
    unchanged: "không có gì mới",
    tokens: "Token tuần này",
    cacheHits: (pct) => `cache trúng ${pct}%`,
    noSessions: "chưa có phiên nào trong 7 ngày",
    statsFailed: "Không đọc được phiên trên máy",
    digest: "Tài liệu dự án",
    digestAll: "Tài liệu trên hub",
    digestSub: "Bản mới nhất trên hub",
    markRead: "Đánh dấu đã đọc",
    noDocs: "Chưa có tài liệu nào bạn đọc được.",
    changedFrom: (v) => `Đổi từ v${v}`,
    isNew: "Mới",
    env: "Máy này còn thiếu",
    fix: "Sửa",
    envOk: "Máy đủ mọi mục bắt buộc cho thư mục này.",
    envOkMachine: "Máy đủ mọi công cụ bắt buộc.",
    envNoFolder: "Mới kiểm công cụ chung của máy; chọn thư mục để kiểm thêm yêu cầu của dự án.",
    tokens7d: "Token 7 ngày",
    detail: "Chi tiết",
    needs: (need, have) => `cần ${need ?? "—"}, máy có ${have ?? "—"}`,
    loading: "Đang đọc…",
  },
  en: {
    hello: (name) => `Hi, ${name}`,
    helloAnon: "Hi there",
    linked: (project) => `linked to the ${project} project on the hub`,
    unmatched: (folder) => `${folder} does not match a hub project (origin remote vs. project repo)`,
    noFolder: "No working folder yet: the figures below cover the whole machine.",
    metaFailed: (folder) => `Could not read the folder ${folder}.`,
    noAccount: "Connect to Hive to see the project's docs and skills.",
    writeDocs: "Write docs",
    machine: "Machine ready",
    toInstall: (n) => `${n} items to install`,
    allReady: "every required item ready",
    checking: "Checking…",
    envFailed: "Could not check this machine",
    worker: "Worker",
    workerKinds: {
      stopped: "Stopped",
      starting: "Starting",
      connecting: "Connecting",
      online: "Online",
      disconnected: "Offline",
      stopping: "Stopping",
      failed: "Failed",
    },
    workerUnknown: "status unavailable",
    skills: "Skills for this folder",
    fromHub: "from the hub, by project",
    pickForSkills: "Choose a folder to see the project's skills",
    unmatchedShort: "folder matches no project",
    hubFailed: "Could not reach the hub",
    docsChanged: "Docs changed since last read",
    firstRead: "first time on this machine",
    unchanged: "nothing new",
    tokens: "Tokens this week",
    cacheHits: (pct) => `${pct}% cache hits`,
    noSessions: "no sessions in 7 days",
    statsFailed: "Could not read sessions on this machine",
    digest: "Project docs",
    digestAll: "Docs on the hub",
    digestSub: "Latest versions on the hub",
    markRead: "Mark as read",
    noDocs: "No docs you can read yet.",
    changedFrom: (v) => `Changed since v${v}`,
    isNew: "New",
    env: "Missing on this machine",
    fix: "Fix",
    envOk: "This machine has every required item for this folder.",
    envOkMachine: "This machine has every required tool.",
    envNoFolder: "Only the machine's common tools are checked; choose a folder to check the project's needs too.",
    tokens7d: "Tokens, 7 days",
    detail: "Details",
    needs: (need, have) => `needs ${need ?? "—"}, have ${have ?? "—"}`,
    loading: "Reading…",
  },
};

/** Khoá "đã đọc" khi chưa có dự án: tài liệu đọc được trên cả hub. */
const ALL_DOCS = "*";

/** Phiên bản tài liệu đã thấy lần trước, theo dự án: để đếm tài liệu đổi kể từ lần đọc trước. */
const SEEN_KEY = "hive.home.seen";
type Seen = Record<string, Record<string, number>>;
function readSeen(): Seen {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Seen;
  } catch {
    return {};
  }
}
function writeSeen(seen: Seen) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* Không nhớ được thì lần sau vẫn tính là mới. */
  }
}

/** Cộng token vào theo ngày cho 7 ngày gần nhất (ngày cũ trước). */
export function tokensByDay(stats: SessionStats, now = Date.now()): { day: string; input: number }[] {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now - (6 - i) * 86_400_000);
    return d.toISOString().slice(0, 10);
  });
  const sums = new Map(days.map((d) => [d, 0]));
  for (const s of stats.sessions) {
    const day = s.at.slice(0, 10);
    if (sums.has(day)) sums.set(day, (sums.get(day) ?? 0) + s.input);
  }
  return days.map((day) => ({ day, input: sums.get(day) ?? 0 }));
}

function Tile({
  label,
  value,
  note,
  tone,
  href,
  title,
  action,
}: {
  label: string;
  value: string;
  note: string;
  tone?: "warn" | "ok" | "bad" | undefined;
  href?: string;
  /** Lỗi đầy đủ khi `note` chỉ nói ngắn. */
  title?: string | undefined;
  /** Nút trong ô (chọn thư mục); có nút thì ô không là link để không lồng nút trong thẻ a. */
  action?: ReactNode;
}) {
  const body = (
    <>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-mono text-2xl font-semibold tracking-tight">{value}</span>
      <span
        title={title}
        className={cn(
          "text-xs",
          tone === "warn"
            ? "text-warning"
            : tone === "ok"
              ? "text-success"
              : tone === "bad"
                ? "text-destructive"
                : "text-muted-foreground",
        )}
      >
        {note}
      </span>
      {action}
    </>
  );
  const cls = "flex flex-col gap-1 rounded-xl border bg-card px-3.5 py-3 text-card-foreground no-underline";
  return href && !action ? (
    <a href={href} className={cn(cls, "hover:bg-muted/40")}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Tên máy chủ của hub cho dòng phụ của ô worker; địa chỉ lạ thì giữ nguyên. */
function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Màn Tổng quan (AppHome.dc.html) bằng dữ liệu thật: máy, worker, skill và tài liệu trên hub, token 7 ngày. Phần
 * không cần thư mục (máy, worker, token, tài liệu đọc được trên hub) hiện ngay; chỉ skill theo dự án chờ thư mục.
 */
export function HomeScreen() {
  const account = useLinkedAccount();
  const t = useT(text);
  const lang = useLang();
  const [folder] = useFolder();
  const writer = profileOf(account ?? null) === "writer";
  const worker = useWorkerState();
  // undefined: đang đọc; null: chưa chọn thư mục hoặc đọc lỗi (metaError nói lý do).
  const [meta, setMeta] = useState<WorkspaceMeta | null | undefined>(undefined);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [project, setProject] = useState<HubProject | null | undefined>(undefined);
  const [docs, setDocs] = useState<HubDoc[] | null>(null);
  const [skills, setSkills] = useState<HubSkill[] | null>(null);
  const [hubError, setHubError] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckItem[] | null>(null);
  const [checksError, setChecksError] = useState<string | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [seen, setSeen] = useState<Seen>(readSeen);

  // Chưa chọn thư mục thì Rust chỉ kiểm công cụ chung của máy.
  useEffect(() => {
    if (writer) return;
    let alive = true;
    setChecks(null);
    setChecksError(null);
    scanEnvironment(folder).then(
      (c) => alive && setChecks(c),
      (e) => alive && setChecksError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [folder, writer]);

  // Chưa chọn thư mục thì tính mọi phiên trên máy.
  useEffect(() => {
    let alive = true;
    setStats(null);
    setStatsError(null);
    sessionStats("claude", folder).then(
      (s) => alive && setStats(s),
      (e) => alive && setStatsError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [folder]);

  useEffect(() => {
    let alive = true;
    setMeta(undefined);
    setMetaError(null);
    if (!folder) {
      setMeta(null);
      return;
    }
    workspaceMeta(folder).then(
      (m) => alive && setMeta(m),
      (e) => {
        if (!alive) return;
        setMeta(null);
        setMetaError(errorText(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [folder]);

  useEffect(() => {
    if (!account || meta === undefined) return;
    let alive = true;
    setProject(undefined);
    setDocs(null);
    setSkills(null);
    setHubError(null);
    (async () => {
      try {
        let found: HubProject | null = null;
        if (meta?.remote) {
          const { projects } = await hubTool<{ projects: HubProject[] }>("project_list");
          found = matchProject(meta.remote, projects);
        }
        if (!alive) return;
        setProject(found);
        // Chưa có dự án (chưa chọn thư mục hay thư mục chưa khớp): vẫn hiện tài liệu người dùng đọc được trên hub.
        const [d, s] = await Promise.all([
          hubTool<{ docs: HubDoc[] }>("doc_list", found ? { prefix: `project/${found.key}/` } : {}),
          found ? hubTool<{ skills: HubSkill[] }>("skill_list", { project: found.key, limit: 50 }) : null,
        ]);
        if (!alive) return;
        setDocs(d.docs);
        setSkills(s?.skills ?? null);
      } catch (e) {
        if (alive) setHubError(errorText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [meta, account]);

  const seenKey = project ? project.key : ALL_DOCS;
  const projectSeen = docs ? (seen[seenKey] ?? null) : null;
  const changed = docs?.filter((d) => !projectSeen || (projectSeen[d.key] ?? 0) < d.version) ?? [];
  const env = checks ? readiness(checks) : null;
  const todo = checks?.filter(needsAction) ?? [];
  const days = stats ? tokensByDay(stats) : [];
  const maxDay = Math.max(1, ...days.map((d) => d.input));
  const rate = stats ? cacheRate(stats.totals.input, stats.totals.cached) : null;
  // Ô cần hub mà chưa có số thì nói lý do ngắn, không để "Đang đọc…" mãi.
  const hubNote = !account ? t.noAccount : hubError ? t.hubFailed : null;

  function markRead() {
    if (!docs) return;
    const next = { ...seen, [seenKey]: Object.fromEntries(docs.map((d) => [d.key, d.version])) };
    writeSeen(next);
    setSeen(next);
  }

  const sub = !folder
    ? t.noFolder
    : metaError
      ? t.metaFailed(folderName(folder))
      : project
        ? t.linked(project.name)
        : project === null
          ? t.unmatched(folderName(folder))
          : !account
            ? t.noAccount
            : (hubError ?? t.loading);

  return (
    <div className="flex flex-col gap-3.5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-heading text-xl font-semibold tracking-tight">
            {account?.name ? t.hello(account.name) : t.helloAnon}
          </h2>
          <p className={cn("text-sm", hubError || metaError ? "text-destructive" : "text-muted-foreground")}>
            {sub}
            {meta?.branch && <span className="font-mono"> · {meta.branch}</span>}
          </p>
        </div>
        <Button nativeButton={false} role="link" render={<a href="#/docs" />} variant="default" size="sm">
          {t.writeDocs}
        </Button>
      </header>

      <section
        className={cn(
          "grid grid-cols-2 gap-3",
          writer ? "min-[1000px]:grid-cols-3" : "min-[760px]:grid-cols-3 min-[1000px]:grid-cols-5",
        )}
      >
        {!writer && (
          <Tile
            label={t.machine}
            value={env ? `${env.ready}/${env.required}` : "—"}
            note={checksError ? t.envFailed : env ? (todo.length ? t.toInstall(todo.length) : t.allReady) : t.checking}
            title={checksError ?? undefined}
            tone={todo.length ? "warn" : env ? "ok" : undefined}
            href="#/setup"
          />
        )}
        {!writer && (
          <Tile
            label={t.worker}
            value={worker ? t.workerKinds[worker.kind] : "—"}
            note={worker ? (worker.detail ?? hostOf(worker.hub)) : t.workerUnknown}
            tone={
              worker?.kind === "online"
                ? "ok"
                : worker?.kind === "failed" || worker?.kind === "disconnected"
                  ? "warn"
                  : undefined
            }
            href="#/runs"
          />
        )}
        <Tile
          label={t.skills}
          value={skills ? String(skills.length) : "—"}
          note={
            !folder
              ? t.pickForSkills
              : metaError
                ? t.metaFailed(folderName(folder))
                : (hubNote ?? (project === null ? t.unmatchedShort : skills ? t.fromHub : t.loading))
          }
          title={hubError ?? undefined}
          href="#/skills"
          action={!folder && <PickFolderButton className="mt-1" />}
        />
        <Tile
          label={t.docsChanged}
          value={docs ? String(changed.length) : "—"}
          note={
            hubNote ??
            (docs
              ? projectSeen
                ? changed.length
                  ? `${docs.length} · ${t.digestSub}`
                  : t.unchanged
                : t.firstRead
              : t.loading)
          }
          title={hubError ?? undefined}
          tone={changed.length && projectSeen ? "warn" : undefined}
        />
        <Tile
          label={t.tokens}
          value={stats ? formatTokens(stats.totals.input, lang) : "—"}
          note={statsError ? t.statsFailed : !stats ? t.loading : rate === null ? t.noSessions : t.cacheHits(rate)}
          title={statsError ?? undefined}
          tone={rate !== null && rate >= 60 ? "ok" : undefined}
          href="#/tokens"
        />
      </section>

      <div className="flex flex-col items-start gap-3.5 min-[1000px]:flex-row">
        <section className="w-full min-w-0 overflow-hidden rounded-xl border bg-card min-[1000px]:flex-[3]">
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <div>
              <h3 className="text-[15px] font-semibold">{project ? t.digest : t.digestAll}</h3>
              <p className="text-xs text-muted-foreground">{t.digestSub}</p>
            </div>
            {docs && docs.length > 0 && (
              <Button variant="outline" size="sm" onClick={markRead} disabled={!changed.length && !!projectSeen}>
                {t.markRead}
              </Button>
            )}
          </div>
          {!account ? (
            <ConnectHive inline note={t.noAccount} />
          ) : docs === null ? (
            <p className={cn("px-4 py-3 text-sm", hubError ? "text-destructive" : "text-muted-foreground")}>
              {hubError ?? t.loading}
            </p>
          ) : docs.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">{t.noDocs}</p>
          ) : (
            <ul>
              {docs.map((d) => {
                const prev = projectSeen?.[d.key];
                const isChanged = !projectSeen || (prev ?? 0) < d.version;
                return (
                  <li key={d.key} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{d.title}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">{d.key}</span>
                    </span>
                    {isChanged && projectSeen && <Pill tone="warn">{prev ? t.changedFrom(prev) : t.isNew}</Pill>}
                    <span className="font-mono text-xs text-muted-foreground">v{d.version}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="flex w-full min-w-0 flex-col gap-3.5 min-[1000px]:flex-[2]">
          {!writer && (
            <section className="overflow-hidden rounded-xl border bg-card">
              <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
                <h3 className="text-[15px] font-semibold">{t.env}</h3>
                <a href="#/setup" className="text-xs text-primary">
                  {t.fix}
                </a>
              </div>
              {checksError ? (
                <p className="px-4 py-3 text-sm text-destructive">{checksError}</p>
              ) : checks === null ? (
                <p className="px-4 py-3 text-sm text-muted-foreground">{t.checking}</p>
              ) : todo.length === 0 ? (
                <p className="px-4 py-3 text-sm text-success">{folder ? t.envOk : t.envOkMachine}</p>
              ) : (
                <ul>
                  {todo.slice(0, 3).map((c) => (
                    <li key={c.id} className="flex items-center gap-2.5 border-b px-4 py-2 text-sm last:border-b-0">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          c.status === "missing" ? "bg-destructive" : "bg-warning",
                        )}
                      />
                      <span className="flex-1">{c.name}</span>
                      <span className="text-xs text-muted-foreground">{t.needs(c.need, c.have)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {!folder && checks && <p className="border-t px-4 py-2 text-xs text-muted-foreground">{t.envNoFolder}</p>}
            </section>
          )}
          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
              <h3 className="text-[15px] font-semibold">{t.tokens7d}</h3>
              <a href="#/tokens" className="text-xs text-primary">
                {t.detail}
              </a>
            </div>
            {statsError ? (
              <p className="px-4 py-3 text-sm text-muted-foreground" title={statsError}>
                {t.statsFailed}
              </p>
            ) : (
              <>
                <div className="flex h-28 items-end gap-1.5 px-4 pt-3 pb-1" role="img" aria-label={t.tokens7d}>
                  {days.map((d) => (
                    <span key={d.day} className="flex flex-1 flex-col items-center gap-1">
                      <span
                        className="w-full rounded-t bg-primary/80"
                        style={{ height: `${Math.max(2, (d.input / maxDay) * 80)}px` }}
                        title={`${d.day} · ${formatTokens(d.input, lang)}`}
                      />
                    </span>
                  ))}
                </div>
                <div className="flex gap-1.5 px-4 pb-3">
                  {days.map((d) => (
                    <span key={d.day} className="flex-1 text-center font-mono text-xs text-muted-foreground">
                      {new Date(`${d.day}T12:00:00Z`).toLocaleDateString(lang, { weekday: "short" })}
                    </span>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
