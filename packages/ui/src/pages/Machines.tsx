import { useEffect, useState } from "react";
import type { Machine, QuotaCooldown } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/components/ui/table";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader, STATUS_TONE } from "../components/common.tsx";
import { formatTime, useAction, useHive, useQuery } from "../hooks.ts";
import { rich, useT } from "../i18n/index.tsx";

const REFRESH_MS = 15_000;

const CODE = "rounded bg-muted px-1 py-0.5 font-mono text-xs";

export function MachinesPage() {
  const { client } = useHive();
  const t = useT();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const machines = useQuery(() => client.call("machines.list", {}), [client, tick]);
  const cooldowns = useQuery(() => client.call("cooldowns.list", {}), [client, tick]);
  const reload = () => setTick((n) => n + 1);

  return (
    <Page>
      <PageHeader title={t("nav.machines")} subtitle={t("machines.subtitle")} />

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">{t("machines.machines")}</h2>
        <ErrorNote error={machines.error} />
        {machines.data?.length === 0 ? <Empty>{t("machines.none")}</Empty> : null}
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
        {machines.data?.length ? (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("machines.colMachine")}</TableHead>
                  <TableHead>{t("machines.colStatus")}</TableHead>
                  <TableHead>{t("machines.colRuns")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {machines.data.map((m) => (
                  <MachineRow key={m.id} machine={m} onChanged={reload} />
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">{t("machines.cooldowns")}</h2>
        <ErrorNote error={cooldowns.error} />
        {cooldowns.data?.length === 0 ? <Empty>{t("machines.noCooldowns")}</Empty> : null}
        {cooldowns.data?.length ? (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("machines.colAccount")}</TableHead>
                  <TableHead>{t("machines.colUntil")}</TableHead>
                  <TableHead>{t("machines.colReason")}</TableHead>
                  <TableHead>{t("machines.colReportedBy")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {cooldowns.data.map((c) => (
                  <CooldownRow key={c.account} cooldown={c} onChanged={reload} />
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </section>
    </Page>
  );
}

function MachineRow({ machine: m, onChanged }: { machine: Machine; onChanged: () => void }) {
  const { client, me } = useHive();
  const t = useT();
  const action = useAction();
  const running = m.runs.filter((r) => r.status === "running");
  const queued = m.runs.length - running.length;
  return (
    <TableRow>
      <TableCell className="align-top whitespace-normal">
        <div className="flex min-w-40 flex-col gap-0.5">
          <span className="font-mono font-semibold break-all">{m.machine}</span>
          <span className="font-mono text-xs break-all text-muted-foreground">{m.id}</span>
          {m.version ? <span className="text-xs text-muted-foreground">v{m.version}</span> : null}
        </div>
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-col items-start gap-1">
          <Badge tone={m.duplicate ? "danger" : m.online ? "ok" : "neutral"}>
            {m.duplicate ? t("machineState.duplicate") : m.online ? t("machineState.online") : t("machineState.offline")}
          </Badge>
          <span className="text-xs text-muted-foreground">{t("machines.lastSeen", { time: formatTime(m.lastSeen) })}</span>
        </div>
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <div className="flex min-w-56 flex-col gap-2">
          {running.length === 0 && queued === 0 ? <span className="text-muted-foreground">{t("machines.idle")}</span> : null}
          {running.map((r) => (
            <div key={r.runId} className="flex flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge tone={STATUS_TONE[r.status]}>{t("runStatus.running").toLocaleLowerCase()}</Badge>
                <span className="font-mono text-xs">{r.taskId}</span>
                <span className="min-w-0 break-words">{r.taskTitle}</span>
              </div>
              <div className="text-xs break-words text-muted-foreground">
                {r.project} · {r.profileId ?? "?"} · {t(`agentRole.${r.role}`).toLocaleLowerCase()} · {t("machines.since", { time: formatTime(r.since) })}
              </div>
            </div>
          ))}
          {queued > 0 ? <div className="text-muted-foreground">{t("machines.queued", { count: queued })}</div> : null}
          {!m.online && m.runs.length > 0 ? <div className="text-xs text-muted-foreground">{t("machines.stale")}</div> : null}
          <ErrorNote error={action.error} />
        </div>
      </TableCell>
      <TableCell className="text-right align-top">
        {me.role === "admin" && !m.online ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await client.call("machines.remove", { id: m.id });
                onChanged();
              })
            }
          >
            {t("machines.remove")}
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function CooldownRow({ cooldown: c, onChanged }: { cooldown: QuotaCooldown; onChanged: () => void }) {
  const { client, me } = useHive();
  const t = useT();
  const action = useAction();
  return (
    <TableRow>
      <TableCell className="align-top font-mono text-xs">{c.account}</TableCell>
      <TableCell className="align-top text-muted-foreground">{formatTime(c.until)}</TableCell>
      <TableCell className="align-top whitespace-normal">
        <div className="flex max-w-80 min-w-48 flex-col gap-2">
          <span className="whitespace-pre-wrap wrap-anywhere">{c.reason || <span className="text-muted-foreground">—</span>}</span>
          <ErrorNote error={action.error} />
        </div>
      </TableCell>
      <TableCell className="align-top font-mono text-xs text-muted-foreground">{c.reportedBy}</TableCell>
      <TableCell className="text-right align-top">
        {me.role !== "viewer" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={action.busy}
            title={t("machines.clearHint")}
            onClick={() =>
              void action.run(async () => {
                await client.call("cooldowns.clear", { account: c.account });
                onChanged();
              })
            }
          >
            {t("machines.clear")}
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
