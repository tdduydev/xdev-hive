import { type MachineKind, machineLabels, type RegisterInput, type RegisterOutput } from "@xdev-hive/contracts";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { type Tx, withTenant } from "../platform/index.ts";
import { allowWith, orgs, requireTeamRole, teamRoleOf } from "../tenancy/index.ts";
import { FleetError, invalidRegistration } from "./errors.ts";
import { machines, machineTokens, registrationTokens } from "./schema.ts";
import { hashToken, MACHINE_PREFIX, newToken, REGISTRATION_PREFIX, withTokenLookup } from "./tokens.ts";

export const REGISTRATION_TTL_MS = 60 * 60 * 1000;

/** Nhãn và cờ máy nhận sẵn khi đăng ký bằng mã (máy worker AI SDLC, specs/011 FR-042). */
export interface RegistrationFlags {
  labels?: string[];
  shared?: boolean;
  labelsOnly?: boolean;
}

/** Tạo mã đăng ký cho một đội. Trả mã gốc một lần; database chỉ giữ băm. */
export async function createRegistration(
  tx: Tx,
  userId: string,
  teamId: string,
  kind: MachineKind = "worker",
  flags: RegistrationFlags = {},
): Promise<{ token: string; expiresAt: Date }> {
  await allowWith(tx, userId, "machines.register", () => requireTeamRole(tx, userId, teamId, "admin"), teamId);
  const token = newToken(REGISTRATION_PREFIX);
  const expiresAt = new Date(Date.now() + REGISTRATION_TTL_MS);
  const labels = machineLabels.parse(flags.labels ?? []);
  const shared = flags.shared ?? false;
  const labelsOnly = flags.labelsOnly ?? false;
  const [row] = await tx
    .insert(registrationTokens)
    .values({
      orgId: sql`hive.ctx_org()`,
      teamId,
      kind,
      tokenHash: hashToken(token),
      expiresAt,
      createdBy: userId,
      labels,
      shared,
      labelsOnly,
    })
    .returning({ id: registrationTokens.id });
  await recordAudit(tx, {
    action: "machine.registration.create",
    targetType: "registration_token",
    targetId: row?.id,
    data: { teamId, kind, expiresAt: expiresAt.toISOString(), labels, shared, labelsOnly },
  });
  return { token, expiresAt };
}

/**
 * Worker đổi mã đăng ký lấy machine token. Không có phiên người dùng: tìm mã bằng băm để biết tổ chức, rồi trong một
 * transaction của tổ chức đó đánh dấu mã đã dùng, tạo (hoặc cài lại) máy và token. Lỗi ở bước nào cũng rollback cả
 * transaction, nên mã chưa bị tiêu nếu đăng ký hỏng.
 */
