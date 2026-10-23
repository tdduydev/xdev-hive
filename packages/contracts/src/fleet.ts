import { oc } from "@orpc/contract";
import { z } from "zod";
import { clientEventResult, machineEventInput, tokenScoreLevel, tokenScoreReport } from "./client-events.ts";
import { orgRoute } from "./common.ts";
import { accountLoginCli, accountLoginHow, cli, machineId, workerAccountSummary, workerOs } from "./worker-protocol.ts";

const id = z.uuid("Mã không hợp lệ.");
// `code` ổn định để client phân biệt lý do mà không phải đọc message.
const reason = z.object({ code: z.string() }).optional();

export const machineKind = z.enum(["worker", "host"]);
export type MachineKind = z.output<typeof machineKind>;

export const machineStatus = z.enum(["online", "offline", "paused", "revoked"]);
export type MachineStatus = z.output<typeof machineStatus>;

/** Nhãn máy (specs/011 FR-041): hub đặt, worker không tự khai, để máy không tự nhận nhãn để lấy việc. */
export const machineLabel = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "Nhãn gồm chữ thường không dấu, số, `-`, tối đa 32 ký tự.");
export const machineLabels = z
  .array(machineLabel)
  .max(10, "Máy có tối đa 10 nhãn.")
  .transform((list) => [...new Set(list)]);

export const machine = z.object({
  id,
  teamId: id,
  kind: machineKind,
  /** Định danh máy tự chọn khi đăng ký, cũng là `machineId` trong gói hello. */
  name: z.string(),
  os: z.string(),
  version: z.string(),
  clis: z.array(z.string()),
  capacity: z.number().int(),
  status: machineStatus,
  lastSeenAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /**
   * Máy dùng chung của đội: nhận run của đội và của mọi thành viên. false là máy cá nhân, chỉ nhận run của người đã
   * đăng ký máy (CLI trên máy đăng nhập bằng tài khoản của họ). Runner host luôn tính là dùng chung.
   */
  shared: z.boolean(),
  /** Người đã đăng ký máy (chủ máy cá nhân). */
  registeredBy: z.string().nullable(),
  // Các trường dưới thêm cho AI SDLC (specs/011); hub chưa có cột thì không trả.
  /** Rỗng khi không trả. */
  labels: z.array(z.string()).optional(),
  /** Chỉ nhận run có ít nhất một nhãn của máy. */
  labelsOnly: z.boolean().optional(),
  /** Capability worker khai trong hello (`sdlc`, `accounts-remote`…). */
  capabilities: z.array(z.string()).optional(),
  /** Tóm tắt tài khoản CLI từ heartbeat; null hoặc không có khi worker chưa báo ("Máy chưa báo gói"). */
  accounts: z.array(workerAccountSummary).nullable().optional(),
  accountsAt: z.iso.datetime().nullable().optional(),
  /** Id dự án máy đã gắn với một repo local (ADR 0020). Rỗng khi không trả. */
  boundProjects: z.array(z.string()).optional(),
  /** Id dự án máy đã bật toàn quyền (ADR 0020); run chỉ nhận toàn quyền khi chính sách tổ chức cũng cho. */
  fullProjects: z.array(z.string()).optional(),
  /** Điểm tối ưu token máy gửi lần gần nhất (specs/025 US6, ADR 0036); null khi máy chưa bật gửi hay chưa gửi. */
  tokenScore: z
    .object({
      score: z.number().nullable(),
      level: tokenScoreLevel.nullable(),
      coverage: z.number(),
      provisional: z.boolean(),
      reportedAt: z.iso.datetime(),
    })
    .nullable()
    .optional(),
});
export type Machine = z.output<typeof machine>;

/** Chi tiết điểm token của một máy: bản mới nhất đầy đủ và điểm máy theo thời gian (90 ngày). */
export const machineTokenScore = z.object({
  machineId: id,
  latest: z.object({ reportedAt: z.iso.datetime(), report: tokenScoreReport }).nullable(),
  history: z.array(z.object({ reportedAt: z.iso.datetime(), score: z.number().nullable(), coverage: z.number() })),
});
export type MachineTokenScore = z.output<typeof machineTokenScore>;

/**
 * Máy trên trang Đội máy AI SDLC (specs/011 US15): máy có nhãn của đội, kèm run `sdlc` và run task hạng mục đang chạy.
 * Máy cá nhân của người khác có `accounts` null (ADR 0017).
 */
