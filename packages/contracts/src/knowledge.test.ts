import { describe, expect, it } from "vitest";
import { memory, memoryContract } from "./knowledge.ts";

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "note",
  status: "approved",
  content: "x",
  files: [],
  scope: { level: "org", teamId: null, projectId: null },
  author: { userId: "u1", runId: null },
  createdAt: "2026-10-22T00:00:00.000Z",
  supersededBy: null,
};

describe("memory ghim", () => {
  it("đầu ra có pinned kiểu boolean", () => {
    expect(memory.parse({ ...base, pinned: true }).pinned).toBe(true);
    expect(memory.parse({ ...base, pinned: false }).pinned).toBe(false);
    expect(memory.safeParse(base).success).toBe(false);
    expect(memory.safeParse({ ...base, pinned: "yes" }).success).toBe(false);
  });

  it("route memory.pin là POST /v1/memories/{id}/pin", () => {
    const route = memoryContract.pin["~orpc"].route;
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/memories/{id}/pin");
  });

  it("memory.pin nhận id và pinned boolean, trả memory", () => {
    const input = memoryContract.pin["~orpc"].inputSchema;
    const output = memoryContract.pin["~orpc"].outputSchema;
    expect(input?.["~standard"].validate({ id: base.id, pinned: true })).toEqual({
      value: { id: base.id, pinned: true },
    });
    for (const bad of [{ id: base.id }, { id: base.id, pinned: "true" }, { id: "x", pinned: true }]) {
      expect(input?.["~standard"].validate(bad)).toHaveProperty("issues");
    }
    expect(output?.["~standard"].validate({ ...base, pinned: true })).not.toHaveProperty("issues");
  });
});
