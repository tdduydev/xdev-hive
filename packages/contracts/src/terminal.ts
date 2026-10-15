import { z } from "zod";
import { id, orgRoute } from "./common.ts";
import { approval } from "./leader.ts";
import { taskTier } from "./projects.ts";
import { base64url, ephPub, remoteAuth, TERM_DENY_MESSAGES, termDenyCode } from "./terminal-auth.ts";
import {
  base64Max,
  cli,
  remoteId,
  TERMINAL_LIMITS,
  termEventKind,
  terminalCols,
  terminalMode,
  terminalRows,
} from "./worker-protocol.ts";

/**
 * Terminal Leader (specs/010 lát đầu cho máy dùng chung, specs/011 FR-067): Claude CLI tương tác chạy trên máy worker
 * dùng chung, web hiện bằng xterm.js qua WebSocket `/ws/terminal`. Chỉ quản trị đội và BA/PO (quyền `leader.terminal`)
 * của đội sở hữu dự án mở được; phiên riêng tư, chủ phiên bật "Cho đội xem" (chỉ xem).
 */

export const TERMINAL_WS_PATH = "/ws/terminal";
/** Vé WebSocket dùng một lần, sống ngắn: lấy bằng oRPC (cần phiên web và CSRF của oRPC) rồi mở WS ngay. */
export const TERMINAL_TICKET_TTL_SEC = 60;

/** Model của chính phiên Leader. Mặc định sonnet (effort high); opus khi người mở chọn. */
export const terminalModel = z.enum(["sonnet", "opus"]);
export type TerminalModel = z.output<typeof terminalModel>;

export const terminalState = z.enum(["opening", "running", "closed", "failed"]);
export type TerminalState = z.output<typeof terminalState>;
export const terminalVisibility = z.enum(["private", "team"]);
export type TerminalVisibility = z.output<typeof terminalVisibility>;

export const terminalSession = z.object({
  id,
  projectId: id,
  projectKey: z.string(),
  projectName: z.string(),
  machineId: id,
  machineName: z.string(),
  ownerId: z.string(),
  ownerName: z.string().nullable(),
  /** Người xem là chủ phiên: chỉ chủ phiên gõ, đổi "Cho đội xem", đóng (quản trị đội cũng đóng được). */
  isOwner: z.boolean(),
  mode: terminalMode,
  model: terminalModel,
  advisor: z.string().nullable(),
  state: terminalState,
  visibility: terminalVisibility,
  /** Quyền worker thật sự áp (null khi worker chưa báo). */
  permissions: z.enum(["workspace", "full"]).nullable(),
  accountLabel: z.string().nullable(),
  /** Cuộc trò chuyện leader chứa đề xuất của phiên (chế độ Đề xuất). */
  threadId: id.nullable(),
  cols: z.number().int(),
  rows: z.number().int(),
  exitCode: z.number().int().nullable(),
  endReason: z.string().nullable(),
  bytes: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
});
export type TerminalSession = z.output<typeof terminalSession>;

export const terminalMachineOption = z.object({
  id,
  name: z.string(),
  online: z.boolean(),
  /** Máy cho toàn quyền với dự án này (công tắc tại máy, ADR 0020) và tổ chức cho phép. */
  fullAccess: z.boolean(),
  /** Đã đủ số phiên terminal của máy. */
  busy: z.boolean(),
  accounts: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      loggedIn: z.boolean().nullable(),
      sessionPct: z.number().nullable(),
      weekPct: z.number().nullable(),
    }),
  ),
});
export type TerminalMachineOption = z.output<typeof terminalMachineOption>;

/** Chi phí trung bình mỗi run code của model trong 30 ngày qua của tổ chức, để người mở thấy giá khi chọn opus. */
export const terminalCostHint = z.object({
  model: terminalModel,
  avgRunUsd: z.number().nullable(),
  runs: z.number().int().min(0),
});

export const terminalOptions = z.object({
  /** Hub bật Terminal Leader (HIVE_REMOTE_TERMINAL). */
  enabled: z.boolean(),
  /** Người gọi mở được phiên cho dự án này (quản trị đội hoặc BA/PO). */
  allowed: z.boolean(),
  machines: z.array(terminalMachineOption),
  defaultModel: terminalModel,
  /** Dự án bật cố vấn (định tuyến cấp nặng có `advisor`): phiên sonnet chạy kèm cố vấn đó. */
  advisor: z.string().nullable(),
  costs: z.array(terminalCostHint),
});
export type TerminalOptions = z.output<typeof terminalOptions>;

