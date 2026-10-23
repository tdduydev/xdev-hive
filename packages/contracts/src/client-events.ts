import { z } from "zod";
import { MEMORY_MAX_CHARS, memoryKind } from "./knowledge.ts";

/**
 * Sự kiện client (specs/027 US1). Bản đầu chỉ có sự kiện máy `machine.token_score` (ADR 0036); tool MCP và thủ tục oRPC
 * vào sau theo plan của spec 027.
 */

/** Khoá chống trùng do client tạo (ULID khuyến nghị); gửi lại cùng khoá thì hub trả `duplicate`. */
export const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,64}$/, "Khoá chống trùng gồm 16–64 ký tự chữ, số, `_` hoặc `-`.");

export const clientSource = z.enum([
  "worker-run",
  "worker",
  "desktop",
  "hive-cli",
  "mcp-local",
  "vscode",
  "web",
  "unknown",
]);
export type ClientSource = z.output<typeof clientSource>;

export const clientEventOutcome = z.enum(["accepted", "duplicate", "rejected"]);
export type ClientEventOutcome = z.output<typeof clientEventOutcome>;

export const clientEventResult = z.object({
  key: idempotencyKey,
  outcome: clientEventOutcome,
  /** Mã ổn định khi bị từ chối, vd. `TOKEN_SCORE_TOO_FREQUENT`. */
  code: z.string().max(64).optional(),
  /** Lý do tiếng Việt khi bị từ chối. */
  reason: z.string().max(500).optional(),
  receivedAt: z.iso.datetime(),
});
export type ClientEventResult = z.output<typeof clientEventResult>;

// ---- Điểm tối ưu token của máy (specs/025 US6, ADR 0036) ----
// Chỉ số, enum và mã lý do cố định (specs/025 FR-015). Mọi object `strict`: thêm trường như id gói, đường dẫn hay tên
// dự án thì hub từ chối thay vì lặng lẽ bỏ, để lỗi rò dữ liệu ở client lộ ra ngay.

export const tokenScoreStatus = z.enum(["ok", "partial", "low", "unknown", "unsupported"]);
export const tokenScoreLevel = z.enum(["good", "fair", "low"]);
const reasonCode = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const percent = z.number().min(0).max(100);
const points = z.number().min(0).max(100);

export const tokenScoreCriterion = z.strictObject({
  id: z.string().regex(/^[A-Z][0-9]{1,2}$/),
  status: tokenScoreStatus,
  earned: points,
  max: points,
  value: z.number().finite().optional(),
  unit: z
    .string()
    .regex(/^[a-z_%/]{1,20}$/)
    .optional(),
  reason: reasonCode.optional(),
});
export type TokenScoreCriterion = z.output<typeof tokenScoreCriterion>;

export const tokenScoreProfile = z.strictObject({
  cli: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  score: percent.nullable(),
  coverage: percent,
  share: z.number().min(0).max(1),
  groups: z.record(z.string().regex(/^[A-Z]$/), z.strictObject({ earned: points, max: points })),
  criteria: z.array(tokenScoreCriterion).max(40),
});
export type TokenScoreProfile = z.output<typeof tokenScoreProfile>;

export const tokenScoreReport = z.strictObject({
  scoreVersion: z.number().int().min(1).max(1000),
  generatedAt: z.iso.datetime(),
  days: z.number().int().min(1).max(90),
  machine: z.strictObject({
    score: percent.nullable(),
    level: tokenScoreLevel.nullable(),
    coverage: percent,
    provisional: z.boolean(),
  }),
  profiles: z.array(tokenScoreProfile).max(20),
});
export type TokenScoreReport = z.output<typeof tokenScoreReport>;

// ---- Ngữ cảnh dùng chung (specs/029) ----
// Chỉ số, enum, uuid và ngày: payload `project.token_usage` không chứa chuỗi tự do (SC-007).

export const memoryProposePayload = z.strictObject({
  projectId: z.uuid(),
  kind: memoryKind,
  content: z.string().min(1).max(MEMORY_MAX_CHARS),
});
export type MemoryProposePayload = z.output<typeof memoryProposePayload>;

export const projectTokenUsagePolicyDrift = z.enum([
  "level",
  "rtk",
  "codegraph",
  "autoCompactWindow",
  "contextBudgetTokens",
  "memoryAutoSync",
]);

const tokenCount = z.number().int().nonnegative();

export const projectTokenUsagePayload = z.strictObject({
  projectId: z.uuid(),
  periodStart: z.iso.datetime(),
  periodEnd: z.iso.datetime(),
  tokens: z.partialRecord(
    z.enum(["claude", "codex"]),
    z.strictObject({
      input: tokenCount,
      output: tokenCount,
      cacheRead: tokenCount,
      weighted: z.number().nonnegative(),
    }),
  ),
  sessions: tokenCount,
  score: z.number().int().min(0).max(100).nullable(),
  policyDrift: z.array(projectTokenUsagePolicyDrift),
});
export type ProjectTokenUsagePayload = z.output<typeof projectTokenUsagePayload>;

