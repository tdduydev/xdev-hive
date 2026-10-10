// Trần chi tiêu (roadmap 27b) on the Costs page: one row per cap with what its day or month used, and for a hub admin
// the way to add, change or remove one. budgets.set replaces the whole list, so every save sends all of them.
import { useState } from "react";
import { BUDGET_PERIODS, type Budget, type BudgetPeriod, type BudgetUsage } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Empty, ErrorNote } from "#ui/components/common.tsx";
import { formatUsd, useAction, useHive, useProjects, useQuery } from "#ui/hooks.ts";
import { useT, type TFunction } from "#ui/i18n/index.tsx";
import { AdminCards, AdminStats, toneForRatio, usedPercent, type AdminCard } from "./cosmic.tsx";

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
    <div className="cx-ops-panel cx-ops-form">
      <label className="cx-ops-field">
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
        <label className="cx-ops-field">
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
        <label className="cx-ops-field">
          {t("budgets.kind.user")}
          <Input controlSize="sm" className="w-36" value={draft.name} placeholder={t("budgets.userPlaceholder")} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
      ) : null}
      <label className="cx-ops-field">
        {t("budgets.periodLabel")}
        <NativeSelect size="sm" value={draft.period} onChange={(e) => setDraft({ ...draft, period: e.target.value as BudgetPeriod })}>
          {BUDGET_PERIODS.map((p) => (
            <NativeSelectOption key={p} value={p}>
              {t(`budgets.period.${p}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <label className="cx-ops-field">
        {t("budgets.usdLabel")}
        <Input controlSize="sm" className="w-24" inputMode="decimal" value={draft.usd} placeholder="—" onChange={(e) => setDraft({ ...draft, usd: e.target.value })} />
      </label>
      <label className="cx-ops-field">
        {t("budgets.runsLabel")}
        <Input controlSize="sm" className="w-20" inputMode="numeric" value={draft.runs} placeholder="—" onChange={(e) => setDraft({ ...draft, runs: e.target.value })} />
      </label>
      <Button
        size="sm"
        variant="solid"
        disabled={action.busy || !ready}
        onClick={() => ready && save(id === "new" ? [...rows.map(plain), ready] : rows.map((r) => (r.id === id ? ready : plain(r))))}
      >
        {t("budgets.save")}
      </Button>
      <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => setEditing(null)}>
        {t("budgets.cancel")}
      </Button>
      <span className="cx-ops-hint basis-full">{t("budgets.formHint")}</span>
    </div>
  );

  const cards: AdminCard[] = rows.map((b) => {
    const pcts = [usedPercent(b.used.usd, b.limit.usd), usedPercent(b.used.runs, b.limit.runs)].filter((p): p is number => p !== null);
    return {
      key: b.id,
      title: scopeLabel(t, b),
      side: t(`budgets.period.${b.period}`),
      tone: toneForRatio(b.ratio),
      bar: pcts.length ? Math.max(...pcts) : null,
      body: (
        <>
          {b.limit.usd !== undefined ? <div>{`${formatUsd(b.used.usd)} / ${formatUsd(b.limit.usd)}`}</div> : null}
          {b.limit.runs !== undefined ? <div>{t("budgets.runsUsed", { used: b.used.runs, limit: b.limit.runs })}</div> : null}
          {b.ratio >= 1 ? <div className="text-danger">{t("budgets.full")}</div> : null}
        </>
      ),
      ...(hubAdmin
        ? {
            action: { label: t("budgets.edit"), disabled: action.busy || editing !== null, onClick: () => start(b.id, toDraft(b)) },
            extra: (
              <Button
                size="sm"
                variant="ghost"
                disabled={action.busy || editing !== null}
                onClick={() => {
                  if (window.confirm(t("budgets.confirmRemove", { scope: scopeLabel(t, b) }))) save(rows.filter((r) => r.id !== b.id).map(plain));
                }}
              >
                {t("budgets.remove")}
              </Button>
            ),
          }
        : {}),
    };
  });
  const full = rows.filter((b) => b.ratio >= 1).length;
  const near = rows.filter((b) => b.ratio >= 0.7 && b.ratio < 1).length;

  return (
    <div className="cx-ops-stack">
      <AdminStats
        stats={[
          { key: "caps", label: t("adminOps.budgets.caps"), value: rows.length, tone: "info" },
          { key: "full", label: t("adminOps.budgets.full"), value: full, note: t("adminOps.budgets.fullNote"), tone: full ? "bad" : "ok" },
          { key: "near", label: t("adminOps.budgets.near"), value: near, note: t("adminOps.budgets.nearNote"), tone: near ? "warn" : "ok" },
        ]}
      />
      <div className="cx-ops-toolbar !mb-0">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5"><h2 className="cx-ops-h">{t("budgets.title")}</h2><span className="cx-ops-hint">{t("budgets.hint")}</span></div>
        {hubAdmin && editing !== "new" ? (
          <Button size="sm" variant="glass" onClick={() => start("new", EMPTY)}>
            {t("budgets.add")}
          </Button>
        ) : null}
      </div>
      <ErrorNote error={list.error ?? action.error} />
      {list.data && !rows.length && editing !== "new" ? <Empty>{t("budgets.none")}</Empty> : null}
      {editing === "new" ? form("new") : null}
      {editing && editing !== "new" ? form(editing) : null}
      <AdminCards cards={cards} />
    </div>
  );
}
