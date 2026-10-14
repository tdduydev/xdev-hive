import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
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
import { LockIcon, PlusIcon, Trash2Icon, WorkflowIcon, XIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { GateKindBadge } from "@/components/gate-kind-badge.tsx";
import { ChipInput } from "@/components/page/chip-input.tsx";
import { DangerZone } from "@/components/page/danger-zone.tsx";
import { SegmentedControl } from "@/components/page/segmented-control.tsx";
import {
  FormRow,
  RadioCards,
  type SectionSave,
  SettingsLayout,
  SettingsNav,
  SettingsSection,
  SwitchRow,
} from "@/components/page/settings.tsx";
import { UnsavedChangesGuard } from "@/components/page/unsaved-guard.tsx";
import { Field, FieldLabel } from "@/components/ui/field.tsx";
import { EmptyState, LoadFailure, SectionsSkeleton } from "@/components/ui/query-state.tsx";
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
  CodeOnPassRows,
  CodeScopeRows,
  codeGateCond,
  codeGateWho,
  codeText,
  FromProjectDialog,
} from "@/pages/knowledge/workflow-code-config.tsx";
import { GateConfig, hubIssuesOf, IssueAlert } from "@/pages/knowledge/workflow-gate-config.tsx";
import { type WorkflowsText, workflowsText } from "@/pages/knowledge/workflows-text.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const NEW = "new";
const text = workflowsText;
type T = WorkflowsText;

/** Các mục lưu riêng của quy trình (admin-layout.md § Decisions 4). Phạm vi và khi đạt chỉ có ở quy trình code. */
type SectionId = "general" | "scope" | "pass" | "pipeline";

const SECTION_ANCHOR: Record<SectionId, string> = {
  general: "quy-trinh-chung",
  scope: "quy-trinh-pham-vi",
  pass: "quy-trinh-khi-dat",
  pipeline: "quy-trinh-giai-doan",
};

/**
 * Lấy ô của một mục từ `from` đặt vào `to`. Lưu một mục gửi bản đã lưu cộng đúng ô của mục đó, nên chữ đang gõ dở ở
 * mục khác không bị gửi theo; Huỷ một mục cũng chỉ trả lại ô của mục đó.
 */
function withSection(id: SectionId, to: WorkflowDraft, from: WorkflowDraft): WorkflowDraft {
  if (id === "general")
    return { ...to, name: from.name, teamId: from.teamId, enabled: from.enabled, docPrefixes: from.docPrefixes };
  if (id === "pipeline") return { ...to, preset: from.preset, phases: from.phases };
  if (!to.code || !from.code) return to;
  const c = from.code;
  return {
    ...to,
    code:
      id === "scope"
        ? { ...to.code, projects: c.projects, baseBranches: c.baseBranches, taskTypes: c.taskTypes, paths: c.paths }
        : {
            ...to.code,
            merge: c.merge,
            maxAgentRevisions: c.maxAgentRevisions,
            dismissStaleApprovals: c.dismissStaleApprovals,
          },
  };
}

// So phần gửi hub: cấu hình của loại gate khác giữ trong nháp không làm quy trình thành "có thay đổi".
const sameInput = (a: WorkflowDraft, b: WorkflowDraft) => JSON.stringify(toInput(a)) === JSON.stringify(toInput(b));

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

