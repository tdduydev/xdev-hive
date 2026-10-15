import { readFileSync } from "node:fs";
import type { RemotePairOptions } from "@xdev-hive/contracts";
import { canonicalChallenge, fromBase64url, toBase64url } from "@xdev-hive/contracts/terminal-auth";
import { describe, expect, it, vi } from "vitest";
import {
  createPasskey,
  creationOptions,
  getAssertion,
  PasskeyError,
  pairedDevices,
  pairProof,
  pairSecretBytes,
  passkeySupport,
  readPairLink,
  rememberDevice,
  scrubPairSecret,
  stashPairSecret,
  suggestDeviceLabel,
} from "@/lib/terminal/webauthn.ts";

// Cùng vector với contracts và worker Go: tag và challenge tính ở web phải khớp từng byte với bên kiểm.
const root = new URL("../../../../../", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("packages/contracts/fixtures/terminal-auth.json", root), "utf8")) as {
  rpId: string;
  pairing: {
    secret: string;
    pairId: string;
    userId: string;
    credentialId: string;
    spki: string;
    tag: string;
    wrongUserTag: string;
  };
  assertions: {
    name: string;
    request: Parameters<typeof canonicalChallenge>[0];
    canonical: string;
    challenge: string;
    assertion: Record<string, string>;
  }[];
};

class MemoryStorage {
  data = new Map<string, string>();
  getItem = (key: string) => this.data.get(key) ?? null;
  setItem = (key: string, value: string) => void this.data.set(key, value);
  removeItem = (key: string) => void this.data.delete(key);
}

const buffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer;

/** authenticatorData tối thiểu: 32 byte rpIdHash, 1 byte cờ, 4 byte bộ đếm. */
function authData(flags: number): ArrayBuffer {
  const bytes = new Uint8Array(37);
  bytes[32] = flags;
  return bytes.buffer;
}

const pairOptions: RemotePairOptions["publicKey"] = {
  rp: { id: "hive.example.com", name: "xDev Hive" },
  user: { id: toBase64url(new TextEncoder().encode("user-an")), name: "an@example.com", displayName: "An" },
  challenge: toBase64url(new Uint8Array(32).fill(7)),
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  timeout: 60_000,
  authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
  attestation: "none",
  excludeCredentials: [{ type: "public-key", id: fixture.pairing.credentialId }],
};

function attestation(over: { flags?: number; spki?: ArrayBuffer | null; alg?: number } = {}) {
  return {
    rawId: buffer(fromBase64url(fixture.pairing.credentialId)),
    response: {
      getPublicKey: () => (over.spki === undefined ? buffer(fromBase64url(fixture.pairing.spki)) : over.spki),
      getPublicKeyAlgorithm: () => over.alg ?? -7,
      getAuthenticatorData: () => authData(over.flags ?? 0x45),
    },
  };
}

const credentialsReturning = (value: unknown) => ({
  create: vi.fn(async () => value as Credential),
  get: vi.fn(async () => value as Credential),
});

