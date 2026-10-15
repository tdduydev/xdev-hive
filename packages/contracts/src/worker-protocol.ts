import { z } from "zod";
import { jobMcpServer } from "./mcp-admin.ts";
import { sandboxJobConfig } from "./sandbox.ts";
import { base64url, ephPub, remoteAuth, termDenyCode } from "./terminal-auth.ts";

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
  /**
   * Việc worker làm được ngoài run code (vd. `doccheck`: run chỉ đọc kiểm tài liệu; `sdlc`: run soạn tài liệu AI SDLC;
   * `accounts-remote`: nhận `account_set` và đăng nhập gói từ web). Worker cũ không gửi.
   */
  capabilities: z.array(z.string().max(40)).max(20).default([]),
  resumeRuns: z.array(z.string().max(64)).max(64).default([]),
  localProjects: localProjects.optional(),
});

const percent = z.number().min(0).max(100);

/**
 * Tóm tắt một tài khoản CLI trên máy (specs/011 FR-043) để quản trị đội thấy gói và quota trên web. Không bao giờ có
 * token hay email đầy đủ: `label` là nhãn người vận hành đặt cho tài khoản.
 */
export const workerAccountSummary = z.object({
  id: z.string().min(1).max(64),
  /** Chuỗi chứ không phải enum `cli`, để worker mới báo được CLI mà hub cũ chưa biết. */
  cli: z.string().min(1).max(40),
  label: z.string().max(80),
  roles: z.array(z.string().max(40)).max(10),
  enabled: z.boolean(),
  /** null khi worker không kiểm được trạng thái đăng nhập của CLI này. */
  loggedIn: z.boolean().nullable(),
  sessionPct: percent.nullable(),
  weekPct: percent.nullable(),
  /** Lúc quota phiên 5 giờ đặt lại. */
  resetsAt: z.iso.datetime().nullable(),
  /** Ngưỡng % worker ngừng giao run cho tài khoản; 0 là không đặt. */
  stopAtSession: percent,
  stopAtWeek: percent,
  /** Số run đang dùng tài khoản. */
  inUse: z.number().int().min(0).max(64),
});
export type WorkerAccountSummary = z.output<typeof workerAccountSummary>;

export const heartbeat = z.object({
  ...envelope("heartbeat"),
  /** Số run đang chạy trên máy, so với capacity khi ghép job. */
  load: z.number().int().min(0).max(64),
  runs: z.array(z.object({ runId, attempt, leaseId })).max(64).default([]),
  /** Gửi lại mỗi heartbeat để công tắc vừa đổi trong app tới hub; thiếu thì hub giữ giá trị đã biết. */
  localProjects: localProjects.optional(),
  /** Tóm tắt tài khoản CLI; worker cũ không gửi, và thiếu thì hub giữ tóm tắt đã biết. */
  accounts: z.array(workerAccountSummary).max(32).optional(),
});

/** Cách đăng nhập gói từ web (T063): Claude theo gói, SSO, Console hoặc dán token `claude setup-token`; Codex mã thiết bị. */
export const accountLoginHow = z.enum(["plan", "sso", "console", "token", "device"]);
export type AccountLoginHow = z.output<typeof accountLoginHow>;
/** CLI đăng nhập được từ web: cần CLI có lệnh đăng nhập không trình duyệt. */
export const accountLoginCli = z.enum(["claude", "codex"]);
export type AccountLoginCli = z.output<typeof accountLoginCli>;
/** Giới hạn một phiên đăng nhập gói; worker và hub cùng tự huỷ sau thời gian này. */
export const ACCOUNT_LOGIN_TIMEOUT_SEC = 600;

const loginRequestId = z.string().min(1).max(64);

/**
 * Bước đăng nhập gói worker báo về (T063, ADR 0017). Worker chỉ gửi URL đăng nhập, mã thiết bị và lời nhắc của chính
 * nó, không gửi output thô của CLI, để token hay thông tin khác trên máy không đi qua hub. `done` có `accountId`.
 * Worker chỉ gửi gói này sau `account_login_start`, nên hub cũ không bao giờ nhận.
 */
