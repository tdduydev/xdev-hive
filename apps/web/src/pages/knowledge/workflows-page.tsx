import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DryRunResult, ReviewGate, ReviewWorkflow, WorkflowPreset, WorkflowSubject } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { GateKindBadge } from "@/components/gate-kind-badge.tsx";
import { EmptyState, LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Lang, useLang, useT } from "@/lib/i18n.ts";
import { usePermissions } from "@/lib/permissions.ts";
import {
  allGateIds,
  defaultPreset,
  draftFromInput,
  draftOf,
  moveGate,
  newDraft,
  newGate,
  PHASE_DESC,
  PRESET_LABEL,
  presetPhases,
  presetsOf,
  ROLE_LABEL,
  SUBJECT_LABEL,
  SUBJECTS,
  toInput,
  type WorkflowDraft,
  type WorkflowIssue,
  withSubject,
  workflowIssues,
} from "@/lib/review-workflows.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { cn } from "@/lib/utils.ts";
import {
  CodeDryRunDialog,
  CodeGateConfig,
  CodeReplacesNote,
  CodeScope,
  codeGateCond,
  codeGateWho,
  codeText,
  FromProjectDialog,
} from "@/pages/knowledge/workflow-code-config.tsx";
import { Field, GateConfig, hubIssuesOf, IssueAlert, segButton } from "@/pages/knowledge/workflow-gate-config.tsx";
import { type WorkflowsText, workflowsText } from "@/pages/knowledge/workflows-text.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const NEW = "new";
const text = workflowsText;
type T = WorkflowsText;

function gateWho(
  g: ReviewGate,
  subject: WorkflowSubject,
  names: Map<string, string>,
  teamNames: Map<string, string>,
  lang: Lang,
  t: T,
): string {
  if (subject === "code") {
    const who = codeGateWho(g, codeText[lang]);
    if (who) return who;
  }
  if (g.kind === "ai")
    return g.ai ? [g.ai.model, t.aiWho(g.ai.checks.length, g.ai.passScore)].filter(Boolean).join(" · ") : t.ruleWho;
  if (g.kind === "rule") return t.ruleWho;
  if (g.kind === "ext") return t.extWho;
  const r = g.reviewers;
  const who = [
    ...(r?.roles ?? []).map((role) => ROLE_LABEL[lang][role]),
    ...(r?.teams ?? []).map((id) => `${t.teamPrefix} ${teamNames.get(id) ?? id}`),
    ...(r?.users ?? []).map((u) => names.get(u) ?? u),
  ];
  if (!who.length) return t.whoNone;
  const q = r?.quorum ?? 1;
  return `${who.join(", ")} · ${q === 0 ? t.whoAll : q === 1 ? t.whoAny : t.whoN(q)}`;
}

function gateCond(g: ReviewGate, subject: WorkflowSubject, lang: Lang, t: T): string {
  if (subject === "code") return codeGateCond(g, codeText[lang], t.condSize);
  const c = g.conditions;
  const parts = [
    ...(c.docTypes.length ? [t.condTypeShort(c.docTypes.join(", "))] : []),
    ...(c.keywords.length ? [t.condKwShort(c.keywords.join(", "))] : []),
    ...(c.minChangedLines ? [t.condSize(c.minChangedLines)] : []),
    ...(c.skipFormattingOnly ? [t.condSkipShort] : []),
  ];
  return parts.length ? t.condLine(parts) : "";
}

