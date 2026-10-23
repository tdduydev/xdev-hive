import { type Deploy, type DeployEnvironment, type DeployTarget, deploy, deployTarget } from "@xdev-hive/contracts";
// Fixture tự chứa vì fake-hub nạp các fixture này; import ngược sẽ tạo vòng phụ thuộc.
export type DeliveryDeploysHandler = (input: unknown) => { status: number; json: unknown };
const ok = (value: unknown) => ({ status: 200, json: { json: value } });
const fail = (code: string, status: number, message: string, data?: unknown) => ({
  status,
  json: { json: { defined: true, code, status, message, ...(data === undefined ? {} : { data }) } },
});

/** Một khung SSE: `event`, `id` tuỳ chọn và `data` được tuần tự hoá thành JSON, như luồng log của lượt chạy. */
export interface DeployStreamFrame {
  event: string;
  id?: string;
  data: unknown;
}

export const SYSTEM_ID = "7b7b7b7b-0000-4000-8000-000000000001";
const TEAM_ID = "5a5a5a5a-0000-4000-8000-000000000001";
export const ENV_DEV = "8c8c8c8c-0000-4000-8000-000000000001";
export const ENV_PROD = "8c8c8c8c-0000-4000-8000-000000000002";
export const PROJECT_PAY = "9d9d9d9d-0000-4000-8000-000000000001";
export const PROJECT_RPT = "9d9d9d9d-0000-4000-8000-000000000002";
export const TARGET_PAY_DEV = "ae0e0e0e-0000-4000-8000-000000000001";
export const TARGET_PAY_PROD = "ae0e0e0e-0000-4000-8000-000000000002";
export const TARGET_RPT_DEV = "ae0e0e0e-0000-4000-8000-000000000003";
/** Lần thành công đang chạy ở pay/dev. */
export const DEPLOY_PAY_DEV_OK = "bf1f1f1f-0000-4000-8000-000000000001";
/** Lần đang chạy ở pay/prod, có log trực tiếp. */
export const DEPLOY_PAY_PROD_RUNNING = "bf1f1f1f-0000-4000-8000-000000000002";
/** Lần "ngoài Hive" ở rpt/dev, do Jenkins ghi lại. */
export const DEPLOY_RPT_EXTERNAL = "bf1f1f1f-0000-4000-8000-000000000003";
/** Lần lỗi cũ ở pay/dev, chỉ có trong lịch sử. */
export const DEPLOY_PAY_DEV_FAILED = "bf1f1f1f-0000-4000-8000-000000000004";
/** Lần vừa tạo từ dialog. */
export const DEPLOY_CREATED = "bf1f1f1f-0000-4000-8000-000000000005";

const MINUTE = 60_000;
const BASE = Date.parse("2026-10-20T03:00:00.000Z");
const at = (minutesAgo: number) => new Date(BASE - minutesAgo * MINUTE).toISOString();
const duy = { userId: "u1", name: "Trần Đức Duy" };
const SHA_OK = "3f9c2ab71d5e4c08a6b2f1e0d9c8b7a6f5e4d3c2";
const SHA_FAILED = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const SHA_EXT = "c0ffee1234567890abcdef1234567890abcdef12";

const version = (patch: Partial<Deploy["version"]>): Deploy["version"] => ({
  commit: null,
  tag: null,
  jenkinsBuild: null,
  image: null,
  images: [],
  revision: null,
  ...patch,
});
const step = (
  key: string,
  state: Deploy["steps"][number]["state"],
  from: number,
  to: number | null,
  exit?: number,
) => ({
  key,
  state,
  startedAt: state === "pending" ? null : at(from),
  finishedAt: to === null ? null : at(to),
  exitCode: exit ?? null,
  message: null,
});

