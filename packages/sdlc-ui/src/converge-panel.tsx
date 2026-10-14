import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type SdlcItemDetail, type SdlcStepRun, sdlcFinding } from "@xdev-hive/contracts";
import { Alert, AlertDescription, AlertTitle } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { Fragment, useState } from "react";
import { useSdlcEnv, useText } from "./env.tsx";
import { formatWhen, type Tone } from "./format.ts";
import { EmptyState } from "./parts.tsx";

type Finding = ReturnType<typeof sdlcFinding.parse>;
type FindingStatus = Finding["status"];

// Mâu thuẫn và thiếu đứng đầu vì đó là việc người xem phải quyết.
const ORDER: readonly FindingStatus[] = ["contradicts", "missing", "partial", "met"];
const tone: Record<FindingStatus, Tone> = { contradicts: "bad", missing: "bad", partial: "warn", met: "ok" };
const findingsOf = sdlcFinding.array();

/** Bước `converge` khai trong chế độ; rỗng là chế độ nhẹ không hội tụ, tab không hiện. */
export function convergeSteps(item: SdlcItemDetail) {
  return item.mode.phases.flatMap((p) =>
    p.steps.filter((s) => s.action === "converge").map((step) => ({ phaseId: p.id, step })),
  );
}

/**
 * Kết quả của run lấy qua schema: hub cũ hay agent viết sai thì coi như chưa có, không làm vỡ màn. Khoá gồm id run vì
 * hạng mục nhiều dự án có một run mỗi dự án, cùng mã yêu cầu có thể lặp.
 */
function readFindings(run: SdlcStepRun): (Finding & { key: string })[] {
  const parsed = findingsOf.safeParse(run.result?.findings);
  return parsed.success ? parsed.data.map((f, i) => ({ ...f, key: `${run.id}-${i}` })) : [];
}

/**
 * Hội tụ (FR-055–FR-058, US10): trạng thái vòng, kết quả từng yêu cầu kèm bằng chứng và hai hướng sửa. Hub giữ số vòng và
 * tự dừng khi hết `converge.maxRounds`, nên màn chỉ đọc `convergeRound`, không tự đếm lại.
 */
