import { useMemo, useState } from "react";
import { TableBody, TableCell, TableHead, TableHeader } from "@xdev-hive/ui/components/ui/table";
import { ResponsiveTable, ResponsiveTableRow } from "#ui/components/ResponsiveTable.tsx";
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
  const machines = useQuery(() => client.call("machines.list", {}), [client, poll]);
  const cooldowns = useQuery(() => client.call("cooldowns.list", {}), [client, poll]);
  const [kind, setKind] = useState("");
  const [machine, setMachine] = useState("");
  const [available, setAvailable] = useState(false);
  const key = scopeKey(scope);
  const shown = useMemo(() => mapMachines(machines.data ?? [], scope), [machines.data, key]);
  const all = quotaRows(shown, cooldowns.data ?? [], Date.now(), machine);
  // Filter grouped rows so a selected machine still shows the shared account's latest report.
  const rows = all.filter(r => (!kind || r.profile.kind === kind) && (!machine || r.members.some(m => m.machine.id === machine)) && (!available || r.available));
  const kinds = [...new Set(all.map(r => r.profile.kind))].sort();
  const summaries = [{ label: t("quota.total"), rows }, ...[...new Set(rows.map(r => r.profile.kind))].sort().map(label => ({ label, rows: rows.filter(r => r.profile.kind === label) }))];
  const number = (n: number | null | undefined) => n == null ? t("quota.unknown") : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const percent = (n: number | null | undefined) => n == null ? t("quota.unknown") : `${number(n)}%`;
  const headers = ["profile", "machines", "usage", "resets", "outlook", "credits", "status"] as const;
  return <Page wide>
    <PageHeader title={t("quota.title")} subtitle={t("quota.hint")} />
    <ErrorNote error={machines.error ?? cooldowns.error} />
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex min-w-0 max-w-full items-center gap-2 text-sm">{t("quota.kind")}<select className="h-[var(--control-h-touch)] rounded-md border bg-background px-3 text-base" value={kind} onChange={e => setKind(e.target.value)} data-quota-kind><option value="">{t("quota.all")}</option>{kinds.map(k => <option key={k}>{k}</option>)}</select></label>
      <label className="flex min-w-0 max-w-full items-center gap-2 text-sm">{t("quota.machines")}<select className="h-[var(--control-h-touch)] min-w-0 max-w-full rounded-md border bg-background px-3 text-base" value={machine} onChange={e => setMachine(e.target.value)} data-quota-machine><option value="">{t("quota.all")}</option>{shown.map(m => <option key={m.id} value={m.id}>{m.machine}</option>)}</select></label>
      <label className="flex min-h-[var(--control-h-touch)] items-center gap-2 text-sm"><input type="checkbox" checked={available} onChange={e => setAvailable(e.target.checked)} data-quota-available />{t("quota.onlyAvailable")}</label>
    </div>
    <div className="grid gap-3 md:grid-cols-2" data-quota-totals>
      {summaries.map(s => { const total = quotaTotals(s.rows); return <section key={s.label} className="rounded-lg border p-4 text-sm/6" data-quota-total={s.label} data-quota-slots={total.slots}>
        <h2 className="font-semibold">{s.label}</h2>
        <p>{t("quota.capacity", { count: total.available, slots: total.slots })}</p>
        <p className="font-medium">{t("quota.dispatch", { count: total.slots })}</p>
        <p>{total.full == null ? t("quota.noEstimate") : t("quota.estimate", { count: number(total.full) })}{total.unknown ? ` · ${t("quota.missing", { count: total.unknown })}` : ""}</p>
        <p>{t("quota.next", { time: total.nextAt ? formatTime(total.nextAt) : t("quota.unknown") })}</p>
      </section>; })}
    </div>
    {!rows.length ? <Empty>{t("quota.empty")}</Empty> : <ResponsiveTable data-quota-table>
      <TableHeader><ResponsiveTableRow>{headers.map(h => <TableHead key={h}>{t(`quota.${h}`)}</TableHead>)}</ResponsiveTableRow></TableHeader>
      <TableBody>{rows.map(r => { const p = r.profile; return <ResponsiveTableRow key={r.key} data-quota-account={p.account ?? p.id}>
        <TableCell className="whitespace-normal"><p className="font-medium">{p.label} · {p.kind}</p><p className="text-xs text-muted-foreground wrap-anywhere">{p.planType ?? "—"} · {p.account ?? "—"}</p></TableCell>
        <TableCell className="whitespace-normal">{r.members.map(m => m.machine.machine).filter((m, i, a) => a.indexOf(m) === i).join(", ")}</TableCell>
        <TableCell className="whitespace-normal"><p>{t("quota.session", { value: percent(p.sessionPercent) })}</p><p>{t("quota.week", { value: percent(p.weekPercent) })}</p><p className="text-xs text-muted-foreground">{t("quota.checked", { time: p.usageCheckedAt ? formatTime(p.usageCheckedAt) : t("quota.unknown") })}</p></TableCell>
        <TableCell className="whitespace-normal"><p>{p.sessionResetsAt ? formatTime(p.sessionResetsAt) : p.sessionResets ?? t("quota.unknown")}</p><p>{p.weekResetsAt ? formatTime(p.weekResetsAt) : p.weekResets ?? t("quota.unknown")}</p></TableCell>
        <TableCell className="whitespace-normal" title={t("agents.quota.outlookHint")}><p>{p.resetsLeft == null ? t("quota.noResetCount") : t("quota.resetCount", { count: number(p.resetsLeft) })}</p><p>{r.full == null ? t("quota.noEstimate") : t("quota.estimate", { count: number(r.full) })}</p>{p.fullSessionsLeft != null && p.resetsLeft != null && p.fullSessionsLeft < p.resetsLeft ? <p>{t("agents.quota.outlookCeiling")}</p> : null}</TableCell>
        <TableCell className="whitespace-normal">{p.credits ? p.credits.unlimited ? t("agents.quota.outlookUnlimited") : t("agents.quota.outlookCredits", { balance: p.credits.balance ?? "?" }) : t("agents.quota.outlookNoCredits")}{p.spendControlReached ? <p>{t("agents.quota.outlookSpend")}</p> : null}</TableCell>
        <TableCell className="whitespace-normal">{r.members.map(m => <p key={`${m.machine.id}/${m.card.profile.id}`}>{m.machine.machine}: {t(`agentMap.state.${m.card.state}`, { n: m.card.running, max: m.card.max })}</p>)}</TableCell>
      </ResponsiveTableRow>; })}</TableBody>
    </ResponsiveTable>}
  </Page>;
}
