import { z } from "zod";
import { sandboxJobConfig } from "./sandbox.ts";

/** Phiên bản giao thức worker ↔ hub (docs/architecture.md mục 5). Tăng khi đổi gói theo cách không tương thích. */
export const PROTOCOL_VERSION = 1;

export const machineId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const cli = z.enum(["claude", "codex", "gemini"]);
export const workerOs = z.enum(["darwin", "linux", "windows"]);

const runId = z.string().min(1).max(64);
// Hub từ chối gói của lần thử cũ (fencing), nên mọi gói gắn với một run đều mang attempt.
const attempt = z.number().int().min(1);
const seq = z.number().int().min(0);
const leaseId = z.string().min(1).max(64);

/** Trường chung của mọi gói: phiên bản giao thức và id gói (để log và loại trùng). */
const envelope = <T extends string>(type: T) => ({
  type: z.literal(type),
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1).max(64),
});

// ---- Worker → hub ----

export const hello = z.object({
  ...envelope("hello"),
  machineId,
  version: z.string().max(40),
  // Hai bên thoả thuận trong khoảng này để worker cũ hơn hub vẫn chạy được.
  protoRange: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
  os: workerOs,
  runnerMode: z.enum(["worker", "host"]).optional(),
  cpuCount: z.number().int().min(1).max(4096).optional(),
  memoryMB: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  clis: z.array(cli).max(10),
  capacity: z.number().int().min(0).max(64),
  resumeRuns: z.array(z.string().max(64)).max(64).default([]),
});

export const heartbeat = z.object({
  ...envelope("heartbeat"),
  /** Số run đang chạy trên máy, so với capacity khi ghép job. */
  load: z.number().int().min(0).max(64),
  runs: z.array(z.object({ runId, attempt, leaseId })).max(64).default([]),
});

// job_accept/job_reject cần runId và attempt để hub biết đang trả lời đề nghị nào; bảng ở mục 5 không ghi rõ.
export const jobAccept = z.object({ ...envelope("job_accept"), runId, attempt });
export const jobReject = z.object({ ...envelope("job_reject"), runId, attempt, reason: z.string().max(500) });

/**
 * Sự kiện của run. Bảng ở mục 5 gọi loại sự kiện là `type`, nhưng `type` đã là khoá phân biệt của gói, nên ở đây
 * đổi thành `event`.
 */
export const runEventKind = z.enum([
  "phase",
  "plan",
  "tool_call",
  "cost",
  "approval_needed",
  "check_result",
  // Báo cáo của agent (tóm tắt, bằng chứng); kiểm tra `agentReport` của chính sách kết quả dựa vào sự kiện này.
  "agent_report",
  // Worker báo chỉ dẫn (gói `steer` có steerId) đã đưa được vào agent đang chạy hay chưa.
  "steer_result",
]);
/**
 * `data` của sự kiện `cost`: usage luỹ kế của lần thử (không phải phần tăng thêm), gửi khi đổi, tối đa 5 giây một lần
 * và một lần cuối trước run_result. Trường CLI không báo là null.
 */
export const costEventData = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  costUsd: z.number().min(0).nullable(),
  turns: z.number().int().min(0).nullable(),
  model: z.string().max(200).nullable(),
});
export type CostEventData = z.output<typeof costEventData>;

/**
 * `data` của sự kiện `steer_result`. `applied` chỉ true khi CLI đã nhận chỉ dẫn vào phiên đang chạy; false khi CLI
 * không nhận tin giữa chừng (codex exec, gemini -p) hoặc agent đã xong trước khi đọc tới, và `reason` nói vì sao.
 */
export const steerResultData = z.object({
  steerId: z.string().min(1).max(64),
  applied: z.boolean(),
  reason: z.string().max(500).optional(),
});
export type SteerResultData = z.output<typeof steerResultData>;

export const runEvent = z.object({
  ...envelope("run_event"),
  runId,
  attempt,
  seq,
  event: runEventKind,
  data: z.record(z.string(), z.unknown()),
});

/** Log terminal; `bytes` là base64 vì log có thể chứa byte không phải UTF-8 (Go mã hoá []byte theo cách này). */
export const logChunk = z.object({
  ...envelope("log_chunk"),
  runId,
  attempt,
  seq,
  offset: z.number().int().min(0),
  bytes: z.base64().max(1_400_000),
});

