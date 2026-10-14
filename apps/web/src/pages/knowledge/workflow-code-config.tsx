import { useMutation, useQuery } from "@tanstack/react-query";
import type { CodeDryRunResult, Project, ReviewerCli, ReviewGate, Run, Task } from "@xdev-hive/contracts";
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
import { InfoIcon, PlusIcon, XIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { GateKindBadge } from "@/components/gate-kind-badge.tsx";
import { FormRow, RadioCards, SwitchRow } from "@/components/page/settings.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Field, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import {
  CODE_RULE_ORDER,
  DEFAULT_COMMAND,
  DOC_ONLY_RULES,
  prNumberOf,
  REVIEWER_CLIS,
  SEVERITIES,
  toInput,
  type WorkflowDraft,
  type WorkflowIssue,
  withKind,
  workflowIssues,
} from "@/lib/review-workflows.ts";
import { cn } from "@/lib/utils.ts";
import {
  Approvers,
  GateHeader,
  hubIssuesOf,
  IssueAlert,
  KindSwitch,
  LinesInput,
  ListInput,
  MODEL_SUGGESTIONS,
  RejectAndSla,
} from "@/pages/knowledge/workflow-gate-config.tsx";
import { workflowsText } from "@/pages/knowledge/workflows-text.ts";
import { useOrg } from "@/shell/org-context.ts";

