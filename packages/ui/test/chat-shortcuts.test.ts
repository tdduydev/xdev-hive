import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HUB_SCOPE, type Machine, type RunRecord, type Task } from "@xdev-hive/core";
import { CHAT_SHORTCUTS, chatStatusCounts, fillShortcutArgument, isStatusCommand, matchingShortcuts, shortcutArgument, shortcutDraft, shortcutRuns } from "#ui/lib/chat-shortcuts.ts";
import { translate } from "#ui/i18n/translate.ts";

describe("chat shortcuts", () => {
  it("offers all English commands at /, filters a first word and leaves prose alone", () => {
    assert.deepEqual(matchingShortcuts("/"), CHAT_SHORTCUTS);
    assert.deepEqual(matchingShortcuts("/re"), ["research", "release", "retry"]);
    assert.deepEqual(matchingShortcuts("/CANCEL"), ["cancel"]);
    for (const text of ["See /status", "/status\nDetails", "/unknown", "/cancel R-1", "a/b"]) assert.deepEqual(matchingShortcuts(text), []);
    assert.ok(isStatusCommand(" /status\nDetails"));
    assert.ok(isStatusCommand("[PAY-1](#/tasks?task=PAY-1) · service: payment\n\n/status\nDetails"));
    assert.equal(isStatusCommand("/statusx"), false);
    assert.equal(isStatusCommand("See /status"), false);
  });

  it("preserves a typed description when a chip fills a localized template", () => {
    for (const locale of ["vi", "en"] as const) for (const command of CHAT_SHORTCUTS) {
      const template = translate(`chat.shortcuts.template.${command}`, undefined, locale);
      assert.ok(template.startsWith(`/${command}`));
      assert.equal(shortcutDraft(template, "/re"), template);
      assert.equal(shortcutDraft(template, ""), template);
      assert.equal(shortcutDraft(template, "Keep this work"), `${template}\nKeep this work`);
      assert.ok(translate(`chat.shortcuts.description.${command}`, undefined, locale));
      assert.ok(translate(`chat.shortcuts.example.${command}`, undefined, locale).startsWith(`/${command}`));
    }
  });

  it("fills only the first-line argument and retains the editable request", () => {
    assert.deepEqual(shortcutArgument("/assign "), { command: "assign", query: "" });
    assert.deepEqual(shortcutArgument("/retry [run ID]\nReason: flaky"), { command: "retry", query: "" });
    assert.deepEqual(shortcutArgument("/research pay"), { command: "research", query: "pay" });
    assert.equal(shortcutArgument("/status "), null);
    assert.equal(fillShortcutArgument("/cancel [run ID]\nReason: flaky", "machine/R-1"), "/cancel machine/R-1\nReason: flaky");
  });

  it("suggests scoped running runs for cancel and recent failures for retry, with machine IDs", () => {
    const run = (runId: string, status: string, project = "payment", updatedAt = "2026-10-07T08:00:00Z") => ({ machineId: "machine-a", runId, status, project, taskId: "PAY-1", taskTitle: "Refund", updatedAt, cancelRequestedAt: null }) as RunRecord;
    const runs = [run("R-1", "running"), run("R-1", "running", "api"), run("R-2", "failed"), run("R-3", "rate_limited", "payment", "2026-10-07T09:00:00Z"), run("R-4", "succeeded"), { ...run("R-5", "running"), cancelRequestedAt: "now" }];
    assert.deepEqual(shortcutRuns(runs, "cancel", "payment", "").map(r => r.runId), ["R-1"]);
    assert.equal(shortcutRuns(runs, "cancel", HUB_SCOPE, "").length, 2);
    assert.deepEqual(shortcutRuns(runs, "retry", "payment", "").map(r => r.runId), ["R-3", "R-2"]);
    assert.equal(shortcutRuns(runs, "retry", "payment", "machine-a/R-2").length, 1);
    assert.equal(shortcutRuns(runs, "retry", "payment", "no-match").length, 0);
  });

  it("counts actual runs independently of doing tasks, without offline or duplicate machines", () => {
    const tasks = ["done", "review", "blocked", "doing", "todo"].map((status, i) => ({ id: `T-${i}`, status, project: "payment" }) as Task);
    tasks.push({ status: "done", project: "api" } as Task);
    const machines = [{ online: true, duplicate: false, runs: [{ project: "payment", status: "running" }, { project: "payment", status: "queued" }, { project: "api", status: "running" }] }, { online: false, duplicate: false, runs: [{ project: "payment", status: "running" }] }, { online: true, duplicate: true, runs: [{ project: "payment", status: "running" }] }] as Machine[];
    assert.deepEqual(chatStatusCounts(tasks, machines, "payment"), { done: 1, running: 1, review: 1, blocked: 1 });
    assert.deepEqual(chatStatusCounts(tasks, machines, HUB_SCOPE), { done: 2, running: 2, review: 1, blocked: 1 });
  });
});