export const accountLoginEvent = z.object({
  ...envelope("account_login_event"),
  requestId: loginRequestId,
  kind: z.enum(["url", "code", "prompt", "done", "error"]),
  text: z.string().max(2000),
  accountId: z.string().min(1).max(64).optional(),
});
export type AccountLoginEvent = z.output<typeof accountLoginEvent>;

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
 * Số liệu tiết kiệm token của worker trong lần thử: số file của context pack tiêm vào đầu run, số lệnh khảo sát bị hook
 * ngân sách chặn trước lần sửa đầu, số ký tự output tool đã cắt khỏi ngữ cảnh. Luỹ kế như các trường cost.
 */
export const guardUsage = z.object({
  contextPackFiles: z.number().int().min(0),
  exploreBlocked: z.number().int().min(0),
  truncatedChars: z.number().int().min(0),
});
export type GuardUsage = z.output<typeof guardUsage>;

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
  /** Số của context pack, ngân sách khảo sát và cắt output; cùng lý do với `rtk`. Chỉ gửi khi run dùng chúng. */
  guard: guardUsage.optional(),
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

/**
 * `POST /api/v1/run/skills` (Bearer run token): skill áp cho dự án của run, để worker chép vào `.claude/skills/` của
 * worktree trước khi chạy Claude Code. Đi ngoài kênh WSS vì bộ skill nặng vài MB, không hợp với job_offer. `have` là
 * hash worker đã có trong cache: hub bỏ `files` của những skill đó.
 */
export const runSkillsRequest = z.object({
  have: z
    .array(z.string().regex(/^[0-9a-f]{64}$/))
    .max(500)
    .default([]),
});
export const runSkill = z.object({
  name: z.string(),
  /** sha256 của nội dung skill; đổi nội dung thì đổi hash. */
  hash: z.string(),
  /** `hive` là bộ skill mặc định; còn lại là skill của tổ chức, đội, dự án trên hub. */
  source: z.enum(["hive", "org", "team", "project"]),
  files: z.array(z.object({ path: z.string(), text: z.string() })).optional(),
});
export const runSkillsResponse = z.object({ skills: z.array(runSkill) });
export type RunSkillsResponse = z.output<typeof runSkillsResponse>;

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
   * để checkpoint chờ người xem thay vì coi là lỗi. Run `sdlc` thêm `artifacts` (`sdlcReportArtifacts`).
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
  /**
   * Điều hub cho máy này (vd. `shared`: máy dùng chung, nên được nhận `account_set`). Worker không tự khai cờ này vì
   * máy cá nhân không được để quản trị đội đổi tài khoản của chủ máy (ADR 0017). Hub cũ không gửi.
   */
  features: z.array(z.string().max(40)).max(20).optional(),
  /**
   * Chủ máy theo hub (specs/010 D14). Worker đổi chủ (`userId` khác `ownerUserId` trong remote.json) thì xoá thiết bị đã
   * ghép; `shared` thì từ chối bật từ xa. Hub cũ không gửi.
   */
  owner: z.object({ userId: z.string().min(1).max(64), shared: z.boolean() }).optional(),
  /** Chính sách tổ chức liên quan tới điều khiển từ xa. Hub chỉ dùng để tắt: thiếu trường thì worker theo cài đặt tại máy. */
  policy: z.object({ totpFallback: z.boolean() }).optional(),
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
   * Nội dung job do module runs định nghĩa. Run code có thể có `checks: { commands: CheckCommand[] }`; run `sdlc` có
   * `sdlc: SdlcJobSpec`. Các trường này đi qua `catchall` chứ không khai ở đây, vì worker cũ phải bỏ qua được chúng và
   * hub không được từ chối job thiếu chúng.
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

/**
 * Quản trị đội bật/tắt một tài khoản CLI trên máy dùng chung (specs/011 FR-044). Hub chỉ gửi khi hello có capability
 * `accounts-remote` và máy `shared`; worker trả `ack` rồi heartbeat kế phản ánh. Thêm tài khoản vẫn làm tại máy vì
 * đăng nhập CLI cần trình duyệt trên máy đó.
 */
