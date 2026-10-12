import type { Page } from "@playwright/test";
import {
  type DryRunResult,
  type ReviewDetail,
  type ReviewSummary,
  type ReviewWorkflow,
  reviewPhase,
  SYSTEM_ROLE_PERMISSIONS,
  WORKFLOW_PRESETS,
  type WorkflowInput,
} from "@xdev-hive/contracts";
import { type FakeHub, fail, fakeHub, ok, type RpcHandler } from "./fake-hub.ts";

export const ORG_ID = "0a0a0a0a-0000-4000-8000-00000000000a";
const NOW = "2026-10-12T08:00:00.000Z";
const HOUR = 3_600_000;
export const TEAM_ID = "5a5a5a5a-0000-4000-8000-000000000001";
export const PRD_WORKFLOW_ID = "3c3c3c3c-0000-4000-8000-000000000001";
export const REVIEW_PRD = "4d4d4d4d-0000-4000-8000-000000000001";
export const REVIEW_DESIGN = "4d4d4d4d-0000-4000-8000-000000000002";
const REVIEW_ADR = "4d4d4d4d-0000-4000-8000-000000000003";
const REVIEW_RUNBOOK = "4d4d4d4d-0000-4000-8000-000000000004";
const RUN_ID = "6e6e6e6e-0000-4000-8000-000000000001";

const members = [
  {
    userId: "u-lan",
    name: "Trần Lan",
    email: "lan@acme.vn",
    image: null,
    role: "member",
    status: "active",
    joinedAt: NOW,
    teams: [],
  },
  {
    userId: "u-ha",
    name: "Phạm Hà",
    email: "ha@acme.vn",
    image: null,
    role: "member",
    status: "active",
    joinedAt: NOW,
    teams: [],
  },
];
const teams = [
  { id: TEAM_ID, slug: "pay", name: "Thanh toán", color: null, createdAt: NOW, systemCount: 0, memberCount: 2 },
];

export type Role = "owner" | "admin" | "member";

/** Hub giả trong một tổ chức với vai trò cho trước; `mine` là quyền hiệu lực (mặc định theo vai trò hệ thống). */
export async function inOrg(
  page: Page,
  role: Role,
  rpc: Record<string, RpcHandler>,
  mine: string[] = [...SYSTEM_ROLE_PERMISSIONS[role]],
): Promise<FakeHub> {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_ID);
  return fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [
            { id: ORG_ID, slug: "acme", name: "Acme", role, emailDomain: null, createdAt: "2026-10-01T00:00:00.000Z" },
          ],
          canCreateOrg: false,
        }),
      "inbox/unreadCount": () => ok({ count: 0 }),
      "roles/mine": () => ok({ permissions: mine }),
      "teams/list": () => ok(teams),
      "orgMembers/list": () => ok(members),
      ...rpc,
    },
  });
}