/** Sự kiện máy gửi lên `POST /v1/client-events`. Danh tính lấy từ token của máy, không lấy từ body. */
export const machineEventInput = z.discriminatedUnion("kind", [
  z.strictObject({
    key: idempotencyKey,
    kind: z.literal("machine.token_score"),
    createdAt: z.iso.datetime(),
    payload: tokenScoreReport,
  }),
  z.strictObject({
    key: idempotencyKey,
    kind: z.literal("memory.propose"),
    createdAt: z.iso.datetime(),
    payload: memoryProposePayload,
  }),
  z.strictObject({
    key: idempotencyKey,
    kind: z.literal("project.token_usage"),
    createdAt: z.iso.datetime(),
    payload: projectTokenUsagePayload,
  }),
]);
export type MachineEventInput = z.output<typeof machineEventInput>;

/**
 * Nhóm của lần ghi khi hub vắng (specs/027 FR-012): `progress` và `proposal` thì hộp thư đi giữ lại và gửi sau;
 * `immediate` cần hub trả lời ngay (agent đọc câu trả lời để làm tiếp) nên không xếp hàng.
 */
export const clientWriteGroup = z.enum(["progress", "proposal", "immediate"]);
export type ClientWriteGroup = z.output<typeof clientWriteGroup>;

/** Nhóm của từng loại sự kiện máy khi hub vắng (specs/027 FR-012): `progress` thì hộp thư đi giữ lại; `proposal` là đề xuất cần người duyệt. */
export const MACHINE_EVENT_KINDS = {
  "machine.token_score": "progress",
  "memory.propose": "proposal",
  "project.token_usage": "progress",
} as const satisfies Record<MachineEventInput["kind"], ClientWriteGroup>;

/**
 * Tool MCP có ghi. Hub bọc các tool này bằng sự kiện client; hộp thư đi trên máy chọn giữ hay báo "Hub đang vắng" theo
 * nhóm. Test của hub kiểm mọi tool có cờ `writes` đều nằm ở đây, test Go kiểm `worker/internal/outbox/tools.go` khớp
 * fixture `client-write-tools.json`.
 */
export const CLIENT_WRITE_TOOLS = {
  task_update: "progress",
  sdlc_report: "progress",
  sdlc_ask: "progress",
  doc_propose: "proposal",
  doc_suggest: "proposal",
  doc_comment: "proposal",
  skill_propose: "proposal",
  memory_write: "proposal",
  plan_submit: "proposal",
  review_submit: "proposal",
  skill_proposal_submit: "proposal",
  brief_submit: "proposal",
  doc_check_submit: "proposal",
  doc_assist_submit: "proposal",
  leader_reply: "immediate",
  leader_propose: "immediate",
  leader_action: "immediate",
  artifact_create: "immediate",
  artifact_update: "immediate",
} as const satisfies Record<string, ClientWriteGroup>;
export type ClientWriteTool = keyof typeof CLIENT_WRITE_TOOLS;

/** Thủ tục oRPC có ghi mà client trên máy gọi; hub bọc bằng sự kiện client khi request có khoá. */
export const CLIENT_WRITE_PROCEDURES = {
  "memory.write": "proposal",
} as const satisfies Record<string, ClientWriteGroup>;

/** Nhóm của tool MCP, thủ tục oRPC hay sự kiện máy; `undefined` là thao tác đọc hay không có trong bảng. */
export function clientWriteGroupOf(kind: string): ClientWriteGroup | undefined {
  const tables: Record<string, ClientWriteGroup>[] = [CLIENT_WRITE_TOOLS, CLIENT_WRITE_PROCEDURES, MACHINE_EVENT_KINDS];
  for (const table of tables) if (Object.hasOwn(table, kind)) return table[kind];
  return undefined;
}

/** Nội dung fixture `client-write-tools.json` mà test Go đọc. */
export function clientWriteToolsFixture() {
  return { tools: CLIENT_WRITE_TOOLS, procedures: CLIENT_WRITE_PROCEDURES, machineEvents: MACHINE_EVENT_KINDS };
}

/** Header của lần ghi qua `/mcp` và `/rpc` (contracts/client-events.md). */
export const CLIENT_EVENT_HEADERS = {
  key: "idempotency-key",
  source: "x-hive-source",
  machine: "x-hive-machine",
  createdAt: "x-hive-created-at",
  client: "x-hive-client",
  /** Header trả về của oRPC: JSON `clientEventResult`. */
  result: "hive-client-event",
} as const;

/** Khoá trong `params._meta` của `tools/call` cho client MCP không đặt được header; header thắng nếu có cả hai. */
export const MCP_IDEMPOTENCY_META = "dev.xdev.hive/idempotencyKey";
/** Khoá trong `_meta` của kết quả tool: `clientEventResult`. */
export const MCP_CLIENT_EVENT_META = "dev.xdev.hive/clientEvent";

/** Một dòng lịch sử task (FR-006): sự kiện client hay đổi trạng thái run, sắp theo giờ hub nhận. */
export const taskHistoryItem = z.object({
  at: z.iso.datetime(),
  clientCreatedAt: z.iso.datetime().nullable(),
  kind: z.string(),
  outcome: clientEventOutcome.exclude(["duplicate"]),
  source: clientSource,
  machine: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  actor: z.object({ id: z.string(), name: z.string() }).nullable(),
  reasonCode: z.string().nullable(),
  reason: z.string().nullable(),
});
export type TaskHistoryItem = z.output<typeof taskHistoryItem>;
