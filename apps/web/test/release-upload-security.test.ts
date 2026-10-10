import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { it } from "node:test";
import type { Request, Response, RequestHandler } from "express";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp, UPLOAD_PART_BYTES } from "#web/app.ts";
import { ReleaseStore } from "#web/releases.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

it("bounds release upload streams, cleans oversized parts, and keeps small uploads working", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-upload-security-"));
  const hive = new SqliteHive(":memory:");
  const releases = new ReleaseStore(hive.db, dir);
  const app = createHubApp({ hive, releases, tokens: new TokenStore(hive.db), users: new UserStore(hive.db) });
  // Exercise the actual route with an authenticated fake request; no listener, sockets or real hub.
  const router = (app as unknown as { router: { stack: Array<{ route?: { path: string; stack: Array<{ handle: RequestHandler }> } }> } }).router;
  const route = router.stack.find((layer) => layer.route?.path === "/api/releases/upload")!.route!;
  const handle = route.stack.at(-1)!.handle;
  const upload = async (chunks: Iterable<Buffer>, extra: Record<string, string> = {}) => {
    const req = Object.assign(Readable.from(chunks), { query: { version: "0.142.0", platform: "linux", arch: "x64", kind: "AppImage", name: "audit.AppImage", ...extra } });
    let status = 200;
    let body: any;
    const res = { locals: { actor: { name: "audit-admin", role: "admin", humanSession: "audit" } }, status: (n: number) => { status = n; return res; }, json: (v: unknown) => { body = v; return res; } };
    await handle(req as unknown as Request, res as unknown as Response, () => {});
    return { status, body };
  };
  try {
    function* oversized() { yield Buffer.alloc(UPLOAD_PART_BYTES); yield Buffer.from([1]); }
    const tooBig = await upload(oversized(), { upload: "a".repeat(16), part: "0", parts: "2" });
    assert.equal(tooBig.status, 400);
    assert.equal(tooBig.body.error.code, "bad_request");
    assert.deepEqual(readdirSync(dir), [], "the partial file is removed");
    const small = await upload([Buffer.from("audit build sentinel")]);
    assert.equal(small.status, 200);
    assert.equal(small.body.result.size, 20);
  } finally { hive.close(); rmSync(dir, { recursive: true, force: true }); }
});
