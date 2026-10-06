import { ResponsiveGridRow, ResponsiveTableFrame } from "#ui/components/ResponsiveTable.tsx";
// Cảnh báo (docs/design/2026-09-redesign, xDev Hive Web Admin; roadmap 22m): the incidents the hub's rules found and the
// rules themselves; on Tổng quan, the open alerts and the live feed of what machines and people did.
import { useEffect, useState } from "react";
import { cn } from "cn";
import type { AlertRule, FeedEvent, HubAlert } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { ErrorNote } from "#ui/components/common.tsx";
import { errorMessage, formatTime, useHive, useQuery } from "#ui/hooks.ts";
import { useT, type TFunction } from "#ui/i18n/index.tsx";
import { activeIntl } from "#ui/i18n/translate.ts";
import { useToast } from "#ui/shell/toast.tsx";
import { ACTION_LABEL } from "#ui/pages/Admin.tsx";

const SEV = {
  high: "bg-danger-soft text-danger border-danger-line",
  medium: "bg-warning-soft text-warning border-warning-line",
  low: "bg-neutral-soft text-fg-secondary border-line-default",
} as const;

/** An alert's vars as the UI shows them (times in the viewer's zone). */
function shown(a: Pick<HubAlert, "vars">): Record<string, string | number> {
  const out: Record<string, string | number> = { ...a.vars };
  for (const k of ["since", "until"]) if (typeof out[k] === "string") out[k] = formatTime(String(out[k]));
  return out;
}
export const alertTitle = (t: TFunction, a: Pick<HubAlert, "rule" | "vars">) => t(`alerts.title.${a.rule}`, shown(a));
export const alertDetail = (t: TFunction, a: Pick<HubAlert, "rule" | "vars">) => t(`alerts.detail.${a.rule}`, shown(a));

