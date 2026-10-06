import assert from "node:assert/strict";
import { it } from "node:test";
import { ClaudeStream, CodexStream } from "#desktop/main/runner/stream.ts";
import { RunStore } from "#desktop/main/runner/store.ts";

it("records only successful Claude skill reads, across chunks and duplicate loads", () => {
  const s = new ClaudeStream("/wt");
  const call = (id: string, name: string, input: unknown) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } }) + "\n";
  const result = (id: string, is_error = false) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error, content: "ok" }] } }) + "\n";
  const lines = call("1", "Read", { file_path: "/wt/.claude/skills/review-pr/SKILL.md" }) + result("1")
    + call("2", "mcp__xdev_hive__skill_get", { name: "review-pr" }) + result("2")
    + call("3", "mcp__xdev_hive__skill_get", { name: "broken" }) + result("3", true)
    + call("4", "Write", { file_path: "/wt/.claude/skills/writing/SKILL.md" }) + result("4")
    + call("5", "Read", { file_path: "C:\\skills\\windows\\SKILL.md" }) + result("5")
    + call("6", "Read", { file_path: "/wt/.claude/skills/unanswered/SKILL.md" })
    + call("7", "skill_get", { name: "release" }) + result("7").trimEnd();
  for (let i = 0; i < lines.length; i += 13) s.push(lines.slice(i, i + 13));
  s.end();
  assert.deepEqual([...s.skills], ["review-pr", "windows", "release"]);
});

it("records Codex MCP skill_get results, ignores failures and unrelated output", () => {
  const s = new CodexStream("/wt");
  const event = (over: Record<string, unknown> = {}) => JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", tool: "skill_get", status: "completed", arguments: { name: "review-pr" }, ...over } });
  const lines = [event(), event(), event({ arguments: JSON.stringify({ name: "release" }) }), event({ status: "failed", arguments: { name: "failed" } }), event({ result: { isError: true }, arguments: { name: "error" } }), event({ arguments: "invalid" }), event({ tool: "skill_list", arguments: { name: "unrelated" } })].join("\n");
  s.push(lines.slice(0, 42)); s.push(lines.slice(42)); s.end();
  assert.deepEqual([...s.skills], ["review-pr", "release"]);
});

it("stores skill usage as JSON with an empty default for older local runs", () => {
  const store = new RunStore(":memory:");
  const run = store.insert({ project: "app", taskId: "T-1", taskTitle: "x", role: "implement", attempt: 1, maxAttempts: 1 }, "2026-10-06T00:00:00.000Z");
  assert.deepEqual(store.get(run.id)?.skills, []);
  store.update(run.id, { skills: ["review-pr", "release"] });
  assert.deepEqual(store.get(run.id)?.skills, ["review-pr", "release"]);
  store.db.close();
});
