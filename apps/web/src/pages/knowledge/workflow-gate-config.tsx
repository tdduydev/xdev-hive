import { ORPCError } from "@orpc/client";
import type { GateKind, OrgMember, RejectRoute, ReviewGate, Team } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon, XIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { type Lang, useLang, useT } from "@/lib/i18n.ts";
import {
  GATE_KINDS,
  KIND_LABEL,
  type QuorumMode,
  quorumMode,
  REVIEWER_ROLES,
  type ReviewerRole,
  ROLE_LABEL,
  RULE_CHECKS,
  type WorkflowDraft,
  type WorkflowIssue,
  withKind,
  workflowIssues,
} from "@/lib/review-workflows.ts";
import { cn } from "@/lib/utils.ts";
import { workflowsText as text } from "@/pages/knowledge/workflows-text.ts";

const SLA_CHOICES = [4, 8, 24, 48, 72];
/** Gợi ý cho ô model; gõ tên khác vẫn được, chính sách agent của tổ chức quyết model nào dùng được. */
export const MODEL_SUGGESTIONS = [
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-haiku-5-5",
  "gpt-5-codex",
  "gemini-2.5-pro",
];

export const segButton = (on: boolean) =>
  cn(
    "h-6.5 cursor-pointer rounded-md border-0 px-2.5 text-sm disabled:cursor-not-allowed",
    on ? "bg-card font-semibold text-foreground shadow-sm" : "bg-transparent text-muted-foreground",
  );

const splitBy = (raw: string, sep: string) =>
  raw
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Chữ đang gõ của ô danh sách. Giữ nguyên dấu phẩy, dòng trống đang gõ dở; chỉ lấy lại từ `value` khi danh sách đổi từ
 * nơi khác (vd. bấm × trên chip điều kiện).
 */
function useRaw(value: string[], sep: string, join: string) {
  const [raw, setRaw] = useState(value.join(join));
  if (splitBy(raw, sep).join("\n") !== value.join("\n")) setRaw(value.join(join));
  return [raw, setRaw] as const;
}

/** Danh sách chữ ngăn bằng dấu phẩy. */
export function ListInput({
  value,
  onChange,
  ...props
}: {
  value: string[];
  onChange: (v: string[]) => void;
  id: string;
  placeholder: string;
  disabled: boolean;
}) {
  const [raw, setRaw] = useRaw(value, ",", ", ");
  return (
    <Input
      {...props}
      value={raw}
      onChange={(e) => {
        setRaw(e.target.value);
        onChange(splitBy(e.target.value, ","));
      }}
      onBlur={() => setRaw(value.join(", "))}
    />
  );
}

