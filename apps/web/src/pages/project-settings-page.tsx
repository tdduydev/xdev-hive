import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { Machine, Project, ProjectSettings } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button, buttonVariants } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { LockIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { ProjectBriefCard } from "@/components/project-brief-card.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { usePermissions } from "@/lib/permissions.ts";
import {
  buildPatch,
  codeWorkflowsForProject,
  type FieldErrors,
  formFromSettings,
  type PermissionMode,
  REVIEW_CLIS,
  SETTINGS_CLIS,
  type SettingsForm,
  saveErrors,
  TASK_TIERS,
  type TaskTier,
  type TierForm,
} from "@/lib/project-settings.ts";
import { teamRoleLookup } from "@/lib/projects.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { CLI_LABEL } from "@/lib/run-view.ts";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  title: string;
  projectsCrumb: string;
  sectionsNav: string;
  loading: string;
  notFound: (k: string) => string;
  backToProjects: string;
  readOnlyBanner: string;
  mergeTitle: string;
  mergeHint: string;
  modeLabel: string;
  modeReview: string;
  modeReviewHint: string;
  modeAuto: string;
  modeAutoHint: string;
  reviewers: string;
  reviewersHint: string;
  method: string;
  mDefault: string;
  ciLabel: string;
  ciHint: string;
  queueLabel: string;
  queueHint: string;
  reviewTitle: string;
  reviewHint: string;
  workflowReview: (name: string) => string;
  workflowProtection: string;
  workflowCreate: string;
  reviewOn: string;
  reviewAgent: string;
  minScore: string;
  minScoreHint: string;
  mustPass: string;
  mustPassHint: string;
  onlyWhen: string;
  linesFrom: string;
  linesSuffix: string;
  filesMatch: string;
  globHint: string;
  onlyWhenHint: string;
  planTitle: string;
  planHint: string;
  sandboxTitle: string;
  sandboxHint: string;
  sandboxLink: string;
  budgetTitle: string;
  budgetHint: string;
  perRun: string;
  perTask: string;
  perTaskHint: string;
  maxTurns: string;
  maxTurnsHint: string;
  unlimited: string;
  modelTitle: string;
  modelHint: string;
  cliDefault: string;
  writeCode: string;
  reviewCode: string;
  tokensTitle: string;
  tokensHint: string;
  tokensOn: string;
  tokensOnHint: string;
  rtk: string;
  rtkHint: string;
  codegraph: string;
  codegraphHint: string;
  bashChars: string;
  bashCharsHint: string;
  compactPct: string;
  compactPctHint: string;
  subagent: string;
  subagentHint: string;
  cacheTtl: string;
  cacheTtlHint: string;
  cacheTtl5: string;
  cacheTtl1h: string;
  compactWindow: string;
  compactWindowHint: string;
  allowWeb: string;
  allowWebHint: string;
  routingTitle: string;
  routingHint: string;
  routingOn: string;
  routingOnHint: string;
  tierLight: string;
  tierMedium: string;
  tierHeavy: string;
  tierModel: string;
  tierEffort: string;
  tierMaxTurns: string;
  tierAdvisor: string;
  tierAdvisorHint: string;
  tierTurnsSuffix: string;
  permTitle: string;
  pWt: string;
  pWtHint: string;
  pFull: string;
  pFullHint: string;
  fullBanner: string;
  fullLocked: string;
  machinesTitle: string;
  machinesHint: string;
  machinesLoading: string;
  machinesFailed: (error: string) => string;
  machinesEmpty: string;
  machineBound: string;
  machineFull: string;
  machineFullIdle: string;
  machineStatus: Record<Machine["status"], string>;
  unsavedChanges: (n: number) => string;
  savedBanner: string;
  discard: string;
  save: string;
  saving: string;
  cfTitle: string;
  cfDesc: string;
  cf1: string;
  cf2: string;
  cf3: string;
  cfNote: string;
  cfKeep: string;
  cfGo: string;
  briefTitle: string;
  briefHint: string;
  briefAuto: string;
  briefAutoHint: string;
  briefCommits: string;
  briefCommitsHint: string;
  briefDays: string;
  briefDaysHint: string;
}> = {
  vi: {
    title: "Cấu hình dự án",
    projectsCrumb: "Dự án",
    sectionsNav: "Các phần",
    loading: "Đang tải…",
    notFound: (k) => `Không tìm thấy dự án ${k}, hoặc bạn không ở trong đội sở hữu dự án.`,
    backToProjects: "Về danh sách dự án",
    readOnlyBanner:
      "Bạn đang xem ở chế độ chỉ đọc. Quản trị đội sở hữu dự án hoặc quản trị tổ chức mới sửa được cấu hình.",
    mergeTitle: "Merge",
    mergeHint: "Cách PR của agent được merge vào nhánh chính.",
    modeLabel: "Chế độ",
    modeReview: "Cần người duyệt",
    modeReviewHint: "Người duyệt PR rồi mới merge.",
    modeAuto: "Tự merge khi đạt điều kiện",
    modeAutoHint: "Hub merge khi đạt chính sách kết quả và CI (nếu bắt buộc).",
    reviewers: "Số người duyệt",
    reviewersHint: "Từ 0 đến 6.",
    method: "Cách merge",
    mDefault: "Mặc định (squash)",
    ciLabel: "Bắt buộc CI xanh",
    ciHint: "Tắt thì repo không có CI vẫn merge được.",
    queueLabel: "Merge queue",
    queueHint: "PR vào hàng, hub cập nhật nhánh theo nhánh chính và merge lần lượt từng PR.",
    reviewTitle: "Review chéo",
    reviewHint: "Sau khi agent xong, một agent khác review thay đổi trước khi kết luận run.",
    workflowReview: (name) => `Quy trình ${name} đang thay review chéo cho run khớp phạm vi.`,
    workflowProtection:
      "Bảo vệ nhánh: yêu cầu status xdev-hive/review và đặt số người approve về 0. Phê duyệt trên GitHub/GitLab không được tính vào checkpoint.",
    workflowCreate: "Tạo quy trình từ cấu hình này",
    reviewOn: "Bật review chéo",
    reviewAgent: "Agent review",
    minScore: "Điểm tối thiểu",
    minScoreHint: "Thang 0 đến 10.",
    mustPass: "Bắt buộc đạt",
    mustPassHint: "Tắt thì kết quả review chỉ để tham khảo, run không hỏng vì review.",
    onlyWhen: "Chỉ review khi",
    linesFrom: "Số dòng đổi từ",
    linesSuffix: "dòng",
    filesMatch: "Có đổi file khớp",
    globHint: "Mỗi dòng một mẫu đường dẫn kiểu glob.",
    onlyWhenHint: "Bỏ trống cả hai thì review mọi run. Điền cả hai thì đạt một trong hai là review.",
    planTitle: "Plan mode",
    planHint: "Agent viết kế hoạch, người trong đội duyệt rồi run mới chạy.",
    sandboxTitle: "Sandbox",
    sandboxHint:
      "Run code chạy trên runner host, mỗi run một container gVisor không có mạng; chỉ ra được các địa chỉ trong allowlist.",
    sandboxLink: "Allowlist mạng và image môi trường của dự án",
    budgetTitle: "Ngân sách",
    budgetHint:
      "Bỏ trống là không giới hạn. Codex, Gemini và Antigravity không báo USD nên trần USD chỉ có tác dụng với Claude.",
    perRun: "Mỗi run",
    perTask: "Mỗi việc",
    perTaskHint: "Cộng mọi run của việc.",
    maxTurns: "Số lượt tối đa",
    maxTurnsHint: "Lượt trao đổi của agent trong một run.",
    unlimited: "Không giới hạn",
    modelTitle: "Model",
    modelHint: "Bỏ trống thì CLI dùng model mặc định của nó.",
    cliDefault: "Mặc định của CLI",
    writeCode: "Viết code",
    reviewCode: "Review",
    tokensTitle: "Tiết kiệm token",
    tokensHint:
      "Worker đặt các giới hạn này cho run Claude Code của dự án. Codex, Gemini và Antigravity chỉ nhận mục CodeGraph. Bản chỉnh của máy và biến môi trường của dự án có thể ghi đè từng mục.",
    tokensOn: "Bật tiết kiệm token",
    tokensOnHint: "Tắt thì run Claude Code dùng cấu hình mặc định của CLI, không nén bằng RTK và không gắn CodeGraph.",
    rtk: "Nén output lệnh bằng RTK",
    rtkHint: "Chỉ áp khi máy chạy run có rtk, và chỉ với Claude Code.",
    codegraph: "Gắn CodeGraph cho agent",
    codegraphHint: "Chỉ áp khi máy chạy run có codegraph. Agent tìm symbol, caller qua codegraph_explore thay vì grep.",
    bashChars: "Output lệnh tối đa",
    bashCharsHint: "Ký tự giữ lại từ một lệnh Bash. Output dài bị đọc lại ở mọi lượt sau nên rất tốn.",
    compactPct: "Tự nén ngữ cảnh khi đầy",
    compactPctHint: "Phần trăm ngữ cảnh khiến agent tự nén. Thấp hơn là nén sớm hơn, ngữ cảnh gọn hơn.",
    subagent: "Model của subagent",
    subagentHint: "Ví dụ sonnet hoặc haiku. Subagent không kế thừa model đắt của run chính.",
    cacheTtl: "Thời gian giữ cache",
    cacheTtlHint: "5 phút đủ khi các lượt cách nhau ngắn. Chọn 1 giờ nếu run hay chờ build, test dài hơn 5 phút.",
    cacheTtl5: "5 phút",
    cacheTtl1h: "1 giờ",
    compactWindow: "Cửa sổ ngữ cảnh tối đa",
    compactWindowHint:
      "Số token ngữ cảnh trước khi Claude Code nén. Phiên gần 1 triệu token bị đọc lại cả ngữ cảnh ở mỗi lượt nên rất tốn.",
    allowWeb: "Cho agent dùng web",
    allowWebHint: "Tắt thì run code không gọi được WebFetch, WebSearch (Claude Code) và web_search (Codex).",
    routingTitle: "Định tuyến model theo độ khó",
    routingHint:
      "Hub suy cấp độ của task (nhẹ, vừa, nặng) từ nhãn, loại task, cỡ kế hoạch và mô tả, rồi chọn model, effort và số lượt tối đa cho run code. Run thử lại sau lỗi lên một cấp. Run review, plan, brief giữ model theo loại run ở mục trên. Codex chỉ nhận effort; Gemini và Antigravity không bị ảnh hưởng.",
    routingOn: "Bật định tuyến",
    routingOnHint:
      "Tắt thì run code dùng model đã cấu hình (hoặc mặc định của CLI) như trước. Model cấu hình ở mục trên luôn thắng.",
    tierLight: "Task nhẹ",
    tierMedium: "Task vừa",
    tierHeavy: "Task nặng",
    tierModel: "Model Claude",
    tierEffort: "Effort",
    tierMaxTurns: "Số lượt tối đa",
    tierAdvisor: "Model cố vấn",
    tierAdvisorHint: "Để trống là tắt. Model chính chỉ hỏi cố vấn ở điểm quyết định; tắt khi máy đã tắt telemetry.",
    tierTurnsSuffix: "lượt",
    permTitle: "Quyền CLI của run",
    pWt: "Trong worktree (khuyên dùng)",
    pWtHint:
      "Agent sửa file và chạy lệnh build, test trong worktree của run; CLI giữ sandbox và chặn thao tác ngoài worktree.",
    pFull: "Toàn quyền",
    pFullHint:
      "Tắt sandbox và mọi bước hỏi duyệt của CLI. Chỉ dùng trong container dùng một lần hoặc máy riêng cho agent.",
    fullBanner: "Run của dự án này chạy với toàn quyền của tài khoản trên máy nhận việc.",
    fullLocked: "Chính sách agent của tổ chức không cho dự án bật toàn quyền; run chạy trong worktree.",
    machinesTitle: "Máy đã gắn dự án này",
    machinesHint:
      "Máy của đội đã gắn dự án với một repo local, và máy đã bật toàn quyền cho dự án (cài ở app desktop trên máy đó). Chỉ để xem.",
    machinesLoading: "Đang tải danh sách máy…",
    machinesFailed: (error) => `Không tải được danh sách máy: ${error}`,
    machinesEmpty: "Chưa máy nào gắn dự án này với repo local.",
    machineBound: "Đã gắn repo local",
    machineFull: "Toàn quyền",
    machineFullIdle: "Toàn quyền đang bị chính sách tổ chức chặn",
    machineStatus: { online: "Sẵn sàng", offline: "Mất kết nối", paused: "Tạm dừng", revoked: "Đã thu hồi" },
    unsavedChanges: (n) => `Có ${n} thay đổi chưa lưu`,
    savedBanner: "Đã lưu cấu hình. Run giao sau đây dùng cấu hình mới.",
    discard: "Bỏ thay đổi",
    save: "Lưu cấu hình",
    saving: "Đang lưu…",
    cfTitle: "Cho agent toàn quyền?",
    cfDesc:
      "CLI sẽ chạy không sandbox và không hỏi duyệt (Claude: bypassPermissions, Codex: bỏ sandbox, Gemini: yolo, Antigravity: --dangerously-skip-permissions).",
    cf1: "Agent đọc và sửa được mọi file tài khoản đó truy cập.",
    cf2: "Agent chạy được mọi lệnh, kể cả lệnh mạng.",
    cf3: "Lỗi của agent có thể làm hỏng máy nhận việc.",
    cfNote:
      "Chỉ bật khi run chạy trong container dùng một lần hoặc trên máy riêng cho agent, không chứa dữ liệu quan trọng.",
    cfKeep: "Giữ trong worktree",
    cfGo: "Bật toàn quyền",
    briefTitle: "Brief dự án",
    briefHint: "Bản tóm tắt repo đưa vào prompt của mọi run để agent khỏi đọc lại cả dự án.",
    briefAuto: "Tự cập nhật brief",
    briefAutoHint:
      "Hub tự giao run viết brief khi chưa có, khi nhánh chính đi xa, hoặc khi brief đã cũ. Tắt thì chỉ làm mới bằng tay.",
    briefCommits: "Làm mới sau số commit",
    briefCommitsHint: "Nhánh chính đi trước brief từng này commit thì làm mới.",
    briefDays: "Làm mới sau số ngày",
    briefDaysHint: "Brief cũ hơn từng này ngày thì làm mới khi có run mới.",
  },
  en: {
    title: "Project settings",
    projectsCrumb: "Projects",
    sectionsNav: "Sections",
    loading: "Loading…",
    notFound: (k) => `Project ${k} not found, or you are not in the owning team.`,
    backToProjects: "Back to projects",
    readOnlyBanner:
      "You are viewing in read-only mode. Only owning team admins or organization admins can edit settings.",
    mergeTitle: "Merge",
    mergeHint: "How agent PRs merge into the main branch.",
    modeLabel: "Mode",
    modeReview: "Requires a reviewer",
    modeReviewHint: "A person approves the PR before merge.",
    modeAuto: "Auto-merge when checks pass",
    modeAutoHint: "The hub merges once the result policy and CI (if required) pass.",
    reviewers: "Required reviewers",
    reviewersHint: "From 0 to 6.",
    method: "Merge method",
    mDefault: "Default (squash)",
    ciLabel: "Require green CI",
    ciHint: "When off, repos without CI can still merge.",
    queueLabel: "Merge queue",
    queueHint: "PRs queue up; the hub rebases each on main and merges them one by one.",
    reviewTitle: "Cross-review",
    reviewHint: "After an agent finishes, another agent reviews the change before the run concludes.",
    workflowReview: (name) => `Workflow ${name} replaces cross-review for runs matching its scope.`,
    workflowProtection:
      "Branch protection: require the xdev-hive/review status and set required approvals to 0. GitHub/GitLab approvals do not count towards checkpoints.",
    workflowCreate: "Create a workflow from this configuration",
    reviewOn: "Enable cross-review",
    reviewAgent: "Reviewing agent",
    minScore: "Minimum score",
    minScoreHint: "Scale of 0 to 10.",
    mustPass: "Must pass",
    mustPassHint: "When off, the review is advisory and never fails the run.",
    onlyWhen: "Only review when",
    linesFrom: "Changed lines from",
    linesSuffix: "lines",
    filesMatch: "Changed files match",
    globHint: "One glob path pattern per line.",
    onlyWhenHint: "Leave both empty to review every run. Fill both and either one triggers a review.",
    planTitle: "Plan mode",
    planHint: "The agent writes a plan; someone on the team approves it before the run starts.",
    sandboxTitle: "Sandbox",
    sandboxHint: "Code runs on the runner host, one gVisor container per run with no network except the allowlist.",
    sandboxLink: "Network allowlist and environment image",
    budgetTitle: "Budget",
    budgetHint:
      "Empty means no limit. Codex, Gemini and Antigravity do not report USD, so USD caps only apply to Claude.",
    perRun: "Per run",
    perTask: "Per task",
    perTaskHint: "Sum of every run of the task.",
    maxTurns: "Max turns",
    maxTurnsHint: "Agent turns within one run.",
    unlimited: "No limit",
    modelTitle: "Model",
    modelHint: "Leave empty to use the CLI default model.",
    cliDefault: "CLI default",
    writeCode: "Writing code",
    reviewCode: "Review",
    tokensTitle: "Token saving",
    tokensHint:
      "The worker sets these limits for the project's Claude Code runs. Codex, Gemini and Antigravity only get the CodeGraph item. A machine override or a project environment variable can replace each item.",
    tokensOn: "Turn on token saving",
    tokensOnHint: "When off, Claude Code runs use the CLI defaults, with no RTK compression and no CodeGraph.",
    rtk: "Compress command output with RTK",
    rtkHint: "Applies only when the machine running the run has rtk, and only for Claude Code.",
    codegraph: "Attach CodeGraph to the agent",
    codegraphHint:
      "Applies only when the machine has codegraph. The agent finds symbols and callers through codegraph_explore instead of grep.",
    bashChars: "Max command output",
    bashCharsHint:
      "Characters kept from one Bash command. Long output is re-read on every later turn, so it is costly.",
    compactPct: "Auto-compact when context is full",
    compactPctHint: "Context percentage that makes the agent compact. Lower compacts earlier and keeps context small.",
    subagent: "Subagent model",
    subagentHint: "For example sonnet or haiku. Subagents do not inherit the main run's expensive model.",
    cacheTtl: "Cache lifetime",
    cacheTtlHint:
      "5 minutes is enough when turns are close together. Pick 1 hour if runs often wait on builds or tests longer than 5 minutes.",
    cacheTtl5: "5 minutes",
    cacheTtl1h: "1 hour",
    compactWindow: "Max context window",
    compactWindowHint:
      "Context tokens before Claude Code compacts. A session near 1 million tokens re-reads all of it every turn, so it is costly.",
    allowWeb: "Let the agent use the web",
    allowWebHint: "When off, code runs cannot call WebFetch, WebSearch (Claude Code) or web_search (Codex).",
    routingTitle: "Route models by difficulty",
    routingHint:
      "The hub infers the task tier (light, medium, heavy) from labels, task type, plan size and description, then picks model, effort and max turns for code runs. A retry after a failure goes up one tier. Review, plan and brief runs keep the per-kind model above. Codex only gets effort; Gemini and Antigravity are unaffected.",
    routingOn: "Turn on routing",
    routingOnHint:
      "When off, code runs use the configured model (or the CLI default) as before. A model set in the section above always wins.",
    tierLight: "Light tasks",
    tierMedium: "Medium tasks",
    tierHeavy: "Heavy tasks",
    tierModel: "Claude model",
    tierEffort: "Effort",
    tierMaxTurns: "Max turns",
    tierAdvisor: "Advisor model",
    tierAdvisorHint:
      "Leave empty to turn off. The main model only asks the advisor at decision points; off when the machine disables telemetry.",
    tierTurnsSuffix: "turns",
    permTitle: "CLI permissions for runs",
    pWt: "Inside the worktree (recommended)",
    pWtHint:
      "The agent edits files and runs builds and tests in the run worktree; the CLI keeps its sandbox and blocks anything outside it.",
    pFull: "Full access",
    pFullHint:
      "Turns off the CLI sandbox and every approval prompt. Only for throwaway containers or machines dedicated to agents.",
    fullBanner: "Runs in this project use the full rights of the account on the machine that picks them up.",
    fullLocked: "The organization's agent policy does not let projects enable full access; runs stay in the worktree.",
    machinesTitle: "Machines linked to this project",
    machinesHint:
      "Team machines that linked this project to a local repository, and machines that turned on full access for it (set in the desktop app on that machine). Read only.",
    machinesLoading: "Loading machines…",
    machinesFailed: (error) => `Could not load machines: ${error}`,
    machinesEmpty: "No machine has linked this project to a local repository yet.",
    machineBound: "Local repo linked",
    machineFull: "Full access",
    machineFullIdle: "Full access is blocked by the organization policy",
    machineStatus: { online: "Ready", offline: "Offline", paused: "Paused", revoked: "Revoked" },
    unsavedChanges: (n) => `${n} unsaved changes`,
    savedBanner: "Settings saved. Subsequent runs will use the new settings.",
    discard: "Discard",
    save: "Save settings",
    saving: "Saving…",
    cfTitle: "Give agents full access?",
    cfDesc:
      "The CLI runs without a sandbox or approval prompts (Claude: bypassPermissions, Codex: no sandbox, Gemini: yolo, Antigravity: --dangerously-skip-permissions).",
    cf1: "The agent can read and change every file that account can reach.",
    cf2: "The agent can run any command, including network commands.",
    cf3: "An agent mistake can damage the machine.",
    cfNote: "Only turn this on for throwaway containers or agent-only machines with no important data.",
    cfKeep: "Keep in worktree",
    cfGo: "Enable full access",
    briefTitle: "Project brief",
    briefHint: "A summary of the repo that goes into every run's prompt so agents do not re-read the whole project.",
    briefAuto: "Update the brief automatically",
    briefAutoHint:
      "The hub queues a brief run when there is none, when the main branch moves on, or when the brief is stale. Off means refresh by hand only.",
    briefCommits: "Refresh after commits",
    briefCommitsHint: "Refresh once the main branch is this many commits ahead of the brief.",
    briefDays: "Refresh after days",
    briefDaysHint: "Refresh when a run starts and the brief is older than this.",
  },
};