/** Every 20 s while open: alerts move on their own. */
function useEvery(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((v) => v + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

function AlertRow({ a, t, state, onAck }: { a: HubAlert; t: TFunction; state?: string; onAck?: () => void }) {
  return (
    <ResponsiveGridRow primary={1} labels={[t("table.severity"), null, null]} className={cn("flex items-center gap-3 border-b border-line-subtle py-2.5 last:border-b-0", a.resolvedAt && "opacity-60")}>
      <span className={cn("inline-flex h-5 w-12 shrink-0 items-center justify-center rounded-xs border text-[11px] font-semibold", SEV[a.severity])}>{t(`alerts.severity.${a.severity}`)}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium text-fg-strong">{alertTitle(t, a)}</span>
        <span className="truncate text-xs text-fg-muted">
          {alertDetail(t, a)} · {a.resolvedAt ? t("alerts.ended", { time: formatTime(a.resolvedAt) }) : t("alerts.since", { time: formatTime(a.openedAt) })}
        </span>
      </span>
      {onAck && !a.ackedBy ? (
        <Button size="xs" variant="outline" onClick={onAck}>
          {t("alerts.ack")}
        </Button>
      ) : state ? (
        <span className="shrink-0 text-xs text-fg-muted">{state}</span>
      ) : null}
    </ResponsiveGridRow>
  );
}

const stateOf = (t: TFunction, a: HubAlert) =>
  a.resolvedAt ? (a.resolvedBy ? t("alerts.stateBy", { who: a.resolvedBy }) : t("alerts.stateAuto")) : a.ackedBy ? t("alerts.stateAcked", { who: a.ackedBy }) : t("alerts.stateOpen");

/** Tổng quan: the alerts open now, with Đã biết. */
export function OpenAlerts({ card }: { card: (title: string, action: React.ReactNode, body: React.ReactNode) => React.ReactNode }) {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const tick = useEvery(20_000);
  const [n, setN] = useState(0);
  const data = useQuery(async () => (client.alerts ? client.alerts.list() : null), [client, tick, n]);
  if (!client.alerts) return null;
  const open = data.data?.open ?? [];
  return card(
    t("alerts.open"),
    <a className="text-fg-link hover:underline" href="#/alerts">
      {t("alerts.all")}
    </a>,
    <>
      <ErrorNote error={data.error} />
      {data.data && !open.length ? <p className="m-0 text-[13px] text-fg-muted">{t("alerts.none")}</p> : null}
      <ResponsiveTableFrame className="flex flex-col">
        {open.slice(0, 6).map((a) => (
          <AlertRow
            key={a.id}
            a={a}
            t={t}
            state={stateOf(t, a)}
            onAck={() =>
              void client.alerts!.ack(a.id).then(
                () => (toast(t("alerts.acked")), setN((v) => v + 1)),
                (err: unknown) => toast(errorMessage(err), { tone: "error" }),
              )
            }
          />
        ))}
      </ResponsiveTableFrame>
    </>,
  );
}

const DOT: Record<FeedEvent["tone"], string> = {
  running: "bg-running",
  success: "bg-success-solid",
  danger: "bg-danger-solid",
  warning: "bg-warning-solid",
  info: "bg-info-solid",
  neutral: "bg-line-strong",
};

/** Tổng quan: what machines and people did, live. */
export function EventFeed({ card }: { card: (title: string, action: React.ReactNode, body: React.ReactNode) => React.ReactNode }) {
  const { client } = useHive();
  const t = useT();
  const tick = useEvery(10_000);
  const feed = useQuery(async () => (client.alerts ? client.alerts.feed(40) : null), [client, tick]);
  if (!client.alerts) return null;
  const text = (e: FeedEvent) => {
    if (e.key === "feed.alertOpened" || e.key === "feed.alertResolved") {
      return t(e.key, { title: alertTitle(t, { rule: e.vars.rule as AlertRule, vars: e.vars }) });
    }
    if (e.key === "feed.audit") {
      const a = String(e.vars.action);
      return t("feed.audit", { action: ACTION_LABEL[a] ? t(ACTION_LABEL[a]!) : a, target: String(e.vars.target) });
    }
    return t(e.key as never, e.vars as never);
  };
  const clock = (at: string) => new Date(at).toLocaleTimeString(activeIntl(), { hour: "2-digit", minute: "2-digit", hour12: false });
  const list = feed.data ?? [];
  return card(
    t("feed.title"),
    <span className="text-fg-muted">{t("feed.hint")}</span>,
    <>
      <ErrorNote error={feed.error} />
      {feed.data && !list.length ? <p className="m-0 text-[13px] text-fg-muted">{t("feed.none")}</p> : null}
      <div aria-live="polite" className="flex max-h-[340px] flex-col overflow-y-auto">
        {list.map((e, i) => {
          const body = (
            <>
              <span className="w-10 shrink-0 font-mono text-[11px] text-fg-muted tabular-nums">{clock(e.at)}</span>
              <span className={cn("size-1.5 shrink-0 rounded-full", DOT[e.tone])} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-fg-primary">
                <span className="font-mono text-xs font-semibold text-fg-strong">{e.src}</span> {text(e)}
              </span>
            </>
          );
          const cls = "flex items-center gap-2.5 border-b border-line-subtle py-1.5 last:border-b-0";
          return e.href ? (
            <a key={i} href={e.href} className={cn(cls, "hover:bg-hover")}>
              {body}
            </a>
          ) : (
            <div key={i} className={cls}>
              {body}
            </div>
          );
        })}
      </div>
    </>,
  );
}

/** Cảnh báo: every incident of the last week, and the rules. */
export function OpsAlerts() {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const tick = useEvery(20_000);
  const [n, setN] = useState(0);
  const data = useQuery(async () => (client.alerts ? client.alerts.list() : null), [client, tick, n]);
  const [busy, setBusy] = useState<string | null>(null);
  if (!client.alerts) return null;
  const all = [...(data.data?.open ?? []), ...(data.data?.recent ?? [])];
  const section = "flex min-w-0 flex-col gap-1 rounded-[14px] border border-line-default bg-surface px-4 pt-3.5 pb-2";
  return (
    <ResponsiveTableFrame className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,460px),1fr))] items-start gap-4">
      <ErrorNote error={data.error} />
      <section className={section}>
        <h2 className="m-0 pb-1 text-sm font-semibold text-fg-strong">{t("alerts.incidents")}</h2>
        {data.data && !all.length ? <p className="m-0 py-2 text-[13px] text-fg-muted">{t("alerts.noneRecent")}</p> : null}
        {all.map((a) => (
          <AlertRow
            key={a.id}
            a={a}
            t={t}
            state={stateOf(t, a)}
            onAck={a.resolvedAt ? undefined : () => void client.alerts!.ack(a.id).then(() => (toast(t("alerts.acked")), setN((v) => v + 1)))}
          />
        ))}
      </section>
      <section className={section}>
        <div className="flex flex-col gap-0.5 pb-1">
          <h2 className="m-0 text-sm font-semibold text-fg-strong">{t("alerts.rules")}</h2>
          <span className="text-xs text-fg-muted">{t("alerts.rulesHint")}</span>
        </div>
        {(data.data?.rules ?? []).map((r) => (
          <ResponsiveGridRow primary={1} labels={[t("table.severity"), null, null]} key={r.rule} className="flex items-center gap-3 border-b border-line-subtle py-2.5 last:border-b-0">
            <span className={cn("inline-flex h-5 w-12 shrink-0 items-center justify-center rounded-xs border text-[11px] font-semibold", SEV[r.severity])}>{t(`alerts.severity.${r.severity}`)}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[13px] font-medium text-fg-strong">{t(`alerts.rule.${r.rule}.label`)}</span>
              <span className="truncate text-xs text-fg-muted">{t(`alerts.rule.${r.rule}.cond`)}</span>
            </span>
            <button
              type="button"
              aria-pressed={r.enabled}
              disabled={busy === r.rule}
              onClick={() => {
                setBusy(r.rule);
                void client
                  .alerts!.setRule(r.rule, !r.enabled)
                  .then(
                    (saved) => (toast(t("alerts.ruleSaved", { state: saved.enabled ? t("alerts.on").toLowerCase() : t("alerts.off").toLowerCase(), rule: t(`alerts.rule.${r.rule}.label`) })), setN((v) => v + 1)),
                    (err: unknown) => toast(errorMessage(err), { tone: "error" }),
                  )
                  .finally(() => setBusy(null));
              }}
              className={cn(
                "h-7 min-w-[52px] cursor-pointer rounded-full border px-3 text-xs font-semibold outline-none focus-visible:focus-ring disabled:opacity-60",
                r.enabled ? "border-fg-strong bg-fg-strong text-canvas" : "border-line-default text-fg-muted hover:text-fg-strong",
              )}
            >
              {r.enabled ? t("alerts.on") : t("alerts.off")}
            </button>
          </ResponsiveGridRow>
        ))}
      </section>
    </ResponsiveTableFrame>
  );
}
