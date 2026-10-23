import {
  createHash,
  createHmac,
  createPublicKey,
  hkdfSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { machineTokenMessage, type WorkerKeyInput, type WorkerTokenInput } from "@xdev-hive/contracts";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { withTenant } from "../platform/index.ts";
import { FleetError, machineAuthFailed } from "./errors.ts";
import { type AuthedMachine, authenticateMachine } from "./machines.ts";
import { machines, machineTokens } from "./schema.ts";
import { MACHINE_PREFIX, withMachineLookup } from "./tokens.ts";

/*
 * Access token máy (ADR 0033): máy giữ khoá Ed25519, ký nonce của hub để đổi lấy JWT HS256 15 phút. Lộ token chỉ lộ
 * chừng đó thời gian, và thu hồi máy chặn lần đổi kế tiếp mà không cần danh sách token bị thu hồi. Khoá ký suy từ
 * HIVE_AUTH_SECRET bằng nhãn HKDF riêng như run token, nên không thay được run token hay cookie phiên.
 */

export const MACHINE_TOKEN_TTL_SEC = 15 * 60;
export const CHALLENGE_TTL_SEC = 60;
export const MACHINE_TOKEN_PER_MINUTE = 30;
export const MACHINE_TOKEN_IP_PER_MINUTE = 300;
const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

export interface MachineTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  org_id: string;
  team_id: string;
  iat: number;
  exp: number;
  jti: string;
  /** Dấu của khoá công khai đã ký nonce. Cài lại máy giữ id máy nhưng thay khoá, nên token của bản cài cũ hết dùng. */
  kid: string;
}

/** Máy đã xác thực, kèm hạn của access token; `exp` không có khi máy mở bằng machine token. */
export interface MachineSession {
  machine: AuthedMachine;
  exp?: Date;
}

export const machineAudience = (publicUrl: string) => `${publicUrl.replace(/\/+$/, "")}/worker`;

export interface MachineAuthOptions {
  pool: pg.Pool;
  authSecret: string;
  publicUrl: string;
  now?: () => number;
}

export type MachineAuth = ReturnType<typeof createMachineAuth>;

