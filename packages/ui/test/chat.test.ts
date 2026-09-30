import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatAction, ChatMessage, Machine, ReportedProfile } from "@xdev-hive/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { actionTask, chatMachines, isLiveReply, linkIds, machineName, mergeMessages, pollAfter, remarkHiveLinks, REPLY_MARKDOWN, stepCount, withAction } from "../src/lib/chat.ts";

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
  actions: [],
  files: [],
  ...over,
});

const action = (id: number, over: Partial<ChatAction> = {}): ChatAction => ({
  id,
  replyId: 2,
  threadId: 1,
  project: "app",
  kind: "task.create",
  input: { id: "T-5", project: "app", title: "Reset", dependsOn: [] },
  reason: "Asked for",
  status: "proposed",
  result: null,
  error: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: "2026-09-29T10:00:00Z",
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
    // An action nobody decided may be decided by another manager: that reply is read again too.
    assert.equal(pollAfter([message(1, { role: "user", status: null }), message(2, { actions: [action(7)] }), message(3)]), 1);
    assert.equal(pollAfter([message(1, { role: "user", status: null }), message(2, { actions: [action(7, { status: "done" })] })]), 2);
    assert.deepEqual(["pending", "running", "done", "failed", "cancelled", "expired", null].filter((status) => isLiveReply({ status: status as never })), ["pending", "running"]);
  });

  it("keeps the newest version of each message, in order", () => {
    const known = [message(1, { role: "user", status: null, text: "hi" }), message(2, { status: "running", text: "Look" })];
    const merged = mergeMessages(known, [message(2, { status: "done", text: "Looked." }), message(4, { text: "later" })]);
    assert.deepEqual(merged.map((m) => [m.id, m.text]), [[1, "hi"], [2, "Looked."], [4, "later"]]);
    assert.equal(mergeMessages(known, []), known, "nothing new: the same list, no re-render");
  });

  it("swaps in a decided action, and names what an action is about", () => {
    const known = [message(1, { role: "user", status: null }), message(2, { actions: [action(7), action(8)] })];
    const next = withAction(known, action(8, { status: "done", result: { taskId: "T-5" } }));
    assert.deepEqual(next[1]!.actions.map((a) => a.status), ["proposed", "done"]);
    assert.equal(next[0], known[0], "other messages untouched");
    assert.equal(actionTask(action(1)), "T-5");
    assert.equal(actionTask(action(1, { kind: "run.dispatch", input: { taskId: "T-2", machineId: "runner.team-mbp@team-mbp" } })), "T-2");
    assert.equal(machineName("runner.team-mbp@team-mbp"), "team-mbp");
    assert.equal(machineName("mini"), "mini");
  });

  it("counts the tool calls among the steps", () => {
    assert.equal(stepCount(""), 0);
    assert.equal(stepCount("▶ tasks_list\n✓ 3 tasks\n▶ tasks_create T-9\n✗ exists"), 2);
  });

  it("links the project's tasks and runs a reply names, and nothing that only looks like them", () => {
    const ids = ["T-1", "T-12", "AUTH-1", "AUTH-12", "v1.2"];
    const text = "Made T-12 and AUTH-12 (after AUTH-1). T-1. Queued R-1fa9c0 for v1.2; not T-123, XT-1 or T-1a.";
    const parts = linkIds(text, ids);
    assert.deepEqual(
      parts.filter((p) => p.kind !== "text").map((p) => `${p.kind}:${p.text}`),
      ["task:T-12", "task:AUTH-12", "task:AUTH-1", "task:T-1", "run:R-1fa9c0", "task:v1.2"],
    );
    assert.equal(parts.map((p) => p.text).join(""), text, "no text lost");
    assert.deepEqual(linkIds("T-1 is done", []), [{ kind: "text", text: "T-1 is done" }], "a task the project does not have is plain text");
  });

  it("turns ids in the reply's text into links, leaving code and existing links alone", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "See T-1 and R-1fa9c0." },
            { type: "inlineCode", value: "T-1" },
            { type: "link", url: "https://x.test", children: [{ type: "text", value: "T-1" }] },
            { type: "strong", children: [{ type: "text", value: "T-1" }] },
          ],
        },
        { type: "code", value: "T-1" },
      ],
    };
    remarkHiveLinks({ taskIds: ["T-1"] })(tree);
    const [paragraph, code] = tree.children as Array<{ type: string; children?: unknown[]; value?: string }>;
    assert.deepEqual(paragraph!.children, [
      { type: "text", value: "See " },
      { type: "link", url: "#/tasks?task=T-1", children: [{ type: "text", value: "T-1" }] },
      { type: "text", value: " and " },
      { type: "link", url: "#/runs?run=R-1fa9c0", children: [{ type: "text", value: "R-1fa9c0" }] },
      { type: "text", value: "." },
      { type: "inlineCode", value: "T-1" },
      { type: "link", url: "https://x.test", children: [{ type: "text", value: "T-1" }] },
      { type: "strong", children: [{ type: "link", url: "#/tasks?task=T-1", children: [{ type: "text", value: "T-1" }] }] },
    ]);
    assert.deepEqual(code, { type: "code", value: "T-1" });
  });

  it("renders a reply as GitHub Markdown, without its HTML or images", () => {
    const html = renderToStaticMarkup(
      createElement(
        Markdown,
        { ...REPLY_MARKDOWN, remarkPlugins: [remarkGfm, [remarkHiveLinks, { taskIds: ["T-2"] }]] },
        [
          "## Plan",
          "- [x] T-2 done",
          "",
          "| Task | State |",
          "| --- | --- |",
          "| T-2 | review |",
          "",
          "```sh",
          "npm test",
          "```",
          "<script>alert(1)</script> <b>bold</b>",
          "",
          "![tracker](https://evil.test/p.png) see https://github.com/x/y/pull/3",
        ].join("\n"),
      ),
    );
    assert.match(html, /<h2>Plan<\/h2>/);
    assert.match(html, /<table>[\s\S]*<td><a href="#\/tasks\?task=T-2">T-2<\/a><\/td>/);
    assert.match(html, /<pre><code class="language-sh">npm test\n<\/code><\/pre>/);
    assert.match(html, /<a href="https:\/\/github.com\/x\/y\/pull\/3">/, "a bare web link becomes a link");
    assert.doesNotMatch(html, /<script|<b>|alert\(1\)<\/script>/, "raw HTML is not rendered");
    assert.doesNotMatch(html, /<img|evil\.test/, "no image from wherever the text points");
  });
});
