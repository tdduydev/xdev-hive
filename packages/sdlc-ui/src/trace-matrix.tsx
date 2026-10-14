import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SdlcCoverage, SdlcItemDetail, SdlcTraceRow } from "@xdev-hive/contracts";
import { Alert, AlertDescription, AlertTitle } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Label } from "@xdev-hive/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/table";
import { cn } from "cn";
import { useId, useState } from "react";
import { useSdlcEnv, useText } from "./env.tsx";
import { EmptyState } from "./parts.tsx";

/** Tải chữ thành file trên trình duyệt (web và webview của app đều có `URL.createObjectURL`). */
export function downloadCsv(name: string, csv: string) {
  // BOM để Excel mở đúng tiếng Việt.
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const complete = (row: SdlcTraceRow) => row.planned && row.done && row.verified;

function CoverageBars({ label, value }: { label: string; value: SdlcCoverage }) {
  const t = useText().trace;
  const bars = [
    [t.planned, value.planned],
    [t.done, value.done],
    [t.verified, value.verified],
  ] as const;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {bars.map(([name, pct]) => (
        <div key={name} className="flex items-center gap-2 text-xs">
          <span className="w-24 shrink-0 text-muted-foreground">{name}</span>
          {/* biome-ignore lint/a11y/useSemanticElements: thẻ <meter> mỗi trình duyệt vẽ một kiểu, không theo token màu. */}
          <div
            role="meter"
            aria-label={`${label} · ${name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
            className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <span className="w-10 text-right font-mono tabular-nums">{Math.round(pct)}%</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Ma trận truy vết (AppSdlcTrace.dc.html, FR-034): requirement → task (theo dự án) → run → PR → test. Hàng tô vàng là
 * requirement chưa có task. Ở mức tổng, "đã làm" chỉ khi mọi task chứa requirement ở mọi dự án đã merge.
 */
export function TraceMatrix({ item }: { item: SdlcItemDetail }) {
  const { api, link, errorMessage } = useSdlcEnv();
  const t = useText();
  const tr = t.trace;
  const ids = useId();
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const [gapsOnly, setGapsOnly] = useState(false);
  const [csvError, setCsvError] = useState<unknown>(null);
  const trace = useQuery(api.sdlc.trace.queryOptions({ input: { id: item.id, ...(projectId ? { projectId } : {}) } }));

  const exportCsv = async () => {
    setCsvError(null);
    try {
      const res = await queryClient.fetchQuery(
        api.sdlc.trace.queryOptions({ input: { id: item.id, format: "csv", ...(projectId ? { projectId } : {}) } }),
      );
      if (res.csv !== null) downloadCsv(`${item.project.key}-${item.ref}-${item.slug}-trace.csv`, res.csv);
    } catch (error) {
      setCsvError(error);
    }
  };

  if (trace.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {tr.loading}
      </p>
    );
  if (trace.isError)
    return (
      <Alert variant="destructive">
        <AlertTitle>{tr.errTitle}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          {errorMessage(trace.error)}
          <Button variant="outline" size="sm" onClick={() => void trace.refetch()}>
            {t.retry}
          </Button>
        </AlertDescription>
      </Alert>
    );
  const data = trace.data;
  if (!data.rows.length && !projectId) return <EmptyState title={tr.emptyTitle} text={tr.emptyText} />;
  const rows = gapsOnly ? data.rows.filter((r) => !complete(r)) : data.rows;
  const status = (row: SdlcTraceRow) => (
    <span className="flex flex-wrap gap-1">
      {!row.planned && (
        <Pill tone="warn" small>
          {tr.noTask}
        </Pill>
      )}
      {row.planned && (
        <Pill small tone={row.done ? "ok" : "neutral"}>
          {row.done ? tr.done : tr.planned}
        </Pill>
      )}
      {row.verified && (
        <Pill small tone="ok">
          {tr.verified}
        </Pill>
      )}
      {row.findings.map((f) => (
        <Pill key={`${f.round}-${f.status}`} small tone={f.status === "met" ? "ok" : "bad"} title={f.evidence}>
          {tr.finding[f.status]}
        </Pill>
      ))}
    </span>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="grid gap-4 rounded-xl border border-border bg-card p-4 md:grid-cols-2">
        <CoverageBars label={tr.covTitle} value={data.total} />
        <div className="flex flex-col gap-3">
          <span className="text-sm font-semibold">{tr.byProject}</span>
          {data.byProject.map((p) => (
            <CoverageBars key={p.projectKey} label={p.projectKey} value={p.coverage} />
          ))}
          <p className="text-xs text-muted-foreground">{tr.doneRule}</p>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-3">
          <h3 className="mr-auto text-base font-semibold">{tr.matrix}</h3>
          <div className="flex w-44 flex-col gap-1">
            <Label htmlFor={`${ids}-project`}>{tr.fProject}</Label>
            <NativeSelect id={`${ids}-project`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <NativeSelectOption value="">{tr.allProjects}</NativeSelectOption>
              {item.projectsDetail.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.key}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <label className="flex h-8 items-center gap-2 text-sm">
            <input type="checkbox" checked={gapsOnly} onChange={(e) => setGapsOnly(e.target.checked)} />
            {tr.gapsOnly}
          </label>
          <Button variant="outline" onClick={() => void exportCsv()}>
            {tr.csv}
          </Button>
        </div>
        {csvError !== null && <p className="text-sm text-destructive">{errorMessage(csvError)}</p>}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tr.noMatch}</p>
        ) : (
          <>
            <div className="max-sm:hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tr.colReq}</TableHead>
                    <TableHead>{tr.colTask}</TableHead>
                    <TableHead>{tr.colRun}</TableHead>
                    <TableHead>{tr.colPr}</TableHead>
                    <TableHead>{tr.colTest}</TableHead>
                    <TableHead>{tr.colStatus}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.flatMap((row) => {
                    const tasks = row.tasks.length ? row.tasks : [null];
                    return tasks.map((task, i) => (
                      <TableRow
                        key={`${row.requirementId}-${task?.taskId ?? "none"}`}
                        className={cn(!row.planned && "bg-warning-soft")}
                      >
                        {i === 0 && (
                          <TableCell rowSpan={tasks.length} className="align-top">
                            <span className="font-mono font-medium">{row.requirementId}</span>
                            <span className="block max-w-xs text-xs text-muted-foreground">{row.text}</span>
                          </TableCell>
                        )}
                        <TableCell>
                          {task
                            ? link({
                                to: { kind: "task", id: task.taskId },
                                className: "font-mono underline",
                                children: `${task.key} (${task.projectKey})`,
                              })
                            : "—"}
                        </TableCell>
                        <TableCell>
                          {task?.runId
                            ? link({
                                to: { kind: "run", id: task.runId },
                                className: "underline",
                                children: tr.openRun,
                              })
                            : "—"}
                        </TableCell>
                        <TableCell>
                          {task?.prUrl ? (
                            <a href={task.prUrl} target="_blank" rel="noreferrer" className="underline">
                              {task.mergeSha ? task.mergeSha.slice(0, 7) : tr.openPr}
                            </a>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {task?.tests.length ? task.tests.join(", ") : "—"}
                          {task?.ci === "success" && <span className="ml-1 text-success">· {tr.ciGreen}</span>}
                          {task?.ci === "failure" && <span className="ml-1 text-destructive">· {tr.ciRed}</span>}
                        </TableCell>
                        {i === 0 && (
                          <TableCell rowSpan={tasks.length} className="align-top">
                            {status(row)}
                          </TableCell>
                        )}
                      </TableRow>
                    ));
                  })}
                </TableBody>
              </Table>
            </div>
            <ul className="flex flex-col gap-2 sm:hidden">
              {rows.map((row) => (
                <li
                  key={row.requirementId}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border border-border p-3 text-sm",
                    !row.planned && "bg-warning-soft",
                  )}
                >
                  <span className="font-mono font-medium">{row.requirementId}</span>
                  <span className="text-xs text-muted-foreground">{row.text}</span>
                  {row.tasks.map((task) => (
                    <span key={task.taskId} className="font-mono text-xs">
                      {task.key} ({task.projectKey})
                    </span>
                  ))}
                  {status(row)}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
