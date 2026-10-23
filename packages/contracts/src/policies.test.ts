import { describe, expect, it } from "vitest";
import { agentPolicyInput, DEFAULT_AGENT_POLICY, jobPolicy, secretInjection } from "./policies.ts";
import { welcome } from "./worker-protocol.ts";

describe("secretInjection (specs/031 FR-050)", () => {
  it("nhận ba giá trị và từ chối giá trị khác", () => {
    for (const v of ["allow", "approve", "deny"]) expect(secretInjection.parse(v)).toBe(v);
    expect(secretInjection.safeParse("ask").success).toBe(false);
    expect(secretInjection.safeParse("").success).toBe(false);
  });

  it("chính sách lưu trước specs/031 đọc ra allow", () => {
    const { secretInjection: _drop, ...old } = DEFAULT_AGENT_POLICY;
    expect(agentPolicyInput.parse(old).secretInjection).toBe("allow");
  });

  it("mặc định của chính sách là allow và qua được kiểm của chính nó", () => {
    expect(DEFAULT_AGENT_POLICY.secretInjection).toBe("allow");
    expect(agentPolicyInput.parse(DEFAULT_AGENT_POLICY)).toEqual(DEFAULT_AGENT_POLICY);
  });

  it("giữ lựa chọn đã lưu", () => {
    expect(agentPolicyInput.parse({ ...DEFAULT_AGENT_POLICY, secretInjection: "deny" }).secretInjection).toBe("deny");
    expect(agentPolicyInput.safeParse({ ...DEFAULT_AGENT_POLICY, secretInjection: "maybe" }).success).toBe(false);
  });
});

describe("secretInjection trong giao thức worker", () => {
  it("jobPolicy cũ không có trường vẫn hợp lệ", () => {
    expect(jobPolicy.parse({ hooks: [], managedHooksOnly: false })).toEqual({ hooks: [], managedHooksOnly: false });
    expect(jobPolicy.parse({ hooks: [], managedHooksOnly: false, secretInjection: "deny" }).secretInjection).toBe(
      "deny",
    );
  });

  it("welcome.policy nhận secretInjection, thiếu trường vẫn hợp lệ", () => {
    const base = { type: "welcome", v: 1, id: "w", sessionId: "s", heartbeatSec: 30 };
    expect(welcome.parse({ ...base, policy: { totpFallback: true } }).policy).toEqual({ totpFallback: true });
    expect(welcome.parse({ ...base, policy: { totpFallback: true, secretInjection: "approve" } }).policy).toEqual({
      totpFallback: true,
      secretInjection: "approve",
    });
    expect(welcome.safeParse({ ...base, policy: { totpFallback: true, secretInjection: "x" } }).success).toBe(false);
  });
});