/** File nhị phân vẫn có đường dẫn nhưng không cộng vào số dòng thêm/xoá. */
export const diffStats = z.object({
  addedLines: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  deletedLines: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  changedFiles: z.array(z.string()),
});
export type DiffStats = z.output<typeof diffStats>;

export const runResult = z.object({
  ...envelope("run_result"),
  runId,
  attempt,
  seq,
  exit: z.number().int(),
  /** null khi agent không tạo commit nào. */
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .nullable(),
  report: z.record(z.string(), z.unknown()).nullable(),
  /** Worker cũ không gửi: hub vẫn yêu cầu review để tránh bỏ sót thay đổi. */
  diffStats: diffStats.optional(),
});

// ---- Hub → worker ----

export const welcome = z.object({
  ...envelope("welcome"),
  sessionId: z.string(),
  heartbeatSec: z.number().int().min(5).max(300),
  // Chưa có access token ngắn hạn (mục 6): máy đang xác thực bằng machine token tới khi bị thu hồi.
  accessTokenExp: z.iso.datetime().optional(),
});

export const upgradeRequired = z.object({
  ...envelope("upgrade_required"),
  url: z.url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sig: z.string(),
});

export const heartbeatAck = z.object({
  ...envelope("heartbeat_ack"),
  /** leaseId đã được gia hạn. Lease không có trong danh sách là đã mất. */
  renewed: z.array(leaseId).max(64),
  /** runId cần huỷ; gửi kèm heartbeat để lệnh huỷ vẫn tới khi kênh khác lỗi. */
  cancel: z.array(runId).max(64),
});

export const jobOffer = z.object({
  ...envelope("job_offer"),
  runId,
  attempt,
  /** Nội dung job do module runs định nghĩa. */
  spec: z
    .object({
      execution: z.enum(["worker", "sandbox"]).optional(),
      sandbox: sandboxJobConfig.optional(),
    })
    .catchall(z.unknown())
    .refine((spec) => (spec.execution === "sandbox") === (spec.sandbox !== undefined), {
      message: "Job sandbox phải có cấu hình mạng và image.",
    }),
  /** Số giây worker có để trả lời trước khi hub đề nghị máy khác. */
  ttl: z.number().int().min(1).max(600),
});

// runId và attempt để worker ghép lease với job đã nhận; bảng ở mục 5 chỉ ghi leaseId, expiresAt, runToken.
export const lease = z.object({
  ...envelope("lease"),
  runId,
  attempt,
  leaseId,
  expiresAt: z.iso.datetime(),
  runToken: z.string().min(1),
});

export const ack = z.object({ ...envelope("ack"), runId, uptoSeq: seq });

/**
 * Chỉ dẫn thêm cho run đang chạy. `steerId` (id sự kiện `steer` ở hub) và `attempt` là trường thêm sau: worker chỉ trả
 * `run_event` loại `steer_result` khi có `steerId`, vì hub cũ đóng kết nối khi gặp loại sự kiện lạ.
 */
export const steer = z.object({
  ...envelope("steer"),
  runId,
  attempt: attempt.optional(),
  steerId: z.string().min(1).max(64).optional(),
  input: z.string().max(100_000),
});

// runId để worker chuyển câu trả lời tới đúng tiến trình agent; bảng ở mục 5 chỉ ghi requestId và decision.
export const approvalResult = z.object({
  ...envelope("approval_result"),
  runId,
  requestId: z.string().min(1).max(64),
  decision: z.enum(["approve", "deny"]),
});

export const cancel = z.object({ ...envelope("cancel"), runId, graceSec: z.number().int().min(0).max(3600) });

export const drain = z.object({ ...envelope("drain") });

export const workerToHub = z.discriminatedUnion("type", [
  hello,
  heartbeat,
  jobAccept,
  jobReject,
  runEvent,
  logChunk,
  runResult,
]);
export const hubToWorker = z.discriminatedUnion("type", [
  welcome,
  upgradeRequired,
  heartbeatAck,
  jobOffer,
  lease,
  ack,
  steer,
  approvalResult,
  cancel,
  drain,
]);
export type WorkerToHub = z.output<typeof workerToHub>;
export type HubToWorker = z.output<typeof hubToWorker>;
