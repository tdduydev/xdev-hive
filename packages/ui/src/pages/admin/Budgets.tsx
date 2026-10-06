import { ResponsiveGridRow, ResponsiveTableFrame } from "#ui/components/ResponsiveTable.tsx";
// Trần chi tiêu (roadmap 27b) on the Costs page: one row per cap with what its day or month used, and for a hub admin
// the way to add, change or remove one. budgets.set replaces the whole list, so every save sends all of them.
import { useState } from "react";
import { cn } from "cn";
import { BUDGET_PERIODS, type Budget, type BudgetPeriod, type BudgetUsage } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Empty, ErrorNote } from "#ui/components/common.tsx";
import { formatUsd, useAction, useHive, useProjects, useQuery } from "#ui/hooks.ts";
import { useT, type TFunction } from "#ui/i18n/index.tsx";

type Kind = Budget["scope"]["kind"];

/** A cap as typed: amounts as text, so a field can be empty (no limit of that kind). */
interface Draft {
  kind: Kind;
  name: string;
  period: BudgetPeriod;
  usd: string;
  runs: string;
}

const EMPTY: Draft = { kind: "project", name: "", period: "month", usd: "", runs: "" };

const toDraft = (b: Budget): Draft => ({
  kind: b.scope.kind,
  name: b.scope.kind === "project" ? b.scope.project : b.scope.kind === "user" ? b.scope.user : "",
  period: b.period,
  usd: b.limit.usd === undefined ? "" : String(b.limit.usd),
  runs: b.limit.runs === undefined ? "" : String(b.limit.runs),
});

/** null while the draft is not a cap yet (no name, or no limit); the hub checks the rest. */
function toBudget(d: Draft): Budget | null {
  const usd = d.usd.trim() ? Number(d.usd) : undefined;
  const runs = d.runs.trim() ? Number(d.runs) : undefined;
  if (usd === undefined && runs === undefined) return null;
  if ((usd !== undefined && !(usd > 0)) || (runs !== undefined && !(Number.isInteger(runs) && runs > 0))) return null;
  const name = d.name.trim();
  if (d.kind !== "hub" && !name) return null;
  const scope: Budget["scope"] = d.kind === "project" ? { kind: "project", project: name } : d.kind === "user" ? { kind: "user", user: name } : { kind: "hub" };
  return { scope, period: d.period, limit: { ...(usd !== undefined ? { usd } : {}), ...(runs !== undefined ? { runs } : {}) } };
}

/** Only what budgets.set takes: the list as the hub gave it, without what it used. */
const plain = (b: BudgetUsage): Budget => ({ scope: b.scope, period: b.period, limit: b.limit });

const scopeLabel = (t: TFunction, b: Budget) =>
  b.scope.kind === "project" ? t("budgets.scope.project", { name: b.scope.project }) : b.scope.kind === "user" ? t("budgets.scope.user", { name: b.scope.user }) : t("budgets.scope.hub");

function UsedBar({ used, limit, label }: { used: number; limit: number; label: string }) {
  const pct = Math.max(0, Math.round((used / limit) * 100));
  return (
    <span className="flex items-center gap-2">
      <span className="relative h-[6px] min-w-0 md:min-w-24 flex-1 rounded-full bg-sunken">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", pct >= 100 ? "bg-danger-solid" : pct >= 70 ? "bg-warning-solid" : "bg-primary")}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </span>
      <span className="shrink-0 font-mono text-[11px] text-fg-secondary">{label}</span>
    </span>
  );
}