/** Một lần Leader gọi tool hub ở chế độ Bypass (đọc từ audit `mcp.*` của phiên). */
export const terminalAction = z.object({
  id,
  at: z.iso.datetime(),
  tool: z.string(),
  outcome: z.enum(["success", "error"]),
  /** Tóm tắt hành động khi tool là `leader_action`. */
  action: z.string().nullable(),
  tier: taskTier.nullable(),
  model: z.string().nullable(),
  reason: z.string().nullable(),
});
export type TerminalAction = z.output<typeof terminalAction>;

export const terminalErrors = {
  TERMINAL_DISABLED: "Hub chưa bật Terminal Leader (HIVE_REMOTE_TERMINAL).",
  TERMINAL_ROLE_REQUIRED: "Chỉ quản trị đội hoặc BA/PO của đội sở hữu dự án mở được terminal Leader.",
  TERMINAL_MACHINE_INVALID: "Chỉ mở được trên máy dùng chung đang online, có hỗ trợ terminal và thuộc đội của dự án.",
  TERMINAL_MACHINE_BUSY: "Máy đã đủ số phiên terminal. Chọn máy khác hoặc đóng phiên cũ.",
  TERMINAL_BYPASS_CONFIRM: "Chế độ Bypass cần xác nhận trước khi mở.",
  TERMINAL_NOT_FOUND: "Không tìm thấy phiên terminal.",
  TERMINAL_CLOSED: "Phiên terminal đã kết thúc.",
} as const;

const sessionRef = z.object({ id });

export const terminalContract = {
  options: orgRoute("GET", "/v1/terminal/options", "Máy, gói và model mở được terminal Leader", "terminal")
    .input(z.object({ projectId: id }))
    .output(terminalOptions),
  open: orgRoute("POST", "/v1/terminal/sessions", "Mở phiên terminal Leader", "terminal")
    .input(
      z.object({
        projectId: id,
        machineId: id,
        accountId: z.string().min(1).max(64).optional(),
        mode: terminalMode,
        /** Bắt buộc `true` khi `mode` là `bypass`: người mở đã đọc và xác nhận cảnh báo. */
        confirmBypass: z.boolean().optional(),
        model: terminalModel.default("sonnet"),
        planId: id.optional(),
        cols: terminalCols,
        rows: terminalRows,
      }),
    )
    .output(terminalSession),
  list: orgRoute("GET", "/v1/terminal/sessions", "Phiên terminal của tôi và phiên đội được xem", "terminal")
    .input(z.object({ projectId: id.optional() }))
    .output(z.array(terminalSession)),
  get: orgRoute("GET", "/v1/terminal/sessions/{id}", "Chi tiết phiên terminal", "terminal")
    .input(sessionRef)
    .output(terminalSession),
  close: orgRoute("POST", "/v1/terminal/sessions/{id}/close", "Đóng phiên terminal", "terminal")
    .input(sessionRef)
    .output(terminalSession),
  setVisibility: orgRoute("POST", "/v1/terminal/sessions/{id}/visibility", "Bật/tắt Cho đội xem", "terminal")
    .input(z.object({ id, visibility: terminalVisibility }))
    .output(terminalSession),
  ticket: orgRoute("POST", "/v1/terminal/sessions/{id}/ticket", "Vé mở WebSocket của phiên", "terminal")
    .input(sessionRef)
    .output(z.object({ ticket: z.string(), expiresAt: z.iso.datetime(), canInput: z.boolean() })),
  /** Bản ghi output đã che bí mật, theo `seq` tăng dần (phát lại phiên đã đóng). */
  chunks: orgRoute("GET", "/v1/terminal/sessions/{id}/chunks", "Bản ghi output của phiên", "terminal")
    .input(
      z.object({
        id,
        after: z.coerce.number().int().min(-1).default(-1),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
    )
    .output(z.object({ chunks: z.array(z.object({ seq: z.number().int(), data: z.base64() })), more: z.boolean() })),
  /** Khung bên phải: đề xuất của phiên (Đề xuất) hoặc nhật ký tool hub đã gọi (Bypass). */
  activity: orgRoute("GET", "/v1/terminal/sessions/{id}/activity", "Đề xuất và nhật ký hành động của phiên", "terminal")
    .input(sessionRef)
    .output(z.object({ proposals: z.array(approval), actions: z.array(terminalAction) })),
};

// ---- Khung WebSocket trình duyệt ↔ hub (`/ws/terminal?ticket=…`) ----

/** Trình duyệt → hub. `in` chỉ nhận từ chủ phiên; người xem gửi thì hub trả `error` và bỏ. */
export const terminalClientFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("in"), data: base64Max(TERMINAL_LIMITS.inputBytes) }),
  z.object({ t: z.literal("resize"), cols: terminalCols, rows: terminalRows }),
  /** Nối lại: hub gửi lại output sau `after` (seq) từ bộ đệm hoặc bản ghi. */
  z.object({ t: z.literal("resume"), after: z.number().int().min(-1) }),
  z.object({ t: z.literal("ping") }),
]);
export type TerminalClientFrame = z.output<typeof terminalClientFrame>;