export const accountSet = z.object({
  ...envelope("account_set"),
  accountId: z.string().min(1).max(64),
  enabled: z.boolean(),
});

/**
 * Bắt đầu đăng nhập một gói mới trên máy dùng chung không màn hình (T063). Worker tạo thư mục cấu hình riêng cho gói,
 * chạy lệnh đăng nhập của CLI trong PTY rồi báo bước qua `account_login_event`. Cùng điều kiện như `account_set`; mỗi
 * máy tối đa một phiên, hết hạn sau `ACCOUNT_LOGIN_TIMEOUT_SEC`.
 */
export const accountLoginStart = z.object({
  ...envelope("account_login_start"),
  requestId: loginRequestId,
  cli: accountLoginCli,
  label: z.string().trim().min(1).max(80),
  how: accountLoginHow,
});

/**
 * Chữ người dùng dán trên web (mã xác nhận của Claude hoặc token `setup-token`). Hub chuyển thẳng xuống worker, không
 * lưu và không ghi log; worker ghi vào PTY hoặc file 0600 trong thư mục gói.
 */
export const accountLoginInput = z.object({
  ...envelope("account_login_input"),
  requestId: loginRequestId,
  text: z.string().min(1).max(4096),
});

/** Huỷ phiên đăng nhập: worker dừng lệnh và xoá gói dở. */
export const accountLoginCancel = z.object({ ...envelope("account_login_cancel"), requestId: loginRequestId });

// ---- Run `sdlc` (specs/011, ADR 0021) ----

/** Giới hạn file worker trả về sau run `sdlc`; vượt thì worker báo lỗi rõ thay vì cắt. */
export const SDLC_ARTIFACT_LIMITS = { files: 20, fileChars: 200_000, totalBytes: 2_000_000 } as const;

/** Đường dẫn tương đối trong worktree; worker vẫn kiểm lại sau khi giải symlink. */
const worktreePath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes(".."),
    "Đường dẫn phải nằm trong repo.",
  );

/** Capability của worker checkout được repo tham gia vào `SDLC_REPOS_DIR` (specs/011 T086). */
export const SDLC_MULTIREPO_CAPABILITY = "sdlc-multirepo";
/** Thư mục chứa bản checkout chỉ đọc của repo tham gia trong worktree tạm; worker ghi `STATUS.md` ở đây. */
export const SDLC_REPOS_DIR = ".hive/repos";
/** Trần số repo tham gia mỗi run: hạng mục nhiều dự án hơn thế thì các repo sau chỉ có tóm tắt. */
export const SDLC_MAX_REPOS = 7;

export const sdlcJobRepo = z
  .object({
    projectKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    cloneUrl: z.url({ protocol: /^(https?|ssh)$/ }),
    branch: z.string().min(1).max(200),
    dir: worktreePath,
  })
  .refine((r) => r.dir === `${SDLC_REPOS_DIR}/${r.projectKey}`, "Thư mục phải là .hive/repos/<mã dự án>.");

/**
 * `jobOffer.spec.sdlc` của run `sdlc`: worker ghi `seed` (baseline và bản nháp của hub chưa có trong repo) vào worktree
 * tạm trước khi chạy CLI, rồi đọc các file `collect` sau khi CLI thoát. Không commit, không đẩy.
 */
export const sdlcJobSpec = z.object({
  step: z.string().min(1).max(40),
  seed: z.array(z.object({ path: worktreePath, content: z.string().max(SDLC_ARTIFACT_LIMITS.fileChars) })).max(100),
  collect: z
    .array(z.object({ artifactId: z.string().min(1).max(120), path: worktreePath }))
    .max(SDLC_ARTIFACT_LIMITS.files),
  /**
   * Repo của dự án tham gia (hạng mục nhiều dự án, T086): worker khai `sdlc-multirepo` clone nông, chỉ đọc vào `dir`.
   * Hub bỏ trường này khi máy không khai capability; tóm tắt repo trong `seed` vẫn luôn có.
   */
  repos: z.array(sdlcJobRepo).max(SDLC_MAX_REPOS).optional(),
});
export type SdlcJobSpec = z.output<typeof sdlcJobSpec>;

