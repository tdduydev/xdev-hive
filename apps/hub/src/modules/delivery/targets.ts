import { randomUUID } from "node:crypto";
import {
  DELIVERY_ERRORS,
  DEPLOY_ACTIVE_STATES,
  type DeliveryPerson,
  type DeployTarget,
  type TargetConfig,
  type TargetUpsertInput,
  targetConfigInput,
} from "@xdev-hive/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import { findProject } from "../catalog/index.ts";
import {
  BadRequestError,
  ConflictError,
  encryptSecret,
  type MasterKey,
  NotFoundError,
  type Tx,
} from "../platform/index.ts";
import { effectivePermissions } from "../tenancy/index.ts";
import { pgCode, requireMasterKey } from "./connections/jenkins.ts";
import { loadEnvironment, peopleOf, requireTeamPermission } from "./environments.ts";
import {
  ciJenkinsConnections,
  deployConnections,
  deployEnvironments,
  deployServers,
  deploys,
  deployTargets,
} from "./schema.ts";

// Đích triển khai = dự án × môi trường (FR-013, FR-014). Chỉ người có `servers.manage` của đội sở hữu sửa cấu hình và
// lệnh (FR-030). Biến bí mật của cách `ssh-script` mã hoá từng giá trị ngay trong `config` (`valueEnc`), không có đường
// trả ra: API chỉ cho biết đã đặt hay chưa.

export interface TargetDeps {
  masterKey?: MasterKey | undefined;
}

/** Ngữ cảnh mã hoá của một biến bí mật; job triển khai dùng cùng hàm này để giải mã khi chạy. */
export const targetVariableContext = (targetId: string, name: string) => `deploy_targets:${targetId}:var:${name}`;

type Config = z.output<typeof targetConfigInput>;
type Row = typeof deployTargets.$inferSelect;
interface StoredVariable {
  name: string;
  secret: boolean;
  value?: string;
  valueEnc?: string;
}

const projectNotFound = () => new NotFoundError("NOT_FOUND", "Không tìm thấy dự án.");
const targetNotFound = () => new NotFoundError("NOT_FOUND", "Không tìm thấy đích triển khai.");
const environmentNotFound = () => new NotFoundError("NOT_FOUND", "Không tìm thấy môi trường.");

const versionConflict = (configVersion: number) =>
  new ConflictError("TARGET_VERSION_CONFLICT", DELIVERY_ERRORS.TARGET_VERSION_CONFLICT.message, { configVersion });

// ---- Hiển thị -------------------------------------------------------------------------------------------------------

function viewConfig(config: Record<string, unknown>): TargetConfig {
  if (config.method !== "ssh-script") return config as TargetConfig;
  const variables = ((config.variables ?? []) as StoredVariable[]).map((v) =>
    v.secret
      ? { name: v.name, secret: true as const, set: typeof v.valueEnc === "string" }
      : { name: v.name, secret: false as const, value: v.value ?? "" },
  );
  return { ...config, variables } as TargetConfig;
}