/** Quy trình "PRD chuẩn" theo khung AI-DLC; save giữ input để test đọc lại, dryRun mô phỏng điều kiện từ khoá. */
export function workflowsFixture() {
  const prd: ReviewWorkflow = {
    id: PRD_WORKFLOW_ID,
    name: "PRD chuẩn",
    preset: "aidlc",
    teamId: TEAM_ID,
    docPrefixes: ["project/payment-api/prd"],
    phases: WORKFLOW_PRESETS.aidlc.map((p) => reviewPhase.parse(p)),
    enabled: true,
    updatedAt: NOW,
    updatedBy: "u1",
    inFlight: 2,
  };
  const state = {
    workflows: [prd] as ReviewWorkflow[],
    saved: [] as WorkflowInput[],
    removed: [] as string[],
    dryRuns: [] as { workflow: WorkflowInput; docKey: string }[],
    /** Đặt để lần lưu kế tiếp bị hub từ chối với câu này. */
    saveConflict: null as string | null,
  };
  const rpc: Record<string, RpcHandler> = {
    "reviewWorkflows/list": () => ok(state.workflows),
    "reviewWorkflows/save": (input) => {
      const i = input as WorkflowInput;
      state.saved.push(i);
      if (state.saveConflict) return fail("CONFLICT", 409, state.saveConflict);
      const saved = {
        ...(i as ReviewWorkflow),
        id: i.id ?? `3c3c3c3c-0000-4000-8000-00000000000${state.workflows.length + 1}`,
        updatedAt: "2026-10-12T09:00:00.000Z",
        updatedBy: "u1",
        inFlight: state.workflows.find((w) => w.id === i.id)?.inFlight ?? 0,
      };
      state.workflows = state.workflows.some((w) => w.id === saved.id)
        ? state.workflows.map((w) => (w.id === saved.id ? saved : w))
        : [...state.workflows, saved];
      return ok(saved);
    },
    "reviewWorkflows/remove": (input) => {
      const { id } = input as { id: string };
      state.removed.push(id);
      state.workflows = state.workflows.filter((w) => w.id !== id);
      return ok({ ok: true });
    },
    "reviewWorkflows/dryRun": (input) => {
      const i = input as { workflow: WorkflowInput; docKey: string };
      state.dryRuns.push(i);
      const result: DryRunResult = {
        docKey: i.docKey,
        docType: i.docKey.split("/").at(-1) ?? "",
        matched: i.workflow.docPrefixes.some((p) => i.docKey.startsWith(p)),
        gates: i.workflow.phases.flatMap((p) =>
          p.gates.map((g) => {
            const keywords = g.conditions?.keywords ?? [];
            const runs = keywords.length === 0;
            return {
              gateId: g.id,
              name: g.name,
              kind: g.kind,
              runs,
              reason: runs ? "Không có điều kiện; luôn chạy." : `Không có từ khoá ${keywords.join(", ")}.`,
              checklist:
                g.kind === "rule"
                  ? [
                      { label: "R-1 có tiêu chí chấp nhận", passed: true, note: null },
                      { label: "R-3 có tiêu chí chấp nhận", passed: false, note: "Mục 3 chưa nhắc R-3." },
                    ]
                  : [],
            };
          }),
        ),
      };
      return ok(result);
    },
  };
  return { state, rpc };
}

const summary = (patch: Partial<ReviewSummary> & Pick<ReviewSummary, "id" | "docKey" | "docTitle">): ReviewSummary => ({
  proposalId: "7f7f7f7f-0000-4000-8000-000000000001",
  docType: "prd",
  workflowId: PRD_WORKFLOW_ID,
  workflowName: "PRD chuẩn",
  status: "in_review",
  gate: null,
  author: { userId: "u-lan", runId: null, name: "Trần Lan" },
  awaitingMe: true,
  aiScore: null,
  addedLines: 0,
  deletedLines: 0,
  createdAt: NOW,
  updatedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
  ...patch,
});

const BASE = `# Hoàn tiền một phần

## 1. Mục tiêu
Cho phép hoàn một phần số tiền đã thu.

## 2. Yêu cầu
R-1: API nhận số tiền hoàn nhỏ hơn số tiền gốc.
R-2: Tổng các lần hoàn phải nhỏ hơn số tiền gốc.
R-3: Mỗi lần hoàn ghi một dòng đối soát.

## 4. Ngoài phạm vi
Hoàn tiền bằng tiền mặt.
Hoàn tiền cho giao dịch quá 180 ngày.
Đổi tiền tệ khi hoàn.
Hoàn tiền thủ công qua tổng đài.
`;
const NEXT = BASE.replace(
  "R-2: Tổng các lần hoàn phải nhỏ hơn số tiền gốc.",
  "R-2: Tổng các lần hoàn không được vượt số tiền gốc trừ phí đã thu; nếu vượt, API trả lỗi BILL-409.",
).replace(
  "## 4. Ngoài phạm vi",
  "## 3. Tiêu chí chấp nhận\n- Hoàn 2 lần 50% thì lần thứ 3 bị chặn với BILL-409.\n- Đối soát cuối ngày khớp tổng tiền hoàn.\n\n## 4. Ngoài phạm vi",
);

const gateRun = (
  patch: Partial<ReviewDetail["gates"][number]> &
    Pick<ReviewDetail["gates"][number], "gateId" | "name" | "kind" | "phase">,
) => ({
  status: "waiting" as const,
  score: null,
  checklist: [],
  approvals: [],
  note: null,
  decidedBy: null,
  startedAt: null,
  finishedAt: null,
  runId: null,
  ...patch,
});

