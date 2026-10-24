import {
  DELIVERY_METHODS,
  type DeliveryCapability,
  type DeliveryMethod,
  type DeployEnvironment,
  type EnvironmentRunner,
  type RunnerCandidate as RunnerCandidateView,
} from "@xdev-hive/contracts";
import { eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { listOnlineMachines, machineNames } from "../fleet/index.ts";
import { BadRequestError, type Tx } from "../platform/index.ts";
import { environmentNotFound, environmentViews, loadEnvironment, requireTeamPermission } from "./environments.ts";
import { DEPLOY_RUNNER_LABEL, type RunnerCandidate } from "./runner-select.ts";
import { deliveryRunners, deployEnvironments } from "./schema.ts";

// Máy chạy deploy của môi trường (specs/032 FR-010..FR-014): cấu hình máy, nhãn bắt buộc và khả năng máy báo lên.
// Danh sách máy và trạng thái trực tuyến lấy từ fleet; khả năng delivery (cách chạy, tên credential) giữ ở bảng riêng.

type EnvRow = NonNullable<Awaited<ReturnType<typeof loadEnvironment>>>;
type RunnerRow = typeof deliveryRunners.$inferSelect;

const KNOWN_METHODS: ReadonlySet<string> = new Set(DELIVERY_METHODS);

/**
 * Lưu khả năng một đăng ký vừa báo ở hello hoặc heartbeat (FR-010). Gọi trong withTenant của tổ chức của đăng ký đó, nên
 * máy đăng ký với hai tổ chức có hai dòng riêng và tổ chức này không thấy credential của tổ chức kia (FR-105).
 */
export async function recordDeliveryCapability(
  tx: Tx,
  machineId: string,
  capability: DeliveryCapability,
  now: Date,
): Promise<void> {
  const methods = capability.methods.filter((m) => KNOWN_METHODS.has(m));
  await tx
    .insert(deliveryRunners)
    .values({
      orgId: sql`hive.ctx_org()`,
      machineId,
      methods,
      credentials: capability.credentials,
      reportedAt: now,
    })
    .onConflictDoUpdate({
      target: [deliveryRunners.orgId, deliveryRunners.machineId],
      set: { methods, credentials: capability.credentials, reportedAt: now },
    });
}

async function reportsOf(tx: Tx, machineIds: string[]): Promise<Map<string, RunnerRow>> {
  if (machineIds.length === 0) return new Map();
  const rows = await tx.select().from(deliveryRunners).where(inArray(deliveryRunners.machineId, machineIds));
  return new Map(rows.map((r) => [r.machineId, r]));
}

/** Ứng viên cho runner-select: máy trực tuyến của đội sở hữu môi trường, kèm khả năng đã báo. */
export async function runnerCandidatesOf(tx: Tx, env: EnvRow): Promise<RunnerCandidate[]> {
  const online = await listOnlineMachines(tx, env.teamId);
  const reports = await reportsOf(
    tx,
    online.map((m) => m.id),
  );
  return online.map((m) => {
    const r = reports.get(m.id);
    return {
      machineId: m.id,
      orgId: env.orgId,
      online: true,
      labels: m.labels,
      methods: (r?.methods ?? []).filter((x): x is DeliveryMethod => KNOWN_METHODS.has(x)),
      credentials: r?.credentials ?? [],
    };
  });
}

/** Cho màn cấu hình: máy trực tuyến của đội và máy đã chọn (máy đang tắt vẫn hiện để admin thấy và bỏ được). */
export async function listRunnerCandidates(
  tx: Tx,
  userId: string,
  environmentId: string,
): Promise<RunnerCandidateView[]> {
  const env = await loadEnvironment(tx, environmentId);
  if (!env) throw environmentNotFound();
  await requireTeamPermission(tx, userId, env.teamId, "ci.view", environmentNotFound);
  const online = await listOnlineMachines(tx, env.teamId);
  const onlineIds = new Set(online.map((m) => m.id));
  const offlineIds = env.runnerMachines.filter((id) => !onlineIds.has(id));
  const names = await machineNames(tx, offlineIds);
  const reports = await reportsOf(tx, [...onlineIds, ...offlineIds]);
  const view = (machineId: string, name: string, isOnline: boolean, labels: string[]): RunnerCandidateView => {
    const r = reports.get(machineId);
    return {
      machineId,
      name,
      online: isOnline,
      labeled: labels.includes(DEPLOY_RUNNER_LABEL),
      methods: (r?.methods ?? []).filter((x): x is DeliveryMethod => KNOWN_METHODS.has(x)),
      credentials: r?.credentials ?? [],
      reportedAt: r?.reportedAt.toISOString() ?? null,
    };
  };
  return [
    ...online.map((m) => view(m.id, m.name, true, m.labels)),
    // Máy đã thu hồi hay thuộc đội khác thì fleet không trả tên: không hiện, lần lưu sau sẽ bỏ nó.
    ...offlineIds.flatMap((id) => {
      const name = names.get(id);
      return name ? [view(id, name, false, [])] : [];
    }),
  ];
}

/**
 * Đổi máy chạy deploy của môi trường (servers.manage). Môi trường đòi nhãn thì từ chối máy trực tuyến chưa có nhãn
 * `deploy-runner`, để admin biết ngay thay vì lần triển khai sau mới chờ mãi (FR-012). Chuyển sang `legacy` được ghi
 * audit vì hub sẽ tự gọi ra ngoài.
 */
export async function setEnvironmentRunner(
  tx: Tx,
  userId: string,
  input: { id: string; runner: EnvironmentRunner },
): Promise<DeployEnvironment> {
  const env = await loadEnvironment(tx, input.id);
  if (!env) throw environmentNotFound();
  await requireTeamPermission(tx, userId, env.teamId, "servers.manage", environmentNotFound);
  const { runner } = input;
  const online = new Map((await listOnlineMachines(tx, env.teamId)).map((m) => [m.id, m]));
  const known = new Set([...online.keys(), ...env.runnerMachines]);
  const unknown = runner.machines.filter((id) => !known.has(id));
  if (unknown.length > 0)
    throw new BadRequestError(
      "RUNNER_MACHINE_UNKNOWN",
      "Chỉ chọn được máy đang trực tuyến của đội sở hữu môi trường. Bật máy rồi thử lại.",
    );
  if (runner.requireLabel) {
    const unlabeled = runner.machines
      .map((id) => online.get(id))
      .filter((m) => m !== undefined && !m.labels.includes(DEPLOY_RUNNER_LABEL));
    if (unlabeled.length > 0)
      throw new BadRequestError(
        "RUNNER_LABEL_MISSING",
        `Máy ${unlabeled.map((m) => m?.name).join(", ")} chưa có nhãn ${DEPLOY_RUNNER_LABEL}. Gắn nhãn ở màn Máy hoặc bỏ yêu cầu nhãn.`,
      );
  }
  const [row] = await tx
    .update(deployEnvironments)
    .set({
      runner: runner.mode,
      runnerMachines: runner.machines,
      runnerLabelRequired: runner.requireLabel,
      updatedAt: new Date(),
    })
    .where(eq(deployEnvironments.id, env.id))
    .returning();
  if (!row) throw environmentNotFound();
  await recordAudit(tx, {
    action: "delivery.environment.runner",
    targetType: "deploy_environment",
    targetId: row.id,
    data: {
      systemId: row.systemId,
      from: { mode: env.runner, machines: env.runnerMachines, requireLabel: env.runnerLabelRequired },
      to: runner,
    },
  });
  return (await environmentViews(tx, [row]))[0] as DeployEnvironment;
}
