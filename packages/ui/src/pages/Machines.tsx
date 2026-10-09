import { ResponsiveTable as Table, ResponsiveTableRow as TableRow } from "#ui/components/ResponsiveTable.tsx";
import { useEffect, useMemo, useState } from "react";
import { cacheReadShare, type CompressionCompare, type CompressionSide, type CostSummary, type CostTotals, type RunTokens } from "@xdev-hive/core";
import { TableBody, TableCell, TableHead, TableHeader } from "@xdev-hive/ui/components/ui/table";
import { Empty, ErrorNote, Notice, Page } from "#ui/components/common.tsx";
import { formatCount, formatTime, formatUsd, hashParam, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { rich, useT } from "#ui/i18n/index.tsx";
import { mapMachines, withFixtureSystem } from "#ui/lib/agentmap.ts";
import { scopeFilter, scopeKey } from "#ui/lib/scope.ts";
import { Skeleton } from "#ui/components/ui/skeleton.tsx";
import { AgentMap } from "#ui/pages/AgentMap.tsx";

/** How often the map asks the hub again while it is on screen (machines report every 30 s, runs as they go). */
const MAP_REFRESH_MS = 5000;

/** Whether the page is in view (not a hidden tab or a minimised window). */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

const CODE = "rounded bg-muted px-1 py-0.5 font-mono text-xs";

export function MachinesPage() {
  const { client, scope } = useHive();
  const t = useT();
  // Every few seconds while the page is in view: the map shows what agents do now.
  const visible = usePageVisible();
  const poll = usePoll(visible ? MAP_REFRESH_MS : null);
  const [tick, setTick] = useState(0);
  const key = scopeKey(scope);
  const deps = [client, key, tick, poll];
  const machines = useQuery(() => client.call("machines.list", {}), deps);
  const cooldowns = useQuery(() => client.call("cooldowns.list", {}), deps);
  const runs = useQuery(() => client.call("runs.list", { ...scopeFilter(scope), limit: 200 }), deps);
  const requests = useQuery(() => client.call("runs.requests", { ...scopeFilter(scope), limit: 200 }), deps);
  // A hub from before batches (31a) has no such method: none then.
  const groups = useQuery(() => client.call("runs.groups", { ...scopeFilter(scope), limit: 30 }).catch(() => []), deps);

  const reload = () => setTick((n) => n + 1);
  const shown = useMemo(() => withFixtureSystem(mapMachines(machines.data ?? [], scope), hashParam("e2e") === "machine-system" && sessionStorage.getItem("hive-e2e-fixtures") === "1"), [machines.data, scope]);

  return (
    <Page wide className="gap-0">
      <p className="m-0 mb-5 max-w-[760px] text-[14px]/[22px] font-medium text-fg-secondary [text-wrap:pretty]">{t("agentMap.pageHint")}</p>

      <section className="flex flex-col gap-3">
        <ErrorNote error={machines.error ?? runs.error ?? requests.error ?? cooldowns.error} />
        {!machines.data && machines.loading ? <div role="status" aria-label={t("common.loading")} className="grid gap-3 md:grid-cols-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-48 rounded-xl" />)}</div> : null}
        {machines.data?.length === 0 ? <Empty>{t("machines.none")}</Empty> : null}
        {machines.data?.length && !shown.length ? <Empty>{t("agentMap.noneInScope")}</Empty> : null}
        {machines.data?.some((m) => m.duplicate) ? (
          <Notice tone="warn">
            <p>
              {rich(t("machines.duplicateHint"), {
                field: <code className={CODE}>machine</code>,
                file: <code className={`${CODE} break-all`}>~/.xdev-hive/config.json</code>,
              })}
            </p>
          </Notice>
        ) : null}
        {shown.length ? (
          <AgentMap machines={shown} cooldowns={cooldowns.data ?? []} runs={runs.data ?? []} requests={requests.data ?? []} groups={groups.data ?? []} onChanged={reload} />
        ) : null}
      </section>

    </Page>
  );
}

/** The share of input read from the prompt cache (roadmap 28c), "—" when the runs did not say. */
export function cacheText(tok: RunTokens | undefined): string {
  const share = tok ? cacheReadShare(tok) : null;
  return share === null ? "—" : `${Math.round(share * 100)}%`;
}

export function tokensTitle(t: ReturnType<typeof useT>, tok: RunTokens | undefined): string {
  if (!tok) return "";
  const n = (v: number | null) => (v === null ? "?" : formatCount(v));
  return t("machines.tokensTitle", { input: n(tok.inputTokens), write: n(tok.cacheWriteTokens), read: n(tok.cacheReadTokens), output: n(tok.outputTokens) });
}

