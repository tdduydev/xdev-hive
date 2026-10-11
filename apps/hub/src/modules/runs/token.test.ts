import { describe, expect, it } from "vitest";
import { createRunTokenVerifier, runTokenKey, signRunToken } from "./token.ts";

const secret = "s".repeat(40);
const publicUrl = "https://hive.example.com/";
const input = { runId: "r1", taskId: "t1", orgId: "o1", attempt: 2, ttlSec: 60 };

describe("run token", () => {
  it("ký rồi xác thực lại được, aud là cổng MCP của hub", () => {
    const { token } = signRunToken(runTokenKey(secret), publicUrl, input);
    const claims = createRunTokenVerifier({ authSecret: secret, publicUrl })(token);
    expect(claims).toMatchObject({
      aud: "https://hive.example.com/mcp",
      iss: "https://hive.example.com",
      run_id: "r1",
      task_id: "t1",
      org_id: "o1",
      attempt: 2,
    });
    expect(claims && claims.exp - claims.iat).toBe(60);
  });

  it("từ chối token hết hạn", () => {
    const { token } = signRunToken(runTokenKey(secret), publicUrl, input, Date.now() - 61_000);
    expect(createRunTokenVerifier({ authSecret: secret, publicUrl })(token)).toBeNull();
  });

  it("từ chối token ký bằng secret khác hoặc cho hub khác", () => {
    const { token } = signRunToken(runTokenKey("x".repeat(40)), publicUrl, input);
    expect(createRunTokenVerifier({ authSecret: secret, publicUrl })(token)).toBeNull();
    const other = signRunToken(runTokenKey(secret), "https://khac.example.com", input).token;
    expect(createRunTokenVerifier({ authSecret: secret, publicUrl })(other)).toBeNull();
  });

  it("từ chối token bị sửa nội dung", () => {
    const { token } = signRunToken(runTokenKey(secret), publicUrl, input);
    const [h, p, s] = token.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, run_id: "r2" })).toString("base64url");
    expect(createRunTokenVerifier({ authSecret: secret, publicUrl })(`${h}.${forged}.${s}`)).toBeNull();
    expect(createRunTokenVerifier({ authSecret: secret, publicUrl })("abc")).toBeNull();
  });

  it("khoá run token khác secret gốc", () => {
    expect(runTokenKey(secret).equals(Buffer.from(secret))).toBe(false);
  });
});
