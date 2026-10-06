import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveHash, WEB_ALIASES } from "#ui/lib/route.ts";

/** The pages of the app, as App.tsx has them: enough of them to tell a redirect from a page that exists. */
const PAGES = ["today", "tasks", "runs", "docs", "setup", "machines", "settings", "pipeline", "admin", "systems", "proposals", "specs", "features", "tokens"];
const isPage = (id: string) => PAGES.includes(id);
const web = (hash: string) => resolveHash(hash, { local: false, web: true, isPage });
/** The desktop app connected to a hub: neither the web's tabs nor the local mode's redirects. */
const desk = (hash: string) => resolveHash(hash, { local: false, isPage });
const local = (hash: string) => resolveHash(hash, { local: true, isPage });

describe("addresses", () => {
  it("redirects the legacy SDLC settings link while preserving project and feature", () => {
    assert.deepEqual(web("#/settings?tab=sdlc&project=app&flow=F-1"), { id: "pipeline", hash: "#/pipeline?project=app&flow=F-1" });
    assert.deepEqual(desk("#/settings?tab=sdlc&project=app"), { id: "settings", hash: null });
  });

  it("leaves a page that exists alone", () => {
    assert.deepEqual(web("#/runs"), { id: "runs", hash: null });
    assert.deepEqual(web("#/runs?run=R-1"), { id: "runs", hash: null });
    assert.deepEqual(local("#/today"), { id: "today", hash: null });
  });

  it("moves proposal links to the correct knowledge pending tab, keeping queries and desktop addresses", () => {
    assert.deepEqual(web("#/proposals"), { id: "docs", hash: "#/docs?tab=pending" });
    assert.deepEqual(web("#/admin/review?kind=skills&proposal=7"), { id: "skills", hash: "#/skills?tab=pending&kind=skills&proposal=7" });
    assert.deepEqual(web("#/proposals?doc=project%2Fapp%2Fskills%2Fdeploy"), { id: "skills", hash: "#/skills?tab=pending&doc=project%2Fapp%2Fskills%2Fdeploy" });
    assert.deepEqual(desk("#/proposals"), { id: "proposals", hash: null });
  });

  it("has no page for an address of its own", () => {
    assert.deepEqual(web("#/nope"), { id: null, hash: null });
    assert.deepEqual(web("#/"), { id: null, hash: null });
    assert.deepEqual(web(""), { id: null, hash: null });
  });

  it("sends the Web Admin's old addresses to the tab that holds them (roadmap 35b, then 49b)", () => {
    assert.deepEqual(web("#/admin/queue"), { id: "machines", hash: "#/machines?tab=queue" });
    assert.deepEqual(web("#/admin/quota"), { id: "machines", hash: "#/machines" });
    assert.deepEqual(web("#/admin/projects"), { id: "settings", hash: "#/settings?tab=systems" });
    assert.deepEqual(web("#/admin/nothing-like-it"), { id: "admin", hash: "#/admin?tab=ops" }, "an address nobody knows opens the overview");
    assert.deepEqual(web("#/admin/costs?range=7d"), { id: "machines", hash: "#/machines?tab=costs&range=7d" }, "the query comes along");
  });

  it("opens Quản trị itself at #/admin on the web, with the tab it names (roadmap 49b)", () => {
    assert.deepEqual(web("#/admin"), { id: "admin", hash: null });
    assert.deepEqual(web("#/admin?tab=users"), { id: "admin", hash: null });
    assert.deepEqual(desk("#/admin"), { id: "ops", hash: "#/ops" }, "the app has no Quản trị: the old address, as before");
  });

  it("sends every page the web folded into a tab to that tab (roadmap 49b)", () => {
    const tabs: Array<[string, string]> = [
      ["ops", "#/admin?tab=ops"],
      ["users", "#/admin?tab=users"],
      ["alerts", "#/admin?tab=alerts"],
      ["audit", "#/admin?tab=audit"],
      ["webhooks", "#/admin?tab=webhooks"],
      ["versions", "#/admin?tab=versions"],
      ["hub", "#/admin?tab=hub"],
      ["fleet", "#/machines?tab=fleet"],
      ["queue", "#/machines?tab=queue"],
      ["costs", "#/machines?tab=costs"],
      ["policy", "#/settings?tab=policy"],
      ["context", "#/settings?tab=context"],
      ["members", "#/settings?tab=members"],
      ["systems", "#/settings?tab=systems"],
      ["tools", "#/settings?tab=tools"],
      ["batches", "#/runs"],
      ["specs", "#/features"],
    ];
    for (const [old, to] of tabs) assert.deepEqual(web(`#/${old}`), { id: to.slice(2).split("?")[0], hash: to }, old);
    assert.equal(Object.keys(WEB_ALIASES).length, tabs.length, "every alias is tested");
  });

  it("keeps a link's own query when it moves to a tab, the target's tab first", () => {
    assert.deepEqual(web("#/batches?group=3"), { id: "runs", hash: "#/runs?group=3" });
    assert.deepEqual(web("#/members?project=app"), { id: "settings", hash: "#/settings?tab=members&project=app" });
    assert.deepEqual(web("#/fleet?tab=map"), { id: "machines", hash: "#/machines?tab=fleet" });
  });

  it("leaves the pages the new menu kept, and Token, where they are", () => {
    for (const id of ["runs", "machines", "tokens"]) assert.deepEqual(web(`#/${id}`), { id, hash: null }, id);
  });

  it("opens a Spec page link on Tính năng on the web, and leaves the app's Spec page (roadmap 49d)", () => {
    assert.deepEqual(web("#/specs?project=app&dir=001-qr&branch="), { id: "features", hash: "#/features?project=app&dir=001-qr&branch=" });
    assert.deepEqual(web("#/admin/specs"), { id: "features", hash: "#/features" });
    assert.deepEqual(desk("#/specs"), { id: "specs", hash: null });
    assert.deepEqual(local("#/specs?project=app"), { id: "specs", hash: null });
  });

  it("leaves the desktop app's addresses as they were (35a/44, 39f)", () => {
    assert.deepEqual(desk("#/systems"), { id: "systems", hash: null });
    assert.deepEqual(desk("#/tools"), { id: null, hash: null });
    assert.deepEqual(desk("#/batches"), { id: null, hash: null });
    assert.deepEqual(local("#/systems"), { id: "systems", hash: null });
    assert.deepEqual(local("#/members"), { id: null, hash: null });
  });

  it("opens the board's address on Task, in every mode (roadmap 39f)", () => {
    assert.deepEqual(web("#/board"), { id: "tasks", hash: "#/tasks" });
    assert.deepEqual(local("#/board"), { id: "tasks", hash: "#/tasks" });
    assert.deepEqual(local("#/board?task=T-1"), { id: "tasks", hash: "#/tasks?task=T-1" }, "the link to one task still opens it");
  });

  it("sends Tool and Đợt chạy to the pages that took them over on this machine (roadmap 39f)", () => {
    assert.deepEqual(local("#/tools"), { id: "setup", hash: "#/setup" });
    assert.deepEqual(local("#/batches"), { id: "runs", hash: "#/runs" });
  });

  it("follows an address that moved twice to where it ends", () => {
    assert.deepEqual(local("#/admin/tools"), { id: "setup", hash: "#/setup" }, "the Web Admin's Tool, then Service & công cụ");
    assert.deepEqual(web("#/admin/tools"), { id: "settings", hash: "#/settings?tab=tools" }, "on the web, Cài đặt service");
    assert.deepEqual(local("#/admin/batches"), { id: "runs", hash: "#/runs" });
    assert.deepEqual(web("#/admin/batches"), { id: "runs", hash: "#/runs" });
  });
});
