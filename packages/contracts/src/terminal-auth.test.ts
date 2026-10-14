import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type ChallengeInput,
  canonicalChallenge,
  canonicalJson,
  challengeBytes,
  deriveInputKey,
  fromBase64url,
  inputMac,
  inputMacPayload,
  pairTag,
  remoteAuth,
  sessionKeyInfo,
  TERM_DENY_MESSAGES,
  termDenyCode,
  toBase64url,
} from "./terminal-auth.ts";

// Vector dùng chung với worker Go (worker/internal/remoteauth): test này kiểm vector đúng theo WebCrypto, test Go kiểm
// worker cho cùng kết quả.
const fixture = JSON.parse(await readFile(new URL("../fixtures/terminal-auth.json", import.meta.url), "utf8")) as {
  hubOrigin: string;
  rpId: string;
  now: number;
  device: { spki: string; credentialId: string; userId: string };
  canonical: { input: Parameters<typeof canonicalJson>[0]; expected: string }[];
  assertions: {
    name: string;
    expect: string;
    request: ChallengeInput;
    canonical: string;
    challenge: string;
    assertion: { credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string };
  }[];
  pairing: {
    secret: string;
    pairId: string;
    userId: string;
    credentialId: string;
    spki: string;
    tag: string;
    wrongUserTag: string;
  };
  ecdh: {
    challenge: string;
    browserPrivate: string;
    ephPub: string;
    workerEphPub: string;
    totpCode: string;
    keys: {
      kind: "passkey" | "totp";
      info: string;
      key: string;
      macs: { input: never; payload: string; mac: string }[];
    }[];
  };
  totp: { secretBase32: string; vectors: { t: number; code: string }[] };
};

const subtle = crypto.subtle;

/** DER ECDSA → r‖s, vì WebCrypto chỉ kiểm dạng r‖s. */
function rawSignature(der: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(64);
  let o = 2;
  for (const half of [0, 32]) {
    const len = der[o + 1] ?? 0;
    const int = der.slice(o + 2, o + 2 + len);
    const trimmed = int.length > 32 ? int.slice(int.length - 32) : int;
    out.set(trimmed, half + 32 - trimmed.length);
    o += 2 + len;
  }
  return out;
}

describe("JSON chuẩn hoá", () => {
  it.each(fixture.canonical)("$expected", ({ input, expected }) => {
    expect(canonicalJson(input)).toBe(expected);
  });

  it("ổn định khi đổi thứ tự khoá và dạng Unicode", () => {
    const a = canonicalJson({ b: [1, { y: "é", x: null }], a: true });
    const b = canonicalJson({ a: true, b: [1, { x: null, y: "é" }] });
    expect(a).toBe(b);
    expect(a).toBe('{"a":true,"b":[1,{"x":null,"y":"é"}]}');
  });

  it("từ chối số thực, khoá không phải ASCII, chuỗi hỏng", () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
    expect(() => canonicalJson({ ă: 1 })).toThrow();
    expect(() => canonicalJson({ a: "\ud800" })).toThrow();
  });
});

describe("assertion trong vector", () => {
  it("có đủ ca đúng và sai", () => {
    const expects = new Set(fixture.assertions.map((a) => a.expect));
    for (const code of ["ok", "AUTH_REPLAY", "AUTH_INVALID", "AUTH_STALE", "ASSERTION_ORIGIN", "ASSERTION_FLAGS"]) {
      expect(expects).toContain(code);
    }
    for (const a of fixture.assertions) if (a.expect !== "ok") expect(termDenyCode.options).toContain(a.expect);
  });

  it.each(fixture.assertions)("$name: challenge khớp yêu cầu", async ({ request, canonical, challenge }) => {
    expect(canonicalChallenge(request)).toBe(canonical);
    expect(toBase64url(await challengeBytes(request))).toBe(challenge);
  });

  it.each(fixture.assertions.filter((a) => a.expect === "ok"))("$name: chữ ký ES256 hợp lệ", async ({ assertion }) => {
    const key = await subtle.importKey(
      "spki",
      fromBase64url(fixture.device.spki),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const authData = fromBase64url(assertion.authenticatorData);
    const clientHash = new Uint8Array(await subtle.digest("SHA-256", fromBase64url(assertion.clientDataJSON)));
    const signed = new Uint8Array(authData.length + 32);
    signed.set(authData);
    signed.set(clientHash, authData.length);
    const ok = await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      rawSignature(fromBase64url(assertion.signature)),
      signed,
    );
    expect(ok).toBe(true);
  });

  it("gói auth của contract nhận assertion và mã TOTP", () => {
    const [a] = fixture.assertions;
    if (!a) throw new Error("thiếu vector");
    const { ephPub, ts, nonce } = a.request;
    expect(remoteAuth.safeParse({ kind: "passkey", assertion: a.assertion, ephPub, ts, nonce }).success).toBe(true);
    expect(remoteAuth.safeParse({ kind: "totp", code: "012345", ephPub, ts, nonce }).success).toBe(true);
    expect(remoteAuth.safeParse({ kind: "totp", code: "12345", ephPub, ts, nonce }).success).toBe(false);
    expect(remoteAuth.safeParse({ kind: "totp", code: "012345", ephPub: "AAAA", ts, nonce }).success).toBe(false);
  });
});

