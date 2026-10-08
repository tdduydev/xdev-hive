import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HiveError, type Actor } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const mini: Actor = { name: "runner.lan-mini@lan-mini", role: "agent" };
const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "manage" } } };
const dev: Actor = { name: "minh", role: "member", access: { projects: { app: "contribute" } } };
const outsider: Actor = { name: "khoa", role: "member", access: { projects: { site: "manage" } } };
/** Admin of two projects, not of the hub: the closest anyone gets to the hub-wide chat without being a hub admin. */
const projectAdmin: Actor = { name: "khanh", role: "admin", access: { projects: { app: "lead", site: "lead" } } };

const profile = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  kind: id.split("-")[0]!,
  enabled: true,
  account: null,
  installed: true,
  loggedIn: true,
  cooldownUntil: null,
  runs: 0,
  rateLimited: 0,
  ...over,
});

async function hub() {
  const clock = { at: Date.parse("2026-09-29T08:00:00.000Z") };
  const hive = new SqliteHive(":memory:", { now: () => new Date(clock.at) });
  const beat = (actor: Actor, over: Record<string, unknown> = {}) =>
    hive.call(
      "machines.heartbeat",
      {
        machine: actor.name.split("@")[1]!,
        instance: "a1b2c3d4",
        profiles: [profile("claude-1"), profile("codex-1")],
        projects: ["app", "site"],
        acceptsRuns: true,
        ...over,
      },
      actor,
    );
  const later = (minutes: number) => (clock.at += minutes * 60_000);
  return { hive, beat, later };
}

/** The error key a call fails with. */
async function refusal(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (err) {
    assert.ok(err instanceof HiveError, String(err));
    return err.key ?? err.code;
  }
  assert.fail("expected the call to fail");
}