/** Chữ riêng của quy trình code (Workflows.dc.html, biến thể Code); chữ dùng chung với tài liệu ở workflows-text.ts. */
export const codeText: Dict<{
  locked: string;
  lockedHint: string;
  test: string;
  fromProject: string;
  scope: string;
  scopeHint: string;
  scopeProjects: string;
  addProject: string;
  removeProject: (key: string) => string;
  scopeProjectsHint: string;
  scopeBranch: string;
  scopeBranchPh: string;
  scopeBranchHint: string;
  scopeKinds: string;
  scopeKindsPh: string;
  scopeKindsHint: string;
  scopePaths: string;
  scopePathsHint: string;
  onPassTitle: string;
  onPassHint: string;
  mergeMode: string;
  mergeProject: string;
  mergeAuto: string;
  mergeManual: string;
  mergeHint: string;
  mergeProjectHint: string;
  mergeManualHint: string;
  allProjects: string;
  agentFixes: string;
  agentFixesHint: string;
  dropApprovals: string;
  dropApprovalsHint: string;
  replaces: string;
  reviewers: string;
  reviewersHint: string;
  reviewerCli: (n: number) => string;
  reviewerModel: (n: number) => string;
  removeReviewer: (n: number) => string;
  addReviewer: string;
  rubric: string;
  rubricHint: string;
  minScore: string;
  combine: string;
  combineAll: string;
  combineAvg: string;
  blockOn: string;
  blockNone: string;
  blockCritical: string;
  blockMajor: string;
  runWhere: string;
  whereTeam: string;
  whereRequester: string;
  aiPolicyHint: string;
  ruleKind: string;
  docOnlyTag: string;
  docOnly: string;
  docOnlyHint: string;
  cmd: (n: number) => string;
  cmdHint: string;
  cmdTimeout: (n: number) => string;
  addCommand: string;
  removeCommand: (n: number) => string;
  maxFiles: string;
  denyGlobs: string;
  denyGlobsHint: string;
  ciHead: string;
  ciHeadHint: string;
  noCi: string;
  noCiPass: string;
  noCiFail: string;
  allowRequester: string;
  allowRequesterHint: string;
  condPaths: (v: string) => string;
  condTaskTypes: (v: string) => string;
  condPathsLabel: string;
  condTaskTypesLabel: string;
  condTaskTypesPh: string;
  skipCodeHint: string;
  noRubric: string;
  dryTitle: string;
  dryDesc: string;
  dryProject: string;
  dryRun: string;
  dryNoRuns: string;
  dryMatched: string;
  dryNotMatched: string;
  dryChosen: string;
  dryShadow: string;
  dryNote: string;
  dryNoPr: string;
  fromTitle: string;
  fromDesc: string;
  fromProjectLabel: string;
  fromCreate: string;
  fromCreating: string;
  fromNoProjects: string;
  fromTeam: string;
  pickProject: string;
  aiWho: (reviewers: string, n: number, score: number) => string;
  condLine: (parts: string[]) => string;
}> = {
  vi: {
    locked: "Loại áp dụng cố định sau khi lưu",
    lockedHint: "Muốn đổi, nhân bản quy trình",
    test: "Chạy thử trên 1 PR",
    fromProject: "Tạo từ cấu hình dự án",
    scope: "Phạm vi kích hoạt",
    scopeHint: "Quy trình chạy khi PR của run code khớp cả bốn ô. Ô trống là không giới hạn.",
    scopeProjects: "Dự án",
    addProject: "thêm dự án",
    removeProject: (key) => `Bỏ dự án ${key}`,
    scopeProjectsHint: "Trống: mọi dự án đội này sở hữu.",
    scopeBranch: "Nhánh đích",
    scopeBranchPh: "main, release/*",
    scopeBranchHint: "Glob, cách nhau bằng dấu phẩy. Trống: nhánh mặc định.",
    scopeKinds: "Loại task",
    scopeKindsPh: "feature, bug",
    scopeKindsHint: "Cách nhau bằng dấu phẩy. Trống: mọi loại.",
    scopePaths: "Đường dẫn đổi",
    scopePathsHint: "Mỗi dòng một glob. Trống: mọi thay đổi.",
    onPassTitle: "Khi đạt và khi trả lại",
    onPassHint: "PR đạt thì merge thế nào; bị trả lại thì agent được sửa mấy lượt.",
    mergeMode: "Chế độ merge",
    mergeProject: "Theo cấu hình dự án",
    mergeAuto: "Tự vào hàng merge",
    mergeManual: "Chờ người bấm",
    mergeHint: "Cần dự án bật merge queue; không thì PR chờ người merge.",
    mergeProjectHint: "Dùng chế độ merge trong cài đặt của từng dự án.",
    mergeManualHint: "PR đạt chờ người bấm merge.",
    allProjects: "Mọi dự án của đội sở hữu",
    agentFixes: "Số lượt agent sửa tối đa",
    agentFixesHint: "0–5. Hết lượt, hoặc hết ngân sách task, PR về người giao việc.",
    dropApprovals: "Bỏ phê duyệt cũ khi có commit mới",
    dropApprovalsHint: "Tắt: phê duyệt ở checkpoint trước điểm trả lại được giữ.",
    replaces:
      "Quy trình này thay review chéo của dự án cho các run khớp phạm vi; dự án không khớp giữ cấu hình hiện tại.",
    reviewers: "Reviewer AI (1–3)",
    reviewersHint: "CLI và model tuỳ chọn; chạy song song.",
    reviewerCli: (n) => `CLI của reviewer ${n}`,
    reviewerModel: (n) => `Model của reviewer ${n}`,
    removeReviewer: (n) => `Bỏ reviewer ${n}`,
    addReviewer: "Thêm reviewer",
    rubric: "Rubric (1–20 mục)",
    rubricHint: "Mỗi dòng một mục; reviewer chấm từng mục.",
    minScore: "Điểm tối thiểu",
    combine: "Cách gộp",
    combineAll: "Mọi reviewer đạt",
    combineAvg: "Điểm trung bình",
    blockOn: "Chặn khi có phát hiện",
    blockNone: "Không chặn",
    blockCritical: "Nghiêm trọng",
    blockMajor: "Lớn trở lên",
    runWhere: "Chạy ở",
    whereTeam: "Máy dùng chung của đội",
    whereRequester: "Máy của người giao việc",
    aiPolicyHint: "CLI hoặc model bị chính sách agent của tổ chức cấm sẽ bị từ chối khi lưu.",
    ruleKind: "Quy tắc",
    docOnlyTag: "chỉ tài liệu",
    docOnly: "Quy tắc này chỉ dùng cho tài liệu.",
    docOnlyHint: "Với Code (PR), chọn command, max-files, deny-paths, max-diff, no-secrets hoặc agent-report.",
    cmd: (n) => `Lệnh ${n}`,
    cmdHint:
      "Worker chạy trong worktree của run sau khi agent xong; hub chỉ đọc mã thoát và 200 dòng cuối. Thiếu kết quả thì chờ người xem.",
    cmdTimeout: (n) => `Thời hạn lệnh ${n} (giây)`,
    addCommand: "Thêm lệnh",
    removeCommand: (n) => `Bỏ lệnh ${n}`,
    maxFiles: "Số file tối đa",
    denyGlobs: "Đường dẫn cấm (glob)",
    denyGlobsHint: "Mỗi dòng một glob; diff đụng vào là không đạt.",
    ciHead: "CI trên commit đầu của PR",
    ciHeadHint: "Cố định theo PR; không chọn commit khác.",
    noCi: "Khi repo không có CI",
    noCiPass: "Cho đạt",
    noCiFail: "Không đạt",
    allowRequester: "Cho người giao việc duyệt",
    allowRequesterHint: "Mặc định tắt (bốn mắt): người giao task cho agent không tự duyệt PR của mình.",
    condPaths: (v) => `đụng ${v}`,
    condTaskTypes: (v) => `loại task ${v}`,
    condPathsLabel: "Diff đụng đường dẫn",
    condTaskTypesLabel: "Loại task",
    condTaskTypesPh: "feature, bug",
    skipCodeHint: "Điều kiện không thoả thì checkpoint bị bỏ qua và ghi lý do cho người duyệt.",
    noRubric: "Chưa có mục nào",
    dryTitle: "Chạy thử trên 1 PR",
    dryDesc:
      "Chọn một run code đã mở PR; hub cho biết quy trình có khớp không và checkpoint nào chạy hay bỏ qua. Không tạo run, không ghi dữ liệu.",
    dryProject: "Dự án",
    dryRun: "Run để thử",
    dryNoRuns: "Dự án này chưa có run code nào mở PR.",
    dryMatched: "Khớp phạm vi",
    dryNotMatched: "Không khớp phạm vi",
    dryChosen: "Quy trình được chọn:",
    dryShadow: "Quy trình bị lấn:",
    dryNote: "Quy tắc chọn: dự án > đội > tổ chức, rồi quy trình cập nhật gần nhất.",
    dryNoPr: "chưa có PR",
    fromTitle: "Tạo từ cấu hình dự án",
    fromDesc:
      "Dựng bản nháp từ review chéo, CI bắt buộc và số người duyệt của dự án. Chưa lưu cho tới khi bạn bấm Tạo quy trình.",
    fromProjectLabel: "Dự án",
    fromCreate: "Tạo bản nháp",
    fromCreating: "Đang tạo…",
    fromNoProjects: "Chưa có dự án nào để lấy cấu hình.",
    fromTeam: "Đội của dự án",
    pickProject: "Chọn dự án",
    aiWho: (reviewers, n, score) => `${reviewers} · ${n} mục · đạt từ ${score}/10`,
    condLine: (parts) => `khi ${parts.join("; ")}`,
  },
  en: {
    locked: "Type is fixed once saved",
    lockedHint: "To change it, duplicate the workflow",
    test: "Dry-run on a PR",
    fromProject: "Create from project settings",
    scope: "Trigger scope",
    scopeHint: "The workflow runs when a code run PR matches all four fields. An empty field means no limit.",
    scopeProjects: "Projects",
    addProject: "add project",
    removeProject: (key) => `Remove project ${key}`,
    scopeProjectsHint: "Empty: every project this team owns.",
    scopeBranch: "Target branches",
    scopeBranchPh: "main, release/*",
    scopeBranchHint: "Globs, comma separated. Empty: the default branch.",
    scopeKinds: "Task types",
    scopeKindsPh: "feature, bug",
    scopeKindsHint: "Comma separated. Empty: every type.",
    scopePaths: "Changed paths",
    scopePathsHint: "One glob per line. Empty: any change.",
    onPassTitle: "On pass and on return",
    onPassHint: "How a passing PR is merged, and how many times the agent may revise a returned one.",
    mergeMode: "Merge mode",
    mergeProject: "Follow project settings",
    mergeAuto: "Enqueue automatically",
    mergeManual: "Wait for a person",
    mergeHint: "Needs the project merge queue; otherwise the PR waits for a person.",
    mergeProjectHint: "Use each project's merge setting.",
    mergeManualHint: "A passing PR waits for someone to merge it.",
    allProjects: "Every project of the owning team",
    agentFixes: "Max agent revisions",
    agentFixesHint: "0–5. When used up, or the task budget runs out, the PR goes back to the task owner.",
    dropApprovals: "Drop old approvals on a new commit",
    dropApprovalsHint: "Off: approvals at checkpoints before the return point are kept.",
    replaces:
      "This workflow replaces the project's cross review for runs inside the scope; other runs keep the current setup.",
    reviewers: "AI reviewers (1–3)",
    reviewersHint: "CLI and optional model; run in parallel.",
    reviewerCli: (n) => `Reviewer ${n} CLI`,
    reviewerModel: (n) => `Reviewer ${n} model`,
    removeReviewer: (n) => `Remove reviewer ${n}`,
    addReviewer: "Add reviewer",
    rubric: "Rubric (1–20 items)",
    rubricHint: "One item per line; each reviewer scores every item.",
    minScore: "Minimum score",
    combine: "Combine",
    combineAll: "Every reviewer passes",
    combineAvg: "Average score",
    blockOn: "Block on findings",
    blockNone: "Never block",
    blockCritical: "Critical",
    blockMajor: "Major and above",
    runWhere: "Run on",
    whereTeam: "Team shared machines",
    whereRequester: "Task owner machines",
    aiPolicyHint: "A CLI or model forbidden by the org agent policy is rejected on save.",
    ruleKind: "Rules",
    docOnlyTag: "documents only",
    docOnly: "This rule only applies to documents.",
    docOnlyHint: "For Code (PR), pick command, max-files, deny-paths, max-diff, no-secrets or agent-report.",
    cmd: (n) => `Command ${n}`,
    cmdHint:
      "The worker runs it in the run worktree after the agent finishes; the hub reads only the exit code and last 200 lines. No result means a person checks.",
    cmdTimeout: (n) => `Command ${n} timeout (seconds)`,
    addCommand: "Add command",
    removeCommand: (n) => `Remove command ${n}`,
    maxFiles: "Max files",
    denyGlobs: "Forbidden paths (glob)",
    denyGlobsHint: "One glob per line; a diff touching them fails.",
    ciHead: "CI on the PR head commit",
    ciHeadHint: "Fixed to the PR; no other commit can be chosen.",
    noCi: "When the repo has no CI",
    noCiPass: "Pass",
    noCiFail: "Fail",
    allowRequester: "Let the task owner approve",
    allowRequesterHint: "Off by default (four eyes): whoever assigned the task to the agent cannot approve its PR.",
    condPaths: (v) => `touches ${v}`,
    condTaskTypes: (v) => `task type ${v}`,
    condPathsLabel: "Diff touches paths",
    condTaskTypesLabel: "Task types",
    condTaskTypesPh: "feature, bug",
    skipCodeHint: "When a condition is not met the checkpoint is skipped and the reason is shown to the reviewer.",
    noRubric: "No items yet",
    dryTitle: "Dry-run on a PR",
    dryDesc:
      "Pick a code run that opened a PR; the hub tells whether the workflow matches and which checkpoints run or are skipped. Creates no run and writes no data.",
    dryProject: "Project",
    dryRun: "Run to try",
    dryNoRuns: "This project has no code run with a PR yet.",
    dryMatched: "Scope matches",
    dryNotMatched: "Scope does not match",
    dryChosen: "Chosen workflow:",
    dryShadow: "Shadowed workflow:",
    dryNote: "Selection order: project > team > organization, then most recently updated.",
    dryNoPr: "no PR yet",
    fromTitle: "Create from project settings",
    fromDesc:
      "Builds a draft from the project's cross review, required CI and approver count. Nothing is saved until you create the workflow.",
    fromProjectLabel: "Project",
    fromCreate: "Create draft",
    fromCreating: "Creating…",
    fromNoProjects: "No project to read settings from.",
    fromTeam: "Project team",
    pickProject: "Pick a project",
    aiWho: (reviewers, n, score) => `${reviewers} · ${n} items · pass from ${score}/10`,
    condLine: (parts) => `when ${parts.join("; ")}`,
  },
};

