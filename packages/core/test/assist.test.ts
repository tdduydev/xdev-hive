import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const lan: Actor = { name: "lan", role: "member", access: { projects: { app: "contribute" } } };
const hoa: Actor = { name: "hoa", role: "member", access: { projects: { app: "contribute", web: "view" } } };
const runner: Actor = { name: "runner@duy-mbp", role: "agent" };
const code = (c: string) => (e: unknown) => e instanceof HiveError && e.code === c;

async function setup(opts: { local?: boolean } = {}) {
  const clock = { at: Date.parse("2026-09-30T08:00:00.000Z") };
  const hive = new SqliteHive(":memory:", { now: () => new Date(clock.at), ...opts });
  await hive.call("docs.save", { key: "project/app/deploy", content: "# Deploy\nChạy update.sh", title: "Deploy" }, admin);
  await hive.call("docs.save", { key: "project/web/secret-plan", content: "Kế hoạch web", title: "Web" }, admin);
  await hive.call("docs.save", { key: "org/security", content: "Không ghi token vào tài liệu.", title: "Bảo mật" }, admin);
  const mem = await hive.call("memory.write", { project: "app", kind: "gotcha", content: "update.sh cần HIVE_TUNNEL=1" }, admin);
  const beat = () => hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", projects: ["app"], acceptsRuns: true }, runner);
  const later = (minutes: number) => (clock.at += minutes * 60_000);
  return { hive, mem, beat, later };
}

