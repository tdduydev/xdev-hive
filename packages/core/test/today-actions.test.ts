import assert from "node:assert/strict";
import { it } from "node:test";
import { HiveError, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "reviewer", role: "admin" };
const writer: Actor = { name: "writer", role: "agent" };
const lead: Actor = { name: "lead", role: "member", access: { projects: { app: "lead" } } };
const member: Actor = { name: "member", role: "member", access: { projects: { app: "contribute" } } };
const forbidden = (e: unknown) => e instanceof HiveError && e.code === "forbidden";

it("sharing memory needs approval in both scopes, preserves identity and rejects linked entries", async () => {
  const hive = new SqliteHive(":memory:", { memoryRequiresApproval: true });
  try {
    const m = await hive.call("memory.write", { project: "app", kind: "decision", content: "Shared testing convention", files: ["test.ts"] }, writer);
    await assert.rejects(hive.call("memory.share", { id: m.id }, lead), forbidden);
    const shared = await hive.call("memory.share", { id: m.id }, admin);
    assert.equal(shared.project, null);
    assert.equal(shared.id, m.id);
    assert.equal(shared.status, "approved");
    assert.deepEqual(shared.files, m.files);
    await hive.call("policy.set", { selfApproval: "nobody" }, admin);
    const own = await hive.call("memory.write", { project: "app", kind: "decision", content: "Own convention" }, admin);
    await assert.rejects(hive.call("memory.share", { id: own.id }, admin), e => e instanceof HiveError && e.key === "errors.selfApprove");
    const a = await hive.call("memory.write", { project: "app", kind: "decision", content: "A" }, writer);
    const b = await hive.call("memory.write", { project: "app", kind: "decision", content: "B", contradicts: a.id }, writer);
    await assert.rejects(hive.call("memory.share", { id: b.id }, admin), e => e instanceof HiveError && e.code === "bad_request");
  } finally { hive.close(); }
});

it("stopping CI persists per project/MR and requires dispatch permission", async () => {
  const hive = new SqliteHive(":memory:");
  const input = { project: "app", mrUrl: "https://git.example/app/-/merge_requests/12" };
  try {
    assert.deepEqual(await hive.call("runs.ciPolicy", input, member), { fixCi: true });
    await assert.rejects(hive.call("runs.stopCi", input, member), forbidden);
    await hive.call("runs.stopCi", input, lead);
    await hive.call("runs.stopCi", input, lead);
    assert.deepEqual(await hive.call("runs.ciPolicy", input, member), { fixCi: false });
    assert.deepEqual(await hive.call("runs.ciPolicy", { ...input, mrUrl: `${input.mrUrl}3` }, member), { fixCi: true });
    assert.deepEqual(await hive.call("runs.ciPolicy", { ...input, project: "other" }, admin), { fixCi: true });
  } finally { hive.close(); }
});

it("review changes require codeReview, a note and an unchanged review status", async () => {
  const hive = new SqliteHive(":memory:");
  const reviewer: Actor = { name: "review", role: "member", access: { projects: { app: { permissions: ["view", "codeReview"] } } } };
  try {
    await hive.call("tasks.create", { project: "app", id: "T-1", title: "Review" }, admin);
    await hive.call("tasks.update", { id: "T-1", status: "review" }, admin);
    await assert.rejects(hive.call("tasks.requestChanges", { id: "T-1", note: "Add tests" }, member), forbidden);
    await assert.rejects(hive.call("tasks.requestChanges", { id: "T-1", note: " " }, reviewer));
    const changed = await hive.call("tasks.requestChanges", { id: "T-1", note: "Add tests" }, reviewer);
    assert.equal(changed.status, "todo");
    assert.equal(changed.note, "Add tests");
    await assert.rejects(hive.call("tasks.requestChanges", { id: "T-1", note: "Again" }, reviewer), e => e instanceof HiveError && e.code === "conflict");
  } finally { hive.close(); }
});