function makeDeploy(
  id: string,
  base: Pick<Deploy, "targetId" | "projectId" | "environmentId" | "state"> & Partial<Deploy>,
): Deploy {
  return deploy.parse({
    id,
    systemId: SYSTEM_ID,
    method: "ssh-script",
    origin: "hive",
    version: version({}),
    requestedBy: duy,
    triggeredBy: null,
    steps: [],
    configVersion: 1,
    rollbackOf: null,
    skipBackup: null,
    external: null,
    health: null,
    approval: null,
    runner: null,
    createdAt: at(30),
    startedAt: at(29),
    finishedAt: null,
    ...base,
  });
}

const sshTarget = (id: string, environmentId: string, backup: boolean): DeployTarget =>
  deployTarget.parse({
    id,
    projectId: PROJECT_PAY,
    environmentId,
    method: "ssh-script",
    config: {
      method: "ssh-script",
      schemaVersion: 1,
      serverId: "d1d1d1d1-0000-4000-8000-000000000001",
      workdir: "/srv/pay",
      composeProject: "pay",
      branch: "main",
      steps: {
        precheck: { script: "true", timeoutSec: 60 },
        backup: backup ? { script: "true", timeoutSec: 60 } : null,
        upload: { mode: "git-archive" },
        deploy: { script: "true", timeoutSec: 60 },
      },
      health: null,
      variables: [],
    },
    configVersion: 1,
    updatedBy: null,
    createdAt: at(1000),
    updatedAt: at(1000),
  });

const jenkinsTarget = (): DeployTarget =>
  deployTarget.parse({
    id: TARGET_RPT_DEV,
    projectId: PROJECT_RPT,
    environmentId: ENV_DEV,
    method: "jenkins-job",
    config: {
      method: "jenkins-job",
      schemaVersion: 1,
      connectionId: "30303030-0000-4000-8000-000000000001",
      jobPath: "rpt/deploy",
      branch: null,
      params: [],
      promote: null,
      rollbackJob: null,
      health: null,
    },
    configVersion: 1,
    updatedBy: null,
    createdAt: at(1000),
    updatedAt: at(1000),
  });

const env = (id: string, name: string, position: number, locked: boolean): DeployEnvironment => ({
  id,
  systemId: SYSTEM_ID,
  name,
  position,
  policy: { deployRoles: [], approveRoles: [], approvals: 0, approvalTtlHours: 24 },
  lock: locked ? { by: duy, at: at(120), reason: "Đóng băng phát hành tuần lễ" } : null,
  runner: { mode: "legacy", machines: [], requireLabel: false },
  createdAt: at(2000),
  updatedAt: at(2000),
});

/** Luồng SSE giả của `/api/v1/deploys/:id/stream`. fake-hub trả đúng các khung này rồi đóng luồng; id lạ nhận luồng rỗng. */
export const deliveryDeployStreams: Record<string, DeployStreamFrame[]> = {
  [DEPLOY_PAY_PROD_RUNNING]: [
    {
      event: "log",
      id: "1",
      data: { id: 1, seq: 1, bytes: btoa("== precheck ==\n"), createdAt: at(5) },
    },
    {
      event: "log",
      id: "2",
      data: { id: 2, seq: 2, bytes: btoa("docker compose pull\n"), createdAt: at(4) },
    },
  ],
  [DEPLOY_PAY_DEV_OK]: [
    {
      event: "log",
      id: "1",
      data: { id: 1, seq: 1, bytes: btoa("deploy xong\n"), createdAt: at(60) },
    },
    { event: "end", data: { state: "succeeded" } },
  ],
};

export interface DeliveryDeploysOptions {
  /** Mã lỗi `deploys/create` trả về thay cho thành công; `data` đi theo `deliveryErrorData`. */
  createFailure?: { code: string; status: number; message: string; data?: unknown };
  /** Môi trường prod bị khoá hay không. */
  prodLocked?: boolean;
  /** Không có lần triển khai nào: bảng trống và lịch sử rỗng. */
  empty?: boolean;
}