export async function registerMachine(pool: pg.Pool, input: RegisterInput): Promise<RegisterOutput> {
  if (!input.registrationToken.startsWith(REGISTRATION_PREFIX)) throw invalidRegistration();
  const hash = hashToken(input.registrationToken);
  const [found] = await withTokenLookup(pool, hash, (tx) =>
    tx
      .select({ id: registrationTokens.id, orgId: registrationTokens.orgId })
      .from(registrationTokens)
      .where(eq(registrationTokens.tokenHash, hash)),
  );
  if (!found) throw invalidRegistration();

  return withTenant(pool, { orgId: found.orgId }, async (tx) => {
    // Điều kiện nằm trong UPDATE: hai lần đăng ký cùng lúc bằng một mã thì lần sau chờ khoá dòng, thấy used_at đã có
    // và nhận 0 dòng.
    const [claimed] = await tx
      .update(registrationTokens)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(registrationTokens.id, found.id),
          isNull(registrationTokens.usedAt),
          gt(registrationTokens.expiresAt, sql`now()`),
        ),
      )
      .returning({
        teamId: registrationTokens.teamId,
        kind: registrationTokens.kind,
        createdBy: registrationTokens.createdBy,
        labels: registrationTokens.labels,
        shared: registrationTokens.shared,
        labelsOnly: registrationTokens.labelsOnly,
      });
    if (!claimed) throw invalidRegistration();

    const info = {
      kind: claimed.kind,
      os: input.os,
      version: input.version,
      clis: input.clis,
      capacity: input.capacity,
      // Cài lại máy mà không gửi khoá (worker cũ) thì bỏ khoá cũ: máy quay về machine token.
      publicKey: input.publicKey ?? null,
      publicKeyAt: input.publicKey ? sql`now()` : null,
      keyStorage: input.publicKey ? (input.keyStorage ?? "keychain") : null,
      registeredBy: claimed.createdBy,
    };
    // Mã thường (không nhãn, không dùng chung) không xoá nhãn và cờ quản trị đội đã đặt cho máy cài lại.
    const flags = {
      ...(claimed.labels.length > 0 ? { labels: claimed.labels, labelsOnly: claimed.labelsOnly } : {}),
      ...(claimed.shared ? { shared: true } : {}),
    };
    const [existing] = await tx.select().from(machines).where(eq(machines.name, input.machineId));
    if (existing && (existing.teamId !== claimed.teamId || existing.kind !== claimed.kind)) {
      throw new FleetError("conflict", "MACHINE_NAME_TAKEN", `Tên máy "${input.machineId}" đã được đội khác dùng.`);
    }
    // Cài lại giữ id, lịch sử và quyền chạy run riêng của chủ máy (ADR 0017), nên người chỉ có quyền tạo mã không được
    // dùng tên máy của người khác để chiếm máy cá nhân của họ (spec 034 FR-093). Admin đội vẫn cài lại hộ được.
    const previousOwner = existing?.registeredBy ?? null;
    if (existing && previousOwner && previousOwner !== claimed.createdBy) {
      const creatorRole = await teamRoleOf(tx, claimed.createdBy, claimed.teamId);
      if (creatorRole !== "admin")
        throw new FleetError("conflict", "MACHINE_NAME_TAKEN", `Tên máy "${input.machineId}" đã được dùng.`);
    }
    // Đổi chủ máy thì thu hồi rồi đăng ký mới; cài lại không lặng lẽ chuyển máy sang người tạo mã.
    if (previousOwner) info.registeredBy = previousOwner;
    // Cài lại máy cùng tên trong cùng đội (máy cài lại hệ điều hành, mất file cấu hình): giữ id để còn lịch sử run,
    // bỏ token cũ và gỡ trạng thái thu hồi vì admin đội vừa cấp mã mới.
    const [machine] = existing
      ? await tx
          .update(machines)
          .set({ ...info, ...flags, status: "offline", revokedAt: null })
          .where(eq(machines.id, existing.id))
          .returning()
      : await onNameTaken(input.machineId, () =>
          tx
            .insert(machines)
            .values({ ...info, ...flags, orgId: found.orgId, teamId: claimed.teamId, name: input.machineId })
            .returning(),
        );
    if (!machine) throw new Error("Không ghi được máy.");
    if (existing) await tx.delete(machineTokens).where(eq(machineTokens.machineId, machine.id));

    const machineToken = newToken(MACHINE_PREFIX);
    await tx.insert(machineTokens).values({
      orgId: found.orgId,
      teamId: machine.teamId,
      machineId: machine.id,
      tokenHash: hashToken(machineToken),
      // Máy có khoá chỉ mở kết nối bằng access token; vẫn trả machine token vì hợp đồng register buộc có trường này.
      supersededAt: input.publicKey ? sql`now()` : null,
    });
    await tx.update(registrationTokens).set({ usedByMachine: machine.id }).where(eq(registrationTokens.id, found.id));
    await recordAudit(tx, {
      action: "machine.register",
      actorUserId: null,
      targetType: "machine",
      targetId: machine.id,
      data: {
        name: machine.name,
        teamId: machine.teamId,
        reinstalled: Boolean(existing),
        ...(existing ? { previousOwner, reinstalledBy: claimed.createdBy } : {}),
        os: input.os,
        keyStorage: info.keyStorage,
      },
    });
    const [org] = await tx.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, found.orgId));
    return {
      id: machine.id,
      orgId: found.orgId,
      ...(org ? { orgName: org.name } : {}),
      teamId: machine.teamId,
      machineId: machine.name,
      machineToken,
    };
  });
}

/** Hai máy cùng tên đăng ký cùng lúc: lần sau vấp ràng buộc duy nhất thay vì nhận lỗi 500. */
async function onNameTaken<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const pgError = ((error as { cause?: unknown }).cause ?? error) as { code?: string; constraint?: string };
    if (pgError.code === "23505" && pgError.constraint === "machines_org_name") {
      throw new FleetError("conflict", "MACHINE_NAME_TAKEN", `Tên máy "${name}" đã được dùng.`);
    }
    throw error;
  }
}
