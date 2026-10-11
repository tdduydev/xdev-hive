import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, parseMasterKey, SecretDecryptError } from "./secrets.ts";

const master = parseMasterKey(randomBytes(32).toString("base64"));

describe("parseMasterKey", () => {
  it("từ chối khoá không đủ 32 byte", () => {
    expect(() => parseMasterKey(randomBytes(16).toString("base64"))).toThrow(/32 byte/);
  });

  it("cùng khoá thì cùng id", () => {
    const b64 = randomBytes(32).toString("base64");
    expect(parseMasterKey(b64).id).toBe(parseMasterKey(` ${b64}\n`).id);
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("giải mã lại đúng chuỗi ban đầu, kể cả Unicode và PEM nhiều dòng", () => {
    for (const s of ["", "ghp_abc", "Tiếng Việt có dấu", "-----BEGIN KEY-----\nabc\n-----END KEY-----\n"]) {
      expect(decryptSecret(master, encryptSecret(master, s, "ctx"), "ctx")).toBe(s);
    }
  });

  it("mỗi lần mã hoá ra bản mã khác (DEK và IV ngẫu nhiên)", () => {
    const a = encryptSecret(master, "x", "ctx");
    const b = encryptSecret(master, "x", "ctx");
    expect(a).not.toBe(b);
    expect(a.split(".")[2]).not.toBe(b.split(".")[2]);
  });

  it("bản mã không chứa chuỗi gốc", () => {
    expect(encryptSecret(master, "token-bi-mat", "ctx")).not.toContain("token-bi-mat");
  });

  it("sai ngữ cảnh thì không giải mã được", () => {
    const sealed = encryptSecret(master, "x", "scm_connections:a");
    expect(() => decryptSecret(master, sealed, "scm_connections:b")).toThrow(SecretDecryptError);
  });

  it("sửa một byte của bản mã thì không giải mã được", () => {
    const parts = encryptSecret(master, "x", "ctx").split(".");
    const data = Buffer.from(parts[3] ?? "", "base64url");
    data[13] = (data[13] ?? 0) ^ 1;
    parts[3] = data.toString("base64url");
    expect(() => decryptSecret(master, parts.join("."), "ctx")).toThrow(SecretDecryptError);
  });

  it("khoá chủ khác thì báo rõ, không trả rác", () => {
    const other = parseMasterKey(randomBytes(32).toString("base64"));
    expect(() => decryptSecret(other, encryptSecret(master, "x", "ctx"), "ctx")).toThrow(/khoá chủ khác/);
  });

  it("từ chối định dạng lạ", () => {
    expect(() => decryptSecret(master, "abc", "ctx")).toThrow(/định dạng/);
  });
});
