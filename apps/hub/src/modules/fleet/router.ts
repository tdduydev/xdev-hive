import { implement, ORPCError } from "@orpc/server";
import { desktopConnectContract, fleetContract } from "@xdev-hive/contracts";
import type pg from "pg";
import type { Auth } from "../identity/index.ts";
import {
  clientIp,
  ForbiddenError,
  parseTrustedProxies,
  type RequestContext,
  type TrustedProxies,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import {
  cancelAccountLogin,
  getAccountLogin,
  inputAccountLogin,
  listMachineAccounts,
  setMachineAccount,
  startAccountLogin,
} from "./accounts.ts";
import { disconnectMachine, isConnected, sendToMachine } from "./connections.ts";
import {
  approveDesktopConnect,
  desktopConnectOptions,
  exchangeDesktopConnect,
  type IssuePersonalToken,
} from "./desktop-connect.ts";
import { FleetError } from "./errors.ts";
import { CLOSE } from "./gateway.ts";
import type { MachineAuth } from "./machine-auth.ts";
import {
  authenticateMachine,
  findMachine,
  listMachines,
  pauseMachine,
  requestMachineUpdate,
  resumeMachine,
  revokeMachine,
  setMachineLabels,
  setMachineShared,
} from "./machines.ts";
import { deleteMyProjectUsage } from "./project-usage.ts";
import { createRegistration, registerMachine } from "./registration.ts";
import { installCommands, type WorkerReleaseCache } from "./releases.ts";
import { listSdlcFleet } from "./sdlc-fleet.ts";
import { getMachineTokenScore, receiveMachineEvent } from "./token-scores.ts";

/** Mã đóng để worker nối lại ngay (1012: dịch vụ khởi động lại), không phải lỗi. */
const CLOSE_RECONNECT = 1012;

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
  /** Access token máy (ADR 0033). Không có (thiếu HIVE_AUTH_SECRET) thì máy chỉ dùng được machine token. */
  machineAuth?: MachineAuth | undefined;
  /** Proxy được tin `X-Forwarded-For`; mặc định đọc `HIVE_TRUSTED_PROXIES`. */
  trustedProxies?: TrustedProxies | undefined;
}

const bearer = (headers: Headers) => /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "")?.[1];

/** Cùng header chọn tổ chức với API tổ chức, đội (M1c). */
export const ORG_HEADER = "x-hive-org";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Đổi lỗi nghiệp vụ thành lỗi oRPC đã khai báo trong hợp đồng, để client nhận lỗi có kiểu và `data.code`. */
function toORPC(error: unknown): never {
  if (error instanceof ForbiddenError)
    throw new ORPCError("FORBIDDEN", { message: error.message, data: { code: error.code } });
  if (error instanceof FleetError) {
    // Hai lỗi có mã riêng trong hợp đồng worker (ADR 0033) để worker phân biệt mà không đọc message.
    if (error.code === "MACHINE_AUTH_FAILED" || error.code === "MACHINE_KEY_EXISTS")
      throw new ORPCError(error.code, { message: error.message });
    const code = {
      bad_request: "BAD_REQUEST",
      unauthorized: "UNAUTHORIZED",
      not_found: "NOT_FOUND",
      conflict: "CONFLICT",
      rate_limited: "TOO_MANY_REQUESTS",
    }[error.kind];
    throw new ORPCError(code, { message: error.message, data: { code: error.code } });
  }
  throw error;
}