const text = workflowsText;

/** Dòng "ai làm" trên thẻ checkpoint code: các reviewer (CLI:model), số mục rubric, điểm đạt. */
export function codeGateWho(g: ReviewGate, tc: (typeof codeText)["vi"]): string | null {
  if (g.kind === "ai" && g.ai) {
    const who = (g.ai.reviewers ?? []).map((r) => (r.model ? `${r.cli}:${r.model}` : r.cli)).join(", ");
    return tc.aiWho(who, g.ai.checks.length, g.ai.passScore);
  }
  if (g.kind === "rule" && g.rules?.length) return g.rules.join(", ");
  return null;
}

/** Điều kiện của checkpoint code ở dạng "⤷ khi …" trên thẻ; chuỗi rỗng khi luôn chạy. */
export function codeGateCond(g: ReviewGate, tc: (typeof codeText)["vi"], size: (n: number) => string): string {
  const c = g.conditions;
  const parts = [
    ...(c.paths?.length ? [tc.condPaths(c.paths.join(", "))] : []),
    ...(c.taskTypes?.length ? [tc.condTaskTypes(c.taskTypes.join(", "))] : []),
    ...(c.minChangedLines ? [size(c.minChangedLines)] : []),
  ];
  return parts.length ? tc.condLine(parts) : "";
}

