import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { HiveError, type Actor } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const testTmpDirs = new Set<string>();
function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  testTmpDirs.add(dir);
  return dir;
}

const admin: Actor = { name: "duy", role: "admin" };
/** An agent on Lan's token, as the hub reads it from an MCP call (roadmap 27c, 2b). */
const claude: Actor = {
  name: "claude-1.lan-mbp@lan-mbp",
  role: "agent",
  access: { projects: { web: "member" } },
  source: { via: "mcp", machine: "lan-mbp", run: "R-abc123", task: "web-1" },
  agent: "claude-1",
  onBehalf: "lan",
};
/** A person of another project: the board's notes are not theirs to read. */
const other: Actor = { name: "minh", role: "member", access: { projects: { app: "lead" } } };
const key = (k: string) => (e: unknown) => e instanceof HiveError && e.key === k;

async function board(file = ":memory:", migrateTo?: number) {
  const hive = new SqliteHive(file, migrateTo === undefined ? {} : { migrateTo });
  await hive.call("tasks.create", { id: "web-1", project: "web", title: "Trang chủ" }, admin);
  return hive;
}

describe("task note history (roadmap 41a)", () => {
  it("keeps every handover, newest first, with the newest as the task's note", async () => {
    const hive = await board();
    await hive.call("tasks.claim", { id: "web-1" }, claude);
    await hive.call("tasks.update", { id: "web-1", status: "doing", note: "Bắt đầu: đọc spec." }, claude);
    await hive.call("tasks.update", { id: "web-1", status: "doing", note: "Đang làm: xong phần core." }, claude);
    await hive.call("tasks.update", { id: "web-1", status: "review", note: "ĐÃ LÀM: core + web.\nCÁCH KIỂM: npm test." }, claude);

    const notes = await hive.call("tasks.notes", { id: "web-1" }, admin);
    assert.deepEqual(notes.map((n) => n.version), [3, 2, 1], "newest first");
    assert.deepEqual(notes.map((n) => n.note), ["ĐÃ LÀM: core + web.\nCÁCH KIỂM: npm test.", "Đang làm: xong phần core.", "Bắt đầu: đọc spec."]);
    assert.deepEqual(notes.map((n) => n.status), ["review", "doing", "doing"], "the status it was moved to");
    const task = (await hive.call("tasks.list", { project: "web" }, admin))[0]!;
    assert.equal(notes[0]!.note, task.note, "the newest version is the task's note");
    assert.deepEqual([notes[0]!.author, notes[0]!.onBehalf, notes[0]!.source?.run], [claude.name, "lan", "R-abc123"], "who wrote it, for whom, from where");
    assert.equal(notes[0]!.taskId, "web-1");
    assert.equal((await hive.call("tasks.notes", { id: "web-1", limit: 2 }, admin)).length, 2, "a few of the latest");
  });

  it("keeps nothing for a status change with no note, and nothing for the same note twice", async () => {
    const hive = await board();
    await hive.call("tasks.update", { id: "web-1", status: "review", note: "Bàn giao." }, claude);
    await hive.call("tasks.update", { id: "web-1", status: "done" }, admin);
    await hive.call("tasks.update", { id: "web-1", status: "review" }, admin);
    assert.deepEqual((await hive.call("tasks.notes", { id: "web-1" }, admin)).map((n) => n.version), [1], "the audit log already has the moves");
    // A caller that sends its note again (the MR watcher, a copy between machine and hub) wrote no new handover.
    await hive.call("tasks.update", { id: "web-1", status: "done", note: "Bàn giao." }, admin);
    assert.deepEqual((await hive.call("tasks.notes", { id: "web-1" }, admin)).map((n) => n.version), [1]);
    // Clearing the note is not a handover either, and leaves the one that was written.
    await hive.call("tasks.update", { id: "web-1", status: "todo", note: "" }, admin);
    const task = (await hive.call("tasks.list", { project: "web" }, admin))[0]!;
    assert.equal(task.note, "");
    assert.deepEqual((await hive.call("tasks.notes", { id: "web-1" }, admin)).map((n) => n.note), ["Bàn giao."]);
  });

  it("hides a line that looks like a secret in both the note and its version, and refuses hidden characters", async () => {
    const hive = await board();
    await hive.call("tasks.update", { id: "web-1", status: "review", note: "Xong.\nTOKEN=glpat-abcdefghijklmnopqrstu\nHết." }, claude);
    const [kept] = await hive.call("tasks.notes", { id: "web-1" }, admin);
    const task = (await hive.call("tasks.list", { project: "web" }, admin))[0]!;
    assert.match(kept!.note, /line hidden/, "the line that looked like a token is gone");
    assert.doesNotMatch(kept!.note, /glpat-/);
    assert.equal(kept!.note, task.note, "the task's note and its version are the same text");

    await assert.rejects(hive.call("tasks.update", { id: "web-1", status: "review", note: "Xong​." }, claude), key("errors.hidden.zeroWidth"));
    assert.equal((await hive.call("tasks.notes", { id: "web-1" }, admin)).length, 1, "nothing half-written");
  });

  it("reads the notes of a project it may see only, and knows no task", async () => {
    const hive = await board();
    await hive.call("tasks.update", { id: "web-1", status: "review", note: "Bàn giao." }, claude);
    assert.equal((await hive.call("tasks.notes", { id: "web-1" }, claude)).length, 1, "the agent reads what it wrote");
    await assert.rejects(hive.call("tasks.notes", { id: "web-1" }, other), key("errors.notFound"));
    await assert.rejects(hive.call("tasks.notes", { id: "web-404" }, admin), key("errors.taskNotFound"));
  });

  /**
   * The notes already on a board become version 1, so the newest version is the task's note for old tasks too.
   * The board starts at the schema before 41a's migration; the note is written as a hub of then wrote it.
   */
  it("keeps the notes a board already had when the table is added", async () => {
    const file = path.join(testTmpDir(path.join(tmpdir(), "hive-notes-")), "hive.db");
    const hive = await board(file, migrationIndex("CREATE TABLE task_notes("));
    // Straight into the row: today's tasks.update would also keep a version, in a table this schema does not have.
    hive.db.prepare("UPDATE tasks SET note = ?, status = 'review' WHERE id = 'web-1'").run("Bàn giao cũ.");
    hive.close();

    let again: SqliteHive;
    try {
      again = new SqliteHive(file);
    } catch (err) {
      throw new Error(`upgrading from the schema before 41a failed (${String(err)})`);
    }
    const notes = await again.call("tasks.notes", { id: "web-1" }, admin);
    assert.deepEqual(notes.map((n) => [n.version, n.note, n.status, n.author]), [[1, "Bàn giao cũ.", "review", "hub"]]);
    assert.equal(notes[0]!.source, null, "nobody recorded where those were written");
    // A handover after the migration goes on from there.
    await again.call("tasks.update", { id: "web-1", status: "review", note: "Bàn giao mới." }, claude);
    assert.deepEqual((await again.call("tasks.notes", { id: "web-1" }, admin)).map((n) => n.version), [2, 1]);
    again.close();
  });
});

after(() => {
  for (const dir of testTmpDirs) rmSync(dir, { recursive: true, force: true });
});