describe("the writing assistant's asks", () => {
  it("cleans generated text and structured error fields before storing an answer", async () => {
    const { hive, beat } = await setup();
    try {
      await hive.call("docs.assist", { key: "project/app/deploy", kind: "free", prompt: "test", content: "" }, lan);
      await beat();
      const job = await hive.call("docs.assistTake", { projects: ["app"] }, runner);
      const synthetic = "hivechat_" + "a".repeat(43);
      await hive.call("docs.assistFinish", { id: job!.id, status: "failed", reply: `safe\n${synthetic}`, markdown: synthetic, error: { message: synthetic, key: "errors.test", vars: { detail: synthetic, count: 2 } } }, runner);
      const [done] = await hive.call("docs.assists", { key: "project/app/deploy" }, lan);
      assert.ok(!JSON.stringify(done).includes(synthetic));
      assert.match(done!.reply, /safe/);
      assert.equal(done!.error?.key, "errors.test");
      assert.equal(done!.error?.vars?.count, 2);
    } finally { hive.close(); }
  });
  it("keeps the sources the person may see, of the page's space or the team's, and hands them to a machine that takes runs", async () => {
    const { hive, mem, beat } = await setup();
    const ask = await hive.call(
      "docs.assist",
      {
        key: "project/app/deploy",
        kind: "draft",
        prompt: "Viết tiếp phần còn thiếu",
        content: "# Deploy\nChạy update.sh\n## Khi lỗi",
        docs: ["org/security", "project/web/secret-plan", "project/app/nope"],
        memory: [mem.id],
        code: ["deploy/update.sh", "../etc/passwd", "/abs"],
      },
      lan,
    );
    assert.equal(ask.status, "pending");
    assert.deepEqual(ask.sources, ["page", "doc:org/security", `memory:${mem.id}`, "code:deploy/update.sh"], "another project's page is left out, and paths outside the repo");
    assert.equal(ask.base, "# Deploy\nChạy update.sh\n## Khi lỗi");

    assert.equal(await hive.call("docs.assistTake", { projects: ["app"] }, runner), null, "not a machine yet");
    await beat();
    assert.equal(await hive.call("docs.assistTake", { projects: ["web"] }, runner), null, "a machine without the project leaves it");
    const job = await hive.call("docs.assistTake", { projects: ["app"], machine: "duy-mbp" }, runner);
    assert.ok(job);
    assert.equal(job.status, "running");
    assert.equal(job.machine, "duy-mbp");
    assert.equal(job.title, "Deploy");
    assert.match(job.context, /Không ghi token/);
    assert.match(job.context, /HIVE_TUNNEL=1/);
    assert.doesNotMatch(job.context, /Kế hoạch web/);
    assert.deepEqual(job.code, ["deploy/update.sh"]);
    assert.equal(await hive.call("docs.assistTake", { projects: ["app"] }, runner), null, "taken once");

    assert.deepEqual(await hive.call("docs.assistProgress", { id: job.id }, runner), { cancelled: false });
    await assert.rejects(hive.call("docs.assistProgress", { id: job.id }, { name: "runner@other", role: "agent" }), code("not_found"), "only the machine that took it");
    await hive.call("docs.assistFinish", { id: job.id, status: "done", reply: "Thêm mục Khi lỗi.", markdown: "# Deploy\n## Khi lỗi\n- Chạy lại", profile: "claude-max-1", costUsd: 0.02 }, runner);
    const [done] = await hive.call("docs.assists", { key: "project/app/deploy" }, lan);
    assert.deepEqual([done!.status, done!.reply, done!.profile, done!.markdown?.split("\n")[1]], ["done", "Thêm mục Khi lỗi.", "claude-max-1", "## Khi lỗi"]);
    assert.equal((await hive.call("docs.assistSettle", { id: job.id, outcome: "applied" }, lan)).outcome, "applied");
  });

  it("shows each person their own asks, and lets them cancel them", async () => {
    const { hive, beat } = await setup();
    const ask = await hive.call("docs.assist", { key: "project/app/deploy", kind: "free", prompt: "Tóm tắt", content: "x" }, lan);
    assert.deepEqual(await hive.call("docs.assists", { key: "project/app/deploy" }, hoa), [], "hoa does not see lan's asks");
    await assert.rejects(hive.call("docs.assistCancel", { id: ask.id }, hoa), code("forbidden"));
    await assert.rejects(hive.call("docs.assistSettle", { id: ask.id, outcome: "dropped" }, hoa), code("not_found"));
    await beat();
    const job = await hive.call("docs.assistTake", { projects: ["app"] }, runner);
    assert.equal((await hive.call("docs.assistCancel", { id: ask.id }, lan)).status, "cancelled");
    assert.deepEqual(await hive.call("docs.assistProgress", { id: job!.id }, runner), { cancelled: true }, "the machine hears it and stops");
    assert.deepEqual(await hive.call("docs.assistFinish", { id: job!.id, status: "done", reply: "late" }, runner), { ok: false });
    await assert.rejects(hive.call("docs.assist", { key: "project/web/secret-plan", kind: "free", prompt: "x", content: "" }, hoa), code("forbidden"), "view is not enough to ask");
  });

  it("gives up on asks no machine took, or whose machine went silent", async () => {
    const { hive, beat, later } = await setup();
    await hive.call("docs.assist", { key: "project/app/deploy", kind: "free", prompt: "a", content: "" }, lan);
    later(16);
    const [gone] = await hive.call("docs.assists", { key: "project/app/deploy" }, lan);
    assert.deepEqual([gone!.status, gone!.error?.key], ["expired", "errors.assistNotTaken"]);
    await hive.call("docs.assist", { key: "project/app/deploy", kind: "free", prompt: "b", content: "" }, lan);
    await beat();
    await hive.call("docs.assistTake", { projects: ["app"] }, runner);
    later(16);
    const list = await hive.call("docs.assists", { key: "project/app/deploy" }, lan);
    assert.deepEqual([list.at(-1)!.status, list.at(-1)!.error?.key], ["failed", "errors.assistSilent"]);
  });

  it("is written by the machine's own runner in a database of its own (no hub)", async () => {
    const { hive } = await setup({ local: true });
    await hive.call("docs.assist", { key: "org/security", kind: "check", prompt: "Kiểm tra", content: "Không ghi token.", code: ["src/**"] }, admin);
    const job = await hive.call("docs.assistTake", { projects: [], machine: "duy-mbp" }, runner);
    assert.equal(job?.docKey, "org/security");
    assert.deepEqual(job?.code, [], "a team page has no repo to read");
  });
});