export const sdlcFleetMachine = machine.extend({
  teamName: z.string(),
  slotsUsed: z.number().int(),
  runs: z.array(
    z.object({
      runId: id,
      kind: z.string(),
      projectKey: z.string(),
      /** Hạng mục và bước khi run thuộc AI SDLC. */
      item: z.object({ id, ref: z.string(), title: z.string() }).nullable(),
      step: z.string().nullable(),
      startedAt: z.iso.datetime().nullable(),
    }),
  ),
  /** Mọi tài khoản dưới ngưỡng dừng: lúc sớm nhất có tài khoản dùng lại được. */
  quotaResetsAt: z.iso.datetime().nullable(),
  /** Quản trị đội bật/tắt tài khoản được: máy dùng chung và worker có capability `accounts-remote`. */
  canSetAccounts: z.boolean(),
});
export type SdlcFleetMachine = z.output<typeof sdlcFleetMachine>;

export const accountLoginStatus = z.enum(["starting", "waiting", "done", "error", "cancelled", "expired"]);
export type AccountLoginStatus = z.output<typeof accountLoginStatus>;

/**
 * Phiên đăng nhập gói từ web. Hub chỉ giữ trong bộ nhớ tới khi phiên kết thúc: URL và mã thiết bị là để người dùng mở
 * trên máy mình; chữ người dùng dán (mã xác nhận, token) không bao giờ có ở đây.
 */