/** `run_result.report.artifacts` của run `sdlc`: file nào trong `collect` không có thì không trả. */
export const sdlcReportArtifacts = z
  .array(
    z.object({
      artifactId: z.string().min(1).max(120),
      path: worktreePath,
      content: z.string().max(SDLC_ARTIFACT_LIMITS.fileChars),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  )
  .max(SDLC_ARTIFACT_LIMITS.files);
export type SdlcReportArtifacts = z.output<typeof sdlcReportArtifacts>;

// ---- Terminal Leader trên máy dùng chung (specs/010 lát đầu, ADR 0019) ----

/** Capability worker khai trong hello khi giữ được phiên PTY tương tác. Hub chỉ gửi `term_*` cho máy có capability này. */
export const TERMINAL_CAPABILITY = "terminal";

/**
 * Giới hạn chung của phiên terminal. `outputBytes`/`inputBytes` là byte trước base64. Worker gom output `flushMs` rồi
 * gửi, tối đa `outputRateBytes` mỗi giây cho một phiên; quá thì chờ (CLI bị chặn ghi), không bỏ byte. Không có input và
 * output trong `idleSec` thì worker đóng phiên.
 */
export const TERMINAL_LIMITS = {
  outputBytes: 32_768,
  inputBytes: 4096,
  flushMs: 40,
  outputRateBytes: 256 * 1024,
  idleSec: 1800,
  sessionsPerMachine: 4,
} as const;

/** Đề xuất (mặc định, LEAD-02: hành động thành đề xuất chờ duyệt) hay Bypass (gọi tool hub thẳng với quyền người mở). */
export const terminalMode = z.enum(["propose", "bypass"]);
export type TerminalMode = z.output<typeof terminalMode>;

const termSessionId = z.uuid();
const termRequestId = z.uuid();
const termUserId = z.string().min(1).max(64);
/** Id do worker sinh (thiết bị, root, mã ghép) hoặc hub sinh (kết nối WS): chữ base64url, không lộ thông tin máy. */
export const remoteId = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/);
/** `local`: `hive chat` tại máy; `remote`: mở từ điện thoại; `hub`: phiên Leader do hub mở trên máy dùng chung. */
export const termOrigin = z.enum(["local", "remote", "hub"]);
export type TermOrigin = z.output<typeof termOrigin>;
/** Bằng chứng trên gói nhập của phiên điều khiển từ xa; phiên Leader trên máy dùng chung không gửi. */
const inputProof = {
  connId: remoteId.optional(),
  seq: seq.optional(),
  mac: z.base64url().length(22).optional(),
};
export const terminalCols = z.number().int().min(20).max(500);
export const terminalRows = z.number().int().min(5).max(200);
/** Chuỗi base64 giải ra tối đa `bytes` byte (đếm theo byte thật, không theo độ dài chuỗi, vì 4/3 làm tròn lên). */
export const base64Max = (bytes: number) =>
  z
    .base64()
    .max(Math.ceil(bytes / 3) * 4)
    .refine((s) => (s.length / 4) * 3 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0) <= bytes, {
      message: `Tối đa ${bytes} byte.`,
    });

/**
 * Lý do phiên kết thúc: `exit` CLI tự thoát, `closed` hub/người dùng đóng, `idle` quá `idleSec` không hoạt động,
 * `denied` worker từ chối mở (máy không dùng chung, quá số phiên, gói không dùng được), `error` lỗi khi chuẩn bị.
 */
export const termExitReason = z.enum(["exit", "closed", "idle", "denied", "error"]);
export type TermExitReason = z.output<typeof termExitReason>;

