import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { ReleaseStore } from "#web/releases.ts";

it("offers deb only to Debian installations and keeps AppImage for older clients", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-deb-release-"));
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ReleaseStore(db, dir);
    for (const kind of ["deb", "AppImage"]) {
      store.addBytes({ version: "0.80.0", channel: "stable", platform: "linux", arch: "x64", kind, name: `linux.${kind}` }, Buffer.from(kind));
    }
    store.setRollout({ target: "0.80.0", percent: 100, installWhen: "idle" }, "admin");
    assert.equal(store.offerFor("a", "0.75.0", "linux", "x64")?.file.kind, "AppImage");
    const deb = store.offerFor("a", "0.75.0", "linux", "x64", "deb");
    assert.equal(deb?.file.kind, "deb");
    assert.equal(deb?.installWhen, "ask");
    assert.equal(store.offerFor("a", "0.75.0", "linux", "arm64", "deb"), null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
