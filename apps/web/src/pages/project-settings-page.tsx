import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { Machine, Project, ProjectSettings, ProjectSettingsPatch } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button, buttonVariants } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { LockIcon } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import {
  FormRow,
  RadioCards,
  type SectionSave,
  SettingsLayout,
  SettingsNav,
  SettingsSection,
  SwitchRow,
} from "@/components/page/settings.tsx";
import { UnitField } from "@/components/page/unit-field.tsx";
import { UnsavedChangesGuard } from "@/components/page/unsaved-guard.tsx";
import { ProjectBriefCard } from "@/components/project-brief-card.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { SectionsSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { usePermissions } from "@/lib/permissions.ts";
import {
  buildSectionPatch,
  codeWorkflowsForProject,
  type FieldErrors,
  formFromSettings,
  type PermissionMode,
  REVIEW_CLIS,
  SETTINGS_CLIS,
  SETTINGS_SECTION_IDS,
  type SettingsForm,
  type SettingsSectionId,
  saveErrors,
  sectionOfField,
  TASK_TIERS,
  type TaskTier,
  type TierForm,
  withSection,
} from "@/lib/project-settings.ts";
import { teamRoleLookup } from "@/lib/projects.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { CLI_LABEL } from "@/lib/run-view.ts";
import { ProjectDocsSettings } from "@/pages/project-docs-settings.tsx";
import { ProjectMembersSection } from "@/pages/project-members-section.tsx";
import { ProjectSdlcSections } from "@/pages/project-sdlc-settings.tsx";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  title: string;
  description: string;
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
  runTitle: string;
  runHint: string;
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
  contextPack: string;
  contextPackHint: string;
  exploreBudget: string;
  exploreBudgetHint: string;
  toolOutput: string;
  toolOutputHint: string;
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
  sdlcAutoTitle: string;
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
  savedBanner: string;
  invalid: string;
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
    description: "Cách agent làm việc trên dự án: merge, review, ngân sách, model, token và quyền trên máy.",
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
    runTitle: "Kế hoạch và sandbox",
    runHint: "Run có cần kế hoạch được duyệt trước không, và chạy ở đâu.",
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
    contextPack: "Dựng context pack trước run",
    contextPackHint:
      "Worker chọn sẵn các file liên quan tới task (đường dẫn, symbol nhắc tới, file hay đổi cùng) và đưa vào đầu run, để agent khỏi dò repo.",
    exploreBudget: "Ngân sách khảo sát",
    exploreBudgetHint:
      "Số lệnh dò cả repo (find, ls -R, grep -r…) agent được chạy trước lần sửa đầu; quá thì bị từ chối. 0 là tắt. Chỉ Claude Code.",
    toolOutput: "Cắt output tool dài",
    toolOutputHint:
      "Output dài hơn bị cắt, giữ đầu, cuối và dòng lỗi; bản đầy đủ lưu ra file cho agent đọc theo đoạn. 0 là tắt. Chỉ Claude Code.",
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
    sdlcAutoTitle: "Tự duyệt AI",
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
    savedBanner: "Đã lưu. Run giao sau đây dùng cấu hình mới.",
    invalid: "Có ô chưa hợp lệ, xem chữ đỏ bên dưới từng ô.",
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
    description: "How agents work on this project: merge, review, budget, models, tokens and machine permissions.",
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
    runTitle: "Plans and sandbox",
    runHint: "Whether runs need an approved plan first, and where they run.",
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
    contextPack: "Build a context pack before the run",
    contextPackHint:
      "The worker picks files related to the task (mentioned paths and symbols, files often changed together) and puts them at the start of the run, so the agent does not scan the repo.",
    exploreBudget: "Exploration budget",
    exploreBudgetHint:
      "How many repo-wide scans (find, ls -R, grep -r…) the agent may run before its first edit; more are refused. 0 turns it off. Claude Code only.",
    toolOutput: "Trim long tool output",
    toolOutputHint:
      "Longer output is trimmed to its start, end and error lines; the full text is saved to a file the agent can read in parts. 0 turns it off. Claude Code only.",
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
    sdlcAutoTitle: "AI auto-approval",
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
    savedBanner: "Saved. Subsequent runs will use the new settings.",
    invalid: "Some fields are invalid; see the red text under each field.",
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
    body = <SectionsSkeleton label={t.loading} />;
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
      <PageHeader crumb={crumb} title={t.title} description={t.description} width="form" />
      <PageBody width="form">{body}</PageBody>
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