function view(r: Row, people: Map<string, DeliveryPerson>): DeployTarget {
  return {
    id: r.id,
    projectId: r.projectId,
    environmentId: r.environmentId,
    method: r.method as DeployTarget["method"],
    config: viewConfig(r.config),
    configVersion: r.configVersion,
    updatedBy: r.updatedBy ? (people.get(r.updatedBy) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function views(tx: Tx, rows: Row[]): Promise<DeployTarget[]> {
  const people = await peopleOf(
    tx,
    rows.map((r) => r.updatedBy),
  );
  return rows.map((r) => view(r, people));
}

// ---- Đọc ------------------------------------------------------------------------------------------------------------

/** Chỉ trả đích của đội mà người gọi có `ci.view`; đích của đội khác bị bỏ lặng lẽ như không có. */
export async function listTargets(
  tx: Tx,
  userId: string,
  filter: { systemId?: string | undefined; projectId?: string | undefined; environmentId?: string | undefined },
): Promise<DeployTarget[]> {
  const rows = await tx
    .select({ target: deployTargets, teamId: deployEnvironments.teamId })
    .from(deployTargets)
    .innerJoin(deployEnvironments, eq(deployEnvironments.id, deployTargets.environmentId))
    .where(
      and(
        filter.systemId ? eq(deployEnvironments.systemId, filter.systemId) : undefined,
        filter.projectId ? eq(deployTargets.projectId, filter.projectId) : undefined,
        filter.environmentId ? eq(deployTargets.environmentId, filter.environmentId) : undefined,
      ),
    )
    .orderBy(deployEnvironments.position, deployEnvironments.name, deployTargets.projectId);
  const visible = new Map<string, boolean>();
  for (const { teamId } of rows)
    if (!visible.has(teamId)) visible.set(teamId, (await effectivePermissions(tx, userId, teamId)).has("ci.view"));
  return views(
    tx,
    rows.filter((r) => visible.get(r.teamId)).map((r) => r.target),
  );
}

async function targetWithTeam(tx: Tx, id: string): Promise<{ target: Row; teamId: string } | null> {
  const [row] = await tx
    .select({ target: deployTargets, teamId: deployEnvironments.teamId })
    .from(deployTargets)
    .innerJoin(deployEnvironments, eq(deployEnvironments.id, deployTargets.environmentId))
    .where(eq(deployTargets.id, id));
  return row ?? null;
}

export async function getTarget(tx: Tx, userId: string, id: string): Promise<DeployTarget> {
  const found = await targetWithTeam(tx, id);
  if (!found) throw targetNotFound();
  await requireTeamPermission(tx, userId, found.teamId, "ci.view", targetNotFound);
  return (await views(tx, [found.target]))[0] as DeployTarget;
}

// ---- Ghi ------------------------------------------------------------------------------------------------------------

const badRequest = (code: string, message: string) => new BadRequestError(code, message);

/** Máy chủ, kết nối và môi trường nguồn mà cấu hình trỏ tới phải có thật và đúng phạm vi (RLS đã giới hạn trong tổ chức). */
async function checkReferences(
  tx: Tx,
  env: { id: string; teamId: string; systemId: string },
  config: Config,
): Promise<void> {
  switch (config.method) {
    case "ssh-script": {
      const [server] = await tx
        .select({ teamId: deployServers.teamId })
        .from(deployServers)
        .where(eq(deployServers.id, config.serverId));
      if (!server || server.teamId !== env.teamId)
        throw badRequest("SERVER_NOT_IN_TEAM", "Máy chủ phải thuộc cùng đội với hệ thống của môi trường.");
      return;
    }
    case "argocd":
    case "kubectl": {
      const kind = config.method === "argocd" ? "argocd" : "kubernetes";
      const [conn] = await tx
        .select({ kind: deployConnections.kind })
        .from(deployConnections)
        .where(eq(deployConnections.id, config.connectionId));
      if (!conn) throw badRequest("CONNECTION_NOT_FOUND", "Không tìm thấy kết nối của tổ chức.");
      if (conn.kind !== kind)
        throw badRequest(
          "CONNECTION_KIND_MISMATCH",
          kind === "argocd" ? "Chọn một kết nối Argo CD." : "Chọn một kết nối Kubernetes.",
        );
      return;
    }
    case "jenkins-job": {
      const [conn] = await tx
        .select({ id: ciJenkinsConnections.id })
        .from(ciJenkinsConnections)
        .where(eq(ciJenkinsConnections.id, config.connectionId));
      if (!conn) throw badRequest("CONNECTION_NOT_FOUND", "Không tìm thấy kết nối Jenkins của tổ chức.");
      if (config.promote) {
        const source = await loadEnvironment(tx, config.promote.fromEnvironmentId);
        if (!source || source.systemId !== env.systemId || source.id === env.id)
          throw badRequest(
            "PROMOTE_SOURCE_INVALID",
            'Môi trường nguồn của "đẩy từ môi trường" phải là môi trường khác của cùng hệ thống.',
          );
      }
      return;
    }
    case "gitlab-manual":
      return;
  }
}

/**
 * Biến bí mật: có giá trị mới thì mã hoá, bỏ trống thì giữ bản đã lưu cùng tên. Biến bí mật mới mà không có giá trị là
 * lỗi nhập, vì không có gì để giữ.
 */
function storeVariables(
  deps: TargetDeps,
  targetId: string,
  config: Config,
  previous: Record<string, unknown> | null,
): { config: Record<string, unknown>; replaced: string[] } {
  if (config.method !== "ssh-script") return { config, replaced: [] };
  const kept = new Map(
    (previous?.method === "ssh-script" ? ((previous.variables ?? []) as StoredVariable[]) : [])
      .filter((v) => v.secret && typeof v.valueEnc === "string")
      .map((v) => [v.name, v.valueEnc as string]),
  );
  const replaced: string[] = [];
  const variables = config.variables.map((v): StoredVariable => {
    if (!v.secret) return { name: v.name, secret: false, value: v.value };
    if (v.value !== undefined) {
      replaced.push(v.name);
      return {
        name: v.name,
        secret: true,
        valueEnc: encryptSecret(requireMasterKey(deps), v.value, targetVariableContext(targetId, v.name)),
      };
    }
    const valueEnc = kept.get(v.name);
    if (!valueEnc)
      throw badRequest("SECRET_VALUE_REQUIRED", `Biến bí mật ${v.name} chưa có giá trị. Nhập giá trị cho biến.`);
    return { name: v.name, secret: true, valueEnc };
  });
  return { config: { ...config, variables }, replaced };
}

/** Bản của cấu hình để ghi audit: không có giá trị hay bản mã của biến bí mật. */
function redacted(config: Record<string, unknown>): Record<string, unknown> {
  if (config.method !== "ssh-script") return config;
  const variables = ((config.variables ?? []) as Array<StoredVariable & { value?: string }>).map((v) =>
    v.secret ? { name: v.name, secret: true } : { name: v.name, secret: false, value: v.value },
  );
  return { ...config, variables };
}

function diffConfig(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = { from: before[key], to: after[key] };
  return out;
}

function parseConfig(input: TargetUpsertInput["config"]): Config {
  const parsed = targetConfigInput.safeParse(input);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const path = (first?.path ?? []).join(".");
  throw badRequest(
    "INVALID_TARGET_CONFIG",
    path ? `Cấu hình đích không hợp lệ ở ${path}: ${first?.message}` : `Cấu hình đích không hợp lệ: ${first?.message}`,
  );
}

/**
 * Tạo hoặc sửa đích. Khoá lạc quan: `expectedConfigVersion` null chỉ để tạo mới, còn lại phải khớp bản đang lưu. Hàng
 * đích bị khoá trong giao dịch nên hai người sửa cùng lúc xếp hàng, người sau thấy bản mới và bị từ chối.
 */
export async function upsertTarget(
  tx: Tx,
  deps: TargetDeps,
  userId: string,
  input: TargetUpsertInput,
): Promise<DeployTarget> {
  const project = await findProject(tx, input.projectId);
  if (!project) throw projectNotFound();
  await requireTeamPermission(tx, userId, project.teamId, "servers.manage", projectNotFound);
  const env = await loadEnvironment(tx, input.environmentId);
  if (!env) throw environmentNotFound();
  if (env.systemId !== project.systemId)
    throw badRequest("TARGET_SYSTEM_MISMATCH", "Môi trường và dự án phải thuộc cùng một hệ thống.");

  const config = parseConfig(input.config);
  await checkReferences(tx, env, config);

  const [current] = await tx
    .select()
    .from(deployTargets)
    .where(and(eq(deployTargets.projectId, project.id), eq(deployTargets.environmentId, env.id)))
    .for("update");
  if (!current && input.expectedConfigVersion !== null) throw targetNotFound();
  if (current && input.expectedConfigVersion !== current.configVersion) throw versionConflict(current.configVersion);

  const id = current?.id ?? randomUUID();
  const stored = storeVariables(deps, id, config, current?.config ?? null);
  const columns = {
    method: config.method,
    config: stored.config,
    serverId: config.method === "ssh-script" ? config.serverId : null,
    connectionId: config.method === "argocd" || config.method === "kubectl" ? config.connectionId : null,
    updatedBy: userId,
    updatedAt: new Date(),
  };

  let row: Row | undefined;
  if (current) {
    [row] = await tx
      .update(deployTargets)
      .set({ ...columns, configVersion: current.configVersion + 1 })
      .where(and(eq(deployTargets.id, id), eq(deployTargets.configVersion, current.configVersion)))
      .returning();
    if (!row) throw versionConflict(current.configVersion);
  } else {
    try {
      [row] = await tx
        .insert(deployTargets)
        .values({ id, orgId: sql`hive.ctx_org()`, projectId: project.id, environmentId: env.id, ...columns })
        .returning();
    } catch (e) {
      // Người khác vừa tạo đích này giữa lúc kiểm và ghi.
      if (pgCode(e) === "23505") throw versionConflict(1);
      throw e;
    }
  }
  if (!row) throw new Error("Không lưu được đích triển khai.");

  await recordAudit(tx, {
    action: current ? "delivery.target.update" : "delivery.target.create",
    targetType: "deploy_target",
    targetId: row.id,
    data: {
      projectId: project.id,
      environmentId: env.id,
      method: row.method,
      configVersion: { from: current?.configVersion ?? null, to: row.configVersion },
      ...(current
        ? { changes: diffConfig(redacted(current.config), redacted(row.config)) }
        : { config: redacted(row.config) }),
      secretsReplaced: stored.replaced,
    },
  });
  return (await views(tx, [row]))[0] as DeployTarget;
}

/** Xoá đích xoá luôn lịch sử triển khai của nó nên chặn khi còn một lần do Hive tạo đang đi. */
export async function removeTarget(tx: Tx, userId: string, id: string): Promise<{ id: string }> {
  const found = await targetWithTeam(tx, id);
  if (!found) throw targetNotFound();
  await requireTeamPermission(tx, userId, found.teamId, "servers.manage", targetNotFound);
  const [active] = await tx
    .select({ id: deploys.id })
    .from(deploys)
    .where(and(eq(deploys.targetId, id), eq(deploys.origin, "hive"), inArray(deploys.state, [...DEPLOY_ACTIVE_STATES])))
    .limit(1);
  if (active) throw new ConflictError("DEPLOY_IN_PROGRESS", DELIVERY_ERRORS.DEPLOY_IN_PROGRESS.message);
  await tx.delete(deployTargets).where(eq(deployTargets.id, id));
  await recordAudit(tx, {
    action: "delivery.target.remove",
    targetType: "deploy_target",
    targetId: id,
    data: { projectId: found.target.projectId, environmentId: found.target.environmentId, method: found.target.method },
  });
  return { id };
}