/** Mỗi dòng một mục. */
export function LinesInput({
  value,
  onChange,
  ...props
}: {
  value: string[];
  onChange: (v: string[]) => void;
  id: string;
  disabled: boolean;
  className?: string;
}) {
  const [raw, setRaw] = useRaw(value, "\n", "\n");
  return (
    <Textarea
      {...props}
      value={raw}
      readOnly={props.disabled}
      onChange={(e) => {
        setRaw(e.target.value);
        onChange(splitBy(e.target.value, "\n"));
      }}
    />
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** Đầu khung cấu hình: mã, nút dời/xoá và tên checkpoint. */
export function GateHeader({
  gate: g,
  canWrite,
  canMoveUp,
  canMoveDown,
  onRename,
  onMove,
  onRemove,
}: {
  gate: ReviewGate;
  canWrite: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onRename: (name: string) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useT(text);
  return (
    <div className="flex flex-col gap-1 border-b px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{t.config}</span>
        <span className="font-mono text-xs text-muted-foreground" title={t.gateId}>
          {g.id}
        </span>
        {canWrite && (
          <span className="ml-auto flex gap-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t.moveUp}
              disabled={!canMoveUp}
              onClick={() => onMove(-1)}
            >
              <ArrowUpIcon aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t.moveDown}
              disabled={!canMoveDown}
              onClick={() => onMove(1)}
            >
              <ArrowDownIcon aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t.removeGate}
              className="text-destructive hover:text-destructive"
              onClick={onRemove}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          </span>
        )}
      </div>
      <Input
        aria-label={t.gateName}
        maxLength={120}
        value={g.name}
        disabled={!canWrite}
        className="text-[15px] font-semibold md:text-[15px]"
        onChange={(e) => onRename(e.target.value)}
      />
    </div>
  );
}

/** Chọn loại checkpoint: AI, người duyệt, quy tắc, cổng CI. */
export function KindSwitch({
  kind,
  disabled,
  onChange,
}: {
  kind: GateKind;
  disabled: boolean;
  onChange: (kind: GateKind) => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const ids = useId();
  return (
    <fieldset className="m-0 border-0 p-0 text-sm font-medium">
      <legend className="mb-1.5">{t.type}</legend>
      <div className="inline-flex flex-wrap gap-0.5 rounded-lg bg-muted p-0.75">
        {GATE_KINDS.map((k) => (
          <label
            key={k}
            className={cn(
              segButton(kind === k),
              "px-2",
              "relative inline-flex items-center has-focus-visible:ring-2 has-focus-visible:ring-ring/50",
              disabled && "cursor-not-allowed",
            )}
          >
            <input
              type="radio"
              name={`${ids}-kind`}
              value={k}
              // Ô radio trong suốt phủ cả nhãn: bấm đâu trên đoạn cũng chọn, vẫn là radio thật cho bàn phím.
              className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-md opacity-0 disabled:cursor-not-allowed"
              checked={kind === k}
              disabled={disabled}
              onChange={() => onChange(k)}
            />
            {KIND_LABEL[lang][k]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Hướng khi bị trả lại và SLA, dùng chung cho tài liệu và code. */
export function RejectAndSla({
  gate: g,
  disabled,
  onChange,
}: {
  gate: ReviewGate;
  disabled: boolean;
  onChange: (patch: Partial<ReviewGate>) => void;
}) {
  const t = useT(text);
  const ids = useId();
  const sla = g.slaHours === null ? "none" : String(g.slaHours);
  const slaChoices =
    g.slaHours !== null && !SLA_CHOICES.includes(g.slaHours) ? [...SLA_CHOICES, g.slaHours] : SLA_CHOICES;
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <Field label={t.onReject} htmlFor={`${ids}-reject`}>
        <NativeSelect
          id={`${ids}-reject`}
          value={g.onReject}
          disabled={disabled}
          onChange={(e) => onChange({ onReject: e.target.value as RejectRoute })}
        >
          {(["author", "agent", "previous"] as const).map((r) => (
            <option key={r} value={r}>
              {t.route[r]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={t.sla} htmlFor={`${ids}-sla`}>
        <NativeSelect
          id={`${ids}-sla`}
          value={sla}
          disabled={disabled}
          onChange={(e) => onChange({ slaHours: e.target.value === "none" ? null : Number(e.target.value) })}
        >
          {slaChoices.map((h) => (
            <option key={h} value={h}>
              {h} {t.hours}
            </option>
          ))}
          <option value="none">{t.noSla}</option>
        </NativeSelect>
      </Field>
    </div>
  );
}

/** Lỗi kiểm dữ liệu của hub (BAD_REQUEST kèm issues) đọc theo chỗ sai; lỗi khác để apiErrorMessage nói. */
export function hubIssuesOf(error: unknown, draft: WorkflowDraft | null, lang: Lang): WorkflowIssue[] | null {
  if (!draft || !(error instanceof ORPCError) || error.code !== "BAD_REQUEST") return null;
  const data: unknown = error.data;
  const raw = typeof data === "object" && data !== null && "issues" in data ? data.issues : null;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const issues = raw.filter(
    (i): i is { path?: unknown[]; message: string; code?: string } =>
      typeof i === "object" && i !== null && typeof (i as { message?: unknown }).message === "string",
  );
  // Lỗi của dryRun bọc quy trình trong `workflow`; bỏ tầng đó để chỉ chỗ như lỗi của save.
  return workflowIssues(
    draft,
    lang,
    issues.map((i) => ({ ...i, path: i.path?.[0] === "workflow" ? i.path.slice(1) : (i.path ?? []) })),
  );
}

export function IssueAlert({ title, issues }: { title: string; issues: WorkflowIssue[] }) {
  return (
    <Alert variant="destructive">
      <span className="font-medium">{title}</span>
      <ul className="list-disc pl-5">
        {issues.map((i, n) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: hai lỗi có thể trùng chữ; thứ tự là thứ tự hợp đồng báo.
          <li key={n}>{i.where ? `${i.where}: ${i.message}` : i.message}</li>
        ))}
      </ul>
    </Alert>
  );
}

/** Khung cấu hình một checkpoint (cột phải của Workflows.dc.html). */
export function GateConfig({
  gate: g,
  canWrite,
  members,
  teams,
  canMoveUp,
  canMoveDown,
  onChange,
  onMove,
  onRemove,
}: {
  gate: ReviewGate;
  canWrite: boolean;
  members: OrgMember[];
  teams: Team[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (fn: (g: ReviewGate) => ReviewGate) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const ids = useId();
  const [condOpen, setCondOpen] = useState(false);
  const disabled = !canWrite;
  const set = (patch: Partial<ReviewGate>) => onChange((x) => ({ ...x, ...patch }));
  const setCond = (patch: Partial<ReviewGate["conditions"]>) =>
    onChange((x) => ({ ...x, conditions: { ...x.conditions, ...patch } }));
  const c = g.conditions;
  const condChips: { key: keyof ReviewGate["conditions"]; label: string; clear: Partial<ReviewGate["conditions"]> }[] =
    [
      ...(c.docTypes.length
        ? [{ key: "docTypes" as const, label: `${t.condType} = ${c.docTypes.join(", ")}`, clear: { docTypes: [] } }]
        : []),
      ...(c.keywords.length
        ? [{ key: "keywords" as const, label: `${t.condKw}: ${c.keywords.join(", ")}`, clear: { keywords: [] } }]
        : []),
      ...(c.minChangedLines
        ? [{ key: "minChangedLines" as const, label: t.condSize(c.minChangedLines), clear: { minChangedLines: null } }]
        : []),
    ];

  return (
    <>
      <GateHeader
        gate={g}
        canWrite={canWrite}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        onRename={(name) => set({ name })}
        onMove={onMove}
        onRemove={onRemove}
      />
      <div className="flex flex-col gap-3.5 px-4 py-3.5">
        <KindSwitch kind={g.kind} disabled={disabled} onChange={(k) => onChange((x) => withKind(x, k, lang))} />

        {g.kind === "human" && (
          <Approvers
            gate={g}
            members={members}
            teams={teams}
            disabled={disabled}
            onChange={(reviewers) => set({ reviewers })}
          />
        )}

        {g.kind === "ai" && g.ai && (
          <>
            <Field label={t.aiModel} htmlFor={`${ids}-model`} hint={t.aiModelHint}>
              <Input
                id={`${ids}-model`}
                list={`${ids}-models`}
                maxLength={200}
                className="font-mono"
                placeholder="claude-sonnet-5-5"
                value={g.ai.model ?? ""}
                disabled={disabled}
                onChange={(e) => {
                  const model = e.target.value;
                  onChange((x) => ({
                    ...x,
                    ai: { checks: x.ai?.checks ?? [], passScore: x.ai?.passScore ?? 7, model },
                  }));
                }}
              />
              <datalist id={`${ids}-models`}>
                {MODEL_SUGGESTIONS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            <Field label={t.aiChecks} htmlFor={`${ids}-checks`} hint={t.aiChecksHint}>
              <LinesInput
                id={`${ids}-checks`}
                className="min-h-23 text-sm"
                value={g.ai.checks}
                disabled={disabled}
                onChange={(checks) =>
                  onChange((x) => ({ ...x, ai: { ...x.ai, passScore: x.ai?.passScore ?? 7, checks } }))
                }
              />
            </Field>
            <Field label={t.passScore} htmlFor={`${ids}-score`}>
              <span className="flex items-center gap-2">
                <Input
                  id={`${ids}-score`}
                  type="number"
                  min="0"
                  max="10"
                  step="0.5"
                  className="w-24 font-mono"
                  value={String(g.ai.passScore)}
                  disabled={disabled}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (e.target.value !== "" && Number.isFinite(n))
                      onChange((x) => ({
                        ...x,
                        ai: { ...x.ai, checks: x.ai?.checks ?? [], passScore: Math.min(10, Math.max(0, n)) },
                      }));
                  }}
                />
                <span className="font-mono text-sm text-muted-foreground">/ 10</span>
              </span>
            </Field>
          </>
        )}

        {g.kind === "rule" && (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1.5 text-sm font-medium">{t.rules}</legend>
            {RULE_CHECKS.map((r) => {
              const on = g.rules?.includes(r) ?? false;
              return (
                <label key={r} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={on}
                    disabled={disabled}
                    onChange={(e) =>
                      onChange((x) => ({
                        ...x,
                        rules: e.target.checked
                          ? RULE_CHECKS.filter((k) => k === r || x.rules?.includes(k))
                          : (x.rules ?? []).filter((k) => k !== r),
                      }))
                    }
                  />
                  {t.ruleText[r]}
                </label>
              );
            })}
            {g.rules?.includes("sections") && (
              <Field label={t.sections} htmlFor={`${ids}-sections`} hint={t.sectionsHint}>
                <LinesInput
                  id={`${ids}-sections`}
                  className="min-h-20 font-mono text-sm"
                  value={g.sections ?? []}
                  disabled={disabled}
                  onChange={(sections) => set({ sections })}
                />
              </Field>
            )}
            {g.rules?.includes("max-diff") && (
              <Field label={t.maxDiff} htmlFor={`${ids}-maxdiff`}>
                <Input
                  id={`${ids}-maxdiff`}
                  type="number"
                  min="1"
                  className="w-32 font-mono"
                  value={g.maxDiffLines ? String(g.maxDiffLines) : ""}
                  disabled={disabled}
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value));
                    onChange(({ maxDiffLines: _, ...x }) => (n > 0 ? { ...x, maxDiffLines: n } : x));
                  }}
                />
              </Field>
            )}
          </fieldset>
        )}

        {g.kind === "ext" && (
          <Field label={t.extCheck} htmlFor={`${ids}-ext`} hint={t.extHint}>
            <Input id={`${ids}-ext`} className="font-mono" value={t.extValue} disabled readOnly />
          </Field>
        )}

        <fieldset className="m-0 flex flex-col gap-2.5 rounded-[10px] border border-dashed border-input px-3 pt-1.5 pb-2.5">
          <legend className="px-1.5 text-sm font-medium">{t.when}</legend>
          <span className="flex flex-wrap items-center gap-1.5 text-sm">
            {condChips.length === 0 && <span className="text-muted-foreground">{t.always}</span>}
            {condChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-xs"
              >
                {chip.label}
                {canWrite && (
                  <button
                    type="button"
                    aria-label={t.removeChip(chip.label)}
                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                    onClick={() => setCond(chip.clear)}
                  >
                    <XIcon className="size-3" aria-hidden="true" />
                  </button>
                )}
              </span>
            ))}
            {canWrite && (
              <Button variant="ghost" size="xs" aria-expanded={condOpen} onClick={() => setCondOpen(!condOpen)}>
                + {t.addCond}
              </Button>
            )}
          </span>
          {condOpen && (
            <div className="grid gap-2.5">
              <Field label={t.condTypeLabel} htmlFor={`${ids}-types`}>
                <ListInput
                  id={`${ids}-types`}
                  placeholder={t.condTypePh}
                  value={c.docTypes}
                  disabled={disabled}
                  onChange={(docTypes) => setCond({ docTypes })}
                />
              </Field>
              <Field label={t.condKwLabel} htmlFor={`${ids}-kw`}>
                <ListInput
                  id={`${ids}-kw`}
                  placeholder={t.condKwPh}
                  value={c.keywords}
                  disabled={disabled}
                  onChange={(keywords) => setCond({ keywords })}
                />
              </Field>
              <Field label={t.condSizeLabel} htmlFor={`${ids}-size`}>
                <Input
                  id={`${ids}-size`}
                  type="number"
                  min="1"
                  className="w-32 font-mono"
                  value={c.minChangedLines ? String(c.minChangedLines) : ""}
                  disabled={disabled}
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value));
                    setCond({ minChangedLines: n > 0 ? n : null });
                  }}
                />
              </Field>
            </div>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.75 size-4 accent-primary"
              checked={c.skipFormattingOnly}
              disabled={disabled}
              onChange={(e) => setCond({ skipFormattingOnly: e.target.checked })}
            />
            <span>
              {t.skipSmall}
              <span className="block text-xs text-muted-foreground">{t.skipSmallHint}</span>
            </span>
          </label>
        </fieldset>

        <RejectAndSla gate={g} disabled={disabled} onChange={set} />
        <Field label={t.after} htmlFor={`${ids}-pass`} hint={t.afterHint}>
          <NativeSelect
            id={`${ids}-pass`}
            value={g.onPass}
            disabled={disabled}
            onChange={(e) => set({ onPass: e.target.value as ReviewGate["onPass"] })}
          >
            <option value="next">{t.afterNext}</option>
            <option value="task">{t.afterTask}</option>
            <option value="baseline">{t.afterBaseline}</option>
          </NativeSelect>
        </Field>
        {g.onPass === "task" && (
          <Field label={t.nextTask} htmlFor={`${ids}-task`} hint={t.nextTaskHint}>
            <Input
              id={`${ids}-task`}
              maxLength={200}
              placeholder={t.nextTaskPh}
              value={g.nextTaskTitle ?? ""}
              disabled={disabled}
              onChange={(e) => set({ nextTaskTitle: e.target.value })}
            />
          </Field>
        )}
      </div>
    </>
  );
}

export function Approvers({
  gate,
  members,
  teams,
  disabled,
  onChange,
}: {
  gate: ReviewGate;
  members: OrgMember[];
  teams: Team[];
  disabled: boolean;
  onChange: (r: NonNullable<ReviewGate["reviewers"]>) => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const ids = useId();
  const r = gate.reviewers ?? { users: [], roles: [], teams: [], quorum: 1 };
  const names = new Map(members.map((m) => [m.userId, m.name]));
  const teamNames = new Map(teams.map((team) => [team.id, team.name]));
  const mode = quorumMode(r.quorum);
  const chip = "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs";
  const removeBtn = (label: string, fn: () => void) =>
    !disabled && (
      <button
        type="button"
        aria-label={t.removeChip(label)}
        className="cursor-pointer opacity-70 hover:opacity-100"
        onClick={fn}
      >
        <XIcon className="size-3" aria-hidden="true" />
      </button>
    );
  return (
    <>
      <fieldset className="m-0 border-0 p-0 text-sm font-medium">
        <legend className="mb-1.5">{t.approvers}</legend>
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-input p-1.5 font-normal">
          {r.roles.map((role) => {
            const label = `${t.rolePrefix}: ${ROLE_LABEL[lang][role]}`;
            return (
              <span key={role} className={cn(chip, "border-transparent bg-accent text-accent-foreground")}>
                {label}
                {removeBtn(label, () => onChange({ ...r, roles: r.roles.filter((x) => x !== role) }))}
              </span>
            );
          })}
          {r.teams.map((id) => {
            const label = `${t.teamPrefix}: ${teamNames.get(id) ?? id}`;
            return (
              <span key={id} className={cn(chip, "border-transparent bg-secondary text-secondary-foreground")}>
                {label}
                {removeBtn(label, () => onChange({ ...r, teams: r.teams.filter((x) => x !== id) }))}
              </span>
            );
          })}
          {r.users.map((u) => {
            const label = names.get(u) ?? u;
            return (
              <span key={u} className={cn(chip, "border-border")}>
                {label}
                {removeBtn(label, () => onChange({ ...r, users: r.users.filter((x) => x !== u) }))}
              </span>
            );
          })}
          {!disabled && (
            <select
              aria-label={t.addApprover}
              value=""
              className="h-6 min-w-30 flex-1 cursor-pointer bg-transparent text-sm text-muted-foreground outline-none"
              onChange={(e) => {
                const [kind, id] = e.target.value.split(":") as [string, string];
                if (kind === "role") onChange({ ...r, roles: [...r.roles, id as ReviewerRole] });
                if (kind === "user") onChange({ ...r, users: [...r.users, id] });
                if (kind === "team") onChange({ ...r, teams: [...r.teams, id] });
              }}
            >
              <option value="">+ {t.addApproverPh}</option>
              <optgroup label={t.roles}>
                {REVIEWER_ROLES.filter((role) => !r.roles.includes(role)).map((role) => (
                  <option key={role} value={`role:${role}`}>
                    {ROLE_LABEL[lang][role]}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t.teams}>
                {teams
                  .filter((team) => !r.teams.includes(team.id))
                  .map((team) => (
                    <option key={team.id} value={`team:${team.id}`}>
                      {team.name}
                    </option>
                  ))}
              </optgroup>
              <optgroup label={t.people}>
                {members
                  .filter((m) => m.status === "active" && !r.users.includes(m.userId))
                  .map((m) => (
                    <option key={m.userId} value={`user:${m.userId}`}>
                      {m.name}
                    </option>
                  ))}
              </optgroup>
            </select>
          )}
        </div>
      </fieldset>
      <div className="flex flex-col gap-2">
        <Field label={t.rule} htmlFor={`${ids}-rule`}>
          <NativeSelect
            id={`${ids}-rule`}
            value={mode}
            disabled={disabled}
            onChange={(e) => {
              const next = e.target.value as QuorumMode;
              onChange({ ...r, quorum: next === "all" ? 0 : next === "any" ? 1 : Math.max(2, r.quorum) });
            }}
          >
            <option value="any">{t.ruleAny}</option>
            <option value="all">{t.ruleAll}</option>
            <option value="n">{t.ruleN}</option>
          </NativeSelect>
        </Field>
        {mode === "n" && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Input
              aria-label={t.quorumN}
              type="number"
              min="2"
              max="50"
              className="w-16 font-mono"
              value={String(r.quorum)}
              disabled={disabled}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (n >= 2) onChange({ ...r, quorum: Math.min(50, n) });
              }}
            />
            {t.ofM(r.users.length)}
          </span>
        )}
      </div>
    </>
  );
}
