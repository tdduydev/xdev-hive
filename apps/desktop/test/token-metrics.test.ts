import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_TEMPLATES, OPEN_POLICY, agentProfileSchema } from "@xdev-hive/core";
import { applyPolicy, limitEnv } from "#desktop/main/runner/command.ts";
import { CodexStream } from "#desktop/main/runner/stream.ts";
import { parseCodexUsage } from "#desktop/main/runner/usage.ts";

const ev = (e: unknown) => `${JSON.stringify(e)}\n`;
const RUN = [
  ev({ type: "thread.started", thread_id: "th-1" }),
  ev({ type: "turn.started" }),
  ev({ type: "item.started", item: { id: "i0", type: "command_execution", command: "bash -lc 'npm test'", status: "in_progress" } }),
  ev({ type: "item.completed", item: { id: "i0", type: "command_execution", command: "bash -lc 'npm test'", aggregated_output: "ok 1\nok 2", exit_code: 0 } }),
  ev({ type: "item.completed", item: { id: "i1", type: "file_change", changes: [{ path: "/repo/src/a.ts", kind: "update" }, { path: "/repo/src/b.ts", kind: "add" }] } }),
  ev({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "Done: tests pass." } }),
  ev({ type: "turn.completed", usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300 } }),
  ev({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 50 } }),
].join("");

describe("Codex exec --json (roadmap 28c)", () => {
  it("turns its events into a log, keeps the last message, and adds up every turn's tokens", () => {
    const s = new CodexStream("/repo");
    // In pieces, as stdout comes.
    const log = s.push(RUN.slice(0, 200)) + s.push(RUN.slice(200)) + s.end();
    assert.match(log, /^# thread th-1 · Codex\n▶ Bash: bash -lc 'npm test'\n {2}✓ ok 1 \(\+1 lines\)\n▶ Edit src\/a\.ts\n▶ Write src\/b\.ts\nDone: tests pass\.\n# tokens in 5000 \(cached 4000\) out 300\n/);
    assert.equal(s.lastText, "Done: tests pass.");
    assert.deepEqual(s.tokens, { turns: 2, input: 6000, cached: 4500, output: 350 });
    assert.doesNotMatch(log, /"type"/, "no raw events");
  });

  it("reads the same tokens from stdout, cached input taken out of input", () => {
    assert.deepEqual(parseCodexUsage(RUN, "Done."), { text: "Done.", costUsd: null, inputTokens: 1500, cacheWriteTokens: 0, cacheReadTokens: 4500, outputTokens: 350 });
    assert.equal(parseCodexUsage("plain text\n"), null);
  });

  it("writes a line it does not know as it came", () => {
    const s = new CodexStream("/repo");
    assert.equal(s.push("WARN something\n"), "WARN something\n");
    assert.equal(s.push(ev({ type: "something.new" })), "");
  });
});

describe("output limits of a project's runs (roadmap 28c)", () => {
  const claude = agentProfileSchema.parse({ ...AGENT_TEMPLATES.claude, id: "claude-1", env: { BASH_MAX_OUTPUT_LENGTH: "5000" } });
  const limited = { ...OPEN_POLICY, limits: { mcpOutputTokens: 20_000, bashOutputChars: 30_000 } };

  it("gives Claude Code the policy's limits, keeping a lower one the profile set", () => {
    assert.deepEqual(limitEnv(claude, limited), { BASH_MAX_OUTPUT_LENGTH: "5000", MAX_MCP_OUTPUT_TOKENS: "20000" });
    assert.deepEqual(applyPolicy(claude, limited).profile.env, { BASH_MAX_OUTPUT_LENGTH: "5000", MAX_MCP_OUTPUT_TOKENS: "20000" });
    assert.deepEqual(limitEnv(claude, OPEN_POLICY), claude.env, "no limits: as the profile has it");
  });

  it("leaves other CLIs alone", () => {
    const codex = agentProfileSchema.parse({ ...AGENT_TEMPLATES.codex, id: "codex-1" });
    assert.deepEqual(limitEnv(codex, limited), codex.env);
  });
});
