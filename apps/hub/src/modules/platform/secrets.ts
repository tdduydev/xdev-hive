import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Mã hoá secret kiểu envelope (docs/architecture.md mục 6): mỗi bản ghi có một khoá dữ liệu (DEK) ngẫu nhiên,
 * DEK được bọc bằng khoá chủ của hub. Đổi khoá chủ sau này chỉ cần bọc lại DEK, không phải giải mã từng secret,
 * và lộ một DEK không lộ secret khác.
 */
export interface MasterKey {
  readonly key: Buffer;
  /** Dấu vân tay ngắn của khoá chủ, ghi vào bản mã để báo lỗi rõ khi hub chạy với khoá chủ khác. */
  readonly id: string;
}

const VERSION = "v1";
const ALG = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretDecryptError extends Error {
  override readonly name = "SecretDecryptError";
}

/** Đọc khoá chủ từ chuỗi base64 (HIVE_MASTER_KEY). Bắt buộc đúng 32 byte vì AES-256. */
export function parseMasterKey(base64: string): MasterKey {
  const key = Buffer.from(base64.trim(), "base64");
  if (key.length !== 32) {
    throw new Error("HIVE_MASTER_KEY phải là 32 byte mã hoá base64 (tạo bằng: openssl rand -base64 32).");
  }
  return { key, id: createHash("sha256").update(key).digest("hex").slice(0, 8) };
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

function open(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new SecretDecryptError("Bản mã secret bị cắt cụt.");
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch (cause) {
    throw new SecretDecryptError("Không giải mã được secret: dữ liệu bị sửa hoặc sai ngữ cảnh.", { cause });
  }
}

/**
 * Mã hoá `plaintext`. `context` (ví dụ `scm_connections:<id>`) được buộc vào bản mã qua AAD, nên chép bản mã của
 * dòng này sang dòng khác sẽ không giải mã được: kẻ ghi được database không đổi secret giữa các bản ghi.
 * Kết quả: `v1.<keyId>.<DEK đã bọc>.<dữ liệu>`, phần sau là base64url.
 */
export function encryptSecret(master: MasterKey, plaintext: string, context: string): string {
  const dek = randomBytes(32);
  const aad = Buffer.from(context, "utf8");
  const wrapped = seal(master.key, dek, aad);
  const data = seal(dek, Buffer.from(plaintext, "utf8"), aad);
  dek.fill(0);
  return [VERSION, master.id, wrapped.toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptSecret(master: MasterKey, envelope: string, context: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretDecryptError("Bản mã secret sai định dạng.");
  const [, keyId, wrapped, data] = parts as [string, string, string, string];
  if (keyId !== master.id) {
    throw new SecretDecryptError(
      `Secret được mã hoá bằng khoá chủ khác (${keyId}); kiểm lại HIVE_MASTER_KEY của hub (đang là ${master.id}).`,
    );
  }
  const aad = Buffer.from(context, "utf8");
  const dek = open(master.key, Buffer.from(wrapped, "base64url"), aad);
  try {
    return open(dek, Buffer.from(data, "base64url"), aad).toString("utf8");
  } finally {
    dek.fill(0);
  }
}
