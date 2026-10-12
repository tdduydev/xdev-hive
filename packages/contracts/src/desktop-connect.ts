import { oc } from "@orpc/contract";
import { z } from "zod";
import { id, orgRoute } from "./common.ts";
import { machineId } from "./worker-protocol.ts";

/**
 * Đăng nhập app desktop bằng trình duyệt (OAuth cho app cài trên máy, RFC 8252 + PKCE RFC 7636). App mở cổng tạm trên
 * 127.0.0.1 rồi mở trang `/desktop/connect` của web; người dùng đăng nhập như thường, chọn đội và bấm Cho phép. Hub
 * chỉ trả về trình duyệt một mã đổi dùng một lần; app đổi mã đó (kèm verifier) lấy mã đăng ký máy và token cá nhân,
 * nên token không bao giờ nằm trên URL hay trong lịch sử trình duyệt.
 */

const base64url = /^[A-Za-z0-9_-]+$/;
/** S256 của verifier: 32 byte, base64url không đệm là đúng 43 ký tự. */
export const pkceChallenge = z.string().length(43).regex(base64url);
/** RFC 7636: 43–128 ký tự. */
export const pkceVerifier = z.string().min(43).max(128).regex(base64url);
export const connectState = z.string().min(16).max(128).regex(base64url);
/** Cổng tạm app mở trên 127.0.0.1; dưới 1024 là cổng hệ thống, app không mở được. */
export const loopbackPort = z.coerce.number().int().min(1024).max(65_535);

export const DESKTOP_CONNECT_PREFIX = "hdc_";
export const desktopConnectCode = z.string().startsWith(DESKTOP_CONNECT_PREFIX).max(200);

export const desktopConnectOptions = z.object({
  /** Đội mà người dùng được đăng ký máy (quản trị đội hoặc vai trò có machines.register). */
  teams: z.array(z.object({ id, name: z.string() })),
});
export type DesktopConnectOptions = z.output<typeof desktopConnectOptions>;

export const desktopConnectApproveInput = z.object({
  teamId: id,
  machine: machineId,
  port: loopbackPort,
  state: connectState,
  challenge: pkceChallenge,
});
export type DesktopConnectApproveInput = z.input<typeof desktopConnectApproveInput>;

export const desktopConnectExchangeInput = z.object({ code: desktopConnectCode, verifier: pkceVerifier });

export const desktopConnectExchangeOutput = z.object({
  hubUrl: z.string(),
  machine: machineId,
  teamId: id,
  /** Mã đăng ký máy (`hwr_…`) dùng một lần, app đưa cho `hive-worker register`. */
  registrationToken: z.string(),
  /** Token MCP cá nhân (`hive_pat_…`) app lưu vào keychain để gọi hub thay người dùng. */
  personalToken: z.string(),
  personalTokenExpiresAt: z.iso.datetime(),
});
export type DesktopConnectExchangeOutput = z.output<typeof desktopConnectExchangeOutput>;

export const desktopConnectContract = {
  options: orgRoute("GET", "/v1/desktop/connect/options", "Đội người dùng được đăng ký máy desktop", "desktop").output(
    desktopConnectOptions,
  ),
  approve: orgRoute(
    "POST",
    "/v1/desktop/connect/approve",
    "Cho phép app desktop trên máy này: tạo mã đổi dùng một lần",
    "desktop",
  )
    .input(desktopConnectApproveInput)
    .output(z.object({ redirectUrl: z.string(), expiresAt: z.iso.datetime() })),
  exchange: oc
    .route({
      method: "POST",
      path: "/v1/desktop/connect/exchange",
      summary: "App desktop đổi mã (kèm PKCE verifier) lấy mã đăng ký máy và token cá nhân",
      tags: ["desktop"],
    })
    .errors({
      BAD_REQUEST: { message: "Dữ liệu gửi lên không hợp lệ." },
      UNAUTHORIZED: { message: "Mã đăng nhập không hợp lệ, đã hết hạn hoặc đã dùng. Bấm đăng nhập lại trong app." },
      FORBIDDEN: { message: "Bạn không còn quyền đăng ký máy cho đội này." },
    })
    .input(desktopConnectExchangeInput)
    .output(desktopConnectExchangeOutput),
};
