import { Tabs } from "@base-ui/react/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AgentPolicy,
  type AgentPolicyInput,
  DEFAULT_AGENT_GIT_POLICY,
  DEFAULT_AGENT_MEMORY_POLICY,
  DEFAULT_AGENT_REMOTE_POLICY,
  DEFAULT_AGENT_SKILL_LEARNING_POLICY,
  DEFAULT_ORG_SDLC_POLICY,
  DEFAULT_SDLC_DENY_KEYWORDS,
  DEFAULT_SDLC_DENY_PATHS,
  type HookEvent,
  type InstructionTemplates,
  type OrgSdlcPolicy,
  type PolicyHook,
  type TemplatePreview,
} from "@xdev-hive/contracts";
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
import { Textarea } from "@xdev-hive/ui/textarea";
import { LockIcon, PlusIcon, XIcon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { ChipInput } from "@/components/page/chip-input.tsx";
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
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { LoadFailure, LoadingState, SectionsSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { usePermissions } from "@/lib/permissions.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { SdlcPolicyStats } from "@/pages/admin/policies-sdlc-stats.tsx";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

type Cli = keyof AgentPolicyInput["allowedModels"];
type TemplateKey = keyof InstructionTemplates;
type Form = Omit<AgentPolicy, "updatedAt" | "updatedBy" | "templateSync" | "defaultTemplates" | "sdlc"> & {
  sdlc: OrgSdlcPolicy;
};

const CLIS: { id: Cli; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "antigravity", name: "Antigravity" },
];
const TEMPLATE_FILES: { id: TemplateKey; path: string }[] = [
  { id: "agents", path: "AGENTS.md" },
  { id: "claude", path: "CLAUDE.md" },
  { id: "mcp", path: ".mcp.json" },
];
const EVENTS: HookEvent[] = ["PreToolUse", "PostToolUse", "Stop"];

/**
 * Ô của từng mục: lưu một mục chỉ thay các ô này trên bản hub đang giữ, nên chỗ đang sửa dở ở mục khác không bị gửi
 * theo (admin-layout.md § Decisions 4). Hub nhận cả chính sách trong một lần gọi nên trang tự ghép.
 */
const SECTIONS = {
  model: ["allowedModels", "neverAutoUpgrade"],
  perm: ["defaultPermissionMode", "allowFullPermission", "requireSandbox"],
  memory: ["agentMemory"],
  learning: ["skillLearning"],
  hooks: ["hooks", "managedHooksOnly"],
  templates: ["templates", "autoSyncTemplates"],
  limits: ["limits"],
  sdlc: ["sdlc"],
} as const satisfies Record<string, readonly (keyof Form)[]>;
type SectionId = keyof typeof SECTIONS;
const SECTION_IDS = Object.keys(SECTIONS) as SectionId[];

const text: Dict<{
  title: string;
  lead: string;
  preview: string;
  sectionsNav: string;
  readOnly: string;
  savedSection: string;
  modelHint: string;
  anyModel: string;
  remove: (name: string) => string;
  add: string;
  addModel: (cli: string) => string;
  neverAuto: string;
  neverAutoHint: string;
  perm: string;
  permHint: string;
  defaultPerm: string;
  defaultPermHint: string;
  wt: string;
  wtHint: string;
  full: string;
  fullHint: string;
  fullOff: string;
  allowFull: string;
  allowFullHint: string;
  ownerOnly: string;
  sandboxReq: string;
  sandboxReqHint: string;
  cfTitle: string;
  cfDesc: string;
  cf1: string;
  cf2: string;
  cfKeep: string;
  cfGo: string;
  memTitle: string;
  memHint: string;
  memMode: string;
  memOff: string;
  memPropose: string;
  memDirect: string;
  memModeHint: Record<Form["agentMemory"]["mode"], string>;
  memMax: string;
  memMaxHint: string;
  memMaxOff: string;
  learnTitle: string;
  learnHint: string;
  learnEnabled: string;
  learnEnabledHint: string;
  learnMax: string;
  learnMaxHint: string;
  outOfRange: string;
  sdlcHint: string;
  sdlcAllow: string;
  sdlcAllowHint: string;
  sdlcOnBadge: string;
  sdlcOffBadge: string;
  sdlcOffNote: string;
  sdlcOffNoteHint: string;
  sdlcFloor: string;
  sdlcFloorHint: string;
  sdlcFloorRange: string;
  sdlcAlways: string;
  sdlcAlwaysHint: string;
  sdlcAlwaysList: string[];
  sdlcKeywords: string;
  sdlcKeywordsHint: string;
  sdlcPaths: string;
  sdlcPathsHint: string;
  sdlcAdd: string;
  sdlcReset: string;
  hooksHint: string;
  managedOnly: string;
  managedOnlyHint: string;
  hookList: string;
  hookListHint: string;
  noHooks: string;
  edit: string;
  editHook: (name: string) => string;
  addHook: string;
  hookTitle: string;
  hookDesc: string;
  hookEvent: string;
  hookName: string;
  hookCommand: string;
  hookMatcher: string;
  hookMatcherHint: string;
  eventHint: Record<HookEvent, string>;
  hookRemove: string;
  done: string;
  cancel: string;
  instr: string;
  instrHint: string;
  files: string;
  standard: string;
  custom: string;
  restore: string;
  variables: string;
  keepSync: string;
  keepSyncHint: string;
  syncNow: string;
  syncHint: string;
  syncDirty: string;
  syncQueued: string;
  noSync: string;
  lastSync: (opened: number, unchanged: number, failed: number, at: string) => string;
  limits: string;
  limitsHint: string;
  runBudget: string;
  dayBudget: string;
  parallel: string;
  parallelUnit: string;
  retention: string;
  days: string;
  unlimited: string;
  usd: string;
  previewTitle: string;
  previewDesc: string;
  project: string;
  projectPlaceholder: string;
  show: string;
  close: string;
}> = {
  vi: {
    title: "Chính sách agent",
    lead: "Áp cho mọi run trong tổ chức. Hub ghi vào managed settings của CLI trên máy nhận việc; dự án không vượt được.",
    preview: "Xem file sinh ra",
    sectionsNav: "Các mục chính sách",
    readOnly:
      "Bạn chỉ xem được chính sách. Cần quyền “Sửa chính sách agent” (mặc định là quản trị tổ chức) để thay đổi.",
    savedSection: "Đã lưu. Run giao sau đây dùng chính sách mới.",
    modelHint: "Model mà dự án được chọn. Dự án chọn model ngoài danh sách thì run dùng model đầu tiên.",
    anyModel: "Mọi model",
    remove: (name) => `Gỡ ${name}`,
    add: "Thêm",
    addModel: (cli) => `Model cho ${cli}`,
    neverAuto: "Không tự lên model đắt nhất",
    neverAutoHint: "Run không chỉ định model thì dùng model đầu danh sách, không để CLI tự chọn fast, max hay Fable.",
    perm: "Quyền CLI",
    permHint: "Mặc định cho dự án mới và giới hạn trên cho mọi dự án.",
    defaultPerm: "Mặc định cho dự án mới",
    defaultPermHint: "Dự án đã có giữ cấu hình của mình.",
    wt: "Trong worktree (khuyên dùng)",
    wtHint: "CLI chỉ sửa file trong worktree của run và hỏi trước lệnh rủi ro.",
    full: "Toàn quyền",
    fullHint: "CLI chạy không sandbox, không hỏi duyệt.",
    fullOff: "Đang khoá vì dự án không được bật toàn quyền.",
    allowFull: "Cho dự án bật toàn quyền",
    allowFullHint: "Tắt thì nút Toàn quyền trong cấu hình dự án bị khoá; run của dự án đang bật chạy trong worktree.",
    ownerOnly: "Mở lại cần quyền “Cho phép CLI toàn quyền” (mặc định chỉ owner).",
    sandboxReq: "Bắt buộc sandbox",
    sandboxReqHint: "Mọi run code phải chạy trong container gVisor trên runner host.",
    cfTitle: "Để dự án mới chạy toàn quyền?",
    cfDesc: "Dự án tạo sau khi lưu sẽ cho CLI chạy không sandbox và không hỏi duyệt, đến khi quản trị đội đổi lại.",
    cf1: "Agent đọc, sửa được mọi file mà tài khoản trên máy nhận việc truy cập được.",
    cf2: "Agent chạy được mọi lệnh, kể cả lệnh mạng.",
    cfKeep: "Giữ trong worktree",
    cfGo: "Chọn toàn quyền",
    memTitle: "Memory do agent ghi",
    memHint: "Agent chạy code và review ghi lại điều đã học cho các run sau qua memory_write.",
    memMode: "Chế độ ghi",
    memOff: "Tắt",
    memPropose: "Đề xuất chờ duyệt",
    memDirect: "Ghi thẳng",
    memModeHint: {
      off: "Agent không ghi được memory.",
      propose: "Memory vào hàng chờ ở trang Memory; chỉ hiện cho agent sau khi thành viên đội duyệt.",
      direct: "Memory có hiệu lực ngay, không qua duyệt.",
    },
    memMax: "Số memory tối đa mỗi run",
    memMaxHint: "Từ 1 đến 50. Hub từ chối ghi vượt số này.",
    memMaxOff: "Bật chế độ ghi để đặt số này.",
    learnTitle: "Học skill từ việc khó",
    learnHint:
      "Mỗi ngày mỗi dự án một lô: agent đọc tóm tắt các run đáng học (thử lại ≥ 2 lần, chi phí vượt p90, hoặc được đánh dấu) rồi đề xuất skill. Chạy bằng model rẻ, chỉ đọc.",
    learnEnabled: "Bật học skill",
    learnEnabledHint: "Tắt thì không lô nào chạy và không tốn token. Đề xuất đã có vẫn duyệt được.",
    learnMax: "Số đề xuất tối đa mỗi ngày",
    learnMaxHint: "Từ 1 đến 50 cho cả tổ chức (UTC). Hết hạn mức thì ngày đó không chạy thêm lô.",
    outOfRange: "Nhập số nguyên từ 1 đến 50. Ô giữ số hợp lệ gần nhất cho tới khi sửa xong.",
    sdlcHint:
      'Tự duyệt AI ở giai đoạn rủi ro thấp ("Continue automatically" của AI-DLC). Chế độ nói giai đoạn nào được tự duyệt; dự án chỉ siết thêm được so với chế độ và mục này.',
    sdlcAllow: "Cho phép tự duyệt",
    sdlcAllowHint: "Tắt thì hub không tự duyệt cổng nào của tổ chức. Tự duyệt đã ghi vẫn thu hồi được tới hết hạn.",
    sdlcOnBadge: "Đang cho phép",
    sdlcOffBadge: "Đã tắt",
    sdlcOffNote: "Đã tắt tự duyệt cho toàn tổ chức.",
    sdlcOffNoteHint: "Dự án đang bật tự duyệt sẽ chờ người duyệt từ cổng kế tiếp.",
    sdlcFloor: "Sàn ngưỡng điểm",
    sdlcFloorHint: "Ngưỡng hiệu lực là mức cao nhất trong chế độ, dự án và sàn này. Thang 0 đến 10.",
    sdlcFloorRange: "Nhập số từ 0 đến 10. Ô giữ số hợp lệ gần nhất cho tới khi sửa xong.",
    sdlcAlways: "Luôn cần người duyệt",
    sdlcAlwaysHint: "Cố định, không tắt được ở bất kỳ lớp nào.",
    sdlcAlwaysList: [
      "Giai đoạn Yêu cầu của chế độ nặng (cỡ L, XL) hoặc hạng mục cỡ L, XL",
      "Thay đổi chạm từ khoá hoặc đường dẫn nhạy cảm",
      "Contract liên repo",
    ],
    sdlcKeywords: "Từ khoá nhạy cảm",
    sdlcKeywordsHint: "Không phân biệt hoa thường và dấu. So với phần thay đổi của tài liệu.",
    sdlcPaths: "Đường dẫn nhạy cảm",
    sdlcPathsHint: "Mẫu glob, so với mọi đường dẫn file nêu trong tài liệu và danh sách file của task.",
    sdlcAdd: "Thêm",
    sdlcReset: "Đặt lại danh sách mặc định",
    hooksHint: "Lệnh chạy chắc chắn ở các mốc của CLI: trước khi gọi tool, sau khi sửa file, khi kết thúc.",
    managedOnly: "Chỉ chạy hook của tổ chức",
    managedOnlyHint: "Bỏ qua hook và cấu hình .claude/settings.json trong repo.",
    hookList: "Hook của tổ chức",
    hookListHint: "Chạy theo thứ tự trong danh sách.",
    noHooks: "Chưa có hook nào. Thêm hook để chạy test hay chặn lệnh nguy hiểm ở mọi run.",
    edit: "Sửa",
    editHook: (name) => `Sửa hook ${name}`,
    addHook: "Thêm hook",
    hookTitle: "Hook của tổ chức",
    hookDesc: "Worker chạy lệnh này trong worktree của run. Hook Stop lỗi thì run lỗi và không push.",
    hookEvent: "Mốc",
    hookName: "Tên",
    hookCommand: "Lệnh",
    hookMatcher: "Tool cần khớp",
    hookMatcherHint: "Cú pháp matcher của Claude Code, ví dụ Bash hoặc Edit|Write. Bỏ trống là mọi tool.",
    eventHint: {
      PreToolUse: "Trước mỗi lần gọi tool. Chỉ Claude Code chạy được.",
      PostToolUse: "Sau mỗi lần gọi tool. Chỉ Claude Code chạy được.",
      Stop: "Khi agent xong, trước khi worker push. Chạy với mọi CLI.",
    },
    hookRemove: "Xoá hook",
    done: "Xong",
    cancel: "Huỷ",
    instr: "File hướng dẫn agent",
    instrHint: "Mẫu hub commit vào repo khi tạo dự án.",
    files: "File mẫu",
    standard: "Mẫu chuẩn",
    custom: "Đã sửa",
    restore: "Dùng mẫu chuẩn",
    variables: "Biến: {{project.name}}, {{project.key}}, {{project.branch}}, {{system.name}}, {{mcp.url}}",
    keepSync: "Mở PR khi mẫu đổi",
    keepSyncHint: "Hub mở PR cập nhật file hướng dẫn cho mọi dự án đang hoạt động.",
    syncNow: "Mở PR ngay",
    syncHint: "Mở PR cập nhật file hướng dẫn theo mẫu đã lưu cho mọi dự án đang hoạt động.",
    syncDirty: "Lưu mục này trước khi mở PR.",
    syncQueued: "Đã xếp việc mở PR cho các dự án.",
    noSync: "Chưa mở PR cập nhật lần nào.",
    lastSync: (opened, unchanged, failed, at) =>
      `Lần gần nhất (${at}): mở ${opened} PR, ${unchanged} dự án đã đúng mẫu${failed ? `, ${failed} lỗi` : ""}.`,
    limits: "Giới hạn chung",
    limitsHint: "Trần cho mọi dự án; dự án đặt thấp hơn được, cao hơn thì không.",
    runBudget: "Trần mỗi run",
    dayBudget: "Trần mỗi ngày của tổ chức",
    parallel: "Run song song mỗi máy",
    parallelUnit: "run",
    retention: "Giữ log run",
    days: "ngày",
    unlimited: "Không giới hạn",
    usd: "USD",
    previewTitle: "File sinh ra từ mẫu",
    previewDesc: "Điền biến của một dự án vào mẫu đang sửa (chưa cần lưu).",
    project: "Dự án",
    projectPlaceholder: "project key, bỏ trống là dự án mẫu",
    show: "Xem",
    close: "Đóng",
  },
  en: {
    title: "Agent policies",
    lead: "Applies to every run in the organization. The hub writes it to the CLI managed settings on run machines; projects cannot override it.",
    preview: "Preview generated files",
    sectionsNav: "Policy sections",
    readOnly:
      "You can only view the policy. Editing needs the “Edit agent policies” permission (organization admins by default).",
    savedSection: "Saved. Runs dispatched from now on use the new policy.",
    modelHint: "Models projects may pick. Anything else falls back to the first model.",
    anyModel: "Any model",
    remove: (name) => `Remove ${name}`,
    add: "Add",
    addModel: (cli) => `Model for ${cli}`,
    neverAuto: "Never auto-upgrade to the priciest model",
    neverAutoHint:
      "Runs without a model use the first model in the list instead of letting the CLI pick fast, max or Fable.",
    perm: "CLI permissions",
    permHint: "Default for new projects and the upper bound for all.",
    defaultPerm: "Default for new projects",
    defaultPermHint: "Existing projects keep their own setting.",
    wt: "Inside the worktree (recommended)",
    wtHint: "The CLI only edits files in the run's worktree and asks before risky commands.",
    full: "Full access",
    fullHint: "The CLI runs without a sandbox or approval prompts.",
    fullOff: "Locked because projects may not enable full access.",
    allowFull: "Let projects enable full access",
    allowFullHint:
      "When off, the Full access option in project settings is locked and full-access projects run in the worktree.",
    ownerOnly: "Turning it back on needs the “Allow full-access CLI” permission (owners by default).",
    sandboxReq: "Require sandbox",
    sandboxReqHint: "Every code run must run in a gVisor container on a runner host.",
    cfTitle: "Give new projects full access?",
    cfDesc:
      "Projects created after you save run the CLI without a sandbox or approval prompts until a team admin changes it.",
    cf1: "The agent can read and edit every file the account on the run machine can reach.",
    cf2: "The agent can run any command, network commands included.",
    cfKeep: "Keep in the worktree",
    cfGo: "Choose full access",
    memTitle: "Agent-written memory",
    memHint: "Code and review agents save what they learned for later runs through memory_write.",
    memMode: "Write mode",
    memOff: "Off",
    memPropose: "Propose, wait for approval",
    memDirect: "Write directly",
    memModeHint: {
      off: "Agents cannot write memory.",
      propose: "Memories wait on the Memory page and reach agents only after a team member approves them.",
      direct: "Memories take effect at once, with no review.",
    },
    memMax: "Max memories per run",
    memMaxHint: "1 to 50. The hub rejects writes over this number.",
    memMaxOff: "Turn on a write mode to set this.",
    learnTitle: "Learning skills from hard tasks",
    learnHint:
      "One batch per project per day: an agent reads summaries of runs worth learning from (retried 2+ times, cost above p90, or marked) and proposes skills. Cheap model, read-only.",
    learnEnabled: "Enable skill learning",
    learnEnabledHint: "When off no batch runs and no tokens are spent. Existing proposals can still be decided.",
    learnMax: "Max proposals per day",
    learnMaxHint: "1 to 50 for the whole organization (UTC). Once used up no more batches run that day.",
    outOfRange: "Enter a whole number from 1 to 50. The last valid number is kept until then.",
    sdlcHint:
      'AI auto-approval for low-risk phases (AI-DLC "Continue automatically"). The mode says which phases qualify; projects may only tighten the mode and this section.',
    sdlcAllow: "Allow auto-approval",
    sdlcAllowHint:
      "When off, the hub auto-approves no gate in the organization. Existing auto-approvals can still be revoked until they expire.",
    sdlcOnBadge: "Allowed",
    sdlcOffBadge: "Turned off",
    sdlcOffNote: "Auto-approval is off for the whole organization.",
    sdlcOffNoteHint: "Projects with auto-approval on will wait for a person from the next gate.",
    sdlcFloor: "Score floor",
    sdlcFloorHint: "The effective threshold is the highest of mode, project and this floor. Scale of 0 to 10.",
    sdlcFloorRange: "Enter a number from 0 to 10. The last valid number is kept until then.",
    sdlcAlways: "Always needs a person",
    sdlcAlwaysHint: "Fixed; no layer can turn these off.",
    sdlcAlwaysList: [
      "Requirements phase of a heavy mode (size L, XL) or an L, XL item",
      "Changes that touch a sensitive keyword or path",
      "Cross-repository contracts",
    ],
    sdlcKeywords: "Sensitive keywords",
    sdlcKeywordsHint: "Case and accent insensitive. Matched against what the document changes.",
    sdlcPaths: "Sensitive paths",
    sdlcPathsHint: "Glob patterns, matched against every file path named in the document and the task file list.",
    sdlcAdd: "Add",
    sdlcReset: "Reset to default lists",
    hooksHint: "Commands that always run at CLI events: before a tool call, after edits, at the end.",
    managedOnly: "Only run organization hooks",
    managedOnlyHint: "Ignore hooks and .claude/settings.json from repositories.",
    hookList: "Organization hooks",
    hookListHint: "Run in list order.",
    noHooks: "No hooks yet. Add one to run tests or block dangerous commands in every run.",
    edit: "Edit",
    editHook: (name) => `Edit hook ${name}`,
    addHook: "Add hook",
    hookTitle: "Organization hook",
    hookDesc:
      "The worker runs this command in the run's worktree. A failing Stop hook fails the run and skips the push.",
    hookEvent: "Event",
    hookName: "Name",
    hookCommand: "Command",
    hookMatcher: "Tool matcher",
    hookMatcherHint: "Claude Code matcher syntax, e.g. Bash or Edit|Write. Leave empty for every tool.",
    eventHint: {
      PreToolUse: "Before every tool call. Claude Code only.",
      PostToolUse: "After every tool call. Claude Code only.",
      Stop: "When the agent finishes, before the worker pushes. Every CLI.",
    },
    hookRemove: "Delete hook",
    done: "Done",
    cancel: "Cancel",
    instr: "Agent instruction files",
    instrHint: "Templates the hub commits to the repo when a project is created.",
    files: "Template files",
    standard: "Standard",
    custom: "Edited",
    restore: "Use the standard template",
    variables: "Variables: {{project.name}}, {{project.key}}, {{project.branch}}, {{system.name}}, {{mcp.url}}",
    keepSync: "Open a PR when the template changes",
    keepSyncHint: "The hub opens a PR updating the instruction files in every active project.",
    syncNow: "Open PRs now",
    syncHint: "Open PRs that update the instruction files from the saved templates in every active project.",
    syncDirty: "Save this section before opening PRs.",
    syncQueued: "Queued PRs for the projects.",
    noSync: "No update PRs opened yet.",
    lastSync: (opened, unchanged, failed, at) =>
      `Last run (${at}): opened ${opened} PRs, ${unchanged} projects already up to date${failed ? `, ${failed} failed` : ""}.`,
    limits: "Global limits",
    limitsHint: "Ceilings for every project; projects can go lower, not higher.",
    runBudget: "Per-run cap",
    dayBudget: "Organization daily cap",
    parallel: "Parallel runs per machine",
    parallelUnit: "runs",
    retention: "Keep run logs",
    days: "days",
    unlimited: "No limit",
    usd: "USD",
    previewTitle: "Generated files",
    previewDesc: "Fill a project's variables into the template being edited (no need to save first).",
    project: "Project",
    projectPlaceholder: "project key, empty for a sample project",
    show: "Show",
    close: "Close",
  },
};

const formOf = (p: AgentPolicy): Form => ({
  // Chính sách lưu trước khi có CLI mới (vd. Antigravity) không có mục đó: coi như chưa giới hạn model.
  allowedModels: { ...Object.fromEntries(CLIS.map((c) => [c.id, []])), ...p.allowedModels } as Form["allowedModels"],
  neverAutoUpgrade: p.neverAutoUpgrade,
  defaultPermissionMode: p.defaultPermissionMode,
  allowFullPermission: p.allowFullPermission,
  requireSandbox: p.requireSandbox,
  hooks: p.hooks,
  managedHooksOnly: p.managedHooksOnly,
  templates: p.templates,
  autoSyncTemplates: p.autoSyncTemplates,
  limits: p.limits,
  // Hub cũ chưa có mục này thì giữ mặc định của hợp đồng, như chính sách lưu trước ADR 0022.
  agentMemory: p.agentMemory ?? { ...DEFAULT_AGENT_MEMORY_POLICY },
  skillLearning: p.skillLearning ?? { ...DEFAULT_AGENT_SKILL_LEARNING_POLICY },
  remote: p.remote ?? { ...DEFAULT_AGENT_REMOTE_POLICY },
  git: p.git ?? { ...DEFAULT_AGENT_GIT_POLICY },
  sdlc: p.sdlc ?? DEFAULT_ORG_SDLC_POLICY,
});

/** Ô của một mục lấy từ `from`, phần còn lại giữ của `base`. */
function withSection(base: Form, from: Form, section: SectionId): Form {
  const next: Record<string, unknown> = { ...base };
  for (const key of SECTIONS[section]) next[key] = from[key];
  return next as Form;
}

const sectionDirty = (form: Form, saved: Form, section: SectionId) =>
  SECTIONS[section].some((key) => JSON.stringify(form[key]) !== JSON.stringify(saved[key]));

/** Ô số có thể bỏ trống (không giới hạn); đơn vị nằm trong ô. */
function LimitInput({
  label,
  unit,
  value,
  onChange,
  disabled,
  step,
  placeholder,
}: {
  label: string;
  unit?: string;
  value: number | null;
  onChange: (v: number | null) => void;
  disabled: boolean;
  step: string;
  placeholder: string;
}) {
  const id = useId();
  const [raw, setRaw] = useState(value === null ? "" : String(value));
  useEffect(() => setRaw(value === null ? "" : String(value)), [value]);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="relative flex items-center">
        <Input
          id={id}
          type="number"
          min="0"
          step={step}
          inputMode="decimal"
          className={cx("tabular-nums", unit && "pr-14")}
          value={raw}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            setRaw(e.target.value);
            const n = Number(e.target.value);
            onChange(e.target.value.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n);
          }}
        />
        {unit && (
          <span className="pointer-events-none absolute right-3 text-xs text-muted-foreground" aria-hidden="true">
            {unit}
          </span>
        )}
      </div>
    </Field>
  );
}