export const terminalServerFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), session: terminalSession, canInput: z.boolean() }),
  z.object({ t: z.literal("out"), seq: z.number().int().min(0), data: z.base64() }),
  z.object({ t: z.literal("state"), session: terminalSession }),
  /** Có đề xuất mới hay tool hub vừa được gọi: web tải lại khung bên phải. */
  z.object({ t: z.literal("activity") }),
  z.object({ t: z.literal("error"), code: z.string(), message: z.string() }),
  z.object({ t: z.literal("pong") }),
]);
export type TerminalServerFrame = z.output<typeof terminalServerFrame>;

/** Mã đóng WebSocket `/ws/terminal`. */
export const TERMINAL_WS_CLOSE = {
  /** Vé sai, hết hạn hoặc đã dùng. */
  unauthorized: 4401,
  /** Sai Origin, mất vai trò, phiên không còn cho xem. */
  forbidden: 4403,
  /** Phiên không có hoặc đã kết thúc. */
  notFound: 4404,
  /** Gõ quá nhanh liên tục. */
  rateLimited: 4429,
} as const;

// ---- Phiên tương tác trên máy cá nhân và điều khiển từ xa (specs/010 US1–US8, ADR 0019) ----
//
// Tách khỏi phiên Leader ở trên vì quyền khác hẳn: phiên do chủ máy mở tại máy (`hive chat`) hoặc từ điện thoại đã ghép,
// chỉ chủ máy điều khiển, và worker tự kiểm passkey/TOTP và HMAC từng gói nhập; hub chỉ chuyển tiếp. Chung bảng
// `terminal_sessions` với phiên Leader nhưng route riêng dưới `/v1/remote` để không nới quyền của bên nào.

/** Giới hạn của phần từ xa (plan.md "Giới hạn", D9). Byte là byte thật trước base64. */
export const REMOTE_LIMITS = {
  /** Phiên ghi lên hub tối đa mỗi máy. */
  recordedSessionsPerMachine: 8,
  /** Kết nối xem mỗi phiên; trong đó tối đa `teamViewers` của người khác chủ (chế độ `team`). */
  viewersPerSession: 16,
  teamViewers: 4,
  /** Vòng đệm output mỗi phiên trong bộ nhớ hub; thiếu thì đọc `terminal_chunks`. */
  replayBytes: 512 * 1024,
  /** Băng thông trực tiếp mỗi người xem và mỗi máy; quá thì người xem nhận `sync`. */
  viewerRateBytes: 512 * 1024,
  machineRateBytes: 2 * 1024 * 1024,
  /** Đệm gửi một người xem vượt mức này thì hub bỏ phần giữa và gửi `sync`. */
  viewerBacklogBytes: 1024 * 1024,
  /** Worker giữ quyền điều khiển cho kết nối rớt chừng này, nối lại bằng `resumeToken` không cần passkey (FR-021). */
  resumeSec: 120,
  /** Không gõ chừng này thì worker thu quyền điều khiển. */
  controlIdleSec: 900,
  /** Hub chờ chủ máy bấm Cho phép tại máy (ghép, "Hỏi trên máy"). */
  confirmSec: 60,
  heartbeatSec: 20,
} as const;

/** Phiên bắt đầu ở đâu: `local` là `hive chat` tại máy, `remote` là mở từ điện thoại (`remote.start`). */
export const remoteOrigin = z.enum(["local", "remote"]);
export type RemoteOrigin = z.output<typeof remoteOrigin>;

