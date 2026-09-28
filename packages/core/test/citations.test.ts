import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "../src/index.ts";
import { SqliteHive } from "../src/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const claude: Actor = { name: "claude@duy", role: "agent" };
const pm: Actor = { name: "pm", role: "viewer" };
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const code = (c: string) => (e: unknown) => e instanceof HiveError && e.code === c;

async function setup() {
  const hive = new SqliteHive(":memory:");
  const m = await hive.call(
    "memory.write",
    { project: "app", kind: "gotcha", content: "The pool must be closed in tests", files: ["src/db/pool.ts", "src/db", "src/new.ts", "src/db/pool.ts"] },
    claude,
  );
  const check = (files: Array<[string, string | null]>) =>
    hive.call("memory.checkFiles", { project: "app", files: files.map(([path, sha]) => ({ path, sha })) }, claude);
  const get = async () => (await hive.call("memory.list", { project: "app" }, admin)).find((x) => x.id === m.id)!;
  return { hive, m, check, get };
}

describe("memory that cites files", () => {
  it("keeps each cited path once and refuses paths outside the repo", async () => {
    const { hive, m } = await setup();
    assert.deepEqual(m.files, [
      { path: "src/db/pool.ts", sha: null },
      { path: "src/db", sha: null },
      { path: "src/new.ts", sha: null },
    ]);
    for (const bad of ["/etc/passwd", "../secrets", "src//x.ts", "src\\x.ts", "src/../../x"]) {
      await assert.rejects(hive.call("memory.write", { project: "app", kind: "context", content: "x", files: [bad] }, claude), code("bad_request"), bad);
    }
  });

  it("takes a baseline first, flags a changed or gone file, and clears the flag when it comes back", async () => {
    const { check, get } = await setup();
    assert.deepEqual(await check([["src/db/pool.ts", A], ["src/db", B], ["src/new.ts", null]]), { flagged: 0, baselined: 2 });
    assert.equal((await get()).review, null, "a file not on the branch yet waits instead of being flagged");

    assert.deepEqual(await check([["src/db/pool.ts", C], ["src/db", B], ["src/new.ts", null]]), { flagged: 1, baselined: 0 });
    let m = await get();
    assert.deepEqual([m.review?.changed, m.review?.missing], [["src/db/pool.ts"], []]);
    const flaggedAt = m.review!.at;

    await check([["src/db/pool.ts", C], ["src/db", null], ["src/new.ts", null]]);
    m = await get();
    assert.deepEqual([m.review?.changed, m.review?.missing, m.review?.at], [["src/db/pool.ts"], ["src/db"], flaggedAt]);

    await check([["src/db/pool.ts", A], ["src/db", B], ["src/new.ts", null]]);
    assert.equal((await get()).review, null, "both files are back to their baseline");
  });

  it("takes the files as they are now when someone says the entry is still true", async () => {
    const { hive, m, check, get } = await setup();
    await check([["src/db/pool.ts", A], ["src/db", B]]);
    await check([["src/db/pool.ts", C], ["src/db", B]]);
    const kept = await hive.call("memory.keep", { id: m.id }, admin);
    assert.equal(kept.review, null);
    assert.deepEqual(kept.files.slice(0, 2), [
      { path: "src/db/pool.ts", sha: C },
      { path: "src/db", sha: B },
    ]);
    assert.deepEqual(await check([["src/db/pool.ts", C], ["src/db", B]]), { flagged: 0, baselined: 0 });
    assert.equal((await get()).review, null);
  });

  it("needs contribute access on the project to report files", async () => {
    const { hive } = await setup();
    await assert.rejects(hive.call("memory.checkFiles", { project: "app", files: [] }, pm), code("forbidden"));
    const lan: Actor = { name: "lan", role: "member", access: { projects: { app: "view" } } };
    await assert.rejects(hive.call("memory.checkFiles", { project: "app", files: [] }, lan), code("forbidden"));
    await assert.rejects(hive.call("memory.checkFiles", { project: "app", files: [{ path: "a.ts", sha: "not-an-id" }] }, claude), code("bad_request"));
  });
});