export function BudgetsCard({ tick }: { tick: number }) {
  const { client, me } = useHive();
  const t = useT();
  const projects = useProjects();
  const [n, setN] = useState(0);
  const list = useQuery(() => client.call("budgets.list", {}), [client, tick, n]);
  const action = useAction();
  // Which row is being edited ("new" for the add form), and what it says so far.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  // Caps bind every project or person: budgets.set is a hub admin's, as on the hub.
  const hubAdmin = me.role === "admin" && !me.access;
  const rows = list.data ?? [];

  const save = (next: Budget[]) =>
    void action.run(async () => {
      await client.call("budgets.set", { budgets: next });
      setEditing(null);
      setN((x) => x + 1);
    });
  const start = (id: string, d: Draft) => {
    setEditing(id);
    setDraft(d);
  };
  const ready = toBudget(draft);

  const form = (id: string) => (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line-default bg-sunken p-2.5">
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        {t("budgets.scopeLabel")}
        <NativeSelect size="sm" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Kind, name: "" })}>
          {(["project", "user", "hub"] as const).map((k) => (
            <NativeSelectOption key={k} value={k}>
              {t(`budgets.kind.${k}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      {draft.kind === "project" ? (
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          {t("budgets.kind.project")}
          <NativeSelect size="sm" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}>
            <NativeSelectOption value="">—</NativeSelectOption>
            {[...new Set([...projects, draft.name].filter(Boolean))].sort().map((p) => (
              <NativeSelectOption key={p} value={p}>
                {p}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : draft.kind === "user" ? (
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          {t("budgets.kind.user")}
          <Input className="h-7 w-36 text-xs" value={draft.name} placeholder={t("budgets.userPlaceholder")} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
      ) : null}
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        {t("budgets.periodLabel")}
        <NativeSelect size="sm" value={draft.period} onChange={(e) => setDraft({ ...draft, period: e.target.value as BudgetPeriod })}>
          {BUDGET_PERIODS.map((p) => (
            <NativeSelectOption key={p} value={p}>
              {t(`budgets.period.${p}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        {t("budgets.usdLabel")}
        <Input className="h-7 w-24 text-xs" inputMode="decimal" value={draft.usd} placeholder="—" onChange={(e) => setDraft({ ...draft, usd: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        {t("budgets.runsLabel")}
        <Input className="h-7 w-20 text-xs" inputMode="numeric" value={draft.runs} placeholder="—" onChange={(e) => setDraft({ ...draft, runs: e.target.value })} />
      </label>
      <Button
        size="sm"
        disabled={action.busy || !ready}
        onClick={() => ready && save(id === "new" ? [...rows.map(plain), ready] : rows.map((r) => (r.id === id ? ready : plain(r))))}
      >
        {t("budgets.save")}
      </Button>
      <Button size="sm" variant="outline" disabled={action.busy} onClick={() => setEditing(null)}>
        {t("budgets.cancel")}
      </Button>
      <span className="basis-full text-[11px] text-fg-muted">{t("budgets.formHint")}</span>
    </div>
  );

  return (
    <ResponsiveTableFrame className="flex min-w-0 flex-col gap-3 rounded-[14px] border border-line-default bg-surface p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="m-0 text-sm/5 font-semibold text-fg-strong">{t("budgets.title")}</h2>
        <span className="text-xs text-fg-muted">{t("budgets.hint")}</span>
        {hubAdmin && editing !== "new" ? (
          <Button className="ml-auto" size="xs" variant="outline" onClick={() => start("new", EMPTY)}>
            {t("budgets.add")}
          </Button>
        ) : null}
      </div>
      <ErrorNote error={list.error ?? action.error} />
      {list.data && !rows.length && editing !== "new" ? <Empty>{t("budgets.none")}</Empty> : null}
      {rows.map((b) =>
        editing === b.id ? (
          <div key={b.id}>{form(b.id)}</div>
        ) : (
          <ResponsiveGridRow labels={[t("budgets.scopeLabel"), t("budgets.title"), null]} key={b.id} className="grid grid-cols-[minmax(140px,1fr)_minmax(200px,2fr)_auto] items-center gap-3 border-b border-line-default pb-2.5 last:border-b-0 last:pb-0">
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium text-fg-strong">{scopeLabel(t, b)}</span>
              <span className="text-xs text-fg-muted">{t(`budgets.period.${b.period}`)}</span>
            </div>
            <div className="flex flex-col gap-1">
              {b.limit.usd !== undefined ? <UsedBar used={b.used.usd} limit={b.limit.usd} label={`${formatUsd(b.used.usd)} / ${formatUsd(b.limit.usd)}`} /> : null}
              {b.limit.runs !== undefined ? <UsedBar used={b.used.runs} limit={b.limit.runs} label={t("budgets.runsUsed", { used: b.used.runs, limit: b.limit.runs })} /> : null}
              {b.ratio >= 1 ? <span className="text-xs text-danger">{t("budgets.full")}</span> : null}
            </div>
            {hubAdmin ? (
              <div className="flex gap-1.5">
                <Button size="xs" variant="outline" disabled={action.busy || editing !== null} onClick={() => start(b.id, toDraft(b))}>
                  {t("budgets.edit")}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={action.busy || editing !== null}
                  onClick={() => {
                    if (window.confirm(t("budgets.confirmRemove", { scope: scopeLabel(t, b) }))) save(rows.filter((r) => r.id !== b.id).map(plain));
                  }}
                >
                  {t("budgets.remove")}
                </Button>
              </div>
            ) : (
              <span />
            )}
          </ResponsiveGridRow>
        ),
      )}
      {editing === "new" ? form("new") : null}
    </ResponsiveTableFrame>
  );
}
