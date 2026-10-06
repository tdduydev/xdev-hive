// The lifecycle gates of the policy page (roadmap 34a): the hub's ceiling, then one row per project, each gate a person,
// an agent's check, or on its own. A project picks within the ceiling; Hiệu lực is what its flows do now.
import { useMemo, useState } from "react";
import { GATE_MODES, SDLC_GATES, type GateMode, type GateModes, type SdlcGate } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/components/ui/table";
import { ErrorNote } from "#ui/components/common.tsx";
import { formatTime, useAction, useCan, useHive, useProjects, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

/** The hub's row; "@" is not allowed in a project name. */
const HUB = "@hub";
const rank = (m: GateMode) => GATE_MODES.indexOf(m);

interface Draft {
  gates: Partial<GateModes>;
  maxFixRounds: string;
  maxParallel: string;
}

export function SdlcGatesCard({ editableOnly = false, hubOnly = false }: { editableOnly?: boolean; hubOnly?: boolean }) {
  const { client, me } = useHive();
  const t = useT();
  const can = useCan();
  const known = useProjects();
  const [tick, setTick] = useState(0);
  const view = useQuery(() => client.call("sdlc.get", {}), [client, tick]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const action = useAction();
  const hubAdmin = me.role === "admin" && !me.access;
  const projects = useMemo(() => {
    const names = new Set<string>([...known, ...Object.keys(view.data?.projects ?? {})]);
    return [...names].filter((p) => !editableOnly || can(p, "projectSettings")).sort();
  }, [known, view.data, editableOnly, can]);

  if (!view.data) return <ErrorNote error={view.error} />;
  const data = view.data;
  const draftOf = (key: string): Draft => {
    if (drafts[key]) return drafts[key];
    if (key === HUB) return { gates: data.ceiling, maxFixRounds: "", maxParallel: "" };
    const p = data.projects[key];
    return { gates: p?.gates ?? {}, maxFixRounds: String(p?.maxFixRounds ?? 2), maxParallel: p?.maxParallel ? String(p.maxParallel) : "" };
  };
  const ceiling = { ...data.ceiling, ...(drafts[HUB]?.gates ?? {}) } as GateModes;
  const edit = (key: string, next: Partial<Draft>) => {
    setSaved(null);
    setDrafts((d) => ({ ...d, [key]: { ...draftOf(key), ...next } }));
  };
  const save = (key: string) =>
    void action.run(async () => {
      const d = draftOf(key);
      if (key === HUB) await client.call("sdlc.setCeiling", { ceiling: d.gates });
      else {
        const fix = Number.parseInt(d.maxFixRounds, 10);
        const parallel = Number.parseInt(d.maxParallel, 10);
        await client.call("sdlc.setProject", {
          project: key,
          settings: { gates: d.gates, ...(Number.isFinite(fix) ? { maxFixRounds: fix } : {}), maxParallel: Number.isFinite(parallel) ? parallel : null },
        });
      }
      setDrafts(({ [key]: _done, ...rest }) => rest);
      setSaved(key);
      setTick((n) => n + 1);
    });

  const row = (key: string) => {
    const isHub = key === HUB;
    const d = draftOf(key);
    const editable = isHub ? hubAdmin : can(key, "projectSettings");
    const modeOf = (g: SdlcGate): GateMode => d.gates[g] ?? (isHub ? "auto" : "human");
    return (
      <TableRow key={key} data-sdlc-row={isHub ? "hub" : key}>
        <TableCell className="align-top font-mono text-xs">{isHub ? <span className="font-sans font-medium">{t("sdlc.hubCeiling")}</span> : key}</TableCell>
        {SDLC_GATES.map((g) => {
          const mode = modeOf(g);
          // A project's choice above the ceiling stays stored, but runs at the ceiling: say so next to it.
          const held = !isHub && rank(mode) > rank(ceiling[g]);
          return (
            <TableCell key={g} className="align-top">
              <NativeSelect
                size="sm"
                wrapperClassName="min-w-32"
                value={mode}
                disabled={!editable}
                aria-label={`${t(`sdlc.gate.${g}`)} · ${key === HUB ? t("sdlc.hubCeiling") : key}`}
                data-sdlc-gate={g}
                onChange={(e) => edit(key, { gates: { ...d.gates, [g]: e.target.value as GateMode } })}
              >
                {GATE_MODES.map((m) => (
                  <NativeSelectOption key={m} value={m} disabled={!isHub && rank(m) > rank(ceiling[g])}>
                    {t(`sdlc.mode.${m}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              {held ? <div className="mt-1 text-[11px] text-warning">{t("sdlc.heldTo", { mode: t(`sdlc.mode.${ceiling[g]}`) })}</div> : null}
            </TableCell>
          );
        })}
        <TableCell className="align-top">
          {isHub ? null : (
            <div className="flex min-w-32 flex-col gap-1.5">
              <label className="flex items-center gap-1.5 text-xs">
                <span className="w-16 shrink-0 text-muted-foreground">{t("sdlc.maxFixRounds")}</span>
                <Input className="h-7 w-14 text-xs" inputMode="numeric" value={d.maxFixRounds} disabled={!editable} onChange={(e) => edit(key, { maxFixRounds: e.target.value.replace(/\D/g, "") })} />
              </label>
              <label className="flex items-center gap-1.5 text-xs">
                <span className="w-16 shrink-0 text-muted-foreground">{t("sdlc.maxParallel")}</span>
                <Input className="h-7 w-14 text-xs" inputMode="numeric" placeholder="∞" value={d.maxParallel} disabled={!editable} onChange={(e) => edit(key, { maxParallel: e.target.value.replace(/\D/g, "") })} />
              </label>
            </div>
          )}
        </TableCell>
        <TableCell className="align-top">
          {editable ? (
            <Button size="sm" variant="outline" disabled={action.busy || !drafts[key]} onClick={() => save(key)} data-sdlc-save={isHub ? "hub" : key}>
              {t("sdlc.save")}
            </Button>
          ) : null}
          {saved === key ? <div className="mt-1 text-xs text-success">{t("sdlc.saved")}</div> : null}
        </TableCell>
      </TableRow>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("sdlc.title")}</CardTitle>
        <CardDescription>{t("sdlc.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ul className="m-0 list-disc pl-5 text-xs text-muted-foreground">
          {GATE_MODES.map((m) => (
            <li key={m}>
              <b className="font-medium text-fg-strong">{t(`sdlc.mode.${m}`)}</b>: {t(`sdlc.modeHint.${m}`)}
            </li>
          ))}
        </ul>
        <div className="overflow-x-auto rounded-lg border">
          <Table className="min-w-[78rem]">
            <TableHeader>
              <TableRow>
                <TableHead>{t("sdlc.colProject")}</TableHead>
                {SDLC_GATES.map((g) => (
                  <TableHead key={g} title={t(`sdlc.gateHint.${g}`)}>
                    {t(`sdlc.gate.${g}`)}
                  </TableHead>
                ))}
                <TableHead>{t("sdlc.colLimits")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {editableOnly && !hubAdmin ? null : row(HUB)}
              {hubOnly ? null : projects.map(row)}
            </TableBody>
          </Table>
        </div>
        {data.updatedAt ? <span className="text-xs text-muted-foreground">{t("admin.policyUpdated", { time: formatTime(data.updatedAt), who: data.updatedBy ?? "" })}</span> : null}
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
  );
}
