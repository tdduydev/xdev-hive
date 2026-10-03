import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveHash } from "#ui/lib/route.ts";

/** The pages of the app, as App.tsx has them: enough of them to tell a redirect from a page that exists. */
const PAGES = ["today", "tasks", "runs", "batches", "docs", "setup", "tools", "ops", "queue", "costs", "machines", "systems", "proposals"];
const web = (hash: string) => resolveHash(hash, { local: false, isPage: (id) => PAGES.includes(id) });
const local = (hash: string) => resolveHash(hash, { local: true, isPage: (id) => PAGES.includes(id) });

describe("addresses", () => {
  it("leaves a page that exists alone", () => {
    assert.deepEqual(web("#/runs"), { id: "runs", hash: null });
    assert.deepEqual(web("#/runs?run=R-1"), { id: "runs", hash: null });
    assert.deepEqual(local("#/today"), { id: "today", hash: null });
  });

  it("has no page for an address of its own", () => {
    assert.deepEqual(web("#/nope"), { id: null, hash: null });
    assert.deepEqual(web("#/"), { id: null, hash: null });
    assert.deepEqual(web(""), { id: null, hash: null });
  });

  it("sends the Web Admin's old addresses to the page that holds them (roadmap 35b)", () => {
    assert.deepEqual(web("#/admin"), { id: "ops", hash: "#/ops" });
    assert.deepEqual(web("#/admin/queue"), { id: "queue", hash: "#/queue" });
    assert.deepEqual(web("#/admin/quota"), { id: "machines", hash: "#/machines" });
    assert.deepEqual(web("#/admin/projects"), { id: "systems", hash: "#/systems" });
    assert.deepEqual(web("#/admin/nothing-like-it"), { id: "ops", hash: "#/ops" }, "an address nobody knows opens the overview");
    assert.deepEqual(web("#/admin/costs?range=7d"), { id: "costs", hash: "#/costs?range=7d" }, "the query comes along");
  });

  it("opens the board's address on Task, in both modes (roadmap 39f)", () => {
    assert.deepEqual(web("#/board"), { id: "tasks", hash: "#/tasks" });
    assert.deepEqual(local("#/board"), { id: "tasks", hash: "#/tasks" });
    assert.deepEqual(local("#/board?task=T-1"), { id: "tasks", hash: "#/tasks?task=T-1" }, "the link to one task still opens it");
  });

  it("sends Tool and Đợt chạy to the pages that took them over, on this machine only (roadmap 39f)", () => {
    assert.deepEqual(local("#/tools"), { id: "setup", hash: "#/setup" });
    assert.deepEqual(local("#/batches"), { id: "runs", hash: "#/runs" });
    assert.deepEqual(web("#/tools"), { id: "tools", hash: null }, "the web keeps the Tool page");
    assert.deepEqual(web("#/batches"), { id: "batches", hash: null }, "and Đợt chạy");
  });

  it("follows an address that moved twice to where it ends", () => {
    assert.deepEqual(local("#/admin/tools"), { id: "setup", hash: "#/setup" }, "the Web Admin's Tool, then Dự án & công cụ");
    assert.deepEqual(web("#/admin/tools"), { id: "tools", hash: "#/tools" }, "on the web it stops at the Tool page");
    assert.deepEqual(local("#/admin/batches"), { id: "runs", hash: "#/runs" });
  });
});