export const accountLogin = z.object({
  requestId: z.string(),
  machineId: id,
  cli: accountLoginCli,
  label: z.string(),
  how: accountLoginHow,
  status: accountLoginStatus,
  /** URL đăng nhập worker bắt được từ CLI. */
  url: z.string().nullable(),
  /** Mã thiết bị (Codex `--device-auth`) người dùng nhập ở trang đăng nhập. */
  code: z.string().nullable(),
  /** Worker đang chờ người dùng dán chữ (mã xác nhận Claude, token). */
  needsInput: z.boolean(),
  accountId: z.string().nullable(),
  error: z.string().nullable(),
  startedBy: z.string(),
  startedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type AccountLogin = z.output<typeof accountLogin>;

/**
 * Gói agent của một máy trên trang Máy (T063). `remote` true khi quản trị đội điều khiển được gói từ web: máy dùng chung,
 * đang online, worker có capability `accounts-remote`. `reason` nói vì sao không (để web hiện đúng lời nhắc).
 */
export const machineAccounts = z.object({
  machineId: id,
  accounts: z.array(workerAccountSummary).nullable(),
  accountsAt: z.iso.datetime().nullable(),
  remote: z.boolean(),
  reason: z.enum(["personal", "offline", "old_worker"]).nullable(),
  /** Phiên đăng nhập đang chạy trên máy (mỗi máy tối đa một), để mở lại bước đang dở. */
  login: accountLogin.nullable(),
});
export type MachineAccounts = z.output<typeof machineAccounts>;

export const accountLoginStartInput = z
  .object({
    machineId: id,
    cli: accountLoginCli,
    label: z.string().trim().min(1, "Cần tên gói.").max(80, "Tên gói tối đa 80 ký tự."),
    how: accountLoginHow,
  })
  .refine((v) => (v.cli === "codex" ? v.how === "device" : v.how !== "device"), {
    message: "Codex đăng nhập bằng mã thiết bị; Claude theo gói, SSO, Console hoặc token.",
    path: ["how"],
  });

export const registrationOutput = z.object({
  /** Chỉ hiện một lần; hub chỉ lưu băm. */
  token: z.string(),
  expiresAt: z.iso.datetime(),
  /** Lệnh đăng ký cho máy đã có hive-worker (app desktop đọc lệnh này khi người dùng dán vào). */
  command: z.string(),
  /** Một dòng cho Linux, macOS: tải bản phát hành, kiểm chữ ký, đăng ký máy, cài dịch vụ (runner host thì không). */
  installCommand: z.string(),
  /** Như installCommand, cho PowerShell trên Windows. */
  installCommandWindows: z.string(),
});

/** Bản worker mới nhất trên trang phát hành, để web chỉ ra máy đang chạy bản cũ. */
export const workerRelease = z.object({
  /** Không có tiền tố v. */
  version: z.string(),
  url: z.url(),
  publishedAt: z.iso.datetime().nullable(),
});
export type WorkerRelease = z.output<typeof workerRelease>;

/** Ed25519 32 byte, base64url không padding. */
export const machinePublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Khoá công khai không hợp lệ.");
/** `file`: máy không có keychain, khoá nằm trong file 0600; trang Máy hiện để quản trị biết máy giữ khoá yếu hơn. */
export const machineKeyStorage = z.enum(["keychain", "file"]);

export const registerInput = z.object({
  registrationToken: z.string().min(1).max(200),
  machineId,
  os: workerOs,
  version: z.string().max(40),
  clis: z.array(cli).max(10).default([]),
  capacity: z.number().int().min(0).max(64).default(1),
  /** Khoá công khai Ed25519 của máy (ADR 0033). Worker cũ không gửi thì máy dùng machine token tới khi đăng ký khoá. */
  publicKey: machinePublicKey.optional(),
  keyStorage: machineKeyStorage.optional(),
});

export const registerOutput = z.object({
  /** Id của máy trên hub. */
  id,
  orgId: id,
  teamId: id,
  machineId,
  /** Chỉ trả một lần; worker lưu vào file cấu hình và gửi trong header Authorization khi mở WSS. */
  machineToken: z.string(),
});

export type RegisterInput = z.output<typeof registerInput>;
export type RegisterOutput = z.output<typeof registerOutput>;

/** Máy đăng ký trước khi có khoá: gửi bằng machine token, xong thì token đó hết dùng được. */
export const workerKeyInput = z.object({ publicKey: machinePublicKey, keyStorage: machineKeyStorage });
export const workerKeyOutput = z.object({ machineId: id, registeredAt: z.iso.datetime() });

export const workerChallengeInput = z.object({ machine: id });
export const workerChallengeOutput = z.object({ nonce: z.string().max(200), expiresAt: z.iso.datetime() });

/** Chuỗi máy ký để đổi lấy access token. Có hubUrl để chữ ký cho hub này không dùng được ở hub khác. */
export const machineTokenMessage = (hubUrl: string, machineId: string, nonce: string) =>
  `xdev-hive-machine-token\n${hubUrl}\n${machineId}\n${nonce}`;

export const workerTokenInput = z.object({
  machineId: id,
  nonce: z.string().max(200),
  /** Ed25519 trên `machineTokenMessage`, base64url không padding. */
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export const workerTokenOutput = z.object({ accessToken: z.string(), expiresAt: z.iso.datetime() });

export type WorkerKeyInput = z.output<typeof workerKeyInput>;
export type WorkerTokenInput = z.output<typeof workerTokenInput>;

// Một lỗi cho mọi lý do (nonce, chữ ký, máy không có khoá, máy bị thu hồi) để không ai dò được máy nào tồn tại.
const machineAuthErrors = {
  BAD_REQUEST: { message: "Dữ liệu gửi lên không hợp lệ." },
  MACHINE_AUTH_FAILED: { status: 401, message: "Máy không xác thực được với hub." },
  TOO_MANY_REQUESTS: { message: "Máy xin token quá nhiều lần; thử lại sau." },
};

const userErrors = {
  UNAUTHORIZED: { message: "Chưa đăng nhập." },
  BAD_REQUEST: { message: "Dữ liệu gửi lên không hợp lệ." },
  FORBIDDEN: { message: "Bạn không có quyền làm việc này.", data: reason },
  NOT_FOUND: { message: "Không tìm thấy.", data: reason },
};

export const fleetContract = {
  machines: {
    list: oc
      .route({ method: "GET", path: "/v1/teams/{teamId}/machines", summary: "Máy của đội", tags: ["fleet"] })
      .errors(userErrors)
      .input(z.object({ teamId: id }))
      .output(z.array(machine)),
    createRegistration: oc
      .route({
        method: "POST",
        path: "/v1/teams/{teamId}/machines/registrations",
        summary: "Tạo mã đăng ký máy (dùng một lần, hết hạn sau 1 giờ)",
        tags: ["fleet"],
      })
      .errors(userErrors)
      .input(
        z.object({
          teamId: id,
          kind: machineKind.default("worker"),
          // Máy worker AI SDLC (specs/011 FR-042): máy nhận nhãn và cờ từ mã, không cần cờ mới cho install.sh.
          labels: machineLabels.default([]),
          shared: z.boolean().default(false),
          labelsOnly: z.boolean().default(false),
        }),
      )
      .output(registrationOutput),
    revoke: oc
      .route({ method: "POST", path: "/v1/machines/{machineId}/revoke", summary: "Thu hồi máy", tags: ["fleet"] })
      .errors(userErrors)
      .input(z.object({ machineId: id }))
      .output(machine),
    pause: oc
      .route({ method: "POST", path: "/v1/machines/{machineId}/pause", summary: "Tạm dừng máy", tags: ["fleet"] })
      .errors(userErrors)
      .input(z.object({ machineId: id }))
      .output(machine),
    setShared: oc
      .route({
        method: "POST",
        path: "/v1/machines/{machineId}/shared",
        summary: "Bật hoặc tắt dùng chung cho máy (quản trị đội)",
        tags: ["fleet"],
      })
      .errors(userErrors)
      .input(z.object({ machineId: id, shared: z.boolean() }))
      .output(machine),
    resume: oc
      .route({ method: "POST", path: "/v1/machines/{machineId}/resume", summary: "Chạy lại máy", tags: ["fleet"] })
      .errors(userErrors)
      .input(z.object({ machineId: id }))
      .output(machine),
    update: oc
      .route({
        method: "POST",
        path: "/v1/machines/{machineId}/update",
        summary: "Yêu cầu máy tự cập nhật worker (chờ run đang chạy xong)",
        tags: ["fleet"],
      })
      .errors({ ...userErrors, CONFLICT: { message: "Máy không ở trạng thái cập nhật được.", data: reason } })
      .input(
        z.object({
          machineId: id,
          /** Bỏ trống là bản mới nhất. */
          version: z
            .string()
            .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Phiên bản phải dạng X.Y.Z.")
            .optional(),
        }),
      )
      .output(machine),
    setLabels: oc
      .route({
        method: "POST",
        path: "/v1/machines/{machineId}/labels",
        summary: "Đặt nhãn máy và cờ chỉ nhận run có nhãn (quản trị đội); áp cho lần giao run kế",
        tags: ["fleet"],
      })
      .errors(userErrors)
      .input(z.object({ machineId: id, labels: machineLabels, labelsOnly: z.boolean() }))
      .output(machine),
    setAccount: oc
      .route({
        method: "POST",
        path: "/v1/machines/{machineId}/accounts/{accountId}",
        summary: "Bật hoặc tắt một tài khoản CLI trên máy dùng chung (quản trị đội)",
        tags: ["fleet"],
      })
      .errors({
        ...userErrors,
        CONFLICT: { message: "Cập nhật worker để điều khiển gói từ web.", data: reason },
      })
      .input(z.object({ machineId: id, accountId: z.string().min(1).max(64), enabled: z.boolean() }))
      .output(machine),
    accounts: {
      list: oc
        .route({
          method: "GET",
          path: "/v1/machines/{machineId}/accounts",
          summary: "Gói agent của máy và phiên đăng nhập đang chạy (quản trị đội)",
          tags: ["fleet"],
        })
        .errors(userErrors)
        .input(z.object({ machineId: id }))
        .output(machineAccounts),
      loginStart: oc
        .route({
          method: "POST",
          path: "/v1/machines/{machineId}/accounts/logins",
          summary: "Bắt đầu đăng nhập gói mới trên máy dùng chung; worker trả URL hoặc mã thiết bị",
          tags: ["fleet"],
        })
        .errors({ ...userErrors, CONFLICT: { message: "Máy không đăng nhập gói từ web được.", data: reason } })
        .input(accountLoginStartInput)
        .output(accountLogin),
      loginGet: oc
        .route({
          method: "GET",
          path: "/v1/machines/{machineId}/accounts/logins/{requestId}",
          summary: "Trạng thái phiên đăng nhập gói",
          tags: ["fleet"],
        })
        .errors(userErrors)
        .input(z.object({ machineId: id, requestId: z.string().min(1).max(64) }))
        .output(accountLogin),
      loginInput: oc
        .route({
          method: "POST",
          path: "/v1/machines/{machineId}/accounts/logins/{requestId}/input",
          summary: "Gửi mã xác nhận hoặc token người dùng dán xuống máy (hub không lưu)",
          tags: ["fleet"],
        })
        .errors({ ...userErrors, CONFLICT: { message: "Phiên đăng nhập không chờ nhập.", data: reason } })
        .input(
          z.object({ machineId: id, requestId: z.string().min(1).max(64), text: z.string().trim().min(1).max(4096) }),
        )
        .output(accountLogin),
      loginCancel: oc
        .route({
          method: "POST",
          path: "/v1/machines/{machineId}/accounts/logins/{requestId}/cancel",
          summary: "Huỷ phiên đăng nhập gói; worker xoá gói dở",
          tags: ["fleet"],
        })
        .errors(userErrors)
        .input(z.object({ machineId: id, requestId: z.string().min(1).max(64) }))
        .output(accountLogin),
    },
    sdlc: orgRoute("GET", "/v1/machines/sdlc", "Đội máy AI SDLC: máy có nhãn, run đang chạy, gói và quota", "fleet")
      .input(z.object({ teamId: id.optional() }))
      .output(z.array(sdlcFleetMachine)),
    tokenScore: oc
      .route({
        method: "GET",
        path: "/v1/machines/{machineId}/token-score",
        summary: "Điểm tối ưu token của máy: bản mới nhất và lịch sử 90 ngày",
        tags: ["fleet"],
      })
      .errors(userErrors)
      .input(z.object({ machineId: id }))
      .output(machineTokenScore),
    deleteMyProjectUsage: oc
      .route({
        method: "DELETE",
        path: "/v1/machines/{id}/project-usage",
        summary: "Xoá số token theo dự án mà máy của mình đã gửi lên (chủ máy)",
        tags: ["fleet"],
      })
      .errors(userErrors)
      .input(z.object({ id }))
      .output(z.object({ deleted: z.number().int().nonnegative() })),
    workerRelease: oc
      .route({
        method: "GET",
        path: "/v1/worker/releases/latest",
        summary: "Bản worker mới nhất (null khi hub không tra được)",
        tags: ["fleet"],
      })
      .errors({ UNAUTHORIZED: userErrors.UNAUTHORIZED })
      .output(workerRelease.nullable()),
  },
  worker: {
    register: oc
      .route({
        method: "POST",
        path: "/v1/worker/register",
        summary: "Worker đổi mã đăng ký lấy machine token",
        tags: ["worker"],
      })
      .errors({
        BAD_REQUEST: { message: "Dữ liệu gửi lên không hợp lệ." },
        UNAUTHORIZED: { message: "Mã đăng ký không hợp lệ, đã hết hạn hoặc đã dùng." },
        CONFLICT: { message: "Tên máy đã được đội khác dùng.", data: reason },
      })
      .input(registerInput)
      .output(registerOutput),
    registerKey: oc
      .route({
        method: "POST",
        path: "/v1/worker/key",
        summary: "Máy đăng ký trước bản có khoá: gửi khoá công khai bằng machine token",
        tags: ["worker"],
      })
      .errors({
        BAD_REQUEST: { message: "Dữ liệu gửi lên không hợp lệ." },
        UNAUTHORIZED: { message: "Machine token không hợp lệ hoặc máy đã bị thu hồi." },
        MACHINE_KEY_EXISTS: {
          status: 409,
          message: "Máy đã có khoá. Muốn đổi khoá thì đăng ký lại máy bằng mã đăng ký mới.",
        },
      })
      .input(workerKeyInput)
      .output(workerKeyOutput),
    challenge: oc
      .route({
        method: "GET",
        path: "/v1/worker/challenge",
        summary: "Nonce để máy ký đổi lấy access token (hết hạn sau 60 giây)",
        tags: ["worker"],
      })
      .errors(machineAuthErrors)
      .input(workerChallengeInput)
      .output(workerChallengeOutput),
    token: oc
      .route({
        method: "POST",
        path: "/v1/worker/token",
        summary: "Máy đổi chữ ký trên nonce lấy access token 15 phút",
        tags: ["worker"],
      })
      .errors(machineAuthErrors)
      .input(workerTokenInput)
      .output(workerTokenOutput),
    clientEvent: oc
      .route({
        method: "POST",
        path: "/v1/client-events",
        summary: "Máy gửi sự kiện client (ADR 0036): xác thực bằng machine token, chống trùng theo khoá",
        tags: ["worker"],
      })
      .errors({
        BAD_REQUEST: { message: "Dữ liệu gửi lên không hợp lệ." },
        UNAUTHORIZED: { message: "Machine token không hợp lệ hoặc máy đã bị thu hồi." },
      })
      .input(machineEventInput)
      .output(clientEventResult),
  },
};