export const remoteSession = z.object({
  id,
  machineId: id,
  machineName: z.string(),
  ownerId: z.string(),
  ownerName: z.string().nullable(),
  isOwner: z.boolean(),
  origin: remoteOrigin,
  cli,
  /** Nhãn gói (không có token hay email). */
  accountLabel: z.string().nullable(),
  /** Nhãn thư mục do worker gửi (nhãn root + thư mục con), không bao giờ là đường dẫn tuyệt đối. */
  cwdLabel: z.string().nullable(),
  projectId: id.nullable(),
  projectKey: z.string().nullable(),
  taskId: id.nullable(),
  taskKey: z.string().nullable(),
  state: terminalState,
  visibility: terminalVisibility,
  /** Phiên cho điều khiển từ xa (`--no-remote` hay máy đang tắt từ xa thì không). */
  remote: z.boolean(),
  /** Ai đang giữ phím: terminal tại máy, một kết nối từ xa, hay chưa ai (null). */
  controller: z.enum(["local", "remote"]).nullable(),
  cols: z.number().int(),
  rows: z.number().int(),
  exitCode: z.number().int().nullable(),
  endReason: z.string().nullable(),
  bytes: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
});
export type RemoteSession = z.output<typeof remoteSession>;

/** Trạng thái từ xa máy báo lần gần nhất (`term_state`), giữ trên hub để điện thoại thấy cả khi máy offline. */
export const remoteMachineState = z.object({
  enabled: z.boolean(),
  roots: z.array(z.object({ id: remoteId, label: z.string() })),
  clis: z.array(cli),
  accounts: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      cli,
      state: z.enum(["ready", "cooldown", "disabled", "logged_out"]),
    }),
  ),
  /** Mã Authenticator (đường lui khi hub chạy HTTP, D15). Khoá không bao giờ rời máy, hub chỉ biết bật/khoá. */
  totp: z.object({ enabled: z.boolean(), locked: z.boolean(), lockedUntil: z.iso.datetime().nullable() }),
  confirmOnMachine: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type RemoteMachineState = z.output<typeof remoteMachineState>;

export const remoteMachine = z.object({
  id,
  name: z.string(),
  online: z.boolean(),
  /** Worker đang chạy có giữ được phiên tương tác (capability `terminal`). */
  terminal: z.boolean(),
  /** null khi máy chưa báo lần nào (worker cũ, chưa chạy `hive`). */
  remote: remoteMachineState.nullable(),
  /** Tổ chức cho dùng mã Authenticator khi hub chạy HTTP. */
  totpAllowed: z.boolean(),
  sessions: z.array(remoteSession),
});
export type RemoteMachine = z.output<typeof remoteMachine>;

