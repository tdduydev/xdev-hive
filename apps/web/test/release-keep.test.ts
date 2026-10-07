import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { ReleaseStore } from "#web/releases.ts";

it("keeps the builds of the newest releases and the rollout target, and says what went (DATA-cleanup-hub)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-release-keep-"));
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ReleaseStore(db, dir, undefined, 2);
    const add = (version: string) => store.addBytes({ version, channel: "stable", platform: "mac", arch: "arm64", kind: "zip", name: "mac.zip" }, Buffer.from(version));
    add("0.1.0");
    store.setRollout({ target: "0.1.0" }, "admin");
    for (const v of ["0.2.0", "0.3.0", "0.4.0"]) add(v);
    // add() prunes as it goes: 0.2.0 went when 0.4.0 came; the target 0.1.0 stays although it is the oldest.
    assert.deepEqual(["0.1.0", "0.2.0", "0.3.0", "0.4.0"].map((v) => existsSync(path.join(dir, v))), [true, false, true, true]);
    assert.deepEqual(store.storage(), { bytes: 15, versions: 3, keep: 2 });
    store.setRollout({ target: "0.4.0" }, "admin");
    assert.deepEqual(store.prune(), { versions: ["0.1.0"], bytes: 5 });
    assert.deepEqual(store.prune(), { versions: [], bytes: 0 }, "a second run finds nothing");
    assert.equal(store.list().length, 4, "rows stay, only files go");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
