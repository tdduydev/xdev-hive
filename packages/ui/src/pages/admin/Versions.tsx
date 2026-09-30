// Phiên bản app (docs/design/2026-09-redesign, xDev Hive Web Admin): which desktop build machines should run, how
// fast it rolls out, how they install it, and the builds the hub holds (roadmap 22i).
import { useMemo, useState, type ReactNode } from "react";
import { cn } from "cn";
import { compareVersions, INSTALL_WHEN, type AppRollout, type MachineUpdate } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Switch } from "@xdev-hive/ui/components/ui/switch";
import { DataTable, type Column } from "../../components/DataTable.tsx";
import { Empty, ErrorNote } from "../../components/common.tsx";
import { Chip, type ChipKind } from "../../components/panes.tsx";
import { DocMarkdown } from "../../components/DocMarkdown.tsx";
import { formatTime, useAction, useHive, useQuery } from "../../hooks.ts";
import { useT } from "../../i18n/index.tsx";
import { useToast } from "../../shell/toast.tsx";

const COLORS = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5", "bg-chart-6"];

function Pills<T extends string | number>({ value, options, onPick, disabled }: { value: T; options: Array<[T, ReactNode]>; onPick: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map(([v, label]) => (
        <button
          key={String(v)}
          type="button"
          disabled={disabled}
          aria-pressed={value === v}
          onClick={() => value !== v && onPick(v)}
          className={cn(
            "h-7 cursor-pointer rounded-full border px-3 text-xs font-semibold outline-none focus-visible:focus-ring disabled:cursor-default",
            value === v ? "border-line-selected bg-selected text-selected-fg" : "border-line-default bg-surface text-fg-secondary hover:text-fg-strong",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-56 shrink-0 text-[13px] text-fg-muted">{label}</span>
      {children}
    </div>
  );
}

export function OpsVersions() {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const [tick, setTick] = useState(0);
  const data = useQuery(async () => (client.releases ? client.releases.list() : null), [client, tick]);
  const action = useAction();
  const rollout = data.data?.rollout;
  const releases = data.data?.releases ?? [];
  const machines = data.data?.machines ?? [];
  const save = (patch: Partial<AppRollout>) =>
    void action.run(async () => {
      await client.releases!.setRollout(patch);
      toast(t("ops.versions.saved"));
      setTick((n) => n + 1);
    });

  const target = rollout?.target ?? null;
  const counts = useMemo(() => {
    const by = new Map<string, number>();
    for (const m of machines) by.set(m.current, (by.get(m.current) ?? 0) + 1);
    return [...by.entries()].sort((a, b) => compareVersions(b[0], a[0]));
  }, [machines]);
  const onTarget = target ? machines.filter((m) => m.current === target).length : 0;
  const stateOf = (m: MachineUpdate): { label: string; kind: ChipKind } => {
    if (target && m.current === target) return { label: t("ops.versions.state.current"), kind: "success" };
    if (m.state === "downloading") return { label: t("ops.versions.state.downloading", { percent: m.percent ?? 0 }), kind: "running" };
    if (m.state === "ready") return { label: t("ops.versions.state.ready"), kind: "info" };
    if (m.state === "installing") return { label: t("ops.versions.state.installing"), kind: "info" };
    if (m.state === "failed") return { label: t("ops.versions.state.failed"), kind: "danger" };
    return { label: target ? t("ops.versions.state.idle") : t("ops.versions.state.none"), kind: "neutral" };
  };
  const columns: Array<Column<MachineUpdate>> = [
    { key: "machine", label: t("ops.versions.col.machine"), width: "minmax(180px,1fr)", mono: true, strong: true, render: (m) => m.machine, sortValue: (m) => m.machine },
    { key: "current", label: t("ops.versions.col.current"), width: "110px", mono: true, render: (m) => m.current, sortValue: (m) => m.current },
    { key: "target", label: t("ops.versions.col.target"), width: "110px", mono: true, render: () => target ?? "—" },
    { key: "state", label: t("ops.versions.col.state"), width: "160px", render: (m) => <Chip kind={stateOf(m).kind}>{stateOf(m).label}</Chip>, title: (m) => m.error ?? undefined },
    { key: "seen", label: t("ops.versions.col.seen"), width: "130px", align: "right", render: (m) => formatTime(m.updatedAt), sortValue: (m) => m.updatedAt },
  ];

  if (!client.releases) return null;
  return (
    <div className="flex flex-col gap-4">
      <ErrorNote error={data.error ?? action.error} />
      {rollout ? (
        <section className="flex flex-col gap-3.5 rounded-[14px] border border-line-default bg-surface p-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-xs text-fg-muted">{t("ops.versions.rollout")}</span>
            <span className="font-mono text-2xl font-bold text-fg-strong">{target ?? "—"}</span>
            {target ? <span className="text-xs text-fg-muted">{t("ops.versions.channel", { channel: releases.find((r) => r.version === target)?.channel ?? "stable" })}</span> : null}
            {rollout.paused ? <Chip kind="warning">{t("ops.versions.paused")}</Chip> : null}
            <span className="ml-auto text-xs text-fg-muted">
              {target
                ? t("ops.versions.progress", {
                    downloading: machines.filter((m) => m.state === "downloading").length,
                    ready: machines.filter((m) => m.state === "ready").length,
                    current: onTarget,
                  })
                : t("ops.versions.noTarget")}
            </span>
          </div>
          <Row label={t("ops.versions.percent")}>
            <Pills value={rollout.percent} disabled={action.busy} onPick={(percent) => save({ percent })} options={[10, 25, 50, 75, 100].map((p) => [p, `${p}%`])} />
            <Button size="sm" variant="outline" disabled={action.busy || !target} onClick={() => save({ paused: !rollout.paused })}>
              {rollout.paused ? t("ops.versions.resume") : t("ops.versions.pause")}
            </Button>
          </Row>
          <Row label={t("ops.versions.autoDownload")}>
            <Switch checked={rollout.autoDownload} disabled={action.busy} onCheckedChange={(v) => save({ autoDownload: v })} aria-label={t("ops.versions.autoDownload")} />
            <span className="text-xs text-fg-muted">{rollout.autoDownload ? t("ops.versions.on") : t("ops.versions.off")}</span>
          </Row>
          <Row label={t("ops.versions.installWhen")}>
            <Pills value={rollout.installWhen} disabled={action.busy} onPick={(installWhen) => save({ installWhen })} options={INSTALL_WHEN.map((w) => [w, t(`ops.versions.when.${w}`)])} />
          </Row>
          <Row label={t("ops.versions.minVersion")}>
            <Pills
              value={rollout.minVersion ?? ""}
              disabled={action.busy}
              onPick={(v) => save({ minVersion: v || null })}
              options={[["", t("ops.versions.noMin")] as [string, ReactNode], ...releases.filter((r) => r.channel === "stable").slice(0, 4).map((r) => [r.version, r.version] as [string, ReactNode])]}
            />
          </Row>
        </section>
      ) : null}
      {counts.length ? (
        <section className="flex flex-col gap-2.5 rounded-[14px] border border-line-default bg-surface p-4">
          <h2 className="m-0 text-sm font-semibold text-fg-strong">{t("ops.versions.distribution")}</h2>
          <div className="flex h-3.5 overflow-hidden rounded-full bg-sunken">
            {counts.map(([v, n], i) => (
              <span key={v} title={`${v}: ${n}`} className={COLORS[i % COLORS.length]} style={{ width: `${(n / machines.length) * 100}%` }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-fg-muted">
            {counts.map(([v, n], i) => (
              <span key={v} className="flex items-center gap-1.5">
                <span className={cn("size-2 rounded-xs", COLORS[i % COLORS.length])} />
                <span className="font-mono text-fg-strong">{v}</span> {n}
              </span>
            ))}
          </div>
        </section>
      ) : null}
      {machines.length ? <DataTable rows={machines} columns={columns} rowKey={(m) => m.machineId} noun={t("ops.versions.noun")} searchText={(m) => `${m.machine} ${m.current}`} maxHeight="52vh" /> : null}
      <h2 className="m-0 mt-1 text-sm font-semibold text-fg-strong">{t("ops.versions.releases")}</h2>
      {data.data && !releases.length ? <Empty>{t("ops.versions.noReleases")}</Empty> : null}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] items-start gap-3">
        {releases.map((r) => (
          <section key={r.version} className="flex flex-col gap-2.5 rounded-xl border border-line-default bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-base font-bold text-fg-strong">{r.version}</span>
              <Chip kind={r.channel === "stable" ? "success" : "warning"}>{r.channel}</Chip>
              <span className="text-xs text-fg-muted">{formatTime(r.createdAt)}</span>
              <span className="ml-auto">
                {r.version === target ? (
                  <Chip kind="info">{t("ops.versions.isTarget")}</Chip>
                ) : r.channel === "stable" ? (
                  <Button size="xs" variant="outline" disabled={action.busy || !r.files.length} onClick={() => save({ target: r.version, paused: false })}>
                    {t("ops.versions.setTarget")}
                  </Button>
                ) : null}
              </span>
            </div>
            {r.notes ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-fg-muted">{t("ops.versions.notes")}</summary>
                <div className="mt-2 max-h-60 overflow-y-auto [&_p]:text-[13px]">
                  <DocMarkdown text={r.notes} />
                </div>
              </details>
            ) : null}
            <div className="flex flex-wrap gap-1">
              {r.files.map((f) => (
                <span key={f.id} title={`${f.sha256} · ${(f.size / 1e6).toFixed(0)} MB`} className="rounded-xs border border-line-subtle bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-fg-secondary">
                  {f.platform}-{f.arch}.{f.kind}
                </span>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
