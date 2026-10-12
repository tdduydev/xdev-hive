import { implement, ORPCError } from "@orpc/server";
import { desktopConnectContract, fleetContract } from "@xdev-hive/contracts";
import type pg from "pg";
import type { Auth } from "../identity/index.ts";
import { ForbiddenError, type RequestContext, type Tx, withTenant } from "../platform/index.ts";
import { disconnectMachine, sendToMachine } from "./connections.ts";
import {
  approveDesktopConnect,
  desktopConnectOptions,
  exchangeDesktopConnect,
  type IssuePersonalToken,
} from "./desktop-connect.ts";
import { FleetError } from "./errors.ts";
import { CLOSE } from "./gateway.ts";
import { listMachines, pauseMachine, requestMachineUpdate, resumeMachine, revokeMachine } from "./machines.ts";
import { createRegistration, registerMachine } from "./registration.ts";
import { installCommands, type WorkerReleaseCache } from "./releases.ts";

export interface FleetDeps {
  auth?: Auth | undefined;
  /** Pool của role hive_app. Không có khi chạy test đơn vị không cần database. */
  pool?: pg.Pool | undefined;
  /** Địa chỉ hub mà máy dev gọi tới; đưa vào lệnh cài. */
  publicUrl: string;
  /** Bản worker mới nhất để web chỉ ra máy chạy bản cũ; không có thì luôn trả null. */
  workerReleases?: WorkerReleaseCache | undefined;
  /** Token cá nhân cho app desktop đăng nhập bằng trình duyệt; không có thì app phải dán token tay. */
  issuePersonalToken?: IssuePersonalToken | undefined;
}

/** Cùng header chọn tổ chức với API tổ chức, đội (M1c). */
export const ORG_HEADER = "x-hive-org";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Đổi lỗi nghiệp vụ thành lỗi oRPC đã khai báo trong hợp đồng, để client nhận lỗi có kiểu và `data.code`. */
function toORPC(error: unknown): never {
  if (error instanceof ForbiddenError)
    throw new ORPCError("FORBIDDEN", { message: error.message, data: { code: error.code } });
  if (error instanceof FleetError) {
    const code = { unauthorized: "UNAUTHORIZED", not_found: "NOT_FOUND", conflict: "CONFLICT" }[error.kind];
    throw new ORPCError(code, { message: error.message, data: { code: error.code } });
  }
  throw error;
}

export function fleetRouter(deps: FleetDeps) {
  const requirePool = () => {
    if (!deps.pool) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Hub chưa cấu hình HIVE_DATABASE_URL." });
    return deps.pool;
  };

  /** Chạy fn trong transaction của tổ chức đang chọn, với người đang đăng nhập. Quyền đội do fn tự kiểm. */
  const inOrg = async <T>(headers: Headers, fn: (tx: Tx, userId: string) => Promise<T>): Promise<T> => {
    const session = deps.auth ? await deps.auth.api.getSession({ headers }) : null;
    if (!session) throw new ORPCError("UNAUTHORIZED", { message: "Chưa đăng nhập." });
    const pool = requirePool();
    const orgId = headers.get(ORG_HEADER);
    if (!orgId) throw new ORPCError("BAD_REQUEST", { message: `Chưa chọn tổ chức (header ${ORG_HEADER}).` });
    if (!UUID.test(orgId)) throw new ORPCError("BAD_REQUEST", { message: "Mã tổ chức không hợp lệ." });
    const userId = session.user.id;
    return withTenant(pool, { userId, orgId }, (tx) => fn(tx, userId)).catch(toORPC);
  };

  const machinesOs = implement(fleetContract.machines).$context<RequestContext>();
  const workerOs = implement(fleetContract.worker).$context<RequestContext>();
  const desktopOs = implement(desktopConnectContract).$context<RequestContext>();
  const hubUrl = deps.publicUrl.replace(/\/+$/, "");

  return {
    machines: {
      list: machinesOs.list.handler(({ context, input }) =>
        inOrg(context.headers, (tx, userId) => listMachines(tx, userId, input.teamId)),
      ),
      createRegistration: machinesOs.createRegistration.handler(async ({ context, input }) => {
        const { token, expiresAt } = await inOrg(context.headers, (tx, userId) =>
          createRegistration(tx, userId, input.teamId, input.kind),
        );
        return {
          token,
          expiresAt: expiresAt.toISOString(),
          command: `hive-worker register --hub ${hubUrl} --token ${token}`,
          ...installCommands(hubUrl, token, input.kind),
        };
      }),
      revoke: machinesOs.revoke.handler(async ({ context, input }) => {
        const machine = await inOrg(context.headers, (tx, userId) => revokeMachine(tx, userId, input.machineId));
        // Sau khi commit mới đóng: nếu transaction hỏng thì máy vẫn chạy bình thường.
        disconnectMachine(machine.id, CLOSE.revoked, "Máy đã bị thu hồi");
        return machine;
      }),
      pause: machinesOs.pause.handler(({ context, input }) =>
        inOrg(context.headers, (tx, userId) => pauseMachine(tx, userId, input.machineId)),
      ),
      resume: machinesOs.resume.handler(({ context, input }) =>
        inOrg(context.headers, (tx, userId) => resumeMachine(tx, userId, input.machineId)),
      ),
      update: machinesOs.update.handler(async ({ context, input }) => {
        const machine = await inOrg(context.headers, (tx, userId) =>
          requestMachineUpdate(tx, userId, input.machineId, input.version),
        );
        const sent = sendToMachine(machine.id, {
          type: "update",
          ...(input.version ? { version: input.version } : {}),
        });
        if (!sent)
          throw new ORPCError("CONFLICT", {
            message: "Máy vừa ngắt kết nối khỏi hub; thử lại khi máy nối lại.",
            data: { code: "MACHINE_NOT_CONNECTED" },
          });
        return machine;
      }),
      workerRelease: machinesOs.workerRelease.handler(async ({ context }) => {
        const session = deps.auth ? await deps.auth.api.getSession({ headers: context.headers }) : null;
        if (!session) throw new ORPCError("UNAUTHORIZED", { message: "Chưa đăng nhập." });
        return (await deps.workerReleases?.get()) ?? null;
      }),
    },
    worker: {
      register: workerOs.register.handler(({ input }) => registerMachine(requirePool(), input).catch(toORPC)),
    },
    desktopConnect: {
      options: desktopOs.options.handler(({ context }) =>
        inOrg(context.headers, (tx, userId) => desktopConnectOptions(tx, userId)),
      ),
      approve: desktopOs.approve.handler(({ context, input }) =>
        inOrg(context.headers, (tx, userId) => approveDesktopConnect(tx, userId, input)),
      ),
      exchange: desktopOs.exchange.handler(({ input }) => {
        const issuePersonalToken = deps.issuePersonalToken;
        if (!issuePersonalToken)
          throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Hub chưa bật token MCP cá nhân." });
        return exchangeDesktopConnect(requirePool(), input, { publicUrl: hubUrl, issuePersonalToken }).catch(toORPC);
      }),
    },
  };
}