const chipClass = "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs";

type ScopeChange = Partial<NonNullable<WorkflowDraft["code"]>>;

/** Các hàng của mục "Phạm vi kích hoạt": quy trình code chỉ nhận PR khớp cả bốn ô. */
export function CodeScopeRows({
  draft,
  canWrite,
  projects,
  onChange,
}: {
  draft: WorkflowDraft;
  canWrite: boolean;
  projects: Pick<Project, "id" | "key" | "name">[];
  onChange: (patch: ScopeChange) => void;
}) {
  const tc = useT(codeText);
  const ids = useId();
  const code = draft.code;
  if (!code) return null;
  const free = projects.filter((p) => !code.projects.includes(p.key));
  return (
    <>
      <FormRow label={tc.scopeProjects} hint={tc.scopeProjectsHint}>
        <span className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-lg border border-input p-1.5">
          {code.projects.length === 0 && !canWrite && (
            <span className="px-1 text-sm text-muted-foreground">{tc.allProjects}</span>
          )}
          {code.projects.map((key) => (
            <span key={key} className={cn(chipClass, "border-border font-mono")}>
              {key}
              {canWrite && (
                <button
                  type="button"
                  aria-label={tc.removeProject(key)}
                  className="cursor-pointer text-muted-foreground hover:text-foreground"
                  onClick={() => onChange({ projects: code.projects.filter((k) => k !== key) })}
                >
                  <XIcon className="size-3" aria-hidden="true" />
                </button>
              )}
            </span>
          ))}
          {canWrite && (
            <select
              aria-label={tc.addProject}
              value=""
              className="h-6 min-w-30 flex-1 cursor-pointer rounded-sm bg-transparent text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              onChange={(e) => e.target.value && onChange({ projects: [...code.projects, e.target.value] })}
            >
              <option value="">+ {tc.addProject}</option>
              {free.map((p) => (
                <option key={p.id} value={p.key}>
                  {p.key} · {p.name}
                </option>
              ))}
            </select>
          )}
        </span>
      </FormRow>
      <FormRow label={tc.scopeBranch} hint={tc.scopeBranchHint} htmlFor={`${ids}-branch`}>
        <ListInput
          id={`${ids}-branch`}
          placeholder={tc.scopeBranchPh}
          value={code.baseBranches}
          disabled={!canWrite}
          onChange={(baseBranches) => onChange({ baseBranches })}
        />
      </FormRow>
      <FormRow label={tc.scopeKinds} hint={tc.scopeKindsHint} htmlFor={`${ids}-kinds`}>
        <ListInput
          id={`${ids}-kinds`}
          placeholder={tc.scopeKindsPh}
          value={code.taskTypes}
          disabled={!canWrite}
          onChange={(taskTypes) => onChange({ taskTypes })}
        />
      </FormRow>
      <FormRow label={tc.scopePaths} hint={tc.scopePathsHint} htmlFor={`${ids}-paths`}>
        <LinesInput
          id={`${ids}-paths`}
          className="min-h-16 font-mono text-sm"
          value={code.paths}
          disabled={!canWrite}
          onChange={(paths) => onChange({ paths })}
        />
      </FormRow>
      {/* Quy trình khớp thì thay review chéo cũ (D3), nên quản trị biết điều gì sẽ đổi trước khi lưu phạm vi. */}
      <p className="flex items-start gap-2 text-xs text-pretty text-muted-foreground">
        <InfoIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        {tc.replaces}
      </p>
    </>
  );
}

/** Các hàng của mục "Khi đạt và khi trả lại" của quy trình code. */
export function CodeOnPassRows({
  draft,
  canWrite,
  onChange,
}: {
  draft: WorkflowDraft;
  canWrite: boolean;
  onChange: (patch: ScopeChange) => void;
}) {
  const tc = useT(codeText);
  const ids = useId();
  const code = draft.code;
  if (!code) return null;
  return (
    <>
      <FormRow label={tc.mergeMode}>
        <RadioCards
          name={`${ids}-merge`}
          label={tc.mergeMode}
          value={code.merge}
          disabled={!canWrite}
          onChange={(merge) => onChange({ merge })}
          options={[
            { value: "project", title: tc.mergeProject, description: tc.mergeProjectHint },
            { value: "auto", title: tc.mergeAuto, description: tc.mergeHint },
            { value: "manual", title: tc.mergeManual, description: tc.mergeManualHint },
          ]}
        />
      </FormRow>
      <FormRow label={tc.agentFixes} hint={tc.agentFixesHint} htmlFor={`${ids}-fixes`}>
        <Input
          id={`${ids}-fixes`}
          type="number"
          min="0"
          max="5"
          className="w-24 font-mono"
          value={String(code.maxAgentRevisions)}
          disabled={!canWrite}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            if (e.target.value !== "" && Number.isFinite(n)) onChange({ maxAgentRevisions: n });
          }}
        />
      </FormRow>
      <SwitchRow
        label={tc.dropApprovals}
        hint={tc.dropApprovalsHint}
        checked={code.dismissStaleApprovals}
        disabled={!canWrite}
        onChange={(dismissStaleApprovals) => onChange({ dismissStaleApprovals })}
      />
    </>
  );
}

