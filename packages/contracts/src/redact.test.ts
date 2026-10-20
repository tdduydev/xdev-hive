import { describe, expect, it } from "vitest";
import { createRedactor, LOG_SECRET_MASK } from "./redact.ts";
import { scanSecrets } from "./secret-scan.ts";

// Chuỗi giả, chỉ có hình dạng giống bí mật thật.
const PASSWORD = "S3cr3t-Hive!2026";
const JENKINS = `11${"a3f9c2e7".repeat(4)}`;
// Ghép lúc chạy để trình quét bí mật của GitHub không chặn push vì chuỗi giả.
const GITLAB = ["glpat", "Zr8Kq2Lm7Np3Vx9WbT4y"].join("-");
const GITHUB = `ghp_${"Ab3dE5gH7j".repeat(3)}`;
const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAv3Xq9k2lTzR8pWfYhN0bVdC7sJ1mQe4uKoLgHiA5tZrMxPyS",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const OPENSSH = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");
const SECRETS = [PASSWORD, JENKINS];
// Phần thân của khoá và mọi bí mật: không chuỗi nào được còn trong log đã che.
const LEAKS = [PASSWORD, JENKINS, GITLAB, GITHUB, "MIIEowIBAAKC", "b3BlbnNzaC1rZXkt"];

const filler = (n: number) => Array.from({ length: n }, (_, i) => `[step ${i}] building module ${i} ok\n`).join("");

const LOG = [
  filler(8),
  `DB_PASSWORD=${PASSWORD}\n`,
  filler(6),
  `curl -u deployer:${JENKINS} https://ci.example.invalid/job/app/build\n`,
  `git clone https://oauth2:${GITLAB}@gitlab.example.invalid/team/app.git\n`,
  `export GITHUB_TOKEN=${GITHUB}\n`,
  filler(3),
  `${PEM}\n`,
  `${OPENSSH}\n`,
  filler(4),
].join("");

const run = (secrets: readonly string[], chunks: readonly string[]) => {
  const r = createRedactor(secrets);
  const parts = chunks.map((c) => r.push(c));
  return { parts, out: parts.join("") + r.flush() };
};

const expectClean = (out: string) => {
  for (const leak of LEAKS) expect(out).not.toContain(leak);
  expect(scanSecrets(out)).toEqual([]);
};

describe("createRedactor", () => {
  const whole = run(SECRETS, [LOG]).out;

  it("che giá trị bí mật của đích và mọi mẫu của secret-scan, giữ chữ xung quanh", () => {
    expectClean(whole);
    expect(whole).toContain(`DB_PASSWORD=${LOG_SECRET_MASK}\n`);
    expect(whole).toContain(`curl -u deployer:${LOG_SECRET_MASK} https://ci.example.invalid/job/app/build\n`);
    expect(whole).toContain(`https://oauth2:${LOG_SECRET_MASK}@gitlab.example.invalid/`);
    expect(whole).toContain(`export GITHUB_TOKEN=${LOG_SECRET_MASK}\n`);
    expect(whole).toContain(`${LOG_SECRET_MASK}\n${LOG_SECRET_MASK}\n[step 0]`);
    expect(whole.startsWith(filler(8))).toBe(true);
  });

  it("bí mật cắt ở mọi vị trí giữa hai đoạn vẫn bị che, kết quả như che một lần", () => {
    for (let i = 0; i <= LOG.length; i++) {
      const { parts, out } = run(SECRETS, [LOG.slice(0, i), LOG.slice(i)]);
      expect(out, `cắt ở ${i}`).toBe(whole);
      for (const part of parts) for (const leak of LEAKS) expect(part).not.toContain(leak);
    }
  });

  it("nhận từng ký tự một vẫn che đủ", () => {
    expect(run(SECRETS, [...LOG]).out).toBe(whole);
  });

  it("không trả phần đang giữ khi chưa che", () => {
    const r = createRedactor([PASSWORD]);
    const first = r.push(`${filler(10)}login ${PASSWORD.slice(0, 6)}`);
    expect(first).not.toContain(PASSWORD.slice(0, 6));
    const rest = r.push(`${PASSWORD.slice(6)} ok\n`) + r.flush();
    expect(first + rest).toBe(`${filler(10)}login ${LOG_SECRET_MASK} ok\n`);
  });

  it("trả ngay phần chắc chắn không còn ghép được, chỉ giữ đuôi", () => {
    const r = createRedactor(SECRETS);
    const text = filler(40);
    const out = r.push(text);
    expect(out.length).toBe(text.length - 200);
    expect(out + r.flush()).toBe(text);
  });

  it("che khi mã ANSI xen giữa tên biến, giá trị và trong bí mật, giữ màu ở ngoài", () => {
    const log = [
      filler(6),
      `\x1b[1;33mDB_PASSWORD=\x1b[0m${PASSWORD}\n`,
      `token \x1b[32m${GITLAB.slice(0, 9)}\x1b[0m${GITLAB.slice(9)}\x1b[0m done\n`,
      `pass ${PASSWORD.slice(0, 5)}\x1b[2m${PASSWORD.slice(5)}\x1b[22m end\n`,
      filler(6),
    ].join("");
    const once = run(SECRETS, [log]).out;
    expectClean(once.replaceAll("\x1b", ""));
    expect(once).toContain(`\x1b[1;33mDB_PASSWORD=\x1b[0m${LOG_SECRET_MASK}\n`);
    expect(once).toContain(`token \x1b[32m${LOG_SECRET_MASK}\x1b[0m done\n`);
    expect(once).toContain(`pass ${LOG_SECRET_MASK}\x1b[22m end\n`);
    for (let i = 0; i <= log.length; i++) {
      expect(run(SECRETS, [log.slice(0, i), log.slice(i)]).out, `cắt ở ${i}`).toBe(once);
    }
  });

  it("bỏ giá trị bí mật rỗng hoặc quá ngắn", () => {
    expect(run(["", "on", "1"], ["mode on, retry 1\n"]).out).toBe("mode on, retry 1\n");
  });

  it("khoá riêng thiếu dòng END quá dài: che phần đầu, bỏ phần sau tới END", () => {
    const r = createRedactor([]);
    const body = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB\n".repeat(400);
    const parts = [r.push("start\n-----BEGIN OPENSSH PRIVATE KEY-----\n")];
    for (let i = 0; i < 5; i++) parts.push(r.push(body));
    parts.push(r.push("-----END OPENSSH PRIVATE KEY-----\nafter\n"), r.flush());
    for (const part of parts) expect(part).not.toContain("b3BlbnNzaC1rZXkt");
    expect(parts.join("")).toBe(`start\n${LOG_SECRET_MASK}\nafter\n`);
  });

  it("khoá riêng chưa có END khi hết log vẫn bị che", () => {
    expect(run([], ["x\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIBkg4LVWM9nuwNSk3yRx"]).out).toBe(
      `x\n${LOG_SECRET_MASK}`,
    );
  });

  it("không cắt giữa cặp surrogate", () => {
    // 601 đơn vị UTF-16, chỗ cắt mặc định (401) rơi đúng giữa một cặp.
    const text = `${"🚀".repeat(300)}.`;
    const r = createRedactor([]);
    const out = r.push(text);
    expect(out.length).toBe(400);
    expect(out + r.flush()).toBe(text);
  });
});
