import assert from "node:assert/strict";
import { test } from "node:test";
import { chatSubmitKey, chatUsage, loadedMatches, matchExcerpt, turnSeconds } from "../src/lib/chat-presentation.ts";

test("desktop Enter sends, mobile Enter adds a line, explicit send and IME remain distinct", () => {
  const enter = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, composing: false };
  assert.equal(chatSubmitKey(enter, false), true);
  assert.equal(chatSubmitKey(enter, true), false);
  assert.equal(chatSubmitKey({ ...enter, ctrlKey: true }, true), true);
  assert.equal(chatSubmitKey({ ...enter, metaKey: true }, true), true);
  assert.equal(chatSubmitKey({ ...enter, shiftKey: true }, false), false);
  assert.equal(chatSubmitKey({ ...enter, composing: true, ctrlKey: true }, false), false);
});

test("loaded search handles Vietnamese Unicode, literal markup, and empty queries", () => {
  const messages = [{ id: 1, text: "Đã trả lời" }, { id: 2, text: "<script> unsafe & text" }, { id: 3, text: "Kế hoạch" }];
  assert.deepEqual(loadedMatches(messages, "ĐÃ"), [1]);
  assert.deepEqual(loadedMatches(messages, "<script>"), [2]);
  assert.deepEqual(loadedMatches(messages, " "), []);
  assert.deepEqual(loadedMatches(messages, "missing"), []);
  assert.deepEqual(matchExcerpt(messages[1]!.text, "<script>"), { before: "", match: "<script>", after: " unsafe & text" });
});

test("missing token/cost data stay distinct from measured zero and aggregates exclude user turns", () => {
  const usage = chatUsage([
    { role: "assistant", tokens: null, costUsd: null },
    { role: "assistant", tokens: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0 },
    { role: "assistant", tokens: { inputTokens: 10, cacheReadTokens: 30, outputTokens: 5 }, costUsd: 0.02 },
    { role: "user", costUsd: null },
  ]);
  assert.deepEqual(usage, { tokens: 45, missing: 1, measured: 2, cost: 0.02, missingCost: 1 });
  assert.equal(chatUsage([{ role: "assistant", costUsd: null }]).measured, 0);
});

test("turn elapsed time clamps clock skew and invalid legacy timestamps", () => {
  assert.equal(turnSeconds("2026-10-07T10:00:00Z", "2026-10-07T10:01:05Z"), 65);
  assert.equal(turnSeconds("2026-10-07T10:00:00Z", "2026-10-07T09:59:00Z"), 0);
  assert.equal(turnSeconds("invalid", Date.now()), 0);
});
