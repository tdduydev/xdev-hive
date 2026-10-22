import { TOTP_DEVICE_ID } from "@xdev-hive/contracts/terminal-auth";
import { afterEach, describe, expect, it } from "vitest";
import {
  isTotpCode,
  lockMinutesLeft,
  markTotpUsed,
  remoteAuthMethod,
  requestRemoteAuth,
  resetTotpUsed,
  totpWaitSec,
} from "./totp-auth.ts";

const machine = (over: { totpAllowed?: boolean; totp?: boolean } = {}): Parameters<typeof remoteAuthMethod>[0] => ({
  id: "m1",
  totpAllowed: over.totpAllowed ?? true,
  remote: {
    enabled: true,
    roots: [],
    clis: [],
    accounts: [],
    totp: { enabled: over.totp ?? true, locked: false, lockedUntil: null },
    confirmOnMachine: false,
    updatedAt: "2026-10-15T00:00:00.000Z",
  },
});
const https = { isSecureContext: true, PublicKeyCredential: {}, navigator: { credentials: {} } };
const http = { isSecureContext: false, navigator: {} };
const device = { deviceId: "dev-1", credentialId: "Y3JlZA" };

afterEach(() => resetTotpUsed());

describe("remoteAuthMethod", () => {
  it("HTTPS dùng passkey của thiết bị đã ghép, không bao giờ hỏi mã", () => {
    expect(remoteAuthMethod(machine(), https, { m1: device })).toEqual({ kind: "passkey", device });
    expect(remoteAuthMethod(machine(), https, {})).toEqual({ kind: "blocked", reason: "unpaired" });
    expect(remoteAuthMethod(machine(), { isSecureContext: true, navigator: {} }, {})).toMatchObject({
      reason: "unsupported",
    });
  });

  it("HTTP dùng mã khi tổ chức cho và máy đã bật TOTP", () => {
    expect(remoteAuthMethod(machine(), http, { m1: device })).toEqual({ kind: "totp" });
    expect(remoteAuthMethod(machine({ totpAllowed: false }), http, {})).toMatchObject({ reason: "totp_not_allowed" });
    expect(remoteAuthMethod(machine({ totp: false }), http, {})).toMatchObject({ reason: "totp_off" });
  });
});

describe("requestRemoteAuth", () => {
  it("TOTP: gửi mã, không gửi deviceId, challenge dùng TOTP_DEVICE_ID", async () => {
    const r = await requestRemoteAuth({
      method: { kind: "totp" },
      machineId: "m1",
      action: "control",
      params: { userId: "u1", sessionId: "s1", connId: "c1" },
      code: "123456",
    });
    expect(r.auth).toMatchObject({ kind: "totp", code: "123456", ephPub: r.attempt.ephPub, nonce: r.attempt.nonce });
    expect(r.deviceId).toBeUndefined();
    expect(r.code).toBe("123456");
    expect(r.attempt.challenge.params).toMatchObject({ deviceId: TOTP_DEVICE_ID, connId: "c1" });
  });

  it("mã không đủ 6 số bị chặn trước khi gửi", async () => {
    await expect(
      requestRemoteAuth({
        method: { kind: "totp" },
        machineId: "m1",
        action: "start",
        params: { userId: "u1", cli: "claude", rootId: "r1", cols: 80, rows: 24 },
        code: "12345",
      }),
    ).rejects.toThrow("6 chữ số");
    expect(isTotpCode("123456")).toBe(true);
    expect(isTotpCode("12a456")).toBe(false);
  });
});

describe("mã vừa dùng và khoá", () => {
  it("chờ tới bước 30 giây kế tiếp", () => {
    const t = 1_800_000_010_000; // 10 giây sau đầu một bước
    expect(totpWaitSec(t)).toBe(0);
    markTotpUsed(t);
    expect(totpWaitSec(t)).toBe(20);
    expect(totpWaitSec(t + 19_500)).toBe(1);
    expect(totpWaitSec(t + 20_000)).toBe(0);
  });

  it("phút còn khoá làm tròn lên", () => {
    const now = Date.parse("2026-10-15T00:00:00.000Z");
    expect(lockMinutesLeft("2026-10-15T00:04:10.000Z", now)).toBe(5);
    expect(lockMinutesLeft("2026-10-14T23:59:00.000Z", now)).toBeNull();
    expect(lockMinutesLeft(null, now)).toBeNull();
  });
});