/** PTY đã chạy. `accountLabel` là nhãn gói (không có token hay email). */
export const termOpened = z.object({
  ...envelope("term_opened"),
  sessionId: termSessionId,
  accountLabel: z.string().max(80).nullable(),
  /** Quyền thật worker áp sau khi xét công tắc toàn quyền của máy (ADR 0020); hub ghi lại để hiện cho người mở. */
  permissions: z.enum(["workspace", "full"]),
  /**
   * Các trường dưới chỉ có ở phiên trên máy cá nhân (`hive chat` tại máy, mở từ xa bằng `term_start`); phiên `term_open`
   * của Leader không gửi nên hub cũ vẫn nhận gói này.
   */
  origin: termOrigin.optional(),
  /** `requestId` của `term_start` khi phiên mở từ xa. */
  requestId: termRequestId.optional(),
  cli: cli.optional(),
  /** Nhãn thư mục (nhãn root + thư mục con), không có đường dẫn tuyệt đối. */
  cwdLabel: z.string().max(200).optional(),
  projectId: z.string().min(1).max(64).optional(),
  taskId: z.string().min(1).max(64).optional(),
  cols: terminalCols.optional(),
  rows: terminalRows.optional(),
  /** Phiên có ghi lên hub không (máy dùng chung, runner host, `--no-record` thì không). */
  record: z.boolean().optional(),
  /** Phiên có cho điều khiển từ xa không (`--no-remote`, từ xa đang tắt thì không). */
  remote: z.boolean().optional(),
});

/** Output của PTY, đã che bí mật worker biết (token MCP của phiên, token gói). `seq` tăng dần từ 0 trong một phiên. */
export const termOutput = z.object({
  ...envelope("term_output"),
  sessionId: termSessionId,
  seq,
  data: base64Max(TERMINAL_LIMITS.outputBytes),
});

export const termExit = z.object({
  ...envelope("term_exit"),
  sessionId: termSessionId,
  exitCode: z.number().int().nullable(),
  reason: termExitReason,
  /** Câu tiếng Việt cho người dùng (vd. lý do từ chối). */
  message: z.string().max(500).optional(),
  /** Ai đóng phiên (userId, `machine` khi đóng tại máy). */
  by: z.string().min(1).max(64).optional(),
});

/**
 * Mở phiên `claude` tương tác trong worktree tạm của dự án (tách HEAD trên nhánh mặc định, không đẩy). Hub chỉ gửi tới
 * máy dùng chung có capability `terminal`; worker vẫn tự từ chối khi hub chưa báo máy dùng chung. `mcpToken` là token
 * MCP có phạm vi của phiên, chỉ ghi vào file `--mcp-config` 0600 và bị che khỏi output.
 */
