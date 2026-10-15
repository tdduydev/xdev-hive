import {
  type ChallengeInput,
  type ControlParams,
  challengeBytes,
  deriveInputKey,
  inputMac,
  inputMacPayload,
  sessionKeyInfo,
  toBase64url,
  type WebCryptoKey,
} from "@xdev-hive/contracts/terminal-auth";

/**
 * Khoá ký gói nhập của quyền gõ từ xa (specs/010 FR-017, plan.md D15). Khoá tạm ECDH và khoá HMAC suy ra đều tạo với
 * `extractable = false` và chỉ nằm trong bộ nhớ trang: không ghi localStorage hay sessionStorage, tải lại trang là mất
 * và phải xác thực lại (mối đe doạ T7). Nối lại trong cùng trang thì dùng tiếp khoá và `seq`, nên không hỏi passkey.
 */

/** Một lần xin quyền: khoá tạm, challenge đã băm và những trường gửi kèm trong `remoteAuth`. */
export interface ControlAttempt {
  challenge: ChallengeInput;
  challengeBytes: Uint8Array<ArrayBuffer>;
  privateKey: WebCryptoKey;
  ephPub: string;
  ts: number;
  nonce: string;
}

export async function newControlAttempt(
  input: { machineId: string; params: ControlParams },
  now: () => number = Date.now,
): Promise<ControlAttempt> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const ephPub = toBase64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const nonce = toBase64url(crypto.getRandomValues(new Uint8Array(16)));
  const ts = Math.floor(now() / 1000);
  const challenge: ChallengeInput = {
    machineId: input.machineId,
    action: "control",
    params: input.params,
    ephPub,
    ts,
    nonce,
  };
  return { challenge, challengeBytes: await challengeBytes(challenge), privateKey: pair.privateKey, ephPub, ts, nonce };
}

/** Khoá HMAC sau khi worker trả `granted`. `code` chỉ có khi xác thực bằng TOTP (trộn vào `info` của HKDF). */
export function grantKey(attempt: ControlAttempt, workerEphPub: string, code?: string): Promise<WebCryptoKey> {
  const info = sessionKeyInfo(code === undefined ? { kind: "passkey" } : { kind: "totp", code });
  return deriveInputKey(attempt.privateKey, workerEphPub, attempt.challengeBytes, info);
}

export type SignedFrame =
  | { t: "in"; seq: number; data: string; mac: string }
  | { t: "resize"; seq: number; cols: number; rows: number; mac: string };

/**
 * Ký gói `in`/`resize` theo thứ tự. Worker bỏ gói có `seq` không tăng, nên `seq` lấy lúc gọi (đồng bộ) và chữ ký trả
 * theo đúng thứ tự gọi dù WebCrypto là bất đồng bộ. `connId` đổi theo kết nối (nối lại), `seq` thì không.
 */
export class InputSigner {
  // Worker bắt đầu từ `last = 0` và đòi `seq > last`.
  private seq = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly key: WebCryptoKey;
  private readonly sessionId: string;

  constructor(key: WebCryptoKey, sessionId: string) {
    this.key = key;
    this.sessionId = sessionId;
  }

  /** `seq` kế tiếp sẽ dùng; test và nối lại cần biết. */
  get nextSeq(): number {
    return this.seq;
  }

  sign(
    connId: string,
    frame: { t: "in"; data: string } | { t: "resize"; cols: number; rows: number },
  ): Promise<SignedFrame> {
    const seq = this.seq++;
    const base = { sessionId: this.sessionId, connId, seq };
    const payload =
      frame.t === "in"
        ? inputMacPayload({ ...base, kind: "in", data: frame.data })
        : inputMacPayload({ ...base, kind: "resize", cols: frame.cols, rows: frame.rows });
    const signed = this.chain.then(async () => ({ ...frame, seq, mac: await inputMac(this.key, payload) }));
    this.chain = signed.catch(() => {});
    return signed;
  }
}
