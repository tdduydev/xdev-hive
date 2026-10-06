import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const runner: Actor = { name: "runner.mac", role: "agent", source: { via: "api", machine: "mac", run: "R-1", task: "T-1" } };

describe("completion journals (41d)", () => {
  for (const system of [false, true]) it(`journals a ${system ? "system service" : "standalone repo"}, once per task`, async (t) => {
    let date = new Date("2026-01-15T12:00:00Z");
    const hive = new SqliteHive(":memory:", { now: () => date });
    t.after(() => hive.close());
    if (system) await hive.call("systems.save", { name: "payment", projects: ["api", "web"] }, admin);
    await hive.call("tasks.create", { id: "T-1", project: "api", title: "Thanh toán" }, admin);
    await hive.call("tasks.update", { id: "T-1", status: "review", note: "ĐÃ LÀM: thanh toán mới.\nCHƯA LÀM: không có.\nCÁCH KIỂM: npm test.\nRỦI RO: cần theo dõi.\nTOKEN=glpat-abcdefghijklmnopqrstu" }, runner);
    hive.db.prepare(`INSERT INTO run_records(machine_id, machine, run_id, project, task_id, task_title, role, status, summary, mr_url, created_at, updated_at)
      VALUES ('runner.mac', 'mac', 'R-1', 'api', 'T-1', 'Thanh toán', 'implement', 'succeeded', 'ok', 'https://git.example/pr/1', '2026-01-01', '2026-01-01')`).run();
    const artifact = await hive.call("artifacts.put", { project: "api", taskId: "T-1", runId: "R-1", name: "report.md", data: Buffer.from("ok").toString("base64") }, runner);
    await hive.call("tasks.update", { id: "T-1", status: "done" }, admin);
    const prefix = system ? "system/payment" : "project/api";
    const pages = await hive.call("docs.list", { project: "api" }, admin);
    const journal = pages.find((d) => d.key.startsWith(`${prefix}/nhat-ky-`))!;
    assert.ok(journal);
    const doc = (await hive.call("docs.get", { key: journal.key }, admin))!;
    assert.equal(doc.parent, `${prefix}/nhat-ky`);
    assert.equal(doc.includeInAgents, false);
    assert.equal(doc.updatedBy, "hub");
    assert.match(doc.content, /thanh toán mới/);
    assert.match(doc.content, /cần theo dõi/);
    assert.doesNotMatch(doc.content, /npm test|không có|glpat-/);
    assert.match(doc.content, /line hidden/);
    assert.match(doc.content, /https:\/\/git.example\/pr\/1/);
    assert.match(doc.content, /#\/runs\?run=R-1/);
    assert.ok(doc.content.includes(`Artifact #${artifact.id}: [report.md](#/tasks?task=T-1)`));
    const versions = await hive.call("docs.history", { key: doc.key }, admin);
    assert.equal(versions[0]!.note, "Nhật ký: T-1");
    assert.equal(versions[0]!.source?.task, "T-1");
    await hive.call("tasks.update", { id: "T-1", status: "done" }, admin);
    assert.equal((await hive.call("docs.get", { key: doc.key }, admin))!.version, doc.version);
    await hive.call("tasks.update", { id: "T-1", status: "review", note: "ĐÃ LÀM: bổ sung.\nRỦI RO: ít." }, admin);
    // The original page stays the home of this task even after a month boundary.
    const oldKey = doc.key;
    date = new Date("2026-02-15T12:00:00Z");
    await hive.call("tasks.update", { id: "T-1", status: "done" }, admin);
    const updated = (await hive.call("docs.get", { key: oldKey }, admin))!;
    assert.equal(updated.content.split("<!-- task-journal:T-1 -->").length, 2);
    assert.match(updated.content, /bổ sung/);
    assert.doesNotMatch(updated.content, /thanh toán mới/);
    assert.match(updated.content, /Hoàn tất lại: 2026-02-15/);
    assert.equal((await hive.call("docs.list", { project: "api" }, admin)).filter((d) => d.key.startsWith(`${prefix}/nhat-ky-`)).length, 1);
    if (system) {
      assert.match((await hive.call("docs.get", { key: `${prefix}/tong-quan` }, admin))!.content, /\[\[system\/payment\/nhat-ky\|Nhật ký\]\]/);
      const outsider: Actor = { name: "other", role: "member", access: { projects: { other: "member" } } };
      await assert.rejects(hive.call("docs.get", { key: oldKey }, outsider));
    }
  });

  it("prepends new tasks and keeps existing page text", async (t) => {
    const hive = new SqliteHive(":memory:");
    t.after(() => hive.close());
    for (const id of ["T-1", "T-2"]) {
      await hive.call("tasks.create", { id, project: "api", title: id }, admin);
      await hive.call("tasks.update", { id, status: "done" }, admin);
      if (id === "T-1") {
        const page = (await hive.call("docs.list", { project: "api" }, admin)).find((d) => d.key.includes("nhat-ky-"))!;
        const doc = (await hive.call("docs.get", { key: page.key }, admin))!;
        await hive.call("docs.save", { key: doc.key, content: `${doc.content}\nGhi chú của người quản trị.\n`, baseVersion: doc.version }, admin);
      }
    }
    const page = (await hive.call("docs.list", { project: "api" }, admin)).find((d) => d.key.includes("nhat-ky-"))!;
    const doc = (await hive.call("docs.get", { key: page.key }, admin))!;
    assert.ok(doc.content.indexOf("task-journal:T-2") < doc.content.indexOf("task-journal:T-1"));
    assert.match(doc.content, /Ghi chú của người quản trị/);
    assert.equal(doc.version, 3);
  });
});
