import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Breakdown, coverage, type SdlcItemDetail } from "@xdev-hive/contracts";
import { Alert, AlertDescription, AlertTitle } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { cn } from "cn";
import { X } from "lucide-react";
import { useState } from "react";
import {
  addDependency,
  type EditResult,
  mergeTasks,
  removeDependency,
  setProject,
  splitTask,
  toChecklist,
  waveOf,
} from "./breakdown-edit.ts";
import { DependencyGraph } from "./dependency-graph.tsx";
import { useSdlcEnv, useText } from "./env.tsx";
import { EmptyState } from "./parts.tsx";

export { DependencyGraph, layoutGraph } from "./dependency-graph.tsx";

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 100);

/**
 * Duyệt bản tách task (AppSdlcBreakdown.dc.html): đồ thị theo dự án, gộp/tách, chuyển thành checklist, đổi dự án, sửa
 * phụ thuộc, độ phủ requirement. Bản tách chỉ là cách nhìn tasks.md: lưu là hub ghi lại bản nháp tài liệu, không có
 * bản thứ hai.
 */
export function BreakdownReview({ item }: { item: SdlcItemDetail }) {
  const { api, errorMessage } = useSdlcEnv();
  const t = useText();
  const b = t.breakdown;
  const queryClient = useQueryClient();
  const input = { id: item.id, source: "draft" as const };
  const view = useQuery(api.sdlc.breakdown.get.queryOptions({ input }));
  const [edited, setEdited] = useState<{ revision: number; breakdown: Breakdown } | null>(null);
  const [cycle, setCycle] = useState<string[] | null>(null);
  const [mode, setMode] = useState<"graph" | "list">("graph");
  const save = useMutation(
    api.sdlc.breakdown.save.mutationOptions({
      onSuccess: (next) => {
        queryClient.setQueryData(api.sdlc.breakdown.get.queryKey({ input }), next);
        setEdited(null);
        void queryClient.invalidateQueries({ queryKey: api.sdlc.items.key() });
      },
    }),
  );

  if (view.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {b.loading}
      </p>
    );
  if (view.isError)
    return (
      <Alert variant="destructive">
        <AlertTitle>{b.loadError}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          {errorMessage(view.error)}
          <Button variant="outline" size="sm" onClick={() => void view.refetch()}>
            {t.retry}
          </Button>
        </AlertDescription>
      </Alert>
    );

  const data = view.data;
  if (!data.breakdown) {
    if (!data.errors.length) return <EmptyState title={b.emptyTitle} text={b.emptyText} />;
    return (
      <Alert variant="destructive">
        <AlertTitle>{b.errTitle(data.errors.length)}</AlertTitle>
        <AlertDescription className="flex flex-col gap-1">
          <p>{b.errCause}</p>
          <ul className="list-disc pl-4 font-mono text-xs">
            {data.errors.map((e) => (
              <li key={`${e.line}-${e.message}`}>{b.errLine(e.line, e.message)}</li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    );
  }

  // Bản sửa tại chỗ chỉ còn hiệu lực khi tài liệu chưa đổi; hub đổi revision thì lấy bản của hub.
  const current = edited && edited.revision === data.revision ? edited.breakdown : data.breakdown;
  const dirty = current !== data.breakdown;
  const canEdit = item.can.write && item.status === "active";
  const home = item.projectsDetail.find((p) => p.role === "home")?.key ?? item.project.key;
  const projectKeys = item.projectsDetail.map((p) => p.key);
  const cov = coverage(current.requirements, current);
  const waves = waveOf(current);
  const limits = item.mode.decomposition;
  const overTasks = limits && current.tasks.length > limits.maxTasks;
  const overChecklist = limits ? current.tasks.filter((x) => x.checklist.length > limits.maxChecklist) : [];

  const apply = (r: EditResult) => {
    if (!r.ok) {
      setCycle(r.cycle);
      return;
    }
    setCycle(null);
    setEdited({ revision: data.revision, breakdown: r.breakdown });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <dl aria-label={b.stats} className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex gap-1">
          <dt className="text-muted-foreground">{b.tasksCount}</dt>
          <dd className="font-mono">{current.tasks.length}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-muted-foreground">{b.wavesCount}</dt>
          <dd className="font-mono">{current.waves.length}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-muted-foreground">{b.projectsCount}</dt>
          <dd className="font-mono">{new Set(current.tasks.map((x) => x.project)).size}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-muted-foreground">{b.covTitle}</dt>
          <dd className="font-mono">{pct(cov.total.planned, cov.total.requirements)}%</dd>
        </div>
        {!canEdit && (
          <div>
            <dt className="sr-only">{b.mode}</dt>
            <dd>
              <Pill>{t.readOnly}</Pill>
            </dd>
          </div>
        )}
      </dl>

      {cycle && (
        <Alert variant="destructive">
          <AlertTitle>{b.cycleTitle}</AlertTitle>
          <AlertDescription>
            {b.cycleText} <span className="font-mono">{cycle.join(" → ")}</span>
          </AlertDescription>
        </Alert>
      )}
      {(overTasks || overChecklist.length > 0) && limits && (
        <Alert>
          <AlertTitle>{b.limitTitle}</AlertTitle>
          <AlertDescription>
            {overTasks && <p>{b.limitTasks(current.tasks.length, limits.maxTasks)}</p>}
            {overChecklist.map((x) => (
              <p key={x.sliceKey}>{b.limitChecklist(x.sliceKey, x.checklist.length, limits.maxChecklist)}</p>
            ))}
          </AlertDescription>
        </Alert>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">{b.graphTitle}</h3>
          <fieldset className="inline-flex rounded-lg bg-muted p-0.5 max-sm:hidden">
            <legend className="sr-only">{b.viewAs}</legend>
            {(
              [
                ["graph", b.vGraph],
                ["list", b.vList],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={mode === key}
                onClick={() => setMode(key)}
                className={cn(
                  "h-7 rounded-md px-2.5 text-sm",
                  mode === key ? "bg-card font-semibold shadow-sm" : "text-muted-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </fieldset>
        </div>
        <DependencyGraph breakdown={current} homeProject={home} view={mode} cycle={cycle ?? undefined} />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-base font-semibold">{b.cardsTitle}</h3>
        <p className="text-xs text-muted-foreground">{b.cardsHint}</p>
        <ul className="grid gap-2 lg:grid-cols-2">
          {current.tasks.map((task) => (
            <TaskCard
              key={task.sliceKey}
              breakdown={current}
              sliceKey={task.sliceKey}
              wave={waves.get(task.sliceKey)}
              projects={projectKeys}
              home={home}
              canEdit={canEdit}
              onEdit={apply}
            />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-base font-semibold">{b.covTitle}</h3>
        <ul className="flex flex-col gap-1 text-sm">
          <li>
            {b.covTotal(cov.total.planned, cov.total.requirements, pct(cov.total.planned, cov.total.requirements))}
          </li>
          {cov.byProject.map((p) => (
            <li key={p.project} className="text-muted-foreground">
              <span className="font-mono">{p.project}</span>: {b.covLine(p.planned, p.requirements)}
            </li>
          ))}
        </ul>
        {cov.missing.length > 0 && (
          <p className="rounded-md bg-warning-soft px-2 py-1 text-sm text-warning">
            {b.missing(cov.missing.join(", "))}
          </p>
        )}
      </section>

      {canEdit && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">{b.srcNote}</p>
          {save.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(save.error)}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate({ id: item.id, breakdown: current, baseRevision: data.revision })}
            >
              {b.save}
            </Button>
            <Button
              variant="outline"
              disabled={!dirty}
              onClick={() => {
                setEdited(null);
                setCycle(null);
              }}
            >
              {b.discard}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskCard(props: {
  breakdown: Breakdown;
  sliceKey: string;
  wave: number | undefined;
  projects: string[];
  home: string;
  canEdit: boolean;
  onEdit: (r: EditResult) => void;
}) {
  const b = useText().breakdown;
  const { breakdown, sliceKey: key, onEdit } = props;
  const task = breakdown.tasks.find((x) => x.sliceKey === key);
  const [target, setTarget] = useState("");
  const [dep, setDep] = useState("");
  if (!task) return null;
  const projectOf = new Map(breakdown.tasks.map((x) => [x.sliceKey, x.project]));
  const others = breakdown.tasks.filter((x) => x.sliceKey !== key);
  const depCandidates = others.filter((x) => !task.dependsOn.includes(x.sliceKey));

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-medium">{key}</span>
        <span className="min-w-0 flex-1">{task.title}</span>
        {props.wave !== undefined && <Pill small>{b.wave(props.wave + 1)}</Pill>}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">{b.project}</span>
        {props.canEdit ? (
          <NativeSelect
            size="sm"
            className="w-40"
            aria-label={`${b.project} ${key}`}
            value={task.project}
            onChange={(e) => onEdit(setProject(breakdown, key, e.target.value))}
          >
            {props.projects.map((p) => (
              <NativeSelectOption key={p} value={p}>
                {p === props.home ? `${p} (${b.main})` : p}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : (
          <span className="font-mono">{task.project}</span>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{b.reqs}</dt>
        <dd className="font-mono">{task.requirementIds.join(", ") || "—"}</dd>
        <dt className="text-muted-foreground">{b.checklist}</dt>
        <dd>{task.checklist.length ? task.checklist.map((c) => c.text).join(" · ") : "—"}</dd>
        <dt className="text-muted-foreground">{b.deps}</dt>
        <dd className="flex flex-wrap gap-1">
          {task.dependsOn.length === 0 && <span className="text-muted-foreground">{b.noDeps}</span>}
          {task.dependsOn.map((d) => {
            const cross = projectOf.get(d) !== task.project;
            return (
              <span
                key={d}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 font-mono",
                  cross ? "border-dashed border-ring" : "border-border",
                )}
              >
                {d}
                {cross && <span className="font-sans text-muted-foreground">({b.cross})</span>}
                {props.canEdit && (
                  <button
                    type="button"
                    aria-label={b.removeDep(d, key)}
                    onClick={() => onEdit(removeDependency(breakdown, key, d))}
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                )}
              </span>
            );
          })}
        </dd>
      </dl>
      {props.canEdit && (
        <div className="flex flex-col gap-2 border-t border-border pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect
              size="sm"
              className="w-40"
              aria-label={b.addDepFor(key)}
              value={dep}
              onChange={(e) => setDep(e.target.value)}
            >
              <NativeSelectOption value="">{b.addDep}</NativeSelectOption>
              {depCandidates.map((x) => (
                <NativeSelectOption key={x.sliceKey} value={x.sliceKey}>
                  {x.sliceKey}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              variant="outline"
              size="xs"
              disabled={!dep}
              onClick={() => {
                onEdit(addDependency(breakdown, key, dep));
                setDep("");
              }}
            >
              {b.addDep}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect
              size="sm"
              className="w-40"
              aria-label={b.targetFor(key)}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <NativeSelectOption value="">{b.pickTarget}</NativeSelectOption>
              {others.map((x) => (
                <NativeSelectOption key={x.sliceKey} value={x.sliceKey}>
                  {x.sliceKey}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              variant="outline"
              size="xs"
              disabled={!target}
              onClick={() => onEdit(mergeTasks(breakdown, key, target))}
            >
              {b.merge}
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={!target}
              onClick={() => onEdit(toChecklist(breakdown, key, target))}
            >
              {b.toList}
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={task.checklist.length < 2}
              onClick={() => onEdit(splitTask(breakdown, key))}
            >
              {b.split}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
