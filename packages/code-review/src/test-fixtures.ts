import type { CodeGateRun, CodeReviewDetail, CodeReviewFiles, PrFile } from "@xdev-hive/contracts";

export const HEAD = "7ff9637aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const NEW_HEAD = "a91c3d2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const at = "2026-10-13T00:00:00.000Z";
const uid = (n: number) => `0a0a0a0a-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const gate = (over: Partial<CodeGateRun> & Pick<CodeGateRun, "gateId" | "kind">): CodeGateRun => ({
  name: over.gateId,
  phase: "p",
  index: 0,
  status: "passed",
  score: null,
  checklist: [],
  approvals: [],
  note: null,
  decidedBy: null,
  overridden: false,
  dueAt: null,
  sla: "none",
  startedAt: at,
  finishedAt: at,
  reviewers: [],
  commands: [],
  ci: null,
  ...over,
});

export const aiGate = gate({
  gateId: "ai",
  name: "Review AI",
  kind: "ai",
  score: 8,
  reviewers: [
    {
      cli: "claude",
      model: "claude-opus-5-5",
      runId: uid(9),
      state: "done",
      score: 8,
      passed: true,
      summary: "Logic hoàn tiền đúng, thiếu test biên.",
      findings: [
        { file: "src/refund.ts", line: 11, severity: "major", message: "Chưa chặn tổng hoàn vượt số tiền gốc." },
        { file: "src/refund.ts", line: null, severity: "info", message: "Nên tách hàm." },
      ],
      checklist: [
        { label: "Có test", passed: false, note: "Thiếu ca hoàn hai lần" },
        { label: "Không lộ bí mật", passed: true, note: null },
      ],
      error: null,
    },
  ],
});

export const ruleGate = gate({
  gateId: "rules",
  name: "Kiểm tự động",
  kind: "rule",
  checklist: [{ label: "Số file đổi: 4 (tối đa 40)", passed: true, note: null }],
  commands: [{ run: "pnpm test", exit: 0, durationMs: 41_200, tail: "Tests  12 passed" }],
});

export const humanGate = gate({
  gateId: "po",
  name: "PO duyệt",
  kind: "human",
  status: "waiting",
  startedAt: at,
  finishedAt: null,
  approvals: [{ userId: "u1", name: "An", at }],
});

export const detail = (over: Partial<CodeReviewDetail> = {}): CodeReviewDetail => ({
  id: uid(1),
  project: { id: uid(2), key: "payment-api", name: "Payment API" },
  task: { id: uid(3), key: "PAY-142", title: "Hoàn tiền một phần" },
  pr: {
    number: 128,
    url: "https://github.com/acme/pay/pull/128",
    branch: "ai/PAY-142",
    baseBranch: "main",
    headSha: HEAD,
  },
  workflow: { id: uid(4), name: "Code cơ bản" },
  status: "in_review",
  round: 2,
  gate: {
    id: "po",
    name: "PO duyệt",
    kind: "human",
    phase: "Người duyệt",
    index: 2,
    total: 3,
    dueAt: null,
    sla: "none",
  },
  requester: { userId: "u9", name: "Lan" },
  awaitingMe: true,
  aiScore: 8,
  addedLines: 82,
  deletedLines: 4,
  changedFiles: 2,
  createdAt: at,
  updatedAt: at,
  runId: uid(5),
  runReasons: ["Đụng đường dẫn payments/**"],
  route: null,
  agentRevisions: 0,
  maxAgentRevisions: 2,
  mergeMode: "manual",
  inMergeQueue: false,
  gates: [ruleGate, aiGate, humanGate],
  rounds: [
    { id: uid(1), round: 2, headSha: HEAD, status: "in_review", runId: uid(5), createdAt: at },
    { id: uid(6), round: 1, headSha: NEW_HEAD, status: "superseded", runId: uid(7), createdAt: at },
  ],
  currentGate: {
    id: "po",
    name: "PO duyệt",
    kind: "human",
    reviewers: { users: [], roles: ["team-member"], teams: [], quorum: 2 },
    conditions: { docTypes: [], keywords: [], minChangedLines: null, skipFormattingOnly: false },
    slaHours: null,
    onReject: "agent",
    onPass: "next",
  },
  previousGate: "ai",
  canDecide: true,
  canOverride: false,
  canEnqueue: false,
  canRecheck: false,
  ...over,
});

export const patch = [
  "@@ -9,3 +9,4 @@",
  " function refund() {",
  "-  return a;",
  "+  const b = 1;",
  "+  return b;",
  " }",
].join("\n");

export const file = (over: Partial<PrFile> = {}): PrFile => ({
  path: "src/refund.ts",
  previousPath: null,
  status: "modified",
  additions: 2,
  deletions: 1,
  patch,
  truncated: false,
  ...over,
});

export const files = (over: Partial<CodeReviewFiles> = {}): CodeReviewFiles => ({
  headSha: HEAD,
  files: [file(), file({ path: "src/big.ts", patch: null, truncated: true })],
  truncated: false,
  ...over,
});
