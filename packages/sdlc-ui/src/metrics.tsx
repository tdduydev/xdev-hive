import { useQuery } from "@tanstack/react-query";
import { SDLC_PHASE_KINDS, type SdlcMetrics } from "@xdev-hive/contracts";
import { Alert, AlertDescription, AlertTitle } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Label } from "@xdev-hive/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/table";
import { cn } from "cn";
import { useId, useState } from "react";
import { type Lang, useSdlcEnv, useText } from "./env.tsx";
import { formatUsd } from "./format.ts";
import { EmptyState } from "./parts.tsx";
import type { SdlcText } from "./text.ts";

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];
const DAY_MS = 86_400_000;

const locale = (lang: Lang) => (lang === "en" ? "en-GB" : "vi-VN");
const num = (value: number, lang: Lang) =>
  new Intl.NumberFormat(locale(lang), { maximumFractionDigits: 1 }).format(value);

/** Dưới một ngày ghi giờ, từ một ngày trở lên ghi ngày: lead time của giai đoạn dài đọc "6 ngày" dễ hơn "144 giờ". */
export function formatHours(hours: number | null, lang: Lang, t: SdlcText["metrics"]): string {
  if (hours === null) return t.noValue;
  return hours < 24 ? t.hours(num(hours, lang)) : t.daysShort(num(hours / 24, lang));
}

const pct = (rate: number | null, lang: Lang, t: SdlcText["metrics"]) =>
  rate === null ? t.noValue : `${num(rate * 100, lang)}%`;

function Card({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <li className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-mono text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{help}</span>
    </li>
  );
}

function LeadTime({ data }: { data: SdlcMetrics }) {
  const { lang } = useSdlcEnv();
  const t = useText();
  const m = t.metrics;
  const rows = SDLC_PHASE_KINDS.map((kind) => ({
    kind,
    duration: data.leadTimeHours.find((r) => r.kind === kind)?.duration ?? { p50: null, p90: null, count: 0 },
  }));
  const max = Math.max(1, ...rows.flatMap((r) => [r.duration.p50 ?? 0, r.duration.p90 ?? 0]));
  // Nút thắt là giai đoạn có p50 lớn nhất: p90 bị vài hạng mục kẹt kéo lên nên không nói được chỗ tắc chung.
  const bottleneck = rows.reduce<(typeof rows)[number] | null>(
    (best, r) => (r.duration.p50 !== null && (best?.duration.p50 ?? -1) < r.duration.p50 ? r : best),
    null,
  )?.kind;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="text-base font-semibold">{m.leadTitle}</h2>
      <ul className="flex flex-col gap-2">
        {rows.map(({ kind, duration }) => (
          <li
            key={kind}
            className="grid grid-cols-[7rem_1fr_5rem] items-center gap-2 text-sm max-sm:grid-cols-[1fr_auto]"
          >
            <span className="flex items-center gap-1.5 truncate">
              {t.phaseKind[kind]}
              {kind === bottleneck && (
                <Pill small tone="warn">
                  {m.bottleneck}
                </Pill>
              )}
            </span>
            {/* biome-ignore lint/a11y/useSemanticElements: thẻ <meter> mỗi trình duyệt vẽ một kiểu, không theo token màu. */}
            <div
              role="meter"
              aria-label={`${t.phaseKind[kind]} · p50`}
              aria-valuemin={0}
              aria-valuemax={Math.round(max)}
              aria-valuenow={Math.round(duration.p50 ?? 0)}
              aria-valuetext={formatHours(duration.p50, lang, m)}
              className="relative h-2.5 overflow-hidden rounded-full bg-muted max-sm:col-span-2 max-sm:row-start-2"
            >
              <div
                className={cn("h-full rounded-full", kind === bottleneck ? "bg-warning" : "bg-primary")}
                style={{ width: `${((duration.p50 ?? 0) / max) * 100}%` }}
              />
              {duration.p90 !== null && (
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 w-0.5 bg-foreground"
                  style={{ left: `calc(${(duration.p90 / max) * 100}% - 1px)` }}
                />
              )}
            </div>
            <span className="text-right font-mono text-xs tabular-nums">{formatHours(duration.p50, lang, m)}</span>
          </li>
        ))}
      </ul>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-4 rounded-full bg-primary" />
          {m.legendP50}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-3 w-0.5 bg-foreground" />
          {m.legendP90}
        </span>
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">{m.tableAlt}</summary>
        <Table className="mt-2">
          <TableHeader>
            <TableRow>
              <TableHead>{m.colStage}</TableHead>
              <TableHead>p50</TableHead>
              <TableHead>p90</TableHead>
              <TableHead>{m.colItems}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ kind, duration }) => (
              <TableRow key={kind}>
                <TableCell>{t.phaseKind[kind]}</TableCell>
                <TableCell className="font-mono">{formatHours(duration.p50, lang, m)}</TableCell>
                <TableCell className="font-mono">{formatHours(duration.p90, lang, m)}</TableCell>
                <TableCell className="font-mono">{duration.count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </details>
    </section>
  );
}

