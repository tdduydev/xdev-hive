import { describe, expect, it } from "vitest";
import { agentPolicyInput, DEFAULT_AGENT_POLICY } from "./policies.ts";
import { outcomeCheck, projectSettingsPatch } from "./projects.ts";
import { PROTOCOL_VERSION, workerToHub } from "./worker-protocol.ts";

describe("Antigravity", () => {
  it("máy khai antigravity trong hello", () => {
    const msg = workerToHub.parse({
      type: "hello",
      v: PROTOCOL_VERSION,
      id: "m1",
      machineId: "dev-01",
      version: "0.2.0",
      protoRange: [1, 1],
      os: "darwin",
      clis: ["claude", "antigravity"],
      capacity: 1,
    });
    expect(msg.type === "hello" && msg.clis).toEqual(["claude", "antigravity"]);
  });

  it("chính sách lưu trước khi có Antigravity vẫn đọc được", () => {
    const { antigravity: _, ...old } = DEFAULT_AGENT_POLICY.allowedModels;
    const parsed = agentPolicyInput.parse({ ...DEFAULT_AGENT_POLICY, allowedModels: old });
    expect(parsed.allowedModels.antigravity).toEqual([]);
  });

  it("dự án đặt model cho Antigravity", () => {
    const patch = projectSettingsPatch.parse({ models: { antigravity: { code: "gemini-3.8-flash-high" } } });
    expect(patch.models?.antigravity?.code).toBe("gemini-3.8-flash-high");
  });

  it("review chéo không giao cho Antigravity (không nộp được review_submit khi chạy chỉ đọc)", () => {
    expect(outcomeCheck.safeParse({ check: "review", by: "antigravity" }).success).toBe(false);
  });
});
