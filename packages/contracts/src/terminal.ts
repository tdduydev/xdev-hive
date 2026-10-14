import { z } from "zod";
import { id, orgRoute } from "./common.ts";
import { approval } from "./leader.ts";
import { taskTier } from "./projects.ts";
import { base64Max, TERMINAL_LIMITS, terminalCols, terminalMode, terminalRows } from "./worker-protocol.ts";

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