export function createMachineAuth(opts: MachineAuthOptions) {
  const tokenKey = Buffer.from(hkdfSync("sha256", opts.authSecret, "", "xdev-hive machine token v1", 32));
  const challengeKey = Buffer.from(hkdfSync("sha256", opts.authSecret, "", "xdev-hive machine challenge v1", 32));
  const iss = opts.publicUrl.replace(/\/+$/, "");
  const aud = machineAudience(opts.publicUrl);
  const now = opts.now ?? Date.now;
  // Đếm theo máy cộng IP chứ không theo máy: id máy không bí mật, đếm theo máy thì ai cũng xin nonce thay máy được để
  // máy thật hết lượt đổi token.
  const perMachineIp = new FixedWindow(MACHINE_TOKEN_PER_MINUTE);
  const perIp = new FixedWindow(MACHINE_TOKEN_IP_PER_MINUTE);
  // Nonce không lưu ở database nên chữ ký bắt được có thể đem đổi lại trong 60 giây; giữ nonce đã dùng tới khi hết hạn.
  // Hub chạy một tiến trình (NFR-14) nên bộ nhớ là đủ.
  const used = new Map<string, number>();

  const mac = (machineId: string, exp: number, salt: string) =>
    createHmac("sha256", challengeKey).update(`${machineId}|${exp}|${salt}`).digest("base64url");

  const limit = (ip: string, machineId?: string) => {
    const t = now();
    if (!perIp.hit(ip, t) || (machineId !== undefined && !perMachineIp.hit(`${machineId}|${ip}`, t))) {
      throw new FleetError("rate_limited", "MACHINE_TOKEN_RATE_LIMITED", "Máy xin token quá nhiều lần; thử lại sau.");
    }
  };

  /**
   * Nonce không hỏi database: máy không tồn tại cũng nhận nonce, để người dò không biết id nào có thật. Hạn theo đồng
   * hồ của hub nên đồng hồ máy lệch không làm hỏng lần đổi.
   */
  const challenge = (machineId: string, ip = "unknown") => {
    // Nonce không chạm database và không đổi được gì nếu thiếu khoá máy, nên chỉ đếm theo IP.
    limit(ip);
    const exp = Math.floor(now() / 1000) + CHALLENGE_TTL_SEC;
    const salt = randomBytes(16).toString("base64url");
    return {
      nonce: `${exp}.${salt}.${mac(machineId, exp, salt)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
      hub: iss,
    };
  };

  const takeNonce = (machineId: string, nonce: string): boolean => {
    const [expRaw, salt, sig] = nonce.split(".");
    const exp = Number(expRaw);
    if (!salt || !sig || !Number.isInteger(exp) || exp * 1000 <= now()) return false;
    const expected = Buffer.from(mac(machineId, exp, salt), "base64url");
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    const t = now();
    for (const [n, e] of used) if (e * 1000 <= t) used.delete(n);
    if (used.has(nonce)) return false;
    used.set(nonce, exp);
    return true;
  };

  const sign = (machine: { id: string; orgId: string; teamId: string; publicKey: string }) => {
    const iat = Math.floor(now() / 1000);
    const claims: MachineTokenClaims = {
      iss,
      aud,
      sub: `machine:${machine.id}`,
      org_id: machine.orgId,
      team_id: machine.teamId,
      iat,
      exp: iat + MACHINE_TOKEN_TTL_SEC,
      jti: randomUUID(),
      kid: keyId(machine.publicKey),
    };
    const body = `${HEADER}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    const sig = createHmac("sha256", tokenKey).update(body).digest("base64url");
    return { accessToken: `${body}.${sig}`, expiresAt: new Date(claims.exp * 1000).toISOString() };
  };

  /** Đổi chữ ký trên nonce lấy access token. Mọi lý do hỏng đều là MACHINE_AUTH_FAILED. */
  const exchange = async (input: WorkerTokenInput, ip = "unknown") => {
    limit(ip, input.machineId);
    if (!takeNonce(input.machineId, input.nonce)) throw machineAuthFailed();
    const [row] = await withMachineLookup(opts.pool, input.machineId, (tx) =>
      tx
        .select({ id: machines.id, orgId: machines.orgId, teamId: machines.teamId, publicKey: machines.publicKey })
        .from(machines)
        .where(and(eq(machines.id, input.machineId), isNull(machines.revokedAt), isNotNull(machines.publicKey))),
    );
    const key = row?.publicKey ? ed25519Key(row.publicKey) : null;
    const message = Buffer.from(machineTokenMessage(iss, input.machineId, input.nonce), "utf8");
    if (!row?.publicKey || !key || !verify(null, message, key, Buffer.from(input.signature, "base64url"))) {
      throw machineAuthFailed();
    }
    return sign({ ...row, publicKey: row.publicKey });
  };

  const verifyToken = (token: string): MachineTokenClaims | null => {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts as [string, string, string];
    if (header !== HEADER) return null;
    const expected = createHmac("sha256", tokenKey).update(`${header}.${payload}`).digest();
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let claims: MachineTokenClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as MachineTokenClaims;
    } catch {
      return null;
    }
    if (claims.aud !== aud || claims.iss !== iss) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now()) return null;
    if (
      typeof claims.sub !== "string" ||
      !claims.sub.startsWith("machine:") ||
      typeof claims.org_id !== "string" ||
      typeof claims.kid !== "string"
    ) {
      return null;
    }
    return claims;
  };

  /**
   * Máy của access token, hoặc của machine token khi máy chưa có khoá (giai đoạn chuyển, FR-005). Vẫn hỏi database cho
   * access token để máy vừa bị thu hồi không dùng nốt phần còn lại của 15 phút.
   */
  const authenticate = async (token: string): Promise<MachineSession | null> => {
    if (token.startsWith(MACHINE_PREFIX)) {
      const machine = await authenticateMachine(opts.pool, token);
      return machine ? { machine } : null;
    }
    const claims = verifyToken(token);
    if (!claims) return null;
    const id = claims.sub.slice("machine:".length);
    const [row] = await withTenant(opts.pool, { orgId: claims.org_id }, (tx) =>
      tx
        .select({
          id: machines.id,
          orgId: machines.orgId,
          teamId: machines.teamId,
          name: machines.name,
          kind: machines.kind,
          publicKey: machines.publicKey,
        })
        .from(machines)
        .where(and(eq(machines.id, id), isNull(machines.revokedAt), isNotNull(machines.publicKey))),
    );
    // So dấu khoá chứ không so giờ: hub và database có thể chạy ở hai máy đồng hồ lệch nhau.
    if (!row?.publicKey || claims.kid !== keyId(row.publicKey)) return null;
    const { publicKey: _, ...machine } = row;
    return { machine, exp: new Date(claims.exp * 1000) };
  };

  /**
   * Máy đăng ký trước khi có khoá gửi khoá bằng machine token. Xong thì token đó hết dùng được; đổi khoá phải đăng ký
   * lại bằng mã mới để kẻ lấy được machine token không thay được khoá của máy.
   */
  const registerKey = async (machineToken: string | undefined, input: WorkerKeyInput) => {
    const machine = machineToken?.startsWith(MACHINE_PREFIX)
      ? await authenticateMachine(opts.pool, machineToken)
      : null;
    if (!machine)
      throw new FleetError(
        "unauthorized",
        "MACHINE_TOKEN_INVALID",
        "Machine token không hợp lệ hoặc máy đã bị thu hồi.",
      );
    if (!ed25519Key(input.publicKey))
      throw new FleetError("bad_request", "MACHINE_KEY_INVALID", "Khoá công khai không hợp lệ.");
    return withTenant(opts.pool, { orgId: machine.orgId }, async (tx) => {
      const [row] = await tx
        .update(machines)
        .set({ publicKey: input.publicKey, publicKeyAt: sql`now()`, keyStorage: input.keyStorage })
        .where(and(eq(machines.id, machine.id), isNull(machines.publicKey), isNull(machines.revokedAt)))
        .returning({ id: machines.id, at: machines.publicKeyAt });
      if (!row?.at) {
        throw new FleetError(
          "conflict",
          "MACHINE_KEY_EXISTS",
          "Máy đã có khoá. Muốn đổi khoá thì đăng ký lại máy bằng mã đăng ký mới.",
        );
      }
      await tx.update(machineTokens).set({ supersededAt: sql`now()` }).where(eq(machineTokens.machineId, machine.id));
      await recordAudit(tx, {
        action: "machine.key_register",
        actorUserId: null,
        targetType: "machine",
        targetId: machine.id,
        data: { keyStorage: input.keyStorage },
      });
      return { machineId: row.id, registeredAt: row.at.toISOString() };
    });
  };

  return { challenge, exchange, verifyToken, authenticate, registerKey, sign };
}

const keyId = (publicKey: string) => createHash("sha256").update(publicKey).digest("base64url").slice(0, 22);

/** null khi chuỗi không phải 32 byte base64url. OpenSSL nhận mọi 32 byte nên khoá rác chỉ lộ ra khi chữ ký không khớp. */
export function ed25519Key(publicKey: string): KeyObject | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(publicKey)) return null;
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
  } catch {
    return null;
  }
}

/** Cửa sổ cố định một phút: đủ để chặn dò khoá, không cần độ mượt như giới hạn của link công khai. */
class FixedWindow {
  private readonly counts = new Map<string, { start: number; n: number }>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  hit(key: string, now: number): boolean {
    const start = now - (now % 60_000);
    if (this.counts.size > 100_000) {
      for (const [k, v] of this.counts) if (v.start < start) this.counts.delete(k);
    }
    const bucket = this.counts.get(key);
    if (!bucket || bucket.start !== start) {
      this.counts.set(key, { start, n: 1 });
      return true;
    }
    bucket.n += 1;
    return bucket.n <= this.limit;
  }
}