export const remoteDevice = z.object({
  id: remoteId,
  label: z.string(),
  userId: z.string(),
  /** Passkey đồng bộ (iCloud, Google) có trên nhiều thiết bị cùng tài khoản nền tảng: gỡ là gỡ ở mọi nơi. */
  synced: z.boolean(),
  createdAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type RemoteDevice = z.output<typeof remoteDevice>;

/**
 * Tuỳ chọn tạo passkey khi ghép (`navigator.credentials.create`). Worker không đọc attestation (dùng `getPublicKey()` và
 * tag ghép, D6), nên `challenge` chỉ cần ngẫu nhiên; UV bắt buộc để mỗi lần dùng đều hỏi sinh trắc hay mã máy.
 */
export const remotePairOptions = z.object({
  machineName: z.string(),
  /** Người dùng hub được ghép; điện thoại đưa vào tag ghép (`pairTagPayload`). */
  userId: z.string(),
  publicKey: z.object({
    rp: z.object({ id: z.string(), name: z.string() }),
    user: z.object({ id: base64url(64), name: z.string(), displayName: z.string() }),
    challenge: base64url(64),
    pubKeyCredParams: z.array(z.object({ type: z.literal("public-key"), alg: z.literal(-7) })),
    timeout: z.number().int(),
    authenticatorSelection: z.object({
      userVerification: z.literal("required"),
      residentKey: z.enum(["discouraged", "preferred", "required"]),
    }),
    attestation: z.literal("none"),
    /** Thiết bị đã ghép với máy này, để trình duyệt không tạo trùng passkey. */
    excludeCredentials: z.array(z.object({ type: z.literal("public-key"), id: base64url(1024) })),
  }),
});
export type RemotePairOptions = z.output<typeof remotePairOptions>;

export const remotePairCompleteInput = z.object({
  machineId: id,
  pairId: remoteId,
  label: z.string().trim().min(1, "Đặt tên cho thiết bị.").max(80, "Tên thiết bị dài tối đa 80 ký tự."),
  credentialId: base64url(1024),
  spki: base64url(512),
  /** HMAC(bí mật ghép trong fragment URL, `pairTagPayload`); hub không biết bí mật nên không giả được (FR-014). */
  tag: z.base64url().length(43),
  synced: z.boolean().default(false),
});

/** Mở phiên mới từ điện thoại. `model` và mức quyền do hub điền theo chính sách tổ chức, không nhận từ trình duyệt. */
export const remoteStartInput = z.object({
  machineId: id,
  /** Thiết bị đã ghép khi `auth` là passkey; TOTP không gắn với thiết bị (trang HTTP không tạo được passkey). */
  deviceId: remoteId.optional(),
  cli,
  accountId: z.string().min(1).max(64).optional(),
  rootId: remoteId,
  subdir: z.string().min(1).max(500).optional(),
  projectId: id.optional(),
  taskId: id.optional(),
  prompt: z.string().min(1).max(20_000).optional(),
  cols: terminalCols,
  rows: terminalRows,
  auth: remoteAuth,
});
export type RemoteStartInput = z.input<typeof remoteStartInput>;

export const pushSubscription = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({ p256dh: base64url(65), auth: base64url(16) }),
  deviceLabel: z.string().trim().max(80).optional(),
});
export type PushSubscriptionInput = z.input<typeof pushSubscription>;

/**
 * Lỗi của hub cho phần từ xa. Lỗi do worker từ chối (`term_denied`) dùng mã của `termDenyCode` và câu trong
 * `TERM_DENY_MESSAGES`, hub chuyển nguyên.
 */
export const remoteErrors = {
  REMOTE_DISABLED_HUB: "Hub chưa bật điều khiển từ xa (HIVE_REMOTE_TERMINAL).",
  MACHINE_NOT_YOURS: "Chỉ chủ máy điều khiển được máy này.",
  MACHINE_SHARED: TERM_DENY_MESSAGES.MACHINE_SHARED,
  MACHINE_OFFLINE: "Máy đang offline. Mở hive-worker trên máy rồi thử lại.",
  MACHINE_NO_TERMINAL: "Worker trên máy chưa hỗ trợ phiên tương tác. Chạy `hive-worker update`.",
  REMOTE_NOT_ENABLED: TERM_DENY_MESSAGES.REMOTE_DISABLED,
  SESSION_NOT_FOUND: "Không tìm thấy phiên.",
  SESSION_ENDED: "Phiên đã kết thúc.",
  SESSION_NOT_REMOTE: "Phiên này không cho điều khiển từ xa.",
  PAIR_EXPIRED: "Mã ghép đã hết hạn hoặc đã dùng. Tạo mã mới tại máy.",
  PAIR_BAD_TAG: "Mã ghép không khớp. Quét lại mã QR trên máy.",
  PAIR_DENIED: "Chủ máy đã từ chối ghép tại máy.",
  PAIR_TIMEOUT: "Không có ai bấm Cho phép tại máy trong thời gian chờ.",
  PAIR_USER_MISMATCH: "Mã ghép được tạo cho người dùng khác.",
  DEVICE_NOT_FOUND: "Không tìm thấy thiết bị.",
  TOTP_NOT_ALLOWED: TERM_DENY_MESSAGES.TOTP_NOT_ALLOWED,
  START_TIMEOUT: "Máy không trả lời yêu cầu mở phiên. Thử lại.",
  PUSH_UNAVAILABLE: "Hub chưa sẵn sàng gửi thông báo đẩy.",
} as const;
export type RemoteErrorCode = keyof typeof remoteErrors;

/**
 * Hành động audit của phần từ xa (plan.md "Quyền"). Gói từ worker về việc làm tại máy (bật, root, ghép, TOTP) ghi với
 * người làm là chủ máy và `data.source = "machine"`.
 */