describe("ghép thiết bị", () => {
  it("tag tính lại khớp; đổi người dùng ra tag khác", async () => {
    const { secret, tag, wrongUserTag, ...input } = fixture.pairing;
    expect(await pairTag(fromBase64url(secret), input)).toBe(tag);
    expect(await pairTag(fromBase64url(secret), { ...input, userId: "user-binh" })).toBe(wrongUserTag);
    expect(wrongUserTag).not.toBe(tag);
  });
});

describe("khoá phiên và HMAC gói nhập", () => {
  const { ecdh } = fixture;
  const browserKey = () => {
    const pub = fromBase64url(ecdh.ephPub);
    return subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        d: ecdh.browserPrivate,
        x: toBase64url(pub.slice(1, 33)),
        y: toBase64url(pub.slice(33)),
      },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
  };

  it.each(ecdh.keys)("$kind: HKDF và HMAC khớp vector", async ({ kind, info, key, macs }) => {
    expect(sessionKeyInfo(kind === "totp" ? { kind, code: ecdh.totpCode } : { kind })).toBe(info);
    const k = await deriveInputKey(await browserKey(), ecdh.workerEphPub, fromBase64url(ecdh.challenge), info, true);
    expect(toBase64url(new Uint8Array(await subtle.exportKey("raw", k)))).toBe(key);
    for (const m of macs) {
      expect(inputMacPayload(m.input)).toBe(m.payload);
      expect(await inputMac(k, m.payload)).toBe(m.mac);
    }
  });

  it("khoá passkey và TOTP khác nhau, TOTP phụ thuộc mã", async () => {
    const [p, t] = ecdh.keys;
    expect(p?.key).not.toBe(t?.key);
    const other = await deriveInputKey(
      await browserKey(),
      ecdh.workerEphPub,
      fromBase64url(ecdh.challenge),
      sessionKeyInfo({ kind: "totp", code: "000000" }),
      true,
    );
    expect(toBase64url(new Uint8Array(await subtle.exportKey("raw", other)))).not.toBe(t?.key);
  });

  it("payload phân biệt phím và resize", () => {
    const base = { sessionId: "s", connId: "c", seq: 1 };
    expect(inputMacPayload({ ...base, kind: "in", data: "AA==" })).toBe(
      '{"connId":"c","data":"AA==","kind":"in","seq":1,"sessionId":"s"}',
    );
    expect(inputMacPayload({ ...base, kind: "resize", cols: 80, rows: 24 })).toBe(
      '{"cols":80,"connId":"c","kind":"resize","rows":24,"seq":1,"sessionId":"s"}',
    );
  });
});

describe("TOTP RFC 6238", () => {
  const base32 = (s: string) => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const c of s) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
    return Uint8Array.from(bits.match(/.{8}/g) ?? [], (b) => Number.parseInt(b, 2));
  };

  it.each(fixture.totp.vectors)("t=$t → $code", async ({ t, code }) => {
    const key = await subtle.importKey(
      "raw",
      base32(fixture.totp.secretBase32),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const counter = new Uint8Array(8);
    new DataView(counter.buffer).setBigUint64(0, BigInt(Math.floor(t / 30)));
    const mac = new Uint8Array(await subtle.sign("HMAC", key, counter));
    const off = (mac[19] ?? 0) & 0x0f;
    const bin = new DataView(mac.buffer).getUint32(off) & 0x7fffffff;
    expect(String(bin % 1_000_000).padStart(6, "0")).toBe(code);
  });
});

it("mọi mã từ chối có câu tiếng Việt", () => {
  for (const code of termDenyCode.options) expect(TERM_DENY_MESSAGES[code].length).toBeGreaterThan(10);
});
