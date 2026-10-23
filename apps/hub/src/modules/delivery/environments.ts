import type { DeliveryPerson, DeployEnvironment, EnvironmentPolicy } from "@xdev-hive/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { authUser } from "../identity/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { effectivePermissions, findSystem } from "../tenancy/index.ts";
import { pgCode } from "./connections/jenkins.ts";
import { deployEnvironments } from "./schema.ts";

// Môi trường của hệ thống (FR-012, FR-026). Tạo, sửa, sắp thứ tự cần `servers.manage` của đội sở hữu hệ thống
// (spec không nói ai tạo môi trường nên theo FR-030: cùng quyền với khai báo đích). Khoá/mở khoá thuộc T027.

const systemNotFound = () => new NotFoundError("NOT_FOUND", "Không tìm thấy hệ thống.");
export const environmentNotFound = () => new NotFoundError("NOT_FOUND", "Không tìm thấy môi trường.");

/**
 * Quyền của người dùng trên đội. Thiếu `ci.view` thì báo như đối tượng không tồn tại (không lộ việc có hay không);
 * có xem mà thiếu quyền ghi thì nói rõ thiếu quyền gì.
 */
export async function requireTeamPermission(
  tx: Tx,
  userId: string,
  teamId: string,
  permission: "ci.view" | "servers.manage",
  notFound: () => NotFoundError,
): Promise<void> {
  const granted = await effectivePermissions(tx, userId, teamId);
  if (!granted.has("ci.view")) throw notFound();
  if (permission === "servers.manage" && !granted.has("servers.manage"))
    throw new ForbiddenError(
      "SERVERS_MANAGE_REQUIRED",
      "Chỉ người có quyền servers.manage (quản trị đội sở hữu hệ thống) mới sửa môi trường, đích và lệnh triển khai.",
    );
}

/** Tên người cho dữ liệu trả về; người đã bị xoá khỏi bảng người dùng thì hiện id. */
export async function peopleOf(tx: Tx, userIds: Array<string | null>): Promise<Map<string, DeliveryPerson>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  const rows = ids.length
    ? await tx.select({ id: authUser.id, name: authUser.name }).from(authUser).where(inArray(authUser.id, ids))
    : [];
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return new Map(ids.map((id) => [id, { userId: id, name: names.get(id) ?? id }]));
}

type Row = typeof deployEnvironments.$inferSelect;

