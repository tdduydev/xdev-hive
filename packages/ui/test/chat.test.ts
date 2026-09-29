import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage, Machine, ReportedProfile } from "@xdev-hive/core";
import { chatMachines, inline, isLiveReply, mergeMessages, pollAfter, replyBlocks, stepCount } from "../src/lib/chat.ts";

const profile = (over: Partial<ReportedProfile> = {}): ReportedProfile => ({
  id: "claude-1",
  label: "claude-1",
  kind: "claude",
  enabled: true,
  account: null,
  installed: true,
  loggedIn: true,
  cooldownUntil: null,
  runs: 0,
  rateLimited: 0,
  ...over,
});

const machine = (name: string, over: Partial<Machine> = {}): Machine => ({
  id: `runner.${name}@team`,
  machine: name,
  version: "0.53.0",
  lastSeen: "2026-09-29T10:00:00Z",
  online: true,
  duplicate: false,
  runs: [],
  profiles: [profile()],
  projects: ["app"],
  acceptsRuns: true,
  ...over,
});

const message = (id: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  threadId: 1,
  role: "assistant",
  author: "claude-1@mbp",
  text: "",
  status: "done",
  activity: null,
  steps: "",
  error: null,
  costUsd: null,
  createdAt: "2026-09-29T10:00:00Z",
  updatedAt: "2026-09-29T10:00:00Z",
  finishedAt: null,
  ...over,
});

describe("chat helpers", () => {
  it("offers only machines that can hold the project's thread, as the hub checks them", () => {
    const list = [
      machine("mbp"),
      machine("off", { online: false }),
      machine("closed", { acceptsRuns: false }),
      machine("norepo", { projects: ["other"] }),
      machine("codex", { profiles: [profile({ kind: "codex" })] }),
      machine("signedout", { profiles: [profile({ loggedIn: false }), profile({ id: "claude-2", enabled: false })] }),
      // Not checked yet (older app, no status command): the hub lets it try.
      machine("unknown", { profiles: [profile({ loggedIn: null })] }),
    ];
    assert.deepEqual(chatMachines(list, "app").map((m) => m.machine), ["mbp", "unknown"]);
    assert.deepEqual(chatMachines(list, "other").map((m) => m.machine), ["norepo"]);
  });

  it("polls from just before the reply being written, since it changes in place", () => {
    assert.equal(pollAfter([]), 0);
    assert.equal(pollAfter([message(1, { role: "user", status: null }), message(2)]), 2);
    assert.equal(pollAfter([message(1, { role: "user", status: null }), message(2, { status: "running" }), message(3, { status: "pending" })]), 1);
    assert.deepEqual(["pending", "running", "done", "failed", "cancelled", "expired", null].filter((status) => isLiveReply({ status: status as never })), ["pending", "running"]);
  });

  it("keeps the newest version of each message, in order", () => {
    const known = [message(1, { role: "user", status: null, text: "hi" }), message(2, { status: "running", text: "Look" })];
    const merged = mergeMessages(known, [message(2, { status: "done", text: "Looked." }), message(4, { text: "later" })]);
    assert.deepEqual(merged.map((m) => [m.id, m.text]), [[1, "hi"], [2, "Looked."], [4, "later"]]);
    assert.equal(mergeMessages(known, []), known, "nothing new: the same list, no re-render");
  });

  it("counts the tool calls among the steps", () => {
    assert.equal(stepCount(""), 0);
    assert.equal(stepCount("▶ tasks_list\n✓ 3 tasks\n▶ tasks_create T-9\n✗ exists"), 2);
  });

  it("links the project's tasks and runs a reply names, and nothing that only looks like them", () => {
    const ids = ["T-1", "T-12", "AUTH-1", "AUTH-12", "v1.2"];
    const parts = inline("Made T-12 and AUTH-12 (after AUTH-1). T-1. Queued R-1fa9c0 for v1.2; not T-123, XT-1 or T-1a.", ids);
    assert.deepEqual(
      parts.filter((p) => p.kind !== "text").map((p) => `${p.kind}:${p.text}`),
      ["task:T-12", "task:AUTH-12", "task:AUTH-1", "task:T-1", "run:R-1fa9c0", "task:v1.2"],
    );
    assert.equal(parts.map((p) => p.text).join(""), "Made T-12 and AUTH-12 (after AUTH-1). T-1. Queued R-1fa9c0 for v1.2; not T-123, XT-1 or T-1a.", "no text lost");
    assert.deepEqual(inline("T-1 is done", []), [{ kind: "text", text: "T-1 is done" }], "a task the project does not have is plain text");
  });

  it("picks out code, bold and web links; a link's closing punctuation stays text", () => {
    assert.deepEqual(inline("Run `npm test` on **T-1**, see https://github.com/x/y/pull/3.", ["T-1"]), [
      { kind: "text", text: "Run " },
      { kind: "code", text: "npm test" },
      { kind: "text", text: " on " },
      { kind: "bold", text: "T-1" },
      { kind: "text", text: ", see " },
      { kind: "url", text: "https://github.com/x/y/pull/3" },
      { kind: "text", text: "." },
    ]);
    assert.deepEqual(inline("`T-1` stays code", ["T-1"]), [{ kind: "code", text: "T-1" }, { kind: "text", text: " stays code" }]);
  });

  it("reads *emphasis*, but not the stars of a sum or a list", () => {
    assert.deepEqual(inline("the review says *needs fixes*: see T-1", ["T-1"]).map((p) => p.kind), ["text", "em", "text", "task"]);
    for (const plain of ["2 * 3 * 4", "a*b*c", "* item\n* item", "**", "* x *"]) {
      assert.ok(inline(plain).every((p) => p.kind === "text"), plain);
    }
    // The page reads what is inside emphasis again, so an id in **T-1** is still a link.
    assert.deepEqual(inline("T-1", ["T-1"]), [{ kind: "task", text: "T-1" }]);
  });

  it("keeps fenced code as it is, including a fence still being written", () => {
    const blocks = replyBlocks("Steps:\n```sh\nnpm test\nnpm run build\n```\nThen T-1.\n\n```ts\nconst a = 1;", ["T-1"]);
    assert.deepEqual(blocks, [
      { kind: "text", parts: [{ kind: "text", text: "Steps:" }] },
      { kind: "code", text: "npm test\nnpm run build" },
      { kind: "text", parts: [{ kind: "text", text: "Then " }, { kind: "task", text: "T-1" }, { kind: "text", text: "." }] },
      { kind: "code", text: "const a = 1;" },
    ]);
    assert.deepEqual(replyBlocks(""), []);
  });
});