describe("chat with a project's leader", () => {
  it("chooses an available Codex leader by priority, saves defaults and resumes its own profile", async () => {
    const { hive, beat } = await hub();
    await beat(mbp, { profiles: [profile("claude-1", { priority: 1, overLimit: true }), profile("codex-1", { priority: 5 }), profile("codex-2", { priority: 10 })] });
    await hive.call("chat.setDefaults", { project: "app", machineId: mbp.name, profileId: null, model: null, effort: null }, lead);
    const first = await hive.call("chat.send", { project: "app", text: "Read app" }, lead);
    assert.equal(first.thread.profileId, "codex-1");
    await hive.call("chat.finish", { replyId: first.reply.id, status: "done", sessionId: "codex-thread", profileId: "codex-1", tokens: { inputTokens: 8, cacheReadTokens: 2, outputTokens: 3 } }, mbp);
    await beat(mbp, { profiles: [profile("claude-1", { priority: 1 }), profile("codex-1", { priority: 20 })] });
    await hive.call("chat.send", { project: "app", threadId: first.thread.id, text: "Continue" }, lead);
    const [req] = await hive.call("chat.poll", {}, mbp);
    assert.deepEqual([req!.profileId, req!.sessionId], ["codex-1", "codex-thread"], "the next turn never resumes on a higher priority account");
    hive.close();
  });

  it("keeps a Claude quota failure until the next send and refuses fallback when no Codex quota is available", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    const first = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Read app" }, lead);
    await hive.call("chat.finish", { replyId: first.reply.id, status: "failed", sessionId: "claude-session", rateLimited: true, error: { message: "Usage limit reached" } }, mbp);
    await beat(mbp, { profiles: [profile("claude-1"), profile("codex-1", { overLimit: true })] });
    assert.equal(await refusal(hive.call("chat.send", { project: "app", threadId: first.thread.id, text: "Continue" }, lead)), "errors.chatNoProfile");
    assert.equal((await hive.call("chat.get", { threadId: first.thread.id }, lead))!.messages.length, 2, "failed send creates no half turn");
    await beat(mbp);
    const next = await hive.call("chat.send", { project: "app", threadId: first.thread.id, text: "Continue" }, lead);
    assert.equal(next.reply.switchedFrom, "claude-1");
    assert.equal((await hive.call("chat.poll", {}, mbp))[0]!.sessionId, null);
    hive.close();
  });

  it("does not let a late cancelled Claude finish overwrite the next Codex turn's session", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    const first = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "First" }, lead);
    await hive.call("chat.cancel", { replyId: first.reply.id }, lead);
    await beat(mbp, { profiles: [profile("claude-1", { overLimit: true }), profile("codex-1")] });
    const next = await hive.call("chat.send", { project: "app", threadId: first.thread.id, text: "Next" }, lead);
    await hive.call("chat.finish", { replyId: first.reply.id, status: "done", sessionId: "late-claude-session", profileId: "claude-1" }, mbp);
    const [req] = await hive.call("chat.poll", {}, mbp);
    assert.deepEqual([req!.profileId, req!.sessionId], ["codex-1", null]);
    await hive.call("chat.finish", { replyId: next.reply.id, status: "done", sessionId: "new-codex-session", profileId: "codex-1" }, mbp);
    assert.equal((await hive.call("chat.get", { threadId: first.thread.id }, lead))!.thread.profileId, "codex-1");
    hive.close();
  });

  it("upgrades existing chats without losing their session or messages", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-chat-codex-migration-"));
    const file = path.join(dir, "hive.db");
    try {
      const hive = new SqliteHive(file);
      await hive.call("machines.heartbeat", { machine: "test", instance: "1234abcd", projects: ["app"], acceptsRuns: true, profiles: [profile("claude-1")] }, mbp);
      const first = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Old message" }, lead);
      await hive.call("chat.finish", { replyId: first.reply.id, status: "done", text: "Old answer", sessionId: "old-session", costUsd: 0.01 }, mbp);
      // Recreate the pre-chat-upgrade schema, including the later research and terminal tables, before replaying migrations.
      hive.db.exec(`DROP TABLE gate_jobs; DROP TABLE gate_manifests; ALTER TABLE machines DROP COLUMN gate_capability; DROP TABLE research_runs; DROP TABLE terminal_audit_chunks; DROP TABLE terminal_stepups; DROP TABLE terminal_tickets; DROP TABLE terminal_sessions; ALTER TABLE machines DROP COLUMN terminal_capability; ALTER TABLE chat_messages DROP COLUMN tokens; ALTER TABLE chat_messages DROP COLUMN switched_from; ALTER TABLE chat_messages DROP COLUMN rate_limited; PRAGMA user_version = ${migrationIndex("ALTER TABLE chat_messages ADD COLUMN tokens")}`);
      hive.close();
      const upgraded = new SqliteHive(file);
      try {
        const chat = (await upgraded.call("chat.get", { threadId: first.thread.id }, lead))!;
        assert.deepEqual(chat.messages.map((m) => m.text), ["Old message", "Old answer"]);
        assert.equal(chat.messages[1]!.tokens, null);
        assert.equal(chat.messages[1]!.costUsd, 0.01);
        await upgraded.call("chat.send", { project: "app", threadId: first.thread.id, text: "Next" }, lead);
        assert.equal((await upgraded.call("chat.poll", {}, mbp))[0]!.sessionId, "old-session");
      } finally { upgraded.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("starts a thread on one machine, hands it the reply, and resumes the session for the next message", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    await beat(mini);
    const first = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Plan AUTH-13\nwith tests" }, lead);
    assert.deepEqual([first.thread.title, first.thread.machine, first.thread.busy, first.thread.createdBy], ["Plan AUTH-13", "duy-mbp", true, "lan"]);
    assert.deepEqual([first.message.role, first.message.author, first.message.text], ["user", "lan", "Plan AUTH-13\nwith tests"]);
    assert.deepEqual([first.reply.role, first.reply.status, first.reply.author], ["assistant", "pending", "claude-1@duy-mbp"]);

    assert.deepEqual((await beat(mini)).chatRequests, [], "only the thread's machine");
    // Between heartbeats the machine asks for the same, every few seconds.
    assert.deepEqual((await hive.call("chat.poll", {}, mbp)).map((r) => r.replyId), [first.reply.id]);
    assert.deepEqual(await hive.call("chat.poll", {}, mini), []);
    const [sent] = (await beat(mbp)).chatRequests;
    assert.deepEqual(
      [sent!.replyId, sent!.threadId, sent!.project, sent!.sessionId, sent!.text, sent!.requestedBy],
      [first.reply.id, first.thread.id, "app", null, "Plan AUTH-13\nwith tests", "lan"],
    );
    assert.deepEqual(sent!.sender, { name: "lan", role: "member", access: { projects: { app: "manage" } } }, "for the hub to cut the MCP token");

    assert.equal(await refusal(hive.call("chat.progress", { replyId: first.reply.id, text: "x" }, mini)), "forbidden");
    assert.deepEqual(await hive.call("chat.progress", { replyId: first.reply.id, text: "Working", steps: "▶ Read: README.md", activity: "Read: README.md" }, mbp), {
      cancelled: false,
    });
    assert.deepEqual((await beat(mbp)).chatRequests, [], "started: not sent again");
    assert.equal(await refusal(hive.call("chat.send", { project: "app", threadId: first.thread.id, text: "and?" }, lead)), "errors.chatBusy");

    const done = await hive.call("chat.finish", { replyId: first.reply.id, status: "done", text: "Created AUTH-13.", steps: "▶ task_create", sessionId: "sess-1", costUsd: 0.12 }, mbp);
    assert.deepEqual([done.status, done.text, done.steps, done.costUsd, done.activity], ["done", "Created AUTH-13.", "▶ task_create", 0.12, null]);

    const next = await hive.call("chat.send", { project: "app", threadId: first.thread.id, text: "Queue it on claude" }, lead);
    const [again] = (await beat(mbp)).chatRequests;
    assert.deepEqual([again!.replyId, again!.sessionId, again!.text], [next.reply.id, "sess-1", "Queue it on claude"]);

    const all = await hive.call("chat.get", { threadId: first.thread.id }, dev);
    assert.deepEqual(all!.messages.map((m) => [m.role, m.status]), [["user", null], ["assistant", "done"], ["user", null], ["assistant", "pending"]]);
    const newer = await hive.call("chat.get", { threadId: first.thread.id, after: done.id }, dev);
    assert.deepEqual(newer!.messages.map((m) => m.id), [next.message.id, next.reply.id]);
  });

  it("only lets project managers write, and refuses what the machine could not answer", async () => {
    const { hive, beat, later } = await hub();
    await beat(mbp);
    const ask = (over: Record<string, unknown>, who: Actor = lead) => refusal(hive.call("chat.send", { project: "app", machineId: mbp.name, text: "hi", ...over }, who));
    assert.equal(await ask({}, dev), "errors.need.chatUse");
    assert.equal(await ask({}, mbp), "errors.need.chatUse", "an agent token never starts a chat");
    assert.equal(await ask({}, outsider), "errors.notFound");
    assert.equal(await ask({ machineId: undefined }), "errors.chatMachine");
    assert.equal(await ask({ machineId: "runner.nobody@x" }), "errors.machineNotFound");
    assert.equal(await ask({ profileId: "gemini-1" }), "errors.chatNoProfile", "only Claude and Codex leaders");
    assert.equal(await ask({ text: "use ​this" }), "errors.hidden.zeroWidth");
    const site = await hive.call("chat.send", { project: "site", machineId: mbp.name, text: "hi" }, admin);
    assert.equal(await ask({ threadId: site.thread.id }), "errors.chatNotFound", "a thread of another project");

    await beat(mbp, { profiles: [profile("claude-1", { loggedIn: false }), profile("codex-1")] });
    assert.equal(await ask({ profileId: "claude-1" }), "errors.chatNoProfile", "the pinned profile is signed out");
    await beat(mbp, { projects: ["site"] });
    assert.equal(await ask({}), "errors.machineNoRepo");
    await beat(mbp, { acceptsRuns: false });
    assert.equal(await ask({}), "errors.machineNoHubRuns");
    await beat(mbp);
    later(3);
    assert.equal(await ask({}), "errors.machineOffline");
  });

  it("cancels a reply: the machine hears it at its next report, and what it wrote is kept", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    const { reply } = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Summarize the reviews" }, lead);
    await hive.call("chat.progress", { replyId: reply.id, text: "Reading" }, mbp);
    assert.equal(await refusal(hive.call("chat.cancel", { replyId: reply.id }, dev)), "errors.need.chatUse");
    assert.equal((await hive.call("chat.cancel", { replyId: reply.id }, lead)).status, "cancelled");
    assert.deepEqual(await hive.call("chat.progress", { replyId: reply.id, text: "Reading more" }, mbp), { cancelled: true });
    const kept = await hive.call("chat.finish", { replyId: reply.id, status: "done", text: "Partial summary" }, mbp);
    assert.deepEqual([kept.status, kept.text], ["cancelled", "Partial summary"]);
    assert.equal(await refusal(hive.call("chat.cancel", { replyId: reply.id }, lead)), "errors.chatReplyEnded");
  });

  it("holds a pending reply during an app update and delivers it when intake resumes", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    const sent = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Wait for the update" }, lead);
    const draining = await beat(mbp, { acceptsRuns: false, updateDraining: true });
    assert.equal(draining.supportsUpdateDrain, true);
    assert.deepEqual(draining.chatRequests, []);
    const kept = await hive.call("chat.get", { threadId: sent.thread.id }, lead);
    assert.equal(kept!.messages.find((m) => m.id === sent.reply.id)!.status, "pending");
    assert.equal((await beat(mbp)).chatRequests[0]!.replyId, sent.reply.id);
  });

  it("expires a reply nobody took, fails one gone silent, and fails waiting ones when the machine stops taking runs", async () => {
    const { hive, beat, later } = await hub();
    await beat(mbp);
    const first = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "one" }, lead);
    later(16);
    await beat(mbp);
    const status = async (id: number) => {
      const got = await hive.call("chat.get", { threadId: first.thread.id }, lead);
      const m = got!.messages.find((x) => x.id === id)!;
      return [m.status, m.error?.key];
    };
    assert.deepEqual(await status(first.reply.id), ["expired", "errors.chatNotTaken"]);

    const second = await hive.call("chat.send", { project: "app", threadId: first.thread.id, text: "two" }, lead);
    await hive.call("chat.progress", { replyId: second.reply.id, text: "…" }, mbp);
    later(16);
    await beat(mbp);
    assert.deepEqual(await status(second.reply.id), ["failed", "errors.chatSilent"]);

    const third = await hive.call("chat.send", { project: "app", threadId: first.thread.id, text: "three" }, lead);
    assert.deepEqual((await beat(mbp, { acceptsRuns: false })).chatRequests, []);
    assert.deepEqual(await hive.call("chat.poll", {}, mbp), [], "nothing while it does not take runs from the hub");
    assert.deepEqual(await status(third.reply.id), ["failed", "errors.machineNoHubRuns"]);
  });

  it("lists the threads a reader sees, most recent first, and cleans what the machine writes", async () => {
    const { hive, beat, later } = await hub();
    await beat(mbp);
    const app = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "app question" }, lead);
    later(1);
    await beat(mbp);
    const site = await hive.call("chat.send", { project: "site", machineId: mbp.name, text: "site question" }, admin);
    assert.deepEqual((await hive.call("chat.threads", {}, admin)).map((t) => t.id), [site.thread.id, app.thread.id]);
    assert.deepEqual((await hive.call("chat.threads", {}, lead)).map((t) => t.id), [app.thread.id]);
    assert.equal(await refusal(hive.call("chat.threads", { project: "site" }, lead)), "errors.notFound");
    assert.equal(await refusal(hive.call("chat.get", { threadId: site.thread.id }, lead)), "errors.notFound");

    const secret = `ghp_${"a".repeat(36)}`;
    const done = await hive.call("chat.finish", { replyId: app.reply.id, status: "done", text: `The key:\ntoken ${secret}\nend`, error: { message: "safe", vars: { detail: secret } } }, mbp);
    assert.ok(!done.text.includes(secret), "a secret-looking line is hidden");
    assert.ok(!JSON.stringify(done.error).includes(secret));
    assert.match(done.text, /^The key:\n.*\nend$/);
  });

  it("finds threads by title or message in any case, Vietnamese letters too, with % and _ as plain characters", async () => {
    const { hive, beat, later } = await hub();
    await beat(mbp);
    const login = await hive.call("chat.send", { project: "app", machineId: mbp.name, title: "Đăng nhập", text: "Lỗi khoá tài khoản" }, lead);
    await hive.call("chat.finish", { replyId: login.reply.id, status: "done", text: "Bộ đếm chưa reset: 100% chắc" }, mbp);
    later(1);
    await beat(mbp);
    const other = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Deploy plan_v2" }, lead);
    const found = async (query: string) => (await hive.call("chat.threads", { project: "app", query }, lead)).map((t) => t.id);
    assert.deepEqual(await found("đăng NHẬP"), [login.thread.id], "the title, whatever the case");
    assert.deepEqual(await found("KHOÁ"), [login.thread.id], "a message");
    assert.deepEqual(await found("reset"), [login.thread.id], "a reply");
    assert.deepEqual(await found("100%"), [login.thread.id]);
    assert.deepEqual(await found("D_ploy"), [], "_ is not a wildcard: Deploy does not match");
    assert.deepEqual(await found("plan_v2"), [other.thread.id]);
    assert.deepEqual(await found("  "), [other.thread.id, login.thread.id], "blank: every thread");
  });

  it("starts a project's chats with what it set, lets the person pick otherwise, and changes a thread's model later", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    await beat(mini);
    assert.deepEqual(await hive.call("chat.defaults", { project: "app" }, dev), {
      project: "app", machineId: null, profileId: null, model: null, effort: null, commands: ["git status", "git log", "git diff", "git show"], autoKinds: [], updatedBy: null, updatedAt: null,
    });
    const set = { project: "app", machineId: mini.name, profileId: "claude-1", model: "opus", effort: "high" as const };
    assert.equal(await refusal(hive.call("chat.setDefaults", set, dev)), "errors.need.projectSettings");
    assert.equal(await refusal(hive.call("chat.setDefaults", { ...set, machineId: "runner.ghost@ghost" }, lead)), "errors.machineNotFound");
    assert.equal(await refusal(hive.call("chat.setDefaults", { ...set, model: "--dangerously-skip-permissions" }, lead)), "bad_request", "a model is never an option");
    assert.equal((await hive.call("chat.setDefaults", set, lead)).updatedBy, "lan");

    // Nothing picked: the project's machine, plan, model and effort.
    const plain = await hive.call("chat.send", { project: "app", text: "Status?" }, lead);
    assert.deepEqual([plain.thread.machineId, plain.thread.profileId, plain.thread.model, plain.thread.effort], [mini.name, "claude-1", "opus", "high"]);
    const [request] = await hive.call("chat.poll", {}, mini);
    assert.deepEqual([request!.model, request!.effort], ["opus", "high"], "the machine hears them");
    // Picked: kept, even "the profile's own" (null).
    const own = await hive.call("chat.send", { project: "app", machineId: mbp.name, profileId: null, model: null, effort: "low", text: "Quick one" }, lead);
    assert.deepEqual([own.thread.machineId, own.thread.profileId, own.thread.model, own.thread.effort], [mbp.name, "claude-1", null, "low"]);

    const changed = await hive.call("chat.configure", { threadId: plain.thread.id, model: "sonnet", effort: null }, lead);
    assert.deepEqual([changed.model, changed.effort], ["sonnet", null]);
    assert.equal(await refusal(hive.call("chat.configure", { threadId: plain.thread.id, model: "haiku", effort: null }, dev)), "errors.need.chatUse");
    assert.equal(await refusal(hive.call("chat.defaults", { project: "app" }, outsider)), "errors.notFound");
  });

  it("keeps the commands a project's leader may run: read-only git until a manager sets others", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    assert.deepEqual((await hive.call("chat.defaults", { project: "app" }, dev)).commands, ["git status", "git log", "git diff", "git show"]);
    assert.equal(await refusal(hive.call("chat.setCommands", { project: "app", commands: ["git log"] }, dev)), "errors.need.projectSettings");
    for (const bad of ["git log; rm -rf /", "git log && curl x", "$(id)", "Git Log", "git --output=x", "a b c d e"]) {
      assert.equal(await refusal(hive.call("chat.setCommands", { project: "app", commands: [bad] }, lead)), "bad_request", bad);
    }
    const set = await hive.call("chat.setCommands", { project: "app", commands: ["git log", "npm test", "git log"] }, lead);
    assert.deepEqual(set.commands, ["git log", "npm test"], "once each");
    // Setting the other defaults keeps the list, and the other way round.
    await hive.call("chat.setDefaults", { project: "app", machineId: mbp.name, profileId: null, model: "opus", effort: null }, lead);
    const both = await hive.call("chat.defaults", { project: "app" }, lead);
    assert.deepEqual([both.commands, both.model, both.machineId], [["git log", "npm test"], "opus", mbp.name]);
    await hive.call("chat.send", { project: "app", text: "Log?" }, lead);
    const [request] = await hive.call("chat.poll", {}, mbp);
    assert.deepEqual(request!.commands, ["git log", "npm test"], "the machine hears them with each reply");
    assert.deepEqual((await hive.call("chat.setCommands", { project: "app", commands: [] }, lead)).commands, [], "none at all");
  });

  it("lets a project manager rename a thread and delete it once no reply is pending", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    const sent = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Plan the reset page" }, lead);
    assert.equal((await hive.call("chat.rename", { threadId: sent.thread.id, title: "  Reset page  " }, lead)).title, "Reset page");
    assert.equal(await refusal(hive.call("chat.rename", { threadId: sent.thread.id, title: "x" }, dev)), "errors.need.chatUse");
    assert.equal(await refusal(hive.call("chat.rename", { threadId: sent.thread.id, title: "x" }, outsider)), "errors.notFound");
    assert.equal(await refusal(hive.call("chat.rename", { threadId: sent.thread.id, title: "Hi​dden" }, lead)), "errors.hidden.zeroWidth");

    assert.equal(await refusal(hive.call("chat.delete", { threadId: sent.thread.id }, lead)), "errors.chatBusy", "the reply is still pending");
    await hive.call("chat.cancel", { replyId: sent.reply.id }, lead);
    assert.equal(await refusal(hive.call("chat.delete", { threadId: sent.thread.id }, dev)), "errors.need.chatUse");
    assert.deepEqual(await hive.call("chat.delete", { threadId: sent.thread.id }, lead), { deleted: sent.thread.id });
    assert.equal(await hive.call("chat.get", { threadId: sent.thread.id }, lead), null);
    assert.equal(await refusal(hive.call("chat.delete", { threadId: sent.thread.id }, lead)), "errors.chatNotFound");
  });
});

