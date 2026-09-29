import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "../src/index.ts";
import { SqliteHive } from "../src/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const mini: Actor = { name: "runner.lan-mini@lan-mini", role: "agent" };
const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "manage" } } };
const dev: Actor = { name: "minh", role: "member", access: { projects: { app: "contribute" } } };
const outsider: Actor = { name: "khoa", role: "member", access: { projects: { site: "manage" } } };

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
  it("starts a thread on one machine, hands it the reply, and resumes the session for the next message", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    await beat(mini);
    const first = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Plan AUTH-13\nwith tests" }, lead);
    assert.deepEqual([first.thread.title, first.thread.machine, first.thread.busy, first.thread.createdBy], ["Plan AUTH-13", "duy-mbp", true, "lan"]);
    assert.deepEqual([first.message.role, first.message.author, first.message.text], ["user", "lan", "Plan AUTH-13\nwith tests"]);
    assert.deepEqual([first.reply.role, first.reply.status, first.reply.author], ["assistant", "pending", "claude@duy-mbp"]);

    assert.deepEqual((await beat(mini)).chatRequests, [], "only the thread's machine");
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
    assert.equal(await ask({}, dev), "errors.need.manage");
    assert.equal(await ask({}, mbp), "errors.need.manage", "an agent token never starts a chat");
    assert.equal(await ask({}, outsider), "errors.notFound");
    assert.equal(await ask({ machineId: undefined }), "errors.chatMachine");
    assert.equal(await ask({ machineId: "runner.nobody@x" }), "errors.machineNotFound");
    assert.equal(await ask({ profileId: "codex-1" }), "errors.chatNoClaude", "the leader runs on Claude Code");
    assert.equal(await ask({ text: "use ​this" }), "errors.hidden.zeroWidth");
    const site = await hive.call("chat.send", { project: "site", machineId: mbp.name, text: "hi" }, admin);
    assert.equal(await ask({ threadId: site.thread.id }), "errors.chatNotFound", "a thread of another project");

    await beat(mbp, { profiles: [profile("claude-1", { loggedIn: false }), profile("codex-1")] });
    assert.equal(await ask({}), "errors.chatNoClaude", "signed out");
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
    assert.equal(await refusal(hive.call("chat.cancel", { replyId: reply.id }, dev)), "errors.need.manage");
    assert.equal((await hive.call("chat.cancel", { replyId: reply.id }, lead)).status, "cancelled");
    assert.deepEqual(await hive.call("chat.progress", { replyId: reply.id, text: "Reading more" }, mbp), { cancelled: true });
    const kept = await hive.call("chat.finish", { replyId: reply.id, status: "done", text: "Partial summary" }, mbp);
    assert.deepEqual([kept.status, kept.text], ["cancelled", "Partial summary"]);
    assert.equal(await refusal(hive.call("chat.cancel", { replyId: reply.id }, lead)), "errors.chatReplyEnded");
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
    const done = await hive.call("chat.finish", { replyId: app.reply.id, status: "done", text: `The key:\ntoken ${secret}\nend` }, mbp);
    assert.ok(!done.text.includes(secret), "a secret-looking line is hidden");
    assert.match(done.text, /^The key:\n.*\nend$/);
  });
});