/** Khung cấu hình một checkpoint của quy trình code: cùng khung với tài liệu, phần thân theo loại của code. */
export function CodeGateConfig({
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
  members: React.ComponentProps<typeof Approvers>["members"];
  teams: React.ComponentProps<typeof Approvers>["teams"];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (fn: (g: ReviewGate) => ReviewGate) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const tc = useT(codeText);
  const lang = useLang();
  const ids = useId();
  const disabled = !canWrite;
  const set = (patch: Partial<ReviewGate>) => onChange((x) => ({ ...x, ...patch }));
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
      <div className="flex flex-col gap-3.5 pt-3.5 xl:pl-4">
        <KindSwitch kind={g.kind} disabled={disabled} onChange={(k) => onChange((x) => withKind(x, k, lang, "code"))} />
        {g.kind === "human" && (
          <>
            <Approvers
              gate={g}
              members={members}
              teams={teams}
              disabled={disabled}
              onChange={(reviewers) => set({ reviewers })}
            />
            <label htmlFor={`${ids}-requester`} className="flex items-start gap-2 text-sm">
              <Checkbox
                id={`${ids}-requester`}
                className="mt-0.5"
                checked={g.reviewers?.allowRequester ?? false}
                disabled={disabled}
                onCheckedChange={(allowRequester) =>
                  g.reviewers && set({ reviewers: { ...g.reviewers, allowRequester } })
                }
              />
              <span>
                {tc.allowRequester}
                <span className="block text-xs text-muted-foreground">{tc.allowRequesterHint}</span>
              </span>
            </label>
          </>
        )}
        {g.kind === "ai" && g.ai && <AiFields gate={g} disabled={disabled} onChange={onChange} />}
        {g.kind === "rule" && <RuleFields gate={g} disabled={disabled} onChange={onChange} />}
        {g.kind === "ext" && <ExtFields gate={g} disabled={disabled} onChange={set} />}
        <Conditions gate={g} canWrite={canWrite} onChange={onChange} />
        <RejectAndSla gate={g} disabled={disabled} onChange={set} />
      </div>
    </>
  );
}

type GateChange = (fn: (g: ReviewGate) => ReviewGate) => void;
type AiConfig = NonNullable<ReviewGate["ai"]>;

function AiFields({ gate: g, disabled, onChange }: { gate: ReviewGate; disabled: boolean; onChange: GateChange }) {
  const tc = useT(codeText);
  const ids = useId();
  const ai = g.ai as AiConfig;
  const reviewers = ai.reviewers ?? [];
  const setAi = (patch: Partial<AiConfig>) =>
    onChange((x) => ({ ...x, ai: { checks: [], passScore: 7, ...x.ai, ...patch } }));
  const setReviewer = (i: number, patch: { cli?: ReviewerCli; model?: string }) =>
    setAi({ reviewers: reviewers.map((r, n) => (n === i ? { ...r, ...patch } : r)) });
  return (
    <>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0 text-sm font-medium">
        <legend className="mb-1.5">{tc.reviewers}</legend>
        <span className="-mt-1 text-xs font-normal text-muted-foreground">{tc.reviewersHint}</span>
        {reviewers.map((r, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: reviewer không có mã; thứ tự là thứ tự trong danh sách.
            key={i}
            className="flex items-center gap-1.5"
          >
            <NativeSelect
              aria-label={tc.reviewerCli(i + 1)}
              className="w-28 flex-none font-mono"
              value={r.cli}
              disabled={disabled}
              onChange={(e) => setReviewer(i, { cli: e.target.value as ReviewerCli })}
            >
              {REVIEWER_CLIS.map((cli) => (
                <option key={cli} value={cli}>
                  {cli}
                </option>
              ))}
            </NativeSelect>
            <Input
              aria-label={tc.reviewerModel(i + 1)}
              list={`${ids}-models`}
              maxLength={200}
              className="min-w-0 flex-1 font-mono"
              placeholder="model"
              value={r.model ?? ""}
              disabled={disabled}
              onChange={(e) => setReviewer(i, { model: e.target.value })}
            />
            {!disabled && reviewers.length > 1 && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={tc.removeReviewer(i + 1)}
                onClick={() => setAi({ reviewers: reviewers.filter((_, n) => n !== i) })}
              >
                <XIcon aria-hidden="true" />
              </Button>
            )}
          </span>
        ))}
        <datalist id={`${ids}-models`}>
          {MODEL_SUGGESTIONS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {!disabled && reviewers.length < 3 && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => {
              const used = new Set(reviewers.map((r) => r.cli));
              const cli = REVIEWER_CLIS.find((c) => !used.has(c)) ?? "claude";
              setAi({ reviewers: [...reviewers, { cli }] });
            }}
          >
            <PlusIcon aria-hidden="true" />
            {tc.addReviewer}
          </Button>
        )}
      </fieldset>
      <Field>
        <FieldLabel htmlFor={`${ids}-rubric`}>{tc.rubric}</FieldLabel>
        <LinesInput
          id={`${ids}-rubric`}
          className="min-h-23 text-sm"
          value={ai.checks}
          disabled={disabled}
          onChange={(checks) => setAi({ checks })}
        />
        <FieldHint>{tc.rubricHint}</FieldHint>
      </Field>
      <div className="grid grid-cols-2 gap-2.5">
        <Field>
          <FieldLabel htmlFor={`${ids}-score`}>{tc.minScore}</FieldLabel>
          <span className="flex items-center gap-2">
            <Input
              id={`${ids}-score`}
              type="number"
              min="0"
              max="10"
              step="0.5"
              className="w-20 font-mono"
              value={String(ai.passScore)}
              disabled={disabled}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (e.target.value !== "" && Number.isFinite(n)) setAi({ passScore: Math.min(10, Math.max(0, n)) });
              }}
            />
            <span className="font-mono text-sm text-muted-foreground">/ 10</span>
          </span>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-aggregate`}>{tc.combine}</FieldLabel>
          <NativeSelect
            id={`${ids}-aggregate`}
            value={ai.aggregate ?? "all"}
            disabled={disabled}
            onChange={(e) => setAi({ aggregate: e.target.value as "all" | "avg" })}
          >
            <option value="all">{tc.combineAll}</option>
            <option value="avg">{tc.combineAvg}</option>
          </NativeSelect>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor={`${ids}-block`}>{tc.blockOn}</FieldLabel>
        <NativeSelect
          id={`${ids}-block`}
          value={ai.blockOn ?? "none"}
          disabled={disabled}
          onChange={(e) =>
            setAi({ blockOn: e.target.value === "none" ? null : (e.target.value as "critical" | "major") })
          }
        >
          <option value="none">{tc.blockNone}</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s === "critical" ? tc.blockCritical : tc.blockMajor}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${ids}-runner`}>{tc.runWhere}</FieldLabel>
        <NativeSelect
          id={`${ids}-runner`}
          value={ai.runner ?? "team"}
          disabled={disabled}
          onChange={(e) => setAi({ runner: e.target.value as "team" | "requester" })}
        >
          <option value="team">{tc.whereTeam}</option>
          <option value="requester">{tc.whereRequester}</option>
        </NativeSelect>
        <FieldHint>{tc.aiPolicyHint}</FieldHint>
      </Field>
    </>
  );
}

