import { describe, expect, it } from "vitest";
import { MACHINE_EVENT_KINDS, machineEventInput } from "./client-events.ts";

const key = "01HZXKQ3N5V8W9Y2A4B6C8D0EF";
const projectId = "6f1c2a40-8f3b-4c1e-9d55-0a1b2c3d4e5f";
const base = { key, createdAt: "2026-10-22T08:00:00.000Z" };

const usage = {
  projectId,
  periodStart: "2026-10-21T00:00:00.000Z",
  periodEnd: "2026-10-22T00:00:00.000Z",
  tokens: { claude: { input: 10, output: 5, cacheRead: 100, weighted: 12.5 } },
  sessions: 3,
  score: 80,
  policyDrift: ["level", "rtk"],
};
const propose = { projectId, kind: "gotcha", content: "Không chạy migrate trên hub dev." };

const parseUsage = (payload: unknown) => machineEventInput.safeParse({ ...base, kind: "project.token_usage", payload });
const parsePropose = (payload: unknown) => machineEventInput.safeParse({ ...base, kind: "memory.propose", payload });

describe("memory.propose", () => {
  it("nhận payload hợp lệ và có trong MACHINE_EVENT_KINDS", () => {
    expect(parsePropose(propose).success).toBe(true);
    expect(MACHINE_EVENT_KINDS["memory.propose"]).toBeDefined();
  });
  it("từ chối trường lạ", () => {
    expect(parsePropose({ ...propose, path: "/etc" }).success).toBe(false);
  });
  it("content 1–2.000 ký tự", () => {
    expect(parsePropose({ ...propose, content: "" }).success).toBe(false);
    expect(parsePropose({ ...propose, content: "a" }).success).toBe(true);
    expect(parsePropose({ ...propose, content: "a".repeat(2000) }).success).toBe(true);
    expect(parsePropose({ ...propose, content: "a".repeat(2001) }).success).toBe(false);
  });
  it("kind ngoài enum và projectId không phải uuid bị từ chối", () => {
    expect(parsePropose({ ...propose, kind: "other" }).success).toBe(false);
    expect(parsePropose({ ...propose, projectId: "abc" }).success).toBe(false);
  });
});

describe("project.token_usage", () => {
  it("nhận payload hợp lệ và có trong MACHINE_EVENT_KINDS", () => {
    expect(parseUsage(usage).success).toBe(true);
    expect(parseUsage({ ...usage, score: null, tokens: {}, policyDrift: [] }).success).toBe(true);
    expect(MACHINE_EVENT_KINDS["project.token_usage"]).toBeDefined();
  });
  it("từ chối trường lạ ở mọi tầng (SC-007: không chuỗi tự do)", () => {
    expect(parseUsage({ ...usage, projectName: "x" }).success).toBe(false);
    expect(parseUsage({ ...usage, tokens: { claude: { ...usage.tokens.claude, model: "x" } } }).success).toBe(false);
    expect(parseUsage({ ...usage, tokens: { gemini: usage.tokens.claude } }).success).toBe(false);
    expect(parseUsage({ ...usage, policyDrift: ["/home/me"] }).success).toBe(false);
  });
  it("giá trị biên của số", () => {
    expect(parseUsage({ ...usage, score: 0 }).success).toBe(true);
    expect(parseUsage({ ...usage, score: 100 }).success).toBe(true);
    expect(parseUsage({ ...usage, score: 101 }).success).toBe(false);
    expect(parseUsage({ ...usage, score: -1 }).success).toBe(false);
    expect(parseUsage({ ...usage, score: 50.5 }).success).toBe(false);
    expect(parseUsage({ ...usage, sessions: -1 }).success).toBe(false);
    expect(parseUsage({ ...usage, sessions: 1.5 }).success).toBe(false);
    expect(parseUsage({ ...usage, periodEnd: "hôm qua" }).success).toBe(false);
    const bad = { claude: { ...usage.tokens.claude, input: -1 } };
    expect(parseUsage({ ...usage, tokens: bad }).success).toBe(false);
  });
});
