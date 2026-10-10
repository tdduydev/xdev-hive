import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SqliteHive } from "@xdev-hive/core/node";
import type { HubBuild } from "@xdev-hive/core";
import { createHubApp } from "#web/app.ts";
import { buildInfo, repoVersion } from "#web/build-info.ts";
import { HubInfoSource } from "#web/hubinfo.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";
import { adminSession, authHeaders } from "./session.ts";

describe("buildInfo", () => {
  it("reads the image's version, date and commit", () => {
    const b = buildInfo({ HIVE_COMMIT: "6dc8d24b", HIVE_BUILD_VERSION: "0.158.0+6dc8d24", HIVE_BUILD_DATE: "2026-10-10T08:30:00.123Z" }, "0.158.0");
    assert.deepEqual(b, { version: "0.158.0", commit: "6dc8d24b", buildVersion: "0.158.0+6dc8d24", buildDate: "2026-10-10T08:30:00.123Z" });
  });

  it("keeps the image's commit when compose sets HIVE_COMMIT to an empty string", () => {
    assert.equal(buildInfo({ HIVE_COMMIT: "", HIVE_BUILD_COMMIT: "6dc8d24b" }, "1.0.0").commit, "6dc8d24b");
    assert.equal(buildInfo({ HIVE_COMMIT: "abc1234", HIVE_BUILD_COMMIT: "6dc8d24b" }, "1.0.0").commit, "abc1234", "a commit set at run time wins");
  });

  it("gives nulls for a build without the args, and for a date that is not one", () => {
    assert.deepEqual(buildInfo({ HIVE_COMMIT: "", HIVE_BUILD_COMMIT: "", HIVE_BUILD_VERSION: " ", HIVE_BUILD_DATE: "" }, "1.0.0"), { version: "1.0.0", commit: null, buildVersion: null, buildDate: null });
    assert.equal(buildInfo({ HIVE_BUILD_DATE: "yesterday" }, "1.0.0").buildDate, null);
    assert.equal(buildInfo({ HIVE_BUILD_DATE: "2026-10-10T08:30:00Z" }, "1.0.0").buildDate, "2026-10-10T08:30:00.000Z");
  });

  it("takes the product version from the desktop app's package.json", () => {
    assert.match(repoVersion(), /^\d+\.\d+\.\d+$/);
    assert.equal(buildInfo({}).version, repoVersion());
  });
});

async function serve(build?: HubBuild) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-build-"));
  const dbPath = path.join(dir, "hub.db");
  const hive = new SqliteHive(dbPath);
  hive.seed("hub", { hub: true });
  const tokens = new TokenStore(hive.db);
  const users = new UserStore(hive.db);
  const admin = adminSession(users, "duy");
  const hub = new HubInfoSource({ hive, dbPath, users, commit: build?.commit, buildVersion: build?.buildVersion, buildDate: build?.buildDate });
  const app = createHubApp({ hive, tokens, users, allowedHosts: ["127.0.0.1"], hub, build });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    admin,
    close: () => {
      server.close();
      hive.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("the hub's build on /api/health and the Hub page", () => {
  const build: HubBuild = { version: "0.158.0", commit: "6dc8d24", buildVersion: "0.158.0+6dc8d24", buildDate: "2026-10-10T08:30:00.000Z" };

  it("answers anyone with the version, commit and build date, and nothing else", async () => {
    const s = await serve(build);
    try {
      const res = await fetch(`${s.base}/api/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(((await res.json()) as { result: unknown }).result, { ok: true, ...build });
      const info = await fetch(`${s.base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(s.admin) },
        body: JSON.stringify({ method: "hub.info" }),
      });
      const result = ((await info.json()) as { result: { commit: string; buildVersion: string; buildDate: string } }).result;
      assert.deepEqual([result.commit, result.buildVersion, result.buildDate], [build.commit, build.buildVersion, build.buildDate]);
    } finally {
      s.close();
    }
  });

  it("still says only ok when the app is made without a build", async () => {
    const s = await serve();
    try {
      assert.deepEqual(((await (await fetch(`${s.base}/api/health`)).json()) as { result: unknown }).result, { ok: true });
    } finally {
      s.close();
    }
  });
});