/** /projects/$key/settings: merge, review chéo, plan mode, ngân sách, model, tiết kiệm token, quyền CLI của run. */
export function ProjectSettingsPage() {
  const me = useMe();
  const { org, api } = useOrg();
  const t = useT(text);
  const { key } = useParams({ from: "/session/app/in-org/projects/$key/settings" });
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const members = useQuery(api.orgMembers.list.queryOptions());
  const project = projects.data?.find((p) => p.key === key);
  const crumb = <Crumb project={project} projectKey={key} />;

  let body: ReactNode;
  if (projects.isPending || (members.isPending && org.role === "member")) {
    body = (
      <p aria-busy="true" className="text-muted-foreground">
        {t.loading}
      </p>
    );
  } else if (projects.isError || !project) {
    body = (
      <>
        <Alert variant="destructive">{projects.isError ? apiErrorMessage(projects.error) : t.notFound(key)}</Alert>
        <Link to="/projects" className="text-primary hover:text-primary/90">
          {t.backToProjects}
        </Link>
      </>
    );
  } else {
    const role = teamRoleLookup(org.role, members.data, me.id)(project.teamId);
    // Brief mở cho cả thành viên đội (hub cũng cho), còn cấu hình dự án chỉ quản trị đội.
    body = <SettingsEditor key={project.id} project={project} canEdit={role === "admin"} canBrief={role !== null} />;
  }

  return (
    <>
      <PageHeader crumb={crumb} title={t.title} />
      <PageBody>{body}</PageBody>
    </>
  );
}