/** Chip có nút bỏ và ô thêm ngắn ở cuối (tiền tố "Áp cho", tài liệu đầu ra). */
function ChipList({
  values,
  onChange,
  canWrite,
  addLabel,
  placeholder,
  chipClass,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  canWrite: boolean;
  addLabel: string;
  placeholder: string;
  chipClass?: string;
}) {
  const t = useT(text);
  const [draft, setDraft] = useState("");
  function add(e: FormEvent) {
    e.preventDefault();
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {values.map((v) => (
        <span
          key={v}
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 font-mono text-xs",
            chipClass,
          )}
        >
          {v}
          {canWrite && (
            <button
              type="button"
              aria-label={t.removeChip(v)}
              className="cursor-pointer text-muted-foreground hover:text-foreground"
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <XIcon className="size-3" aria-hidden="true" />
            </button>
          )}
        </span>
      ))}
      {canWrite && (
        <form onSubmit={add} className="inline-flex">
          <input
            aria-label={addLabel}
            placeholder={`+ ${placeholder}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => {
              if (draft.trim()) add(e);
            }}
            className="h-6 w-48 rounded-full border border-dashed border-input bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </form>
      )}
    </span>
  );
}

/** Quy trình duyệt tài liệu (Workflows.dc.html): giai đoạn, checkpoint, cấu hình từng checkpoint, chạy thử. */
export function WorkflowsPage() {
  const { org } = useOrg();
  return <WorkflowsScreen key={org.id} />;
}

function WorkflowsScreen() {
  const { org, api } = useOrg();
  const t = useT(text);
  const tc = useT(codeText);
  const lang = useLang();
  const can = usePermissions();
  const canWrite = isOrgAdmin(org.role) || can("workflows.write");
  const queryClient = useQueryClient();
  const list = useQuery(api.reviewWorkflows.list.queryOptions());
  const teams = useQuery(api.teams.list.queryOptions());
  const members = useQuery(api.orgMembers.list.queryOptions());
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const [filter, setFilter] = useState<WorkflowSubject | "all">("all");
  const [fromOpen, setFromOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, WorkflowDraft>>({});
  const [gateSel, setGateSel] = useState<string | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [saved, setSaved] = useState(false);
  const [presetAsk, setPresetAsk] = useState<WorkflowPreset | null>(null);
  const [removing, setRemoving] = useState(false);
  const [dryOpen, setDryOpen] = useState(false);
  const ids = useId();
  // Bộ lọc "Code" thì quy trình mới cũng là quy trình code, để không phải đổi loại ngay sau khi bấm.
  const freshSubject = filter === "code" ? "code" : "doc";
  const fresh = useMemo(() => newDraft(defaultPreset(freshSubject), text[lang].newName, lang), [lang, freshSubject]);
  const names = useMemo(() => new Map((members.data ?? []).map((m) => [m.userId, m.name])), [members.data]);
  const teamNames = useMemo(() => new Map((teams.data ?? []).map((team) => [team.id, team.name])), [teams.data]);

  const workflows = list.data ?? [];
  const visible = workflows.filter((w) => filter === "all" || w.subject === filter);
  const stays = selected === NEW || visible.some((w) => w.id === selected);
  const key = (stays ? selected : null) ?? visible[0]?.id ?? (canWrite ? NEW : null);
  const base = workflows.find((w) => w.id === key) ?? null;
  const draft: WorkflowDraft | null = key ? (drafts[key] ?? (base ? draftOf(base) : key === NEW ? fresh : null)) : null;

  const save = useMutation({
    mutationFn: (d: WorkflowDraft) => api.reviewWorkflows.save.call(toInput(d)),
    onSuccess: (next, d) => {
      queryClient.setQueryData(api.reviewWorkflows.list.queryKey(), (old: ReviewWorkflow[] | undefined) =>
        old?.some((w) => w.id === next.id) ? old.map((w) => (w.id === next.id ? next : w)) : [...(old ?? []), next],
      );
      setDrafts(({ [d.id ?? NEW]: _, ...rest }) => rest);
      setSelected(next.id);
      setSaved(true);
      setShowIssues(false);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.reviewWorkflows.remove.call({ id }),
    onSuccess: (_, id) => {
      queryClient.setQueryData(api.reviewWorkflows.list.queryKey(), (old: ReviewWorkflow[] | undefined) =>
        old?.filter((w) => w.id !== id),
      );
      setDrafts(({ [id]: _, ...rest }) => rest);
      setSelected(null);
      setRemoving(false);
    },
  });

  // So phần gửi hub: cấu hình của loại gate khác giữ trong nháp không làm quy trình thành "có thay đổi".
  const dirty =
    !!draft &&
    (draft.id === null || (!!base && JSON.stringify(toInput(draft)) !== JSON.stringify(toInput(draftOf(base)))));

  const header = (
    <PageHeader crumb={t.knowledge} title={t.title}>
      {canWrite && draft?.subject === "code" && (
        <Button variant="outline" onClick={() => setFromOpen(true)}>
          {tc.fromProject}
        </Button>
      )}
      <Button variant="outline" disabled={!draft} onClick={() => setDryOpen(true)}>
        {draft?.subject === "code" ? tc.test : t.test}
      </Button>
      {canWrite && (
        <Button disabled={!draft || !dirty || save.isPending} onClick={() => draft && apply(draft)}>
          {save.isPending ? t.saving : t.publish}
        </Button>
      )}
    </PageHeader>
  );

  if (list.isPending || list.isError) {
    return (
      <>
        {header}
        <PageBody>
          {list.isPending ? <LoadingState /> : <LoadFailure error={list.error} retry={() => list.refetch()} />}
        </PageBody>
      </>
    );
  }

  const issues = showIssues && draft ? workflowIssues(draft, lang) : [];
  const hubIssues = save.error ? hubIssuesOf(save.error, draft, lang) : null;
  const badGates = new Set([...issues, ...(hubIssues ?? [])].map((i) => i.gateId).filter(Boolean));

  function apply(d: WorkflowDraft) {
    setSaved(false);
    if (workflowIssues(d, lang).length) {
      setShowIssues(true);
      return;
    }
    save.mutate(d);
  }
  function update(patch: Partial<WorkflowDraft>) {
    if (!draft || !key) return;
    setSaved(false);
    save.reset();
    setDrafts((all) => ({ ...all, [key]: { ...draft, ...patch } }));
  }
  function patchGate(id: string, fn: (g: ReviewGate) => ReviewGate) {
    if (!draft) return;
    update({ phases: draft.phases.map((p) => ({ ...p, gates: p.gates.map((g) => (g.id === id ? fn(g) : g)) })) });
  }
  function pick(next: string) {
    setSelected(next);
    setGateSel(null);
    setSaved(false);
    setShowIssues(false);
    save.reset();
  }
  function applyPreset(preset: WorkflowPreset) {
    if (!draft) return;
    update({ preset, phases: presetPhases(preset, lang) });
    setGateSel(null);
    setPresetAsk(null);
  }
  // Loại chỉ đổi được khi bản nháp chưa lưu; sau khi lưu hub không cho đổi.
  function changeSubject(subject: WorkflowSubject) {
    if (!draft || !key || draft.id || draft.subject === subject) return;
    setSaved(false);
    save.reset();
    setDrafts((all) => ({ ...all, [key]: withSubject(draft, subject, lang) }));
    setGateSel(null);
  }
  function openDraft(input: Parameters<typeof draftFromInput>[0], teamId: string | null) {
    setDrafts((all) => ({ ...all, [NEW]: draftFromInput(input, teamId) }));
    setFromOpen(false);
    pick(NEW);
  }

  const gates = draft?.phases.flatMap((p) => p.gates) ?? [];
  const cur = gates.find((g) => g.id === gateSel) ?? gates[0] ?? null;
  const isCode = draft?.subject === "code";
  const presetShort = isCode
    ? "Code"
    : draft && draft.preset !== "custom"
      ? PRESET_LABEL.en[draft.preset].replace(" (AWS)", "")
      : "#";

  return (
    <>
      {header}
      <PageBody>
        <p className="-mt-2 max-w-3xl text-muted-foreground">{isCode ? tc.lead : t.lead}</p>
        {!canWrite && <Alert>{t.readOnly}</Alert>}
        {issues.length > 0 && <IssueAlert title={t.invalid} issues={issues} />}
        {hubIssues && <IssueAlert title={t.invalid} issues={hubIssues} />}
        {save.error && !hubIssues && <Alert variant="destructive">{apiErrorMessage(save.error)}</Alert>}
        {saved && !dirty && (
          <p role="status" className="text-sm text-success">
            {t.saved}
          </p>
        )}
        {canWrite && dirty && <p className="text-sm text-muted-foreground">{t.unsaved}</p>}

        {!draft && <EmptyState title={t.empty} description={t.emptyHint} />}
        {draft && (
          <>
            <section className="flex flex-col gap-3 rounded-xl border bg-card px-3.5 py-3 text-card-foreground">
              <div className="flex flex-wrap items-center gap-3">
                <fieldset className="m-0 flex flex-wrap items-center gap-2 border-0 p-0">
                  <legend className="float-left text-sm font-medium">{tc.subject}</legend>
                  <span className="inline-flex gap-0.5 rounded-lg bg-muted p-0.75">
                    {SUBJECTS.map((sj) => (
                      <label
                        key={sj}
                        className={cn(
                          segButton(draft.subject === sj),
                          "relative inline-flex items-center has-focus-visible:ring-2 has-focus-visible:ring-ring/50",
                        )}
                      >
                        <input
                          type="radio"
                          name={`${ids}-subject`}
                          value={sj}
                          // Ô radio trong suốt phủ cả nhãn, như bộ chọn loại checkpoint. Loại cố định sau khi lưu:
                          // hub từ chối đổi, nên chỉ bản nháp mới chọn được.
                          className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-md opacity-0 disabled:cursor-not-allowed"
                          checked={draft.subject === sj}
                          disabled={!canWrite || draft.id !== null}
                          onChange={() => changeSubject(sj)}
                        />
                        {SUBJECT_LABEL[lang][sj]}
                      </label>
                    ))}
                  </span>
                  {draft.id !== null && (
                    <span className="text-xs text-muted-foreground" title={tc.lockedHint}>
                      🔒 {tc.locked}
                    </span>
                  )}
                </fieldset>
                <fieldset className="m-0 flex flex-wrap items-center gap-2 border-0 p-0">
                  <legend className="float-left text-sm text-muted-foreground">{tc.filter}</legend>
                  <span className="inline-flex gap-0.5 rounded-lg bg-muted p-0.75">
                    {(["all", ...SUBJECTS] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={filter === f}
                        className={segButton(filter === f)}
                        onClick={() => {
                          setFilter(f);
                          setGateSel(null);
                        }}
                      >
                        {f === "all" ? tc.filterAll : SUBJECT_LABEL[lang][f]}
                      </button>
                    ))}
                  </span>
                </fieldset>
              </div>
              <div className="flex flex-wrap items-center gap-3 border-t border-dashed border-input pt-3">
                <label htmlFor={`${ids}-wf`} className="flex w-full items-center gap-2 text-sm font-medium sm:w-auto">
                  {t.workflow}
                  <NativeSelect
                    id={`${ids}-wf`}
                    className="min-w-0 flex-1 sm:w-65 sm:flex-none"
                    value={key ?? ""}
                    onChange={(e) => pick(e.target.value)}
                  >
                    {visible.map((w) => (
                      <option key={w.id} value={w.id}>
                        {(drafts[w.id]?.name ?? w.name) || w.name}
                        {w.subject === "code" ? ` · ${SUBJECT_LABEL[lang].code}` : ""}
                        {w.enabled ? "" : ` (${t.off})`}
                      </option>
                    ))}
                    {(key === NEW || drafts[NEW]) && <option value={NEW}>{drafts[NEW]?.name || t.newName}</option>}
                  </NativeSelect>
                  {isCode && <Pill tone="neutral">{SUBJECT_LABEL[lang].code}</Pill>}
                </label>
                {canWrite && key !== NEW && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDrafts((all) => (all[NEW] ? all : { ...all, [NEW]: fresh }));
                      pick(NEW);
                    }}
                  >
                    <PlusIcon aria-hidden="true" />
                    {t.newWorkflow}
                  </Button>
                )}
                <fieldset className="m-0 flex flex-wrap items-center gap-3 border-0 p-0">
                  <legend className="float-left text-sm text-muted-foreground">{t.preset}</legend>
                  <span className="inline-flex flex-wrap gap-0.5 rounded-lg bg-muted p-0.75">
                    {presetsOf(draft.subject).map((p) => (
                      <button
                        key={p}
                        type="button"
                        aria-pressed={draft.preset === p}
                        disabled={!canWrite}
                        className={segButton(draft.preset === p)}
                        onClick={() => {
                          if (p === draft.preset) return;
                          if (draft.id) setPresetAsk(p);
                          else applyPreset(p);
                        }}
                      >
                        {PRESET_LABEL[lang][p]}
                      </button>
                    ))}
                  </span>
                </fieldset>
                {!isCode && (
                  <span className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-sm text-muted-foreground">{t.appliesTo}</span>
                    <ChipList
                      values={draft.docPrefixes}
                      onChange={(docPrefixes) => update({ docPrefixes })}
                      canWrite={canWrite}
                      addLabel={t.addPrefix}
                      placeholder={t.prefixPh}
                    />
                  </span>
                )}
              </div>
              <WorkflowMeta
                draft={draft}
                base={base}
                canWrite={canWrite}
                teams={teams.data ?? []}
                onChange={update}
                onRemove={() => setRemoving(true)}
              />
            </section>

            {isCode && (
              <>
                <CodeScope
                  draft={draft}
                  canWrite={canWrite}
                  projects={projects.data ?? []}
                  onChange={(patch) => update({ code: draft.code && { ...draft.code, ...patch } })}
                />
                <CodeReplacesNote />
              </>
            )}

            <div className="flex flex-wrap items-start gap-4">
              <section aria-label={t.pipeline} className="flex min-w-0 flex-[999_1_640px] gap-3 overflow-x-auto pb-1.5">
                {draft.phases.map((p, pi) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: giai đoạn không có mã; thứ tự là thứ tự chạy.
                    key={pi}
                    className="flex flex-[1_0_230px] flex-col gap-2.5 rounded-xl bg-muted p-3"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      {canWrite ? (
                        <input
                          aria-label={t.phaseName(pi + 1)}
                          value={p.name}
                          onChange={(e) =>
                            update({
                              phases: draft.phases.map((x, i) => (i === pi ? { ...x, name: e.target.value } : x)),
                            })
                          }
                          className="w-0 min-w-0 flex-1 rounded-sm bg-transparent font-heading text-sm font-semibold tracking-[-0.02em] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        />
                      ) : (
                        <strong className="font-heading text-sm tracking-[-0.02em]">{p.name}</strong>
                      )}
                      <span className="font-mono text-xs text-muted-foreground">
                        {presetShort} {pi + 1}
                      </span>
                      {canWrite && draft.phases.length > 1 && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t.removePhase(p.name)}
                          onClick={() => update({ phases: draft.phases.filter((_, i) => i !== pi) })}
                        >
                          <XIcon aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                    {canWrite ? (
                      <textarea
                        aria-label={t.phaseDesc(pi + 1)}
                        rows={1}
                        maxLength={300}
                        // Giai đoạn của khung mẫu chưa có mô tả riêng thì gợi ý mô tả mặc định như thiết kế.
                        placeholder={PHASE_DESC[p.name]?.[lang] ?? t.phaseDescPh}
                        value={p.description ?? ""}
                        onChange={(e) =>
                          update({
                            phases: draft.phases.map((x, i) => (i === pi ? { ...x, description: e.target.value } : x)),
                          })
                        }
                        className="-mt-1.5 field-sizing-content resize-none rounded-sm bg-transparent text-xs text-muted-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                    ) : (
                      (p.description || PHASE_DESC[p.name]) && (
                        <span className="-mt-1.5 text-xs text-muted-foreground">
                          {p.description || PHASE_DESC[p.name]?.[lang]}
                        </span>
                      )
                    )}
                    {p.gates.length === 0 && <span className="text-xs text-muted-foreground">{t.noGates}</span>}
                    {p.gates.map((g, gi) => {
                      const on = g.id === cur?.id;
                      const cond = gateCond(g, draft.subject, lang, t);
                      return (
                        <div key={g.id} className="flex flex-col items-stretch gap-1.5">
                          <button
                            type="button"
                            aria-pressed={on}
                            onClick={() => setGateSel(g.id)}
                            className={cn(
                              "flex cursor-pointer flex-col gap-1 rounded-[10px] border bg-card px-3 py-2.5 text-left text-card-foreground",
                              on ? "border-primary ring-2 ring-accent" : "border-border",
                              badGates.has(g.id) && "border-destructive ring-2 ring-destructive-soft",
                            )}
                          >
                            <span className="flex items-center gap-1.5">
                              <GateKindBadge kind={g.kind} />
                              <span className="ml-auto font-mono text-xs text-muted-foreground">
                                {g.slaHours ? `${g.slaHours}h` : "—"}
                              </span>
                            </span>
                            <span className="text-sm font-semibold">{g.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {gateWho(g, draft.subject, names, teamNames, lang, t)}
                            </span>
                            {cond && <span className="text-xs text-warning">⤷ {cond}</span>}
                          </button>
                          {gi < p.gates.length - 1 && (
                            <span aria-hidden="true" className="text-center text-xs leading-none text-muted-foreground">
                              ↓
                            </span>
                          )}
                        </div>
                      );
                    })}
                    {canWrite && (
                      <button
                        type="button"
                        className="h-8.5 cursor-pointer rounded-lg border border-dashed border-input bg-transparent text-sm text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          const g = newGate(t.newGateName, allGateIds(draft.phases), lang, draft.subject);
                          update({
                            phases: draft.phases.map((x, i) => (i === pi ? { ...x, gates: [...x.gates, g] } : x)),
                          });
                          setGateSel(g.id);
                        }}
                      >
                        + {t.addGate}
                      </button>
                    )}
                    <div className="mt-0.5 flex flex-col gap-1 border-t border-dashed border-input pt-2 text-xs">
                      <span className="text-muted-foreground">{t.outputs}</span>
                      <ChipList
                        values={p.outputs}
                        onChange={(outputs) =>
                          update({ phases: draft.phases.map((x, i) => (i === pi ? { ...x, outputs } : x)) })
                        }
                        canWrite={canWrite}
                        addLabel={t.addOutput(p.name)}
                        placeholder={t.outputPh}
                        chipClass="bg-card"
                      />
                    </div>
                  </div>
                ))}
                {canWrite && draft.phases.length < 10 && (
                  <button
                    type="button"
                    aria-label={t.addPhase}
                    title={t.addPhase}
                    className="flex min-h-40 flex-[0_0_40px] cursor-pointer items-center justify-center rounded-xl border border-dashed border-input text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      update({
                        phases: [
                          ...draft.phases,
                          { name: t.newPhase(draft.phases.length + 1), outputs: [], gates: [] },
                        ],
                      })
                    }
                  >
                    <PlusIcon className="size-4" aria-hidden="true" />
                  </button>
                )}
              </section>

              <aside
                aria-label={t.config}
                className="flex w-full min-w-75 flex-[1_1_340px] flex-col overflow-hidden rounded-xl border bg-card text-card-foreground md:max-w-100"
              >
                {cur ? (
                  <GateConfigFor
                    // Ô nhiều dòng giữ chữ đang gõ; đổi quy trình, khung mẫu hay gate thì dựng lại từ dữ liệu mới.
                    key={`${key}:${draft.preset}:${cur.id}`}
                    subject={draft.subject}
                    gate={cur}
                    canWrite={canWrite}
                    members={members.data ?? []}
                    teams={teams.data ?? []}
                    canMoveUp={gates[0]?.id !== cur.id}
                    canMoveDown={gates.at(-1)?.id !== cur.id}
                    onChange={(fn) => patchGate(cur.id, fn)}
                    onMove={(delta) => update({ phases: moveGate(draft.phases, cur.id, delta) })}
                    onRemove={() => {
                      update({
                        phases: draft.phases.map((p) => ({ ...p, gates: p.gates.filter((g) => g.id !== cur.id) })),
                      });
                      setGateSel(null);
                    }}
                  />
                ) : (
                  <p className="px-4 py-3.5 text-sm text-muted-foreground">{t.pickGate}</p>
                )}
              </aside>
            </div>
          </>
        )}
      </PageBody>

      {dryOpen && draft && isCode && (
        <CodeDryRunDialog draft={draft} projects={projects.data ?? []} onClose={() => setDryOpen(false)} />
      )}
      {dryOpen && draft && !isCode && <DryRunDialog draft={draft} onClose={() => setDryOpen(false)} />}
      {fromOpen && (
        <FromProjectDialog projects={projects.data ?? []} onClose={() => setFromOpen(false)} onDraft={openDraft} />
      )}
      {presetAsk && (
        <Dialog open onOpenChange={(open) => !open && setPresetAsk(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t.presetTitle(PRESET_LABEL[lang][presetAsk])}</DialogTitle>
              <DialogDescription>{t.presetBody}</DialogDescription>
            </DialogHeader>
            <DialogActions>
              <Button variant="outline" onClick={() => setPresetAsk(null)}>
                {t.cancel}
              </Button>
              <Button onClick={() => applyPreset(presetAsk)}>{t.presetApply}</Button>
            </DialogActions>
          </DialogContent>
        </Dialog>
      )}
      {removing && base && (
        <Dialog open onOpenChange={(open) => !open && setRemoving(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t.removeTitle}</DialogTitle>
              <DialogDescription>{t.removeBody(base.name, base.inFlight)}</DialogDescription>
            </DialogHeader>
            {remove.isError && <Alert variant="destructive">{apiErrorMessage(remove.error)}</Alert>}
            <DialogActions>
              <Button variant="outline" onClick={() => setRemoving(false)}>
                {t.cancel}
              </Button>
              <Button variant="destructive-solid" disabled={remove.isPending} onClick={() => remove.mutate(base.id)}>
                {t.removeConfirm}
              </Button>
            </DialogActions>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

type GateConfigProps = React.ComponentProps<typeof GateConfig>;

/** Khung cấu hình checkpoint theo loại quy trình: tài liệu và code dùng chung đầu khung, khác phần thân. */
function GateConfigFor({ subject, ...props }: GateConfigProps & { subject: WorkflowSubject }) {
  return subject === "code" ? <CodeGateConfig {...props} /> : <GateConfig {...props} />;
}

function WorkflowMeta({
  draft,
  base,
  canWrite,
  teams,
  onChange,
  onRemove,
}: {
  draft: WorkflowDraft;
  base: ReviewWorkflow | null;
  canWrite: boolean;
  teams: { id: string; name: string }[];
  onChange: (patch: Partial<WorkflowDraft>) => void;
  onRemove: () => void;
}) {
  const t = useT(text);
  const ids = useId();
  return (
    <div className="flex flex-wrap items-end gap-3 border-t border-dashed border-input pt-3">
      <div className="w-full sm:w-60">
        <Field label={t.name} htmlFor={`${ids}-name`}>
          <Input
            id={`${ids}-name`}
            maxLength={120}
            value={draft.name}
            disabled={!canWrite}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </Field>
      </div>
      <div className="w-full sm:w-52">
        <Field label={t.team} htmlFor={`${ids}-team`}>
          <NativeSelect
            id={`${ids}-team`}
            value={draft.teamId ?? ""}
            disabled={!canWrite}
            onChange={(e) => onChange({ teamId: e.target.value || null })}
          >
            <option value="">{t.wholeOrg}</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <label htmlFor={`${ids}-on`} className="flex h-8 cursor-pointer items-center gap-2 text-sm font-medium">
        <Switch
          id={`${ids}-on`}
          aria-label={t.enabled}
          checked={draft.enabled}
          disabled={!canWrite}
          onCheckedChange={(enabled) => onChange({ enabled })}
        />
        {t.enabled}
      </label>
      <span className="flex h-8 items-center text-xs text-muted-foreground">{t.inFlight(base?.inFlight ?? 0)}</span>
      <span className="flex-1" />
      {canWrite && base && (
        <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={onRemove}>
          <Trash2Icon aria-hidden="true" />
          {t.remove}
        </Button>
      )}
    </div>
  );
}

function DryRunDialog({ draft, onClose }: { draft: WorkflowDraft; onClose: () => void }) {
  const { api } = useOrg();
  const t = useT(text);
  const lang = useLang();
  const ids = useId();
  const [docKey, setDocKey] = useState(draft.docPrefixes[0]?.startsWith("project/") ? draft.docPrefixes[0] : "");
  const [issues, setIssues] = useState<WorkflowIssue[]>([]);
  const run = useMutation({
    mutationFn: (key: string): Promise<DryRunResult> =>
      api.reviewWorkflows.dryRun.call({ workflow: toInput(draft), docKey: key }),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    const found = workflowIssues(draft, lang);
    setIssues(found);
    if (!found.length && docKey.trim()) run.mutate(docKey.trim());
  }
  const hubIssues = run.error ? hubIssuesOf(run.error, draft, lang) : null;
  const r = run.data;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t.dryTitle}</DialogTitle>
          <DialogDescription>{t.dryDesc}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex items-end gap-2">
          <div className="flex-1">
            <Field label={t.docKey} htmlFor={`${ids}-key`}>
              <Input
                id={`${ids}-key`}
                required
                maxLength={200}
                className="font-mono"
                placeholder="project/payment-api/prd"
                value={docKey}
                onChange={(e) => setDocKey(e.target.value)}
              />
            </Field>
          </div>
          <Button type="submit" variant="outline" disabled={run.isPending || !docKey.trim()}>
            {run.isPending ? t.running : t.run}
          </Button>
        </form>
        {issues.length > 0 && <IssueAlert title={t.invalid} issues={issues} />}
        {hubIssues && <IssueAlert title={t.invalid} issues={hubIssues} />}
        {run.error && !hubIssues && <Alert variant="destructive">{apiErrorMessage(run.error)}</Alert>}
        {r && (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              <span className="font-mono">{r.docKey}</span> · {t.docType}:{" "}
              <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs text-secondary-foreground">
                {r.docType}
              </span>
            </p>
            {!r.matched && <Alert>{t.notMatched}</Alert>}
            <ol aria-label={t.dryGates} className="flex flex-col overflow-hidden rounded-[10px] border">
              {r.gates.map((g) => (
                <li
                  key={g.gateId}
                  className={cn("flex flex-col gap-1.5 border-b px-3 py-2.5 last:border-b-0", !g.runs && "bg-muted/50")}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <GateKindBadge kind={g.kind} />
                    <span className={cn("text-sm font-semibold", !g.runs && "text-muted-foreground")}>{g.name}</span>
                    <Pill tone={g.runs ? "ok" : "neutral"} className="ml-auto">
                      {g.runs ? t.runs : t.skips}
                    </Pill>
                  </span>
                  <span className="text-xs text-muted-foreground">{g.reason}</span>
                  {g.checklist.length > 0 && (
                    <ul className="flex flex-col gap-1 text-sm">
                      {g.checklist.map((c) => (
                        <li key={c.label} className="flex items-start gap-2">
                          <span
                            aria-hidden="true"
                            className={cn(
                              "inline-flex size-4.5 flex-none items-center justify-center rounded-full text-xs",
                              c.passed ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive",
                            )}
                          >
                            {c.passed ? "✓" : "✗"}
                          </span>
                          <span>
                            <span className="sr-only">{c.passed ? "✓ " : "✗ "}</span>
                            {c.label}
                            {c.note && <span className="block text-xs text-muted-foreground">{c.note}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
        <DialogActions>
          <Button variant="outline" onClick={onClose}>
            {t.close}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
