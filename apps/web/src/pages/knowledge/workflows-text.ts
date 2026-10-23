import type { RejectRoute, RuleCheck } from "@xdev-hive/contracts";
import type { Dict } from "@/lib/i18n.ts";

/** Chữ của màn Quy trình duyệt (Workflows.dc.html), dùng chung cho trang và khung cấu hình checkpoint. */
export const workflowsText: Dict<{
  title: string;
  description: string;
  test: string;
  create: string;
  readOnly: string;
  workflow: string;
  filter: string;
  filterAll: string;
  newWorkflow: string;
  newName: string;
  off: string;
  sectionsNav: string;
  general: string;
  generalHint: string;
  subject: string;
  subjectHint: string;
  subjectDesc: Record<"doc" | "code", string>;
  preset: string;
  prefixes: string;
  prefixesHint: string;
  addPrefix: string;
  prefixPh: string;
  removeChip: (v: string) => string;
  name: string;
  team: string;
  wholeOrg: string;
  enabled: string;
  inFlight: (n: number) => string;
  remove: string;
  pipeline: string;
  pipelineTitle: string;
  pipelineHint: string;
  addGate: string;
  newGateName: string;
  outputs: string;
  addOutput: (phase: string) => string;
  outputPh: string;
  phaseName: (n: number) => string;
  phaseDesc: (n: number) => string;
  phaseDescPh: string;
  addPhase: string;
  newPhase: (n: number) => string;
  removePhase: (name: string) => string;
  noGates: string;
  config: string;
  pickGate: string;
  gateName: string;
  gateId: string;
  moveUp: string;
  moveDown: string;
  removeGate: string;
  type: string;
  approvers: string;
  rolePrefix: string;
  teamPrefix: string;
  teams: string;
  addApprover: string;
  addApproverPh: string;
  roles: string;
  people: string;
  rule: string;
  ruleAny: string;
  ruleAll: string;
  ruleN: string;
  quorumN: string;
  ofM: (m: number) => string;
  aiModel: string;
  aiModelHint: string;
  aiChecks: string;
  aiChecksHint: string;
  passScore: string;
  rules: string;
  ruleText: Record<RuleCheck, string>;
  sections: string;
  sectionsHint: string;
  maxDiff: string;
  extCheck: string;
  extValue: string;
  extHint: string;
  when: string;
  always: string;
  condType: string;
  condKw: string;
  condSize: (n: number) => string;
  addCond: string;
  condTypeLabel: string;
  condTypePh: string;
  condKwLabel: string;
  condKwPh: string;
  condSizeLabel: string;
  skipSmall: string;
  skipSmallHint: string;
  onReject: string;
  route: Record<RejectRoute, string>;
  sla: string;
  hours: string;
  noSla: string;
  after: string;
  afterNext: string;
  afterTask: string;
  afterBaseline: string;
  afterHint: string;
  nextTask: string;
  nextTaskPh: string;
  nextTaskHint: string;
  whoAll: string;
  whoAny: string;
  whoN: (n: number) => string;
  whoNone: string;
  aiWho: (n: number, score: number) => string;
  ruleWho: string;
  extWho: string;
  condLine: (parts: string[]) => string;
  condTypeShort: (v: string) => string;
  condKwShort: (v: string) => string;
  condSkipShort: string;
  invalid: string;
  empty: string;
  emptyHint: string;
  dryTitle: string;
  dryDesc: string;
  docKey: string;
  run: string;
  running: string;
  close: string;
  docType: string;
  notMatched: string;
  runs: string;
  skips: string;
  dryGates: string;
  presetTitle: (name: string) => string;
  presetBody: string;
  presetApply: string;
  cancel: string;
  removeTitle: string;
  removeBody: (name: string, n: number) => string;
  removeConfirm: string;
  danger: string;
  dangerHint: string;
}> = {
  vi: {
    title: "Quy trình duyệt",
    description: "Tài liệu và PR của agent đi qua những checkpoint nào trước khi được chốt hoặc merge.",
    test: "Chạy thử trên 1 tài liệu",
    create: "Tạo quy trình",
    readOnly: "Bạn chỉ xem được quy trình duyệt. Cần quyền “Sửa quy trình duyệt” để thay đổi.",
    workflow: "Quy trình",
    filter: "Lọc quy trình theo loại",
    filterAll: "Tất cả",
    newWorkflow: "Quy trình mới",
    newName: "Quy trình mới",
    off: "đang tắt",
    sectionsNav: "Các mục của quy trình",
    general: "Thông tin chung",
    generalHint: "Tên, đội sở hữu, loại áp dụng và quy trình có đang nhận việc mới hay không.",
    subject: "Loại áp dụng",
    subjectHint: "Quy trình duyệt tài liệu trong kho kiến thức hay PR do agent mở.",
    subjectDesc: { doc: "PRD, thiết kế, spec trong kho kiến thức", code: "PR do agent mở, trước khi merge" },
    preset: "Khung mẫu",
    prefixes: "Tiền tố tài liệu",
    prefixesHint: "Tài liệu có key bắt đầu bằng một trong các tiền tố này đi qua quy trình.",
    addPrefix: "Thêm tiền tố tài liệu",
    prefixPh: "project/<dự án>/prd",
    removeChip: (v) => `Bỏ ${v}`,
    name: "Tên quy trình",
    team: "Đội sở hữu",
    wholeOrg: "Cả tổ chức",
    enabled: "Đang bật",
    inFlight: (n) => (n ? `${n} phiên duyệt đang chạy theo quy trình này` : "Chưa có phiên duyệt nào đang chạy"),
    remove: "Xoá quy trình",
    pipeline: "Các checkpoint",
    pipelineTitle: "Giai đoạn và checkpoint",
    pipelineHint: "Chạy theo thứ tự từ trái sang phải. Bấm một checkpoint để cấu hình.",
    addGate: "Thêm checkpoint",
    newGateName: "Checkpoint mới",
    outputs: "Tài liệu đầu ra",
    addOutput: (phase) => `Thêm tài liệu đầu ra cho ${phase}`,
    outputPh: "spec.md",
    phaseName: (n) => `Tên giai đoạn ${n}`,
    phaseDesc: (n) => `Mô tả giai đoạn ${n}`,
    phaseDescPh: "Thêm mô tả",
    addPhase: "Thêm giai đoạn",
    newPhase: (n) => `Giai đoạn ${n}`,
    removePhase: (name) => `Xoá giai đoạn ${name}`,
    noGates: "Chưa có checkpoint.",
    config: "Cấu hình checkpoint",
    pickGate: "Chọn một checkpoint để cấu hình.",
    gateName: "Tên checkpoint",
    gateId: "mã",
    moveUp: "Dời checkpoint lên",
    moveDown: "Dời checkpoint xuống",
    removeGate: "Xoá checkpoint",
    type: "Loại",
    approvers: "Người duyệt",
    rolePrefix: "Vai trò",
    teamPrefix: "Đội",
    teams: "Đội",
    addApprover: "Thêm người duyệt",
    addApproverPh: "vai trò, đội, người",
    roles: "Vai trò",
    people: "Người",
    rule: "Cách duyệt",
    ruleAny: "Một người bất kỳ",
    ruleAll: "Tất cả phải duyệt",
    ruleN: "N trên M người",
    quorumN: "Số người cần duyệt",
    ofM: (m) => (m ? `trên ${m} người được chỉ định` : "người"),
    aiModel: "Model kiểm",
    aiModelHint: "Bỏ trống là model review của dự án. Chính sách agent của tổ chức vẫn áp.",
    aiChecks: "AI kiểm gì",
    aiChecksHint: "Mỗi dòng một mục; agent chấm từng mục rồi cho điểm.",
    passScore: "Điểm đạt",
    rules: "Quy tắc",
    ruleText: {
      sections: "Đủ các mục bắt buộc",
      requirements: "Mỗi R-n có tiêu chí chấp nhận",
      "no-secrets": "Không có secret, token, mật khẩu",
      "max-diff": "Thay đổi không quá số dòng cho phép",
      command: "Lệnh kiểm chạy đạt",
      "max-files": "Không quá số file cho phép",
      "deny-paths": "Không đụng đường dẫn cấm",
      "agent-report": "Agent có nộp báo cáo",
      "no-open-questions": "Không còn câu hỏi mở",
      breakdown: "Bản tách task đọc được",
      coverage: "Mỗi requirement có task",
      ears: "Tiêu chí chấp nhận viết theo EARS",
      "qa-cases": "TC có cấu trúc và liên kết FR/AC",
      "qa-tests": "TC bắt buộc đạt hoặc được miễn",
    },
    sections: "Mục bắt buộc",
    sectionsHint: "Mỗi dòng một tiêu đề mục phải có trong tài liệu.",
    maxDiff: "Số dòng thay đổi tối đa",
    extCheck: "Kiểm tra bên ngoài",
    extValue: "CI · nhánh chính của repo dự án",
    extHint: "Đạt khi CI của nhánh chính trong repo của dự án đang xanh.",
    when: "Chạy khi",
    always: "Luôn chạy",
    condType: "Loại",
    condKw: "Có từ khoá",
    condSize: (n) => `Δ ≥ ${n} dòng`,
    addCond: "Điều kiện",
    condTypeLabel: "Loại tài liệu",
    condTypePh: "prd, design",
    condKwLabel: "Có một trong các từ khoá",
    condKwPh: "phí, hoàn tiền",
    condSizeLabel: "Số dòng thêm và xoá từ",
    skipSmall: "Bỏ qua khi chỉ sửa chính tả, định dạng",
    skipSmallHint: "AI phân loại thay đổi trước; thay đổi nhỏ đi thẳng tới checkpoint sau.",
    onReject: "Khi bị trả lại",
    route: { author: "Về người viết", agent: "Agent sửa theo góp ý", previous: "Về checkpoint trước" },
    sla: "SLA",
    hours: "giờ",
    noSla: "Không hạn",
    after: "Khi đạt",
    afterNext: "Sang checkpoint tiếp",
    afterTask: "Tạo việc cho agent bước sau",
    afterBaseline: "Chốt phiên bản (baseline)",
    afterHint: "Ví dụ: PRD đạt thì leader tạo việc viết thiết kế kỹ thuật, trỏ về PRD đã chốt.",
    nextTask: "Tiêu đề việc cho bước sau",
    nextTaskPh: "Viết thiết kế kỹ thuật cho {title}",
    nextTaskHint: "{title} là tiêu đề tài liệu vừa đạt.",
    whoAll: "tất cả",
    whoAny: "1 người",
    whoN: (n) => `${n} người`,
    whoNone: "Chưa chọn người duyệt",
    aiWho: (n, score) => `${n} mục kiểm · đạt từ ${score}/10`,
    ruleWho: "Tự động",
    extWho: "CI của repo",
    condLine: (parts) => `khi ${parts.join("; ")}`,
    condTypeShort: (v) => `loại ${v}`,
    condKwShort: (v) => `có ${v}`,
    condSkipShort: "bỏ qua sửa định dạng",
    invalid: "Chưa lưu được:",
    empty: "Chưa có quy trình duyệt",
    emptyHint: "Quản trị tổ chức hoặc người có quyền “Sửa quy trình duyệt” tạo quy trình từ khung mẫu.",
    dryTitle: "Chạy thử trên 1 tài liệu",
    dryDesc:
      "Hub xem bản đang sửa (chưa cần lưu) sẽ chạy những checkpoint nào với tài liệu này. Không tạo phiên duyệt.",
    docKey: "Key tài liệu",
    run: "Chạy thử",
    running: "Đang chạy thử…",
    close: "Đóng",
    docType: "Loại tài liệu",
    notMatched: "Key của tài liệu không khớp tiền tố nào của quy trình nên tài liệu sẽ không đi qua quy trình.",
    runs: "Chạy",
    skips: "Bỏ qua",
    dryGates: "Checkpoint với tài liệu này",
    presetTitle: (name) => `Dùng khung mẫu ${name}?`,
    presetBody:
      "Các giai đoạn và checkpoint đang có được thay bằng khung mẫu. Quy trình đang chạy chỉ đổi khi bạn lưu mục Giai đoạn và checkpoint.",
    presetApply: "Dùng khung mẫu",
    cancel: "Huỷ",
    removeTitle: "Xoá quy trình?",
    removeBody: (name, n) =>
      `Quy trình “${name}” bị xoá${n ? `; ${n} phiên duyệt đang chạy theo quy trình này` : ""}. Không hoàn tác được.`,
    removeConfirm: "Xoá quy trình",
    danger: "Vùng nguy hiểm",
    dangerHint: "Xoá quy trình không hoàn tác được.",
  },
  en: {
    title: "Review workflows",
    description: "Which checkpoints docs and agent PRs pass before they are baselined or merged.",
    test: "Dry-run on a doc",
    create: "Create workflow",
    readOnly: "You can only view review workflows. Editing needs the “Edit review workflows” permission.",
    workflow: "Workflow",
    filter: "Filter workflows by kind",
    filterAll: "All",
    newWorkflow: "New workflow",
    newName: "New workflow",
    off: "off",
    sectionsNav: "Workflow sections",
    general: "General",
    generalHint: "Name, owning team, what the workflow reviews and whether it takes new work.",
    subject: "Reviews",
    subjectHint: "Docs in the knowledge base, or PRs opened by agents.",
    subjectDesc: { doc: "PRDs, designs and specs in the knowledge base", code: "PRs opened by agents, before merge" },
    preset: "Preset",
    prefixes: "Doc key prefixes",
    prefixesHint: "Docs whose key starts with one of these prefixes go through this workflow.",
    addPrefix: "Add a doc key prefix",
    prefixPh: "project/<project>/prd",
    removeChip: (v) => `Remove ${v}`,
    name: "Workflow name",
    team: "Owning team",
    wholeOrg: "Whole organization",
    enabled: "Enabled",
    inFlight: (n) => (n ? `${n} reviews in flight on this workflow` : "No reviews in flight"),
    remove: "Delete workflow",
    pipeline: "Checkpoints",
    pipelineTitle: "Phases and checkpoints",
    pipelineHint: "They run left to right. Pick a checkpoint to configure it.",
    addGate: "Add checkpoint",
    newGateName: "New checkpoint",
    outputs: "Output artifacts",
    addOutput: (phase) => `Add an output artifact to ${phase}`,
    outputPh: "spec.md",
    phaseName: (n) => `Phase ${n} name`,
    phaseDesc: (n) => `Phase ${n} description`,
    phaseDescPh: "Add a description",
    addPhase: "Add phase",
    newPhase: (n) => `Phase ${n}`,
    removePhase: (name) => `Delete phase ${name}`,
    noGates: "No checkpoints yet.",
    config: "Checkpoint settings",
    pickGate: "Pick a checkpoint to configure.",
    gateName: "Checkpoint name",
    gateId: "id",
    moveUp: "Move checkpoint up",
    moveDown: "Move checkpoint down",
    removeGate: "Delete checkpoint",
    type: "Type",
    approvers: "Approvers",
    rolePrefix: "Role",
    teamPrefix: "Team",
    teams: "Teams",
    addApprover: "Add approver",
    addApproverPh: "role, team, person",
    roles: "Roles",
    people: "People",
    rule: "Approval rule",
    ruleAny: "Any one",
    ruleAll: "Everyone",
    ruleN: "N of M",
    quorumN: "Approvals needed",
    ofM: (m) => (m ? `of ${m} named approvers` : "people"),
    aiModel: "Checking model",
    aiModelHint: "Leave empty to use the project's review model. Organization agent policies still apply.",
    aiChecks: "What the AI checks",
    aiChecksHint: "One item per line; the agent grades each one and scores the doc.",
    passScore: "Pass score",
    rules: "Rules",
    ruleText: {
      sections: "Required sections present",
      requirements: "Every R-n has acceptance criteria",
      "no-secrets": "No secrets, tokens or passwords",
      "max-diff": "Change stays within a line limit",
      command: "Check commands pass",
      "max-files": "Changes stay within a file limit",
      "deny-paths": "No changes to denied paths",
      "agent-report": "Agent submitted a report",
      "no-open-questions": "No open questions left",
      breakdown: "Task breakdown is readable",
      coverage: "Every requirement has a task",
      ears: "Acceptance criteria follow EARS",
      "qa-cases": "Structured test cases linked to FR/AC",
      "qa-tests": "Required test cases pass or are waived",
    },
    sections: "Required sections",
    sectionsHint: "One heading per line that the doc must contain.",
    maxDiff: "Max changed lines",
    extCheck: "External check",
    extValue: "CI · default branch of the project repo",
    extHint: "Passes when CI on the project repo's default branch is green.",
    when: "Runs when",
    always: "Always runs",
    condType: "Type",
    condKw: "Mentions",
    condSize: (n) => `Δ ≥ ${n} lines`,
    addCond: "Condition",
    condTypeLabel: "Doc types",
    condTypePh: "prd, design",
    condKwLabel: "Mentions any of",
    condKwPh: "fee, refund",
    condSizeLabel: "Added plus deleted lines from",
    skipSmall: "Skip for typo or formatting-only edits",
    skipSmallHint: "AI classifies the change first; small ones go straight on.",
    onReject: "On reject",
    route: { author: "Back to author", agent: "Agent revises", previous: "Previous checkpoint" },
    sla: "SLA",
    hours: "hours",
    noSla: "No SLA",
    after: "On pass",
    afterNext: "Go to next checkpoint",
    afterTask: "Create the next-phase agent task",
    afterBaseline: "Baseline the version",
    afterHint: "e.g. once the PRD passes, the leader opens a design task linked to the baselined PRD.",
    nextTask: "Next task title",
    nextTaskPh: "Write the technical design for {title}",
    nextTaskHint: "{title} is the title of the doc that passed.",
    whoAll: "all",
    whoAny: "any one",
    whoN: (n) => `${n} people`,
    whoNone: "No approvers yet",
    aiWho: (n, score) => `${n} checks · pass from ${score}/10`,
    ruleWho: "Automatic",
    extWho: "Project repo CI",
    condLine: (parts) => `when ${parts.join("; ")}`,
    condTypeShort: (v) => `type ${v}`,
    condKwShort: (v) => `mentions ${v}`,
    condSkipShort: "skip formatting-only",
    invalid: "Not saved:",
    empty: "No review workflows yet",
    emptyHint: "Org admins or people with “Edit review workflows” create one from a preset.",
    dryTitle: "Dry-run on a doc",
    dryDesc:
      "The hub shows which checkpoints of the draft (no need to save) would run for this doc. No review is created.",
    docKey: "Doc key",
    run: "Dry-run",
    running: "Running…",
    close: "Close",
    docType: "Doc type",
    notMatched: "The doc key matches none of the workflow's prefixes, so the doc would not enter this workflow.",
    runs: "Runs",
    skips: "Skipped",
    dryGates: "Checkpoints for this doc",
    presetTitle: (name) => `Use the ${name} preset?`,
    presetBody:
      "The current phases and checkpoints are replaced. Running reviews change only when you save Phases and checkpoints.",
    presetApply: "Use preset",
    cancel: "Cancel",
    removeTitle: "Delete workflow?",
    removeBody: (name, n) =>
      `“${name}” will be deleted${n ? `; ${n} reviews are in flight on it` : ""}. This cannot be undone.`,
    removeConfirm: "Delete workflow",
    danger: "Danger zone",
    dangerHint: "Deleting a workflow cannot be undone.",
  },
};

export type WorkflowsText = (typeof workflowsText)["vi"];