function NumberField({
  label,
  id,
  value,
  disabled,
  onChange,
}: {
  label: string;
  id: string;
  value: number | undefined;
  disabled: boolean;
  onChange: (n: number | undefined) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        min="1"
        className="w-32 font-mono"
        value={value ? String(value) : ""}
        disabled={disabled}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value));
          onChange(n > 0 ? n : undefined);
        }}
      />
    </Field>
  );
}

function RuleFields({ gate: g, disabled, onChange }: { gate: ReviewGate; disabled: boolean; onChange: GateChange }) {
  const t = useT(text);
  const tc = useT(codeText);
  const ids = useId();
  const has = (r: (typeof CODE_RULE_ORDER)[number]) => g.rules?.includes(r) ?? false;
  const commands = g.commands ?? [];
  const wrongKind = DOC_ONLY_RULES.filter(has);
  const setCommands = (next: typeof commands) => onChange((x) => ({ ...x, commands: next }));
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1.5 text-sm font-medium">{tc.ruleKind}</legend>
      {CODE_RULE_ORDER.map((r) => (
        <label key={r} htmlFor={`${ids}-rule-${r}`} className="flex items-center gap-2 text-sm">
          <Checkbox
            id={`${ids}-rule-${r}`}
            checked={has(r)}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange((x) => ({
                ...x,
                rules: checked
                  ? CODE_RULE_ORDER.filter((k) => k === r || x.rules?.includes(k))
                  : (x.rules ?? []).filter((k) => k !== r),
                // Lệnh đầu tiên điền sẵn để quy tắc vừa bật đã hợp lệ.
                ...(checked && r === "command" && !x.commands?.length ? { commands: [DEFAULT_COMMAND] } : {}),
              }))
            }
          />
          <span>
            {t.ruleText[r]}
            {DOC_ONLY_RULES.includes(r) && (
              <span className="ml-1.5 text-xs text-muted-foreground">({tc.docOnlyTag})</span>
            )}
          </span>
        </label>
      ))}
      {wrongKind.length > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-destructive-soft px-2.5 py-2 text-sm text-destructive"
        >
          <span aria-hidden="true">!</span>
          <span>
            {tc.docOnly}
            <span className="block text-xs opacity-85">{tc.docOnlyHint}</span>
          </span>
        </div>
      )}
      {has("command") && (
        <div className="flex flex-col gap-2">
          {commands.map((c, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: lệnh không có mã; thứ tự là thứ tự chạy.
              key={i}
              className="flex items-end gap-1.5"
            >
              <span className="min-w-0 flex-1">
                <Field>
                  <FieldLabel htmlFor={`${ids}-cmd-${i}`}>{tc.cmd(i + 1)}</FieldLabel>
                  <Input
                    id={`${ids}-cmd-${i}`}
                    maxLength={500}
                    className="font-mono"
                    value={c.run}
                    disabled={disabled}
                    onChange={(e) => setCommands(commands.map((x, n) => (n === i ? { ...x, run: e.target.value } : x)))}
                  />
                </Field>
              </span>
              <Input
                aria-label={tc.cmdTimeout(i + 1)}
                type="number"
                min="10"
                max="3600"
                className="w-20 flex-none font-mono"
                value={String(c.timeoutSec)}
                disabled={disabled}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (n > 0) setCommands(commands.map((x, k) => (k === i ? { ...x, timeoutSec: n } : x)));
                }}
              />
              {!disabled && commands.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={tc.removeCommand(i + 1)}
                  className="mb-1"
                  onClick={() => setCommands(commands.filter((_, n) => n !== i))}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              )}
            </span>
          ))}
          <span className="text-xs text-muted-foreground">{tc.cmdHint}</span>
          {!disabled && commands.length < 5 && (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setCommands([...commands, { ...DEFAULT_COMMAND }])}
            >
              <PlusIcon aria-hidden="true" />
              {tc.addCommand}
            </Button>
          )}
        </div>
      )}
      {has("max-files") && (
        <NumberField
          label={tc.maxFiles}
          id={`${ids}-maxfiles`}
          value={g.maxFiles}
          disabled={disabled}
          onChange={(maxFiles) => onChange(({ maxFiles: _, ...x }) => (maxFiles ? { ...x, maxFiles } : x))}
        />
      )}
      {has("max-diff") && (
        <NumberField
          label={t.maxDiff}
          id={`${ids}-maxdiff`}
          value={g.maxDiffLines}
          disabled={disabled}
          onChange={(maxDiffLines) =>
            onChange(({ maxDiffLines: _, ...x }) => (maxDiffLines ? { ...x, maxDiffLines } : x))
          }
        />
      )}
      {has("deny-paths") && (
        <Field>
          <FieldLabel htmlFor={`${ids}-deny`}>{tc.denyGlobs}</FieldLabel>
          <LinesInput
            id={`${ids}-deny`}
            className="min-h-16 font-mono text-sm"
            value={g.denyPaths ?? []}
            disabled={disabled}
            onChange={(denyPaths) => onChange((x) => ({ ...x, denyPaths }))}
          />
          <FieldHint>{tc.denyGlobsHint}</FieldHint>
        </Field>
      )}
    </fieldset>
  );
}