/** Số nguyên 1..50; gõ dở hoặc ngoài khoảng thì giữ giá trị hợp lệ cuối và báo ô sai, để không lưu số rác. */
function MaxPerRunInput({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  const t = useT(text);
  const id = useId();
  const [raw, setRaw] = useState(String(value));
  useEffect(() => setRaw(String(value)), [value]);
  const n = Number(raw);
  const valid = Number.isInteger(n) && n >= 1 && n <= 50;
  return (
    <FormRow label={label} hint={hint} htmlFor={id}>
      <Field invalid={!valid}>
        <Input
          id={id}
          type="number"
          min="1"
          max="50"
          step="1"
          inputMode="numeric"
          className="w-28 tabular-nums"
          value={raw}
          disabled={disabled}
          aria-invalid={!valid}
          onChange={(e) => {
            setRaw(e.target.value);
            const next = Number(e.target.value);
            if (e.target.value.trim() !== "" && Number.isInteger(next) && next >= 1 && next <= 50) onChange(next);
          }}
        />
        {!valid && <FieldError>{t.outOfRange}</FieldError>}
      </Field>
    </FormRow>
  );
}

/** Số thập phân 0..10; gõ dở hoặc ngoài khoảng thì giữ giá trị hợp lệ cuối, như ô số run mỗi máy. */
function FloorInput({
  label,
  hint,
  error,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  error: string;
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  const id = useId();
  const [raw, setRaw] = useState(String(value));
  useEffect(() => setRaw(String(value)), [value]);
  const n = Number(raw.trim().replace(",", "."));
  const valid = raw.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 10;
  return (
    <Field invalid={!valid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="decimal"
          className="w-24 font-mono tabular-nums"
          value={raw}
          disabled={disabled}
          aria-invalid={!valid}
          onChange={(e) => {
            setRaw(e.target.value);
            const next = Number(e.target.value.trim().replace(",", "."));
            if (e.target.value.trim() !== "" && Number.isFinite(next) && next >= 0 && next <= 10) onChange(next);
          }}
        />
        <span className="font-mono text-sm text-muted-foreground">/ 10</span>
      </div>
      {valid ? <FieldHint>{hint}</FieldHint> : <FieldError>{error}</FieldError>}
    </Field>
  );
}

/**
 * /admin/policies: chính sách agent của tổ chức (admin-layout.md § Settings forms). Tám mục, mỗi mục lưu riêng; thanh
 * mục dính trên form để nhảy nhanh; rời trang khi còn mục chưa lưu thì hỏi lại.
 */
export function PoliciesPage() {
  const t = useT(text);
  const { api } = useOrg();
  const policy = useQuery(api.policies.get.queryOptions());
  // Nút ở đầu trang, còn hộp xem trước đọc mẫu đang sửa trong trình soạn, nên trạng thái mở nằm ở đây.
  const [previewOpen, setPreviewOpen] = useState(false);

  let body: ReactNode;
  if (policy.isPending) body = <SectionsSkeleton sections={4} />;
  else if (policy.isError) body = <LoadFailure error={policy.error} retry={() => policy.refetch()} />;
  else
    body = <PolicyEditor policy={policy.data} previewOpen={previewOpen} onClosePreview={() => setPreviewOpen(false)} />;

  return (
    <>
      <PageHeader title={t.title} description={t.lead} width="form">
        {policy.data && (
          <Button variant="outline" onClick={() => setPreviewOpen(true)}>
            {t.preview}
          </Button>
        )}
      </PageHeader>
      <PageBody width="form">{body}</PageBody>
    </>
  );
}

function PolicyEditor({
  policy,
  previewOpen,
  onClosePreview,
}: {
  policy: AgentPolicy;
  previewOpen: boolean;
  onClosePreview: () => void;
}) {
  const { org, api } = useOrg();
  const t = useT(text);
  const lang = useLang();
  const can = usePermissions();
  const canWrite = isOrgAdmin(org.role) || can("policies.write");
  const canFull = can("policies.fullaccess");
  const queryClient = useQueryClient();
  const saved = useMemo(() => formOf(policy), [policy]);
  const [form, setForm] = useState<Form>(saved);
  // Kết quả lưu gần nhất của từng mục: hiện ở chân mục đó.
  const [results, setResults] = useState<Partial<Record<SectionId, { done?: true; failure?: string }>>>({});
  // Huỷ một mục mà giá trị không đổi (ô số đang gõ dở) thì ô vẫn giữ chữ cũ; đổi khoá để ô dựng lại từ giá trị.
  const [epoch, setEpoch] = useState<Partial<Record<SectionId, number>>>({});
  const [tab, setTab] = useState<TemplateKey>("agents");
  const [editingHook, setEditingHook] = useState<{ index: number | null; hook: PolicyHook } | null>(null);
  const [adding, setAdding] = useState<Cli | null>(null);
  const [newModel, setNewModel] = useState("");
  const [confirmFull, setConfirmFull] = useState(false);
  const ids = { defaultPerm: useId(), memMode: useId(), retention: useId() };

  const save = useMutation({
    mutationFn: ({ section }: { section: SectionId }) => {
      // Mục khác không gửi `sdlc`: hub giữ bản đã lưu, nên lưu mục khác không ghi đè thay đổi AI SDLC của người khác.
      const { sdlc, ...rest } = withSection(saved, form, section);
      return api.policies.update.call(section === "sdlc" ? { ...rest, sdlc } : rest);
    },
    onSuccess: (next, { section }) => {
      queryClient.setQueryData(api.policies.get.queryKey(), next);
      // Chỉ mục vừa lưu lấy lại giá trị hub trả; mục khác giữ bản nháp đang sửa.
      setForm((f) => withSection(f, formOf(next), section));
      setResults((r) => ({ ...r, [section]: { done: true } }));
    },
    onError: (error, { section }) => setResults((r) => ({ ...r, [section]: { failure: apiErrorMessage(error) } })),
  });
  const sync = useMutation({ mutationFn: () => api.policies.syncTemplates.call({}) });

  const disabled = !canWrite || save.isPending;
  const dirty = Object.fromEntries(SECTION_IDS.map((id) => [id, sectionDirty(form, saved, id)])) as Record<
    SectionId,
    boolean
  >;
  const anyDirty = SECTION_IDS.some((id) => dirty[id]);
  const update = (section: SectionId, patch: Partial<Form>) => {
    if (results[section]) setResults((r) => ({ ...r, [section]: {} }));
    setForm((f) => ({ ...f, ...patch }));
  };
  const sectionSave = (section: SectionId): SectionSave | undefined =>
    canWrite
      ? {
          dirty: dirty[section],
          saving: save.isPending && save.variables?.section === section,
          disabled: save.isPending,
          saved: results[section]?.done === true,
          error: results[section]?.failure,
          savedLabel: t.savedSection,
          onSave: () => {
            setResults((r) => ({ ...r, [section]: {} }));
            save.mutate({ section });
          },
          onDiscard: () => {
            setForm((f) => withSection(f, saved, section));
            setResults((r) => ({ ...r, [section]: {} }));
            setEpoch((e) => ({ ...e, [section]: (e[section] ?? 0) + 1 }));
            if (section === "model") setAdding(null);
          },
        }
      : undefined;

  const defaults = policy.defaultTemplates;
  const templateText = form.templates[tab] ?? defaults[tab];
  // Đang tắt mà người sửa không có quyền mở lại: khoá công tắc để khỏi lưu rồi mới biết bị từ chối.
  const fullLocked = !policy.allowFullPermission && !canFull;
  const lastSync = policy.templateSync;

  function addModel(cli: Cli) {
    const name = newModel.trim();
    if (!name) return;
    const list = form.allowedModels[cli];
    if (!list.includes(name)) update("model", { allowedModels: { ...form.allowedModels, [cli]: [...list, name] } });
    setNewModel("");
    setAdding(null);
  }
  // Ô thêm model nằm trong form của mục: Enter phải thêm model chứ không lưu cả mục.
  function onModelKey(cli: Cli, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      addModel(cli);
    } else if (e.key === "Escape") setAdding(null);
  }

  const nav = useMemo(
    () => [
      { id: "model", label: "Model" },
      { id: "perm", label: t.perm },
      { id: "memory", label: t.memTitle },
      { id: "learning", label: t.learnTitle },
      { id: "hooks", label: "Hooks" },
      { id: "templates", label: t.instr },
      { id: "limits", label: t.limits },
      { id: "sdlc", label: "AI SDLC" },
    ],
    [t],
  );

  return (
    <div className="grid gap-4">
      <UnsavedChangesGuard when={anyDirty} />
      {!canWrite && (
        <p role="note" className="rounded-lg border border-border bg-muted px-3.5 py-2.5 text-sm text-foreground">
          {t.readOnly}
        </p>
      )}

      <SettingsLayout nav={<SettingsNav label={t.sectionsNav} items={nav} />}>
        <SettingsSection id="model" title="Model" description={t.modelHint} save={sectionSave("model")}>
          {CLIS.map((c) => (
            <FormRow key={c.id} label={c.name}>
              <div className="flex flex-wrap items-center gap-1.5">
                {form.allowedModels[c.id].length === 0 && (
                  <span className="text-sm text-muted-foreground">{t.anyModel}</span>
                )}
                {form.allowedModels[c.id].map((m, i) => (
                  <span
                    key={m}
                    className={cx(
                      "inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 font-mono text-xs",
                      i === 0 && "border-transparent bg-accent text-accent-foreground",
                    )}
                  >
                    {m}
                    {canWrite && (
                      <button
                        type="button"
                        aria-label={t.remove(m)}
                        disabled={disabled}
                        className="-mr-1 inline-flex cursor-pointer rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          update("model", {
                            allowedModels: {
                              ...form.allowedModels,
                              [c.id]: form.allowedModels[c.id].filter((x) => x !== m),
                            },
                          })
                        }
                      >
                        <XIcon className="size-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </span>
                ))}
                {canWrite &&
                  (adding === c.id ? (
                    <span className="flex items-center gap-1.5">
                      <Input
                        autoFocus
                        aria-label={t.addModel(c.name)}
                        className="h-7 w-48 font-mono text-xs"
                        value={newModel}
                        onChange={(e) => setNewModel(e.target.value)}
                        onKeyDown={(e) => onModelKey(c.id, e)}
                      />
                      <Button type="button" size="sm" variant="outline" onClick={() => addModel(c.id)}>
                        {t.add}
                      </Button>
                    </span>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => {
                        setAdding(c.id);
                        setNewModel("");
                      }}
                      aria-label={t.addModel(c.name)}
                    >
                      <PlusIcon aria-hidden="true" />
                      {t.add}
                    </Button>
                  ))}
              </div>
            </FormRow>
          ))}
          <SwitchRow
            label={t.neverAuto}
            hint={t.neverAutoHint}
            checked={form.neverAutoUpgrade}
            onChange={(v) => update("model", { neverAutoUpgrade: v })}
            disabled={disabled}
          />
        </SettingsSection>

        <SettingsSection id="perm" title={t.perm} description={t.permHint} save={sectionSave("perm")}>
          <FormRow label={t.defaultPerm} hint={t.defaultPermHint}>
            <RadioCards
              name={ids.defaultPerm}
              label={t.defaultPerm}
              value={form.defaultPermissionMode}
              disabled={disabled}
              onChange={(mode) =>
                mode === "full" ? setConfirmFull(true) : update("perm", { defaultPermissionMode: mode })
              }
              options={[
                { value: "workspace", title: t.wt, description: t.wtHint },
                {
                  value: "full",
                  title: t.full,
                  description: form.allowFullPermission ? t.fullHint : t.fullOff,
                  tone: "destructive",
                  disabled: !form.allowFullPermission,
                },
              ]}
            />
          </FormRow>
          <SwitchRow
            label={t.allowFull}
            hint={fullLocked ? `${t.allowFullHint} ${t.ownerOnly}` : t.allowFullHint}
            checked={form.allowFullPermission}
            onChange={(v) =>
              update("perm", {
                allowFullPermission: v,
                ...(v ? {} : { defaultPermissionMode: "workspace" as const }),
              })
            }
            disabled={disabled || (fullLocked && !form.allowFullPermission)}
            tone="destructive"
          />
          <SwitchRow
            label={t.sandboxReq}
            hint={t.sandboxReqHint}
            checked={form.requireSandbox}
            onChange={(v) => update("perm", { requireSandbox: v })}
            disabled={disabled}
          />
        </SettingsSection>

        <SettingsSection id="memory" title={t.memTitle} description={t.memHint} save={sectionSave("memory")}>
          <FormRow label={t.memMode}>
            <RadioCards
              name={ids.memMode}
              label={t.memMode}
              value={form.agentMemory.mode}
              disabled={disabled}
              onChange={(mode) => update("memory", { agentMemory: { ...form.agentMemory, mode } })}
              options={[
                { value: "off", title: t.memOff, description: t.memModeHint.off },
                { value: "propose", title: t.memPropose, description: t.memModeHint.propose },
                { value: "direct", title: t.memDirect, description: t.memModeHint.direct },
              ]}
            />
          </FormRow>
          <MaxPerRunInput
            key={`mem-${epoch.memory ?? 0}`}
            label={t.memMax}
            hint={form.agentMemory.mode === "off" ? t.memMaxOff : t.memMaxHint}
            value={form.agentMemory.maxPerRun}
            onChange={(maxPerRun) => update("memory", { agentMemory: { ...form.agentMemory, maxPerRun } })}
            disabled={disabled || form.agentMemory.mode === "off"}
          />
        </SettingsSection>

        <SettingsSection id="learning" title={t.learnTitle} description={t.learnHint} save={sectionSave("learning")}>
          <SwitchRow
            label={t.learnEnabled}
            hint={t.learnEnabledHint}
            checked={form.skillLearning.enabled}
            onChange={(enabled) => update("learning", { skillLearning: { ...form.skillLearning, enabled } })}
            disabled={disabled}
          >
            <MaxPerRunInput
              key={`learn-${epoch.learning ?? 0}`}
              label={t.learnMax}
              hint={t.learnMaxHint}
              value={form.skillLearning.maxPerDay}
              onChange={(maxPerDay) => update("learning", { skillLearning: { ...form.skillLearning, maxPerDay } })}
              disabled={disabled || !form.skillLearning.enabled}
            />
          </SwitchRow>
        </SettingsSection>

        <SettingsSection
          id="hooks"
          title="Hooks"
          description={t.hooksHint}
          save={sectionSave("hooks")}
          actions={
            canWrite && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => setEditingHook({ index: null, hook: { event: "PreToolUse", name: "", command: "" } })}
              >
                <PlusIcon aria-hidden="true" />
                {t.addHook}
              </Button>
            )
          }
        >
          <SwitchRow
            label={t.managedOnly}
            hint={t.managedOnlyHint}
            checked={form.managedHooksOnly}
            onChange={(v) => update("hooks", { managedHooksOnly: v })}
            disabled={disabled}
          />
          <FormRow label={t.hookList} hint={t.hookListHint}>
            {form.hooks.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.noHooks}</p>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {form.hooks.map((h, i) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: hook không có id; thứ tự là thứ tự chạy.
                    key={i}
                    className="flex items-center gap-2.5 px-3 py-2"
                  >
                    <Pill className="shrink-0 font-mono">{h.event}</Pill>
                    <span className="grid min-w-0 flex-1 leading-snug">
                      <span className="truncate text-sm">{h.name}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground" title={h.command}>
                        {h.command}
                      </span>
                    </span>
                    {canWrite && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        aria-label={t.editHook(h.name)}
                        onClick={() => setEditingHook({ index: i, hook: h })}
                      >
                        {t.edit}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </FormRow>
        </SettingsSection>

        <SettingsSection id="templates" title={t.instr} description={t.instrHint} save={sectionSave("templates")}>
          <Tabs.Root value={tab} onValueChange={(v: TemplateKey) => setTab(v)} className="grid min-w-0 gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Tabs.List aria-label={t.files} className="flex flex-wrap gap-1.5">
                {TEMPLATE_FILES.map((f) => (
                  <FileTab key={f.id} value={f.id}>
                    {f.path}
                  </FileTab>
                ))}
              </Tabs.List>
              <Pill tone={form.templates[tab] === null ? "neutral" : "sel"} className="ml-auto">
                {form.templates[tab] === null ? t.standard : t.custom}
              </Pill>
            </div>
            <Tabs.Panel value={tab} className="grid">
              <Textarea
                aria-label={TEMPLATE_FILES.find((f) => f.id === tab)?.path}
                className="min-h-56 font-mono text-xs leading-relaxed"
                value={templateText}
                readOnly={disabled}
                onChange={(e) =>
                  update("templates", {
                    templates: {
                      ...form.templates,
                      // Trùng mẫu chuẩn thì lưu null, để mẫu chuẩn của bản hub mới tự áp.
                      [tab]: e.target.value === defaults[tab] ? null : e.target.value,
                    },
                  })
                }
              />
            </Tabs.Panel>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 font-mono text-xs break-words text-muted-foreground">{t.variables}</span>
              {canWrite && form.templates[tab] !== null && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => update("templates", { templates: { ...form.templates, [tab]: null } })}
                >
                  {t.restore}
                </Button>
              )}
            </div>
          </Tabs.Root>
          <SwitchRow
            label={t.keepSync}
            hint={t.keepSyncHint}
            checked={form.autoSyncTemplates}
            onChange={(v) => update("templates", { autoSyncTemplates: v })}
            disabled={disabled}
          />
          {(canWrite || lastSync) && (
            <FormRow label={t.syncNow} hint={dirty.templates && canWrite ? t.syncDirty : t.syncHint}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {canWrite && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={sync.isPending || dirty.templates}
                    onClick={() => sync.mutate()}
                  >
                    {t.syncNow}
                  </Button>
                )}
                <span role="status" className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground">
                  {sync.isSuccess
                    ? t.syncQueued
                    : sync.isError
                      ? apiErrorMessage(sync.error)
                      : lastSync
                        ? t.lastSync(
                            lastSync.opened,
                            lastSync.unchanged,
                            lastSync.failed.length,
                            new Date(lastSync.at).toLocaleString(lang),
                          )
                        : t.noSync}
                </span>
              </div>
            </FormRow>
          )}
        </SettingsSection>

        <SettingsSection id="limits" title={t.limits} description={t.limitsHint} save={sectionSave("limits")}>
          <div key={`limits-${epoch.limits ?? 0}`} className="grid gap-4 sm:grid-cols-2">
            <LimitInput
              label={t.runBudget}
              unit={t.usd}
              step="0.5"
              placeholder={t.unlimited}
              value={form.limits.perRunUsd}
              disabled={disabled}
              onChange={(v) => update("limits", { limits: { ...form.limits, perRunUsd: v } })}
            />
            <LimitInput
              label={t.dayBudget}
              unit={t.usd}
              step="1"
              placeholder={t.unlimited}
              value={form.limits.dailyUsd}
              disabled={disabled}
              onChange={(v) => update("limits", { limits: { ...form.limits, dailyUsd: v } })}
            />
            <LimitInput
              label={t.parallel}
              unit={t.parallelUnit}
              step="1"
              placeholder={t.unlimited}
              value={form.limits.maxParallelPerMachine}
              disabled={disabled}
              onChange={(v) =>
                update("limits", {
                  limits: { ...form.limits, maxParallelPerMachine: v === null ? null : Math.round(v) },
                })
              }
            />
            <Field>
              <FieldLabel htmlFor={ids.retention}>{t.retention}</FieldLabel>
              <NativeSelect
                id={ids.retention}
                value={String(form.limits.runLogRetentionDays)}
                disabled={disabled}
                onChange={(e) =>
                  update("limits", {
                    limits: {
                      ...form.limits,
                      runLogRetentionDays: Number(e.target.value) as Form["limits"]["runLogRetentionDays"],
                    },
                  })
                }
              >
                {[30, 90, 365].map((d) => (
                  <option key={d} value={d}>
                    {d} {t.days}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
        </SettingsSection>

        <SettingsSection
          id="sdlc"
          title="AI SDLC"
          description={t.sdlcHint}
          save={sectionSave("sdlc")}
          actions={
            <Pill tone={form.sdlc.autoApprove.allowed ? "ok" : "warn"}>
              {form.sdlc.autoApprove.allowed ? t.sdlcOnBadge : t.sdlcOffBadge}
            </Pill>
          }
        >
          <SwitchRow
            label={t.sdlcAllow}
            hint={t.sdlcAllowHint}
            checked={form.sdlc.autoApprove.allowed}
            disabled={disabled}
            onChange={(allowed) => update("sdlc", { sdlc: { autoApprove: { ...form.sdlc.autoApprove, allowed } } })}
          />
          {!form.sdlc.autoApprove.allowed && (
            <div role="status" className="rounded-lg bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
              {t.sdlcOffNote}
              <p className="text-xs">{t.sdlcOffNoteHint}</p>
            </div>
          )}
          <div key={`sdlc-${epoch.sdlc ?? 0}`} className="grid items-start gap-5 md:grid-cols-2">
            <div className="grid gap-3.5">
              <FloorInput
                label={t.sdlcFloor}
                hint={t.sdlcFloorHint}
                error={t.sdlcFloorRange}
                value={form.sdlc.autoApprove.minScoreFloor}
                disabled={disabled}
                onChange={(minScoreFloor) =>
                  update("sdlc", { sdlc: { autoApprove: { ...form.sdlc.autoApprove, minScoreFloor } } })
                }
              />
              <div className="grid gap-1.5 rounded-lg bg-muted px-3.5 py-2.5 text-sm">
                <strong className="flex items-center gap-1.5 font-semibold">
                  <LockIcon aria-hidden="true" className="size-3.5" />
                  {t.sdlcAlways}
                </strong>
                <ul className="m-0 grid list-disc gap-0.5 pl-5">
                  {t.sdlcAlwaysList.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
                <span className="text-xs text-muted-foreground">{t.sdlcAlwaysHint}</span>
              </div>
            </div>
            <div className="grid gap-3.5">
              <Field>
                <FieldLabel>{t.sdlcKeywords}</FieldLabel>
                <FieldHint>{t.sdlcKeywordsHint}</FieldHint>
                <ChipInput
                  boxed
                  values={form.sdlc.autoApprove.denyKeywords}
                  onChange={(denyKeywords) =>
                    update("sdlc", { sdlc: { autoApprove: { ...form.sdlc.autoApprove, denyKeywords } } })
                  }
                  canWrite={!disabled}
                  addLabel={`${t.sdlcAdd} ${t.sdlcKeywords.toLowerCase()}`}
                  placeholder={t.sdlcAdd}
                />
              </Field>
              <Field>
                <FieldLabel>{t.sdlcPaths}</FieldLabel>
                <FieldHint>{t.sdlcPathsHint}</FieldHint>
                <ChipInput
                  boxed
                  values={form.sdlc.autoApprove.denyPaths}
                  onChange={(denyPaths) =>
                    update("sdlc", { sdlc: { autoApprove: { ...form.sdlc.autoApprove, denyPaths } } })
                  }
                  canWrite={!disabled}
                  addLabel={`${t.sdlcAdd} ${t.sdlcPaths.toLowerCase()}`}
                  placeholder={t.sdlcAdd}
                />
              </Field>
              {canWrite && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="justify-self-start"
                  disabled={disabled}
                  onClick={() =>
                    update("sdlc", {
                      sdlc: {
                        autoApprove: {
                          ...form.sdlc.autoApprove,
                          denyKeywords: [...DEFAULT_SDLC_DENY_KEYWORDS],
                          denyPaths: [...DEFAULT_SDLC_DENY_PATHS],
                        },
                      },
                    })
                  }
                >
                  {t.sdlcReset}
                </Button>
              )}
            </div>
          </div>
          <SdlcPolicyStats />
        </SettingsSection>
      </SettingsLayout>

      <Dialog open={confirmFull} onOpenChange={setConfirmFull}>
        <DialogContent>
          <DialogTitle>{t.cfTitle}</DialogTitle>
          <DialogDescription>{t.cfDesc}</DialogDescription>
          <ul className="grid list-disc gap-1 pl-5 text-sm text-foreground">
            <li>{t.cf1}</li>
            <li>{t.cf2}</li>
          </ul>
          <DialogActions>
            <Button variant="outline" onClick={() => setConfirmFull(false)}>
              {t.cfKeep}
            </Button>
            <Button
              variant="destructive-solid"
              onClick={() => {
                update("perm", { defaultPermissionMode: "full" });
                setConfirmFull(false);
              }}
            >
              {t.cfGo}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
      {editingHook && (
        <HookDialog
          initial={editingHook.hook}
          isNew={editingHook.index === null}
          onClose={() => setEditingHook(null)}
          onRemove={() => {
            update("hooks", { hooks: form.hooks.filter((_, i) => i !== editingHook.index) });
            setEditingHook(null);
          }}
          onSave={(hook) => {
            const hooks = [...form.hooks];
            if (editingHook.index === null) hooks.push(hook);
            else hooks[editingHook.index] = hook;
            update("hooks", { hooks });
            setEditingHook(null);
          }}
        />
      )}
      {previewOpen && <PreviewDialog templates={form.templates} onClose={onClosePreview} />}
    </div>
  );
}

/** Tab chọn file mẫu: Base UI lo mũi tên trái/phải và `aria-controls`; kiểu viên thuốc vì nằm trong một mục form. */
function FileTab({ value, children }: { value: string; children: ReactNode }) {
  return (
    <Tabs.Tab
      value={value}
      className="inline-flex h-7 cursor-pointer items-center rounded-full border border-border px-2.5 font-mono text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring data-active:border-transparent data-active:bg-accent data-active:font-medium data-active:text-accent-foreground"
    >
      {children}
    </Tabs.Tab>
  );
}

function HookDialog({
  initial,
  isNew,
  onClose,
  onSave,
  onRemove,
}: {
  initial: PolicyHook;
  isNew: boolean;
  onClose: () => void;
  onSave: (hook: PolicyHook) => void;
  onRemove: () => void;
}) {
  const t = useT(text);
  const ids = useId();
  const [hook, setHook] = useState<PolicyHook>(initial);
  const toolEvent = hook.event !== "Stop";
  function submit(e: FormEvent) {
    e.preventDefault();
    // Hộp thoại vẽ qua portal nhưng sự kiện React vẫn nổi lên form của mục Hooks; chặn để Enter không lưu cả mục.
    e.stopPropagation();
    const { matcher, ...rest } = hook;
    const m = matcher?.trim();
    onSave({
      ...rest,
      name: hook.name.trim(),
      command: hook.command.trim(),
      ...(toolEvent && m ? { matcher: m } : {}),
    });
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t.hookTitle}</DialogTitle>
            <DialogDescription>{t.hookDesc}</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${ids}-event`}>{t.hookEvent}</FieldLabel>
            <NativeSelect
              id={`${ids}-event`}
              value={hook.event}
              onChange={(e) => setHook({ ...hook, event: e.target.value as HookEvent })}
            >
              {EVENTS.map((ev) => (
                <option key={ev} value={ev}>
                  {ev}
                </option>
              ))}
            </NativeSelect>
            <FieldHint>{t.eventHint[hook.event]}</FieldHint>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-name`}>{t.hookName}</FieldLabel>
            <Input
              id={`${ids}-name`}
              required
              maxLength={120}
              value={hook.name}
              onChange={(e) => setHook({ ...hook, name: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-command`}>{t.hookCommand}</FieldLabel>
            <Input
              id={`${ids}-command`}
              required
              maxLength={2000}
              className="font-mono"
              value={hook.command}
              onChange={(e) => setHook({ ...hook, command: e.target.value })}
            />
          </Field>
          {toolEvent && (
            <Field>
              <FieldLabel htmlFor={`${ids}-matcher`}>{t.hookMatcher}</FieldLabel>
              <Input
                id={`${ids}-matcher`}
                maxLength={200}
                className="font-mono"
                value={hook.matcher ?? ""}
                onChange={(e) => setHook({ ...hook, matcher: e.target.value })}
              />
              <FieldHint>{t.hookMatcherHint}</FieldHint>
            </Field>
          )}
          <DialogActions>
            {!isNew && (
              <Button type="button" variant="destructive" className="mr-auto" onClick={onRemove}>
                {t.hookRemove}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={!hook.name.trim() || !hook.command.trim()}>
              {t.done}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PreviewDialog({ templates, onClose }: { templates: InstructionTemplates; onClose: () => void }) {
  const { api } = useOrg();
  const t = useT(text);
  const ids = useId();
  const [project, setProject] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const preview = useMutation({
    mutationFn: (key: string): Promise<TemplatePreview> =>
      api.policies.preview.call({ templates, ...(key.trim() ? { project: key.trim() } : {}) }),
  });
  // Mở hộp là xem ngay với dự án mẫu.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chỉ chạy một lần khi mở.
  useEffect(() => {
    preview.mutate("");
  }, []);
  const files = preview.data?.files ?? [];
  const current = files.find((f) => f.path === file) ?? files[0];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t.previewTitle}</DialogTitle>
          <DialogDescription>{t.previewDesc}</DialogDescription>
        </DialogHeader>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            preview.mutate(project);
          }}
        >
          <Field className="flex-1">
            <FieldLabel htmlFor={`${ids}-project`}>{t.project}</FieldLabel>
            <Input
              id={`${ids}-project`}
              className="font-mono"
              placeholder={t.projectPlaceholder}
              value={project}
              onChange={(e) => setProject(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="outline" disabled={preview.isPending}>
            {t.show}
          </Button>
        </form>
        {preview.isError && <Alert variant="destructive">{apiErrorMessage(preview.error)}</Alert>}
        {preview.isPending && !preview.data && <LoadingState />}
        {current && (
          <Tabs.Root value={current.path} onValueChange={(v: string) => setFile(v)} className="grid min-w-0 gap-3">
            <Tabs.List aria-label={t.previewTitle} className="flex flex-wrap gap-1.5">
              {files.map((f) => (
                <FileTab key={f.path} value={f.path}>
                  {f.path}
                </FileTab>
              ))}
            </Tabs.List>
            <Tabs.Panel value={current.path}>
              <pre className="max-h-96 overflow-auto overscroll-contain rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                {current.content}
              </pre>
            </Tabs.Panel>
          </Tabs.Root>
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
