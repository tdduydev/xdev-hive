import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type ReviewGate,
  reviewGate,
  SDLC_PHASE_KINDS,
  type SdlcMode,
  type SdlcModeView,
  type SdlcPhase,
  sdlcArtifact,
  sdlcModeDryRunInput,
  sdlcModeSaveInput,
  sdlcPhase,
  sdlcStep,
} from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { type ReactNode, useId, useState } from "react";
import { useSdlcEnv, useText } from "./env.tsx";

export type GateEditorProps = {
  gate: ReviewGate;
  onChange: (fn: (gate: ReviewGate) => ReviewGate) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canWrite: boolean;
};
const text = {
  vi: {
    name: "Tên chế độ",
    slug: "Mã chế độ",
    description: "Mô tả",
    size: "Cỡ phù hợp",
    phases: "Giai đoạn",
    phase: "Tên giai đoạn",
    phaseId: "Mã giai đoạn",
    kind: "Loại giai đoạn",
    optional: "Có thể bỏ qua",
    addPhase: "Thêm giai đoạn",
    remove: "Xoá",
    up: "Lên",
    down: "Xuống",
    docs: "Tài liệu",
    addDoc: "Thêm tài liệu",
    path: "Đường dẫn repo",
    scope: "Phạm vi",
    required: "Bắt buộc",
    repeat: "Lặp theo contract",
    template: "Khuôn Markdown",
    sections: "Mục bắt buộc (mỗi dòng)",
    gates: "Cổng duyệt",
    addGate: "Thêm checkpoint",
    projectGates: "Checkpoint theo đội dự án (mã, cách nhau bởi dấu phẩy)",
    auto: "Tự duyệt AI",
    autoGates: "Checkpoint tự duyệt (mã, cách nhau bởi dấu phẩy)",
    score: "Ngưỡng điểm",
    hours: "Hạn thu hồi (giờ)",
    steps: "Bước agent",
    addStep: "Thêm bước",
    action: "Hành động",
    prompt: "Chỉ dẫn cho agent",
    artifactIds: "Mã tài liệu (cách nhau bởi dấu phẩy)",
    autoStep: "Tự chạy",
    autoSubmit: "Tự gửi duyệt",
    save: "Lưu chế độ",
    saved: "Đã lưu chế độ.",
    dry: "Chạy thử",
    project: "Dự án chạy thử",
    title: "Tiêu đề chạy thử",
    participants: "Dự án tham gia (cách nhau bởi dấu phẩy)",
    readOnly: "Chỉ đọc",
    clone: "Preset chỉ đọc. Bản sao được lưu thành chế độ mới.",
    enabled: "Bật chế độ",
    team: "Phạm vi đội",
    org: "Toàn tổ chức",
    testSize: "Cỡ chạy thử",
    skipped: "Bỏ qua",
    decomposition: "Tách task",
    sourcePhase: "Giai đoạn nguồn",
    sourceDoc: "Mã tài liệu nguồn",
    requirementId: "Regex requirement",
    parser: "Bộ đọc",
    granularity: "Độ mịn",
    cli: "CLI",
    model: "Model",
    skill: "Skill",
    questions: "Tối đa câu hỏi",
    blocking: "Mức chặn",
    blockingOptions: { hard: "Chặn cứng", soft: "Cảnh báo", none: "Không chặn" },
    scopeOptions: { item: "Chung cho hạng mục", project: "Theo dự án", contract: "Contract liên repo" },
  },
  en: {
    name: "Mode name",
    slug: "Mode slug",
    description: "Description",
    size: "Applicable sizes",
    phases: "Phases",
    phase: "Phase name",
    phaseId: "Phase ID",
    kind: "Phase kind",
    optional: "Optional",
    addPhase: "Add phase",
    remove: "Remove",
    up: "Up",
    down: "Down",
    docs: "Documents",
    addDoc: "Add document",
    path: "Repo path",
    scope: "Scope",
    required: "Required",
    repeat: "Repeat per contract",
    template: "Markdown template",
    sections: "Required sections (one per line)",
    gates: "Review gates",
    addGate: "Add checkpoint",
    projectGates: "Per-project checkpoints (comma separated IDs)",
    auto: "AI auto-approval",
    autoGates: "Auto-approved checkpoints (comma separated IDs)",
    score: "Minimum score",
    hours: "Revocation window (hours)",
    steps: "Agent steps",
    addStep: "Add step",
    action: "Action",
    prompt: "Agent instructions",
    artifactIds: "Artifact IDs (comma separated)",
    autoStep: "Run automatically",
    autoSubmit: "Submit automatically",
    save: "Save mode",
    saved: "Mode saved.",
    dry: "Dry run",
    project: "Dry-run project",
    title: "Dry-run title",
    participants: "Participants (comma separated)",
    readOnly: "Read only",
    clone: "Presets are read only. This copy will be saved as a new mode.",
    enabled: "Enabled",
    team: "Team scope",
    org: "Organization",
    testSize: "Dry-run size",
    skipped: "Skipped",
    decomposition: "Task decomposition",
    sourcePhase: "Source phase",
    sourceDoc: "Source artifact ID",
    requirementId: "Requirement regex",
    parser: "Parser",
    granularity: "Granularity",
    cli: "CLI",
    model: "Model",
    skill: "Skill",
    questions: "Maximum questions",
    blocking: "Blocking",
    blockingOptions: { hard: "Hard block", soft: "Warn", none: "No block" },
    scopeOptions: { item: "Item", project: "Per project", contract: "Cross-repo contract" },
  },
};
const split = (value: string) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const nextId = (prefix: string, taken: string[]) => {
  let n = 1;
  while (taken.includes(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
};
function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1 text-sm">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

/** Giữ dấu phân cách đang gõ để người dùng thêm được phần tử kế tiếp. */
function ListField({
  label,
  value,
  onChange,
  disabled,
  lines = false,
}: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  disabled: boolean;
  lines?: boolean;
}) {
  const separator = lines ? "\n" : ",";
  const join = lines ? "\n" : ", ";
  const parse = (raw: string) =>
    raw
      .split(separator)
      .map((s) => s.trim())
      .filter(Boolean);
  const [raw, setRaw] = useState(value.join(join));
  if (parse(raw).join("\n") !== value.join("\n")) setRaw(value.join(join));
  const Control = lines ? Textarea : Input;
  return (
    <Field label={label}>
      {(id) => (
        <Control
          id={id}
          value={raw}
          disabled={disabled}
          onChange={(e) => {
            setRaw(e.target.value);
            onChange(parse(e.target.value));
          }}
          onBlur={() => setRaw(value.join(join))}
        />
      )}
    </Field>
  );
}

/** Lỗi schema giữ đường dẫn giai đoạn để người sửa biết cổng nào vi phạm FR-056. */
export function ModeEditor({
  mode,
  teams = [],
  onSaved,
  renderGate,
}: {
  mode: SdlcModeView;
  teams?: { id: string; name: string }[];
  onSaved?: (mode: SdlcModeView) => void;
  renderGate?: (props: GateEditorProps) => ReactNode;
}) {
  const { api, lang, can, errorMessage } = useSdlcEnv();
  const t = text[lang];
  const sharedText = useText();
  const [definition, setDefinition] = useState<SdlcMode>(() => structuredClone(mode.definition));
  const [slug, setSlug] = useState(mode.preset ? `${mode.slug}-copy` : mode.slug);
  const [teamId, setTeamId] = useState(mode.teamId ?? "");
  const [enabled, setEnabled] = useState(mode.enabled);
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [projectKey, setProjectKey] = useState("payment-api");
  const [title, setTitle] = useState("Hoàn tiền một phần");
  const [size, setSize] = useState<SdlcMode["sizes"][number]>("M");
  const [participants, setParticipants] = useState("");
  const client = useQueryClient();
  const save = useMutation(
    api.sdlc.modes.save.mutationOptions({
      onSuccess: (saved) => {
        void client.invalidateQueries({ queryKey: api.sdlc.modes.key() });
        onSaved?.(saved);
      },
    }),
  );
  const dry = useMutation(api.sdlc.modes.dryRun.mutationOptions());
  const disabled = !can.manageModes || save.isPending;
  const patchPhase = (index: number, fn: (p: SdlcPhase) => SdlcPhase) =>
    setDefinition((d) => ({ ...d, phases: d.phases.map((p, i) => (i === index ? fn(p) : p)) }));
  const patchAuto = (index: number, patch: Partial<NonNullable<SdlcPhase["autoApprove"]>>) =>
    patchPhase(index, (p) => (p.autoApprove ? { ...p, autoApprove: { ...p.autoApprove, ...patch } } : p));
  const patchDecomposition = (patch: Partial<NonNullable<SdlcMode["decomposition"]>>) =>
    setDefinition((d) => (d.decomposition ? { ...d, decomposition: { ...d.decomposition, ...patch } } : d));
  const change = <K extends keyof SdlcMode>(key: K, value: SdlcMode[K]) =>
    setDefinition((d) => ({ ...d, [key]: value }));
  const report = (errors: { path: PropertyKey[]; message: string }[]) =>
    setIssues(errors.map((e) => ({ path: e.path.join("."), message: e.message })));
  function persist() {
    const parsed = sdlcModeSaveInput.safeParse({
      ...(mode.preset ? {} : { id: mode.ref }),
      slug,
      teamId: teamId || null,
      enabled,
      basePreset: mode.preset ? mode.ref : mode.basePreset,
      definition: { ...definition, id: slug },
    });
    if (!parsed.success) return report(parsed.error.issues);
    setIssues([]);
    save.mutate(parsed.data);
  }
  function test() {
    const parsed = sdlcModeDryRunInput.safeParse({
      mode: definition,
      projectKey,
      title,
      size,
      participants: split(participants),
    });
    if (!parsed.success) return report(parsed.error.issues);
    setIssues([]);
    dry.mutate(parsed.data);
  }
  const input = (label: string, value: string | number, onChange: (s: string) => void, type = "text") => (
    <Field label={label}>
      {(id) => (
        <Input id={id} type={type} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
  const textarea = (label: string, value: string, onChange: (s: string) => void) => (
    <Field label={label}>
      {(id) => <Textarea id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
  const check = (label: string, value: boolean, onChange: (v: boolean) => void) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {mode.preset && <p className="text-sm text-muted-foreground">{t.clone}</p>}
      {!can.manageModes && <p>{t.readOnly}</p>}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {input(t.name, definition.name, (name) => change("name", name))}
        {input(t.slug, slug, setSlug)}
        <Field label={t.team}>
          {(id) => (
            <NativeSelect
              id={id}
              value={teamId}
              disabled={disabled || !mode.preset}
              onChange={(e) => setTeamId(e.target.value)}
            >
              <option value="">{t.org}</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label={t.blocking}>
          {(id) => (
            <NativeSelect
              id={id}
              value={definition.blocking}
              disabled={disabled}
              onChange={(e) => change("blocking", e.target.value as SdlcMode["blocking"])}
            >
              {(["hard", "soft", "none"] as const).map((v) => (
                <option key={v} value={v}>
                  {t.blockingOptions[v]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </div>
      {textarea(t.description, definition.description, (description) => change("description", description))}
      {check(t.enabled, enabled, setEnabled)}
      <fieldset className="flex flex-wrap gap-3">
        <legend className="mb-2 text-sm">{t.size}</legend>
        {(["S", "M", "L", "XL"] as const).map((s) => (
          <label key={s} className="flex gap-1">
            <input
              type="checkbox"
              disabled={disabled}
              checked={definition.sizes.includes(s)}
              onChange={(e) =>
                change("sizes", e.target.checked ? [...definition.sizes, s] : definition.sizes.filter((v) => v !== s))
              }
            />
            {s}
          </label>
        ))}
      </fieldset>
      {issues
        .filter((e) => !e.path.startsWith("definition.phases.") && !e.path.startsWith("mode.phases."))
        .map((e) => (
          <Alert key={`${e.path}:${e.message}`} variant="destructive">
            {e.message}
          </Alert>
        ))}
      {definition.phases.map((phase, pi) => (
        <section key={pi.toString()} className="flex min-w-0 flex-col gap-3 rounded-xl border p-4">
          <header className="flex flex-wrap items-center gap-2">
            <h3 className="flex-1 font-semibold">
              {t.phases} {pi + 1} · {phase.name}
            </h3>
            {([-1, 1] as const).map((delta) => (
              <Button
                key={delta}
                variant="outline"
                size="sm"
                disabled={disabled || pi + delta < 0 || pi + delta >= definition.phases.length}
                onClick={() => {
                  const next = [...definition.phases];
                  const other = next[pi + delta];
                  if (!other) return;
                  next[pi] = other;
                  next[pi + delta] = phase;
                  change("phases", next);
                }}
              >
                {delta < 0 ? t.up : t.down}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || definition.phases.length === 1}
              onClick={() =>
                change(
                  "phases",
                  definition.phases.filter((_, i) => i !== pi),
                )
              }
            >
              {t.remove}
            </Button>
          </header>
          <div className="grid gap-3 sm:grid-cols-2">
            {input(t.phaseId, phase.id, (id) => patchPhase(pi, (p) => ({ ...p, id })))}
            {input(t.phase, phase.name, (name) => patchPhase(pi, (p) => ({ ...p, name })))}
            <Field label={t.kind}>
              {(id) => (
                <NativeSelect
                  id={id}
                  value={phase.kind}
                  disabled={disabled}
                  onChange={(e) => patchPhase(pi, (p) => ({ ...p, kind: e.target.value as SdlcPhase["kind"] }))}
                >
                  {SDLC_PHASE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {sharedText.phaseKind[k]}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>
          {check(t.optional, phase.optional, (optional) => patchPhase(pi, (p) => ({ ...p, optional })))}
          {phase.artifacts.map((a, ai) => {
            const update = (patch: Partial<typeof a>) =>
              patchPhase(pi, (p) => ({
                ...p,
                artifacts: p.artifacts.map((v, i) => (i === ai ? { ...v, ...patch } : v)),
              }));
            return (
              <fieldset key={ai.toString()} className="grid min-w-0 gap-3 rounded-lg bg-muted/40 p-3">
                <legend>
                  {t.docs} {ai + 1}
                </legend>
                {input("ID", a.id, (id) => update({ id }))}
                {input(t.name, a.name, (name) => update({ name }))}
                {input(t.path, a.path, (path) => update({ path }))}
                <Field label={t.scope}>
                  {(id) => (
                    <NativeSelect
                      id={id}
                      value={a.scope}
                      disabled={disabled}
                      onChange={(e) => update({ scope: e.target.value as typeof a.scope })}
                    >
                      {(["item", "project", "contract"] as const).map((v) => (
                        <option key={v} value={v}>
                          {t.scopeOptions[v]}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                {check(t.required, a.required, (required) => update({ required }))}
                {check(t.repeat, a.repeatable, (repeatable) => update({ repeatable }))}
                {textarea(t.template, a.template ?? "", (template) => update({ template }))}
                <ListField
                  label={t.sections}
                  value={a.sections}
                  lines
                  disabled={disabled}
                  onChange={(sections) => update({ sections })}
                />
                <Button
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => patchPhase(pi, (p) => ({ ...p, artifacts: p.artifacts.filter((_, i) => i !== ai) }))}
                >
                  {t.remove}
                </Button>
              </fieldset>
            );
          })}
          <Button
            variant="outline"
            disabled={disabled || phase.artifacts.length >= 10}
            onClick={() => {
              const id = nextId(
                "doc",
                definition.phases.flatMap((p) => p.artifacts.map((a) => a.id)),
              );
              patchPhase(pi, (p) => ({
                ...p,
                artifacts: [
                  ...p.artifacts,
                  sdlcArtifact.parse({
                    id,
                    name: "Tài liệu",
                    path: `specs/{NNN}-{slug}/${id}.md`,
                  }),
                ],
              }));
            }}
          >
            {t.addDoc}
          </Button>
          <h4 className="font-medium">{t.gates}</h4>
          {phase.gate.map((group, gi) => (
            <div key={gi.toString()} className="grid gap-3">
              {group.gates.map((gate, ci) => {
                const props: GateEditorProps = {
                  gate,
                  canWrite: !disabled,
                  canMoveUp: ci > 0,
                  canMoveDown: ci + 1 < group.gates.length,
                  onChange: (fn) =>
                    patchPhase(pi, (p) => ({
                      ...p,
                      gate: p.gate.map((g, i) =>
                        i === gi ? { ...g, gates: g.gates.map((v, j) => (j === ci ? fn(v) : v)) } : g,
                      ),
                    })),
                  onMove: (delta) => {
                    const gates = [...group.gates];
                    const other = gates[ci + delta];
                    if (!other) return;
                    gates[ci] = other;
                    gates[ci + delta] = gate;
                    patchPhase(pi, (p) => ({ ...p, gate: p.gate.map((g, i) => (i === gi ? { ...g, gates } : g)) }));
                  },
                  onRemove: () =>
                    patchPhase(pi, (p) => ({
                      ...p,
                      gate: p.gate
                        .map((g, i) => (i === gi ? { ...g, gates: g.gates.filter((_, j) => j !== ci) } : g))
                        .filter((g) => g.gates.length),
                    })),
                };
                return (
                  <div key={gate.id}>
                    {renderGate ? (
                      renderGate(props)
                    ) : (
                      <p>
                        {gate.id} · {gate.name} · {gate.kind}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() =>
              patchPhase(pi, (p) => {
                const gate = reviewGate.parse({
                  id: nextId(
                    "human",
                    p.gate.flatMap((g) => g.gates.map((v) => v.id)),
                  ),
                  name: "BA/PO duyệt",
                  kind: "human",
                  reviewers: { roles: ["team-ba"] },
                });
                return {
                  ...p,
                  gate: p.gate.length
                    ? p.gate.map((g, i) => (i === p.gate.length - 1 ? { ...g, gates: [...g.gates, gate] } : g))
                    : [{ name: p.name, outputs: [], gates: [gate] }],
                };
              })
            }
          >
            {t.addGate}
          </Button>
          <ListField
            label={t.projectGates}
            value={phase.perProjectGates}
            disabled={disabled}
            onChange={(perProjectGates) => patchPhase(pi, (p) => ({ ...p, perProjectGates }))}
          />
          {check(t.auto, !!phase.autoApprove, (on) =>
            patchPhase(pi, (p) => {
              const { autoApprove: _, ...rest } = p;
              return on
                ? {
                    ...p,
                    autoApprove: {
                      gates: p.gate.flatMap((g) => g.gates.filter((v) => v.kind === "human").map((v) => v.id)),
                      minScore: 9,
                      revokeHours: 24,
                    },
                  }
                : rest;
            }),
          )}
          {phase.autoApprove && (
            <div className="grid gap-3 sm:grid-cols-2">
              <ListField
                label={t.autoGates}
                value={phase.autoApprove.gates}
                disabled={disabled}
                onChange={(gates) => patchAuto(pi, { gates })}
              />
              {input(t.score, phase.autoApprove.minScore, (s) => patchAuto(pi, { minScore: Number(s) }), "number")}
              {input(
                t.hours,
                phase.autoApprove.revokeHours,
                (s) => patchAuto(pi, { revokeHours: Number(s) }),
                "number",
              )}
            </div>
          )}
          <h4 className="font-medium">{t.steps}</h4>
          {phase.steps.map((step, si) => {
            const update = (patch: Partial<typeof step>) =>
              patchPhase(pi, (p) => ({ ...p, steps: p.steps.map((v, i) => (i === si ? { ...v, ...patch } : v)) }));
            return (
              <fieldset key={si.toString()} className="grid gap-3 rounded-lg border p-3">
                <legend>{step.id}</legend>
                {input("ID", step.id, (id) => update({ id }))}
                <Field label={t.action}>
                  {(id) => (
                    <NativeSelect
                      id={id}
                      value={step.action}
                      disabled={disabled}
                      onChange={(e) => update({ action: e.target.value as typeof step.action })}
                    >
                      {sdlcStep.shape.action.options.map((action) => (
                        <option key={action} value={action}>
                          {sharedText.detail.stepAction[action]}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <ListField
                  label={t.artifactIds}
                  value={step.artifacts}
                  disabled={disabled}
                  onChange={(artifacts) => update({ artifacts })}
                />
                {textarea(t.prompt, step.prompt, (prompt) => update({ prompt }))}
                {input(t.cli, step.cli ?? "", (cli) => update({ cli: cli ? (cli as typeof step.cli) : undefined }))}
                {input(t.model, step.model ?? "", (model) => update({ model: model || undefined }))}
                {input(t.skill, step.skill ?? "", (skill) => update({ skill: skill || undefined }))}
                {input(t.questions, step.maxQuestions, (s) => update({ maxQuestions: Number(s) }), "number")}
                {check(t.autoStep, step.auto, (auto) => update({ auto }))}
                {check(t.autoSubmit, step.autoSubmit, (autoSubmit) => update({ autoSubmit }))}
                <Button
                  disabled={disabled}
                  variant="ghost"
                  onClick={() => patchPhase(pi, (p) => ({ ...p, steps: p.steps.filter((_, i) => i !== si) }))}
                >
                  {t.remove}
                </Button>
              </fieldset>
            );
          })}
          <Button
            variant="outline"
            disabled={disabled || phase.steps.length >= 6}
            onClick={() =>
              patchPhase(pi, (p) => ({
                ...p,
                steps: [
                  ...p.steps,
                  sdlcStep.parse({
                    id: nextId(
                      "draft",
                      p.steps.map((s) => s.id),
                    ),
                    action: "draft",
                    prompt: "Soạn tài liệu theo yêu cầu của hạng mục.",
                  }),
                ],
              }))
            }
          >
            {t.addStep}
          </Button>
          {issues
            .filter((e) => e.path.startsWith(`definition.phases.${pi}.`) || e.path.startsWith(`mode.phases.${pi}.`))
            .map((e) => (
              <Alert key={`${e.path}:${e.message}`} variant="destructive">
                {e.message}
              </Alert>
            ))}
        </section>
      ))}
      <Button
        variant="outline"
        disabled={disabled || definition.phases.length >= 12}
        onClick={() =>
          change("phases", [
            ...definition.phases,
            sdlcPhase.parse({
              id: nextId(
                "phase",
                definition.phases.map((p) => p.id),
              ),
              name: "Giai đoạn mới",
              kind: "design",
            }),
          ])
        }
      >
        {t.addPhase}
      </Button>
      {definition.decomposition && (
        <section className="grid gap-3 rounded-xl border p-4">
          <h3>{t.decomposition}</h3>
          {input(t.sourcePhase, definition.decomposition.phase, (phase) => patchDecomposition({ phase }))}
          {input(t.sourceDoc, definition.decomposition.artifact, (artifact) => patchDecomposition({ artifact }))}
          {input(t.parser, definition.decomposition.parser, (parser) =>
            patchDecomposition({
              parser: parser as NonNullable<SdlcMode["decomposition"]>["parser"],
            }),
          )}
          {input(t.granularity, definition.decomposition.granularity, (granularity) =>
            patchDecomposition({
              granularity: granularity as NonNullable<SdlcMode["decomposition"]>["granularity"],
            }),
          )}
          {input(t.requirementId, definition.decomposition.requirementId, (requirementId) =>
            patchDecomposition({ requirementId }),
          )}
        </section>
      )}
      {save.error && <Alert variant="destructive">{errorMessage(save.error)}</Alert>}
      {save.isSuccess && <p role="status">{t.saved}</p>}
      <Button disabled={disabled} onClick={persist}>
        {t.save}
      </Button>
      <section className="grid gap-3 rounded-xl border p-4">
        <h3>{t.dry}</h3>
        {input(t.project, projectKey, setProjectKey)}
        {input(t.title, title, setTitle)}
        {input(t.participants, participants, setParticipants)}
        <Field label={t.testSize}>
          {(id) => (
            <NativeSelect id={id} value={size} onChange={(e) => setSize(e.target.value as typeof size)}>
              {["S", "M", "L", "XL"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Button variant="outline" disabled={dry.isPending} onClick={test}>
          {t.dry}
        </Button>
        {dry.error && <Alert variant="destructive">{errorMessage(dry.error)}</Alert>}
        {dry.data && (
          <div role="status" className="grid gap-3">
            {dry.data.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
            {dry.data.phases.map((p) => (
              <div key={p.id}>
                <strong>
                  {p.name}
                  {p.skipped ? ` · ${t.skipped}` : ""}
                </strong>
                {p.artifacts.map((a) => (
                  <p className="break-all font-mono text-xs" key={a.docKey}>
                    {a.path} · {a.docKey}
                  </p>
                ))}
                {p.gates.map((g) => (
                  <p key={g.gateId}>
                    {g.name} · {g.reason} {g.autoApprove ? ` · ${t.auto}` : ""}
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
