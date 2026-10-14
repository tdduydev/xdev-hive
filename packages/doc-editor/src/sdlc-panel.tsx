import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SdlcArtifactView, SdlcItemDetail, SdlcQuestion, SdlcStepRun } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { cn } from "cn";
import { type ReactNode, useId, useState } from "react";
import { type DocEditorEnv, type Lang, useDocEditorEnv } from "./env.tsx";
import { docEditorText, sdlcPanelText } from "./text.ts";

/*
 * Khung bên "Hạng mục" của trình soạn (DocEditor.dc.html biến thể sdlc, specs/011 T053) và phần dữ liệu hạng mục mà
 * ReviewPane dùng lại. Chỉ đọc hợp đồng `sdlc`; component của `@xdev-hive/sdlc-ui` đến qua props của app chủ.
 */

export type SdlcItemRef = { projectKey: string; number: number };

/**
 * Hạng mục của một key tài liệu AI SDLC (`sdlcDocKey` trong contracts): `project/<k>/sdlc/<NNN>-<slug>/…` là hạng mục
 * của chính dự án `<k>`; tài liệu riêng của dự án tham gia nằm ở `project/<k>/sdlc/<home>-<NNN>-<slug>/…`. Key dự án
 * bắt đầu bằng chữ nên thư mục bắt đầu bằng số là trường hợp đầu.
 */
export function parseSdlcDocKey(key: string): SdlcItemRef | null {
  const m = /^project\/([^/]+)\/sdlc\/([^/]+)\/.+$/.exec(key);
  if (!m?.[1] || !m[2]) return null;
  const own = /^(\d{3,})-/.exec(m[2]);
  if (own?.[1]) return { projectKey: m[1], number: Number(own[1]) };
  const other = /^([a-z][a-z0-9-]*?)-(\d{3,})-/.exec(m[2]);
  return other?.[1] && other[2] ? { projectKey: other[1], number: Number(other[2]) } : null;
}

/** Mục bắt buộc có trong bản nháp chưa: so tiêu đề Markdown, bỏ hoa thường và khoảng trắng thừa. */
export function sectionPresence(content: string, sections: readonly string[]): { name: string; present: boolean }[] {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("vi");
  const headings = new Set(
    content
      .split("\n")
      .map((line) => /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1])
      .filter((h): h is string => !!h)
      .map(norm),
  );
  return sections.map((name) => ({ name, present: headings.has(norm(name)) }));
}

const STEP_LIVE: readonly SdlcStepRun["status"][] = ["queued", "running"];

/** Hạng mục của tài liệu và tài liệu đó trong hạng mục; tải lại khi có bước agent đang chạy. */
export function useSdlcItem(docKey: string, enabled: boolean) {
  const { api } = useDocEditorEnv();
  const ref = enabled ? parseSdlcDocKey(docKey) : null;
  const item = useQuery({
    ...api.sdlc.items.get.queryOptions({ input: ref ?? { projectKey: "", number: 0 } }),
    enabled: !!ref,
    refetchInterval: (q) => (q.state.data?.steps.some((s) => STEP_LIVE.includes(s.status)) ? 4000 : false),
  });
  const artifact = item.data?.artifacts.find((a) => a.docKey === docKey) ?? null;
  return { ref, item, artifact };
}

export function answeredQuestions(item: SdlcItemDetail, artifact: SdlcArtifactView | null): SdlcQuestion[] {
  return item.questions
    .filter((q) => q.status === "answered" && (!artifact || q.phaseId === artifact.phaseId))
    .sort((a, b) => a.round - b.round || a.position - b.position);
}

export function useSdlcText() {
  return sdlcPanelText[useDocEditorEnv().lang];
}

export function formatAt(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(iso));
}

export function formatScore(n: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === "en" ? "en-US" : "vi-VN", { maximumFractionDigits: 1 }).format(n);
}

