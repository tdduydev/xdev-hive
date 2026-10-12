import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { useEffect, useState } from "react";
import { profileOf, useLinkedAccount } from "@/lib/account.ts";
import { folderName, useFolder } from "@/lib/folder.ts";
import { type HubDoc, type HubProject, type HubSkill, hubTool, matchProject } from "@/lib/hub.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { type CheckItem, needsAction, readiness, scanEnvironment } from "@/lib/setup.ts";
import { errorText, type WorkspaceMeta, workspaceMeta } from "@/lib/tauri.ts";
import { cacheRate, formatTokens, type SessionStats, sessionStats } from "@/lib/usage.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{
  hello: (name: string) => string;
  helloAnon: string;
  linked: (project: string) => string;
  unmatched: (folder: string) => string;
  noFolder: string;
  noAccount: string;
  writeDocs: string;
  machine: string;
  toInstall: (n: number) => string;
  allReady: string;
  skills: string;
  fromHub: string;
  docsChanged: string;
  firstRead: string;
  unchanged: string;
  tokens: string;
  cacheHits: (pct: number) => string;
  digest: string;
  digestSub: string;
  markRead: string;
  noDocs: string;
  changedFrom: (v: number) => string;
  isNew: string;
  env: string;
  fix: string;
  envOk: string;
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
    noFolder: "Chọn thư mục làm việc ở góc trên bên trái để bắt đầu.",
    noAccount: "Liên kết tài khoản để xem tài liệu và skill của dự án.",
    writeDocs: "Viết tài liệu",
    machine: "Máy sẵn sàng",
    toInstall: (n) => `${n} mục cần cài`,
    allReady: "đủ mọi mục bắt buộc",
    skills: "Skill áp cho thư mục",
    fromHub: "từ hub, theo dự án",
    docsChanged: "Tài liệu đổi từ lần trước",
    firstRead: "lần đầu mở trên máy này",
    unchanged: "không có gì mới",
    tokens: "Token tuần này",
    cacheHits: (pct) => `cache trúng ${pct}%`,
    digest: "Tài liệu dự án",
    digestSub: "Bản mới nhất trên hub",
    markRead: "Đánh dấu đã đọc",
    noDocs: "Dự án chưa có tài liệu nào bạn đọc được.",
    changedFrom: (v) => `Đổi từ v${v}`,
    isNew: "Mới",
    env: "Máy này còn thiếu",
    fix: "Sửa",
    envOk: "Máy đủ mọi mục bắt buộc cho thư mục này.",
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
    noFolder: "Choose a working folder at the top left to start.",
    noAccount: "Link your account to see the project's docs and skills.",
    writeDocs: "Write docs",
    machine: "Machine ready",
    toInstall: (n) => `${n} items to install`,
    allReady: "every required item ready",
    skills: "Skills for this folder",
    fromHub: "from the hub, by project",
    docsChanged: "Docs changed since last read",
    firstRead: "first time on this machine",
    unchanged: "nothing new",
    tokens: "Tokens this week",
    cacheHits: (pct) => `${pct}% cache hits`,
    digest: "Project docs",
    digestSub: "Latest versions on the hub",
    markRead: "Mark as read",
    noDocs: "The project has no docs you can read yet.",
    changedFrom: (v) => `Changed since v${v}`,
    isNew: "New",
    env: "Missing on this machine",
    fix: "Fix",
    envOk: "This machine has every required item for this folder.",
    tokens7d: "Tokens, 7 days",
    detail: "Details",
    needs: (need, have) => `needs ${need ?? "—"}, have ${have ?? "—"}`,
    loading: "Reading…",
  },
};

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
}: {
  label: string;
  value: string;
  note: string;
  tone?: "warn" | "ok" | undefined;
  href?: string;
}) {
  const body = (
    <>
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      <span className="font-mono text-2xl font-semibold tracking-tight">{value}</span>
      <span
        className={cn(
          "text-xs",
          tone === "warn" ? "text-warning" : tone === "ok" ? "text-success" : "text-muted-foreground",
        )}
      >
        {note}
      </span>
    </>
  );
  const cls = "flex flex-col gap-1 rounded-xl border bg-card px-3.5 py-3 text-card-foreground no-underline";
  return href ? (
    <a href={href} className={cn(cls, "hover:bg-muted/40")}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Màn Tổng quan (AppHome.dc.html) bằng dữ liệu thật: máy, skill và tài liệu của dự án trên hub, token 7 ngày. */
export function HomeScreen() {
  const account = useLinkedAccount();
  const t = useT(text);
  const lang = useLang();
  const [folder] = useFolder();
  const writer = profileOf(account ?? null) === "writer";
  const [meta, setMeta] = useState<WorkspaceMeta | null>(null);
  const [project, setProject] = useState<HubProject | null | undefined>(undefined);
  const [docs, setDocs] = useState<HubDoc[] | null>(null);
  const [skills, setSkills] = useState<HubSkill[] | null>(null);
  const [hubError, setHubError] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckItem[] | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [seen, setSeen] = useState<Seen>(readSeen);

  useEffect(() => {
    let alive = true;
    setMeta(null);
    setProject(undefined);
    setDocs(null);
    setSkills(null);
    setHubError(null);
    if (!folder) return;
    workspaceMeta(folder).then(
      (m) => alive && setMeta(m),
      () => {},
    );
    if (!writer)
      scanEnvironment(folder).then(
        (c) => alive && setChecks(c),
        () => {},
      );
    sessionStats("claude", folder).then(
      (s) => alive && setStats(s),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [folder, writer]);

  useEffect(() => {
    if (!meta || !account) return;
    let alive = true;
    (async () => {
      try {
        const { projects } = await hubTool<{ projects: HubProject[] }>("project_list");
        const found = matchProject(meta.remote, projects);
        if (!alive) return;
        setProject(found);
        if (!found) return;
        const [d, s] = await Promise.all([
          hubTool<{ docs: HubDoc[] }>("doc_list", { project: found.key }),
          hubTool<{ skills: HubSkill[] }>("skill_list", { project: found.key, limit: 50 }),
        ]);
        if (!alive) return;
        setDocs(d.docs);
        setSkills(s.skills);
      } catch (e) {
        if (alive) setHubError(errorText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [meta, account]);

  const projectSeen = project ? (seen[project.key] ?? null) : null;
  const changed = docs?.filter((d) => !projectSeen || (projectSeen[d.key] ?? 0) < d.version) ?? [];
  const env = checks ? readiness(checks) : null;
  const todo = checks?.filter(needsAction) ?? [];
  const days = stats ? tokensByDay(stats) : [];
  const maxDay = Math.max(1, ...days.map((d) => d.input));
  const rate = stats ? cacheRate(stats.totals.input, stats.totals.cached) : null;

  function markRead() {
    if (!project || !docs) return;
    const next = { ...seen, [project.key]: Object.fromEntries(docs.map((d) => [d.key, d.version])) };
    writeSeen(next);
    setSeen(next);
  }

  const sub = !folder
    ? t.noFolder
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
          <p className={cn("text-[13px]", hubError ? "text-destructive" : "text-muted-foreground")}>
            {sub}
            {meta?.branch && <span className="font-mono"> · {meta.branch}</span>}
          </p>
        </div>
        <Button render={<a href="#/docs" />} variant="default" size="sm">
          {t.writeDocs}
        </Button>
      </header>

      <section className="grid grid-cols-2 gap-3 min-[1000px]:grid-cols-4">
        {!writer && (
          <Tile
            label={t.machine}
            value={env ? `${env.ready}/${env.required}` : "—"}
            note={env ? (todo.length ? t.toInstall(todo.length) : t.allReady) : t.loading}
            tone={todo.length ? "warn" : env ? "ok" : undefined}
            href="#/setup"
          />
        )}
        <Tile
          label={t.skills}
          value={skills ? String(skills.length) : "—"}
          note={account ? t.fromHub : t.noAccount}
          href="#/skills"
        />
        <Tile
          label={t.docsChanged}
          value={docs ? String(changed.length) : "—"}
          note={
            docs
              ? projectSeen
                ? changed.length
                  ? `${docs.length} · ${t.digestSub}`
                  : t.unchanged
                : t.firstRead
              : t.loading
          }
          tone={changed.length && projectSeen ? "warn" : undefined}
        />
        <Tile
          label={t.tokens}
          value={stats ? formatTokens(stats.totals.input, lang) : "—"}
          note={rate === null ? t.loading : t.cacheHits(rate)}
          tone={rate !== null && rate >= 60 ? "ok" : undefined}
          href="#/tokens"
        />
      </section>

      <div className="flex flex-col items-start gap-3.5 min-[1000px]:flex-row">
        <section className="w-full min-w-0 overflow-hidden rounded-xl border bg-card min-[1000px]:flex-[3]">
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <div>
              <h3 className="text-[14.5px] font-semibold">{t.digest}</h3>
              <p className="text-xs text-muted-foreground">{t.digestSub}</p>
            </div>
            {docs && docs.length > 0 && (
              <Button variant="outline" size="sm" onClick={markRead} disabled={!changed.length && !!projectSeen}>
                {t.markRead}
              </Button>
            )}
          </div>
          {docs === null ? (
            <p className="px-4 py-3 text-[13px] text-muted-foreground">
              {project === undefined && account && folder ? t.loading : sub}
            </p>
          ) : docs.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted-foreground">{t.noDocs}</p>
          ) : (
            <ul>
              {docs.map((d) => {
                const prev = projectSeen?.[d.key];
                const isChanged = !projectSeen || (prev ?? 0) < d.version;
                return (
                  <li key={d.key} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13.5px] font-medium">{d.title}</span>
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
                <h3 className="text-[14.5px] font-semibold">{t.env}</h3>
                <a href="#/setup" className="text-xs text-primary">
                  {t.fix}
                </a>
              </div>
              {checks === null ? (
                <p className="px-4 py-3 text-[13px] text-muted-foreground">{folder ? t.loading : t.noFolder}</p>
              ) : todo.length === 0 ? (
                <p className="px-4 py-3 text-[13px] text-success">{t.envOk}</p>
              ) : (
                <ul>
                  {todo.slice(0, 3).map((c) => (
                    <li key={c.id} className="flex items-center gap-2.5 border-b px-4 py-2 text-[13px] last:border-b-0">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          c.status === "missing" ? "bg-destructive" : "bg-warning",
                        )}
                      />
                      <span className="flex-1">{c.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">{t.needs(c.need, c.have)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
              <h3 className="text-[14.5px] font-semibold">{t.tokens7d}</h3>
              <a href="#/tokens" className="text-xs text-primary">
                {t.detail}
              </a>
            </div>
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
                <span key={d.day} className="flex-1 text-center font-mono text-[10.5px] text-muted-foreground">
                  {new Date(`${d.day}T12:00:00Z`).toLocaleDateString(lang, { weekday: "short" })}
                </span>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