function ExtFields({
  gate: g,
  disabled,
  onChange,
}: {
  gate: ReviewGate;
  disabled: boolean;
  onChange: (patch: Partial<ReviewGate>) => void;
}) {
  const t = useT(text);
  const tc = useT(codeText);
  const ids = useId();
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${ids}-ext`}>{t.extCheck}</FieldLabel>
        <Input id={`${ids}-ext`} className="bg-muted" value={tc.ciHead} disabled readOnly />
        <FieldHint>{tc.ciHeadHint}</FieldHint>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${ids}-none`}>{tc.noCi}</FieldLabel>
        <NativeSelect
          id={`${ids}-none`}
          value={g.ext?.whenNone ?? "pass"}
          disabled={disabled}
          onChange={(e) => onChange({ ext: { check: "ci", whenNone: e.target.value as "pass" | "fail" } })}
        >
          <option value="pass">{tc.noCiPass}</option>
          <option value="fail">{tc.noCiFail}</option>
        </NativeSelect>
      </Field>
    </>
  );
}

/** "Chạy khi" của checkpoint code: đường dẫn đổi, loại task, số dòng đổi; không thoả thì bỏ qua và ghi lý do. */
function Conditions({ gate: g, canWrite, onChange }: { gate: ReviewGate; canWrite: boolean; onChange: GateChange }) {
  const t = useT(text);
  const tc = useT(codeText);
  const ids = useId();
  const [open, setOpen] = useState(false);
  const c = g.conditions;
  const setCond = (patch: Partial<ReviewGate["conditions"]>) =>
    onChange((x) => ({ ...x, conditions: { ...x.conditions, ...patch } }));
  const chips: { key: string; label: string; clear: Partial<ReviewGate["conditions"]> }[] = [
    ...(c.paths?.length ? [{ key: "paths", label: tc.condPaths(c.paths.join(", ")), clear: { paths: [] } }] : []),
    ...(c.taskTypes?.length
      ? [{ key: "taskTypes", label: tc.condTaskTypes(c.taskTypes.join(", ")), clear: { taskTypes: [] } }]
      : []),
    ...(c.minChangedLines
      ? [{ key: "min", label: t.condSize(c.minChangedLines), clear: { minChangedLines: null } }]
      : []),
  ];
  return (
    <fieldset className="m-0 flex flex-col gap-2.5 border-0 border-t border-border p-0 pt-3">
      <legend className="float-left mb-1.5 w-full text-sm font-medium">{t.when}</legend>
      <span className="flex flex-wrap items-center gap-1.5 text-sm">
        {chips.length === 0 && <span className="text-muted-foreground">{t.always}</span>}
        {chips.map((chip) => (
          <span key={chip.key} className={cn(chipClass, "border-border")}>
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
          <Button variant="ghost" size="xs" aria-expanded={open} onClick={() => setOpen(!open)}>
            + {t.addCond}
          </Button>
        )}
      </span>
      {open && (
        <div className="grid gap-2.5">
          <Field>
            <FieldLabel htmlFor={`${ids}-paths`}>{tc.condPathsLabel}</FieldLabel>
            <LinesInput
              id={`${ids}-paths`}
              className="min-h-14 font-mono text-sm"
              value={c.paths ?? []}
              disabled={!canWrite}
              onChange={(paths) => setCond({ paths })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-types`}>{tc.condTaskTypesLabel}</FieldLabel>
            <ListInput
              id={`${ids}-types`}
              placeholder={tc.condTaskTypesPh}
              value={c.taskTypes ?? []}
              disabled={!canWrite}
              onChange={(taskTypes) => setCond({ taskTypes })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-size`}>{t.condSizeLabel}</FieldLabel>
            <Input
              id={`${ids}-size`}
              type="number"
              min="1"
              className="w-32 font-mono"
              value={c.minChangedLines ? String(c.minChangedLines) : ""}
              disabled={!canWrite}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                setCond({ minChangedLines: n > 0 ? n : null });
              }}
            />
          </Field>
        </div>
      )}
      <span className="text-xs text-muted-foreground">{tc.skipCodeHint}</span>
    </fieldset>
  );
}

const byNewest = (a: Run, b: Run) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt);

