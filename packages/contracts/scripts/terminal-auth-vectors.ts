/**
 * Sinh `fixtures/terminal-auth.json`: vector xác thực điều khiển từ xa dùng chung cho test TypeScript và Go
 * (`worker/internal/remoteauth`). Mọi khoá, chữ ký, HMAC đều tạo bằng WebCrypto như trình duyệt làm, nên Go kiểm đúng thứ
 * trình duyệt thật gửi. Khoá sinh ngẫu nhiên mỗi lần chạy: chạy lại thì commit cả file mới.
 *
 *   node scripts/terminal-auth-vectors.ts
 */
import { writeFile } from "node:fs/promises";
import {
  type ChallengeInput,
  canonicalJson,
  challengeBytes,
  deriveInputKey,
  inputMac,
  inputMacPayload,
  PASSKEY_KEY_INFO,
  pairTag,
  sessionKeyInfo,
  toBase64url,
  type WebCryptoKey,
} from "../src/terminal-auth.ts";

const subtle = crypto.subtle;
const enc = new TextEncoder();
const hubOrigin = "https://hive.example.com";
const rpId = "hive.example.com";
const machineId = "may-cua-an";
const now = 1_792_000_000;
const userId = "user-an";
const deviceId = "dev-iphone01";
const storedSignCount = 5;

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const sha256 = async (b: Uint8Array<ArrayBuffer>) => new Uint8Array(await subtle.digest("SHA-256", b));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** WebCrypto ký ECDSA ra r‖s 64 byte; WebAuthn trả DER, nên đổi để vector giống trình duyệt thật. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if ((v[0] ?? 0) & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

const ecdsa = { name: "ECDSA", namedCurve: "P-256" } as const;
const deviceKey = await subtle.generateKey(ecdsa, true, ["sign", "verify"]);
const strangerKey = await subtle.generateKey(ecdsa, true, ["sign", "verify"]);
const credentialId = toBase64url(random(32));
const spki = toBase64url(new Uint8Array(await subtle.exportKey("spki", deviceKey.publicKey)));

interface AssertionOpts {
  origin?: string;
  rpId?: string;
  flags?: number;
  signCount?: number;
  type?: string;
  crossOrigin?: boolean;
  key?: WebCryptoKey;
  credentialId?: string;
}

async function assertion(challenge: Uint8Array, o: AssertionOpts = {}) {
  const authData = new Uint8Array(37);
  authData.set(await sha256(enc.encode(o.rpId ?? rpId)), 0);
  authData[32] = o.flags ?? 0x05; // UP | UV
  new DataView(authData.buffer).setUint32(33, o.signCount ?? storedSignCount + 1);
  const clientData = enc.encode(
    JSON.stringify({
      type: o.type ?? "webauthn.get",
      challenge: toBase64url(challenge),
      origin: o.origin ?? hubOrigin,
      crossOrigin: o.crossOrigin ?? false,
    }),
  );
  const signed = concat(authData, await sha256(clientData));
  const raw = new Uint8Array(
    await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, o.key ?? deviceKey.privateKey, signed),
  );
  return {
    credentialId: o.credentialId ?? credentialId,
    authenticatorData: toBase64url(authData),
    clientDataJSON: toBase64url(clientData),
    signature: toBase64url(derSignature(raw)),
  };
}

const browserEph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const workerEph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const ephPub = toBase64url(new Uint8Array(await subtle.exportKey("raw", browserEph.publicKey)));
const workerEphPub = toBase64url(new Uint8Array(await subtle.exportKey("raw", workerEph.publicKey)));
const workerJwk = await subtle.exportKey("jwk", workerEph.privateKey);
const browserJwk = await subtle.exportKey("jwk", browserEph.privateKey);

const control = (connId = "conn-0001aa") =>
  ({ userId, deviceId, sessionId: "5b0f8c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e", connId }) as const;
const start = {
  userId,
  deviceId,
  cli: "claude",
  rootId: "root-code01",
  subdir: "apps/web",
  prompt: "Sửa lỗi đăng nhập\n“ngoặc” và   dòng",
  cols: 44,
  rows: 30,
};

interface Case {
  name: string;
  expect: string;
  replayOf?: string;
  challenge: ChallengeInput;
  /** Khi hub sửa yêu cầu sau khi trình duyệt ký: worker tính challenge từ `challenge` (đã sửa) nhưng chữ ký là bản cũ. */
  signedOver?: ChallengeInput;
  opts?: AssertionOpts;
}

const nonce = () => toBase64url(random(16));
const base = (action: "start" | "control", params: ChallengeInput["params"], ts = now - 10): ChallengeInput => ({
  machineId,
  action,
  params,
  ephPub,
  ts,
  nonce: nonce(),
});

