import { type Deploy, deploy } from "@xdev-hive/contracts";
// Fixture tự chứa vì fake-hub nạp các fixture này; import ngược sẽ tạo vòng phụ thuộc.
export type DeliveryApprovalsHandler = (input: unknown) => { status: number; json: unknown };
const ok = (value: unknown) => ({ status: 200, json: { json: value } });
const fail = (code: string, status: number, message: string, data?: unknown) => ({
  status,
  json: { json: { defined: true, code, status, message, ...(data === undefined ? {} : { data }) } },
});

/** Mặc định không có lần nào chờ duyệt: fake-hub nạp hàm này vào mọi spec. */
export function deliveryApprovalsDefaults(): Record<string, DeliveryApprovalsHandler> {
  return { "deploys/approvals/pending": () => ok([]) };
}

const SYSTEM_ID = "7c7c7c7c-0000-4000-8000-000000000001";
const ENV_PROD = "8d8d8d8d-0000-4000-8000-000000000002";
const PROJECT_PAY = "9e9e9e9e-0000-4000-8000-000000000001";
const PROJECT_RPT = "9e9e9e9e-0000-4000-8000-000000000002";
/** Cần một lượt duyệt, chưa ai duyệt. */
export const APPROVAL_PAY = "c0c0c0c0-0000-4000-8000-000000000001";
/** Cần hai lượt duyệt, đã có một. */
export const APPROVAL_RPT = "c0c0c0c0-0000-4000-8000-000000000002";

const NOW = Date.parse("2026-10-20T03:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const lan = { userId: "u2", name: "Lê Thị Lan" };

function pending(id: string, projectId: string, method: Deploy["method"], approval: Deploy["approval"]): Deploy {
  return deploy.parse({
    id,
    targetId: id,
    projectId,
    environmentId: ENV_PROD,
    systemId: SYSTEM_ID,
    method,
    origin: "hive",
    state: "pending_approval",
    version: {
      commit: "3f9c2ab71d5e4c08a6b2f1e0d9c8b7a6f5e4d3c2",
      tag: null,
      jenkinsBuild: null,
      image: null,
      images: [],
      revision: null,
    },
    requestedBy: lan,
    triggeredBy: null,
    steps: [],
    configVersion: 1,
    rollbackOf: null,
    skipBackup: null,
    external: null,
    health: null,
    approval,
    runner: { mode: "worker", machine: null, waiting: null },
    createdAt: at(10),
    startedAt: null,
    finishedAt: null,
  });
}

export interface DeliveryApprovalsOptions {
  /** Lần duyệt kế tiếp trả lỗi này, như khi người khác vừa quyết. */
  failNext?: { code: string; status: number; message: string; data?: unknown };
}

/** Hub giả cho trang Duyệt triển khai (specs/032). `state.calls` để test đọc lại thứ đã gửi. */
export function deliveryApprovalsFixture(options: DeliveryApprovalsOptions = {}) {
  const state = {
    pending: [
      pending(APPROVAL_PAY, PROJECT_PAY, "jenkins-job", { required: 1, expiresAt: at(-60 * 24), decisions: [] }),
      pending(APPROVAL_RPT, PROJECT_RPT, "argocd", {
        required: 2,
        expiresAt: at(-60 * 24),
        decisions: [{ by: { userId: "u3", name: "Phạm Minh" }, decision: "approve", reason: null, at: at(5) }],
      }),
    ],
    calls: [] as { path: string; input: unknown }[],
    failNext: options.failNext ?? null,
  };
  const record = (path: string, input: unknown) => state.calls.push({ path, input });
  const decide = (path: string, input: unknown, next: Deploy["state"]) => {
    record(path, input);
    const { id } = input as { id: string };
    const found = state.pending.find((d) => d.id === id);
    if (state.failNext) {
      const { code, status, message, data } = state.failNext;
      state.failNext = null;
      state.pending = state.pending.filter((d) => d.id !== id);
      return fail(code, status, message, data);
    }
    if (!found) return fail("NOT_FOUND", 404, "Không tìm thấy lần triển khai.");
    state.pending = state.pending.filter((d) => d.id !== id);
    return ok({ ...found, state: next });
  };

  const rpc: Record<string, DeliveryApprovalsHandler> = {
    "projects/list": () =>
      ok([
        { id: PROJECT_PAY, teamId: null, name: "Cổng thanh toán", key: "pay", createdAt: at(3000) },
        { id: PROJECT_RPT, teamId: null, name: "Báo cáo", key: "rpt", createdAt: at(3000) },
      ]),
    "environments/list": () =>
      ok([
        {
          id: ENV_PROD,
          systemId: SYSTEM_ID,
          name: "prod",
          position: 0,
          policy: { deployRoles: [], approveRoles: [], approvals: 1, approvalTtlHours: 24 },
          lock: null,
          runner: { mode: "worker", machines: [], requireLabel: false },
          createdAt: at(3000),
          updatedAt: at(3000),
        },
      ]),
    "deploys/approvals/pending": () => ok(state.pending),
    "deploys/approvals/approve": (input) => decide("deploys/approvals/approve", input, "queued"),
    "deploys/approvals/reject": (input) => decide("deploys/approvals/reject", input, "rejected"),
  };
  return { rpc, state };
}