/**
 * Chỉ số AI SDLC (AppSdlcMetrics.dc.html, tab Chỉ số; FR-037, FR-064): lead time theo giai đoạn, thời gian chờ cổng người, tỉ lệ
 * trả lại, câu hỏi, độ phủ, vòng converge, vòng review, chi phí agent và tự duyệt. Hub tính sẵn; màn chỉ lọc và vẽ.
 */
export function Metrics() {
  const { api, lang, errorMessage, link } = useSdlcEnv();
  const t = useText();
  const m = t.metrics;
  const ids = useId();
  const [range, setRange] = useState<Range>(30);
  const [projectId, setProjectId] = useState("");
  const [modeRef, setModeRef] = useState("");
  // Mốc "bây giờ" giữ nguyên trong phiên màn: lấy lại mỗi lần vẽ thì khoá truy vấn đổi liên tục và tải lại không dứt.
  const [now] = useState(() => Date.now());
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const modes = useQuery(api.sdlc.modes.list.queryOptions({ input: {} }));
  const metrics = useQuery(
    api.sdlc.metrics.queryOptions({
      input: {
        from: new Date(now - range * DAY_MS).toISOString(),
        to: new Date(now).toISOString(),
        ...(projectId ? { projectId } : {}),
        ...(modeRef ? { modeRef } : {}),
      },
    }),
  );
  const sdlcProjects = (projects.data ?? []).filter((p) => p.settings.sdlc?.enabled);
  const modeName = (ref: string) => modes.data?.find((x) => x.ref === ref)?.definition.name ?? ref;

  let body: React.ReactNode;
  if (metrics.isPending) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {m.loading}
      </p>
    );
  } else if (metrics.isError) {
    body = (
      <Alert variant="destructive">
        <AlertTitle>{m.errTitle}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          {errorMessage(metrics.error)}
          <Button variant="outline" size="sm" onClick={() => void metrics.refetch()}>
            {t.retry}
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (metrics.data.items === 0) {
    body = (
      <EmptyState title={m.emptyTitle} text={m.emptyText}>
        {range !== 90 && (
          <Button variant="outline" size="sm" onClick={() => setRange(90)}>
            {m.try90}
          </Button>
        )}
      </EmptyState>
    );
  } else {
    const d = metrics.data;
    const cov = d.coverage;
    const cards = [
      [m.gateWait, formatHours(d.gateWaitHours.p50, lang, m), m.gateWaitHelp],
      [m.returnRate, pct(d.returnRate, lang, m), m.returnRateHelp],
      [m.questions, d.questionsPerItem === null ? m.noValue : num(d.questionsPerItem, lang), m.questionsHelp],
      [
        m.coverage,
        cov === null || cov.requirements === 0
          ? m.noValue
          : `${Math.round(Math.min(cov.planned, cov.done, cov.verified))}%`,
        m.coverageHelp,
      ],
      [m.converge, d.convergeRounds === null ? m.noValue : num(d.convergeRounds, lang), m.convergeHelp],
      [
        m.reviewRounds,
        d.codeReviewRoundsPerPr === null ? m.noValue : num(d.codeReviewRoundsPerPr, lang),
        m.reviewRoundsHelp,
      ],
      [m.cost, d.costUsdPerItem === null ? m.noValue : formatUsd(d.costUsdPerItem, lang), m.costHelp],
    ] as const;
    body = (
      <>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-sm text-muted-foreground">{m.items(d.items)}</p>
          {/* Contract chưa cho lọc danh sách hạng mục theo thời gian, nên chỉ mang dự án và chế độ sang bảng và nói rõ. */}
          <p className="flex flex-col items-end gap-0.5 text-right max-sm:items-start max-sm:text-left">
            {link({
              to: { kind: "board", ...(projectId ? { projectId } : {}), ...(modeRef ? { modeRef } : {}) },
              className: "text-sm font-medium text-primary hover:text-primary/90",
              children: m.openBoard,
            })}
            <span className="text-xs text-muted-foreground">{m.openBoardNote}</span>
          </p>
        </div>
        <LeadTime data={d} />
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {cards.map(([label, value, help]) => (
            <Card key={label} label={label} value={value} help={help} />
          ))}
        </ul>
        <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
          <h2 className="text-base font-semibold">{m.autoTitle}</h2>
          <p className="text-xs text-muted-foreground">{m.autoMeta}</p>
          {d.autoApproval.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.colMode}</TableHead>
                  <TableHead>{m.colProject}</TableHead>
                  <TableHead>{m.autoRate}</TableHead>
                  <TableHead>{m.revokeRate}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.autoApproval.map((r) => (
                  <TableRow key={`${r.modeRef}-${r.projectKey ?? ""}`}>
                    <TableCell>{modeName(r.modeRef)}</TableCell>
                    <TableCell className={cn(r.projectKey && "font-mono")}>{r.projectKey ?? m.wholeMode}</TableCell>
                    <TableCell className="font-mono">{pct(r.autoRate, lang, m)}</TableCell>
                    <TableCell className="font-mono">{pct(r.revokeRate, lang, m)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">{m.autoEmpty}</p>
          )}
        </section>
      </>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="text-xl font-semibold">{m.title}</h1>
        <p className="max-w-prose text-sm text-muted-foreground">{m.lead}</p>
      </header>
      <form aria-label={m.range} className="flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()}>
        <fieldset className="flex flex-col gap-1 max-sm:w-full">
          <legend className="mb-1 text-sm font-medium">{m.range}</legend>
          <div className="inline-flex rounded-lg bg-muted p-0.5">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={range === r}
                onClick={() => setRange(r)}
                className={cn(
                  "inline-flex h-7 items-center rounded-md px-2.5 text-sm max-sm:flex-1 max-sm:justify-center",
                  range === r ? "bg-card font-semibold shadow-sm" : "text-muted-foreground",
                )}
              >
                {m.days(r)}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="flex w-48 flex-col gap-1 max-sm:w-full">
          <Label htmlFor={`${ids}-project`}>{m.fProject}</Label>
          <NativeSelect id={`${ids}-project`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <NativeSelectOption value="">{m.allProjects}</NativeSelectOption>
            {sdlcProjects.map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {p.key}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex w-48 flex-col gap-1 max-sm:w-full">
          <Label htmlFor={`${ids}-mode`}>{m.fMode}</Label>
          <NativeSelect id={`${ids}-mode`} value={modeRef} onChange={(e) => setModeRef(e.target.value)}>
            <NativeSelectOption value="">{m.allModes}</NativeSelectOption>
            {(modes.data ?? [])
              .filter((x) => x.enabled)
              .map((x) => (
                <NativeSelectOption key={x.ref} value={x.ref}>
                  {x.definition.name}
                </NativeSelectOption>
              ))}
          </NativeSelect>
        </div>
      </form>
      <p className="text-xs text-muted-foreground">{m.rangeNote}</p>
      {body}
    </div>
  );
}