export const REMOTE_AUDIT_ACTIONS = [
  "terminal.remote_enable",
  "terminal.remote_disable",
  "terminal.root_add",
  "terminal.root_remove",
  "terminal.pair",
  "terminal.pair_denied",
  "terminal.device_revoke",
  "terminal.open",
  "terminal.deny",
  "terminal.attach",
  "terminal.detach",
  "terminal.control_grant",
  "terminal.control_revoke",
  "terminal.control_take",
  "terminal.resize",
  "terminal.input_rejected",
  "terminal.close",
  "terminal.exit",
  "terminal.visibility",
  "terminal.totp_ok",
  "terminal.totp_fail",
  "terminal.totp_locked",
  "terminal.totp_enroll",
  "terminal.totp_disable",
  "cli.connect.exchange",
] as const;

const remoteSessionRef = z.object({ id });
const machineRef = z.object({ machineId: id });

export const remoteContract = {
  machines: orgRoute(
    "GET",
    "/v1/remote/machines",
    "Máy cá nhân của tôi và trạng thái điều khiển từ xa",
    "remote",
  ).output(z.array(remoteMachine)),
  list: orgRoute("GET", "/v1/remote/sessions", "Phiên tương tác trên máy cá nhân tôi xem được", "remote")
    .input(
      z.object({
        machineId: id.optional(),
        projectId: id.optional(),
        taskId: id.optional(),
        active: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]).optional(),
      }),
    )
    .output(z.array(remoteSession)),
  get: orgRoute("GET", "/v1/remote/sessions/{id}", "Chi tiết phiên tương tác", "remote")
    .input(remoteSessionRef)
    .output(remoteSession),
  /** Bản ghi đã che bí mật theo `seq` tăng dần (phát lại), cùng dạng với `terminal.chunks`. */
  chunks: orgRoute("GET", "/v1/remote/sessions/{id}/chunks", "Bản ghi output của phiên tương tác", "remote")
    .input(
      z.object({
        id,
        after: z.coerce.number().int().min(-1).default(-1),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
    )
    .output(z.object({ chunks: z.array(z.object({ seq: z.number().int(), data: z.base64() })), more: z.boolean() })),
  /** Vé chỉ xem; quyền gõ xin trong WS bằng passkey/TOTP (khung `control`), worker kiểm. */
  ticket: orgRoute("POST", "/v1/remote/sessions/{id}/ticket", "Vé mở WebSocket của phiên tương tác", "remote")
    .input(remoteSessionRef)
    .output(z.object({ ticket: z.string(), expiresAt: z.iso.datetime(), canControl: z.boolean() })),
  start: orgRoute("POST", "/v1/remote/sessions", "Mở phiên mới trên máy cá nhân từ điện thoại", "remote")
    .input(remoteStartInput)
    .output(remoteSession),
  close: orgRoute("POST", "/v1/remote/sessions/{id}/close", "Ngắt phiên tương tác", "remote")
    .input(remoteSessionRef)
    .output(remoteSession),
  setVisibility: orgRoute("POST", "/v1/remote/sessions/{id}/visibility", "Bật/tắt Cho đội xem phiên", "remote")
    .input(z.object({ id, visibility: terminalVisibility }))
    .output(remoteSession),
  /** Chỉ tắt: không có route bật hay thêm thiết bị (FR-012), những việc đó làm tại máy. */
  disableRemote: orgRoute("POST", "/v1/remote/machines/{machineId}/disable", "Tắt điều khiển từ xa ngay", "remote")
    .input(machineRef)
    .output(remoteMachine),
  pairOptions: orgRoute(
    "POST",
    "/v1/remote/machines/{machineId}/pair/options",
    "Tuỳ chọn tạo passkey để ghép",
    "remote",
  )
    .input(z.object({ machineId: id, pairId: remoteId }))
    .output(remotePairOptions),
  /** Hub chuyển `term_pair` tới máy rồi chờ chủ máy bấm Cho phép tại máy (`REMOTE_LIMITS.confirmSec`). */
  pairComplete: orgRoute("POST", "/v1/remote/machines/{machineId}/pair", "Ghép thiết bị với máy", "remote")
    .input(remotePairCompleteInput)
    .output(remoteDevice),
  devices: orgRoute("GET", "/v1/remote/machines/{machineId}/devices", "Thiết bị đã ghép với máy", "remote")
    .input(machineRef)
    .output(z.array(remoteDevice)),
  revokeDevice: orgRoute("POST", "/v1/remote/machines/{machineId}/devices/{deviceId}/revoke", "Gỡ thiết bị", "remote")
    .input(z.object({ machineId: id, deviceId: remoteId }))
    .output(z.object({ machineId: id, deviceId: remoteId })),
  /** Khoá công khai VAPID (base64url); null khi hub chưa có khoá chủ để giữ khoá riêng. */
  pushKey: orgRoute("GET", "/v1/remote/push/key", "Khoá công khai Web Push của hub", "remote").output(
    z.object({ publicKey: base64url(65).nullable() }),
  ),
  pushSubscribe: orgRoute("POST", "/v1/remote/push/subscriptions", "Nhận thông báo đẩy trên thiết bị này", "remote")
    .input(pushSubscription)
    .output(z.object({ id })),
  pushUnsubscribe: orgRoute(
    "POST",
    "/v1/remote/push/unsubscribe",
    "Thôi nhận thông báo đẩy trên thiết bị này",
    "remote",
  )
    .input(z.object({ endpoint: z.url().max(2000) }))
    .output(z.object({ removed: z.boolean() })),
};

// ---- Khung WebSocket trình duyệt ↔ hub cho phiên trên máy cá nhân (`/ws/terminal?ticket=…`) ----

const inputMac = z.base64url().length(22);
const inputSeq = z.number().int().min(0);

/**
 * Trình duyệt → hub. `in`/`resize` mang `seq` tăng nghiêm ngặt và HMAC (`inputMacPayload`); hub chỉ chuyển của kết nối
 * của chủ máy đã được cấp quyền, worker kiểm lại và bỏ gói sai (FR-017).
 */
export const remoteClientFrame = z.discriminatedUnion("t", [
  /**
   * Nối lại: hub gửi output sau `after`; có `resumeToken` còn hạn thì worker cấp lại quyền với khoá cũ. `deviceId` là
   * passkey của lần cấp (cấp bằng TOTP thì bỏ trống), hub dùng khi vừa khởi động lại và không còn nhớ token; worker vẫn
   * so token với đúng người và thiết bị của lần cấp.
   */
  z.object({
    t: z.literal("resume"),
    after: z.number().int().min(-1),
    resumeToken: z.base64url().max(64).optional(),
    deviceId: remoteId.optional(),
  }),
  /** Xin quyền gõ. Challenge ký gồm `connId` hub gửi trong `hello` nên assertion không dùng được cho kết nối khác. */
  z.object({ t: z.literal("control"), deviceId: remoteId.optional(), auth: remoteAuth }),
  z.object({ t: z.literal("release") }),
  z.object({ t: z.literal("in"), seq: inputSeq, data: base64Max(TERMINAL_LIMITS.inputBytes), mac: inputMac }),
  z.object({ t: z.literal("resize"), seq: inputSeq, cols: terminalCols, rows: terminalRows, mac: inputMac }),
  z.object({ t: z.literal("ping") }),
]);
export type RemoteClientFrame = z.output<typeof remoteClientFrame>;

export const remoteServerFrame = z.discriminatedUnion("t", [
  /** `canControl`: người xem là chủ máy và phiên cho điều khiển từ xa (vẫn phải qua passkey/TOTP). */
  z.object({ t: z.literal("hello"), session: remoteSession, connId: remoteId, canControl: z.boolean() }),
  z.object({ t: z.literal("out"), seq: z.number().int().min(0), data: z.base64() }),
  /** Client chậm hoặc thiếu đoạn: xoá màn hình và phát lại từ `after` (D9). */
  z.object({ t: z.literal("sync"), after: z.number().int().min(-1) }),
  z.object({ t: z.literal("state"), session: remoteSession }),
  z.object({ t: z.literal("granted"), workerEphPub: ephPub, resumeToken: z.base64url().max(64) }),
  z.object({
    t: z.literal("revoked"),
    reason: z.enum(["taken", "idle", "disabled", "device_revoked", "input_rejected", "closed", "expired"]),
  }),
  z.object({ t: z.literal("denied"), code: termDenyCode, message: z.string() }),
  z.object({ t: z.literal("event"), event: termEventKind, data: z.record(z.string(), z.unknown()).optional() }),
  z.object({ t: z.literal("error"), code: z.string(), message: z.string() }),
  z.object({ t: z.literal("pong") }),
]);
export type RemoteServerFrame = z.output<typeof remoteServerFrame>;