export function fleetRouter(deps: FleetDeps) {
  // Giới hạn xin token đếm theo IP: header người gọi tự đặt thì giả được IP của máy khác để chặn máy đó.
  const trusted = deps.trustedProxies ?? parseTrustedProxies(process.env.HIVE_TRUSTED_PROXIES);
  const callerIp = (context: RequestContext) =>
    clientIp(context.remoteAddress, context.headers.get("x-forwarded-for") ?? undefined, trusted);
  const requirePool = () => {
    if (!deps.pool) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Hub chưa cấu hình HIVE_DATABASE_URL." });
    return deps.pool;
  };

  /** Người đang đăng nhập và tổ chức đang chọn. */
  const orgContext = async (headers: Headers) => {
    const session = deps.auth ? await deps.auth.api.getSession({ headers }) : null;
    if (!session) throw new ORPCError("UNAUTHORIZED", { message: "Chưa đăng nhập." });
    const pool = requirePool();
    const orgId = headers.get(ORG_HEADER);
    if (!orgId) throw new ORPCError("BAD_REQUEST", { message: `Chưa chọn tổ chức (header ${ORG_HEADER}).` });
    if (!UUID.test(orgId)) throw new ORPCError("BAD_REQUEST", { message: "Mã tổ chức không hợp lệ." });
    return { pool, userId: session.user.id, orgId };
  };

  /** Chạy fn trong transaction của tổ chức đang chọn, với người đang đăng nhập. Quyền đội do fn tự kiểm. */
  const inOrg = async <T>(headers: Headers, fn: (tx: Tx, userId: string) => Promise<T>): Promise<T> => {
    const { pool, userId, orgId } = await orgContext(headers);
    return withTenant(pool, { userId, orgId }, (tx) => fn(tx, userId)).catch(toORPC);
  };

  /** Như inOrg, rồi chạy `after` sau khi commit (gửi lệnh xuống máy), đổi lỗi nghiệp vụ của nó như nhau. */
  const thenSend = async <T, R>(
    headers: Headers,
    fn: (tx: Tx, userId: string) => Promise<T>,
    after: (value: T) => R,
  ): Promise<R> => {
    const value = await inOrg(headers, fn);
    try {
      return after(value);
    } catch (error) {
      return toORPC(error);
    }
  };

  const requireMachineAuth = () => {
    if (!deps.machineAuth)
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Hub chưa cấu hình HIVE_AUTH_SECRET cho token máy." });
    return deps.machineAuth;
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
          createRegistration(tx, userId, input.teamId, input.kind, {
            labels: input.labels,
            shared: input.shared,
            labelsOnly: input.labelsOnly,
          }),
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
      setShared: machinesOs.setShared.handler(async ({ context, input }) => {
        const { machine, changed } = await inOrg(context.headers, async (tx, userId) => {
          const before = await findMachine(tx, input.machineId);
          const machine = await setMachineShared(tx, userId, input.machineId, input.shared);
          return { machine, changed: before?.shared !== input.shared };
        });
        // Worker chỉ biết máy dùng chung qua welcome; cho nối lại để nhận cờ mới. Run đang chạy vẫn tiếp tục.
        if (changed && machine.capabilities?.includes("accounts-remote") && isConnected(machine.id))
          disconnectMachine(machine.id, CLOSE_RECONNECT, "Máy đổi chế độ dùng chung");
        return machine;
      }),
      setLabels: machinesOs.setLabels.handler(({ context, input }) =>
        inOrg(context.headers, (tx, userId) => setMachineLabels(tx, userId, input.machineId, input)),
      ),
      setAccount: machinesOs.setAccount.handler(({ context, input }) =>
        thenSend(
          context.headers,
          (tx, userId) => setMachineAccount(tx, userId, input),
          (machine) => {
            if (!sendToMachine(machine.id, { type: "account_set", accountId: input.accountId, enabled: input.enabled }))
              throw new FleetError("conflict", "MACHINE_NOT_CONNECTED", "Máy vừa ngắt kết nối khỏi hub; thử lại sau.");
            return machine;
          },
        ),
      ),
      accounts: {
        list: machinesOs.accounts.list.handler(({ context, input }) =>
          inOrg(context.headers, (tx, userId) => listMachineAccounts(tx, userId, input.machineId)),
        ),
        loginStart: machinesOs.accounts.loginStart.handler(async ({ context, input }) => {
          const { pool, userId, orgId } = await orgContext(context.headers);
          return startAccountLogin(pool, { userId, orgId }, input).catch(toORPC);
        }),
        loginGet: machinesOs.accounts.loginGet.handler(({ context, input }) =>
          inOrg(context.headers, (tx, userId) => getAccountLogin(tx, userId, input)),
        ),
        loginInput: machinesOs.accounts.loginInput.handler(({ context, input }) =>
          thenSend(
            context.headers,
            (tx, userId) => inputAccountLogin(tx, userId, input),
            ({ send }) => send(input.text),
          ),
        ),
        loginCancel: machinesOs.accounts.loginCancel.handler(({ context, input }) =>
          thenSend(
            context.headers,
            (tx, userId) => cancelAccountLogin(tx, userId, input),
            ({ commit }) => commit(),
          ),
        ),
      },
      sdlc: machinesOs.sdlc.handler(({ context, input }) =>
        inOrg(context.headers, (tx, userId) => listSdlcFleet(tx, userId, input.teamId)),
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
      tokenScore: machinesOs.tokenScore.handler(({ context, input }) =>
        inOrg(context.headers, (tx, userId) => getMachineTokenScore(tx, userId, input.machineId)),
      ),
      deleteMyProjectUsage: machinesOs.deleteMyProjectUsage.handler(({ context, input }) =>
        inOrg(context.headers, (tx, userId) => deleteMyProjectUsage(tx, userId, input.id)),
      ),
      workerRelease: machinesOs.workerRelease.handler(async ({ context }) => {
        const session = deps.auth ? await deps.auth.api.getSession({ headers: context.headers }) : null;
        if (!session) throw new ORPCError("UNAUTHORIZED", { message: "Chưa đăng nhập." });
        return (await deps.workerReleases?.get()) ?? null;
      }),
    },
    worker: {
      register: workerOs.register.handler(({ input }) => registerMachine(requirePool(), input).catch(toORPC)),
      registerKey: workerOs.registerKey.handler(({ context, input }) =>
        requireMachineAuth().registerKey(bearer(context.headers), input).catch(toORPC),
      ),
      challenge: workerOs.challenge.handler(({ context, input }) => {
        try {
          return requireMachineAuth().challenge(input.machine, callerIp(context));
        } catch (error) {
          return toORPC(error);
        }
      }),
      token: workerOs.token.handler(({ context, input }) =>
        requireMachineAuth().exchange(input, callerIp(context)).catch(toORPC),
      ),
      // Sự kiện máy (ADR 0036): danh tính là máy của token, không lấy từ body. Nhận access token máy (ADR 0033), và
      // machine token khi máy chưa có khoá.
      clientEvent: workerOs.clientEvent.handler(async ({ context, input }) => {
        const pool = requirePool();
        const token = bearer(context.headers);
        const machine = !token
          ? null
          : deps.machineAuth
            ? ((await deps.machineAuth.authenticate(token))?.machine ?? null)
            : await authenticateMachine(pool, token);
        if (!machine)
          throw new ORPCError("UNAUTHORIZED", { message: "Machine token không hợp lệ hoặc máy đã bị thu hồi." });
        return receiveMachineEvent(pool, machine, input);
      }),
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
