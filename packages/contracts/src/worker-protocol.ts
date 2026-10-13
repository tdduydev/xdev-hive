import { z } from "zod";
import { jobMcpServer } from "./mcp-admin.ts";
import { sandboxJobConfig } from "./sandbox.ts";

/** Phiên bản giao thức worker ↔ hub (docs/architecture.md mục 5). Tăng khi đổi gói theo cách không tương thích. */
export const PROTOCOL_VERSION = 1;

export const machineId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
/**
 * CLI hub giao run được. Hub cũ kiểm hello và đăng ký máy bằng enum này, nên worker hỏi `clis` của GET /api/v1/health
 * và chỉ khai CLI hub đó biết (hub chưa trả `clis` thì chỉ claude, codex, gemini).
 */
export const cli = z.enum(["claude", "codex", "gemini", "antigravity"]);
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

/**
 * Dự án máy đã gắn với repo trên máy và dự án máy cho toàn quyền (projects.json, ADR 0020). Hub dùng để chọn máy chạy
 * được run cần toàn quyền (Antigravity); worker vẫn tự quyết quyền lúc chạy. Worker cũ và runner host không gửi.
 */
export const localProjects = z.object({
  bound: z.array(z.string().min(1).max(64)).max(256),
  full: z.array(z.string().min(1).max(64)).max(256),
});
export type LocalProjects = z.output<typeof localProjects>;

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
  /** Việc worker làm được ngoài run code (vd. `doccheck`: run chỉ đọc kiểm tài liệu). Worker cũ không gửi. */
  capabilities: z.array(z.string().max(40)).max(20).default([]),
  resumeRuns: z.array(z.string().max(64)).max(64).default([]),
  localProjects: localProjects.optional(),
});

export const heartbeat = z.object({
  ...envelope("heartbeat"),
  /** Số run đang chạy trên máy, so với capacity khi ghép job. */
  load: z.number().int().min(0).max(64),
  runs: z.array(z.object({ runId, attempt, leaseId })).max(64).default([]),
  /** Gửi lại mỗi heartbeat để công tắc vừa đổi trong app tới hub; thiếu thì hub giữ giá trị đã biết. */
  localProjects: localProjects.optional(),
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
 * Usage agent dùng để khảo sát repo trước lần sửa file đầu tiên (Edit, Write, MultiEdit, NotebookEdit), ADR 0022.
 * `edited` false là agent chưa sửa gì: số bằng toàn bộ usage tới lúc đó.
 */
export const exploreUsage = z.object({
  edited: z.boolean(),
  turns: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
});
export type ExploreUsage = z.output<typeof exploreUsage>;

/** Số liệu RTK của lần thử: số lệnh Bash đã qua RTK và số token RTK ước tính đã bớt được. Luỹ kế như các trường cost. */
export const rtkUsage = z.object({
  commands: z.number().int().min(0),
  savedTokens: z.number().int().min(0),
});
export type RtkUsage = z.output<typeof rtkUsage>;

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
  /** Id gói (tài khoản CLI trong accounts.json của máy) đã chạy run; thiếu khi worker cũ hoặc dùng đăng nhập mặc định. */
  accountId: z.string().min(1).max(100).nullish(),
  /**
   * Usage trước lần sửa file đầu tiên. Đi trong sự kiện cost thay vì loại sự kiện mới vì hub cũ bỏ khoá lạ của data
   * nhưng đóng kết nối khi gặp loại sự kiện lạ. Worker cũ và CLI chưa đọc được (Codex, Gemini, Antigravity) không gửi.
   */
  explore: exploreUsage.optional(),
  /**
   * Số liệu RTK. Đi trong sự kiện cost vì cùng lý do với `explore` (hub cũ bỏ khoá lạ của data nhưng đóng kết nối khi
   * gặp loại sự kiện lạ). Chỉ gửi khi run đã dùng RTK.
   */
  rtk: rtkUsage.optional(),
});
export type CostEventData = z.output<typeof costEventData>;

/**
 * `run_result.report.repo` (ADR 0022): commit của nhánh chính lúc worker tạo worktree, và số commit nhánh chính đi
 * trước commit của brief (`spec.brief.sha`). `briefBehind` null khi job không có brief hoặc repo không có commit đó.
 */
export const reportRepo = z.object({
  baseSha: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .nullable(),
  briefBehind: z.number().int().min(0).nullable(),
});
export type ReportRepo = z.output<typeof reportRepo>;

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

/**
 * Lệnh kiểm hub giao trong `jobOffer.spec.checks.commands` (quy tắc `command` của quy trình review code,
 * `outcome.command`). Worker chạy tuần tự trong worktree (hoặc container sandbox) sau khi agent thoát 0, trước khi đẩy.
 */
export const checkCommand = z.object({
  run: z.string().trim().min(1).max(500),
  timeoutSec: z.number().int().min(10).max(3600),
});
export type CheckCommand = z.output<typeof checkCommand>;

/** Kết quả một lệnh kiểm trong `run_result.report.commands`. `exit` null khi hết thời hạn hoặc không chạy được. */
export const checkCommandResult = z.object({
  run: z.string().max(500),
  exit: z.number().int().nullable(),
  durationMs: z.number().int().min(0),
  /** 200 dòng cuối của stdout + stderr, worker đã che chuỗi giống bí mật. */
  tail: z.string().max(100_000),
});
export type CheckCommandResult = z.output<typeof checkCommandResult>;

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
  /**
   * Báo cáo tự do của worker. Khi job có `spec.checks.commands`, worker mới thêm `commands: CheckCommandResult[]` theo
   * đúng thứ tự lệnh. Giữ dạng record để worker cũ vẫn hợp lệ: thiếu `commands` nghĩa là máy chưa chạy lệnh kiểm, hub
   * để checkpoint chờ người xem thay vì coi là lỗi.
   */
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
  /**
   * Nội dung job do module runs định nghĩa. Run code có thể có `checks: { commands: CheckCommand[] }`; trường này đi
   * qua `catchall` chứ không khai ở đây, vì worker cũ phải bỏ qua được nó và hub không được từ chối job thiếu nó.
   */
  spec: z
    .object({
      execution: z.enum(["worker", "sandbox"]).optional(),
      sandbox: sandboxJobConfig.optional(),
      /** MCP server ngoài được phép (MCP-06); worker chỉ nạp những server này, ngoài cổng MCP của hub. */
      mcpServers: z.array(jobMcpServer).max(64).optional(),
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

/**
 * Admin bấm cập nhật trên web: worker ngừng nhận job như `drain`, chờ run đang chạy xong rồi tự tải bản phát hành (kiểm
 * chữ ký và sha256) và khởi động lại. Bỏ `version` là bản mới nhất. Worker đi kèm app desktop bỏ qua, vì app tự cập nhật.
 */
export const update = z.object({
  ...envelope("update"),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    .optional(),
});

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
  update,
]);
export type WorkerToHub = z.output<typeof workerToHub>;
export type HubToWorker = z.output<typeof hubToWorker>;