export function Costs({ summary: s }: { summary: CostSummary }) {
  const t = useT();
  if (s.total.runs30 === 0) return <Empty>{t("machines.noCosts")}</Empty>;
  const cells = (c: CostTotals) => (
    <>
      <TableCell className="text-right tabular-nums">{formatUsd(c.usd1)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatUsd(c.usd7)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatUsd(c.usd30)}</TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">{formatCount(c.runs30)}</TableCell>
      <TableCell className="text-right tabular-nums" title={tokensTitle(t, c.tokens30)}>
        {cacheText(c.tokens30)}
      </TableCell>
    </>
  );
  const heads = (
    <>
      <TableHead className="text-right">{t("machines.col24h")}</TableHead>
      <TableHead className="text-right">{t("machines.col7d")}</TableHead>
      <TableHead className="text-right">{t("machines.col30d")}</TableHead>
      <TableHead className="text-right">{t("machines.colRunCount")}</TableHead>
      <TableHead className="text-right" title={t("machines.colCacheHint")}>
        {t("machines.colCache")}
      </TableHead>
    </>
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">
        {t("machines.costTotal", { day: formatUsd(s.total.usd1), week: formatUsd(s.total.usd7), month: formatUsd(s.total.usd30), runs: formatCount(s.total.runs30) })}
        {s.total.tokens30?.cacheReadTokens != null ? ` · ${t("machines.cacheTotal", { share: cacheText(s.total.tokens30) })}` : ""}
      </p>
      <div className="grid gap-3 xl:grid-cols-2">
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("machines.colProject")}</TableHead>
                {heads}
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.projects.map((p) => (
                <TableRow key={p.project}>
                  <TableCell className="font-mono text-xs">{p.project}</TableCell>
                  {cells(p)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("machines.colProfile")}</TableHead>
                {heads}
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.profiles.map((p) => (
                <TableRow key={`${p.machine}/${p.profileId}/${p.account ?? ""}`}>
                  <TableCell className="whitespace-normal">
                    <div className="font-mono text-xs">{p.profileId}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.machine}
                      {p.account ? ` · ${p.account}` : ""}
                    </div>
                  </TableCell>
                  {cells(p)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
      {s.compression?.length ? <CompressionTable rows={s.compression} /> : null}
    </div>
  );
}

/**
 * Runs with RTK beside those without (roadmap 28d), by project and role over 30 days: what the admin reads before
 * turning RTK on by default. Shown once some run had RTK.
 */
function CompressionTable({ rows }: { rows: CompressionCompare[] }) {
  const t = useT();
  const n = (v: number | null) => (v === null ? "—" : formatCount(Math.round(v)));
  const side = (c: CompressionSide) => (
    <>
      <TableCell className="text-right tabular-nums">{`${formatCount(c.runs)} (${formatCount(c.failed)})`}</TableCell>
      <TableCell className="text-right tabular-nums">{n(c.inputAvg)}</TableCell>
      <TableCell className="text-right tabular-nums">{n(c.outputAvg)}</TableCell>
      <TableCell className="text-right tabular-nums">{c.cacheShare === null ? "—" : `${Math.round(c.cacheShare * 100)}%`}</TableCell>
      <TableCell className="text-right tabular-nums">{c.costAvg === null ? "—" : formatUsd(c.costAvg)}</TableCell>
    </>
  );
  const heads = (
    <>
      <TableHead className="text-right">{t("machines.rtkRuns")}</TableHead>
      <TableHead className="text-right">{t("machines.rtkInput")}</TableHead>
      <TableHead className="text-right">{t("machines.rtkOutput")}</TableHead>
      <TableHead className="text-right">{t("machines.colCache")}</TableHead>
      <TableHead className="text-right">{t("machines.rtkCost")}</TableHead>
    </>
  );
  return (
    <div className="flex flex-col gap-2" data-testid="rtk-compare">
      <p className="text-sm font-medium">{t("machines.rtkTitle")}</p>
      <p className="text-xs text-muted-foreground">{t("machines.rtkHint")}</p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead rowSpan={2}>{t("machines.colProject")}</TableHead>
              <TableHead rowSpan={2}>{t("machines.rtkRole")}</TableHead>
              <TableHead colSpan={5} className="text-center">
                {t("machines.rtkWith")}
              </TableHead>
              <TableHead colSpan={5} className="text-center">
                {t("machines.rtkWithout")}
              </TableHead>
            </TableRow>
            <TableRow>
              {heads}
              {heads}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={`${r.project}/${r.role}`}>
                <TableCell className="font-mono text-xs">{r.project}</TableCell>
                <TableCell className="text-xs">{r.role}</TableCell>
                {side(r.rtk)}
                {side(r.plain)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}


