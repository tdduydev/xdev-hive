import type { Criterion, CriterionId, ProfileScore, TokenScore } from "@/lib/token-score.ts";

/** Một tiêu chí mẫu; chỉ ghi đè phần khác biệt. Số liệu dựng tay, không lấy từ máy thật. */
export function criterion(id: CriterionId, patch: Partial<Criterion> = {}): Criterion {
  return { id, group: id.startsWith("A") ? "A" : "B", status: "ok", earned: 1, max: 1, ...patch };
}

/** Hai gói Claude/Codex được tính, một gói Antigravity không tính (spec 025 US1 kịch bản 1 và 4). */
export function sampleScore(): TokenScore {
  const claude: ProfileScore = {
    id: "claude-2",
    label: "Gói Max",
    cli: "claude",
    counted: true,
    level: "balanced",
    weighted: 800_000_000,
    sessions: 31,
    share: 0.8,
    score: 50,
    coverage: 87,
    groups: { A: { earned: 15, max: 38 }, B: { earned: 22.5, max: 49 } },
    criteria: [
      criterion("A1", {
        status: "low",
        value: 967_000,
        unit: "tokens",
        good: 200_000,
        bad: 600_000,
        earned: 0,
        max: 10,
        source: "context",
        fixes: ["optimizer.balanced"],
      }),
      criterion("A2", {
        status: "partial",
        earned: 4,
        max: 8,
        source: "settings",
        items: [
          { id: "bash", status: "ok", value: 15_000, score: 1 },
          { id: "read", status: "low", value: 40_000, score: 0 },
          { id: "hook", status: "low", score: 0 },
        ],
        warnings: [{ code: "user_set" }],
        fixes: ["optimizer.balanced"],
      }),
      criterion("A3", { earned: 5, max: 5, source: "files", value: 1_500, unit: "tokens", good: 2_000, bad: 8_000 }),
      criterion("A4", {
        status: "low",
        value: 15_000,
        unit: "tokens",
        good: 4_000,
        bad: 20_000,
        earned: 2,
        max: 7,
        source: "context",
        fixes: ["open.mcp", "open.memory"],
      }),
      criterion("A5", {
        status: "partial",
        earned: 2.5,
        max: 5,
        source: "tools",
        items: [
          { id: "tool", status: "ok", score: 1 },
          { id: "mcp", status: "low", score: 0 },
          { id: "index", status: "partial", value: 0.5, score: 0.5 },
        ],
        fixes: ["tool.codegraph", "codegraph.mcp", "codegraph.init"],
      }),
      criterion("A6", { status: "unknown", reason: "windows_rtk_unsupported", earned: 0, max: 3, fixes: ["tool.rtk"] }),
      criterion("A7", { earned: 3, max: 3 }),
      criterion("A8", { status: "low", earned: 1, max: 4, fixes: ["optimizer.aggressive"] }),
      criterion("B1", {
        status: "low",
        value: 450_000,
        unit: "tokens",
        good: 120_000,
        bad: 300_000,
        earned: 0,
        max: 12,
        source: "sessions",
      }),
      criterion("B2", {
        status: "partial",
        value: 0.3,
        unit: "ratio",
        good: 0.1,
        bad: 0.5,
        earned: 5,
        max: 10,
        source: "sessions",
      }),
      criterion("B3", { earned: 8, max: 8, value: 15_000, unit: "tokens", good: 20_000, bad: 50_000 }),
      criterion("B4", { earned: 6, max: 6, value: 0.97, unit: "ratio", good: 0.9, bad: 0.6 }),
      criterion("B5", {
        status: "partial",
        earned: 4,
        max: 8,
        value: 40_000,
        unit: "tokens",
        good: 20_000,
        bad: 60_000,
      }),
      criterion("B6", { earned: 5, max: 5 }),
      criterion("B7", { status: "unknown", reason: "no_edit_sessions", earned: 0, max: 6 }),
    ],
    projects: [
      { key: "p1", path: "~/work/app", share: 0.62, codegraph: false },
      { key: "p2", path: "~/work/lib", share: 0.38, codegraph: true },
    ],
    context: [
      { name: "Skills", tokens: 4_300 },
      { name: "MCP tools", tokens: 10_700 },
    ],
  };
  const codex: ProfileScore = {
    id: "codex-1",
    cli: "codex",
    default: true,
    counted: true,
    weighted: 200_000_000,
    sessions: 12,
    share: 0.2,
    score: 75,
    coverage: 70,
    groups: { A: { earned: 10, max: 20 }, B: { earned: 30, max: 36 } },
    criteria: [
      criterion("A1", { status: "partial", earned: 5, max: 10, fixes: ["optimizer.balanced"] }),
      criterion("A6", { status: "unsupported", reason: "unsupported_cli", earned: 0, max: 3 }),
      criterion("B4", { status: "partial", earned: 3, max: 6 }),
    ],
    projects: [],
  };
  const agy: ProfileScore = {
    id: "agy-1",
    cli: "antigravity",
    counted: false,
    reason: "no_token_logs",
    weighted: 0,
    sessions: 0,
    share: 0,
    score: 60,
    coverage: 20,
    groups: { A: { earned: 12, max: 20 }, B: { earned: 0, max: 0 } },
    criteria: [criterion("A3", { earned: 4, max: 5 })],
    projects: [],
  };
  return {
    scoreVersion: 1,
    generatedAt: "2026-10-19T09:00:00Z",
    days: 7,
    machine: { score: 55, level: "low", coverage: 87, provisional: false },
    previous: { score: 51.5, at: "2026-10-18T09:00:00Z" },
    profiles: [claude, codex, agy],
  };
}
