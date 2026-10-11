import { implement, ORPCError } from "@orpc/server";
import { fleetContract } from "@xdev-hive/contracts";
import type pg from "pg";
import type { Auth } from "../identity/index.ts";
import { ForbiddenError, type RequestContext, type Tx, withTenant } from "../platform/index.ts";
import { disconnectMachine } from "./connections.ts";
import { FleetError } from "./errors.ts";
import { CLOSE } from "./gateway.ts";
import { listMachines, pauseMachine, resumeMachine, revokeMachine } from "./machines.ts";
import { createRegistration, registerMachine } from "./registration.ts";

export interface FleetDeps {
  auth?: Auth | undefined;
  /** Pool của role hive_app. Không có khi chạy test đơn vị không cần database. */
  pool?: pg.Pool | undefined;
  /** Địa chỉ hub mà máy dev gọi tới; đưa vào lệnh cài. */
  publicUrl: string;
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
    },
    worker: {
      register: workerOs.register.handler(({ input }) => registerMachine(requirePool(), input).catch(toORPC)),
    },
  };
}
