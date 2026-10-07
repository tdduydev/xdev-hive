import { useMemo, useState } from "react";
import { TableBody, TableCell, TableHead, TableHeader } from "@xdev-hive/ui/components/ui/table";
import { ResponsiveTable, ResponsiveTableRow } from "#ui/components/ResponsiveTable.tsx";
import { Skeleton } from "#ui/components/ui/skeleton.tsx";
import { SummaryStrip } from "#ui/components/SummaryStrip.tsx";
import { QuotaBars } from "#ui/components/QuotaBars.tsx";
import { CooldownRow } from "#ui/components/CooldownRow.tsx";
import { Empty, ErrorNote, Page, PageHeader } from "#ui/components/common.tsx";
import { formatTime, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { mapMachines } from "#ui/lib/agentmap.ts";
import { quotaRows, quotaTotals } from "#ui/lib/quota.ts";
import { scopeKey } from "#ui/lib/scope.ts";

export function QuotaPage() {
  const { client, scope } = useHive();
  const t = useT();
  const poll = usePoll(5000);
  const [tick, setTick] = useState(0);
  const machines = useQuery(() => client.call("machines.list", {}), [client, poll, tick]);
  const cooldowns = useQuery(() => client.call("cooldowns.list", {}), [client, poll, tick]);
  const [kind, setKind] = useState(() => new URLSearchParams(location.hash.split("?")[1]).get("kind") ?? "");
  const [machine, setMachine] = useState(() => new URLSearchParams(location.hash.split("?")[1]).get("machine") ?? "");
  const [available, setAvailable] = useState(false);
  const key = scopeKey(scope);
  const shown = useMemo(() => mapMachines(machines.data ?? [], scope), [machines.data, key]);
  const all = quotaRows(shown, cooldowns.data ?? [], Date.now(), machine);
  // Filter grouped rows so a selected machine still shows the shared account's latest report.
  const rows = all.filter(r => (!kind || r.profile.kind === kind) && (!machine || r.members.some(m => m.machine.id === machine)) && (!available || r.available));
  const kinds = [...new Set(all.map(r => r.profile.kind))].sort();
  const summaries = [{ label: t("quota.total"), rows }, ...[...new Set(rows.map(r => r.profile.kind))].sort().map(label => ({ label, rows: rows.filter(r => r.profile.kind === label) }))];
  const number = (n: number | null | undefined) => n == null ? t("quota.unknown") : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const total = quotaTotals(rows);
  const rests = (cooldowns.data ?? []).filter(c => all.some(r => r.profile.account === c.account && (!kind || r.profile.kind === kind) && (!machine || r.members.some(m => m.machine.id === machine))));
  const headers = [t("quota.profile"), t("quota.machines"), t("dashboardAgents.usage"), t("dashboardAgents.resetEstimate"), t("quota.status")];
  return <Page wide>
    <PageHeader title={t("quota.title")} subtitle={t("quota.hint")} />
    <ErrorNote error={machines.error ?? cooldowns.error} />
    {machines.data ? <div data-quota-totals>
      <SummaryStrip label={t("quota.total")} items={[
        { id: "dispatch", label: t("dashboardAgents.dispatch"), value: total.slots, href: "#/machines?tab=map" },
        { id: "slots", label: t("dashboardAgents.slots"), value: total.slots, sub: t("quota.capacity", { count: total.available, slots: total.slots }), href: "#/machines?tab=map" },
        { id: "full", label: t("dashboardAgents.full"), value: total.full == null ? "—" : `~${number(total.full)}`, sub: total.unknown ? t("quota.missing", { count: total.unknown }) : undefined, href: "#/machines?tab=quota" },
        { id: "reset", label: t("dashboardAgents.reset"), value: total.nextAt ? new Date(total.nextAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—", sub: total.nextAt ? formatTime(total.nextAt) : undefined, href: "#/machines?tab=quota" },
      ]} />
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">{summaries.map(s => { const sum = quotaTotals(s.rows); return <span key={s.label} data-quota-total={s.label} data-quota-slots={sum.slots}>{s.label}: {sum.slots} · {t("dashboardAgents.slots")}</span>; })}</div>
    </div> : null}
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex min-w-0 max-w-full items-center gap-2 text-sm">{t("quota.kind")}<select className="h-[var(--control-h-touch)] rounded-md border bg-background px-3 text-base" value={kind} onChange={e => setKind(e.target.value)} data-quota-kind><option value="">{t("quota.all")}</option>{kinds.map(k => <option key={k}>{k}</option>)}</select></label>
      <label className="flex min-w-0 max-w-full items-center gap-2 text-sm">{t("quota.machines")}<select className="h-[var(--control-h-touch)] min-w-0 max-w-full rounded-md border bg-background px-3 text-base" value={machine} onChange={e => setMachine(e.target.value)} data-quota-machine><option value="">{t("quota.all")}</option>{shown.map(m => <option key={m.id} value={m.id}>{m.machine}</option>)}</select></label>
      <label className="flex min-h-[var(--control-h-touch)] items-center gap-2 text-sm"><input type="checkbox" checked={available} onChange={e => setAvailable(e.target.checked)} data-quota-available />{t("quota.onlyAvailable")}</label>
    </div>
    {!machines.data && machines.loading ? <Skeleton role="status" aria-label={t("common.loading")} className="h-48 rounded-lg" /> : !rows.length ? <Empty>{t("quota.empty")}</Empty> : <ResponsiveTable data-quota-table className="table-fixed" data-density="compact">
      <TableHeader><ResponsiveTableRow>{headers.map(h => <TableHead key={h}>{h}</TableHead>)}</ResponsiveTableRow></TableHeader>
      <TableBody>{rows.map(r => {
        const p = r.profile;
        const missing = p.sessionPercent == null && p.weekPercent == null && !p.sessionResets && !p.weekResets && !p.sessionResetsAt && !p.weekResetsAt && p.resetsLeft == null && r.full == null && !p.credits && !p.spendControlReached;
        const names = [...new Set(r.members.map(m => m.machine.machine))].join(", ");
        const reset = [p.sessionResetsAt ? formatTime(p.sessionResetsAt) : p.sessionResets, p.weekResetsAt ? formatTime(p.weekResetsAt) : p.weekResets].filter(Boolean).join(" · ");
        const states = [...new Set(r.members.map(m => t(`agentMap.state.${m.card.state}`, { n: m.card.running, max: m.card.max })))].join(" · ");
        return <ResponsiveTableRow key={r.key} data-quota-account={p.account ?? p.id} data-quota-missing={missing || undefined}>
          <TableCell className="whitespace-normal align-top"><p className="truncate font-medium" title={`${p.label} · ${p.kind}`}>{p.label} · {p.kind}</p><p className="truncate text-xs text-muted-foreground" title={p.account ?? p.planType ?? undefined}>{p.account ?? p.planType ?? "—"}</p></TableCell>
          <TableCell className="whitespace-normal align-top"><p className="line-clamp-2 wrap-anywhere" title={names}>{names}</p></TableCell>
          {missing ? <TableCell colSpan={2} className="whitespace-normal align-top"><span className="text-xs text-fg-muted md:line-clamp-2" title={t("dashboardAgents.readHint", { machine: names })}>{t("dashboardAgents.missing")} · {t("dashboardAgents.readHint", { machine: names })}</span></TableCell> : <>
            <TableCell className="whitespace-normal align-top" title={t("quota.checked", { time: p.usageCheckedAt ? formatTime(p.usageCheckedAt) : t("quota.unknown") })}><QuotaBars profile={p} /></TableCell>
            <TableCell className="whitespace-normal align-top text-xs" title={[reset, t("agents.quota.outlookHint")].filter(Boolean).join("\n")}>
              {reset ? <p className="line-clamp-2">{reset}</p> : null}
              {p.resetsLeft != null || r.full != null ? <p>{p.resetsLeft == null ? "—" : t("quota.resetCount", { count: number(p.resetsLeft) })} · {r.full == null ? "—" : t("quota.estimate", { count: number(r.full) })}</p> : null}
              {p.fullSessionsLeft != null && p.resetsLeft != null && p.fullSessionsLeft < p.resetsLeft ? <p>{t("agents.quota.outlookCeiling")}</p> : null}
              {p.credits ? <p>{p.credits.unlimited ? t("agents.quota.outlookUnlimited") : t("agents.quota.outlookCredits", { balance: p.credits.balance ?? "?" })}</p> : null}
              {p.spendControlReached ? <p>{t("agents.quota.outlookSpend")}</p> : null}
              {!reset && p.resetsLeft == null && r.full == null && !p.credits && !p.spendControlReached ? "—" : null}
            </TableCell>
          </>}
          <TableCell className="whitespace-normal align-top text-xs">{r.members.length > 1 ? <details><summary className="min-h-11 cursor-pointer content-center md:min-h-0"><span className="line-clamp-2">{states}</span></summary>{r.members.map(({ machine: m, card }) => <p key={`${m.id}/${card.profile.id}`} className="mt-1 wrap-anywhere">{m.machine}: {t(`agentMap.state.${card.state}`, { n: card.running, max: card.max })}</p>)}</details> : states}</TableCell>
        </ResponsiveTableRow>;
      })}</TableBody>
    </ResponsiveTable>}
    {rests.length ? <section className="flex flex-col gap-2"><h2 className="text-sm font-semibold">{t("dashboardAgents.cooldowns")}</h2><ResponsiveTable><TableHeader><ResponsiveTableRow>
      <TableHead>{t("machines.colAccount")}</TableHead><TableHead>{t("machines.colUntil")}</TableHead><TableHead>{t("machines.colReason")}</TableHead><TableHead>{t("machines.colReportedBy")}</TableHead><TableHead />
    </ResponsiveTableRow></TableHeader><TableBody>{rests.map(c => <CooldownRow key={c.account} cooldown={c} onChanged={() => setTick(n => n + 1)} />)}</TableBody></ResponsiveTable></section> : null}
  </Page>;
}
