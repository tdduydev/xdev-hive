// Máy này: what this machine is doing (hub link, load, memory, disk) and the app on it (version, update).
import { useState, type ReactNode } from "react";
import { Download } from "lucide-react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Badge, ErrorNote, Page, PageHeader, StatusDot } from "@xdev-hive/ui-kit/components/common";
import { useT } from "@xdev-hive/ui";
import { useHive, usePoll, useQuery } from "@xdev-hive/ui/hooks";
import { useStartStatus } from "@xdev-hive/ui/pages/Start";
import { formatBytes, loadPercent, percentOf, uptimeParts } from "../machine-format.ts";

/** A labelled figure with an optional bar: the bar is decoration, the text carries the value. */
function Meter({ label, value, detail, percent }: { label: string; value: string; detail?: string; percent: number | null }) {
  const high = percent !== null && percent >= 85;
  return (
    <div className="flex flex-col gap-1.5" data-meter={label}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-fg-secondary">{label}</span>
        <span className="font-mono text-sm text-fg-strong">{value}</span>
      </div>
      {percent !== null ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
          <div className={high ? "h-full bg-warning-solid" : "h-full bg-primary"} style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
      ) : null}
      {detail ? <span className="text-xs text-fg-muted">{detail}</span> : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-fg-secondary">{label}</span>
      <span className="min-w-0 truncate text-right text-fg-strong">{children}</span>
    </div>
  );
}