export function ConvergePanel({ item }: { item: SdlcItemDetail }) {
  const { api, lang, link, errorMessage } = useSdlcEnv();
  const t = useText();
  const c = t.converge;
  const queryClient = useQueryClient();
  const step = useMutation(
    api.sdlc.items.step.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: api.sdlc.key() }),
    }),
  );
  const defs = convergeSteps(item);
  const runs = item.steps.filter((s) => s.action === "converge");
  const rounds = [...new Set(runs.map((r) => r.round))].sort((a, b) => a - b);
  const [picked, setPicked] = useState<number | null>(null);
  const [hideMet, setHideMet] = useState(true);
  const round = picked !== null && rounds.includes(picked) ? picked : rounds.at(-1);
  const max = item.mode.converge.maxRounds;
  const running = runs.some((r) => r.status === "queued" || r.status === "running");
  const converged = item.convergedAt !== null;
  const outOfRounds = !converged && !running && max > 0 && item.convergeRound >= max;
  const def = defs[0];
  const canRun = item.can.write && item.status === "active" && !running && !converged && !outOfRounds && !!def;

  const status = converged ? (
    <Pill tone="ok" dot>
      {c.converged}
    </Pill>
  ) : running ? (
    <Pill tone="sel" dot>
      {c.running}
    </Pill>
  ) : outOfRounds ? (
    <Pill tone="bad" dot>
      {c.outOfRounds(max)}
    </Pill>
  ) : runs.length ? (
    <Pill tone="warn" dot>
      {c.notYet(item.convergeRound, max)}
    </Pill>
  ) : (
    <Pill dot>{c.never}</Pill>
  );

  const roundRuns = runs.filter((r) => r.round === round);
  const findings = roundRuns.flatMap(readFindings).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const counts = ORDER.map((s) => [s, findings.filter((f) => f.status === s).length] as const).filter(([, n]) => n);
  const shown = hideMet ? findings.filter((f) => f.status !== "met") : findings;
  const failedRun = roundRuns.find((r) => r.status === "failed");
  const finishedAt = roundRuns.map((r) => r.finishedAt).find(Boolean);
  // Task bổ sung đi qua cổng tách task (FR-057), nên "sửa code" mở tài liệu tách task nếu có, không thì tab task.
  const decompositionDoc = item.artifacts.find((a) => a.artifactId === item.mode.decomposition?.artifact)?.docKey;
  // Tài liệu giữ yêu cầu là nguồn mã yêu cầu của bản tách; chế độ không khai thì lấy tài liệu đầu bước hội tụ đọc.
  const source = item.mode.decomposition?.requirementSource[0]?.artifact ?? def?.step.artifacts[0];
  const sourceDoc = item.artifacts.find((a) => a.artifactId === source)?.docKey;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {status}
          {converged && item.convergedAt && (
            <span className="text-xs text-muted-foreground">{formatWhen(item.convergedAt, lang)}</span>
          )}
          {canRun && def && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto max-sm:ml-0"
              disabled={step.isPending}
              onClick={() => step.mutate({ id: item.id, phaseId: def.phaseId, stepId: def.step.id })}
            >
              {runs.length ? c.runNext : c.run}
            </Button>
          )}
        </div>
        <p className="text-muted-foreground">{c.lead}</p>
        {outOfRounds && <p className="text-warning">{c.outNote}</p>}
        {step.isError && <p className="text-xs text-destructive">{errorMessage(step.error)}</p>}
      </div>

      {round === undefined ? (
        <EmptyState title={c.never} text={c.neverText} />
      ) : (
        <section className="flex flex-col gap-3" aria-label={c.round(round)}>
          <div className="flex flex-wrap items-center gap-2">
            {rounds.length > 1 && (
              <fieldset className="inline-flex overflow-hidden rounded-md border border-border">
                <legend className="sr-only">{c.rounds}</legend>
                {rounds.map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={r === round}
                    onClick={() => setPicked(r)}
                    className={
                      r === round
                        ? "min-h-8 bg-primary px-3 text-xs font-semibold text-primary-foreground"
                        : "min-h-8 px-3 text-xs text-muted-foreground hover:bg-muted"
                    }
                  >
                    {c.round(r)}
                  </button>
                ))}
              </fieldset>
            )}
            {rounds.length === 1 && <span className="text-xs font-semibold">{c.round(round)}</span>}
            {counts.map(([s, n]) => (
              <Pill key={s} tone={tone[s]} small>
                {c.status[s]} {n}
              </Pill>
            ))}
            {finishedAt && <span className="text-xs text-muted-foreground">{formatWhen(finishedAt, lang)}</span>}
            {roundRuns.map(
              (r) =>
                r.run && (
                  <Fragment key={r.id}>
                    {link({
                      to: { kind: "run", id: r.run.id },
                      className: "text-xs underline",
                      children: t.detail.openRun,
                    })}
                  </Fragment>
                ),
            )}
            {findings.some((f) => f.status === "met") && (
              <label className="ml-auto flex items-center gap-1.5 text-xs max-sm:ml-0">
                <input type="checkbox" checked={hideMet} onChange={(e) => setHideMet(e.target.checked)} />
                {c.hideMet}
              </label>
            )}
          </div>

          {failedRun && (
            <Alert variant="destructive">
              <AlertTitle>{c.failed}</AlertTitle>
              {failedRun.error && <AlertDescription>{failedRun.error}</AlertDescription>}
            </Alert>
          )}
          {!findings.length && !failedRun && <p className="text-sm text-muted-foreground">{c.noFindings}</p>}
          {findings.length > 0 && !shown.length && <p className="text-sm text-muted-foreground">{c.allMet}</p>}

          <ul className="flex flex-col gap-2">
            {shown.map((f) => (
              <li key={f.key} className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold">{f.requirementId}</span>
                  <Pill tone={tone[f.status]} small dot>
                    {c.status[f.status]}
                  </Pill>
                </div>
                <p className="whitespace-pre-wrap break-words text-muted-foreground">{f.evidence}</p>
                {f.suggestedTask && (
                  <p className="break-words">
                    <span className="font-medium">{c.suggested}: </span>
                    {f.suggestedTask}
                  </p>
                )}
                {f.status === "contradicts" && <p className="text-xs text-warning">{c.contradictsNote}</p>}
                {f.status !== "met" && (
                  <div className="flex flex-wrap gap-3 text-xs">
                    {link({
                      to: decompositionDoc
                        ? { kind: "doc", key: decompositionDoc }
                        : { kind: "item", projectKey: item.project.key, number: item.number, tab: "tasks" },
                      className: "underline",
                      children: c.fixCode,
                    })}
                    {f.status === "contradicts" &&
                      sourceDoc &&
                      link({ to: { kind: "doc", key: sourceDoc }, className: "underline", children: c.fixDoc })}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