describe("link ghép", () => {
  const href = `https://hive.example.com/remote/pair?m=may-cua-an&p=${fixture.pairing.pairId}#s=${fixture.pairing.secret}`;

  it("đọc tên máy, pairId và bí mật từ fragment", () => {
    expect(readPairLink(href)).toEqual({
      machine: "may-cua-an",
      pairId: fixture.pairing.pairId,
      secret: fixture.pairing.secret,
    });
  });

  it("bí mật thiếu, sai base64url hoặc quá ngắn thì coi như không có", () => {
    expect(readPairLink(href.split("#")[0] ?? "").secret).toBeNull();
    expect(readPairLink(`${href.split("#")[0]}#s=abc`).secret).toBeNull();
    expect(readPairLink(`${href.split("#")[0]}#s=${"%2B".repeat(30)}`).secret).toBeNull();
    expect(pairSecretBytes(fixture.pairing.secret)?.length).toBe(16);
    expect(pairSecretBytes("abc")).toBeNull();
  });

  it("chưa đăng nhập: cất bí mật vào sessionStorage, đường dẫn quay lại không còn fragment", () => {
    const storage = new MemoryStorage();
    const back = stashPairSecret(href, storage);
    expect(back).toBe(`/remote/pair?m=may-cua-an&p=${fixture.pairing.pairId}`);
    expect(back).not.toContain(fixture.pairing.secret);
    // Sau đăng nhập URL không còn fragment, trang lấy lại bí mật đã cất.
    expect(readPairLink(back, storage).secret).toBe(fixture.pairing.secret);
    // Trang khác không bị đụng tới.
    expect(stashPairSecret("/tasks#x", storage)).toBe("/tasks#x");
  });

  it("xoá bí mật khỏi thanh địa chỉ và sessionStorage, giữ history.state của router", () => {
    const storage = new MemoryStorage();
    storage.setItem(`hive.pair.${fixture.pairing.pairId}`, fixture.pairing.secret);
    const state = { __TSR_index: 3 };
    const replaceState = vi.fn();
    scrubPairSecret(fixture.pairing.pairId, { location: { href }, history: { state, replaceState } }, storage);
    expect(replaceState).toHaveBeenCalledWith(state, "", `/remote/pair?m=may-cua-an&p=${fixture.pairing.pairId}`);
    expect(storage.data.size).toBe(0);
  });
});

describe("passkeySupport", () => {
  it("HTTP không phải secure context thì báo cần HTTPS trước khi xét WebAuthn", () => {
    expect(passkeySupport({ isSecureContext: false, PublicKeyCredential: {}, navigator: { credentials: {} } })).toBe(
      "insecure",
    );
    expect(passkeySupport({ isSecureContext: true, navigator: {} })).toBe("unsupported");
    expect(passkeySupport({ isSecureContext: true, PublicKeyCredential: {}, navigator: { credentials: {} } })).toBe(
      "ok",
    );
  });
});

describe("tạo passkey khi ghép", () => {
  it("đổi tuỳ chọn base64url thành byte và luôn bắt buộc UV", () => {
    const options = creationOptions({
      ...pairOptions,
      authenticatorSelection: { ...pairOptions.authenticatorSelection, userVerification: "preferred" as "required" },
    });
    expect(options.authenticatorSelection?.userVerification).toBe("required");
    expect(new TextDecoder().decode(options.user.id as Uint8Array)).toBe("user-an");
    expect(options.attestation).toBe("none");
    expect(toBase64url(options.excludeCredentials?.[0]?.id as Uint8Array)).toBe(fixture.pairing.credentialId);
  });

  it("trả credentialId, SPKI từ getPublicKey() và cờ đồng bộ", async () => {
    const credentials = credentialsReturning(attestation({ flags: 0x45 | 0x08 }));
    const passkey = await createPasskey(pairOptions, credentials);
    expect(passkey).toEqual({
      credentialId: fixture.pairing.credentialId,
      spki: fixture.pairing.spki,
      synced: true,
    });
    expect(credentials.create).toHaveBeenCalledOnce();
  });

  it("passkey tạo không có UV bị từ chối vì worker sẽ không nhận assertion của nó", async () => {
    await expect(createPasskey(pairOptions, credentialsReturning(attestation({ flags: 0x41 })))).rejects.toMatchObject({
      code: "no_user_verification",
    });
  });

  it("thiếu khoá công khai hoặc sai thuật toán thì báo rõ", async () => {
    await expect(createPasskey(pairOptions, credentialsReturning(attestation({ spki: null })))).rejects.toMatchObject({
      code: "no_public_key",
    });
    await expect(createPasskey(pairOptions, credentialsReturning(attestation({ alg: -257 })))).rejects.toMatchObject({
      code: "wrong_algorithm",
    });
  });

  it("người dùng huỷ (NotAllowedError) thành PasskeyError cancelled", async () => {
    const error = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const credentials = { create: vi.fn().mockRejectedValue(error), get: vi.fn() };
    const failure = await createPasskey(pairOptions, credentials).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PasskeyError);
    expect(failure).toMatchObject({ code: "cancelled" });
  });

  it("tag ghép khớp vector của contracts và worker", async () => {
    const secret = pairSecretBytes(fixture.pairing.secret);
    if (!secret) throw new Error("vector bí mật sai");
    const proof = await pairProof({
      secret,
      pairId: fixture.pairing.pairId,
      userId: fixture.pairing.userId,
      passkey: { credentialId: fixture.pairing.credentialId, spki: fixture.pairing.spki, synced: false },
    });
    expect(proof.tag).toBe(fixture.pairing.tag);
    expect(proof.tag).toHaveLength(43);
    const other = await pairProof({
      secret,
      pairId: fixture.pairing.pairId,
      userId: "user-khac",
      passkey: { credentialId: fixture.pairing.credentialId, spki: fixture.pairing.spki, synced: false },
    });
    expect(other.tag).not.toBe(fixture.pairing.tag);
  });
});