describe("what a chat leader proposes", () => {
  /** A thread on duy-mbp with a reply being written, and the leader as the hub's reply token makes it (agent, capped). */
  async function leading() {
    const { hive, beat, later } = await hub();
    await beat(mbp);
    await beat(mini);
    await hive.call("tasks.create", { id: "T-1", project: "app", title: "Sign in" }, admin);
    await hive.call("tasks.create", { id: "S-1", project: "site", title: "Landing" }, admin);
    const sent = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Plan the reset page" }, lead);
    await hive.call("chat.progress", { replyId: sent.reply.id, text: "Looking" }, mbp);
    const leader: Actor = { name: "claude-1.duy-mbp@chat-lan", role: "agent", access: { projects: { app: "contribute" } }, chatReply: sent.reply.id };
    return { hive, later, sent, leader };
  }

  const taskOf = async (hive: SqliteHive, id: string, actor: Actor) => (await hive.call("tasks.list", {}, actor)).find((t) => t.id === id) ?? null;

  const plan = () => ({
    kind: "plan.create" as const,
    spec: { key: "project/app/reset-plan", title: "Reset password", content: "# Reset password\nSend a single-use link." },
    // Deliberately reversed: dependencies, not array order, determine creation order.
    tasks: [
      { id: "PLAN-2", title: "Reset UI", acceptance: "Expired links show a useful error", dependsOn: ["PLAN-1"] },
      { id: "PLAN-1", title: "Reset API", acceptance: "A link can be used only once", dependsOn: ["T-1"] },
    ],
    batches: [{ title: "API", taskIds: ["PLAN-1"] }, { title: "UI", taskIds: ["PLAN-2"] }],
  });

  it("creates an entire plan once, with its spec, acceptance criteria and dependency order", async () => {
    const { hive, leader } = await leading();
    const a = await hive.call("chat.propose", { action: plan(), reason: "Requested reset" }, leader);
    assert.equal(a.status, "proposed");
    assert.equal(await taskOf(hive, "PLAN-1", lead), null);
    const done = await hive.call("chat.decide", { actionId: a.id, accept: true }, lead);
    assert.equal(done.status, "done", JSON.stringify(done.error));
    const policy = (await hive.call("sdlc.get", {}, lead)).projects.app;
    assert.equal(policy?.autoDispatch, true);
    const stored = JSON.parse(String(hive.db.prepare("SELECT value FROM settings WHERE key = 'sdlcPolicy'").get()?.value));
    assert.equal(stored.projects.app.autoDispatchBy, lead.name);
    assert.deepEqual(done.result, { specKey: plan().spec.key, taskIds: ["PLAN-2", "PLAN-1"] });
    assert.equal((await hive.call("docs.get", { key: plan().spec.key }, lead))?.content, plan().spec.content);
    const task = await taskOf(hive, "PLAN-2", lead);
    assert.deepEqual(task?.dependsOn, ["PLAN-1"]);
    assert.match(task?.note ?? "", /Expired links/);
    assert.match(task?.note ?? "", /project\/app\/reset-plan/);
    assert.equal(await refusal(hive.call("chat.decide", { actionId: a.id, accept: true }, lead)), "errors.chatActionDecided");
    hive.close();
  });

  it("validates cyclic dependencies, duplicate ids, batch order and spec scope before proposing", async () => {
    const { hive, leader } = await leading();
    const invalid = [
      { ...plan(), spec: { ...plan().spec, key: "org/reset-plan" } },
      { ...plan(), spec: { ...plan().spec, key: "project/site/reset-plan" } },
      { ...plan(), tasks: [plan().tasks[0]!, plan().tasks[0]!] },
      { ...plan(), batches: [...plan().batches].reverse() },
      { ...plan(), tasks: plan().tasks.map((t) => ({ ...t, dependsOn: [t.id === "PLAN-1" ? "PLAN-2" : "PLAN-1"] })), batches: [{ title: "All", taskIds: ["PLAN-1", "PLAN-2"] }] },
      { ...plan(), tasks: [{ ...plan().tasks[0]!, acceptance: "" }] },
    ];
    for (const action of invalid) await assert.rejects(hive.call("chat.propose", { action, reason: "Invalid" }, leader));
    assert.equal(await hive.call("docs.get", { key: plan().spec.key }, lead), null);
    hive.close();
  });

  it("allows a reviewed plan without enabling auto-dispatch", async () => {
    const { hive, leader } = await leading();
    try {
      const a = await hive.call("chat.propose", { action: plan(), reason: "Requested" }, leader);
      const done = await hive.call("chat.decide", { actionId: a.id, accept: true, autoDispatch: false }, lead);
      assert.equal(done.status, "done");
      assert.equal((await hive.call("sdlc.get", {}, lead)).projects.app?.autoDispatch, false);
    } finally { hive.close(); }
  });

  it("keeps the plan's auto-dispatch choice when accepting all reply actions", async () => {
    const { hive, leader } = await leading();
    try {
      const a = await hive.call("chat.propose", { action: plan(), reason: "Requested" }, leader);
      const done = await hive.call("chat.decideAll", { replyId: leader.chatReply!, accept: true, autoDispatch: { [a.id]: false } }, lead);
      assert.equal(done.find(action => action.id === a.id)?.status, "done");
      assert.equal((await hive.call("sdlc.get", {}, lead)).projects.app?.autoDispatch, false);
    } finally { hive.close(); }
  });

  it("rechecks conflicts when accepted and leaves no partial plan", async () => {
    const { hive, leader } = await leading();
    const a = await hive.call("chat.propose", { action: plan(), reason: "Requested reset" }, leader);
    await hive.call("tasks.create", { project: "app", id: "PLAN-2", title: "Already taken" }, lead);
    const failed = await hive.call("chat.decide", { actionId: a.id, accept: true }, lead);
    assert.equal(failed.status, "failed");
    assert.equal(await hive.call("docs.get", { key: plan().spec.key }, lead), null);
    assert.equal(await taskOf(hive, "PLAN-1", lead), null);
    hive.close();
  });

  it("runs plans only under configured autonomy, and dismissal writes nothing", async () => {
    const first = await leading();
    const a = await first.hive.call("chat.propose", { action: plan(), reason: "Requested" }, first.leader);
    assert.equal((await first.hive.call("chat.decide", { actionId: a.id, accept: false }, lead)).status, "dismissed");
    assert.equal(await first.hive.call("docs.get", { key: plan().spec.key }, lead), null);
    first.hive.close();
    const { hive, leader } = await leading();
    await hive.call("chat.setAutonomy", { project: "app", kinds: ["plan.create"] }, admin);
    const done = await hive.call("chat.propose", { action: plan(), reason: "Requested" }, leader);
    assert.equal(done.status, "done", JSON.stringify(done.error));
    assert.equal(done.auto, true);
    assert.equal(done.decidedBy, lead.name);
    assert.notEqual((await hive.call("sdlc.get", {}, admin)).projects.app?.autoDispatch, true, "a plan the leader ran alone leaves auto-dispatch off");
    hive.close();
  });

  it("keeps a cross-service system plan atomic when the approver lacks rights to a service", async () => {
    const { hive, leader } = await leading();
    await hive.call("systems.save", { name: "product", projects: ["app", "site"] }, admin);
    const action = { ...plan(), spec: { ...plan().spec, key: "system/product/reset-plan" }, tasks: plan().tasks.map((t) => ({ ...t, project: t.id === "PLAN-2" ? "site" : "app" })) };
    const wideLeader = { ...leader, access: { projects: { app: "contribute" as const, site: "contribute" as const } } };
    const a = await hive.call("chat.propose", { action, reason: "Across services" }, wideLeader);
    const failed = await hive.call("chat.decide", { actionId: a.id, accept: true }, lead);
    assert.equal(failed.status, "failed");
    assert.equal(await hive.call("docs.get", { key: action.spec.key }, admin), null);
    assert.equal(await taskOf(hive, "PLAN-1", admin), null);
    const b = await hive.call("chat.propose", { action, reason: "Across services" }, wideLeader);
    assert.equal((await hive.call("chat.decide", { actionId: b.id, accept: true }, admin)).status, "done");
    hive.close();
  });

  it("keeps a plan's task ids apart from the reply's other proposals, and logs what it made as tasks.create does", async () => {
    const { hive, leader } = await leading();
    await hive.call("chat.propose", { action: { kind: "task.create", id: "PLAN-1", title: "Taken" }, reason: "First" }, leader);
    assert.equal(await refusal(hive.call("chat.propose", { action: plan(), reason: "Requested" }, leader)), "errors.taskExists");
    const { hive: other, leader: second } = await leading();
    const a = await other.call("chat.propose", { action: plan(), reason: "Requested" }, second);
    assert.equal(await refusal(other.call("chat.propose", { action: { kind: "task.create", id: "PLAN-2", title: "Again" }, reason: "Twice" }, second)), "errors.taskExists");
    // A move of a task the plan makes is known before the plan runs, as for a task.create of the same reply.
    assert.equal((await other.call("chat.propose", { action: { kind: "task.update", id: "PLAN-1", status: "doing" }, reason: "Start" }, second)).status, "proposed");
    await other.call("chat.decide", { actionId: a.id, accept: true }, lead);
    const log = await other.call("admin.audit", { limit: 30 }, admin);
    assert.equal(log.find((e) => e.action === "tasks.create" && e.target === "PLAN-2")?.detail, "Reset UI · ← PLAN-1");
    assert.equal(log.find((e) => e.action === "docs.save" && e.target === plan().spec.key)?.detail, "v1");
    // A spec someone wrote in the meantime: the plan does not overwrite it.
    const b = await other.call("chat.propose", { action: { ...plan(), tasks: [{ ...plan().tasks[1]!, id: "PLAN-3" }], batches: [{ title: "API", taskIds: ["PLAN-3"] }] }, reason: "Again" }, second).catch((e: HiveError) => e.key);
    assert.equal(b, "errors.chatPlanSpecExists");
    hive.close();
    other.close();
  });

  it("does nothing until a project manager confirms, then runs it as that manager", async () => {
    const { hive, sent, leader } = await leading();
    assert.equal(await refusal(hive.call("tasks.create", { id: "T-2", project: "app", title: "Reset" }, leader)), "errors.need.taskManage", "it cannot itself");

    const create = await hive.call("chat.propose", { action: { kind: "task.create", id: "T-2", title: "Reset page", dependsOn: ["T-1"] }, reason: "Asked for in the chat" }, leader);
    assert.deepEqual([create.status, create.project, create.replyId, create.input], ["proposed", "app", sent.reply.id, { id: "T-2", project: "app", title: "Reset page", dependsOn: ["T-1"] }]);
    const run = await hive.call("chat.propose", { action: { kind: "run.dispatch", taskId: "T-1", role: "review" }, reason: "Check the sign-in" }, leader);
    assert.equal(run.input.machineId, mbp.name, "the chat's own machine unless it names another");
    const other = await hive.call("chat.propose", { action: { kind: "run.dispatch", taskId: "T-1", machine: "lan-mini" }, reason: "Faster machine" }, leader);
    assert.equal(other.input.machineId, mini.name, "a machine by its name");
    const move = await hive.call("chat.propose", { action: { kind: "task.update", id: "T-1", status: "blocked", note: "Waits for the mail server" }, reason: "Blocked" }, leader);
    assert.equal((await hive.call("tasks.list", { project: "app" }, admin)).length, 1, "nothing made yet");

    // The reply shows them, for the chat page.
    const [, reply] = (await hive.call("chat.get", { threadId: sent.thread.id }, lead))!.messages;
    assert.deepEqual(reply!.actions.map((a) => [a.kind, a.status]), [["task.create", "proposed"], ["run.dispatch", "proposed"], ["run.dispatch", "proposed"], ["task.update", "proposed"]]);

    // A contributor cannot confirm; a manager can, once.
    assert.equal(await refusal(hive.call("chat.decide", { actionId: create.id, accept: true }, dev)), "errors.need.chatApprove");
    const done = await hive.call("chat.decide", { actionId: create.id, accept: true }, lead);
    assert.deepEqual([done.status, done.result, done.decidedBy], ["done", { taskId: "T-2" }, "lan"]);
    assert.deepEqual((await hive.call("tasks.list", { project: "app" }, admin)).find((t) => t.id === "T-2")?.dependsOn, ["T-1"]);
    assert.equal(await refusal(hive.call("chat.decide", { actionId: create.id, accept: true }, admin)), "errors.chatActionDecided");

    const queued = await hive.call("chat.decide", { actionId: run.id, accept: true }, lead);
    const [request] = await hive.call("runs.requests", { project: "app" }, admin);
    assert.deepEqual([queued.status, queued.result, request!.requestedBy, request!.role, request!.machineId], ["done", { requestId: request!.id }, "lan", "review", mbp.name]);

    const dismissed = await hive.call("chat.decide", { actionId: move.id, accept: false }, lead);
    assert.equal(dismissed.status, "dismissed");
    assert.equal((await hive.call("tasks.list", { project: "app" }, admin)).find((t) => t.id === "T-1")?.status, "todo", "set aside: nothing ran");
  });

  it("keeps why a confirmed action failed, as the manager's own call would", async () => {
    const { hive, leader } = await leading();
    // The second run request of a task while the first waits for its machine.
    const first = await hive.call("chat.propose", { action: { kind: "run.dispatch", taskId: "T-1" }, reason: "Go" }, leader);
    const second = await hive.call("chat.propose", { action: { kind: "run.dispatch", taskId: "T-1", machine: "lan-mini" }, reason: "Again" }, leader);
    await hive.call("chat.decide", { actionId: first.id, accept: true }, lead);
    const failed = await hive.call("chat.decide", { actionId: second.id, accept: true }, lead);
    assert.equal(failed.status, "failed");
    assert.ok(failed.error?.key, "a key the page translates");
    assert.equal((await hive.call("runs.requests", { project: "app" }, admin)).length, 1);
  });

  it("confirms all of a reply in the order they build on each other, and stops at the first that fails", async () => {
    const { hive, sent, leader } = await leading();
    // A run for a task the same reply creates: proposed after it, confirmed after it.
    const move = await hive.call("chat.propose", { action: { kind: "task.update", id: "T-1", status: "doing" }, reason: "Start" }, leader);
    const create = await hive.call("chat.propose", { action: { kind: "task.create", id: "T-5", title: "Reset page" }, reason: "New" }, leader);
    const run = await hive.call("chat.propose", { action: { kind: "run.dispatch", taskId: "T-5" }, reason: "Go" }, leader);
    assert.equal(await refusal(hive.call("chat.propose", { action: { kind: "task.create", id: "T-5", title: "Again" }, reason: "r" }, leader)), "errors.taskExists");
    assert.equal(await refusal(hive.call("chat.decideAll", { replyId: sent.reply.id, accept: true }, dev)), "errors.need.chatApprove");

    const done = await hive.call("chat.decideAll", { replyId: sent.reply.id, accept: true }, lead);
    // The run went through: T-5 existed by then, made first although proposed second.
    assert.deepEqual(done.map((a) => [a.id, a.status]), [[move.id, "done"], [create.id, "done"], [run.id, "done"]]);
    assert.deepEqual((await hive.call("runs.requests", { project: "app" }, admin)).map((r) => [r.taskId, r.requestedBy]), [["T-5", "lan"]]);
  });

  it("moves a task before running it, whatever order the leader proposed them in", async () => {
    const { hive, sent, leader } = await leading();
    await hive.call("tasks.update", { id: "T-1", status: "done" }, admin);
    // Proposed the other way round: a run of a done task would be refused.
    const run = await hive.call("chat.propose", { action: { kind: "run.dispatch", taskId: "T-1" }, reason: "Again" }, leader);
    const reopen = await hive.call("chat.propose", { action: { kind: "task.update", id: "T-1", status: "todo", note: "Reopened" }, reason: "Found a bug" }, leader);
    const done = await hive.call("chat.decideAll", { replyId: sent.reply.id, accept: true }, lead);
    assert.deepEqual(done.map((a) => [a.id, a.status]), [[run.id, "done"], [reopen.id, "done"]]);
  });

  it("stops at the first action that fails, leaving the rest to decide; sets all aside at once", async () => {
    const { hive, sent, leader } = await leading();
    const bad = await hive.call("chat.propose", { action: { kind: "task.create", id: "T-6", title: "x", dependsOn: ["T-404"] }, reason: "r" }, leader);
    const later = await hive.call("chat.propose", { action: { kind: "task.update", id: "T-1", status: "blocked" }, reason: "r" }, leader);
    const after = await hive.call("chat.decideAll", { replyId: sent.reply.id, accept: true }, lead);
    assert.deepEqual(after.map((a) => [a.id, a.status]), [[bad.id, "failed"], [later.id, "proposed"]]);
    assert.ok(after[0]!.error?.key, "why, for the page to show");

    const aside = await hive.call("chat.decideAll", { replyId: sent.reply.id, accept: false }, lead);
    assert.deepEqual(aside.map((a) => a.status), ["failed", "dismissed"]);
    assert.equal((await hive.call("tasks.list", { project: "app" }, admin)).find((t) => t.id === "T-1")?.status, "todo");
    assert.equal(await refusal(hive.call("chat.decideAll", { replyId: 9999, accept: true }, admin)), "errors.chatReplyNotFound");
  });

  it("takes proposals only from the leader writing the reply, in the thread's project, while it writes", async () => {
    const { hive, sent, leader } = await leading();
    const action = { kind: "task.create" as const, id: "T-9", title: "x" };
    assert.equal(await refusal(hive.call("chat.propose", { action, reason: "r" }, lead)), "errors.chatProposeOnly", "a person creates tasks directly");
    assert.equal(await refusal(hive.call("chat.propose", { action, reason: "r" }, mbp)), "errors.chatProposeOnly", "so does the machine's own token");
    // Another project's task, a task it lacks, one that exists already, a machine the hub does not know.
    assert.equal(await refusal(hive.call("chat.propose", { action: { kind: "task.update", id: "S-1", status: "done" }, reason: "r" }, leader)), "errors.chatTaskNotFound");
    assert.equal(await refusal(hive.call("chat.propose", { action: { kind: "run.dispatch", taskId: "T-404" }, reason: "r" }, leader)), "errors.chatTaskNotFound");
    assert.equal(await refusal(hive.call("chat.propose", { action: { kind: "task.create", id: "T-1", title: "again" }, reason: "r" }, leader)), "errors.taskExists");
    assert.equal(await refusal(hive.call("chat.propose", { action: { kind: "run.dispatch", taskId: "T-1", machine: "ghost" }, reason: "r" }, leader)), "errors.machineNotFound");
    assert.equal(await refusal(hive.call("chat.propose", { action, reason: "Use​ this" }, leader)), "errors.hidden.zeroWidth", "a person reads it before confirming");

    for (let i = 0; i < 20; i++) await hive.call("chat.propose", { action: { ...action, id: `N-${i}` }, reason: "r" }, leader);
    assert.equal(await refusal(hive.call("chat.propose", { action, reason: "r" }, leader)), "errors.chatTooManyActions");

    await hive.call("chat.finish", { replyId: sent.reply.id, status: "done", text: "Proposed." }, mbp);
    assert.equal(await refusal(hive.call("chat.propose", { action: { ...action, id: "L-1" }, reason: "r" }, leader)), "errors.chatReplyEnded");
    // What it proposed stays to be decided after the reply ended.
    const [, reply] = (await hive.call("chat.get", { threadId: sent.thread.id }, lead))!.messages;
    assert.equal((await hive.call("chat.decide", { actionId: reply!.actions[0]!.id, accept: true }, lead)).status, "done");
  });
});

