import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { describeBuild, importRelease } from "#web/import-release.ts";
import { ReleaseStore } from "#web/releases.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "hive-import-"));
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE audit(id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '')");
  const store = new ReleaseStore(db, path.join(root, "releases"));
  const incoming = (files: Record<string, string>, sums: Record<string, string> = files) => {
    const from = path.join(root, "incoming", String(Math.random()).slice(2));
    mkdirSync(from, { recursive: true });
    for (const [n, body] of Object.entries(files)) writeFileSync(path.join(from, n), body);
    writeFileSync(path.join(from, "SHA256SUMS.txt"), Object.entries(sums).map(([n, b]) => `${sha(b)}  ${n}`).join("\n") + "\n");
    return from;
  };
  return { root, db, store, incoming, done: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe("hub release import over SSH", () => {
  it("reads builds the way the HTTP upload does", () => {
    assert.deepEqual(describeBuild("xdev-hive-1.0.0-linux-amd64.deb"), { platform: "linux", arch: "x64", kind: "deb" });
    assert.deepEqual(describeBuild("xdev-hive-1.0.0-win-arm64-setup.exe"), { platform: "win", arch: "arm64", kind: "exe" });
    assert.equal(describeBuild("install-linux.sh"), null);
  });

  it("stores checked builds with their notes and an audit line, and skips what the hub already has", async () => {
    const s = setup();
    try {
      const files = { "xdev-hive-1.0.0-mac-arm64.zip": "mac", "xdev-hive-1.0.0-linux-x86_64.AppImage": "linux", "install-linux.sh": "#!/bin/sh" };
      const r = await importRelease({ db: s.db, store: s.store, from: s.incoming(files), version: "1.0.0", notes: "- notes", by: "ssh:duy" });
      assert.deepEqual(r.added, ["xdev-hive-1.0.0-linux-x86_64.AppImage", "xdev-hive-1.0.0-mac-arm64.zip"]);
      const release = s.store.list()[0]!;
      assert.equal(release.notes, "- notes");
      assert.deepEqual(release.files.map((f) => [f.platform, f.arch, f.kind, f.sha256]), [["linux", "x64", "AppImage", sha("linux")], ["mac", "arm64", "zip", sha("mac")]]);
      assert.equal(readFileSync(path.join(s.root, "releases", "1.0.0", "xdev-hive-1.0.0-mac-arm64.zip"), "utf8"), "mac");
      const audit = s.db.prepare("SELECT actor, action, target FROM audit ORDER BY id").all();
      assert.deepEqual(audit.map((a) => [a.actor, a.action]), [["ssh:duy", "releases.upload"], ["ssh:duy", "releases.upload"]]);
      const again = await importRelease({ db: s.db, store: s.store, from: s.incoming(files), version: "1.0.0", by: "ssh:duy" });
      assert.deepEqual(again.added, []);
      assert.equal(again.kept.length, 2);
    } finally { s.done(); }
  });

  it("stores nothing when a copy is damaged or a build is not in SHA256SUMS.txt", async () => {
    const s = setup();
    try {
      const damaged = s.incoming({ "xdev-hive-1.0.0-mac-arm64.zip": "mac", "xdev-hive-1.0.0-win-x64-setup.exe": "cut off" }, { "xdev-hive-1.0.0-mac-arm64.zip": "mac", "xdev-hive-1.0.0-win-x64-setup.exe": "whole" });
      await assert.rejects(importRelease({ db: s.db, store: s.store, from: damaged, version: "1.0.0", by: "ssh" }), /copy damaged/);
      assert.equal(s.store.list().length, 0, "the good build waits too: a release goes in whole");
      assert.ok(existsSync(path.join(damaged, "xdev-hive-1.0.0-mac-arm64.zip")));
      const unlisted = s.incoming({ "xdev-hive-1.0.0-mac-arm64.zip": "mac" }, {});
      await assert.rejects(importRelease({ db: s.db, store: s.store, from: unlisted, version: "1.0.0", by: "ssh" }), /not in SHA256SUMS/);
    } finally { s.done(); }
  });
});
