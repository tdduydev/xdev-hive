import { z } from "zod";

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

/** Sự kiện máy gửi lên `POST /v1/client-events`. Danh tính lấy từ token của máy, không lấy từ body. */
export const machineEventInput = z.discriminatedUnion("kind", [
  z.strictObject({
    key: idempotencyKey,
    kind: z.literal("machine.token_score"),
    createdAt: z.iso.datetime(),
    payload: tokenScoreReport,
  }),
]);
export type MachineEventInput = z.output<typeof machineEventInput>;

/** Nhóm của từng loại sự kiện máy khi hub vắng (specs/027 FR-012): `progress` thì hộp thư đi giữ lại. */
export const MACHINE_EVENT_KINDS = { "machine.token_score": "progress" } as const;