function Crumb({ project, projectKey }: { project: Project | undefined; projectKey: string }) {
  const t = useT(text);
  return (
    <>
      <Link to="/projects" className="text-primary hover:text-primary/90">
        {t.projectsCrumb}
      </Link>{" "}
      /{" "}
      <Link to="/projects/$key" params={{ key: projectKey }} className="text-primary hover:text-primary/90">
        {project?.name ?? projectKey}
      </Link>
    </>
  );
}

function Section({ id, title, hint, children }: { id?: string; title?: string; hint?: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <Card id={id} className="grid gap-4 p-5 scroll-mt-20" role="group" aria-labelledby={title ? headingId : undefined}>
      {title && (
        <div className="grid gap-0.5">
          <h2 id={headingId} className="text-base font-semibold text-foreground">
            {title}
          </h2>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      )}
      {children}
    </Card>
  );
}

/** Máy của đội đã gắn dự án với repo local hay bật toàn quyền cho dự án (ADR 0020); chỉ đọc. */
function ProjectMachines({ project, fullLocked }: { project: Project; fullLocked: boolean }) {
  const { api } = useOrg();
  const t = useT(text);
  const machines = useQuery({
    ...api.machines.list.queryOptions({ input: { teamId: project.teamId } }),
    retry: false,
  });
  // Máy đã thu hồi không nhận run nữa, nên không đáng hiện ở đây.
  const linked = (machines.data ?? []).filter(
    (m) => m.status !== "revoked" && (m.boundProjects?.includes(project.id) || m.fullProjects?.includes(project.id)),
  );
  return (
    <Section id="machines" title={t.machinesTitle} hint={t.machinesHint}>
      {machines.isPending ? (
        <p aria-busy="true" className="text-sm text-muted-foreground">
          {t.machinesLoading}
        </p>
      ) : machines.isError ? (
        <Alert variant="destructive">{t.machinesFailed(apiErrorMessage(machines.error))}</Alert>
      ) : linked.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.machinesEmpty}</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {linked.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border px-3.5 py-2.5 text-sm"
            >
              <strong className="font-medium text-foreground">{m.name}</strong>
              <span className="text-xs text-muted-foreground">{m.os}</span>
              <Pill tone={m.status === "online" ? "ok" : m.status === "paused" ? "warn" : "neutral"}>
                {t.machineStatus[m.status]}
              </Pill>
              <span className="flex-1" />
              {m.boundProjects?.includes(project.id) && <Pill tone="sel">{t.machineBound}</Pill>}
              {m.fullProjects?.includes(project.id) && (
                <Pill tone={fullLocked ? "neutral" : "warn"} title={fullLocked ? t.machineFullIdle : undefined}>
                  {t.machineFull}
                </Pill>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="grid cursor-pointer gap-0.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
    </div>
  );
}

function TextField({
  label,
  hint,
  error,
  value,
  onChange,
  disabled,
  inputMode,
  placeholder,
  suffix,
}: {
  label: string;
  hint?: string;
  error: string | undefined;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  inputMode?: "decimal" | "numeric";
  placeholder?: string;
  suffix?: string;
}) {
  const id = useId();
  return (
    <Field invalid={error !== undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="relative flex items-center">
        <Input
          id={id}
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          inputMode={inputMode}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className={cx("font-mono text-sm", suffix && "pr-12")}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3 font-mono text-xs text-muted-foreground">{suffix}</span>
        )}
      </div>
      {error ? <FieldError>{error}</FieldError> : hint && <FieldHint>{hint}</FieldHint>}
    </Field>
  );
}

function SettingsEditor({ project, canEdit, canBrief }: { project: Project; canEdit: boolean; canBrief: boolean }) {
  const { org, api } = useOrg();
  const t = useT(text);
  const workflows = useQuery({ ...api.reviewWorkflows.list.queryOptions(), retry: false });
  const codeWorkflows = codeWorkflowsForProject(workflows.data ?? [], project);
  const can = usePermissions();
  const canCreateWorkflow = isOrgAdmin(org.role) || can("workflows.write");
  // Hub cũ chưa có chính sách thì coi như không khoá, như trước.
  const policy = useQuery({ ...api.policies.get.queryOptions(), retry: false });
  const fullLocked = policy.data?.allowFullPermission === false;
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState<ProjectSettings>(project.settings);
  const [form, setForm] = useState<SettingsForm>(() => formFromSettings(project.settings));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [confirmFull, setConfirmFull] = useState(false);
  const effortId = useId();
  const ids = {
    cacheTtl: useId(),
    method: useId(),
    reviewBy: useId(),
    paths: useId(),
    pathsHint: useId(),
    pathsError: useId(),
  };

  const save = useMutation({
    mutationFn: (patch: NonNullable<Extract<ReturnType<typeof buildPatch>, { ok: true }>["patch"]>) =>
      api.projects.updateSettings.call({ key: project.key, settings: patch }),
    onSuccess: async (next) => {
      setSaved(next);
      setForm(formFromSettings(next));
      setDone(true);
      await queryClient.invalidateQueries({ queryKey: api.projects.key() });
    },
    onError: (error) => {
      const r = saveErrors(error);
      setErrors(r.errors);
      setFailure(r.message ?? null);
    },
  });

  const disabled = !canEdit || save.isPending;
  const set = <K extends keyof SettingsForm>(k: K, v: SettingsForm[K]) => {
    setDone(false);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const setModel = (cli: (typeof SETTINGS_CLIS)[number], kind: "code" | "review", v: string) => {
    setDone(false);
    setForm((f) => ({ ...f, models: { ...f.models, [cli]: { ...f.models[cli], [kind]: v } } }));
  };
  const setTier = <K extends keyof TierForm>(tier: TaskTier, k: K, v: TierForm[K]) => {
    setDone(false);
    setForm((f) => ({ ...f, tiers: { ...f.tiers, [tier]: { ...f.tiers[tier], [k]: v } } }));
  };
  const built = buildPatch(form, saved);
  const dirty = !built.ok || built.patch !== null;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFailure(null);
    setDone(false);
    if (!built.ok) {
      setErrors(built.errors);
      setFailure(built.message ?? "Có ô chưa hợp lệ, xem chữ đỏ bên dưới từng ô.");
      return;
    }
    setErrors({});
    if (built.patch) save.mutate(built.patch);
  }

  function choosePermission(mode: PermissionMode) {
    if (mode === "full" && form.runPermissions !== "full") setConfirmFull(true);
    else set("runPermissions", mode);
  }

  const toc = [
    { href: "#merge", label: t.mergeTitle },
    { href: "#review", label: t.reviewTitle },
    { href: "#plan", label: t.planTitle },
    { href: "#sandbox", label: t.sandboxTitle },
    { href: "#brief", label: t.briefTitle },
    { href: "#budget", label: t.budgetTitle },
    { href: "#model", label: t.modelTitle },
    { href: "#tokens", label: t.tokensTitle },
    { href: "#perm", label: t.permTitle },
    ...(canEdit ? [{ href: "#machines", label: t.machinesTitle }] : []),
  ];

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-6">
      {!canEdit && (
        <p role="note" className="rounded-lg border border-border bg-muted px-3.5 py-2.5 text-sm text-foreground">
          {t.readOnlyBanner}
        </p>
      )}

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* TOC sidebar */}
        <nav aria-label={t.sectionsNav} className="sticky top-4 hidden w-48 shrink-0 flex-col gap-1 text-sm lg:flex">
          {toc.map((s) => (
            <a
              key={s.href}
              href={s.href}
              className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {s.label}
            </a>
          ))}
        </nav>

        {/* Content sections */}
        <div className="min-w-0 flex-1 grid gap-4">
          <Section id="merge" title={t.mergeTitle} hint={t.mergeHint}>
            <div role="radiogroup" aria-label={t.modeLabel} className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["review", t.modeReview, t.modeReviewHint],
                  ["auto", t.modeAuto, t.modeAutoHint],
                ] as const
              ).map(([value, label, hint]) => {
                const on = form.mergeMode === value;
                return (
                  <label
                    key={value}
                    className={cx(
                      "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors",
                      on ? "border-primary bg-accent/40" : "border-border hover:bg-muted/40",
                      disabled && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="radio"
                      name="mergeMode"
                      value={value}
                      checked={on}
                      onChange={() => set("mergeMode", value)}
                      disabled={disabled}
                      className="mt-0.5 size-4 accent-primary"
                    />
                    <span className="grid gap-0.5">
                      <strong className="font-medium text-foreground">{label}</strong>
                      <span className="text-xs text-muted-foreground">{hint}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t.reviewers}
                hint={t.reviewersHint}
                error={errors.requiredApprovals}
                value={form.requiredApprovals}
                onChange={(v) => set("requiredApprovals", v)}
                disabled={disabled}
                inputMode="numeric"
              />
              <Field invalid={errors.mergeMethod !== undefined}>
                <FieldLabel htmlFor={ids.method}>{t.method}</FieldLabel>
                <NativeSelect
                  id={ids.method}
                  value={form.mergeMethod}
                  onChange={(e) => set("mergeMethod", e.currentTarget.value as SettingsForm["mergeMethod"])}
                  disabled={disabled}
                >
                  <option value="">{t.mDefault}</option>
                  <option value="squash">Squash</option>
                  <option value="merge">Merge commit</option>
                  <option value="rebase">Rebase</option>
                </NativeSelect>
                {errors.mergeMethod && <FieldError>{errors.mergeMethod}</FieldError>}
              </Field>
            </div>
            <SwitchRow
              label={t.ciLabel}
              hint={t.ciHint}
              checked={form.requireCi}
              onChange={(v) => set("requireCi", v)}
              disabled={disabled}
            />
            <SwitchRow
              label={t.queueLabel}
              hint={t.queueHint}
              checked={form.mergeQueue}
              onChange={(v) => set("mergeQueue", v)}
              disabled={disabled}
            />
          </Section>

          <Section id="review" title={t.reviewTitle} hint={t.reviewHint}>
            {codeWorkflows.length > 0 && (
              <Alert>
                <div className="grid gap-2 break-words">
                  {codeWorkflows.map((workflow) => (
                    <Link
                      key={workflow.id}
                      to="/knowledge/workflows"
                      className="text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {t.workflowReview(workflow.name)}
                    </Link>
                  ))}
                  <p>{t.workflowProtection}</p>
                </div>
              </Alert>
            )}
            {canCreateWorkflow && (
              <Link
                to="/knowledge/workflows"
                search={{ duan: project.key }}
                className={cx(buttonVariants({ variant: "outline" }), "w-fit")}
              >
                {t.workflowCreate}
              </Link>
            )}
            <SwitchRow
              label={t.reviewOn}
              checked={form.crossReview}
              onChange={(v) => set("crossReview", v)}
              disabled={disabled}
            />
            {form.crossReview && (
              <div className="grid gap-4 border-l-2 border-border pl-3.5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field invalid={errors.reviewBy !== undefined}>
                    <FieldLabel htmlFor={ids.reviewBy}>{t.reviewAgent}</FieldLabel>
                    <NativeSelect
                      id={ids.reviewBy}
                      value={form.reviewBy}
                      onChange={(e) => set("reviewBy", e.currentTarget.value as SettingsForm["reviewBy"])}
                      disabled={disabled}
                    >
                      {REVIEW_CLIS.map((c) => (
                        <option key={c} value={c}>
                          {CLI_LABEL[c]}
                        </option>
                      ))}
                    </NativeSelect>
                    {errors.reviewBy && <FieldError>{errors.reviewBy}</FieldError>}
                  </Field>
                  <TextField
                    label={t.minScore}
                    hint={t.minScoreHint}
                    error={errors.reviewMinScore}
                    value={form.reviewMinScore}
                    onChange={(v) => set("reviewMinScore", v)}
                    disabled={disabled}
                    inputMode="decimal"
                  />
                </div>
                <SwitchRow
                  label={t.mustPass}
                  hint={t.mustPassHint}
                  checked={form.reviewRequired}
                  onChange={(v) => set("reviewRequired", v)}
                  disabled={disabled}
                />
                <fieldset className="grid gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[180px_minmax(0,1fr)]">
                  <legend className="px-1.5 text-xs font-medium text-foreground">{t.onlyWhen}</legend>
                  <TextField
                    label={t.linesFrom}
                    error={errors.reviewMinLines}
                    value={form.reviewMinLines}
                    onChange={(v) => set("reviewMinLines", v)}
                    disabled={disabled}
                    inputMode="numeric"
                    suffix={t.linesSuffix}
                  />
                  <div className="grid gap-1.5">
                    <label htmlFor={ids.paths} className="text-sm font-medium text-foreground">
                      {t.filesMatch}
                    </label>
                    <Textarea
                      id={ids.paths}
                      rows={3}
                      value={form.reviewPaths}
                      onChange={(e) => set("reviewPaths", e.currentTarget.value)}
                      disabled={disabled}
                      placeholder={"src/billing/**\ndb/migrations/**"}
                      spellCheck={false}
                      aria-invalid={errors.reviewPaths ? true : undefined}
                      aria-describedby={errors.reviewPaths ? ids.pathsError : ids.pathsHint}
                      className="font-mono text-xs"
                    />
                    {errors.reviewPaths ? (
                      <p id={ids.pathsError} className="text-xs text-destructive">
                        {errors.reviewPaths}
                      </p>
                    ) : (
                      <p id={ids.pathsHint} className="text-xs text-muted-foreground">
                        {t.globHint}
                      </p>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground sm:col-span-2">{t.onlyWhenHint}</span>
                </fieldset>
              </div>
            )}
          </Section>

          <Section id="plan">
            <SwitchRow
              label={t.planTitle}
              hint={t.planHint}
              checked={form.planMode}
              onChange={(v) => set("planMode", v)}
              disabled={disabled}
            />
          </Section>

          <Section id="sandbox">
            <SwitchRow
              label={t.sandboxTitle}
              hint={t.sandboxHint}
              checked={form.sandbox}
              onChange={(v) => set("sandbox", v)}
              disabled={disabled}
            />
            <p className="text-xs">
              <Link
                to="/projects/$key/sandbox"
                params={{ key: project.key }}
                className="text-primary hover:text-primary/90"
              >
                {t.sandboxLink} →
              </Link>
            </p>
          </Section>

          <Section id="brief" title={t.briefTitle} hint={t.briefHint}>
            <ProjectBriefCard project={project} canWrite={canBrief} />
            <SwitchRow
              label={t.briefAuto}
              hint={t.briefAutoHint}
              checked={form.briefAuto}
              onChange={(v) => set("briefAuto", v)}
              disabled={disabled}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t.briefCommits}
                hint={t.briefCommitsHint}
                error={errors.briefRefreshCommits}
                value={form.briefRefreshCommits}
                onChange={(v) => set("briefRefreshCommits", v)}
                disabled={disabled}
                inputMode="numeric"
              />
              <TextField
                label={t.briefDays}
                hint={t.briefDaysHint}
                error={errors.briefRefreshDays}
                value={form.briefRefreshDays}
                onChange={(v) => set("briefRefreshDays", v)}
                disabled={disabled}
                inputMode="numeric"
              />
            </div>
          </Section>

          <Section id="budget" title={t.budgetTitle} hint={t.budgetHint}>
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField
                label={t.perRun}
                error={errors.perRunUsd}
                value={form.perRunUsd}
                onChange={(v) => set("perRunUsd", v)}
                disabled={disabled}
                inputMode="decimal"
                placeholder={t.unlimited}
                suffix="USD"
              />
              <TextField
                label={t.perTask}
                hint={t.perTaskHint}
                error={errors.perTaskUsd}
                value={form.perTaskUsd}
                onChange={(v) => set("perTaskUsd", v)}
                disabled={disabled}
                inputMode="decimal"
                placeholder={t.unlimited}
                suffix="USD"
              />
              <TextField
                label={t.maxTurns}
                hint={t.maxTurnsHint}
                error={errors.maxTurns}
                value={form.maxTurns}
                onChange={(v) => set("maxTurns", v)}
                disabled={disabled}
                inputMode="numeric"
                placeholder={t.unlimited}
              />
            </div>
          </Section>

          <Section id="model" title={t.modelTitle} hint={t.modelHint}>
            <div className="grid gap-3 pt-1">
              {SETTINGS_CLIS.map((cli) => (
                <div key={cli} className="grid items-end gap-3 border-b border-border pb-3 sm:grid-cols-[80px_1fr_1fr]">
                  <strong className="pb-2 text-sm font-semibold text-foreground">{CLI_LABEL[cli]}</strong>
                  <TextField
                    label={`${t.writeCode} (${CLI_LABEL[cli]})`}
                    error={errors[`models.${cli}.code`]}
                    value={form.models[cli].code}
                    onChange={(v) => setModel(cli, "code", v)}
                    disabled={disabled}
                    placeholder={t.cliDefault}
                  />
                  <TextField
                    label={`${t.reviewCode} (${CLI_LABEL[cli]})`}
                    error={errors[`models.${cli}.review`]}
                    value={form.models[cli].review}
                    onChange={(v) => setModel(cli, "review", v)}
                    disabled={disabled}
                    placeholder={t.cliDefault}
                  />
                </div>
              ))}
            </div>
          </Section>

          <Section id="tokens" title={t.tokensTitle} hint={t.tokensHint}>
            <SwitchRow
              label={t.tokensOn}
              hint={t.tokensOnHint}
              checked={form.tokenSaving}
              onChange={(v) => set("tokenSaving", v)}
              disabled={disabled}
            />
            <SwitchRow
              label={t.rtk}
              hint={t.rtkHint}
              checked={form.rtk}
              onChange={(v) => set("rtk", v)}
              disabled={disabled || !form.tokenSaving}
            />
            <SwitchRow
              label={t.codegraph}
              hint={t.codegraphHint}
              checked={form.codegraph}
              onChange={(v) => set("codegraph", v)}
              disabled={disabled || !form.tokenSaving}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t.bashChars}
                hint={t.bashCharsHint}
                error={errors.bashMaxChars}
                value={form.bashMaxChars}
                onChange={(v) => set("bashMaxChars", v)}
                disabled={disabled || !form.tokenSaving}
                inputMode="numeric"
                suffix="ký tự"
              />
              <TextField
                label={t.compactPct}
                hint={t.compactPctHint}
                error={errors.autocompactPct}
                value={form.autocompactPct}
                onChange={(v) => set("autocompactPct", v)}
                disabled={disabled || !form.tokenSaving}
                inputMode="numeric"
                suffix="%"
              />
              <TextField
                label={t.subagent}
                hint={t.subagentHint}
                error={errors.subagentModel}
                value={form.subagentModel}
                onChange={(v) => set("subagentModel", v)}
                disabled={disabled || !form.tokenSaving}
              />
              <Field invalid={errors.cacheTtl !== undefined}>
                <FieldLabel htmlFor={ids.cacheTtl}>{t.cacheTtl}</FieldLabel>
                <NativeSelect
                  id={ids.cacheTtl}
                  value={form.cacheTtl}
                  onChange={(e) => set("cacheTtl", e.currentTarget.value as SettingsForm["cacheTtl"])}
                  disabled={disabled || !form.tokenSaving}
                >
                  <option value="5m">{t.cacheTtl5}</option>
                  <option value="1h">{t.cacheTtl1h}</option>
                </NativeSelect>
                {errors.cacheTtl ? <FieldError>{errors.cacheTtl}</FieldError> : <FieldHint>{t.cacheTtlHint}</FieldHint>}
              </Field>
              <TextField
                label={t.compactWindow}
                hint={t.compactWindowHint}
                error={errors.autocompactWindow}
                value={form.autocompactWindow}
                onChange={(v) => set("autocompactWindow", v)}
                disabled={disabled || !form.tokenSaving}
                inputMode="numeric"
                suffix="token"
              />
            </div>
            <SwitchRow
              label={t.allowWeb}
              hint={t.allowWebHint}
              checked={form.allowWeb}
              onChange={(v) => set("allowWeb", v)}
              disabled={disabled || !form.tokenSaving}
            />
          </Section>

          <Section id="routing" title={t.routingTitle} hint={t.routingHint}>
            <SwitchRow
              label={t.routingOn}
              hint={t.routingOnHint}
              checked={form.routing}
              onChange={(v) => set("routing", v)}
              disabled={disabled}
            />
            {TASK_TIERS.map((tier) => (
              <div key={tier} className="grid gap-3 sm:grid-cols-4">
                <strong className="text-sm font-semibold text-foreground sm:col-span-4">
                  {{ light: t.tierLight, medium: t.tierMedium, heavy: t.tierHeavy }[tier]}
                </strong>
                <TextField
                  label={t.tierModel}
                  error={errors[`tiers.${tier}.model`]}
                  value={form.tiers[tier].model}
                  onChange={(v) => setTier(tier, "model", v)}
                  disabled={disabled || !form.routing}
                />
                <Field invalid={errors[`tiers.${tier}.effort`] !== undefined}>
                  <FieldLabel htmlFor={`${effortId}-${tier}`}>{t.tierEffort}</FieldLabel>
                  <NativeSelect
                    id={`${effortId}-${tier}`}
                    value={form.tiers[tier].effort}
                    onChange={(e) => setTier(tier, "effort", e.currentTarget.value as TierForm["effort"])}
                    disabled={disabled || !form.routing}
                  >
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </NativeSelect>
                  {errors[`tiers.${tier}.effort`] && <FieldError>{errors[`tiers.${tier}.effort`]}</FieldError>}
                </Field>
                <TextField
                  label={t.tierMaxTurns}
                  error={errors[`tiers.${tier}.maxTurns`]}
                  value={form.tiers[tier].maxTurns}
                  onChange={(v) => setTier(tier, "maxTurns", v)}
                  disabled={disabled || !form.routing}
                  inputMode="numeric"
                  suffix={t.tierTurnsSuffix}
                />
                <TextField
                  label={t.tierAdvisor}
                  {...(tier === "medium" ? { hint: t.tierAdvisorHint } : {})}
                  error={errors[`tiers.${tier}.advisor`]}
                  value={form.tiers[tier].advisor}
                  onChange={(v) => setTier(tier, "advisor", v)}
                  disabled={disabled || !form.routing}
                />
              </div>
            ))}
          </Section>

          <Section id="perm" title={t.permTitle}>
            <div role="radiogroup" aria-label={t.permTitle} className="grid gap-2">
              <label
                className={cx(
                  "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors",
                  form.runPermissions === "workspace"
                    ? "border-primary bg-accent/40"
                    : "border-border hover:bg-muted/40",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  type="radio"
                  name="runPermissions"
                  value="workspace"
                  checked={form.runPermissions === "workspace"}
                  onChange={() => choosePermission("workspace")}
                  disabled={disabled}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span className="grid gap-0.5">
                  <strong className="font-medium text-foreground">{t.pWt}</strong>
                  <span className="text-xs text-muted-foreground">{t.pWtHint}</span>
                </span>
              </label>

              <label
                className={cx(
                  "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors",
                  form.runPermissions === "full"
                    ? "border-destructive bg-destructive-soft text-destructive"
                    : "border-border hover:bg-muted/40",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  type="radio"
                  name="runPermissions"
                  value="full"
                  checked={form.runPermissions === "full"}
                  onChange={() => choosePermission("full")}
                  disabled={disabled || (fullLocked && form.runPermissions !== "full")}
                  className="mt-0.5 size-4 accent-destructive"
                />
                <span className="grid gap-0.5">
                  <strong className={form.runPermissions === "full" ? "text-destructive" : "text-foreground"}>
                    {t.pFull}
                  </strong>
                  <span className="text-xs text-muted-foreground">{t.pFullHint}</span>
                </span>
              </label>
            </div>
            {fullLocked ? (
              <p className="flex items-start gap-2 rounded-lg bg-muted px-3.5 py-2.5 text-xs text-muted-foreground">
                <LockIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                {t.fullLocked}
              </p>
            ) : (
              form.runPermissions === "full" && (
                <p role="alert" className="rounded-lg bg-destructive-soft px-3.5 py-2.5 text-xs text-destructive">
                  {t.fullBanner}
                </p>
              )
            )}
            {errors.runPermissions && <p className="text-xs text-destructive">{errors.runPermissions}</p>}
          </Section>

          {/* Hub chỉ cho quản trị đội xem danh sách máy, nên thành viên thường không có mục này. */}
          {canEdit && <ProjectMachines project={project} fullLocked={fullLocked} />}
        </div>
      </div>

      {canEdit && (
        <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-background py-3">
          {dirty && <span className="mr-auto text-xs text-muted-foreground">{t.unsavedChanges(1)}</span>}
          {failure && (
            <Alert variant="destructive" className="mr-auto">
              {failure}
            </Alert>
          )}
          {done && !failure && (
            <p role="status" className="mr-auto text-xs text-success">
              {t.savedBanner}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setForm(formFromSettings(saved));
              setErrors({});
              setFailure(null);
            }}
            disabled={!dirty || save.isPending}
          >
            {t.discard}
          </Button>
          <Button type="submit" variant="default" disabled={!dirty || save.isPending}>
            {save.isPending ? t.saving : t.save}
          </Button>
        </div>
      )}

      <Dialog open={confirmFull} onOpenChange={setConfirmFull}>
        <DialogContent>
          <DialogTitle>{t.cfTitle}</DialogTitle>
          <DialogDescription>{t.cfDesc}</DialogDescription>
          <ul className="grid list-disc gap-1 pl-5 text-sm text-foreground">
            <li>{t.cf1}</li>
            <li>{t.cf2}</li>
            <li>{t.cf3}</li>
          </ul>
          <p className="text-xs text-muted-foreground">{t.cfNote}</p>
          <DialogActions>
            <Button variant="outline" onClick={() => setConfirmFull(false)}>
              {t.cfKeep}
            </Button>
            <Button
              variant="destructive-solid"
              onClick={() => {
                set("runPermissions", "full");
                setConfirmFull(false);
              }}
            >
              {t.cfGo}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </form>
  );
}