describe("the rest of the web a chat leader proposes (roadmap 29b)", () => {
  // Reviews code and confirms proposals in app, but neither runs agents nor sets the project up.
  const hoa: Actor = { name: "hoa", role: "member", access: { projects: { app: "reviewer" } } };
  const report = {
    machine: [
      { id: "cli:codex", label: "Codex CLI", state: "missing" as const, detail: "Chưa cài", action: "Cài bằng npm" },
      { id: "shim", label: "Lệnh hive-mcp", state: "manual" as const, detail: "không có trong PATH", action: null },
    ],
    projects: [
      { project: "app", repo: "/Users/duy/app", items: [{ id: "app:codegraph-index", label: "Index codegraph", state: "missing" as const, detail: "Chưa tạo", action: "Tạo index" }] },
      { project: "site", repo: "/Users/duy/site", items: [{ id: "site:codegraph-index", label: "Index codegraph", state: "missing" as const, detail: "Chưa tạo", action: "Tạo index" }] },
    ],
  };
  const pushed = (over: Record<string, unknown> = {}) => ({
    runId: "R-run1",
    project: "app",
    taskId: "T-1",
    taskTitle: "Sign in",
    role: "implement" as const,
    status: "running" as const,
    profileId: "claude-1",
    createdAt: "2026-09-29T07:50:00.000Z",
    ...over,
  });

  /**
   * duy-mbp reports plans with priorities and what it could install, and runs of app: one running, one ended, one with
   * an MR, one with an MR lan asked for herself; and one of site. The leader writes a reply in an app thread.
   */
  async function ops() {
    const { hive, beat } = await hub();
    await beat(mbp, {
      profiles: [profile("claude-1", { priority: 10 }), profile("codex-1", { priority: 20 })],
      setup: { checkedAt: "2026-09-29T07:59:00.000Z", report },
    });
    await beat(mini);
    await hive.call("tasks.create", { id: "T-1", project: "app", title: "Sign in" }, admin);
    await hive.call(
      "runs.push",
      {
        machine: "duy-mbp",
        runs: [
          pushed(),
          pushed({ runId: "R-done1", status: "succeeded", finishedAt: "2026-09-29T07:55:00.000Z" }),
          pushed({ runId: "R-mr1", status: "succeeded", mrUrl: "https://gitlab.example/team/app/-/merge_requests/7" }),
          pushed({ runId: "R-site1", project: "site", taskId: "S-1", taskTitle: "Landing" }),
        ],
      },
      mbp,
    );
    // Pushed on lan's token: the run is hers.
    await hive.call(
      "runs.push",
      { machine: "duy-mbp", runs: [pushed({ runId: "R-mine", status: "succeeded", mrUrl: "https://gitlab.example/team/app/-/merge_requests/8" })] },
      { ...mbp, onBehalf: "lan" },
    );
    const sent = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Clean up the runs" }, lead);
    await hive.call("chat.progress", { replyId: sent.reply.id, text: "Looking" }, mbp);
    const leader: Actor = { name: "claude-1.duy-mbp@chat-lan", role: "agent", access: { projects: { app: "contribute" } }, chatReply: sent.reply.id };
    const propose = (action: Record<string, unknown>) => hive.call("chat.propose", { action, reason: "Asked in the chat" } as never, leader);
    return { hive, sent, leader, propose };
  }

  it("stores the call each kind becomes, always on the chat's project", async () => {
    const { hive, propose } = await ops();
    assert.deepEqual((await propose({ kind: "run.cancel", machine: "duy-mbp", runId: "R-run1" })).input, { machineId: mbp.name, runId: "R-run1" });
    assert.deepEqual((await propose({ kind: "run.merge", machine: mbp.name, runId: "R-mr1" })).input, { machineId: mbp.name, runId: "R-mr1" });
    assert.deepEqual((await propose({ kind: "machine.profile", machine: "duy-mbp", profileId: "claude-1", enabled: false })).input, {
      machineId: mbp.name,
      profileId: "claude-1",
      enabled: false,
    });
    assert.deepEqual((await propose({ kind: "machine.profile", machine: "duy-mbp", profileId: "codex-1", priority: 1 })).input, { machineId: mbp.name, profileId: "codex-1", priority: 1 });
    // The part as it is now, for the card to show before and after.
    await hive.call("agentPolicy.set", { project: "app", policy: { autonomy: "edit" } }, admin);
    assert.deepEqual((await propose({ kind: "agent.policy", policy: { autonomy: "propose" } })).input, { project: "app", policy: { autonomy: "propose" }, before: { autonomy: "edit" } });
    assert.deepEqual((await propose({ kind: "agent.policy", policy: null })).input, { project: "app", policy: null, before: { autonomy: "edit" } });
    assert.deepEqual((await propose({ kind: "agents.stop" })).input, { project: "app" });
    assert.deepEqual((await propose({ kind: "agents.resume" })).input, { project: "app" });
    assert.deepEqual((await propose({ kind: "machine.install", machine: "duy-mbp", itemId: "cli:codex" })).input, { machineId: mbp.name, itemId: "cli:codex" });
    assert.deepEqual((await propose({ kind: "machine.install", machine: "duy-mbp", itemId: "app:codegraph-index" })).input, { machineId: mbp.name, itemId: "app:codegraph-index" });
    // Nothing ran yet.
    assert.equal((await hive.call("runs.get", { machineId: mbp.name, runId: "R-run1" }, admin))!.cancelRequestedBy, null);
    assert.deepEqual((await hive.call("agents.paused", {}, admin)).projects, []);
  });

  it("refuses what the hub knows is wrong, with a key the page translates", async () => {
    const { propose } = await ops();
    assert.equal(await refusal(propose({ kind: "run.cancel", machine: "duy-mbp", runId: "R-site1" })), "errors.chatRunNotFound", "another project's run");
    assert.equal(await refusal(propose({ kind: "run.cancel", machine: "lan-mini", runId: "R-run1" })), "errors.chatRunNotFound", "not that machine's");
    assert.equal(await refusal(propose({ kind: "run.cancel", machine: "ghost", runId: "R-run1" })), "errors.machineNotFound");
    assert.equal(await refusal(propose({ kind: "run.cancel", machine: "duy-mbp", runId: "R-done1" })), "errors.chatRunEnded");
    assert.equal(await refusal(propose({ kind: "run.merge", machine: "duy-mbp", runId: "R-run1" })), "errors.chatRunNoMr");
    assert.equal(await refusal(propose({ kind: "run.merge", machine: "duy-mbp", runId: "R-site1" })), "errors.chatRunNotFound");
    assert.equal(await refusal(propose({ kind: "machine.profile", machine: "duy-mbp", profileId: "gemini-1", enabled: true })), "errors.chatProfileNotFound");
    assert.equal(await refusal(propose({ kind: "machine.profile", machine: "duy-mbp", profileId: "claude-1" })), "errors.chatProfileNothing");
    assert.equal(await refusal(propose({ kind: "machine.install", machine: "duy-mbp", itemId: "site:codegraph-index" })), "errors.chatInstallOtherProject");
    assert.equal(await refusal(propose({ kind: "machine.install", machine: "ghost", itemId: "cli:codex" })), "errors.machineNotFound");
  });

  it("runs each as the person confirming it, with the method's own rights", async () => {
    const { hive, propose } = await ops();
    const cancel = await propose({ kind: "run.cancel", machine: "duy-mbp", runId: "R-run1" });
    const merge = await propose({ kind: "run.merge", machine: "duy-mbp", runId: "R-mr1" });
    const profileOff = await propose({ kind: "machine.profile", machine: "duy-mbp", profileId: "claude-1", enabled: false });
    const policy = await propose({ kind: "agent.policy", policy: { autonomy: "propose" } });
    const install = await propose({ kind: "machine.install", machine: "duy-mbp", itemId: "cli:codex" });
    const resume = await propose({ kind: "agents.resume" });
    // Last: stopping also ends the reply being written, after which it proposes nothing more.
    const stop = await propose({ kind: "agents.stop" });

    const done = await hive.call("chat.decide", { actionId: cancel.id, accept: true }, lead);
    assert.deepEqual([done.status, done.result], ["done", null]);
    assert.equal((await hive.call("runs.get", { machineId: mbp.name, runId: "R-run1" }, admin))!.cancelRequestedBy, "lan");

    assert.equal((await hive.call("chat.decide", { actionId: merge.id, accept: true }, hoa)).status, "done", "a reviewer merges");
    assert.equal((await hive.call("runs.get", { machineId: mbp.name, runId: "R-mr1" }, admin))!.merge?.requestedBy, "hoa");

    assert.equal((await hive.call("chat.decide", { actionId: policy.id, accept: true }, lead)).status, "done");
    assert.deepEqual((await hive.call("agentPolicy.get", {}, admin)).projects.app, { autonomy: "propose" });

    // A plan is its machine's owner's or a hub admin's; an install a hub admin's.
    assert.equal((await hive.call("chat.decide", { actionId: profileOff.id, accept: true }, admin)).status, "done");
    const m = (await hive.call("machines.list", {}, admin)).find((x) => x.id === mbp.name)!;
    assert.deepEqual(m.profileChanges.map((c) => [c.profileId, c.enabled]), [["claude-1", false]]);
    const installed = await hive.call("chat.decide", { actionId: install.id, accept: true }, admin);
    const [command] = (await hive.call("admin.machines", {}, admin)).find((x) => x.id === mbp.name)!.commands;
    assert.deepEqual([installed.status, installed.result, command!.itemId, command!.requestedBy], ["done", { commandId: command!.id }, "cli:codex", "duy"]);

    assert.equal((await hive.call("chat.decide", { actionId: stop.id, accept: true }, lead)).status, "done");
    assert.deepEqual((await hive.call("agents.paused", {}, admin)).projects, ["app"]);
    assert.equal((await hive.call("chat.decide", { actionId: resume.id, accept: true }, lead)).status, "done");
    assert.deepEqual((await hive.call("agents.paused", {}, admin)).projects, []);
  });

  it("fails a confirmed action its confirmer lacks the rights for, with no shortcut", async () => {
    const { hive, propose } = await ops();
    const cancel = await propose({ kind: "run.cancel", machine: "duy-mbp", runId: "R-run1" });
    const policy = await propose({ kind: "agent.policy", policy: { autonomy: "read" } });
    const profileOff = await propose({ kind: "machine.profile", machine: "duy-mbp", profileId: "claude-1", enabled: false });
    const install = await propose({ kind: "machine.install", machine: "duy-mbp", itemId: "cli:codex" });
    const mine = await propose({ kind: "run.merge", machine: "duy-mbp", runId: "R-mine" });
    const stop = await propose({ kind: "agents.stop" });

    const failed = async (actionId: number, who: Actor) => {
      const a = await hive.call("chat.decide", { actionId, accept: true }, who);
      assert.equal(a.status, "failed", a.kind);
      return a.error?.key;
    };
    assert.equal(await failed(cancel.id, hoa), "errors.need.runDispatch");
    assert.equal(await failed(stop.id, hoa), "errors.need.runDispatch");
    assert.equal(await failed(policy.id, hoa), "errors.need.projectSettings");
    assert.equal(await failed(profileOff.id, lead), "errors.machineProfileForbidden", "lan does not own duy-mbp");
    assert.equal(await failed(install.id, lead), "errors.roleTooLow", "a hub admin's alone");
    assert.equal(await failed(mine.id, lead), "errors.selfApprove", "not a merge of her own run");

    assert.equal((await hive.call("runs.get", { machineId: mbp.name, runId: "R-run1" }, admin))!.cancelRequestedBy, null);
    assert.deepEqual((await hive.call("agents.paused", {}, admin)).projects, []);
    assert.equal((await hive.call("agentPolicy.get", {}, admin)).projects.app, undefined);
    assert.deepEqual((await hive.call("admin.machines", {}, admin)).find((x) => x.id === mbp.name)!.commands, []);
  });

  it("confirms all in the spec's order: agents back before runs, stopped last", async () => {
    const { hive, sent, propose } = await ops();
    // The task first: a run may only name a task the reply already proposed to create. The rest the other way round.
    const create = await propose({ kind: "task.create", id: "T-7", title: "Reset page" });
    const stop = await propose({ kind: "agents.stop" });
    const run = await propose({ kind: "run.dispatch", taskId: "T-7" });
    const merge = await propose({ kind: "run.merge", machine: "duy-mbp", runId: "R-mr1" });
    const cancel = await propose({ kind: "run.cancel", machine: "duy-mbp", runId: "R-run1" });
    const resume = await propose({ kind: "agents.resume" });
    const install = await propose({ kind: "machine.install", machine: "duy-mbp", itemId: "cli:codex" });
    const profileOff = await propose({ kind: "machine.profile", machine: "duy-mbp", profileId: "claude-1", enabled: false });
    const policy = await propose({ kind: "agent.policy", policy: { autonomy: "edit" } });

    const done = await hive.call("chat.decideAll", { replyId: sent.reply.id, accept: true }, admin);
    assert.deepEqual(
      done.map((a) => a.status),
      done.map(() => "done"),
      JSON.stringify(done.map((a) => [a.kind, a.status, a.error?.key])),
    );
    const ids = [create, stop, run, merge, cancel, resume, install, profileOff, policy].map((a) => a.id);
    assert.deepEqual(done.map((a) => a.id), ids);
    // runs.cancel keeps no audit entry; the run says who cancelled it.
    const audited = ["tasks.create", "agentPolicy.set", "machines.setProfile", "admin.commandCreate", "agents.resume", "runs.merge", "runs.dispatch", "agents.stop"];
    const order = (await hive.call("admin.audit", { limit: 100 }, admin))
      // Not the setup's own task T-1.
      .filter((e) => audited.includes(e.action) && e.actor === "duy" && !(e.action === "tasks.create" && e.target !== "T-7"))
      .reverse()
      .map((e) => e.action);
    assert.deepEqual(order, audited);
    assert.equal((await hive.call("runs.get", { machineId: mbp.name, runId: "R-run1" }, admin))!.cancelRequestedBy, "duy");
  });
});