const issueLine = (t: T, issues: WorkflowIssue[]) =>
  `${t.invalid} ${issues.map((i) => (i.where ? `${i.where}: ${i.message}` : i.message)).join(" · ")}`;

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
  // Mục vừa bấm Lưu mà quy trình còn lỗi: lỗi hiện ở chân mục đó và tự hết khi sửa xong.
  const [checking, setChecking] = useState<SectionId | null>(null);
  const [savedAt, setSavedAt] = useState<SectionId | null>(null);
  const [presetAsk, setPresetAsk] = useState<WorkflowPreset | null>(null);
  const [removing, setRemoving] = useState(false);
  const [dryOpen, setDryOpen] = useState(false);
  const configRef = useRef<HTMLElement>(null);
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
  const baseDraft = useMemo(() => (base ? draftOf(base) : null), [base]);
  const draft: WorkflowDraft | null = key ? (drafts[key] ?? baseDraft ?? (key === NEW ? fresh : null)) : null;
  const isNew = draft?.id === null;
  const isCode = draft?.subject === "code";

  const save = useMutation({
    mutationFn: (v: { draft: WorkflowDraft; section: SectionId }) => api.reviewWorkflows.save.call(toInput(v.draft)),
    onSuccess: (next, { draft: sent, section }) => {
      queryClient.setQueryData(api.reviewWorkflows.list.queryKey(), (old: ReviewWorkflow[] | undefined) =>
        old?.some((w) => w.id === next.id) ? old.map((w) => (w.id === next.id ? next : w)) : [...(old ?? []), next],
      );
      const stored = draftOf(next);
      // Mục khác của quy trình vẫn giữ thay đổi chưa lưu; quy trình mới thì cả bản nháp đã thành quy trình.
      setDrafts(({ [sent.id ?? NEW]: cur, ...rest }) => {
        if (!cur || sent.id === null) return rest;
        const kept = withSection(section, cur, stored);
        return sameInput(kept, stored) ? rest : { ...rest, [next.id]: kept };
      });
      setSelected(next.id);
      setSavedAt(section);
      setChecking(null);
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
      setSavedAt(null);
      setRemoving(false);
    },
  });

  // Nút "Tạo quy trình từ cấu hình này" ở Cài đặt dự án dẫn tới đây kèm `?duan=`: dựng bản nháp, không lưu.
  const { duan } = useSearch({ from: "/session/app/in-org/knowledge/workflows" });
  const navigate = useNavigate();
  const handedOff = useRef<string | null>(null);
  const fromSearch = useMutation({
    mutationFn: (projectKey: string) => api.codeReviews.workflowFromProject.call({ projectKey }),
    onSuccess: (input, projectKey) =>
      openDraft(input, projects.data?.find((p) => p.key === projectKey)?.teamId ?? null),
  });
  // Chờ danh sách dự án để biết đội của dự án nguồn; chỉ chạy một lần cho mỗi giá trị `duan`.
  useEffect(() => {
    if (!duan || projects.isPending || handedOff.current === duan) return;
    handedOff.current = duan;
    if (canWrite) fromSearch.mutate(duan);
    void navigate({ to: "/knowledge/workflows", search: {}, replace: true });
  }, [duan, projects.isPending, canWrite, fromSearch.mutate, navigate]);

  // Rời trang thì mất mọi bản nháp (kể cả của quy trình đang không mở); bản nháp mới chưa sửa gì thì không hỏi.
  const anyDirty =
    canWrite &&
    Object.entries(drafts).some(([k, d]) => {
      if (k === NEW) return !sameInput(d, newDraft(defaultPreset(d.subject), text[lang].newName, lang));
      const w = workflows.find((x) => x.id === k);
      return !!w && !sameInput(d, draftOf(w));
    });

  const header = (
    <PageHeader title={t.title} description={t.description}>
      {canWrite && isCode && (
        <Button variant="outline" onClick={() => setFromOpen(true)}>
          {tc.fromProject}
        </Button>
      )}
      <Button variant="outline" disabled={!draft} onClick={() => setDryOpen(true)}>
        {isCode ? tc.test : t.test}
      </Button>
      {canWrite && (
        <Button
          onClick={() => {
            setDrafts((all) => (all[NEW] ? all : { ...all, [NEW]: fresh }));
            pick(NEW);
          }}
        >
          <PlusIcon aria-hidden="true" />
          {t.newWorkflow}
        </Button>
      )}
    </PageHeader>
  );

  if (list.isPending || list.isError) {
    return (
      <>
        {header}
        <PageBody>
          {list.isPending ? <SectionsSkeleton /> : <LoadFailure error={list.error} retry={() => list.refetch()} />}
        </PageBody>
      </>
    );
  }

  // Quy trình mới gửi cả bản nháp vì hub chưa có gì; quy trình đã lưu gửi bản đã lưu cộng ô của mục.
  const sentFor = (id: SectionId, d: WorkflowDraft) => (baseDraft && d.id !== null ? withSection(id, baseDraft, d) : d);
  const dirtyOf = (id: SectionId) =>
    !!draft && (isNew || (!!baseDraft && !sameInput(withSection(id, baseDraft, draft), baseDraft)));
  const issues = checking && draft ? workflowIssues(sentFor(checking, draft), lang) : [];
  const sent = save.variables;
  const hubIssues = save.error && sent ? hubIssuesOf(save.error, sent.draft, lang) : null;
  const badGates = new Set([...issues, ...(hubIssues ?? [])].map((i) => i.gateId).filter(Boolean));

  function errorOf(id: SectionId) {
    if (checking === id && issues.length) return issueLine(t, issues);
    if (!save.error || sent?.section !== id) return undefined;
    return hubIssues ? issueLine(t, hubIssues) : apiErrorMessage(save.error);
  }
  function sectionSave(id: SectionId): SectionSave | undefined {
    if (!canWrite || !draft) return undefined;
    return {
      dirty: dirtyOf(id),
      saving: save.isPending && sent?.section === id,
      saved: savedAt === id,
      error: errorOf(id),
      disabled: save.isPending,
      ...(isNew ? { saveLabel: t.create } : {}),
      onSave: () => submit(id),
      onDiscard: () => discard(id),
    };
  }
  function submit(id: SectionId) {
    if (!draft) return;
    const d = sentFor(id, draft);
    setSavedAt(null);
    if (workflowIssues(d, lang).length) {
      setChecking(id);
      return;
    }
    save.mutate({ draft: d, section: id });
  }
  function discard(id: SectionId) {
    if (!draft || !key) return;
    const origin = baseDraft ?? newDraft(defaultPreset(draft.subject), t.newName, lang);
    setDrafts((all) => ({ ...all, [key]: withSection(id, draft, origin) }));
    setChecking(null);
    if (save.isError) save.reset();
  }
  function update(patch: Partial<WorkflowDraft>) {
    if (!draft || !key) return;
    if (save.isError) save.reset();
    setDrafts((all) => ({ ...all, [key]: { ...draft, ...patch } }));
  }
  function patchGate(id: string, fn: (g: ReviewGate) => ReviewGate) {
    if (!draft) return;
    update({ phases: draft.phases.map((p) => ({ ...p, gates: p.gates.map((g) => (g.id === id ? fn(g) : g)) })) });
  }
  function pick(next: string) {
    setSelected(next);
    setGateSel(null);
    setSavedAt(null);
    setChecking(null);
    save.reset();
  }
  function selectGate(id: string) {
    setGateSel(id);
    // Dưới 1280 px khung cấu hình nằm dưới các giai đoạn: đưa nó vào tầm nhìn để thấy ngay checkpoint vừa chọn.
    if (window.matchMedia("(min-width: 80rem)").matches) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    configRef.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
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
    if (save.isError) save.reset();
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
  const presetShort = isCode
    ? "Code"
    : draft && draft.preset !== "custom"
      ? PRESET_LABEL.en[draft.preset].replace(" (AWS)", "")
      : "#";
  const sections: SectionId[] = isCode ? ["general", "scope", "pass", "pipeline"] : ["general", "pipeline"];
  const sectionTitle: Record<SectionId, string> = {
    general: t.general,
    scope: tc.scope,
    pass: tc.onPassTitle,
    pipeline: t.pipelineTitle,
  };

  return (
    <>
      {header}
      <PageBody>
        {canWrite && <UnsavedChangesGuard when={anyDirty} />}
        {!canWrite && <Alert role="note">{t.readOnly}</Alert>}
        {fromSearch.error && <Alert variant="destructive">{apiErrorMessage(fromSearch.error)}</Alert>}

        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="grid w-full gap-1.5 sm:w-80">
            <label htmlFor={`${ids}-wf`} className="text-sm font-medium">
              {t.workflow}
            </label>
            <NativeSelect id={`${ids}-wf`} value={key ?? ""} onChange={(e) => pick(e.target.value)}>
              {visible.map((w) => (
                <option key={w.id} value={w.id}>
                  {(drafts[w.id]?.name ?? w.name) || w.name}
                  {w.subject === "code" ? ` · ${SUBJECT_LABEL[lang].code}` : ""}
                  {w.enabled ? "" : ` (${t.off})`}
                </option>
              ))}
              {(key === NEW || drafts[NEW]) && <option value={NEW}>{drafts[NEW]?.name || t.newName}</option>}
            </NativeSelect>
          </div>
          <SegmentedControl
            label={t.filter}
            value={filter}
            onChange={(f) => {
              setFilter(f);
              setGateSel(null);
            }}
            options={[
              { value: "all", label: t.filterAll },
              ...SUBJECTS.map((sj) => ({ value: sj, label: SUBJECT_LABEL[lang][sj] })),
            ]}
          />
        </div>

        {!draft && <EmptyState icon={WorkflowIcon} title={t.empty} description={t.emptyHint} />}
        {draft && (
          <SettingsLayout
            nav={
              isCode ? (
                <SettingsNav
                  label={t.sectionsNav}
                  items={sections.map((id) => ({ id: SECTION_ANCHOR[id], label: sectionTitle[id] }))}
                />
              ) : undefined
            }
          >
            <SettingsSection
              id={SECTION_ANCHOR.general}
              title={t.general}
              description={t.generalHint}
              save={sectionSave("general")}
            >
              <FormRow
                label={t.subject}
                hint={
                  draft.id === null ? (
                    t.subjectHint
                  ) : (
                    <span className="inline-flex items-center gap-1" title={tc.lockedHint}>
                      <LockIcon aria-hidden="true" className="size-3" />
                      {tc.locked}
                    </span>
                  )
                }
              >
                <RadioCards
                  name={`${ids}-subject`}
                  label={t.subject}
                  value={draft.subject}
                  onChange={changeSubject}
                  // Hub từ chối đổi loại của quy trình đã lưu, nên chỉ bản nháp mới chọn được.
                  disabled={!canWrite || draft.id !== null}
                  columns={2}
                  options={SUBJECTS.map((sj) => ({
                    value: sj,
                    title: SUBJECT_LABEL[lang][sj],
                    description: t.subjectDesc[sj],
                  }))}
                />
              </FormRow>
              <FormRow label={t.name} htmlFor={`${ids}-name`}>
                <Input
                  id={`${ids}-name`}
                  maxLength={120}
                  value={draft.name}
                  disabled={!canWrite}
                  onChange={(e) => update({ name: e.target.value })}
                />
              </FormRow>
              <FormRow label={t.team} htmlFor={`${ids}-team`}>
                <NativeSelect
                  id={`${ids}-team`}
                  value={draft.teamId ?? ""}
                  disabled={!canWrite}
                  onChange={(e) => update({ teamId: e.target.value || null })}
                >
                  <option value="">{t.wholeOrg}</option>
                  {(teams.data ?? []).map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </NativeSelect>
              </FormRow>
              {!isCode && (
                <FormRow label={t.prefixes} hint={t.prefixesHint}>
                  <ChipInput
                    boxed
                    values={draft.docPrefixes}
                    onChange={(docPrefixes) => update({ docPrefixes })}
                    canWrite={canWrite}
                    addLabel={t.addPrefix}
                    placeholder={t.prefixPh}
                  />
                </FormRow>
              )}
              <SwitchRow
                label={t.enabled}
                hint={t.inFlight(base?.inFlight ?? 0)}
                checked={draft.enabled}
                disabled={!canWrite}
                onChange={(enabled) => update({ enabled })}
              />
            </SettingsSection>

            {isCode && (
              <>
                <SettingsSection
                  id={SECTION_ANCHOR.scope}
                  title={tc.scope}
                  description={tc.scopeHint}
                  save={sectionSave("scope")}
                >
                  <CodeScopeRows
                    draft={draft}
                    canWrite={canWrite}
                    projects={projects.data ?? []}
                    onChange={(patch) => update({ code: draft.code && { ...draft.code, ...patch } })}
                  />
                </SettingsSection>
                <SettingsSection
                  id={SECTION_ANCHOR.pass}
                  title={tc.onPassTitle}
                  description={tc.onPassHint}
                  save={sectionSave("pass")}
                >
                  <CodeOnPassRows
                    draft={draft}
                    canWrite={canWrite}
                    onChange={(patch) => update({ code: draft.code && { ...draft.code, ...patch } })}
                  />
                </SettingsSection>
              </>
            )}

            <SettingsSection
              id={SECTION_ANCHOR.pipeline}
              title={t.pipelineTitle}
              description={t.pipelineHint}
              save={sectionSave("pipeline")}
              actions={
                <SegmentedControl
                  label={t.preset}
                  size="sm"
                  value={draft.preset}
                  onChange={(p) => {
                    if (p === draft.preset) return;
                    if (draft.id) setPresetAsk(p);
                    else applyPreset(p);
                  }}
                  options={presetsOf(draft.subject).map((p) => ({
                    value: p,
                    label: PRESET_LABEL[lang][p],
                    disabled: !canWrite,
                  }))}
                />
              }
            >
              <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]">
                <section aria-label={t.pipeline} className="flex min-w-0 gap-3 self-start overflow-x-auto pb-1.5">
                  {draft.phases.map((p, pi) => (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: giai đoạn không có mã; thứ tự là thứ tự chạy.
                      key={pi}
                      className="flex flex-[1_0_220px] flex-col gap-2.5 rounded-xl bg-muted p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        {canWrite ? (
                          <input
                            aria-label={t.phaseName(pi + 1)}
                            value={p.name}
                            onChange={(e) =>
                              update({
                                phases: draft.phases.map((x, i) => (i === pi ? { ...x, name: e.target.value } : x)),
                              })
                            }
                            className="-ml-1.5 h-7 w-0 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 font-heading text-sm font-semibold tracking-[-0.02em] outline-none hover:border-input focus-visible:border-ring focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-ring/40"
                          />
                        ) : (
                          <strong className="font-heading text-sm tracking-[-0.02em]">{p.name}</strong>
                        )}
                        <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">
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
                              phases: draft.phases.map((x, i) =>
                                i === pi ? { ...x, description: e.target.value } : x,
                              ),
                            })
                          }
                          className="-mx-1.5 -mt-1.5 field-sizing-content resize-none rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-xs text-muted-foreground outline-none placeholder:text-muted-foreground hover:border-input focus-visible:border-ring focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-ring/40"
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
                              onClick={() => selectGate(g.id)}
                              className={cn(
                                "flex cursor-pointer flex-col gap-1 rounded-[10px] border bg-card px-3 py-2.5 text-left text-card-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
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
                              <span
                                aria-hidden="true"
                                className="text-center text-xs leading-none text-muted-foreground"
                              >
                                ↓
                              </span>
                            )}
                          </div>
                        );
                      })}
                      {canWrite && (
                        <button
                          type="button"
                          className="h-8.5 cursor-pointer rounded-lg border border-dashed border-input bg-transparent text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
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
                      {/* Quy trình Code duyệt PR, không có tài liệu đầu ra theo giai đoạn. */}
                      {draft.subject !== "code" && (
                        <div className="mt-0.5 flex flex-col gap-1 border-t border-dashed border-input pt-2 text-xs">
                          <span className="text-muted-foreground">{t.outputs}</span>
                          <ChipInput
                            values={p.outputs}
                            onChange={(outputs) =>
                              update({ phases: draft.phases.map((x, i) => (i === pi ? { ...x, outputs } : x)) })
                            }
                            canWrite={canWrite}
                            addLabel={t.addOutput(p.name)}
                            placeholder={t.outputPh}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                  {canWrite && draft.phases.length < 10 && (
                    <button
                      type="button"
                      aria-label={t.addPhase}
                      title={t.addPhase}
                      className="flex min-h-40 flex-[0_0_40px] cursor-pointer items-center justify-center rounded-xl border border-dashed border-input text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
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

                {/* Khung cấu hình dính khi cuộn để vẫn thấy checkpoint đang sửa; dưới 1280 px nó nằm dưới các giai
                    đoạn và cuộn theo trang. */}
                <aside
                  ref={configRef}
                  aria-label={t.config}
                  className={cn(
                    "min-w-0 border-t border-border pt-4 xl:sticky xl:self-start xl:overflow-y-auto xl:overscroll-contain xl:border-t-0 xl:border-l xl:pt-1 xl:pr-1 xl:pb-1",
                    isCode
                      ? "scroll-mt-28 xl:top-28 xl:max-h-[calc(100dvh-8rem)]"
                      : "scroll-mt-16 xl:top-16 xl:max-h-[calc(100dvh-5rem)]",
                  )}
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
                    <p className="text-sm text-muted-foreground xl:pl-4">{t.pickGate}</p>
                  )}
                </aside>
              </div>
            </SettingsSection>

            {canWrite && base && (
              <DangerZone
                title={t.danger}
                description={
                  <>
                    <span className="font-medium text-foreground">{base.name}</span> · {t.dangerHint}
                  </>
                }
              >
                <Button variant="destructive" onClick={() => setRemoving(true)}>
                  <Trash2Icon aria-hidden="true" />
                  {t.remove}
                </Button>
              </DangerZone>
            )}
          </SettingsLayout>
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
            <Field>
              <FieldLabel htmlFor={`${ids}-key`}>{t.docKey}</FieldLabel>
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