/** Danh sách câu đã trả lời, dùng ở khung bên và ở thẻ của ReviewPane. */
export function AnsweredList({ questions }: { questions: SdlcQuestion[] }) {
  const t = useSdlcText();
  if (questions.length === 0) return <p className="m-0 text-sm text-muted-foreground">{t.noQa}</p>;
  return (
    <ol className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
      {questions.map((q) => (
        <li key={q.id} className="flex flex-col gap-0.5">
          <span className="font-medium">{q.text}</span>
          <span>
            → {q.answer}
            {q.usedRecommended && <span className="text-muted-foreground"> ({t.qaRecommended})</span>}
            {q.answeredBy && <span className="text-muted-foreground"> · {q.answeredBy.name}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Section({ title, children, meta }: { title: string; children: ReactNode; meta?: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 flex-1 text-sm font-semibold">{title}</h3>
        {meta}
      </div>
      {children}
    </section>
  );
}

/** Bước agent soạn tài liệu này: bước `draft` của giai đoạn có tài liệu trong `artifacts`, không thì bước `draft` đầu. */
function draftStepOf(item: SdlcItemDetail, artifact: SdlcArtifactView) {
  const phase = item.mode.phases.find((p) => p.id === artifact.phaseId);
  const drafts = (phase?.steps ?? []).filter((s) => s.action === "draft");
  return drafts.find((s) => s.artifacts.includes(artifact.artifactId)) ?? drafts[0] ?? null;
}

export function SdlcPanel({ docKey, content, sdlc }: { docKey: string; content: string; sdlc: DocEditorEnv["sdlc"] }) {
  const t = useSdlcText();
  const { item, artifact } = useSdlcItem(docKey, true);
  if (!item.data) return <PanelState query={item} />;
  const d = item.data;
  if (!artifact)
    return (
      <div className="flex flex-col gap-3 p-3.5">
        <p className="m-0 text-sm text-muted-foreground">{t.notFound}</p>
        {sdlc?.itemLink({
          projectKey: d.project.key,
          number: d.number,
          className: "text-sm underline",
          children: t.openItem,
        })}
      </div>
    );
  return <Panel item={d} artifact={artifact} content={content} sdlc={sdlc} />;
}

function Panel({
  item,
  artifact,
  content,
  sdlc,
}: {
  item: SdlcItemDetail;
  artifact: SdlcArtifactView;
  content: string;
  sdlc: DocEditorEnv["sdlc"];
}) {
  const t = useSdlcText();
  const env = useDocEditorEnv();
  const queryClient = useQueryClient();
  const ids = useId();
  const [instructions, setInstructions] = useState("");
  const [done, setDone] = useState(false);
  const phase = item.phases.find((p) => p.id === artifact.phaseId);
  const modePhase = item.mode.phases.find((p) => p.id === artifact.phaseId);
  const spec = modePhase?.artifacts.find((a) => a.id === artifact.artifactId);
  const step = draftStepOf(item, artifact);
  const lastRun = step
    ? item.steps.filter((s) => s.phaseId === artifact.phaseId && s.stepId === step.id).at(-1)
    : undefined;
  const live = lastRun && STEP_LIVE.includes(lastRun.status);
  const canWrite = item.can.write && item.status === "active";
  const rewrite = useMutation({
    mutationFn: () =>
      env.api.sdlc.items.step.call({
        id: item.id,
        phaseId: artifact.phaseId,
        stepId: step?.id ?? "",
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(
        env.api.sdlc.items.get.queryKey({ input: { projectKey: item.project.key, number: item.number } }),
        next,
      );
      setInstructions("");
      setDone(true);
    },
  });
  const gates = (modePhase?.gate ?? []).flatMap((p) => p.gates);
  const perTeam = gates.filter((g) => modePhase?.perProjectGates.includes(g.id)).map((g) => g.name);
  const projectOf = (id: string) => item.projectsDetail.find((p) => p.id === id);
  const auto = item.autoApprovals.filter((a) => a.artifactId === artifact.id && !a.revokedAt).at(-1);
  const kind = docEditorText[env.lang].kind;
  const answered = answeredQuestions(item, artifact);

  return (
    <div className="flex flex-col gap-3 p-3.5">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="m-0 text-[15px] font-semibold">{t.title(item.ref, phase?.name ?? artifact.phaseId)}</h2>
          {phase && (
            <Pill tone={phase.status === "approved" ? "ok" : phase.status === "pending" ? "neutral" : "warn"}>
              {t.phaseStatus[phase.status]}
            </Pill>
          )}
          {!item.can.write && <Pill>{t.readOnly}</Pill>}
        </div>
        <p className="m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {item.title} · <span className="font-mono">{`${item.ref}-${item.slug}`}</span> ·{" "}
          {t.meta(item.size, item.modeName)}
        </p>
        {sdlc?.itemLink({
          projectKey: item.project.key,
          number: item.number,
          className: "self-start text-sm underline",
          children: t.openItem,
        })}
      </div>

      {live && !lastRun.waitingReason && (
        <div role="status" className="flex flex-col gap-1 rounded-lg border border-primary p-3 text-sm">
          <strong className="font-semibold">{t.runTitle}</strong>
          <span className="text-muted-foreground">{t.runText}</span>
          {lastRun.run &&
            env.link({
              to: { kind: "run", id: lastRun.run.id },
              className: "self-start underline",
              children: t.openRun,
            })}
        </div>
      )}
      {live && lastRun.waitingReason && (
        <Alert role="status" className="border-transparent bg-warning-soft text-warning">
          <strong className="font-semibold">{t.waitTitle}</strong>
          <span>{lastRun.waitingReason}</span>
        </Alert>
      )}
      {lastRun?.status === "failed" && (
        <Alert variant="destructive">
          <strong className="font-semibold">{t.errTitle}</strong>
          {lastRun.error && <span>{lastRun.error}</span>}
        </Alert>
      )}
      {!item.can.write && <p className="m-0 text-sm text-muted-foreground">{t.roText}</p>}

      <Section title={t.projects}>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
          {item.projectsDetail.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-24 text-muted-foreground">{t.role[p.role]}</span>
              <span className="font-mono">{p.key}</span>
              <span className="text-muted-foreground">{p.teamName}</span>
              {!p.enabled && <Pill tone="warn">{t.disabled}</Pill>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t.stageTitle}>
        <ol aria-label={t.stagesAria} className="m-0 flex list-none flex-wrap gap-1 p-0 text-xs">
          {item.phases.map((p) => {
            const state =
              p.id === artifact.phaseId ? "now" : p.status === "approved" || p.status === "skipped" ? "done" : "todo";
            return (
              <li key={p.id}>
                <span
                  aria-current={state === "now" ? "step" : undefined}
                  className={cn(
                    "inline-flex h-5.5 items-center gap-1 rounded-full px-2",
                    state === "done" && "bg-success-soft text-success",
                    state === "now" && "bg-warning-soft font-semibold text-warning",
                    state === "todo" && "border border-border text-muted-foreground",
                  )}
                >
                  <span aria-hidden="true">{state === "done" ? "✓" : state === "now" ? "●" : "○"}</span>
                  {p.name}
                  <span className="sr-only"> ({t.stageState[state]})</span>
                </span>
              </li>
            );
          })}
        </ol>
        <h4 className="m-0 text-xs font-medium text-muted-foreground">{t.gatesTitle}</h4>
        {gates.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">{t.noGates}</p>
        ) : (
          <ol aria-label={t.gatesTitle} className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {gates.map((g) => (
              <li key={g.id} className="flex items-center gap-2">
                <Pill small>{kind[g.kind]}</Pill>
                <span className="min-w-0 [overflow-wrap:anywhere]">{g.name}</span>
              </li>
            ))}
          </ol>
        )}
        {perTeam.length > 0 && item.projectsDetail.length > 1 && (
          <p className="m-0 text-xs text-muted-foreground">{t.perTeam(perTeam.join(", "))}</p>
        )}
        {modePhase?.autoApprove && artifact.scope !== "contract" && (
          <p className="m-0 text-xs text-muted-foreground">
            {t.autoRule(formatScore(modePhase.autoApprove.minScore, env.lang), modePhase.autoApprove.revokeHours)}
          </p>
        )}
        {auto && (
          <Pill tone="ok" className="self-start">
            {t.autoBadge(formatScore(auto.score, env.lang), formatScore(auto.threshold, env.lang))}
          </Pill>
        )}
      </Section>

      {artifact.scope === "contract" && (
        <Section
          title={t.contractTitle}
          meta={
            <Pill small className="font-mono">
              {artifact.instance}
              {artifact.contractFormat ? ` · ${artifact.contractFormat}` : ""}
            </Pill>
          }
        >
          <p className="m-0 text-sm">
            <span className="text-muted-foreground">{t.provider}: </span>
            <span className="font-mono">{projectOf(artifact.projectId)?.key ?? artifact.projectId}</span>
          </p>
          <p className="m-0 text-sm">
            <span className="text-muted-foreground">{t.consumers}: </span>
            {artifact.consumerProjectIds.map((id) => projectOf(id)?.key ?? id).join(", ")}
          </p>
          <p className="m-0 text-xs text-muted-foreground">{t.contractNote}</p>
        </Section>
      )}

      <Section title={t.tplTitle}>
        {spec?.template ? (
          <details className="text-sm">
            <summary className="cursor-pointer">{t.tplOpen}</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
              {spec.template}
            </pre>
          </details>
        ) : (
          <p className="m-0 text-sm text-muted-foreground">{t.noTpl}</p>
        )}
      </Section>

      {(spec?.sections.length ?? 0) > 0 && (
        <Section title={t.reqTitle}>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {sectionPresence(content, spec?.sections ?? []).map((s) => (
              <li key={s.name} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex size-4.5 flex-none items-center justify-center rounded-full text-xs",
                    s.present ? "bg-success-soft text-success" : "bg-warning-soft text-warning",
                  )}
                >
                  {s.present ? "✓" : "!"}
                </span>
                {s.name}
                <span className="sr-only"> ({s.present ? t.reqPresent : t.reqMissing})</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={t.qaTitle}>
        <AnsweredList questions={answered} />
        {answered.length > 0 && <p className="m-0 text-xs text-muted-foreground">{t.qaNote}</p>}
      </Section>

      {artifact.syncs.length > 0 && (
        <Section title={t.syncTitle}>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
            {artifact.syncs.map((s) => (
              <li key={`${s.projectId}:${s.kind}`} className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs [overflow-wrap:anywhere]">
                    {s.projectKey} · {s.repoPath}
                  </span>
                  <Pill
                    small
                    tone={s.state === "synced" ? "ok" : s.state === "failed" || s.state === "deleted" ? "bad" : "warn"}
                  >
                    {t.syncState[s.state]}
                  </Pill>
                </span>
                {s.error && <span className="text-xs text-destructive">{s.error}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {canWrite &&
        (step ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setDone(false);
              rewrite.mutate();
            }}
          >
            <label htmlFor={`${ids}-ins`} className="text-sm font-medium">
              {t.rewriteTitle}
            </label>
            <Textarea
              id={`${ids}-ins`}
              placeholder={t.rewriteHint}
              maxLength={4000}
              className="h-18"
              value={instructions}
              disabled={rewrite.isPending}
              onChange={(e) => setInstructions(e.currentTarget.value)}
            />
            <p className="m-0 text-xs text-muted-foreground">{t.rewriteNote(step.id)}</p>
            {rewrite.isError && <Alert variant="destructive">{env.errorMessage(rewrite.error)}</Alert>}
            {done && (
              <p role="status" className="m-0 text-sm text-success">
                {t.rewriteDone}
              </p>
            )}
            <Button type="submit" size="sm" disabled={rewrite.isPending || !!live}>
              ✦ {rewrite.isPending ? t.rewriting : t.rewrite}
            </Button>
          </form>
        ) : (
          <p className="m-0 text-xs text-muted-foreground">{t.noStep}</p>
        ))}
    </div>
  );
}

function PanelState({ query }: { query: { isPending: boolean; error: unknown; refetch: () => unknown } }) {
  const env = useDocEditorEnv();
  const t = docEditorText[env.lang];
  if (query.error)
    return (
      <div className="p-3.5">
        <Alert variant="destructive">
          {env.errorMessage(query.error)}
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>
            {t.retry}
          </Button>
        </Alert>
      </div>
    );
  return (
    <p role="status" aria-busy="true" className="p-3.5 text-muted-foreground">
      {t.loading}
    </p>
  );
}
