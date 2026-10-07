import { ResponsiveTableFrame } from "#ui/components/ResponsiveTable.tsx";
// Trang Hub and Context agent (docs/design/2026-09-redesign, xDev Hive Web Admin; roadmap 22n): what the hub is and how
// it is doing (a backup on request), and what a project's agents get from Hive (the AGENTS.md a sync writes).
import { useEffect, useState, type ReactNode } from "react";
import { readSyncOutcome, type CommandStatus, type MachineCommand } from "@xdev-hive/core";
import { cn } from "cn";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { ErrorNote } from "#ui/components/common.tsx";
import { errorMessage, formatTime, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { fileSize } from "#ui/lib/chat.ts";
import { contextProjects } from "#ui/lib/permission-controls.ts";
import { scopeProject } from "#ui/lib/scope.ts";
import { useToast } from "#ui/shell/toast.tsx";

type Tone = "ok" | "warn" | "run" | "neutral";
const STATE: Record<Tone, string> = {
  ok: "bg-success-soft text-success",
  warn: "bg-warning-soft text-warning",
  run: "bg-running-soft text-running",
  neutral: "bg-sunken text-fg-secondary",
};

function HubCard({
  title,
  state,
  tone,
  value,
  detail,
  action,
}: {
  title: string;
  state: string;
  tone: Tone;
  value: ReactNode;
  detail: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5 rounded-[14px] border border-line-default bg-surface p-4">
      <div className="flex items-center gap-2">
        <span className="text-xs text-fg-muted">{title}</span>
        <span className={cn("ml-auto rounded-xs px-1.5 py-0.5 text-[11px] font-semibold", STATE[tone])}>{state}</span>
      </div>
      <span className="truncate font-mono text-lg font-semibold text-fg-strong">{value}</span>
      <span className="text-xs/[18px] text-fg-muted [overflow-wrap:anywhere]">{detail}</span>
      {action ? <div className="mt-1">{action}</div> : null}
    </section>
  );
}

const uptime = (s: number) => {
  const d = Math.floor(s / 86400);
  const h = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return `${d ? `${d}d ` : ""}${h}:${m}`;
};

/** Trang Hub: version, database, backup (Backup ngay), meaning search, SSO, hosts. */
export function OpsHub() {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const info = useQuery(async () => (client.hub ? client.hub.info() : null), [client, tick]);
  const [busy, setBusy] = useState(false);
  if (!client.hub) return null;
  const h = info.data;
  const backupLate = h?.backup?.last ? Date.now() - Date.parse(h.backup.last) > (h.backup.hours + 2) * 3_600_000 : Boolean(h?.backup);
  const backupNow = () => {
    setBusy(true);
    void client
      .hub!.backup()
      .then(
        (r) => (toast(t("hub.backedUp", { file: r.file })), setTick((n) => n + 1)),
        (err: unknown) => toast(errorMessage(err), { tone: "error" }),
      )
      .finally(() => setBusy(false));
  };
  const cleanup = () => {
    setBusy(true);
    void client
      .hub!.cleanup()
      .then(
        (r) => {
          const freed = (r.releases?.bytes ?? 0) + r.artifacts.bytes + Math.max(0, r.db.before - r.db.after);
          toast(t("hub.cleaned", { size: fileSize(freed), builds: r.releases?.versions.length ?? 0, artifacts: r.artifacts.removed }));
          setTick((n) => n + 1);
        },
        (err: unknown) => toast(errorMessage(err), { tone: "error" }),
      )
      .finally(() => setBusy(false));
  };
  const s = h?.storage;
  return (
    <ResponsiveTableFrame className="flex flex-col gap-3">
      <ErrorNote error={info.error} />
      {h ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-2.5">
          <HubCard
            title={t("hub.version")}
            state={t("hub.ok")}
            tone="ok"
            value={`hub ${h.version}${h.commit ? ` · ${h.commit}` : ""}`}
            detail={t("hub.versionDetail", {
              where: h.container ? t("hub.container") : t("hub.process"),
              node: h.node,
              uptime: uptime(h.uptimeSeconds),
              since: formatTime(h.startedAt),
            })}
          />
          <HubCard
            title={t("hub.database")}
            state={t("hub.ok")}
            tone="ok"
            value={`${h.db.path.split("/").pop()} · ${fileSize(h.db.bytes + h.db.walBytes)}`}
            detail={t("hub.dbDetail", { path: h.db.path, ...h.db.counts })}
          />
          <HubCard
            title={t("hub.files")}
            state={!h.files.store ? t("hub.inDb") : h.files.lastError ? t("hub.error") : h.files.inDb ? t("hub.moving") : t("hub.ok")}
            tone={!h.files.store ? "neutral" : h.files.lastError ? "warn" : h.files.inDb ? "run" : "ok"}
            value={`${h.files.store ?? "SQLite"} · ${t("hub.filesCount", { count: h.files.count })} · ${fileSize(h.files.bytes)}`}
            detail={
              !h.files.store
                ? t("hub.filesOffHint")
                : [h.files.where, h.files.lastError, h.files.inDb ? t("hub.filesInDb", { count: h.files.inDb }) : null].filter(Boolean).join(" · ")
            }
          />
          <HubCard
            title={t("hub.backup")}
            state={h.backup ? (backupLate ? t("hub.late") : t("hub.ok")) : t("hub.off")}
            tone={h.backup ? (backupLate ? "warn" : "ok") : "neutral"}
            value={h.backup ? (h.backup.last ? formatTime(h.backup.last) : t("hub.noBackupYet")) : t("hub.off")}
            detail={
              h.backup
                ? t("hub.backupDetail", { hours: h.backup.hours, keep: h.backup.keep, dir: h.backup.dir, count: h.backup.count })
                : t("hub.backupOffHint")
            }
            action={
              h.backup ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={backupNow}>
                  {busy ? t("hub.backingUp") : t("hub.backupNow")}
                </Button>
              ) : undefined
            }
          />
          {s ? (
            <HubCard
              title={t("hub.storage")}
              state={t("hub.ok")}
              tone="ok"
              value={fileSize((s.releases?.bytes ?? 0) + s.artifacts.bytes + h.db.bytes + h.db.walBytes)}
              detail={[
                s.releases ? t("hub.storageBuilds", { count: s.releases.versions, size: fileSize(s.releases.bytes), keep: s.releases.keep }) : null,
                t("hub.storageArtifacts", { count: s.artifacts.count, size: fileSize(s.artifacts.bytes), days: s.artifacts.days }),
                t("hub.storageLogs", { days: s.runLogDays }),
              ].filter(Boolean).join(" · ")}
              action={
                <Button size="sm" variant="outline" disabled={busy} onClick={cleanup} data-hub-cleanup>
                  {busy ? t("hub.cleaning") : t("hub.cleanup")}
                </Button>
              }
            />
          ) : null}
          <HubCard
            title={t("hub.search")}
            state={
              h.search.mode === "keyword"
                ? t("hub.keywordOnly")
                : h.search.lastError
                  ? t("hub.error")
                  : h.search.indexed < h.search.total
                    ? t("hub.indexing")
                    : t("hub.ok")
            }
            tone={h.search.mode === "keyword" ? "neutral" : h.search.lastError ? "warn" : h.search.indexed < h.search.total ? "run" : "ok"}
            value={h.search.model ? `${h.search.model} · ${h.search.indexed}/${h.search.total}` : t("hub.keywordOnly")}
            detail={
              h.search.mode === "keyword"
                ? t("hub.searchOffHint")
                : [h.search.url, h.search.lastError, t("hub.waitingVectors", { count: h.search.total - h.search.indexed })].filter(Boolean).join(" · ")
            }
          />
          <HubCard
            title={t("hub.sso")}
            state={h.sso ? t("hub.on") : t("hub.off")}
            tone={h.sso ? "ok" : "neutral"}
            value={h.sso?.name ?? t("hub.passwordOnly")}
            detail={h.sso ? t("hub.ssoDetail", { issuer: h.sso.issuer, count: h.sso.linked }) : t("hub.ssoOffHint")}
          />
          <HubCard
            title={t("hub.hosts")}
            state={t("hub.config")}
            tone="neutral"
            value={h.hosts.allowed?.join(", ") ?? t("hub.anyHost")}
            detail={[h.hosts.publicUrl, h.hosts.trustProxy ? "HIVE_TRUST_PROXY=1" : null].filter(Boolean).join(" · ") || "—"}
          />
        </div>
      ) : null}
    </ResponsiveTableFrame>
  );
}