export const termOpen = z.object({
  ...envelope("term_open"),
  sessionId: termSessionId,
  projectId: z.string().min(1).max(64),
  planId: z.string().min(1).max(64).optional(),
  mode: terminalMode,
  cols: terminalCols,
  rows: terminalRows,
  cli: z.literal("claude"),
  repoUrl: z.string().min(1).max(2000),
  baseBranch: z.string().min(1).max(255),
  projectKey: z.string().min(1).max(100),
  /** Gói (tài khoản trong accounts.json) người mở chọn; bỏ trống thì worker tự chọn gói rảnh. */
  accountId: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(100),
  effort: z.enum(["low", "medium", "high"]).optional(),
  /** Model cố vấn (`--advisor`); worker bỏ khi CLI chưa hỗ trợ. */
  advisor: z.string().min(1).max(100).optional(),
  /** Quyền dự án xin; worker áp `projects.Effective` như run (toàn quyền chỉ khi máy bật cho dự án). */
  runPermissions: z.enum(["workspace", "full"]),
  /** Chính sách tổ chức cho toàn quyền (allowFullPermission). */
  fullAllowed: z.boolean(),
  mcpToken: z.string().min(1).max(4000),
  /** Lời dặn thêm vào system prompt của Claude (`--append-system-prompt`): vai trò Leader, chế độ, cách đề xuất. */
  systemPrompt: z.string().max(20_000),
  /** Cài đặt "Tiết kiệm token" của dự án (như `jobOffer.spec.tokenSaving`); worker cũ bỏ qua. */
  tokenSaving: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Phím người mở gõ trên web. Hub chỉ chuyển của chủ phiên, sau giới hạn tốc độ. Phiên trên máy cá nhân (điều khiển từ xa)
 * thêm `connId`, `seq` tăng nghiêm ngặt và `mac` (FR-017, `inputMacPayload`); worker bỏ gói thiếu hoặc sai.
 */
export const termInput = z.object({
  ...envelope("term_input"),
  sessionId: termSessionId,
  data: base64Max(TERMINAL_LIMITS.inputBytes),
  ...inputProof,
});

export const termResize = z.object({
  ...envelope("term_resize"),
  sessionId: termSessionId,
  cols: terminalCols,
  rows: terminalRows,
  ...inputProof,
});

/** Đóng phiên: worker dừng cả nhóm tiến trình, xoá worktree tạm, trả `term_exit` lý do `closed`. */
export const termClose = z.object({
  ...envelope("term_close"),
  sessionId: termSessionId,
  reason: z.string().max(200).optional(),
  /** userId người đóng (chủ phiên, quản trị đội); worker ghi vào remote-audit.log. */
  by: z.string().min(1).max(64).optional(),
});

// ---- Điều khiển từ xa phiên trên máy cá nhân (specs/010 US2–US5; passkey/TOTP kiểm ở worker) ----

/** Chủ máy ghép thiết bị: bí mật ghép không qua hub nên hub không thay được khoá (`pairTag`, FR-014). */
export const termPair = z.object({
  ...envelope("term_pair"),
  pairId: remoteId,
  userId: termUserId,
  label: z.string().min(1).max(80),
  credentialId: base64url(1024),
  /** Khoá công khai ES256 dạng SPKI DER (`AuthenticatorAttestationResponse.getPublicKey()`), base64url. */
  spki: base64url(512),
  tag: z.base64url().length(43),
});

/**
 * Mở phiên mới từ điện thoại. Mọi trường trong `StartParams` (terminal-auth.ts) được ký trong challenge; `model` và
 * `permissions` do hub điền theo chính sách tổ chức (FR-019), worker vẫn không chạy toàn quyền nếu máy chưa cho.
 */
export const termStart = z.object({
  ...envelope("term_start"),
  requestId: termRequestId,
  userId: termUserId,
  deviceId: remoteId,
  cli,
  accountId: z.string().min(1).max(64).optional(),
  rootId: remoteId,
  subdir: z.string().min(1).max(500).optional(),
  model: z.string().min(1).max(100).optional(),
  permissions: z.enum(["ask", "workspace", "full"]).optional(),
  projectId: z.string().min(1).max(64).optional(),
  taskId: z.string().min(1).max(64).optional(),
  // min(1): worker coi chuỗi rỗng là không có khi dựng lại challenge, nên rỗng sẽ không khớp chữ ký.
  prompt: z.string().min(1).max(20_000).optional(),
  cols: terminalCols,
  rows: terminalRows,
  auth: remoteAuth,
});

/**
 * Xin quyền gõ cho một kết nối WS. Lần đầu cần `auth`; nối lại trong 2 phút dùng `resumeToken` để giữ khoá cũ (FR-021).
 * Thiếu cả hai thì worker từ chối `AUTH_INVALID`.
 */
export const termControl = z.object({
  ...envelope("term_control"),
  sessionId: termSessionId,
  connId: remoteId,
  userId: termUserId,
  deviceId: remoteId,
  auth: remoteAuth.optional(),
  resumeToken: z.base64url().max(64).optional(),
});

/** Kết nối WS rời phiên (đóng tab, mất mạng); worker giữ quyền chờ `resumeToken` tới hạn. */
export const termDetach = z.object({ ...envelope("term_detach"), sessionId: termSessionId, connId: remoteId });

/** Hub đã ghi bền output tới `upto` (gồm cả `upto`); worker xoá phần đệm đĩa tương ứng. */
export const termAck = z.object({ ...envelope("term_ack"), sessionId: termSessionId, upto: seq });

/** Tắt điều khiển từ xa ngay (FR-022). Không có gói bật: chỉ bật được tại máy (FR-012). */
export const termDisable = z.object({ ...envelope("term_disable"), by: termUserId });

export const termDeviceRevoke = z.object({ ...envelope("term_device_revoke"), deviceId: remoteId, by: termUserId });

/** Trạng thái điều khiển từ xa tại máy; gửi sau `welcome` và mỗi khi đổi. Không có đường dẫn tuyệt đối hay khoá. */
export const termState = z.object({
  ...envelope("term_state"),
  enabled: z.boolean(),
  totp: z.object({ enabled: z.boolean(), locked: z.boolean(), lockedUntil: z.iso.datetime().optional() }),
  roots: z.array(z.object({ id: remoteId, label: z.string().min(1).max(80) })).max(32),
  clis: z.array(cli).max(8),
  accounts: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        label: z.string().max(80),
        cli,
        state: z.enum(["ready", "cooldown", "disabled", "logged_out"]),
      }),
    )
    .max(32),
  devices: z
    .array(z.object({ id: remoteId, label: z.string().min(1).max(80), userId: termUserId, synced: z.boolean() }))
    .max(32),
  sessions: z
    .array(z.object({ id: termSessionId, origin: termOrigin, controller: z.enum(["local", "remote"]).nullable() }))
    .max(64),
  confirmOnMachine: z.boolean(),
});