function view(r: Row, people: Map<string, DeliveryPerson>): DeployEnvironment {
  return {
    id: r.id,
    systemId: r.systemId,
    name: r.name,
    position: r.position,
    policy: r.policy,
    lock:
      r.lockedAt && r.lockReason !== null
        ? {
            by: r.lockedBy ? (people.get(r.lockedBy) ?? null) : null,
            at: r.lockedAt.toISOString(),
            reason: r.lockReason,
          }
        : null,
    runner: {
      mode: r.runner as DeployEnvironment["runner"]["mode"],
      machines: r.runnerMachines,
      requireLabel: r.runnerLabelRequired,
    },
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function environmentViews(tx: Tx, rows: Row[]): Promise<DeployEnvironment[]> {
  const people = await peopleOf(
    tx,
    rows.map((r) => r.lockedBy),
  );
  return rows.map((r) => view(r, people));
}

export async function loadEnvironment(tx: Tx, id: string): Promise<Row | null> {
  const [row] = await tx.select().from(deployEnvironments).where(eq(deployEnvironments.id, id));
  return row ?? null;
}

const inSystem = (tx: Tx, systemId: string) =>
  tx
    .select()
    .from(deployEnvironments)
    .where(eq(deployEnvironments.systemId, systemId))
    .orderBy(deployEnvironments.position, deployEnvironments.name);

export async function listEnvironments(tx: Tx, userId: string, systemId: string): Promise<DeployEnvironment[]> {
  const system = await findSystem(tx, systemId);
  if (!system) throw systemNotFound();
  await requireTeamPermission(tx, userId, system.teamId, "ci.view", systemNotFound);
  return environmentViews(tx, await inSystem(tx, systemId));
}

const nameTaken = (name: string) =>
  new ConflictError("ENV_NAME_TAKEN", `Hệ thống đã có môi trường tên "${name}". Chọn tên khác.`);

export async function createEnvironment(
  tx: Tx,
  userId: string,
  input: { systemId: string; name: string; policy: EnvironmentPolicy },
): Promise<DeployEnvironment> {
  const system = await findSystem(tx, input.systemId);
  if (!system) throw systemNotFound();
  await requireTeamPermission(tx, userId, system.teamId, "servers.manage", systemNotFound);
  // Khoá theo hệ thống để hai người tạo cùng lúc không nhận cùng một vị trí.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploy_environments:${system.id}`}, 0))`);
  const [last] = await tx
    .select({ max: sql<number | null>`max(${deployEnvironments.position})` })
    .from(deployEnvironments)
    .where(eq(deployEnvironments.systemId, system.id));
  let row: Row | undefined;
  try {
    [row] = await tx
      .insert(deployEnvironments)
      .values({
        orgId: sql`hive.ctx_org()`,
        teamId: system.teamId,
        systemId: system.id,
        name: input.name,
        position: (last?.max ?? -1) + 1,
        policy: input.policy,
      })
      .returning();
  } catch (e) {
    if (pgCode(e) === "23505") throw nameTaken(input.name);
    throw e;
  }
  if (!row) throw new Error("Không tạo được môi trường.");
  await recordAudit(tx, {
    action: "delivery.environment.create",
    targetType: "deploy_environment",
    targetId: row.id,
    data: { systemId: system.id, name: row.name, position: row.position, policy: row.policy },
  });
  return (await environmentViews(tx, [row]))[0] as DeployEnvironment;
}

export async function updateEnvironment(
  tx: Tx,
  userId: string,
  input: { id: string; name?: string | undefined; policy?: EnvironmentPolicy | undefined },
): Promise<DeployEnvironment> {
  const current = await loadEnvironment(tx, input.id);
  if (!current) throw environmentNotFound();
  await requireTeamPermission(tx, userId, current.teamId, "servers.manage", environmentNotFound);
  let row: Row | undefined;
  try {
    [row] = await tx
      .update(deployEnvironments)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.policy === undefined ? {} : { policy: input.policy }),
        updatedAt: new Date(),
      })
      .where(eq(deployEnvironments.id, current.id))
      .returning();
  } catch (e) {
    if (pgCode(e) === "23505") throw nameTaken(input.name ?? current.name);
    throw e;
  }
  if (!row) throw environmentNotFound();
  await recordAudit(tx, {
    action: "delivery.environment.update",
    targetType: "deploy_environment",
    targetId: row.id,
    data: {
      systemId: row.systemId,
      ...(row.name !== current.name ? { name: { from: current.name, to: row.name } } : {}),
      ...(JSON.stringify(row.policy) !== JSON.stringify(current.policy)
        ? { policy: { from: current.policy, to: row.policy } }
        : {}),
    },
  });
  return (await environmentViews(tx, [row]))[0] as DeployEnvironment;
}

/** Danh sách mới phải đủ mọi môi trường của hệ thống: thiếu hay thừa thì một môi trường lạc vị trí mà không ai hay. */
export async function reorderEnvironments(
  tx: Tx,
  userId: string,
  input: { systemId: string; ids: string[] },
): Promise<DeployEnvironment[]> {
  const system = await findSystem(tx, input.systemId);
  if (!system) throw systemNotFound();
  await requireTeamPermission(tx, userId, system.teamId, "servers.manage", systemNotFound);
  const current = await inSystem(tx, system.id);
  const known = new Set(current.map((r) => r.id));
  if (input.ids.length !== known.size || input.ids.some((id) => !known.has(id)))
    throw new BadRequestError(
      "ENV_ORDER_MISMATCH",
      "Danh sách sắp thứ tự phải gồm đủ mọi môi trường của hệ thống, mỗi môi trường một lần.",
    );
  for (const [position, id] of input.ids.entries())
    await tx
      .update(deployEnvironments)
      .set({ position, updatedAt: new Date() })
      .where(and(eq(deployEnvironments.id, id), eq(deployEnvironments.systemId, system.id)));
  await recordAudit(tx, {
    action: "delivery.environment.reorder",
    targetType: "system",
    targetId: system.id,
    data: {
      from: current.map((r) => r.name),
      to: input.ids.map((id) => current.find((r) => r.id === id)?.name),
    },
  });
  return environmentViews(tx, await inSystem(tx, system.id));
}
