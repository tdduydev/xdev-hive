import { useState } from "react";
import { cleanupReason, worktreeCleanupSchema, type Machine, type WorktreeCleanup, type WorktreeEntry } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { TableBody, TableCell, TableHead, TableHeader } from "@xdev-hive/ui/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@xdev-hive/ui/components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle, AlertDialogFooter, AlertDialogCancel } from "@xdev-hive/ui/components/ui/alert-dialog";
import { ResponsiveTable, ResponsiveTableRow } from "#ui/components/ResponsiveTable.tsx";
import { ErrorNote, Notice } from "#ui/components/common.tsx";
import { formatTime, useAction, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

export function WorktreeManager({ machine }: { machine?: Machine }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="outline" size="sm" className="min-h-11 md:min-h-7" data-worktrees={machine?.machine ?? "local"}>{t("worktrees.title")}</Button></DialogTrigger>
    <DialogContent className="max-h-[90dvh] min-w-0 overflow-y-auto sm:max-w-5xl" data-worktree-panel>
      <DialogHeader><DialogTitle>{machine ? `${machine.machine} · ` : ""}{t("worktrees.title")}</DialogTitle><DialogDescription>{t("worktrees.hint")}</DialogDescription></DialogHeader>
      {open ? <WorktreePanel machine={machine} /> : null}
    </DialogContent>
  </Dialog>;
}

const size = (bytes: number | null) => bytes === null ? "—" : bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KiB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
const CONTROL = "min-h-11 md:min-h-7";

function WorktreePanel({ machine }: { machine?: Machine }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const [tick, setTick] = useState(0);
  const poll = usePoll(machine ? 5000 : null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<WorktreeEntry[]>([]);
  const [ack, setAck] = useState(false);
  const [notice, setNotice] = useState("");
  const query = useQuery(async () => machine ? client.call("machines.worktrees", { machineId: machine.id }) : ({ supported: true, canManage: true, report: await client.desktop!.worktrees(), commands: [] }), [client, machine?.id, machine?.lastSeen, tick, poll]);
  const access = query.data;
  const report = access?.report;
  const expired = (c: { requestedAt: string }) => Date.now() - Date.parse(c.requestedAt) >= 24 * 60 * 60_000;
  const pending = new Set(access?.commands.filter(c => !c.completedAt && !expired(c)).flatMap(c => c.targets.map(e => e.path)) ?? []);
  const deletable = (e: WorktreeEntry) => !e.active && !pending.has(e.path);
  const ask = (entries: WorktreeEntry[]) => { setAck(false); setConfirm(entries); };
  // Dọn ngay: what automatic cleanup would remove, now, even while it is switched off.
  const now = new Date();
  const sweep = report?.entries.filter(e => deletable(e) && cleanupReason(e, report.cleanup, now, { now: true })) ?? [];
  const risky = confirm.some(e => e.dirty || e.merged !== true);
  const reload = () => setTick(v => v + 1);
  const remove = () => void action.run(async () => {
    const targets = confirm.map(({ project, path, fingerprint }) => ({ project, path, fingerprint }));
    if (machine) {
      try {
        // The heartbeat command limit also applies when the user selects the whole inventory.
        for (let i = 0; i < targets.length; i += 100) {
          await client.call("machines.manageWorktrees", { machineId: machine.id, targets: targets.slice(i, i + 100), force: risky });
          setNotice(t("worktrees.pending"));
          setConfirm(entries => entries.filter(e => !targets.slice(i, i + 100).some(target => target.path === e.path)));
        }
      } finally { reload(); }
    }
    else {
      const results = await client.desktop!.manageWorktrees(targets, risky);
      const failures = results.filter(r => !r.ok);
      setNotice(failures.length ? failures.map(r => `${r.path}: ${r.error}`).join("\n") : t("worktrees.removed"));
    }
    setConfirm([]); setSelected(new Set()); reload();
  });
  const bool = (v: boolean | null) => t(v === null ? "worktrees.unknown" : v ? "worktrees.yes" : "worktrees.no");
  return <div className="flex min-w-0 flex-col gap-4" aria-busy={query.loading || action.busy}>
    <ErrorNote error={query.error ?? action.error} />
    {query.loading && !access ? <p role="status">{t("common.loading")}</p> : null}
    {access && !access.supported ? <p>{t("worktrees.oldApp")}</p> : null}
    {notice ? <p role="status" className="whitespace-pre-wrap break-all text-sm">{notice}</p> : null}
    {report ? <>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium">{t("worktrees.total", { size: size(report.totalBytes), free: size(report.freeBytes) })}<span className="block text-xs font-normal text-fg-muted">{t("worktrees.measured", { time: formatTime(report.measuredAt) })}</span></p>
        {access?.canManage ? <Button size="sm" className={CONTROL} disabled={action.busy || !sweep.length} onClick={() => ask(sweep)} data-worktree-sweep>{t("worktrees.sweep", { count: sweep.length, size: size(sweep.reduce((n, e) => n + (e.bytes ?? 0), 0)) })}</Button> : null}
        <Button variant="outline" size="sm" className={CONTROL} disabled={action.busy} onClick={reload}>{t("worktrees.refresh")}</Button>
      </div>
      {report.errors.length ? <Notice tone="warn"><p>{t("worktrees.partial")}</p><ul className="break-all">{report.errors.map((error, i) => <li key={i}>{error}</li>)}</ul></Notice> : null}
      {access?.canManage ? <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={report.entries.some(deletable) && report.entries.filter(deletable).every(e => selected.has(e.path))} onChange={e => setSelected(e.target.checked ? new Set(report.entries.filter(deletable).map(e => e.path)) : new Set())} />{t("worktrees.selectAll")}</label>
        <Button variant="outline" size="sm" className={CONTROL} disabled={action.busy || !report.entries.some(e => selected.has(e.path) && deletable(e))} onClick={() => ask(report.entries.filter(e => selected.has(e.path) && deletable(e)))}>{t("worktrees.removeSelected", { count: report.entries.filter(e => selected.has(e.path) && deletable(e)).length })}</Button>
      </div> : null}
      {!report.entries.length ? <p className="text-sm">{t("worktrees.none")}</p> : null}
      {[...new Set(report.entries.map(e => e.project))].sort().map(project => <section key={project} className="min-w-0">
        <h3 className="mb-2 break-all font-mono text-sm font-semibold">{project}</h3>
        <ResponsiveTable><TableHeader><ResponsiveTableRow>
          <TableHead>{t("worktrees.task")}</TableHead><TableHead>{t("worktrees.branch")}</TableHead><TableHead>{t("worktrees.size")}</TableHead><TableHead>{t("worktrees.modified")}</TableHead><TableHead>{t("worktrees.changes")}</TableHead><TableHead>{t("worktrees.merged")}</TableHead><TableHead />
        </ResponsiveTableRow></TableHeader><TableBody>{report.entries.filter(e => e.project === project).map(entry => <ResponsiveTableRow key={entry.path} data-worktree={entry.taskId}>
          <TableCell><div className="flex items-center gap-2">
            {access?.canManage ? <label className="flex min-h-11 min-w-11 items-center justify-center md:min-h-7 md:min-w-7"><input type="checkbox" aria-label={t("worktrees.select", { task: entry.taskId })} disabled={!deletable(entry) || action.busy} checked={selected.has(entry.path)} onChange={event => setSelected(old => { const next = new Set(old); if (event.target.checked) next.add(entry.path); else next.delete(entry.path); return next; })} /></label> : null}
            <span className="break-all font-mono text-xs">{entry.taskId}<span className="block font-sans text-fg-muted">{entry.taskStatus ? t(`taskStatus.${entry.taskStatus}`) : t("worktrees.unknown")}</span></span>
          </div></TableCell>
          <TableCell className="whitespace-normal"><span className="break-all font-mono text-xs">{entry.branch}</span><span className="block break-all text-xs text-fg-muted">{entry.path}</span></TableCell>
          <TableCell>{size(entry.bytes)}{entry.error ? <span className="block text-xs text-fg-muted">{t("worktrees.measureFailed")}</span> : null}</TableCell>
          <TableCell>{formatTime(entry.modifiedAt)}</TableCell><TableCell>{bool(entry.dirty)}</TableCell><TableCell>{bool(entry.merged)}</TableCell>
          <TableCell>{entry.active ? <span className="text-xs">{t("worktrees.active")}</span> : pending.has(entry.path) ? <span className="text-xs">{t("worktrees.pending")}</span> : access?.canManage ? <Button variant="outline" size="sm" className={CONTROL} disabled={action.busy} data-delete-worktree onClick={() => ask([entry])}>{t("worktrees.remove")}</Button> : null}</TableCell>
        </ResponsiveTableRow>)}</TableBody></ResponsiveTable>
      </section>)}
      <CleanupSettings key={JSON.stringify(report.cleanup)} initial={report.cleanup} busy={action.busy} onSave={cleanup => void action.run(async () => {
        if (machine) { await client.call("machines.manageWorktrees", { machineId: machine.id, cleanup }); setNotice(t("worktrees.pending")); }
        else { await client.desktop!.updateSettings({ runner: { worktreeCleanup: cleanup } }); setNotice(t("worktrees.configured")); }
        reload();
      })} />
      <p className="text-xs/5 text-fg-muted">{t("worktrees.dependencies")}</p>
      {access?.commands.length ? <div className="flex flex-col gap-2 text-xs/5">{access.commands.slice(0, 10).map(c => <p key={c.id} className="break-all">{formatTime(c.requestedAt)} · {c.requestedBy} · {c.completedAt ? c.results.some(r => !r.ok) ? t("worktrees.failed") : c.cleanup ? t("worktrees.configured") : t("worktrees.removed") : expired(c) ? t("worktrees.expired") : t("worktrees.pending")}{c.results.filter(r => !r.ok).map(r => <span key={r.path} className="block">{r.path}: {r.error}</span>)}</p>)}</div> : null}
      <section><h3 className="mb-2 text-sm font-semibold">{t("worktrees.log")}</h3><ul className="flex flex-col gap-2 text-xs/5">{report.logs.map((log, i) => <li key={i} className="break-all">{formatTime(log.at)} · {log.project}/{log.taskId} · {t(`worktrees.reason.${log.reason}`)} · {t(log.ok ? "worktrees.removed" : "worktrees.failed")}{log.error ? `: ${log.error}` : ""}</li>)}</ul></section>
    </> : null}
    <AlertDialog open={confirm.length > 0} onOpenChange={open => { if (!open && !action.busy) setConfirm([]); }}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{t("worktrees.confirm", { count: confirm.length })}</AlertDialogTitle><AlertDialogDescription>{t("worktrees.confirmHint")}</AlertDialogDescription></AlertDialogHeader>
      <ul className="max-h-40 overflow-y-auto break-all text-xs/5">{confirm.map(e => <li key={e.path}>{e.project}/{e.taskId} · {e.branch}</li>)}</ul>
      {risky ? <><Notice tone="warn">{t("worktrees.warning")}</Notice><label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />{t("worktrees.acknowledge")}</label></> : null}
      <ErrorNote error={action.error} /><AlertDialogFooter><AlertDialogCancel disabled={action.busy} className={CONTROL}>{t("common.cancel")}</AlertDialogCancel><Button variant="destructive" className={CONTROL} disabled={action.busy || (risky && !ack)} onClick={remove} data-confirm-worktree-delete>{t("worktrees.remove")}</Button></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </div>;
}

function CleanupSettings({ initial, busy, onSave }: { initial: WorktreeCleanup; busy: boolean; onSave: (value: WorktreeCleanup) => void }) {
  const t = useT();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [days, setDays] = useState(String(initial.retentionDays));
  const [gb, setGb] = useState(String(initial.minFreeGb));
  const parsed = worktreeCleanupSchema.safeParse({ enabled, retentionDays: days.trim() ? Number(days) : NaN, minFreeGb: gb.trim() ? Number(gb) : NaN });
  return <form className="flex flex-col gap-3 rounded-lg border border-line-default p-3" onSubmit={e => { e.preventDefault(); if (parsed.success) onSave(parsed.data); }}>
    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium"><input type="checkbox" checked={enabled} disabled={busy} onChange={e => setEnabled(e.target.checked)} />{t("worktrees.cleanup")}</label>
    <p className="text-xs/5 text-fg-muted">{t("worktrees.cleanupHint")}</p>
    <div className="grid gap-3 md:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">{t("worktrees.retention")}<Input type="number" min={1} max={365} required value={days} onChange={e => setDays(e.target.value)} disabled={busy} className="text-base md:text-sm" /></label>
      <label className="flex flex-col gap-1 text-sm">{t("worktrees.minFree")}<Input type="number" min={0} max={1000} step="any" required value={gb} onChange={e => setGb(e.target.value)} disabled={busy} className="text-base md:text-sm" /></label>
    </div><Button type="submit" variant="outline" size="sm" className={`${CONTROL} self-start`} disabled={busy || !parsed.success}>{t("worktrees.save")}</Button>
  </form>;
}
