import { readFileSync } from "node:fs";
import {
  canonicalChallenge,
  challengeBytes,
  deriveInputKey,
  fromBase64url,
  inputMac,
  inputMacPayload,
  PASSKEY_KEY_INFO,
  toBase64url,
} from "@xdev-hive/contracts/terminal-auth";
import { describe, expect, it } from "vitest";
import { type ControlAttempt, grantKey, InputSigner, newControlAttempt } from "@/lib/terminal/input-mac.ts";

// Cùng vector với contracts và worker Go: khoá và HMAC tính ở web phải khớp từng byte với worker.
const root = new URL("../../../../../", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("packages/contracts/fixtures/terminal-auth.json", root), "utf8")) as {
  ecdh: {
    challenge: string;
    browserPrivate: string;
    ephPub: string;
    workerEphPub: string;
    totpCode: string;
    keys: {
      kind: "passkey" | "totp";
      macs: {
        input:
          | { sessionId: string; connId: string; seq: number; kind: "in"; data: string }
          | { sessionId: string; connId: string; seq: number; kind: "resize"; cols: number; rows: number };
        mac: string;
      }[];
    }[];
  };
};

/** Khoá tạm của trình duyệt trong vector, nạp lại không xuất được như khoá thật. */
async function vectorAttempt(): Promise<ControlAttempt> {
  const { ecdh } = fixture;
  const pub = fromBase64url(ecdh.ephPub);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: ecdh.browserPrivate,
      x: toBase64url(pub.slice(1, 33)),
      y: toBase64url(pub.slice(33, 65)),
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return {
    challenge: { machineId: "", action: "control", params: {} as never, ephPub: ecdh.ephPub, ts: 0, nonce: "" },
    challengeBytes: fromBase64url(ecdh.challenge),
    privateKey,
    ephPub: ecdh.ephPub,
    ts: 0,
    nonce: "",
  };
}

describe("grantKey + InputSigner", () => {
  it.each(fixture.ecdh.keys)("ký đúng như worker với khoá $kind", async ({ kind, macs }) => {
    const attempt = await vectorAttempt();
    const key = await grantKey(attempt, fixture.ecdh.workerEphPub, kind === "totp" ? fixture.ecdh.totpCode : undefined);
    expect(key.extractable).toBe(false);
    const first = macs[0]?.input;
    if (!first) throw new Error("vector thiếu gói");
    const signer = new InputSigner(key, first.sessionId);
    for (const { input, mac } of macs) {
      const frame =
        input.kind === "in"
          ? { t: "in" as const, data: input.data }
          : { t: "resize" as const, cols: input.cols, rows: input.rows };
      expect(await signer.sign(input.connId, frame)).toEqual({ ...frame, seq: input.seq, mac });
    }
  });

  it("giữ thứ tự seq khi ký song song và đổi connId khi nối lại", async () => {
    const attempt = await vectorAttempt();
    const key = await grantKey(attempt, fixture.ecdh.workerEphPub);
    const signer = new InputSigner(key, "s1");
    const frames = await Promise.all([
      signer.sign("conn-a", { t: "in", data: "YQ==" }),
      signer.sign("conn-a", { t: "in", data: "Yg==" }),
      signer.sign("conn-b", { t: "resize", cols: 40, rows: 20 }),
    ]);
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(signer.nextSeq).toBe(4);
    const expected = await inputMac(
      key,
      inputMacPayload({ sessionId: "s1", connId: "conn-b", seq: 3, kind: "resize", cols: 40, rows: 20 }),
    );
    expect(frames[2]?.mac).toBe(expected);
  });
});

describe("newControlAttempt", () => {
  it("tạo khoá tạm không xuất được và challenge khớp JSON chuẩn hoá", async () => {
    const params = { userId: "u1", deviceId: "dev-iphone01", sessionId: "s1", connId: "conn-0001aa" };
    const attempt = await newControlAttempt({ machineId: "m1", params }, () => 1_792_000_000_500);
    expect(attempt.privateKey.extractable).toBe(false);
    expect(attempt.ts).toBe(1_792_000_000);
    expect(attempt.ephPub).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    expect(fromBase64url(attempt.nonce)).toHaveLength(16);
    expect(attempt.challenge).toEqual({
      machineId: "m1",
      action: "control",
      params,
      ephPub: attempt.ephPub,
      ts: attempt.ts,
      nonce: attempt.nonce,
    });
    expect(toBase64url(attempt.challengeBytes)).toBe(toBase64url(await challengeBytes(attempt.challenge)));
    expect(canonicalChallenge(attempt.challenge)).toContain('"action":"control"');
  });

  it("hai phía suy ra cùng khoá: worker giả ký được gói trình duyệt gửi", async () => {
    const params = { userId: "u1", deviceId: "dev-iphone01", sessionId: "s1", connId: "c1" };
    const attempt = await newControlAttempt({ machineId: "m1", params });
    const worker = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const workerPub = toBase64url(new Uint8Array(await crypto.subtle.exportKey("raw", worker.publicKey)));
    const browserKey = await grantKey(attempt, workerPub);
    const workerKey = await deriveInputKey(worker.privateKey, attempt.ephPub, attempt.challengeBytes, PASSKEY_KEY_INFO);
    const signed = await new InputSigner(browserKey, "s1").sign("c1", { t: "in", data: "bHMK" });
    expect(signed.mac).toBe(
      await inputMac(workerKey, inputMacPayload({ sessionId: "s1", connId: "c1", seq: 1, kind: "in", data: "bHMK" })),
    );
  });
});