export function MachinePage() {
  const { client, me } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const tick = usePoll(5000);
  const slow = usePoll(15_000);
  const settings = useQuery(() => desktop.settings(), [desktop]);
  const info = useQuery(() => desktop.appInfo(), [desktop]);
  const link = useQuery(() => desktop.hubStatus(), [desktop, tick]);
  const update = useQuery(() => desktop.updateStatus().catch(() => null), [desktop, tick]);
  const stats = useQuery(async () => (desktop.machineStats ? desktop.machineStats() : null), [desktop, slow]);
  const runs = useQuery(async () => desktop.runsCount?.() ?? null, [desktop, tick]);
  const [installing, setInstalling] = useState(false);
  const start = useStartStatus();

  const ok = link.data?.ok ?? null;
  const unreachable = link.data?.code === "unavailable";
  const tone = ok === null ? "neutral" : ok ? "ok" : unreachable ? "warn" : "danger";
  const up = update.data;
  const s = stats.data;
  const mem = s ? s.memTotal - s.memFree : null;
  const disk = s && s.diskTotal !== null && s.diskFree !== null ? s.diskTotal - s.diskFree : null;
  const upt = s ? uptimeParts(s.uptime) : null;

  const install = () => {
    setInstalling(true);
    // Other kinds quit and relaunch; a deb only opens the system installer, which the person may also cancel.
    void desktop.installUpdate().then(() => { if (up?.updateKind === "deb") setInstalling(false); }, () => setInstalling(false));
  };

  return (
    <Page>
      <PageHeader title={t("desk.nav.machine")} subtitle={settings.data?.machine ?? t("desk.sub.machine")} />
      <ErrorNote error={settings.error ?? link.error ?? stats.error} />
      {/* What is left of the first-run guide: the machine is not ready until it is done. */}
      {start.data?.remaining ? (
        <Button variant="outline" className="h-auto min-h-[var(--control-h-touch)] w-full justify-start whitespace-normal text-left" onClick={() => { window.location.hash = "/start"; }}>
          {t("start.reminder", { count: start.data.remaining })}
        </Button>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2" data-machine-page>
        <Card data-card="hub">
          <CardHeader><CardTitle>{t("desk.machine.hub")}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-center gap-2" data-hub-status={ok === null ? "unknown" : ok ? "ok" : "down"}>
              <StatusDot tone={tone} />
              <span className="text-sm">{ok === null ? t("desk.machine.hubUnknown") : ok ? t("desk.machine.hubOk") : t("desk.machine.hubDown")}</span>
              {ok === true ? null : (
                <Button size="sm" variant="ghost" onClick={() => void desktop.hubRetry().then(link.reload, link.reload)}>{t("shell.retry")}</Button>
              )}
            </div>
            {link.data?.error && ok === false ? <p className="text-xs break-words text-fg-muted">{link.data.error}</p> : null}
            <Row label={t("desk.machine.machineName")}>{settings.data?.machine ?? "—"}</Row>
            <Row label="Hub">{settings.data?.hubUrl ?? "—"}</Row>
            <Row label={t("desk.machine.account")}>{me.user?.displayName ?? me.user?.username ?? "—"}</Row>
            <Row label={t("desk.machine.runs")}>{runs.data ? (runs.data.running ? String(runs.data.running) : t("desk.machine.runsNone")) : "—"}</Row>
          </CardContent>
        </Card>

        <Card data-card="resources">
          <CardHeader><CardTitle>{t("desk.machine.resources")}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-4">
            {s ? (
              <>
                <Meter
                  label={t("desk.machine.cpu")}
                  value={s.load === null ? "—" : `${loadPercent(s.load)}%`}
                  detail={s.load === null ? t("desk.machine.cpuNone") : `${t("desk.machine.cores", { count: s.cpuCount })}${s.cpuModel ? ` · ${s.cpuModel}` : ""}`}
                  percent={loadPercent(s.load)}
                />
                <Meter label={t("desk.machine.ram")} value={t("desk.machine.used", { used: formatBytes(mem), total: formatBytes(s.memTotal) })} percent={percentOf(mem, s.memTotal)} />
                <Meter
                  label={t("desk.machine.disk")}
                  value={disk === null ? t("desk.machine.diskNone") : t("desk.machine.used", { used: formatBytes(disk), total: formatBytes(s.diskTotal) })}
                  detail={s.diskFree === null ? undefined : t("desk.machine.diskFree", { free: formatBytes(s.diskFree), total: formatBytes(s.diskTotal) })}
                  percent={percentOf(disk, s.diskTotal)}
                />
                {upt ? <Row label={t("desk.machine.uptime")}>{upt.days > 0 ? t("desk.machine.days", upt) : t("desk.machine.hours", { hours: upt.hours, minutes: upt.minutes })}</Row> : null}
              </>
            ) : (
              <p className="text-sm text-fg-muted">{stats.loading ? "…" : t("desk.machine.diskNone")}</p>
            )}
          </CardContent>
        </Card>

        <Card data-card="app" className="md:col-span-2">
          <CardHeader><CardTitle>{t("desk.machine.app")}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Row label={t("desk.machine.version")}>{info.data ? `v${info.data.version}` : "—"}</Row>
            <Row label={t("desk.machine.platform")}>{info.data?.platform ?? "—"}</Row>
            <div className="flex flex-wrap items-center gap-3" data-update-state={up?.state ?? "unknown"}>
              <span className="text-sm text-fg-secondary">{t("desk.machine.update")}</span>
              {up?.state === "downloading" && up.version ? <Badge tone="info">{t("desk.machine.updateDownloading", { version: up.version, percent: up.percent ?? 0 })}</Badge> : null}
              {up?.state === "failed" ? <Badge tone="danger">{t("desk.machine.updateFailed")}</Badge> : null}
              {up && up.supported === false ? <Badge tone="neutral">{t("desk.machine.updateUnsupported")}</Badge> : null}
              {up?.state === "ready" && up.version ? (
                <>
                  <Badge tone="ok">{t("desk.machine.updateReady", { version: up.version })}</Badge>
                  <Button size="sm" onClick={install} disabled={installing || up.idleState === "waiting"} title={up.notes ?? undefined}>
                    <Download aria-hidden="true" />
                    {t("desk.machine.updateInstall")}
                  </Button>
                </>
              ) : null}
              {up && (up.state === "idle" || up.state === "installing") && up.supported !== false ? <span className="text-sm text-fg-muted">{t("desk.machine.updateNone")}</span> : null}
            </div>
            {up?.state === "failed" && up.error ? <p className="text-xs break-words text-fg-muted">{up.error}</p> : null}
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}