/** Chạy thử quy trình code (FR-009): chọn dự án, một run code đã mở PR, rồi xem checkpoint nào chạy hay bỏ qua. */
export function CodeDryRunDialog({
  draft,
  projects,
  onClose,
}: {
  draft: WorkflowDraft;
  projects: Pick<Project, "id" | "key" | "name">[];
  onClose: () => void;
}) {
  const t = useT(text);
  const tc = useT(codeText);
  const ids = useId();
  const scoped = projects.filter((p) => !draft.code?.projects.length || draft.code.projects.includes(p.key));
  const choices = scoped.length ? scoped : projects;
  const [projectId, setProjectId] = useState(choices[0]?.id ?? "");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tc.dryTitle}</DialogTitle>
          <DialogDescription>{tc.dryDesc}</DialogDescription>
        </DialogHeader>
        {choices.length === 0 ? (
          <Alert>{tc.fromNoProjects}</Alert>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor={`${ids}-project`}>{tc.dryProject}</FieldLabel>
              <NativeSelect id={`${ids}-project`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {choices.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.key} · {p.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <DryRunRuns key={projectId} draft={draft} projectId={projectId} />
          </>
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

function DryRunRuns({ draft, projectId }: { draft: WorkflowDraft; projectId: string }) {
  const { api } = useOrg();
  const t = useT(text);
  const tc = useT(codeText);
  const lang = useLang();
  const ids = useId();
  const runs = useQuery(api.runs.latest.queryOptions({ input: { projectId } }));
  const tasks = useQuery(api.tasks.list.queryOptions({ input: { projectId } }));
  const [picked, setPicked] = useState("");
  const [issues, setIssues] = useState<WorkflowIssue[]>([]);
  const dry = useMutation({
    mutationFn: (runId: string): Promise<CodeDryRunResult> =>
      api.codeReviews.dryRun.call({ workflow: toInput(draft), runId }),
  });
  if (runs.isPending || tasks.isPending) return <LoadingState />;
  if (runs.isError) return <LoadFailure error={runs.error} retry={() => runs.refetch()} />;
  const taskOf = new Map((tasks.data ?? []).map((task: Task) => [task.id, task]));
  const candidates = runs.data.filter((r) => r.kind === "code" && r.prUrl).sort(byNewest);
  const runId = candidates.find((r) => r.id === picked)?.id ?? candidates[0]?.id ?? "";
  const label = (r: Run) => {
    const task = r.taskId ? taskOf.get(r.taskId) : undefined;
    const pr = prNumberOf(r.prUrl);
    return [task?.key ?? r.branch, pr ? `#${pr}` : tc.dryNoPr, r.headSha?.slice(0, 7)].filter(Boolean).join(" · ");
  };
  function submit(e: FormEvent) {
    e.preventDefault();
    const found = workflowIssues(draft, lang);
    setIssues(found);
    if (!found.length && runId) dry.mutate(runId);
  }
  const hubIssues = dry.error ? hubIssuesOf(dry.error, draft, lang) : null;
  const r = dry.data;
  if (candidates.length === 0) return <Alert>{tc.dryNoRuns}</Alert>;
  return (
    <>
      <form onSubmit={submit} className="flex items-end gap-2">
        <div className="flex-1">
          <Field>
            <FieldLabel htmlFor={`${ids}-run`}>{tc.dryRun}</FieldLabel>
            <NativeSelect
              id={`${ids}-run`}
              className="font-mono"
              value={runId}
              onChange={(e) => {
                setPicked(e.target.value);
                dry.reset();
              }}
            >
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {label(c)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <Button type="submit" variant="outline" disabled={dry.isPending || !runId}>
          {dry.isPending ? t.running : t.run}
        </Button>
      </form>
      {issues.length > 0 && <IssueAlert title={t.invalid} issues={issues} />}
      {hubIssues && <IssueAlert title={t.invalid} issues={hubIssues} />}
      {dry.error && !hubIssues && <Alert variant="destructive">{apiErrorMessage(dry.error)}</Alert>}
      {r && (
        <div className="flex flex-col gap-3">
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <Pill tone={r.matched ? "ok" : "warn"}>
              <span aria-hidden="true">{r.matched ? "✓" : "✗"}</span> {r.matched ? tc.dryMatched : tc.dryNotMatched}
            </Pill>
            <span className="text-xs text-muted-foreground">{r.reason}</span>
          </span>
          {r.chosen && (
            <p className="text-xs text-muted-foreground">
              {tc.dryChosen} <span className="font-mono">{r.chosen.name}</span>
            </p>
          )}
          {r.outranked.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {tc.dryShadow} <span className="font-mono">{r.outranked.map((w) => w.name).join(", ")}</span>
            </p>
          )}
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
              </li>
            ))}
          </ol>
          <span className="text-xs text-muted-foreground">{tc.dryNote}</span>
        </div>
      )}
    </>
  );
}

/** "Tạo từ cấu hình dự án" (FR-010): hub dựng bản nháp từ review chéo, CI và số người duyệt của dự án; chưa lưu. */
export function FromProjectDialog({
  projects,
  onClose,
  onDraft,
}: {
  projects: Pick<Project, "id" | "key" | "name" | "teamId">[];
  onClose: () => void;
  onDraft: (input: Awaited<ReturnType<typeof requestDraft>>, teamId: string | null) => void;
}) {
  const { api } = useOrg();
  const t = useT(text);
  const tc = useT(codeText);
  const ids = useId();
  const [key, setKey] = useState(projects[0]?.key ?? "");
  const make = useMutation({
    mutationFn: (projectKey: string) => requestDraft(api, projectKey),
    onSuccess: (input) => onDraft(input, projects.find((p) => p.key === key)?.teamId ?? null),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (key) make.mutate(key);
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tc.fromTitle}</DialogTitle>
          <DialogDescription>{tc.fromDesc}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          {projects.length === 0 ? (
            <Alert>{tc.fromNoProjects}</Alert>
          ) : (
            <Field>
              <FieldLabel htmlFor={`${ids}-project`}>{tc.fromProjectLabel}</FieldLabel>
              <NativeSelect id={`${ids}-project`} value={key} onChange={(e) => setKey(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.key}>
                    {p.key} · {p.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          {make.error && <Alert variant="destructive">{apiErrorMessage(make.error)}</Alert>}
          <DialogActions>
            <Button type="button" variant="outline" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={!key || make.isPending}>
              {make.isPending ? tc.fromCreating : tc.fromCreate}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type OrgApi = ReturnType<typeof useOrg>["api"];
const requestDraft = (api: OrgApi, projectKey: string) => api.codeReviews.workflowFromProject.call({ projectKey });