describe("assertion với challenge chuẩn hoá", () => {
  for (const name of ["ok_start", "ok_control"]) {
    it(`${name}: challenge gửi trình duyệt khớp vector, kết quả mã hoá base64url`, async () => {
      const vector = fixture.assertions.find((a) => a.name === name);
      if (!vector) throw new Error(`thiếu vector ${name}`);
      expect(canonicalChallenge(vector.request)).toBe(vector.canonical);
      const a = vector.assertion as Record<
        "credentialId" | "authenticatorData" | "clientDataJSON" | "signature",
        string
      >;
      const credentials = credentialsReturning({
        rawId: buffer(fromBase64url(a.credentialId)),
        response: {
          authenticatorData: buffer(fromBase64url(a.authenticatorData)),
          clientDataJSON: buffer(fromBase64url(a.clientDataJSON)),
          signature: buffer(fromBase64url(a.signature)),
          userHandle: null,
        },
      });
      const result = await getAssertion(
        { challenge: vector.request, rpId: fixture.rpId, credentialIds: [a.credentialId] },
        credentials,
      );
      expect(result).toEqual({
        credentialId: a.credentialId,
        authenticatorData: a.authenticatorData,
        clientDataJSON: a.clientDataJSON,
        signature: a.signature,
      });
      const options = credentials.get.mock.calls[0] as unknown as [CredentialRequestOptions];
      const publicKey = options[0].publicKey;
      expect(toBase64url(publicKey?.challenge as Uint8Array)).toBe(vector.challenge);
      expect(publicKey?.userVerification).toBe("required");
      expect(publicKey?.rpId).toBe(fixture.rpId);
      expect(toBase64url(publicKey?.allowCredentials?.[0]?.id as Uint8Array)).toBe(a.credentialId);
    });
  }
});

describe("thiết bị này", () => {
  it("nhớ và quên thiết bị đã ghép theo máy, bỏ qua dữ liệu hỏng", () => {
    const storage = new MemoryStorage();
    expect(pairedDevices(storage)).toEqual({});
    rememberDevice("m1", { deviceId: "d1", credentialId: "c1" }, storage);
    rememberDevice("m2", { deviceId: "d2", credentialId: "c2" }, storage);
    rememberDevice("m1", null, storage);
    expect(pairedDevices(storage)).toEqual({ m2: { deviceId: "d2", credentialId: "c2" } });
    storage.setItem("hive.remote.devices", "{không phải json");
    expect(pairedDevices(storage)).toEqual({});
  });

  it("gợi ý tên theo thiết bị", () => {
    expect(suggestDeviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(suggestDeviceLabel("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari")).toBe("Điện thoại Android");
    expect(suggestDeviceLabel("curl/8")).toBe("Trình duyệt");
  });
});