describe("the hub-wide chat (roadmap 37)", () => {
  /**
   * lan-mini holds the hub-wide chat with no repo of its own, duy-mbp has app and site, and each project has a task and
   * a run. `leader` is the token the hub would cut for the reply being written.
   */
  async function hubChat() {
    const { hive, beat, later } = await hub();
    // The machine that runs the hub-wide leader needs no project checked out, at this heartbeat or any later one.
    const beatHub = () => beat(mini, { projects: [] });
    await beatHub();
    await beat(mbp);
    await hive.call("tasks.create", { id: "T-1", project: "app", title: "Sign in" }, admin);
    await hive.call("tasks.create", { id: "S-1", project: "site", title: "Landing" }, admin);
    await hive.call(
      "runs.push",
      {
        machine: "duy-mbp",
        runs: [
          { runId: "R-app1", project: "app", taskId: "T-1", taskTitle: "Sign in", role: "implement" as const, status: "running" as const, profileId: "claude-1", createdAt: "2026-09-29T07:50:00.000Z" },
          { runId: "R-site1", project: "site", taskId: "S-1", taskTitle: "Landing", role: "implement" as const, status: "running" as const, profileId: "claude-1", createdAt: "2026-09-29T07:50:00.000Z" },
        ],
      },
      mbp,
    );
    const sent = await hive.call("chat.send", { project: "*", machineId: mini.name, text: "Tidy up every project" }, admin);
    await hive.call("chat.progress", { replyId: sent.reply.id, text: "Looking" }, mini);
    // What ChatGrants hands the leader: a hub admin narrowed by the machine's own token, so never a hub admin itself.
    const leader: Actor = { name: "claude-1.lan-mini@chat-duy", role: "agent", chatReply: sent.reply.id };
    const propose = (action: Record<string, unknown>) => hive.call("chat.propose", { action, reason: "Asked in the chat" } as never, leader);
    return { hive, beat, beatHub, later, sent, leader, propose };
  }

  it("is a hub admin's alone to open, and nobody else sees it in their threads", async () => {
    const { hive, beat } = await hub();
    await beat(mini, { projects: [] });
    const open = (who: Actor) => refusal(hive.call("chat.send", { project: "*", machineId: mini.name, text: "hi" }, who));
    assert.equal(await open(lead), "errors.hubAdminOnly");
    assert.equal(await open(dev), "errors.hubAdminOnly");
    assert.equal(await open(projectAdmin), "errors.hubAdminOnly", "an admin of some projects is not the hub's");
    assert.equal(await open(mini), "errors.hubAdminOnly", "nor is a machine's own token");

    // No repo for any project: the hub-wide leader reads the board, not a checkout.
    const hubThread = await hive.call("chat.send", { project: "*", machineId: mini.name, text: "Tidy up every project" }, admin);
    assert.deepEqual([hubThread.thread.project, hubThread.thread.machine], ["*", "lan-mini"]);
    await hive.call("chat.finish", { replyId: hubThread.reply.id, status: "done", text: "Done." }, mini);
    await beat(mbp);
    const appThread = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "app question" }, lead);

    assert.deepEqual((await hive.call("chat.threads", {}, admin)).map((t) => t.id).sort(), [hubThread.thread.id, appThread.thread.id].sort());
    for (const who of [lead, projectAdmin]) {
      assert.deepEqual((await hive.call("chat.threads", {}, who)).map((t) => t.id), [appThread.thread.id], `${who.name} never sees it`);
    }
    assert.deepEqual((await hive.call("chat.threads", {}, mini)).map((t) => t.id), [appThread.thread.id], "nor does an unrestricted agent token");
    assert.equal(await refusal(hive.call("chat.threads", { project: "*" }, lead)), "errors.hubAdminOnly");

    const id = hubThread.thread.id;
    assert.equal(await refusal(hive.call("chat.get", { threadId: id }, projectAdmin)), "errors.hubAdminOnly");
    assert.equal(await refusal(hive.call("chat.rename", { threadId: id, title: "x" }, lead)), "errors.hubAdminOnly");
    assert.equal(await refusal(hive.call("chat.configure", { threadId: id, model: "opus", effort: null }, lead)), "errors.hubAdminOnly");
    assert.equal(await refusal(hive.call("chat.cancel", { replyId: hubThread.reply.id }, lead)), "errors.hubAdminOnly");
    assert.equal(await refusal(hive.call("chat.defaults", { project: "*" }, lead)), "errors.hubAdminOnly");
    assert.equal(await refusal(hive.call("chat.setCommands", { project: "*", commands: [] }, lead)), "errors.hubAdminOnly");
    assert.equal(await refusal(hive.call("chat.setAutonomy", { project: "*", kinds: [] }, projectAdmin)), "errors.hubAdminOnly");
    assert.equal(await refusal(hive.call("chat.setDefaults", { project: "*", machineId: mini.name, profileId: null, model: null, effort: null }, lead)), "errors.hubAdminOnly");
    assert.deepEqual((await hive.call("chat.setCommands", { project: "*", commands: ["git log"] }, admin)).commands, ["git log"]);
    assert.equal(await refusal(hive.call("chat.delete", { threadId: id }, lead)), "errors.hubAdminOnly");
    assert.deepEqual(await hive.call("chat.delete", { threadId: id }, admin), { deleted: id });
  });

  it("hands the machine every project of the hub, with its systems and who has its repo", async () => {
    const { hive, beat, beatHub, sent } = await hubChat();
    await hive.call("systems.save", { name: "shop", projects: ["app", "site"] }, admin);
    // Shared memory is kept under "" and a system's under sys:<name>: neither is a project of the hub.
    await hive.call("memory.write", { shared: true, kind: "decision", content: "Every project tags its releases" }, admin);
    await hive.call("memory.write", { system: "shop", kind: "decision", content: "The services talk over the order event" }, admin);
    assert.deepEqual((await beatHub()).chatRequests, [], "the reply it already started is not sent again");

    await hive.call("chat.finish", { replyId: sent.reply.id, status: "done", text: "Looked." }, mini);
    const again = await hive.call("chat.send", { project: "*", threadId: sent.thread.id, text: "and the costs?" }, admin);
    const [request] = (await beatHub()).chatRequests;
    assert.deepEqual([request!.replyId, request!.project], [again.reply.id, "*"]);
    assert.deepEqual(request!.projects, [
      { project: "app", systems: ["shop"], machines: ["duy-mbp"] },
      { project: "site", systems: ["shop"], machines: ["duy-mbp"] },
    ]);
    // A project's own thread is told nothing about the rest of the hub.
    await beat(mbp);
    const app = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "app question" }, lead);
    const [other] = (await beat(mbp)).chatRequests;
    assert.deepEqual([other!.replyId, other!.project, other!.projects], [app.reply.id, "app", undefined]);
  });

  it("makes every proposal name its project, and files what belongs to no project under the hub", async () => {
    const { hive, propose } = await hubChat();
    assert.equal(await refusal(propose({ kind: "task.create", id: "T-2", title: "Reset page" })), "errors.chatProjectRequired");
    assert.equal(await refusal(propose({ kind: "task.create", id: "T-2", title: "Reset page", project: "ghost" })), "errors.chatProjectUnknown");
    assert.equal(await refusal(propose({ kind: "task.update", id: "S-1", status: "doing", project: "app" })), "errors.chatTaskNotFound", "S-1 is site's");
    assert.equal(await refusal(propose({ kind: "run.cancel", machine: "duy-mbp", runId: "R-app1", project: "site" })), "errors.chatRunNotFound");
    assert.equal(await refusal(propose({ kind: "machine.install", machine: "duy-mbp", itemId: "app:codegraph-index" })), "errors.chatProjectRequired");
    assert.equal(await refusal(propose({ kind: "machine.install", machine: "duy-mbp", itemId: "app:codegraph-index", project: "site" })), "errors.chatInstallOtherProject");

    // Aimed at a project: chat_actions.project is that project, so Today and the filters stay right.
    const made = await propose({ kind: "task.create", id: "T-2", title: "Reset page", project: "app" });
    assert.deepEqual([made.project, made.input], ["app", { id: "T-2", project: "app", title: "Reset page", dependsOn: [] }]);
    assert.equal((await propose({ kind: "task.update", id: "S-1", status: "doing", project: "site" })).project, "site");
    assert.equal((await propose({ kind: "run.cancel", machine: "duy-mbp", runId: "R-site1", project: "site" })).project, "site");
    const stopApp = await propose({ kind: "agents.stop", project: "app" });
    assert.deepEqual([stopApp.project, stopApp.input], ["app", { project: "app" }]);

    // Belonging to no project: filed under "*", and the call it becomes says the whole hub.
    const profile = await propose({ kind: "machine.profile", machine: "duy-mbp", profileId: "claude-1", enabled: false });
    assert.equal(profile.project, "*", "a plan is the machine's, not a project's");
    assert.equal((await propose({ kind: "machine.install", machine: "duy-mbp", itemId: "cli:codex" })).project, "*");
    assert.equal((await propose({ kind: "machine.install", machine: "duy-mbp", itemId: "tool:rtk" })).project, "*");
    const stopAll = await propose({ kind: "agents.stop" });
    assert.deepEqual([stopAll.project, stopAll.input], ["*", { project: null }]);
    const policy = await propose({ kind: "agent.policy", policy: { autonomy: "propose" } });
    assert.deepEqual([policy.project, policy.input.project], ["*", null]);
    assert.deepEqual(policy.input.before, (await hive.call("agentPolicy.get", {}, admin)).hub, "the card shows the hub's default before and after");
    const forApp = await propose({ kind: "agent.policy", policy: { autonomy: "read" }, project: "app" });
    assert.deepEqual([forApp.project, forApp.input.project, forApp.input.before], ["app", "app", null]);
  });

  it("keeps hub attachments admin-only and forwards them in the chat request", async () => {
    const { hive, beat } = await hub();
    await beat(mini, { projects: [] });
    const input = { project: "*", name: "plan.txt", bytes: new TextEncoder().encode("Hub plan") };
    const member: Actor = { name: "member", role: "member" };
    assert.throws(() => hive.putChatFile(input, member), (e: unknown) => e instanceof HiveError && e.key === "errors.hubAdminOnly");
    const file = hive.putChatFile(input, admin);
    const sent = await hive.call("chat.send", { project: "*", machineId: mini.name, text: "Read the plan", files: [file.id] }, admin);
    assert.equal(hive.chatFile(file.id, member), null);
    assert.equal(hive.chatFile(file.id, admin)?.name, "plan.txt");
    const request = (await beat(mini, { projects: [] })).chatRequests.find((r) => r.replyId === sent.reply.id)!;
    assert.deepEqual(request.files?.map((f) => f.id), [file.id]);
  });

  it("keeps main's classification and assignment proposals scoped, and hides hub proposals from project readers", async () => {
    const { hive, propose } = await hubChat();
    for (const action of [
      { kind: "task.classify", id: "S-1", taskKind: "feature", size: "m", risk: "high" },
      { kind: "task.assign", taskId: "S-1", machine: "duy-mbp", profileId: "claude-1" },
    ]) {
      assert.equal(await refusal(propose(action)), "errors.chatProjectRequired");
      assert.equal(await refusal(propose({ ...action, project: "app" })), "errors.chatTaskNotFound");
      const proposed = await propose({ ...action, project: "site" });
      assert.equal(proposed.project, "site");
      assert.equal((await hive.call("chat.decide", { actionId: proposed.id, accept: true }, admin)).status, "done");
    }
    await propose({ kind: "task.create", id: "T-2", title: "Hub proposal", project: "app" });
    assert.equal((await hive.call("chat.pending", { project: "app" }, admin)).length, 1);
    assert.deepEqual(await hive.call("chat.pending", { project: "app" }, lead), []);
    assert.deepEqual(await hive.call("chat.pending", {}, { name: "reader", role: "viewer" }), []);
    assert.equal((await hive.call("projects.list", {}, admin)).some((p) => p.project === "*"), false);
  });

  it("lets one reply propose 50 things, where a project's chat stops at 20", async () => {
    const { hive, sent, propose } = await hubChat();
    for (let i = 0; i < 50; i++) await propose({ kind: "task.create", id: `N-${i}`, title: "x", project: "app" });
    assert.equal(await refusal(propose({ kind: "task.create", id: "N-50", title: "x", project: "app" })), "errors.chatTooManyActions");
    const reply = (await hive.call("chat.get", { threadId: sent.thread.id }, admin))!.messages.find((m) => m.id === sent.reply.id)!;
    assert.equal(reply.actions.length, 50);
  });

  it("is a hub admin's alone to confirm, and what is confirmed still goes through the method", async () => {
    const { hive, sent, propose } = await hubChat();
    const create = await propose({ kind: "task.create", id: "T-2", title: "Reset page", project: "app" });
    // lan leads app and may confirm her own project's chats; a proposal of the hub-wide chat is not hers to decide.
    assert.equal(await refusal(hive.call("chat.decide", { actionId: create.id, accept: true }, lead)), "errors.hubAdminOnly");
    assert.equal(await refusal(hive.call("chat.decide", { actionId: create.id, accept: true }, projectAdmin)), "errors.hubAdminOnly");
    assert.equal(await refusal(hive.call("chat.decideAll", { replyId: sent.reply.id, accept: true }, lead)), "errors.hubAdminOnly");
    assert.deepEqual([(await hive.call("chat.decide", { actionId: create.id, accept: true }, admin)).status, create.project], ["done", "app"]);
    assert.equal((await hive.call("tasks.list", { project: "app" }, admin)).some((t) => t.id === "T-2"), true);

    // No shortcut: the method runs with the confirmer's own call and refuses what it always refuses.
    const bad = await propose({ kind: "run.dispatch", taskId: "T-1", machine: "lan-mini", project: "app" });
    const failed = await hive.call("chat.decide", { actionId: bad.id, accept: true }, admin);
    assert.deepEqual([failed.status, failed.error?.key], ["failed", "errors.machineNoRepo"], "lan-mini holds the chat but has no app repo");
    assert.deepEqual(await hive.call("runs.requests", { project: "app" }, admin), []);

    const stop = await propose({ kind: "agents.stop" });
    assert.equal((await hive.call("chat.decide", { actionId: stop.id, accept: true }, admin)).status, "done");
    assert.equal((await hive.call("agents.paused", {}, admin)).hub, true, "no project named: the whole hub");
  });

  it("plans for a project it names, and across a system with a system spec", async () => {
    const { hive, propose } = await hubChat();
    await hive.call("systems.save", { name: "shop", projects: ["app", "site"] }, admin);
    const tasks = [
      { id: "P-1", title: "API", acceptance: "Returns the cart", project: "app" },
      { id: "P-2", title: "Page", acceptance: "Shows the cart", project: "site", dependsOn: ["P-1", "S-1"] },
    ];
    const action = { kind: "plan.create", spec: { key: "system/shop/cart", title: "Cart", content: "# Cart" }, tasks, batches: [{ title: "All", taskIds: ["P-1", "P-2"] }] };
    assert.equal(await refusal(propose(action)), "errors.chatProjectRequired");
    const a = await propose({ ...action, project: "app" });
    assert.equal(a.project, "app");
    const done = await hive.call("chat.decide", { actionId: a.id, accept: true }, admin);
    assert.equal(done.status, "done", JSON.stringify(done.error));
    const made = await hive.call("tasks.list", {}, admin);
    assert.deepEqual(made.find((t) => t.id === "P-2")?.project, "site");
    assert.deepEqual(made.find((t) => t.id === "P-2")?.dependsOn, ["P-1", "S-1"]);
  });

  it("runs on its own only what chat_defaults[\"*\"] allows, and never what always waits", async () => {
    const { hive, propose } = await hubChat();
    // The hub-wide leader has settings of its own: what app lets its leader do says nothing here.
    await hive.call("chat.setAutonomy", { project: "app", kinds: ["task.update"] }, lead);
    assert.equal(await refusal(hive.call("chat.setAutonomy", { project: "*", kinds: ["agent.policy"] }, admin)), "errors.chatAutoNever");
    assert.deepEqual((await hive.call("chat.setAutonomy", { project: "*", kinds: ["task.create"] }, admin)).autoKinds, ["task.create"]);

    const made = await propose({ kind: "task.create", id: "T-2", title: "Reset page", project: "app" });
    assert.deepEqual([made.status, made.auto, made.decidedBy], ["done", true, "duy"], "as the hub admin who wrote the message");
    assert.equal((await hive.call("tasks.list", { project: "app" }, admin)).some((t) => t.id === "T-2"), true);
    const entry = (await hive.call("admin.audit", { limit: 30 }, admin)).find((e) => e.action === "tasks.create" && e.target === "T-2")!;
    assert.deepEqual([entry.agent, entry.onBehalf], ["claude-1.lan-mini@chat-duy", "duy"], "the log says the leader acted for duy");

    // app's own auto kind does not follow the proposal into the hub-wide chat.
    assert.equal((await propose({ kind: "task.update", id: "T-1", status: "doing", project: "app" })).status, "proposed");
    assert.equal((await propose({ kind: "agent.policy", policy: { autonomy: "read" } })).status, "proposed", "loosening the leash always waits");
  });

  it("leaves a project's own chat exactly as it was", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    await hive.call("tasks.create", { id: "T-1", project: "app", title: "Sign in" }, admin);
    const sent = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Plan it" }, lead);
    await hive.call("chat.progress", { replyId: sent.reply.id, text: "Looking" }, mbp);
    const leader: Actor = { name: "claude-1.duy-mbp@chat-lan", role: "agent", access: { projects: { app: "contribute" } }, chatReply: sent.reply.id };
    const propose = (action: Record<string, unknown>) => hive.call("chat.propose", { action, reason: "r" } as never, leader);

    // No project named and none needed: everything is filed under the chat's own project, as before roadmap 37.
    assert.equal((await propose({ kind: "task.create", id: "T-2", title: "Reset" })).project, "app");
    assert.equal((await propose({ kind: "agents.stop" })).project, "app");
    assert.deepEqual((await propose({ kind: "agents.resume" })).input, { project: "app" });
    assert.equal((await propose({ kind: "machine.install", machine: "duy-mbp", itemId: "cli:codex" })).project, "app");
    // Still twenty to a reply, and a project outside its systems is still refused.
    assert.equal(await refusal(propose({ kind: "task.create", id: "T-9", title: "x", project: "site" })), "errors.chatProjectOutside");
    for (let i = 0; i < 16; i++) await propose({ kind: "task.create", id: `N-${i}`, title: "x" });
    assert.equal(await refusal(propose({ kind: "task.create", id: "N-20", title: "x" })), "errors.chatTooManyActions");
  });
});
