import type {
  CodeGateRun,
  CodeReviewDetail,
  CodeReviewFiles,
  CodeReviewStatus,
  CodeReviewSummary,
  PrFile,
} from "@xdev-hive/contracts";
import { fail, ok, type RpcHandler } from "./fake-hub.ts";

const NOW = "2026-10-13T08:00:00.000Z";
const HOUR = 3_600_000;
const uid = (n: number) => `4e4e4e4e-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (c: string) => c.repeat(40);

export const REVIEW_PAY = uid(1);
export const REVIEW_LEGACY = uid(2);
export const REVIEW_BIG = uid(3);
export const REVIEW_DONE = uid(4);
export const HEAD_PAY = sha("a");
export const NEW_HEAD_PAY = sha("b");
export const BIG_FILE_COUNT = 100;

const PATCH = [
  "@@ -9,3 +9,4 @@",
  " function refund(order) {",
  "-  return order.total;",
  "+  const left = order.total - order.fee;",
  "+  return Math.min(left, order.amount);",
  " }",
].join("\n");

const file = (path: string, over: Partial<PrFile> = {}): PrFile => ({
  path,
  previousPath: null,
  status: "modified",
  additions: 2,
  deletions: 1,
  patch: PATCH,
  truncated: false,
  ...over,
});

const gate = (over: Partial<CodeGateRun> & Pick<CodeGateRun, "gateId" | "kind">): CodeGateRun => ({
  name: over.gateId,
  phase: "Quy trình",
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
  startedAt: NOW,
  finishedAt: NOW,
  reviewers: [],
  commands: [],
  ci: null,
  ...over,
});

const ruleGate = gate({
  gateId: "rules",
  name: "Kiểm tự động",
  kind: "rule",
  checklist: [{ label: "Số file đổi trong giới hạn", passed: true, note: null }],
});
const aiGate = gate({
  gateId: "ai",
  name: "Review AI",
  kind: "ai",
  index: 1,
  score: 8,
  reviewers: [
    {
      cli: "claude",
      model: "claude-opus-5-5",
      runId: uid(90),
      state: "done",
      score: 8,
      passed: true,
      summary: "Logic hoàn tiền đúng, thiếu test biên.",
      findings: [
        { file: "src/refund.ts", line: 11, severity: "major", message: "Chưa chặn tổng hoàn vượt số tiền gốc." },
      ],
      checklist: [{ label: "Có test", passed: false, note: "Thiếu ca hoàn hai lần" }],
      error: null,
    },
  ],
});
const humanGate = (over: Partial<CodeGateRun> = {}) =>
  gate({
    gateId: "po",
    name: "Product owner duyệt",
    kind: "human",
    index: 2,
    status: "waiting",
    finishedAt: null,
    ...over,
  });

const waitingGate = (dueInHours: number | null, sla: "overdue" | "due-soon" | "on-time" | "none") => ({
  id: "po",
  name: "Product owner duyệt",
  kind: "human" as const,
  phase: "Người duyệt",
  index: 2,
  total: 3,
  dueAt: dueInHours === null ? null : new Date(Date.now() + dueInHours * HOUR).toISOString(),
  sla,
});

const currentGate = (quorum: number, onReject: "agent" | "author" | "previous" = "agent") => ({
  id: "po",
  name: "Product owner duyệt",
  kind: "human" as const,
  reviewers: { users: [], roles: ["team-member" as const], teams: [], quorum },
  conditions: { docTypes: [], keywords: [], minChangedLines: null, skipFormattingOnly: false },
  slaHours: 24,
  onReject,
  onPass: "next" as const,
});

const detail = (over: Partial<CodeReviewDetail> & Pick<CodeReviewDetail, "id">): CodeReviewDetail => ({
  project: { id: uid(50), key: "payment-api", name: "Payment API" },
  task: { id: uid(51), key: "PAY-142", title: "Hoàn tiền một phần" },
  pr: {
    number: 128,
    url: "https://github.com/acme/pay/pull/128",
    branch: "ai/PAY-142",
    baseBranch: "main",
    headSha: HEAD_PAY,
  },
  workflow: { id: uid(52), name: "Code cơ bản" },
  status: "in_review",
  round: 1,
  gate: waitingGate(14, "on-time"),
  requester: { userId: "u9", name: "Lan" },
  awaitingMe: true,
  aiScore: 8,
  addedLines: 4,
  deletedLines: 2,
  changedFiles: 2,
  createdAt: NOW,
  updatedAt: NOW,
  runId: uid(60),
  runReasons: ["Đụng đường dẫn payments/**"],
  route: null,
  agentRevisions: 0,
  maxAgentRevisions: 2,
  mergeMode: "manual",
  inMergeQueue: false,
  gates: [ruleGate, aiGate, humanGate({ dueAt: waitingGate(14, "on-time").dueAt, sla: "on-time" })],
  rounds: [{ id: over.id, round: 1, headSha: HEAD_PAY, status: "in_review", runId: uid(60), createdAt: NOW }],
  currentGate: currentGate(2),
  previousGate: "ai",
  canDecide: true,
  canOverride: false,
  canEnqueue: false,
  canRecheck: false,
  ...over,
});

const summary = (d: CodeReviewDetail): CodeReviewSummary => ({
  id: d.id,
  project: d.project,
  task: d.task,
  pr: d.pr,
  workflow: d.workflow,
  status: d.status,
  round: d.round,
  gate: d.gate,
  requester: d.requester,
  awaitingMe: d.awaitingMe,
  aiScore: d.aiScore,
  addedLines: d.addedLines,
  deletedLines: d.deletedLines,
  changedFiles: d.changedFiles,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

/**
 * Bốn phiên review code cho tab Code của "Chờ tôi duyệt" (spec 009, T032): PR cần hai người duyệt, PR của người khác
 * (không đủ quyền quyết), PR 100 file (SC-007) và PR đã duyệt chờ đưa vào hàng merge. `state` ghi lại mọi quyết định
 * để test đọc lại, và `behavior` cho test ép hub từ chối. Gộp `rpc` sau route của `reviewsFixture().rpc`.
 */
export function codeReviewsFixture() {
  const sessions: Record<string, CodeReviewDetail> = {
    [REVIEW_PAY]: detail({ id: REVIEW_PAY }),
    [REVIEW_LEGACY]: detail({
      id: REVIEW_LEGACY,
      task: { id: uid(53), key: "PAY-150", title: "Đối soát ngày công" },
      pr: {
        number: 131,
        url: "https://github.com/acme/pay/pull/131",
        branch: "ai/PAY-150",
        baseBranch: "main",
        headSha: sha("c"),
      },
      requester: null,
      awaitingMe: false,
      canDecide: false,
      gate: waitingGate(-3, "overdue"),
      gates: [ruleGate, aiGate, humanGate({ dueAt: waitingGate(-3, "overdue").dueAt, sla: "overdue" })],
      rounds: [{ id: REVIEW_LEGACY, round: 1, headSha: sha("c"), status: "in_review", runId: uid(60), createdAt: NOW }],
    }),
    [REVIEW_BIG]: detail({
      id: REVIEW_BIG,
      task: { id: uid(54), key: "PAY-160", title: "Tách module thanh toán" },
      pr: {
        number: 140,
        url: "https://github.com/acme/pay/pull/140",
        branch: "ai/PAY-160",
        baseBranch: "main",
        headSha: sha("d"),
      },
      changedFiles: BIG_FILE_COUNT,
      addedLines: BIG_FILE_COUNT * 2,
      deletedLines: BIG_FILE_COUNT,
      currentGate: currentGate(1, "previous"),
      rounds: [{ id: REVIEW_BIG, round: 1, headSha: sha("d"), status: "in_review", runId: uid(60), createdAt: NOW }],
    }),
    [REVIEW_DONE]: detail({
      id: REVIEW_DONE,
      task: { id: uid(55), key: "PAY-120", title: "Báo cáo hoàn tiền" },
      pr: {
        number: 121,
        url: "https://github.com/acme/pay/pull/121",
        branch: "ai/PAY-120",
        baseBranch: "main",
        headSha: sha("e"),
      },
      status: "approved",
      gate: null,
      currentGate: null,
      awaitingMe: false,
      canDecide: false,
      canEnqueue: true,
      gates: [ruleGate, aiGate, humanGate({ status: "passed", finishedAt: NOW })],
      rounds: [{ id: REVIEW_DONE, round: 1, headSha: sha("e"), status: "approved", runId: uid(60), createdAt: NOW }],
    }),
  };

  const filesOf = (id: string): CodeReviewFiles => {
    const d = sessions[id];
    if (!d) throw new Error(`Không có phiên ${id}`);
    const headSha = state.latestHead ?? d.pr.headSha;
    if (id === REVIEW_BIG)
      return {
        headSha,
        files: Array.from({ length: BIG_FILE_COUNT }, (_, i) =>
          file(`src/modules/m${String(i).padStart(3, "0")}/index.ts`),
        ),
        truncated: false,
      };
    return {
      headSha,
      files: [file("src/refund.ts"), file("src/big.ts", { patch: null, truncated: true })],
      truncated: false,
    };
  };

  const state = {
    decisions: [] as { id: string; headSha: string; decision: string; note?: string; route?: string }[],
    enqueued: [] as string[],
    /** Đặt để lần quyết định kế tiếp bị hub từ chối với lỗi này. */
    rejectDecision: null as { code: string; status: number; message: string } | null,
    /** Đặt để hub báo PR đã có commit mới ở lần quyết định kế tiếp. */
    headMoved: false,
    /** Đầu PR mới nhất mà `codeReviews/files` báo; khác đầu của phiên thì khung hiện cảnh báo commit mới. */
    latestHead: null as string | null,
  };

  const awaiting = () => Object.values(sessions).filter((d) => d.awaitingMe && d.status === "in_review").length;

  const rpc: Record<string, RpcHandler> = {
    "codeReviews/list": (input) => {
      const { scope, status } = input as { scope?: "mine" | "all"; status?: CodeReviewStatus };
      const rows = Object.values(sessions)
        .filter((d) => (scope === "all" ? true : d.awaitingMe))
        .filter((d) => !status || d.status === status)
        .map(summary);
      return ok({ items: rows, nextCursor: null });
    },
    "codeReviews/count": () => ok({ awaitingMe: awaiting() }),
    "codeReviews/get": (input) => {
      const d = sessions[(input as { id: string }).id];
      return d ? ok(d) : fail("NOT_FOUND", 404, "Không tìm thấy phiên review.");
    },
    "codeReviews/files": (input) => {
      const { id } = input as { id: string };
      return sessions[id] ? ok(filesOf(id)) : fail("NOT_FOUND", 404, "Không tìm thấy phiên review.");
    },
    "codeReviews/decide": (input) => {
      const i = input as {
        id: string;
        headSha: string;
        decision: "approve" | "changes";
        note?: string;
        route?: "agent" | "author" | "previous";
      };
      const d = sessions[i.id];
      if (!d) return fail("NOT_FOUND", 404, "Không tìm thấy phiên review.");
      if (state.rejectDecision) {
        const { code, status, message } = state.rejectDecision;
        return fail(code, status, message);
      }
      if (state.headMoved || i.headSha !== d.pr.headSha)
        return fail("CONFLICT", 409, "PR đã có commit mới. Tải lại để xem rồi quyết định lại.");
      if (!d.canDecide) return fail("FORBIDDEN", 403, "Bạn không phải người duyệt ở checkpoint này.");
      state.decisions.push({
        id: i.id,
        headSha: i.headSha,
        decision: i.decision,
        ...(i.note ? { note: i.note } : {}),
        ...(i.route ? { route: i.route } : {}),
      });
      if (i.decision === "changes") {
        sessions[i.id] = {
          ...d,
          status: "changes_requested",
          gate: null,
          currentGate: null,
          awaitingMe: false,
          canDecide: false,
          route: i.route ?? d.currentGate?.onReject ?? "agent",
        };
      } else {
        const quorum = d.currentGate?.reviewers?.quorum ?? 1;
        const human = d.gates.find((g) => g.gateId === "po");
        const approvals = [...(human?.approvals ?? []), { userId: "u1", name: "Trần Đức Duy", at: NOW }];
        const reached = approvals.length >= quorum;
        sessions[i.id] = {
          ...d,
          status: reached ? "approved" : "in_review",
          gate: reached ? null : d.gate,
          currentGate: reached ? null : d.currentGate,
          awaitingMe: false,
          canDecide: false,
          gates: d.gates.map((g) =>
            g.gateId === "po"
              ? { ...g, approvals, ...(reached ? { status: "passed" as const, finishedAt: NOW } : {}) }
              : g,
          ),
        };
      }
      return ok(sessions[i.id]);
    },
    "codeReviews/enqueue": (input) => {
      const { id } = input as { id: string };
      const d = sessions[id];
      if (!d) return fail("NOT_FOUND", 404, "Không tìm thấy phiên review.");
      state.enqueued.push(id);
      sessions[id] = { ...d, inMergeQueue: true, canEnqueue: false };
      return ok(sessions[id]);
    },
  };

  return { state, rpc, sessions };
}
