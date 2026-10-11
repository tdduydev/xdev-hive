import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { GitProviderKind } from "./types.ts";

/** timingSafeEqual đòi hai bên cùng độ dài; băm trước để so được chuỗi khác độ dài mà không lộ độ dài qua thời gian. */
function sameSecret(a: string | Buffer, b: string | Buffer): boolean {
  const h = (v: string | Buffer) => createHash("sha256").update(v).digest();
  return timingSafeEqual(h(a), h(b));
}

/** GitHub: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 của thân request>`. Phải tính trên byte gốc, chưa parse. */
export function verifyGitHubSignature(secret: string, body: Uint8Array, header: string | null | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return sameSecret(Buffer.from(header.toLowerCase()), Buffer.from(expected));
}

/** GitLab không ký thân request mà gửi nguyên secret trong `X-Gitlab-Token`. */
export function verifyGitLabToken(secret: string, header: string | null | undefined): boolean {
  if (!header) return false;
  return sameSecret(header, secret);
}

export function verifyWebhook(
  provider: GitProviderKind,
  secret: string,
  body: Uint8Array,
  headers: Pick<Headers, "get">,
): boolean {
  return provider === "github"
    ? verifyGitHubSignature(secret, body, headers.get("x-hub-signature-256"))
    : verifyGitLabToken(secret, headers.get("x-gitlab-token"));
}

/**
 * Mã giao nhận ổn định qua các lần nhà cung cấp gửi lại, dùng để chống trùng. GitLab 17.4+ có `Idempotency-Key`
 * (bằng `webhook-id` từ 19.0); bản cũ hơn chỉ có `X-Gitlab-Event-UUID`.
 */
export function deliveryId(provider: GitProviderKind, headers: Pick<Headers, "get">): string | null {
  const id =
    provider === "github"
      ? headers.get("x-github-delivery")
      : (headers.get("idempotency-key") ?? headers.get("webhook-id") ?? headers.get("x-gitlab-event-uuid"));
  return id?.trim() ? id.trim().slice(0, 200) : null;
}

export function eventHeader(provider: GitProviderKind, headers: Pick<Headers, "get">): string | null {
  return headers.get(provider === "github" ? "x-github-event" : "x-gitlab-event");
}
