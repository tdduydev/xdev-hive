import { createHmac, generateKeyPairSync, hkdfSync } from "node:crypto";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { FleetError } from "./errors.ts";
import {
  CHALLENGE_TTL_SEC,
  createMachineAuth,
  ed25519Key,
  MACHINE_TOKEN_IP_PER_MINUTE,
  MACHINE_TOKEN_PER_MINUTE,
  MACHINE_TOKEN_TTL_SEC,
  machineAudience,
} from "./machine-auth.ts";

const machineId = "0198a1b2-0000-7000-8000-000000000001";
// Các nhánh ở đây hỏng trước khi chạm database; pool giả ném lỗi để test lộ ra nếu lỡ hỏi database.
const pool = {
  connect: () => Promise.reject(new Error("không được hỏi database")),
} as unknown as pg.Pool;

function setup(start = Date.UTC(2026, 9, 23, 8, 0, 0)) {
  let t = start;
  const auth = createMachineAuth({ pool, authSecret: "s".repeat(32), publicUrl: "https://hub.test/", now: () => t });
  return { auth, advance: (ms: number) => (t += ms), now: () => t };
}

const code = async (run: () => unknown) => {
  try {
    await run();
    return undefined;
  } catch (error) {
    if (error instanceof FleetError) return error.code;
    throw error;
  }
};

describe("access token máy", () => {
  it("ký JWT HS256 15 phút với aud của cổng worker", () => {
    const { auth, now } = setup();
    const { accessToken, expiresAt } = auth.sign({
      id: machineId,
      orgId: "org-1",
      teamId: "team-1",
      publicKey: "A".repeat(43),
    });
    const claims = auth.verifyToken(accessToken);
    expect(claims).toMatchObject({
      iss: "https://hub.test",
      aud: "https://hub.test/worker",
      sub: `machine:${machineId}`,
      org_id: "org-1",
      team_id: "team-1",
    });
    expect(claims?.exp).toBe(Math.floor(now() / 1000) + MACHINE_TOKEN_TTL_SEC);
    expect(Date.parse(expiresAt)).toBe((claims?.exp ?? 0) * 1000);
    expect(machineAudience("https://hub.test//")).toBe("https://hub.test/worker");
  });

  it("từ chối token hết hạn, bị sửa, hay ký bằng khoá của hub khác", () => {
    const { auth, advance } = setup();
    const { accessToken } = auth.sign({ id: machineId, orgId: "org-1", teamId: "team-1", publicKey: "A".repeat(43) });
    const [h, p, s] = accessToken.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), org_id: "x" }));
    expect(auth.verifyToken(`${h}.${forged.toString("base64url")}.${s}`)).toBeNull();
    expect(auth.verifyToken(`${h}.${p}`)).toBeNull();
    expect(auth.verifyToken("hwm_abc")).toBeNull();

    const other = createMachineAuth({ pool, authSecret: "t".repeat(32), publicUrl: "https://hub.test" });
    expect(other.verifyToken(accessToken)).toBeNull();

    advance(MACHINE_TOKEN_TTL_SEC * 1000);
    expect(auth.verifyToken(accessToken)).toBeNull();
  });

  it("khoá ký tách khỏi run token: cùng secret nhưng nhãn HKDF khác", () => {
    const { auth } = setup();
    const { accessToken } = auth.sign({ id: machineId, orgId: "org-1", teamId: "team-1", publicKey: "A".repeat(43) });
    const [h, p] = accessToken.split(".") as [string, string, string];
    const runKey = Buffer.from(hkdfSync("sha256", "s".repeat(32), "", "xdev-hive run token v1", 32));
    const sig = createHmac("sha256", runKey).update(`${h}.${p}`).digest("base64url");
    expect(auth.verifyToken(`${h}.${p}.${sig}`)).toBeNull();
  });
});

describe("nonce", () => {
  it("hết hạn sau 60 giây theo đồng hồ hub", () => {
    const { auth, now } = setup();
    const { nonce, expiresAt } = auth.challenge(machineId);
    expect(Date.parse(expiresAt)).toBe(Math.floor(now() / 1000) * 1000 + CHALLENGE_TTL_SEC * 1000);
    expect(nonce.split(".")).toHaveLength(3);
    expect(auth.challenge(machineId).nonce).not.toBe(nonce);
  });

  it("nonce sai máy, bị sửa hay hết hạn đều là MACHINE_AUTH_FAILED và không hỏi database", async () => {
    const { auth, advance } = setup();
    const { nonce } = auth.challenge(machineId);
    const signature = "A".repeat(86);
    const otherMachine = "0198a1b2-0000-7000-8000-000000000002";
    expect(await code(() => auth.exchange({ machineId: otherMachine, nonce, signature }))).toBe("MACHINE_AUTH_FAILED");
    expect(await code(() => auth.exchange({ machineId, nonce: `${nonce}x`, signature }))).toBe("MACHINE_AUTH_FAILED");
    expect(await code(() => auth.exchange({ machineId, nonce: "1.2", signature }))).toBe("MACHINE_AUTH_FAILED");
    advance(CHALLENGE_TTL_SEC * 1000);
    expect(await code(() => auth.exchange({ machineId, nonce, signature }))).toBe("MACHINE_AUTH_FAILED");
  });

  it("đổi token giới hạn 30 lần mỗi phút cho một máy trên một IP, IP khác không bị chặn theo", async () => {
    const { auth, advance } = setup();
    const signature = "A".repeat(86);
    const attempt = (ip: string) => code(() => auth.exchange({ machineId, nonce: "1.2", signature }, ip));
    for (let i = 0; i < MACHINE_TOKEN_PER_MINUTE; i += 1) expect(await attempt("10.0.0.1")).toBe("MACHINE_AUTH_FAILED");
    expect(await attempt("10.0.0.1")).toBe("MACHINE_TOKEN_RATE_LIMITED");
    // Ai đó biết id máy và xin liên tục từ IP khác không làm máy thật hết lượt.
    expect(await attempt("10.0.0.2")).toBe("MACHINE_AUTH_FAILED");
    advance(60_000);
    expect(await attempt("10.0.0.1")).toBe("MACHINE_AUTH_FAILED");
  });

  it("xin nonce chỉ đếm theo IP", () => {
    const { auth } = setup();
    for (let i = 0; i < MACHINE_TOKEN_IP_PER_MINUTE; i += 1) auth.challenge(machineId, "10.0.0.1");
    expect(() => auth.challenge("0198a1b2-0000-7000-8000-000000000003", "10.0.0.1")).toThrow(
      expect.objectContaining({ code: "MACHINE_TOKEN_RATE_LIMITED" }),
    );
    expect(() => auth.challenge(machineId, "10.0.0.2")).not.toThrow();
  });

  it("nonce kèm URL hub mà máy phải ký", () => {
    expect(setup().auth.challenge(machineId).hub).toBe("https://hub.test");
  });
});

describe("khoá công khai", () => {
  it("nhận khoá Ed25519 32 byte, từ chối chuỗi sai độ dài hay sai ký tự", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const x = publicKey.export({ format: "jwk" }).x as string;
    expect(ed25519Key(x)).not.toBeNull();
    expect(ed25519Key(x.slice(1))).toBeNull();
    expect(ed25519Key(`${x.slice(1)}+`)).toBeNull();
  });

  it("registerKey không có machine token thì từ chối trước khi hỏi database", async () => {
    const { auth } = setup();
    expect(await code(() => auth.registerKey(undefined, { publicKey: "A".repeat(43), keyStorage: "file" }))).toBe(
      "MACHINE_TOKEN_INVALID",
    );
  });
});