/** Hàng chờ duyệt: PRD (AI đã chấm, chờ PO), thiết kế quá hạn (về được checkpoint trước), ADR đã xong. */
export function reviewsFixture() {
  const prd = summary({
    id: REVIEW_PRD,
    docKey: "project/payment-api/prd",
    docTitle: "Hoàn tiền một phần",
    gate: {
      id: "po",
      name: "Product owner duyệt",
      kind: "human",
      phase: "Inception",
      index: 1,
      total: 7,
      dueAt: new Date(Date.now() + 14 * HOUR).toISOString(),
      sla: "on-time",
    },
    author: { userId: null, runId: RUN_ID, name: "Claude (gói Max)" },
    aiScore: 8.5,
    addedLines: 5,
    deletedLines: 1,
  });
  const design = summary({
    id: REVIEW_DESIGN,
    docKey: "project/hive-worker/design",
    docTitle: "Thiết kế kênh WebSocket qua proxy",
    docType: "design",
    gate: {
      id: "design",
      name: "Kiến trúc sư duyệt thiết kế",
      kind: "human",
      phase: "Construction",
      index: 3,
      total: 7,
      dueAt: new Date(Date.now() - 3 * HOUR).toISOString(),
      sla: "overdue",
    },
    author: { userId: "u-ha", runId: null, name: "Phạm Hà" },
    addedLines: 40,
    deletedLines: 12,
  });
  const adr = summary({
    id: REVIEW_ADR,
    docKey: "project/xdev-hive/adr-012",
    docTitle: "ADR-012: Lưu skill trong Git",
    docType: "adr",
    status: "approved",
    awaitingMe: false,
    addedLines: 20,
    deletedLines: 0,
  });
  const runbook = summary({
    id: REVIEW_RUNBOOK,
    docKey: "project/payment-api/runbook",
    docTitle: "Runbook sự cố VNPAY",
    docType: "runbook",
    gate: {
      id: "ops",
      name: "Trực vận hành duyệt runbook",
      kind: "human",
      phase: "Operations",
      index: 6,
      total: 7,
      dueAt: new Date(Date.now() + 5 * HOUR).toISOString(),
      sla: "due-soon",
    },
    addedLines: 3,
    deletedLines: 3,
  });
  const gatesOf = (current: string): ReviewDetail["gates"] => {
    const all = [
      gateRun({
        gateId: "ai-prd",
        name: "AI kiểm đủ mục PRD",
        kind: "ai",
        phase: "Inception",
        status: "passed",
        score: 8.5,
        checklist: [
          { label: "Đủ 6/6 mục theo mẫu PRD", passed: true, note: null },
          { label: "Mỗi R-n có tiêu chí chấp nhận", passed: true, note: null },
          {
            label: "Chưa nêu giới hạn số lần hoàn trong một ngày",
            passed: false,
            note: "Mục 2 thiếu giới hạn theo ngày.",
          },
        ],
        runId: RUN_ID,
      }),
      gateRun({ gateId: "po", name: "Product owner duyệt", kind: "human", phase: "Inception" }),
      gateRun({ gateId: "legal", name: "Pháp chế", kind: "human", phase: "Inception" }),
      gateRun({ gateId: "design", name: "Kiến trúc sư duyệt thiết kế", kind: "human", phase: "Construction" }),
      gateRun({ gateId: "trace", name: "Truy vết R-n → tiêu chí", kind: "rule", phase: "Construction" }),
      gateRun({ gateId: "ci", name: "CI của repo xanh", kind: "ext", phase: "Operations" }),
      gateRun({ gateId: "ops", name: "Trực vận hành duyệt runbook", kind: "human", phase: "Operations" }),
    ];
    const at = all.findIndex((g) => g.gateId === current);
    return all.map((g, i) =>
      i < at && g.status === "waiting"
        ? {
            ...g,
            status: g.gateId === "legal" ? "skipped" : "passed",
            decidedBy: g.kind === "human" ? "Nguyễn Minh" : null,
          }
        : g,
    );
  };
  const details: Record<string, ReviewDetail> = {
    [REVIEW_PRD]: {
      ...prd,
      baseVersion: 2,
      baseContent: BASE,
      content: NEXT,
      reason: "Thêm tiêu chí chấp nhận cho hoàn nhiều lần.",
      gates: gatesOf("po"),
      trace: [
        {
          id: "R-1",
          text: "API nhận số tiền hoàn nhỏ hơn số tiền gốc.",
          acceptance: ["Hoàn 2 lần 50% thì lần thứ 3 bị chặn với BILL-409."],
          tasks: [{ key: "TASK-45", title: "API hoàn tiền", status: "done" }],
        },
        {
          id: "R-2",
          text: "Tổng các lần hoàn không vượt số tiền gốc trừ phí.",
          acceptance: ["Hoàn 2 lần 50% thì lần thứ 3 bị chặn với BILL-409."],
          tasks: [
            { key: "TASK-45", title: "API hoàn tiền", status: "done" },
            { key: "TASK-47", title: "Đối soát", status: "in_progress" },
          ],
        },
        { id: "R-3", text: "Mỗi lần hoàn ghi một dòng đối soát.", acceptance: [], tasks: [] },
      ],
      canDecide: true,
      previousGate: null,
    },
    [REVIEW_DESIGN]: {
      ...design,
      baseVersion: 0,
      baseContent: "",
      content: "# Thiết kế kênh WebSocket qua proxy\n\nWorker giữ một kết nối WebSocket tới hub qua proxy công ty.\n",
      reason: null,
      gates: gatesOf("design"),
      trace: [],
      canDecide: true,
      previousGate: "po",
    },
    [REVIEW_ADR]: {
      ...adr,
      baseVersion: 1,
      baseContent: "# ADR-012\n",
      content: "# ADR-012\n\nQuyết định: lưu skill trong Git.\n",
      reason: null,
      gates: gatesOf("@done").map((g) => ({ ...g, status: g.status === "waiting" ? "passed" : g.status })),
      trace: [],
      canDecide: false,
      previousGate: null,
    },
    [REVIEW_RUNBOOK]: {
      ...runbook,
      baseVersion: 3,
      baseContent: "# Runbook\n",
      content: "# Runbook VNPAY\n",
      reason: null,
      gates: gatesOf("ops"),
      trace: [],
      canDecide: false,
      previousGate: "ci",
    },
  };
  const state = {
    decisions: [] as { id: string; decision: "approve" | "changes"; note?: string; route?: string }[],
    /** Đặt để lần quyết định kế tiếp bị hub từ chối với câu này. */
    decideConflict: null as string | null,
  };
  const rpc: Record<string, RpcHandler> = {
    "reviews/list": (input) => {
      const i = input as { scope?: "mine" | "all"; status?: string; cursor?: string };
      if (i.cursor === "p2") return ok({ items: [runbook], nextCursor: null });
      const all = [prd, design, adr].filter((r) => (i.scope === "all" ? true : r.awaitingMe));
      const items = i.status ? all.filter((r) => r.status === i.status) : all;
      return ok({ items, nextCursor: i.scope === "all" || i.status ? null : "p2" });
    },
    "reviews/get": (input) => {
      const d = details[(input as { id: string }).id];
      return d ? ok(d) : fail("NOT_FOUND", 404, "Không tìm thấy phiên duyệt.");
    },
    "reviews/decide": (input) => {
      const i = input as (typeof state.decisions)[number];
      state.decisions.push(i);
      if (state.decideConflict) return fail("CONFLICT", 409, state.decideConflict);
      const d = details[i.id];
      if (!d) return fail("NOT_FOUND", 404, "Không tìm thấy phiên duyệt.");
      const next: ReviewDetail =
        i.decision === "approve"
          ? {
              ...d,
              gates: gatesOf("legal"),
              gate: d.gate && { ...d.gate, id: "legal", name: "Pháp chế", index: 2 },
              awaitingMe: false,
              canDecide: false,
            }
          : {
              ...d,
              status: "changes_requested",
              gates: d.gates.map((g) =>
                g.gateId === d.gate?.id
                  ? { ...g, status: "failed", note: i.note ?? null, decidedBy: "Trần Đức Duy" }
                  : g,
              ),
              gate: null,
              awaitingMe: false,
              canDecide: false,
            };
      details[i.id] = next;
      const row = [prd, design, adr, runbook].find((r) => r.id === i.id);
      if (row) Object.assign(row, { status: next.status, gate: next.gate, awaitingMe: false });
      return ok(next);
    },
  };
  return { state, rpc, details };
}