/** Máy của đội đã gắn dự án với repo local hay bật toàn quyền cho dự án (ADR 0020); chỉ đọc nên không có nút Lưu. */
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
    <SettingsSection id="machines" title={t.machinesTitle} description={t.machinesHint}>
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
            <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
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
    </SettingsSection>
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
  // Kết quả lưu gần nhất của từng mục: hiện ở chân mục đó, không ở chỗ chung.
  const [results, setResults] = useState<Partial<Record<SettingsSectionId, { done?: true; failure?: string }>>>({});
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
    mutationFn: ({ patch }: { section: SettingsSectionId; patch: ProjectSettingsPatch }) =>
      api.projects.updateSettings.call({ key: project.key, settings: patch }),
    onSuccess: async (next, { section }) => {
      setSaved(next);
      // Chỉ mục vừa lưu lấy lại giá trị hub trả; mục khác giữ bản nháp đang sửa.
      setForm((f) => withSection(f, formFromSettings(next), section));
      setResults((r) => ({ ...r, [section]: { done: true } }));
      await queryClient.invalidateQueries({ queryKey: api.projects.key() });
    },
    onError: (error, { section }) => {
      const r = saveErrors(error);
      setErrors((e) => ({ ...clearSection(e, section), ...r.errors }));
      setResults((all) => ({ ...all, [section]: { failure: r.message ?? t.invalid } }));
    },
  });

  const disabled = !canEdit || save.isPending;
  const touch = (section: SettingsSectionId | undefined) => {
    if (section && results[section]?.done) setResults((r) => ({ ...r, [section]: {} }));
  };
  const set = <K extends keyof SettingsForm>(k: K, v: SettingsForm[K]) => {
    touch(sectionOfField(k));
    setForm((f) => ({ ...f, [k]: v }));
  };
  const setModel = (cli: (typeof SETTINGS_CLIS)[number], kind: "code" | "review", v: string) => {
    touch("model");
    setForm((f) => ({ ...f, models: { ...f.models, [cli]: { ...f.models[cli], [kind]: v } } }));
  };
  const setTier = <K extends keyof TierForm>(tier: TaskTier, k: K, v: TierForm[K]) => {
    touch("routing");
    setForm((f) => ({ ...f, tiers: { ...f.tiers, [tier]: { ...f.tiers[tier], [k]: v } } }));
  };
  const built = Object.fromEntries(
    SETTINGS_SECTION_IDS.map((id) => [id, buildSectionPatch(form, saved, id)]),
  ) as Record<SettingsSectionId, ReturnType<typeof buildSectionPatch>>;
  const isDirty = (id: SettingsSectionId) => !built[id].ok || built[id].patch !== null;
  const anyDirty = SETTINGS_SECTION_IDS.some(isDirty);

  /** Nút Lưu, Huỷ và trạng thái ở chân từng mục; người chỉ xem không có. */
  const sectionSave = (section: SettingsSectionId): SectionSave | undefined => {
    if (!canEdit) return undefined;
    const result = built[section];
    return {
      dirty: isDirty(section),
      saving: save.isPending && save.variables?.section === section,
      disabled: save.isPending,
      saved: results[section]?.done === true,
      error: results[section]?.failure,
      savedLabel: t.savedBanner,
      onSave: () => {
        if (!result.ok) {
          setErrors((e) => ({ ...clearSection(e, section), ...result.errors }));
          setResults((r) => ({ ...r, [section]: { failure: result.message ?? t.invalid } }));
          return;
        }
        setErrors((e) => clearSection(e, section));
        setResults((r) => ({ ...r, [section]: {} }));
        if (result.patch) save.mutate({ section, patch: result.patch });
      },
      onDiscard: () => {
        setForm((f) => withSection(f, formFromSettings(saved), section));
        setErrors((e) => clearSection(e, section));
        setResults((r) => ({ ...r, [section]: {} }));
      },
    };
  };

  function choosePermission(mode: PermissionMode) {
    if (mode === "full" && form.runPermissions !== "full") setConfirmFull(true);
    else set("runPermissions", mode);
  }

  const nav = useMemo(
    () => [
      { id: "merge", label: t.mergeTitle },
      { id: "review", label: t.reviewTitle },
      { id: "run", label: t.runTitle },
      { id: "brief", label: t.briefTitle },
      { id: "budget", label: t.budgetTitle },
      { id: "model", label: t.modelTitle },
      { id: "tokens", label: t.tokensTitle },
      { id: "routing", label: t.routingTitle },
      { id: "perm", label: t.permTitle },
      ...(canBrief ? [{ id: "members", label: "Thành viên dự án" }] : []),
      { id: "docs", label: "Tài liệu" },
      { id: "sdlc", label: "AI SDLC" },
      { id: "sdlc-auto", label: t.sdlcAutoTitle },
      ...(canEdit ? [{ id: "machines", label: t.machinesTitle }] : []),
    ],
    [t, canEdit, canBrief],
  );
  const tokenOff = disabled || !form.tokenSaving;
  const routingOff = disabled || !form.routing;

  return (
    <div className="grid gap-4">
      <UnsavedChangesGuard when={anyDirty} />
      {!canEdit && (
        <p role="note" className="rounded-lg border border-border bg-muted px-3.5 py-2.5 text-sm text-foreground">
          {t.readOnlyBanner}
        </p>
      )}

      <SettingsLayout nav={<SettingsNav label={t.sectionsNav} items={nav} />}>
        <SettingsSection id="merge" save={sectionSave("merge")} title={t.mergeTitle} description={t.mergeHint}>
          <RadioCards
            name="mergeMode"
            label={t.modeLabel}
            columns={2}
            value={form.mergeMode}
            onChange={(value) => set("mergeMode", value)}
            disabled={disabled}
            options={[
              { value: "review", title: t.modeReview, description: t.modeReviewHint },
              { value: "auto", title: t.modeAuto, description: t.modeAutoHint },
            ]}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <UnitField
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
        </SettingsSection>

        <SettingsSection
          id="review"
          save={sectionSave("review")}
          title={t.reviewTitle}
          description={t.reviewHint}
          actions={
            canCreateWorkflow && (
              <Link
                to="/knowledge/workflows"
                search={{ duan: project.key }}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                {t.workflowCreate}
              </Link>
            )
          }
        >
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
          <SwitchRow
            label={t.reviewOn}
            checked={form.crossReview}
            onChange={(v) => set("crossReview", v)}
            disabled={disabled}
          >
            {form.crossReview && (
              <>
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
                  <UnitField
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
                <fieldset className="grid min-w-0 gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[180px_minmax(0,1fr)]">
                  <legend className="px-1.5 text-xs font-medium text-foreground">{t.onlyWhen}</legend>
                  <UnitField
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
              </>
            )}
          </SwitchRow>
        </SettingsSection>

        <SettingsSection id="run" save={sectionSave("run")} title={t.runTitle} description={t.runHint}>
          <SwitchRow
            label={t.planTitle}
            hint={t.planHint}
            checked={form.planMode}
            onChange={(v) => set("planMode", v)}
            disabled={disabled}
          />
          <SwitchRow
            label={t.sandboxTitle}
            hint={
              <>
                {t.sandboxHint}{" "}
                <Link
                  to="/projects/$key/sandbox"
                  params={{ key: project.key }}
                  className="text-primary hover:text-primary/90"
                >
                  {t.sandboxLink} →
                </Link>
              </>
            }
            checked={form.sandbox}
            onChange={(v) => set("sandbox", v)}
            disabled={disabled}
          />
        </SettingsSection>

        <SettingsSection id="brief" save={sectionSave("brief")} title={t.briefTitle} description={t.briefHint}>
          <ProjectBriefCard project={project} canWrite={canBrief} />
          <SwitchRow
            label={t.briefAuto}
            hint={t.briefAutoHint}
            checked={form.briefAuto}
            onChange={(v) => set("briefAuto", v)}
            disabled={disabled}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <UnitField
              label={t.briefCommits}
              hint={t.briefCommitsHint}
              error={errors.briefRefreshCommits}
              value={form.briefRefreshCommits}
              onChange={(v) => set("briefRefreshCommits", v)}
              disabled={disabled}
              inputMode="numeric"
            />
            <UnitField
              label={t.briefDays}
              hint={t.briefDaysHint}
              error={errors.briefRefreshDays}
              value={form.briefRefreshDays}
              onChange={(v) => set("briefRefreshDays", v)}
              disabled={disabled}
              inputMode="numeric"
            />
          </div>
        </SettingsSection>

        <SettingsSection id="budget" save={sectionSave("budget")} title={t.budgetTitle} description={t.budgetHint}>
          <div className="grid gap-4 sm:grid-cols-3">
            <UnitField
              label={t.perRun}
              error={errors.perRunUsd}
              value={form.perRunUsd}
              onChange={(v) => set("perRunUsd", v)}
              disabled={disabled}
              inputMode="decimal"
              placeholder={t.unlimited}
              suffix="USD"
            />
            <UnitField
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
            <UnitField
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
        </SettingsSection>

        <SettingsSection id="model" save={sectionSave("model")} title={t.modelTitle} description={t.modelHint}>
          {SETTINGS_CLIS.map((cli) => (
            <FormRow key={cli} label={CLI_LABEL[cli] ?? cli}>
              <div className="grid gap-3 sm:grid-cols-2">
                <UnitField
                  label={`${t.writeCode} (${CLI_LABEL[cli]})`}
                  error={errors[`models.${cli}.code`]}
                  value={form.models[cli].code}
                  onChange={(v) => setModel(cli, "code", v)}
                  disabled={disabled}
                  placeholder={t.cliDefault}
                />
                <UnitField
                  label={`${t.reviewCode} (${CLI_LABEL[cli]})`}
                  error={errors[`models.${cli}.review`]}
                  value={form.models[cli].review}
                  onChange={(v) => setModel(cli, "review", v)}
                  disabled={disabled}
                  placeholder={t.cliDefault}
                />
              </div>
            </FormRow>
          ))}
        </SettingsSection>

        <SettingsSection id="tokens" save={sectionSave("tokens")} title={t.tokensTitle} description={t.tokensHint}>
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
            disabled={tokenOff}
          />
          <SwitchRow
            label={t.codegraph}
            hint={t.codegraphHint}
            checked={form.codegraph}
            onChange={(v) => set("codegraph", v)}
            disabled={tokenOff}
          />
          <SwitchRow
            label={t.contextPack}
            hint={t.contextPackHint}
            checked={form.contextPack}
            onChange={(v) => set("contextPack", v)}
            disabled={tokenOff}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <UnitField
              label={t.exploreBudget}
              hint={t.exploreBudgetHint}
              error={errors.exploreBudget}
              value={form.exploreBudget}
              onChange={(v) => set("exploreBudget", v)}
              disabled={tokenOff}
              inputMode="numeric"
              suffix="lệnh"
            />
            <UnitField
              label={t.toolOutput}
              hint={t.toolOutputHint}
              error={errors.toolOutputMaxChars}
              value={form.toolOutputMaxChars}
              onChange={(v) => set("toolOutputMaxChars", v)}
              disabled={tokenOff}
              inputMode="numeric"
              suffix="ký tự"
            />
            <UnitField
              label={t.bashChars}
              hint={t.bashCharsHint}
              error={errors.bashMaxChars}
              value={form.bashMaxChars}
              onChange={(v) => set("bashMaxChars", v)}
              disabled={tokenOff}
              inputMode="numeric"
              suffix="ký tự"
            />
            <UnitField
              label={t.compactPct}
              hint={t.compactPctHint}
              error={errors.autocompactPct}
              value={form.autocompactPct}
              onChange={(v) => set("autocompactPct", v)}
              disabled={tokenOff}
              inputMode="numeric"
              suffix="%"
            />
            <UnitField
              label={t.subagent}
              hint={t.subagentHint}
              error={errors.subagentModel}
              value={form.subagentModel}
              onChange={(v) => set("subagentModel", v)}
              disabled={tokenOff}
            />
            <Field invalid={errors.cacheTtl !== undefined}>
              <FieldLabel htmlFor={ids.cacheTtl}>{t.cacheTtl}</FieldLabel>
              <NativeSelect
                id={ids.cacheTtl}
                value={form.cacheTtl}
                onChange={(e) => set("cacheTtl", e.currentTarget.value as SettingsForm["cacheTtl"])}
                disabled={tokenOff}
              >
                <option value="5m">{t.cacheTtl5}</option>
                <option value="1h">{t.cacheTtl1h}</option>
              </NativeSelect>
              {errors.cacheTtl ? <FieldError>{errors.cacheTtl}</FieldError> : <FieldHint>{t.cacheTtlHint}</FieldHint>}
            </Field>
            <UnitField
              label={t.compactWindow}
              hint={t.compactWindowHint}
              error={errors.autocompactWindow}
              value={form.autocompactWindow}
              onChange={(v) => set("autocompactWindow", v)}
              disabled={tokenOff}
              inputMode="numeric"
              suffix="token"
            />
          </div>
          <SwitchRow
            label={t.allowWeb}
            hint={t.allowWebHint}
            checked={form.allowWeb}
            onChange={(v) => set("allowWeb", v)}
            disabled={tokenOff}
          />
        </SettingsSection>

        <SettingsSection id="routing" save={sectionSave("routing")} title={t.routingTitle} description={t.routingHint}>
          <SwitchRow
            label={t.routingOn}
            hint={t.routingOnHint}
            checked={form.routing}
            onChange={(v) => set("routing", v)}
            disabled={disabled}
          />
          {TASK_TIERS.map((tier) => (
            <FormRow key={tier} label={{ light: t.tierLight, medium: t.tierMedium, heavy: t.tierHeavy }[tier]}>
              <div className="grid gap-3 sm:grid-cols-2">
                <UnitField
                  label={t.tierModel}
                  error={errors[`tiers.${tier}.model`]}
                  value={form.tiers[tier].model}
                  onChange={(v) => setTier(tier, "model", v)}
                  disabled={routingOff}
                />
                <Field invalid={errors[`tiers.${tier}.effort`] !== undefined}>
                  <FieldLabel htmlFor={`${effortId}-${tier}`}>{t.tierEffort}</FieldLabel>
                  <NativeSelect
                    id={`${effortId}-${tier}`}
                    value={form.tiers[tier].effort}
                    onChange={(e) => setTier(tier, "effort", e.currentTarget.value as TierForm["effort"])}
                    disabled={routingOff}
                  >
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </NativeSelect>
                  {errors[`tiers.${tier}.effort`] && <FieldError>{errors[`tiers.${tier}.effort`]}</FieldError>}
                </Field>
                <UnitField
                  label={t.tierMaxTurns}
                  error={errors[`tiers.${tier}.maxTurns`]}
                  value={form.tiers[tier].maxTurns}
                  onChange={(v) => setTier(tier, "maxTurns", v)}
                  disabled={routingOff}
                  inputMode="numeric"
                  suffix={t.tierTurnsSuffix}
                />
                <UnitField
                  label={t.tierAdvisor}
                  {...(tier === "medium" ? { hint: t.tierAdvisorHint } : {})}
                  error={errors[`tiers.${tier}.advisor`]}
                  value={form.tiers[tier].advisor}
                  onChange={(v) => setTier(tier, "advisor", v)}
                  disabled={routingOff}
                />
              </div>
            </FormRow>
          ))}
        </SettingsSection>

        <SettingsSection id="perm" save={sectionSave("perm")} title={t.permTitle}>
          <RadioCards
            name="runPermissions"
            label={t.permTitle}
            value={form.runPermissions}
            onChange={choosePermission}
            disabled={disabled}
            options={[
              { value: "workspace", title: t.pWt, description: t.pWtHint },
              {
                value: "full",
                title: t.pFull,
                description: t.pFullHint,
                tone: "destructive",
                disabled: fullLocked && form.runPermissions !== "full",
              },
            ]}
          />
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
        </SettingsSection>

        {/* Ai đọc được dự án cũng xem được danh sách; chỉ quản trị đội hay người có quyền sửa cấu hình mới đổi. */}
        {canBrief && <ProjectMembersSection project={project} canManage={canEdit || can("projects.settings")} />}

        <ProjectDocsSettings project={project} canEdit={canEdit} />
        <ProjectSdlcSections project={project} canEdit={canEdit} orgPolicy={policy.data?.sdlc} />

        {/* Hub chỉ cho quản trị đội xem danh sách máy, nên thành viên thường không có mục này. */}
        {canEdit && <ProjectMachines project={project} fullLocked={fullLocked} />}
      </SettingsLayout>

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
    </div>
  );
}

/** Bỏ lỗi ô của một mục trước khi kiểm hay lưu lại mục đó. */
function clearSection(errors: FieldErrors, section: SettingsSectionId): FieldErrors {
  return Object.fromEntries(Object.entries(errors).filter(([field]) => sectionOfField(field) !== section));
}
