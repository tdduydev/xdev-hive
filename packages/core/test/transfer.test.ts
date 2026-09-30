import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { transferHive, type Actor, type TransferReport } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const agent: Actor = { name: "hive-transfer@duy-macbook", role: "agent" };

const results = (r: TransferReport, kind: string) =>
  Object.fromEntries(r.items.filter((i) => i.kind === kind).map((i) => [i.key, i.result]));

async function machine() {
  const hive = new SqliteHive(":memory:");
  await hive.call("docs.save", { key: "org/style", content: "Tabs" }, admin);
  await hive.call("docs.save", { key: "project/app/agents", content: "Chạy npm test trước khi commit" }, admin);
  await hive.call("memory.write", { project: "app", kind: "gotcha", content: "node:sqlite cần Node 24" }, admin);
  await hive.call("tasks.create", { id: "T-1", project: "app", title: "Thêm trang cài đặt" }, admin);
  await hive.call("tasks.create", { id: "T-2", project: "app", title: "Sửa đăng nhập" }, admin);
  await hive.call("tasks.claim", { id: "T-2" }, { name: "claude-1@duy", role: "agent" });
  await hive.call("tasks.create", { id: "T-3", project: "app", title: "Review MR" }, admin);
  await hive.call("tasks.update", { id: "T-3", status: "review", note: "Đã xong phần UI" }, admin);
  return hive;
}

describe("transferHive", () => {
  it("copies docs, approved memory and tasks, and is a no-op the second time", async () => {
    const local = await machine();
    const hub = new SqliteHive(":memory:", { memoryRequiresApproval: true });
    const push = () => transferHive({ backend: local, actor: admin, label: "máy duy-mbp" }, { backend: hub, actor: admin, label: "hub" });

    const first = await push();
    assert.deepEqual(first.counts, { added: 6, updated: 0, proposed: 0, unchanged: 0, skipped: 0, failed: 0 });
    assert.equal((await hub.call("docs.get", { key: "project/app/agents" }, admin))?.content, "Chạy npm test trước khi commit");
    assert.equal((await hub.call("memory.search", { project: "app", query: "sqlite" }, admin)).length, 1, "admin writes are approved");
    const tasks = Object.fromEntries((await hub.call("tasks.list", {}, admin)).map((t) => [t.id, t]));
    assert.equal(tasks["T-2"]!.status, "todo", "a task in progress arrives without its lease");
    assert.equal(tasks["T-2"]!.owner, null);
    assert.match(tasks["T-2"]!.note ?? "", /Đang làm ở máy duy-mbp bởi claude-1@duy/);
    assert.equal(tasks["T-3"]!.status, "review");
    assert.equal(tasks["T-3"]!.note, "Đã xong phần UI");

    const again = await push();
    assert.deepEqual(again.counts, { added: 0, updated: 0, proposed: 0, unchanged: 6, skipped: 0, failed: 0 });
  });

  it("turns a doc that differs into a proposal instead of overwriting it", async () => {
    const local = await machine();
    const hub = new SqliteHive(":memory:");
    await hub.call("docs.save", { key: "org/style", content: "Spaces" }, admin);
    const r = await transferHive({ backend: local, actor: admin, label: "máy duy-mbp" }, { backend: hub, actor: admin, label: "hub" });
    assert.equal(results(r, "doc")["org/style"], "proposed");
    assert.equal((await hub.call("docs.get", { key: "org/style" }, admin))?.content, "Spaces", "hub copy untouched");
    const [p] = await hub.call("proposals.list", { status: "pending" }, admin);
    assert.equal(p!.content, "Tabs");
    assert.match(p!.reason, /máy duy-mbp khác bản ở hub \(v1\)/);

    const again = await transferHive({ backend: local, actor: admin, label: "máy duy-mbp" }, { backend: hub, actor: admin, label: "hub" });
    assert.equal(results(again, "doc")["org/style"], "unchanged", "no duplicate proposal");
  });

  it("with an agent token: docs become proposals, memory waits for approval, tasks report the missing role", async () => {
    const local = await machine();
    const hub = new SqliteHive(":memory:", { memoryRequiresApproval: true });
    const r = await transferHive({ backend: local, actor: admin, label: "máy duy-mbp" }, { backend: hub, actor: agent, label: "hub" });
    assert.deepEqual(results(r, "doc"), { "org/style": "proposed", "project/app/agents": "proposed" });
    assert.equal(r.items.find((i) => i.kind === "memory")?.note, "chờ admin duyệt ở đích");
    assert.deepEqual(Object.values(results(r, "task")), ["failed", "failed", "failed"]);
    assert.match(r.items.find((i) => i.kind === "task")!.note!, /cần token admin/);
  });

  it("pulling saves the hub copy as a new version, and never moves untouched default docs", async () => {
    const local = new SqliteHive(":memory:");
    local.seed();
    await local.call("docs.save", { key: "project/app/agents", content: "bản cũ trên máy" }, admin);
    const hub = new SqliteHive(":memory:");
    hub.seed("hub");
    await hub.call("docs.save", { key: "project/app/agents", content: "bản của team" }, admin);
    const pull = await transferHive({ backend: hub, actor: admin, label: "hub" }, { backend: local, actor: admin, label: "máy này" }, { newVersions: true });
    assert.equal(results(pull, "doc")["project/app/agents"], "updated");
    assert.equal((await local.call("docs.get", { key: "project/app/agents" }, admin))?.content, "bản của team");
    assert.deepEqual((await local.call("docs.history", { key: "project/app/agents" }, admin)).map((v) => v.content), ["bản của team", "bản cũ trên máy"]);
    assert.ok(pull.items.filter((i) => i.key.startsWith("org/")).every((i) => i.result === "unchanged"), "same seed on both sides");

    await hub.call("docs.save", { key: "org/agent-protocol", content: "Sửa trên hub" }, admin);
    const push = await transferHive({ backend: local, actor: admin, label: "máy này" }, { backend: hub, actor: admin, label: "hub" });
    assert.equal(results(push, "doc")["org/agent-protocol"], "skipped", "the local default copy is not proposed over the hub edit");
    assert.equal((await hub.call("proposals.list", { status: "pending" }, admin)).length, 0);
  });

  it("skips pending memory and a task id that means something else at the target", async () => {
    const local = new SqliteHive(":memory:", { memoryRequiresApproval: true });
    await local.call("memory.write", { project: "app", kind: "context", content: "chưa duyệt" }, agent);
    await local.call("tasks.create", { id: "T-1", project: "app", title: "Việc A" }, admin);
    const hub = new SqliteHive(":memory:");
    await hub.call("tasks.create", { id: "T-1", project: "app", title: "Việc B" }, admin);
    const r = await transferHive({ backend: hub, actor: admin, label: "hub" }, { backend: local, actor: admin, label: "máy này" });
    assert.equal(results(r, "task")["T-1"], "skipped");
    const back = await transferHive({ backend: local, actor: admin, label: "máy này" }, { backend: hub, actor: admin, label: "hub" });
    assert.equal(back.items.filter((i) => i.kind === "memory").length, 0, "pending memory stays behind");
  });
});
