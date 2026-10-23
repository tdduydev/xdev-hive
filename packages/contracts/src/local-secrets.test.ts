import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  isReservedSecretName,
  isValidSecretName,
  normalizeSecretName,
  RESERVED_SECRET_NAMES,
  SECRET_NAME_MAX_LENGTH,
} from "./local-secrets.ts";

// Cùng file mẫu với test Go (worker/internal/secretstore/names_test.go) để hai bên giữ cùng quy tắc tên.
const fixtures = JSON.parse(await readFile(new URL("../fixtures/local-secrets.json", import.meta.url), "utf8")) as {
  reserved: { exact: string[]; prefixes: string[] };
  names: { valid: string[]; invalid: string[]; maxLengthValid: string; normalize: [string, string][] };
};

const usable = (name: string) => isValidSecretName(name) && !isReservedSecretName(name);

describe("tên bí mật tại máy dùng chung với worker Go", () => {
  it("danh sách dành riêng khớp file mẫu", () => {
    expect([...RESERVED_SECRET_NAMES.exact]).toEqual(fixtures.reserved.exact);
    expect([...RESERVED_SECRET_NAMES.prefixes]).toEqual(fixtures.reserved.prefixes);
  });

  it.each(fixtures.names.valid)("%s dùng được", (name) => {
    expect(usable(name)).toBe(true);
  });

  it.each(fixtures.names.invalid)("%j bị từ chối", (name) => {
    expect(usable(name)).toBe(false);
  });

  it("tên dài đúng 64 ký tự dùng được, 65 thì không", () => {
    expect(fixtures.names.maxLengthValid).toHaveLength(SECRET_NAME_MAX_LENGTH);
    expect(usable(fixtures.names.maxLengthValid)).toBe(true);
    expect(usable(`${fixtures.names.maxLengthValid}A`)).toBe(false);
  });

  it.each(fixtures.names.normalize)("chuẩn hoá %j thành %j", (input, want) => {
    expect(normalizeSecretName(input)).toBe(want);
  });

  it("tên dành riêng bị bắt dù viết thường, vì Windows không phân biệt hoa thường", () => {
    expect(isReservedSecretName("path")).toBe(true);
    expect(isReservedSecretName("anthropic_api_key")).toBe(true);
  });

  it("kiểm cú pháp chỉ nhận tên đã chuẩn hoá", () => {
    expect(isValidSecretName("stripe_key")).toBe(false);
    expect(isValidSecretName(normalizeSecretName("stripe_key"))).toBe(true);
  });
});