const okControl = base("control", control());
const tampered = base("control", control());
const cases: Case[] = [
  { name: "ok_control", expect: "ok", challenge: okControl },
  { name: "ok_start", expect: "ok", challenge: base("start", start), opts: { signCount: storedSignCount + 2 } },
  { name: "replay", expect: "AUTH_REPLAY", replayOf: "ok_control", challenge: okControl },
  {
    name: "hub_changed_conn",
    expect: "AUTH_INVALID",
    challenge: { ...tampered, params: control("conn-evil01") },
    signedOver: tampered,
  },
  {
    name: "wrong_origin",
    expect: "ASSERTION_ORIGIN",
    challenge: base("control", control()),
    opts: { origin: "https://evil.example.com" },
  },
  {
    name: "cross_origin",
    expect: "ASSERTION_ORIGIN",
    challenge: base("control", control()),
    opts: { crossOrigin: true },
  },
  {
    name: "wrong_rp_id",
    expect: "ASSERTION_RP_ID",
    challenge: base("control", control()),
    opts: { rpId: "evil.example.com" },
  },
  { name: "no_uv", expect: "ASSERTION_FLAGS", challenge: base("control", control()), opts: { flags: 0x01 } },
  { name: "no_up", expect: "ASSERTION_FLAGS", challenge: base("control", control()), opts: { flags: 0x04 } },
  {
    name: "wrong_type",
    expect: "AUTH_INVALID",
    challenge: base("control", control()),
    opts: { type: "webauthn.create" },
  },
  {
    name: "bad_signature",
    expect: "ASSERTION_SIGNATURE",
    challenge: base("control", control()),
    opts: { key: strangerKey.privateKey },
  },
  {
    name: "counter_regress",
    expect: "ASSERTION_COUNTER",
    challenge: base("control", control()),
    opts: { signCount: storedSignCount },
  },
  { name: "stale", expect: "AUTH_STALE", challenge: base("control", control(), now - 300) },
  { name: "future", expect: "AUTH_STALE", challenge: base("control", control(), now + 300) },
  {
    name: "unknown_device",
    expect: "DEVICE_UNKNOWN",
    challenge: base("control", control()),
    opts: { credentialId: toBase64url(random(32)) },
  },
  {
    name: "other_user",
    expect: "DEVICE_USER_MISMATCH",
    challenge: base("control", { ...control(), userId: "user-binh" }),
  },
];

const assertions = [];
for (const c of cases) {
  const signed = await challengeBytes(c.signedOver ?? c.challenge);
  assertions.push({
    name: c.name,
    expect: c.expect,
    ...(c.replayOf ? { replayOf: c.replayOf } : {}),
    request: c.challenge,
    canonical: canonicalJson({ ...c.challenge, params: { ...c.challenge.params } }),
    challenge: toBase64url(await challengeBytes(c.challenge)),
    assertion: await assertion(signed, c.opts),
  });
}

// Ghép: bí mật 128 bit trong fragment URL; tag sai khi đổi bất kỳ trường nào.
const pairSecret = random(16);
const pairInput = { pairId: "pair-0a1b2c3d", userId, credentialId, spki };
const pairing = {
  secret: toBase64url(pairSecret),
  ...pairInput,
  tag: await pairTag(pairSecret, pairInput),
  wrongUserTag: await pairTag(pairSecret, { ...pairInput, userId: "user-binh" }),
};

// Khoá phiên và HMAC gói nhập, cho cả passkey và TOTP (TOTP trộn mã vào info).
const challenge = await challengeBytes(okControl);
const totpCode = "287082";
const keys = [];
for (const auth of [{ kind: "passkey" as const }, { kind: "totp" as const, code: totpCode }]) {
  const info = sessionKeyInfo(auth);
  const key = await deriveInputKey(browserEph.privateKey, workerEphPub, challenge, info, true);
  const macs = [];
  for (const p of [
    { sessionId: control().sessionId, connId: control().connId, seq: 1, kind: "in" as const, data: "bHMK" },
    { sessionId: control().sessionId, connId: control().connId, seq: 2, kind: "resize" as const, cols: 44, rows: 30 },
  ]) {
    const payload = inputMacPayload(p);
    macs.push({ input: p, payload, mac: await inputMac(key, payload) });
  }
  keys.push({
    kind: auth.kind,
    info,
    key: toBase64url(new Uint8Array(await subtle.exportKey("raw", key))),
    macs,
  });
}

const fixture = {
  $comment: "Sinh bằng packages/contracts/scripts/terminal-auth-vectors.ts. Không sửa tay.",
  hubOrigin,
  rpId,
  machineId,
  now,
  device: { deviceId, userId, credentialId, spki, signCount: storedSignCount },
  canonical: [
    {
      input: { b: 1, a: "x", c: [true, null, { z: "", y: -2 }] },
      expected: '{"a":"x","b":1,"c":[true,null,{"y":-2,"z":""}]}',
    },
    { input: { s: "é ạ" }, expected: '{"s":"é ạ"}' },
    {
      input: { s: '"\\/\b\f\n\r\t\u0001\u001f\u007f  <>&😀' },
      expected: canonicalJson({ s: '"\\/\b\f\n\r\t\u0001\u001f\u007f  <>&😀' }),
    },
    { input: { skip: undefined, k: 0 }, expected: '{"k":0}' },
  ],
  assertions,
  pairing,
  ecdh: {
    challenge: toBase64url(challenge),
    browserPrivate: browserJwk.d,
    ephPub,
    workerPrivate: workerJwk.d,
    workerEphPub,
    passkeyInfo: PASSKEY_KEY_INFO,
    totpCode,
    keys,
  },
  totp: {
    // RFC 6238 Phụ lục B, SHA-1, khoá ASCII "12345678901234567890"; mã 8 số của RFC cắt còn 6 số cuối.
    secretBase32: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    vectors: [
      { t: 59, code: "287082" },
      { t: 1111111109, code: "081804" },
      { t: 1111111111, code: "050471" },
      { t: 1234567890, code: "005924" },
      { t: 2000000000, code: "279037" },
      { t: 20000000000, code: "353130" },
    ],
  },
};

await writeFile(new URL("../fixtures/terminal-auth.json", import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Đã ghi ${assertions.length} assertion vào fixtures/terminal-auth.json`);
