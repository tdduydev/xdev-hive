import { oc } from "@orpc/contract";
import { z } from "zod";
import { cli, machineId, workerOs } from "./worker-protocol.ts";

const id = z.uuid("Mã không hợp lệ.");
// `code` ổn định để client phân biệt lý do mà không phải đọc message.
const reason = z.object({ code: z.string() }).optional();

export const machineKind = z.enum(["worker", "host"]);
export type MachineKind = z.output<typeof machineKind>;

export const machineStatus = z.enum(["online", "offline", "paused", "revoked"]);
export type MachineStatus = z.output<typeof machineStatus>;

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
});
export type Machine = z.output<typeof machine>;

export const registrationOutput = z.object({
  /** Chỉ hiện một lần; hub chỉ lưu băm. */
  token: z.string(),
  expiresAt: z.iso.datetime(),
  /** Lệnh cài một dòng để dán vào máy dev. */
  command: z.string(),
});

export const registerInput = z.object({
  registrationToken: z.string().min(1).max(200),
  machineId,
  os: workerOs,
  version: z.string().max(40),
  clis: z.array(cli).max(10).default([]),
  capacity: z.number().int().min(0).max(64).default(1),
  /** Khoá công khai của máy (mục 6), để sau đổi sang access token ngắn hạn. Chưa bắt buộc. */
  publicKey: z.string().max(2000).optional(),
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
      .input(z.object({ teamId: id, kind: machineKind.default("worker") }))
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
    resume: oc
      .route({ method: "POST", path: "/v1/machines/{machineId}/resume", summary: "Chạy lại máy", tags: ["fleet"] })
      .errors(userErrors)
      .input(z.object({ machineId: id }))
      .output(machine),
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
  },
};