/**
 * Hub giả cho bảng triển khai, dialog Triển khai và trang một lần triển khai. `state.calls` để test đọc lại thứ đã gửi.
 * Hệ thống có hai môi trường (dev, prod) và hai dự án: Cổng thanh toán (ssh-script, cả hai môi trường), Báo cáo (Jenkins ở
 * dev, chưa có đích ở prod).
 */
export function deliveryDeploysFixture(options: DeliveryDeploysOptions = {}) {
  const payDev = makeDeploy(DEPLOY_PAY_DEV_OK, {
    targetId: TARGET_PAY_DEV,
    projectId: PROJECT_PAY,
    environmentId: ENV_DEV,
    state: "succeeded",
    version: version({ commit: SHA_OK, tag: "v1.4.2" }),
    steps: [
      step("precheck", "succeeded", 60, 59, 0),
      step("backup", "succeeded", 59, 58, 0),
      step("deploy", "succeeded", 58, 56, 0),
      step("health", "succeeded", 56, 55),
    ],
    health: { ok: true, at: at(55), status: 200, message: "HTTP 200" },
    createdAt: at(61),
    startedAt: at(60),
    finishedAt: at(55),
  });
  const payProdRunning = makeDeploy(DEPLOY_PAY_PROD_RUNNING, {
    targetId: TARGET_PAY_PROD,
    projectId: PROJECT_PAY,
    environmentId: ENV_PROD,
    state: "running",
    version: version({ commit: SHA_OK }),
    steps: [
      step("precheck", "succeeded", 5, 4, 0),
      step("backup", "running", 4, null),
      step("deploy", "pending", 0, null),
    ],
    createdAt: at(6),
    startedAt: at(5),
  });
  const rptExternal = makeDeploy(DEPLOY_RPT_EXTERNAL, {
    targetId: TARGET_RPT_DEV,
    projectId: PROJECT_RPT,
    environmentId: ENV_DEV,
    method: "jenkins-job",
    origin: "external",
    state: "succeeded",
    requestedBy: null,
    triggeredBy: "lan.tran",
    version: version({ commit: SHA_EXT, jenkinsBuild: 482, image: "registry.example.com/rpt:482" }),
    external: { label: "rpt/deploy #482", url: "https://jenkins.example.com/job/rpt/deploy/482/" },
    createdAt: at(300),
    startedAt: at(299),
    finishedAt: at(295),
  });
  const payDevFailed = makeDeploy(DEPLOY_PAY_DEV_FAILED, {
    targetId: TARGET_PAY_DEV,
    projectId: PROJECT_PAY,
    environmentId: ENV_DEV,
    state: "failed",
    version: version({ commit: SHA_FAILED }),
    steps: [step("precheck", "succeeded", 600, 599, 0), step("deploy", "failed", 599, 597, 1)],
    createdAt: at(601),
    startedAt: at(600),
    finishedAt: at(597),
  });

  const state = {
    deploys: new Map<string, Deploy>(
      options.empty ? [] : [payDev, payProdRunning, rptExternal, payDevFailed].map((d) => [d.id, d]),
    ),
    calls: [] as { path: string; input: unknown }[],
  };
  const record = (path: string, input: unknown) => state.calls.push({ path, input });
  const environments = [env(ENV_DEV, "dev", 0, false), env(ENV_PROD, "prod", 1, options.prodLocked ?? false)];
  const targets = [
    sshTarget(TARGET_PAY_DEV, ENV_DEV, true),
    sshTarget(TARGET_PAY_PROD, ENV_PROD, true),
    jenkinsTarget(),
  ];
  const targetFor = (projectId: string, environmentId: string) =>
    targets.find((t) => t.projectId === projectId && t.environmentId === environmentId);
  const cell = (projectId: string, environmentId: string) => {
    const target = targetFor(projectId, environmentId);
    const mine = [...state.deploys.values()].filter((d) => d.targetId === target?.id);
    return {
      environmentId,
      targetId: target?.id ?? null,
      method: target?.method ?? null,
      current: mine.find((d) => d.state === "succeeded") ?? null,
      active: mine.find((d) => d.state === "running" || d.state === "queued") ?? null,
    };
  };
  const sorted = () => [...state.deploys.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const rpc: Record<string, DeliveryDeploysHandler> = {
    "systems/list": () =>
      ok([
        {
          id: SYSTEM_ID,
          teamId: TEAM_ID,
          slug: "pay",
          name: "Hệ thống thanh toán",
          description: null,
          createdAt: at(3000),
        },
      ]),
    "deploys/board": () =>
      ok({
        environments,
        rows: [
          { projectId: PROJECT_PAY, projectName: "Cổng thanh toán" },
          { projectId: PROJECT_RPT, projectName: "Báo cáo" },
        ].map((p) => ({ ...p, cells: environments.map((e) => cell(p.projectId, e.id)) })),
      }),
    "deploys/list": (input) => {
      record("deploys/list", input);
      const f = (input ?? {}) as { projectId?: string; environmentId?: string; state?: string; origin?: string };
      const items = sorted().filter(
        (d) =>
          (!f.projectId || d.projectId === f.projectId) &&
          (!f.environmentId || d.environmentId === f.environmentId) &&
          (!f.state || d.state === f.state) &&
          (!f.origin || d.origin === f.origin),
      );
      return ok({ items, nextCursor: null });
    },
    "deploys/get": (input) => {
      const found = state.deploys.get((input as { id: string }).id);
      return found ? ok(found) : fail("NOT_FOUND", 404, "Không tìm thấy lần triển khai.");
    },
    "deployTargets/get": (input) => {
      const found = targets.find((t) => t.id === (input as { id: string }).id);
      return found ? ok(found) : fail("NOT_FOUND", 404, "Không tìm thấy đích triển khai.");
    },
    "deploys/create": (input) => {
      record("deploys/create", input);
      if (options.createFailure) {
        const { code, status, message, data } = options.createFailure;
        return fail(code, status, message, data);
      }
      const body = input as { targetId: string; skipBackup?: { reason: string } };
      const target = targets.find((t) => t.id === body.targetId);
      const created = makeDeploy(DEPLOY_CREATED, {
        targetId: body.targetId,
        projectId: target?.projectId ?? PROJECT_PAY,
        environmentId: target?.environmentId ?? ENV_DEV,
        state: "queued",
        skipBackup: body.skipBackup ?? null,
        version: version({ commit: SHA_OK }),
        createdAt: at(0),
        startedAt: null,
      });
      state.deploys.set(created.id, created);
      return ok(created);
    },
    "deploys/cancel": (input) => {
      record("deploys/cancel", input);
      const found = state.deploys.get((input as { id: string }).id);
      if (!found) return fail("NOT_FOUND", 404, "Không tìm thấy lần triển khai.");
      const canceled: Deploy = {
        ...found,
        state: "canceled",
        finishedAt: at(0),
        steps: found.steps.map((s) =>
          s.state === "running" || s.state === "pending" ? { ...s, state: "canceled" } : s,
        ),
      };
      state.deploys.set(canceled.id, canceled);
      return ok(canceled);
    },
  };
  return { rpc, state };
}

/**
 * Thủ tục mặc định mà fake-hub nạp cho mọi spec. Chỉ các thủ tục `deploys/*` và `deployTargets/get`, không lấn `systems/list`
 * vì nhiều spec khác đã tự khai báo danh sách hệ thống riêng.
 */
export function deliveryDeploysDefaults(): Record<string, DeliveryDeploysHandler> {
  const { rpc } = deliveryDeploysFixture();
  return Object.fromEntries(
    Object.entries(rpc).filter(([path]) => path.startsWith("deploys/") || path === "deployTargets/get"),
  );
}
