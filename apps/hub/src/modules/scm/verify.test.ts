import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deliveryId, verifyGitHubSignature, verifyGitLabToken, verifyWebhook } from "./verify.ts";

const secret = "bi-mat-cua-du-an";
const body = new TextEncoder().encode('{"zen":"Keep it logically awesome."}');
const sign = (s: string, b: Uint8Array) => `sha256=${createHmac("sha256", s).update(b).digest("hex")}`;

describe("GitHub X-Hub-Signature-256", () => {
  it("chữ ký đúng", () => {
    expect(verifyGitHubSignature(secret, body, sign(secret, body))).toBe(true);
  });

  it("ví dụ trong tài liệu GitHub", () => {
    // docs.github.com, "Validating webhook deliveries": secret "It's a Secret to Everybody", payload "Hello, World!".
    expect(
      verifyGitHubSignature(
        "It's a Secret to Everybody",
        new TextEncoder().encode("Hello, World!"),
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      ),
    ).toBe(true);
  });

  it.each([
    ["secret khác", sign("secret-khac", body)],
    ["thân request bị sửa", sign(secret, new TextEncoder().encode('{"zen":"khác"}'))],
    ["thiếu tiền tố sha256=", sign(secret, body).slice(7)],
    ["chữ ký SHA-1 cũ", `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`],
    ["chữ ký cụt", sign(secret, body).slice(0, 20)],
    ["rỗng", ""],
    ["không có header", null],
  ])("từ chối: %s", (_name, header) => {
    expect(verifyGitHubSignature(secret, body, header)).toBe(false);
  });
});

describe("GitLab X-Gitlab-Token", () => {
  it("token đúng", () => {
    expect(verifyGitLabToken(secret, secret)).toBe(true);
  });

  it.each([
    ["token khác", "bi-mat-khac"],
    ["tiền tố của token", secret.slice(0, 5)],
    ["rỗng", ""],
    ["không có header", null],
  ])("từ chối: %s", (_name, header) => {
    expect(verifyGitLabToken(secret, header)).toBe(false);
  });
});

describe("verifyWebhook theo nhà cung cấp", () => {
  it("không nhận header của nhà cung cấp kia", () => {
    const gh = new Headers({ "x-hub-signature-256": sign(secret, body) });
    const gl = new Headers({ "x-gitlab-token": secret });
    expect(verifyWebhook("github", secret, body, gh)).toBe(true);
    expect(verifyWebhook("gitlab", secret, body, gh)).toBe(false);
    expect(verifyWebhook("gitlab", secret, body, gl)).toBe(true);
    expect(verifyWebhook("github", secret, body, gl)).toBe(false);
  });
});

describe("deliveryId", () => {
  it("GitHub lấy X-GitHub-Delivery", () => {
    expect(deliveryId("github", new Headers({ "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958" }))).toBe(
      "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    );
  });

  it("GitLab ưu tiên Idempotency-Key (giữ nguyên khi gửi lại), bản cũ dùng X-Gitlab-Event-UUID", () => {
    const both = new Headers({ "idempotency-key": "k-1", "x-gitlab-event-uuid": "e-1" });
    expect(deliveryId("gitlab", both)).toBe("k-1");
    expect(deliveryId("gitlab", new Headers({ "x-gitlab-event-uuid": "e-1" }))).toBe("e-1");
    expect(deliveryId("gitlab", new Headers())).toBeNull();
  });
});