const SYNC_TONE: Record<CommandStatus, Tone> = {
  pending: "run",
  running: "run",
  done: "ok",
  failed: "warn",
  rejected: "neutral",
  cancelled: "neutral",
  expired: "warn",
};

/** What a machine's last sync did, in one line: files changed, commit, pages mirrored; or why it did not. */
function syncDetail(c: MachineCommand, t: ReturnType<typeof useT>): string {
  if (c.status === "expired") return t("context.sync.expiredHint");
  const o = readSyncOutcome(c.output);
  if (!o) return c.status === "failed" ? (c.output ?? "") : "";
  return [
    o.changed.length ? t("context.sync.changed", { count: o.changed.length }) : t("context.sync.unchanged"),
    o.skipped.length ? t("context.sync.skipped", { count: o.skipped.length }) : null,
    o.commit ? t("context.sync.commit", { commit: o.commit }) : o.changed.length ? t("context.sync.noCommit") : null,
    // The machine put the docs in a merge request instead of its checkout (roadmap 38c): the link is what to read next.
    o.mr ? t("context.sync.mr", { url: o.mr }) : null,
    o.mirrored !== null ? t("context.sync.mirrored", { count: o.mirrored }) : null,
    o.note,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Sync on the machines (roadmap 22n): ask every online machine with the project's repo, and how each last went. */
function SyncCard({ project, className }: { project: string; className: string }) {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const can = useCan();
  const state = useQuery(() => client.call("docs.syncStatus", { project }), [client, project]);
  const [busy, setBusy] = useState(false);
  const open = (state.data ?? []).some((m) => m.last?.status === "pending" || m.last?.status === "running");
  const { reload } = state;
  // Machines answer within a heartbeat or two: look again soon while a request is open, now and then otherwise.
  useEffect(() => {
    const id = setInterval(reload, open ? 5_000 : 30_000);
    return () => clearInterval(id);
  }, [reload, open]);
  const request = () => {
    setBusy(true);
    void client
      .call("docs.syncRequest", { project })
      .then(
        (sent) => (toast(sent.length ? t("context.sync.requested", { count: sent.length }) : t("context.sync.noneOnline"), sent.length ? {} : { tone: "error" }), reload()),
        (err: unknown) => toast(errorMessage(err), { tone: "error" }),
      )
      .finally(() => setBusy(false));
  };
  const list = state.data ?? [];
  return (
    <section className={className}>
      <div className="flex items-center gap-2">
        <h2 className="m-0 text-sm font-semibold text-fg-strong">{t("context.sync.title")}</h2>
        {can(project, "contextEdit") ? (
          <Button size="sm" variant="outline" className="ml-auto" disabled={busy || !list.some((m) => m.online)} onClick={request}>
            {busy ? t("context.sync.requesting") : t("context.sync.request")}
          </Button>
        ) : null}
      </div>
      <span className="text-[11px] text-fg-muted">{t("context.sync.hint")}</span>
      <ErrorNote error={state.error} />
      {state.data && !list.length ? <span className="text-xs text-fg-muted">{t("context.sync.noMachines")}</span> : null}
      {list.map((m) => (
        <div key={m.machineId} className="flex flex-col gap-0.5 border-b border-line-subtle py-1.5 last:border-b-0">
          <span className="flex items-center gap-2 text-[13px]">
            <span className={cn("size-1.5 shrink-0 rounded-full", m.online ? "bg-success-solid" : "bg-fg-muted")} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-strong" title={m.machineId}>
              {m.machine}
              {m.online ? "" : ` · ${t("context.sync.offline")}`}
            </span>
            {m.last ? (
              <span className={cn("rounded-xs px-1.5 py-0.5 text-[11px] font-semibold", STATE[SYNC_TONE[m.last.status]])}>
                {t(`context.sync.status.${m.last.status}`)}
              </span>
            ) : (
              <span className="text-[11px] text-fg-muted">{t("context.sync.never")}</span>
            )}
          </span>
          {m.last ? (
            <span className="text-[11px] text-fg-muted [overflow-wrap:anywhere]">
              {[t("context.sync.by", { who: m.last.requestedBy, time: formatTime(m.last.updatedAt) }), syncDetail(m.last, t)].filter(Boolean).join(" · ")}
            </span>
          ) : null}
        </div>
      ))}
    </section>
  );
}

/** Context agent: a project's AGENTS.md as a sync writes it, what it is made of, the files, the memory. */
export function OpsContext() {
  const { client, projects, me, scope } = useHive();
  const t = useT();
  const [picked, setPicked] = useState<string | null>(null);
  const editableProjects = contextProjects(me, projects);
  const selected = scopeProject(scope);
  const project = picked && editableProjects.includes(picked) ? picked : selected && editableProjects.includes(selected) ? selected : (editableProjects[0] ?? null);
  const ctx = useQuery(async () => (project ? client.call("docs.context", { project }) : null), [client, project]);
  const [full, setFull] = useState(false);
  const c = ctx.data;
  const over = c ? c.lines > c.limit : false;
  const card = "flex min-w-0 flex-col gap-2.5 rounded-[14px] border border-line-default bg-surface p-4";
  return (
    <div className="flex flex-col gap-3">
      <label className="flex h-9 items-center gap-2 self-start rounded-[9px] border border-line-default bg-surface pr-1.5 pl-3 text-xs text-fg-muted">
        {t("context.project")}
        <NativeSelect
          size="sm"
          className="border-0 font-mono"
          value={project ?? ""}
          onChange={(e) => (setPicked(e.target.value), setFull(false))}
          aria-label={t("context.project")}
        >
          {editableProjects.map((p) => (
            <NativeSelectOption key={p} value={p}>
              {p}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <ErrorNote error={ctx.error} />
      {!editableProjects.length ? <p className="m-0 text-[13px] text-fg-muted">{t("context.noProjects")}</p> : null}
      {c ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-start gap-3">
          <section className={card}>
            <div className="flex items-baseline gap-2">
              <h2 className="m-0 text-sm font-semibold text-fg-strong">AGENTS.md</h2>
              <span className={cn("ml-auto font-mono text-xs", over ? "text-warning" : "text-fg-muted")}>
                {t("context.lines", { lines: c.lines, limit: c.limit })}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-sunken">
              <div
                className={cn("h-full rounded-full", over ? "bg-warning-solid" : "bg-success-solid")}
                style={{ width: `${Math.min(100, (c.lines / c.limit) * 100)}%` }}
              />
            </div>
            <span className="text-xs text-fg-muted">{over ? t("context.over") : t("context.under")}</span>
            {c.blocks.map((b) => (
              <div key={b.kind} className="flex flex-col gap-1">
                <span className="pt-1 type-caption text-fg-muted">{t(`context.block.${b.kind}`)}</span>
                {b.items.length === 0 ? <span className="text-xs text-fg-muted">{t("context.none")}</span> : null}
                {b.items.map((i, n) => (
                  <div key={i.key ?? n} className="flex items-center gap-2 border-b border-line-subtle py-1.5 text-[13px] last:border-b-0">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-strong" title={i.key ?? undefined}>
                      {b.kind === "paths"
                        ? t("context.pathsCount", { count: Number(i.title) })
                        : b.kind === "skills"
                          ? t("context.skillsCount", { count: Number(i.title) })
                          : (i.key ?? i.title)}
                    </span>
                    {i.version ? (
                      <span className="font-mono text-[11px] text-fg-muted">v{i.version}</span>
                    ) : b.kind === "project" ? (
                      <span className="text-[11px] text-warning">{t("context.noProjectDoc")}</span>
                    ) : null}
                    <span className="w-16 text-right font-mono text-[11px] text-fg-muted">{t("context.lineCount", { count: i.lines })}</span>
                  </div>
                ))}
              </div>
            ))}
            <div className="flex gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={() => setFull((v) => !v)} aria-expanded={full}>
                {full ? t("context.hideFull") : t("context.showFull")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(c.agentsMd)}>
                {t("context.copy")}
              </Button>
            </div>
            {full ? (
              <pre className="m-0 max-h-[480px] overflow-auto rounded-md border border-line-subtle bg-code p-3 font-mono text-[11px]/[17px] whitespace-pre-wrap text-code-fg">
                {c.agentsMd}
              </pre>
            ) : null}
          </section>
          <div className="flex flex-col gap-3">
            <section className={card}>
              <h2 className="m-0 text-sm font-semibold text-fg-strong">{t("context.paths")}</h2>
              {!c.paths.length ? <span className="text-xs text-fg-muted">{t("context.noPaths")}</span> : null}
              {c.paths.map((p) => (
                <div key={`${p.key}-${p.file}`} className="flex flex-col gap-0.5 border-b border-line-subtle py-1.5 last:border-b-0">
                  <span className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
                    <span className="text-fg-brand">{p.globs.join(", ")}</span>
                    <span className="text-fg-muted">→</span>
                    <span className="text-fg-strong">{p.file}</span>
                  </span>
                  <span className="text-[11px] text-fg-muted">
                    {p.title} · {t(p.nested ? "context.readNested" : "context.readRule")}
                  </span>
                </div>
              ))}
            </section>
            <section className={card}>
              <h2 className="m-0 text-sm font-semibold text-fg-strong">{t("context.files")}</h2>
              <div className="flex flex-wrap gap-1.5">
                {c.files.map((f) => (
                  <span
                    key={f.path}
                    title={t("context.lineCount", { count: f.lines })}
                    className="rounded-xs border border-line-subtle bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-fg-secondary"
                  >
                    {f.path === "CLAUDE.md" ? "CLAUDE.md → @AGENTS.md" : f.path}
                    {f.block ? ` (${t("context.blockOnly")})` : ""}
                  </span>
                ))}
              </div>
              <span className="text-xs text-fg-muted">
                {t("context.memory", { project: c.memory.project, shared: c.memory.shared, stale: c.memory.stale, pending: c.memory.pending })}
              </span>
              <span className="text-[11px] text-fg-muted">{t("context.syncHint")}</span>
            </section>
            {client.hub ? <SyncCard project={project!} className={card} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
