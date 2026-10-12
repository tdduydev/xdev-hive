import { createHash, timingSafeEqual } from "node:crypto";
import {
  DESKTOP_CONNECT_PREFIX,
  type DesktopConnectApproveInput,
  type DesktopConnectExchangeOutput,
  type DesktopConnectOptions,
  desktopConnectApproveInput,
  desktopConnectExchangeInput,
} from "@xdev-hive/contracts";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { ForbiddenError, type Tx, withTenant } from "../platform/index.ts";
import { allowWith, requireTeamRole, teams } from "../tenancy/index.ts";
import { FleetError } from "./errors.ts";
import { createRegistration } from "./registration.ts";
import { desktopConnectCodes } from "./schema.ts";
import { hashToken, newToken, withTokenLookup } from "./tokens.ts";

/** Đủ để đăng nhập trên trình duyệt rồi quay về app; ngắn để mã lọt ra ngoài cũng hết hạn sớm. */
export const DESKTOP_CONNECT_TTL_MS = 5 * 60 * 1000;

/** Token cá nhân của app desktop; module mcp tạo (main.ts truyền vào) để fleet không import mcp. */
export type IssuePersonalToken = (tx: Tx, userId: string) => Promise<{ token: string; expiresAt: Date }>;

// Mã sai, hết hạn, đã dùng hay verifier sai đều cùng một lỗi, để người dò không biết mã nào từng tồn tại.
const invalidCode = () =>
  new FleetError(
    "unauthorized",
    "DESKTOP_CONNECT_INVALID",
    "Mã đăng nhập không hợp lệ, đã hết hạn hoặc đã dùng. Bấm đăng nhập lại trong app.",
  );

const canRegister = (tx: Tx, userId: string, teamId: string) =>
  allowWith(tx, userId, "machines.register", () => requireTeamRole(tx, userId, teamId, "admin"), teamId);

export async function desktopConnectOptions(tx: Tx, userId: string): Promise<DesktopConnectOptions> {
  const all = await tx.select({ id: teams.id, name: teams.name }).from(teams).orderBy(asc(teams.name));
  const allowed: DesktopConnectOptions["teams"] = [];
  for (const team of all) {
    try {
      await canRegister(tx, userId, team.id);
      allowed.push(team);
    } catch (error) {
      if (!(error instanceof ForbiddenError)) throw error;
    }
  }
  return { teams: allowed };
}

/**
 * Người dùng bấm Cho phép trên web. Chỉ chuyển trình duyệt về 127.0.0.1 (RFC 8252 mục 7.3): trang khác không nhận
 * được mã, và mã một mình vô dụng nếu không có verifier mà chỉ app giữ.
 */
export async function approveDesktopConnect(
  tx: Tx,
  userId: string,
  raw: DesktopConnectApproveInput,
): Promise<{ redirectUrl: string; expiresAt: string }> {
  const input = desktopConnectApproveInput.parse(raw);
  await canRegister(tx, userId, input.teamId);
  const code = newToken(DESKTOP_CONNECT_PREFIX);
  const expiresAt = new Date(Date.now() + DESKTOP_CONNECT_TTL_MS);
  const [row] = await tx
    .insert(desktopConnectCodes)
    .values({
      orgId: sql`hive.ctx_org()`,
      teamId: input.teamId,
      userId,
      tokenHash: hashToken(code),
      challenge: input.challenge,
      machine: input.machine,
      expiresAt,
    })
    .returning({ id: desktopConnectCodes.id });
  await recordAudit(tx, {
    action: "desktop.connect.approve",
    targetType: "desktop_connect_code",
    targetId: row?.id,
    data: { teamId: input.teamId, machine: input.machine },
  });
  const url = new URL(`http://127.0.0.1:${input.port}/callback`);
  url.searchParams.set("code", code);
  url.searchParams.set("state", input.state);
  return { redirectUrl: url.toString(), expiresAt: expiresAt.toISOString() };
}

function pkceMatches(verifier: string, challenge: string): boolean {
  const got = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const want = Buffer.from(challenge);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * App đổi mã lấy mã đăng ký máy và token cá nhân. Không có phiên người dùng: tìm mã bằng băm để biết tổ chức, rồi
 * trong transaction của tổ chức đó (thay người đã bấm Cho phép) đánh dấu mã đã dùng và tạo hai token. Quyền đăng ký
 * máy được kiểm lại ở đây, nên người bị gỡ quyền trong năm phút đó không đổi được mã.
 */
export async function exchangeDesktopConnect(
  pool: pg.Pool,
  raw: { code: string; verifier: string },
  deps: { publicUrl: string; issuePersonalToken: IssuePersonalToken },
): Promise<DesktopConnectExchangeOutput> {
  const input = desktopConnectExchangeInput.parse(raw);
  const hash = hashToken(input.code);
  const found = await withTokenLookup(pool, hash, async (tx) => {
    const [row] = await tx
      .select({ orgId: desktopConnectCodes.orgId, userId: desktopConnectCodes.userId })
      .from(desktopConnectCodes)
      .where(eq(desktopConnectCodes.tokenHash, hash));
    return row;
  });
  if (!found) throw invalidCode();
  return withTenant(pool, { userId: found.userId, orgId: found.orgId }, async (tx) => {
    const [row] = await tx
      .select()
      .from(desktopConnectCodes)
      .where(and(eq(desktopConnectCodes.tokenHash, hash), isNull(desktopConnectCodes.usedAt)))
      .for("update");
    if (!row || row.expiresAt <= new Date() || !pkceMatches(input.verifier, row.challenge)) throw invalidCode();
    await tx.update(desktopConnectCodes).set({ usedAt: new Date() }).where(eq(desktopConnectCodes.id, row.id));
    const registration = await createRegistration(tx, row.userId, row.teamId);
    const personal = await deps.issuePersonalToken(tx, row.userId);
    await recordAudit(tx, {
      action: "desktop.connect.exchange",
      actorUserId: row.userId,
      targetType: "desktop_connect_code",
      targetId: row.id,
      data: { teamId: row.teamId, machine: row.machine },
    });
    return {
      hubUrl: deps.publicUrl.replace(/\/+$/, ""),
      machine: row.machine,
      teamId: row.teamId,
      registrationToken: registration.token,
      personalToken: personal.token,
      personalTokenExpiresAt: personal.expiresAt.toISOString(),
    };
  });
}