export const termDenied = z.object({
  ...envelope("term_denied"),
  requestId: termRequestId,
  code: termDenyCode,
  /** Câu tiếng Việt cho người dùng; không chứa mã TOTP hay chi tiết khoá. */
  reason: z.string().max(500),
});

/** Sự kiện của phiên, enum riêng để không đụng `runEventKind` (hub cũ đóng kết nối khi gặp loại lạ). */
export const termEventKind = z.enum(["attention", "idle", "controller", "resize", "gap", "input_rejected", "viewer"]);
export type TermEventKind = z.output<typeof termEventKind>;

export const termEvent = z.object({
  ...envelope("term_event"),
  sessionId: termSessionId,
  seq,
  event: termEventKind,
  data: z.record(z.string(), z.unknown()).optional(),
});

/** Worker cấp quyền gõ cho `connId`; trình duyệt suy ra khoá HMAC từ `workerEphPub` (`deriveInputKey`). */
export const termGranted = z.object({
  ...envelope("term_granted"),
  sessionId: termSessionId,
  connId: remoteId,
  workerEphPub: ephPub,
  resumeToken: z.base64url().max(64),
});

export const termRevoked = z.object({
  ...envelope("term_revoked"),
  sessionId: termSessionId,
  connId: remoteId,
  reason: z.enum(["taken", "idle", "disabled", "device_revoked", "input_rejected", "closed", "expired"]),
});

export const termPairResult = z.object({
  ...envelope("term_pair_result"),
  pairId: remoteId,
  ok: z.boolean(),
  deviceId: remoteId.optional(),
  reason: z.enum(["expired", "bad_tag", "denied", "timeout", "user_mismatch", "disabled"]).optional(),
});

export const workerToHub = z.discriminatedUnion("type", [
  hello,
  heartbeat,
  jobAccept,
  jobReject,
  runEvent,
  logChunk,
  runResult,
  accountLoginEvent,
  termOpened,
  termOutput,
  termExit,
  termState,
  termDenied,
  termEvent,
  termGranted,
  termRevoked,
  termPairResult,
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
  accountSet,
  accountLoginStart,
  accountLoginInput,
  accountLoginCancel,
  termOpen,
  termInput,
  termResize,
  termClose,
  termStart,
  termControl,
  termDetach,
  termAck,
  termDisable,
  termPair,
  termDeviceRevoke,
]);
export type WorkerToHub = z.output<typeof workerToHub>;
export type HubToWorker = z.output<typeof hubToWorker>;
