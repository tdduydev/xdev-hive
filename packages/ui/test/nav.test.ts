import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Me } from "@xdev-hive/core";
import { adminTabs, machineTabs, pickTab, settingsTabs, WEB_MENU, WEB_SHORTCUTS, webMenu, webPages, type WebCaps } from "#ui/lib/nav.ts";
import { hasKey } from "#ui/i18n/translate.ts";

const caps: WebCaps = { users: true, members: true, alerts: true, webhooks: true, releases: true, hub: true };
const account = (projects: NonNullable<Me["access"]>["projects"], role: Me["role"] = "member"): Me => ({ name: "person", role, mode: "hub", access: { projects } });
const viewer = account({ app: "viewer" }, "viewer");
const member = account({ app: "member" });
const lead = account({ app: "lead", other: "member" });
const admin: Me = { name: "admin", role: "admin", mode: "hub" };
const projects = ["app", "other"];
/** The menu as the sidebar lists it, folded pages included: WEB_MENU's order, what the person sees. */
const menu = (me: Me, c: WebCaps = caps) => webMenu(webPages(me, projects, c)).flatMap((g) => [...g.ids, ...g.more]);

describe("web menu by job (roadmap 49b)", () => {
  it("gives a viewer the work and the knowledge to read, no chat, settings or administration", () => {
    assert.deepEqual(menu(viewer), ["today", "tasks", "runs", "pipeline", "features", "docs", "memory", "skills", "artifacts", "history", "graph", "machines"]);
  });

  it("gives a member the same: Chat needs chatUse, which the member role does not have", () => {
    assert.deepEqual(menu(member), ["today", "tasks", "runs", "pipeline", "features", "docs", "memory", "skills", "artifacts", "history", "graph", "machines"]);
    assert.ok(menu(account({ app: { permissions: ["view", "chatUse"] } })).includes("chat"), "a grant with chatUse shows Chat");
  });

  it("adds Chat and Cài đặt service for a project lead, still no Quản trị", () => {
    assert.deepEqual(menu(lead), ["today", "tasks", "runs", "pipeline", "features", "chat", "docs", "memory", "skills", "artifacts", "history", "graph", "machines", "settings"]);
  });

  it("gives the hub admin every entry: fifteen entries with proposals on knowledge tabs", () => {
    const all = menu(admin);
    assert.deepEqual(all, ["today", "tasks", "runs", "pipeline", "features", "chat", "docs", "memory", "skills", "artifacts", "history", "graph", "machines", "settings", "admin"]);
    assert.equal(all.filter((id) => id !== "proposals").length, 15);
  });

  it("shows Cài đặt service to whoever manages members alone, with only what they may do", () => {
    const manager = account({ app: { permissions: ["view", "membersManage"] } });
    assert.ok(menu(manager).includes("settings"));
    assert.deepEqual(settingsTabs(manager, projects, caps), ["members", "systems"]);
    assert.deepEqual(settingsTabs(manager, projects, { members: false }), ["systems"], "an older hub without members: only systems");
  });

  it("gathers a lead's settings, Context agent only where contextEdit is granted (49a)", () => {
    assert.deepEqual(settingsTabs(lead, projects, caps), ["policy", "agent", "tools", "context", "leader", "members", "systems"]);
    const settingsOnly = account({ app: { permissions: ["view", "projectSettings"] } });
    assert.deepEqual(settingsTabs(settingsOnly, projects, caps), ["policy", "agent", "tools", "leader", "systems"]);
    assert.deepEqual(settingsTabs(member, projects, caps), []);
    assert.deepEqual(settingsTabs(admin, projects, caps), ["policy", "agent", "tools", "context", "leader", "members", "systems"]);
  });

  it("gives Máy & agent the fleet, queue and costs tabs for the hub admin only", () => {
    assert.deepEqual(machineTabs(admin), ["map", "quota", "fleet", "queue", "costs"]);
    assert.deepEqual(machineTabs(lead), ["map", "quota"]);
    assert.deepEqual(machineTabs(viewer), ["map", "quota"]);
  });

  it("puts the hub admin's jobs in Quản trị's tabs, leaving out what an older hub lacks", () => {
    assert.deepEqual(adminTabs(caps), ["ops", "users", "roles", "org", "policy", "tools", "budgets", "alerts", "audit", "webhooks", "versions", "hub"]);
    assert.deepEqual(adminTabs({ ...caps, users: false, alerts: false, webhooks: false, releases: false, hub: false }), ["ops", "policy", "tools", "budgets", "audit"]);
  });

  it("opens the tab an address asks for, else the first one the person has", () => {
    assert.equal(pickTab(["map", "fleet"], "fleet"), "fleet");
    assert.equal(pickTab(["map"], "fleet"), "map", "a lead following an admin's link lands on the map");
    assert.equal(pickTab(["map"], null), "map");
    assert.equal(pickTab([], "x"), undefined);
  });

  it("keeps ⌘1–5 on the pages of a working day", () => {
    assert.deepEqual(WEB_SHORTCUTS, { today: "1", chat: "2", tasks: "3", runs: "4", docs: "5" });
  });

  it("groups by job: Hôm nay alone, then work, conversation, knowledge with a fold, and quiet operations last", () => {
    const groups = webMenu(webPages(admin, projects, caps));
    assert.deepEqual(groups.map((g) => [g.label, g.ids, g.more, g.quiet]), [
      [null, ["today"], [], false],
      ["nav.groupWork", ["tasks", "runs", "pipeline", "features"], [], false],
      ["nav.groupTalk", ["chat"], [], false],
      ["nav.groupKnowledge", ["docs", "memory", "skills"], ["artifacts", "history", "graph"], false],
      [null, ["machines", "settings", "admin"], [], true],
    ]);
  });

  it("leaves out a group, or a fold, whose pages are all hidden", () => {
    // A member without Chat: no Trao đổi heading over nothing.
    assert.ok(!webMenu(webPages(member, projects, caps)).some((g) => g.label === "nav.groupTalk"));
    // Someone who views no project has no Artifact, Lịch sử or Đồ thị: Kiến thức keeps its pages, without "Thêm".
    const outsider = account({});
    const knowledge = webMenu(webPages(outsider, [], caps)).find((g) => g.label === "nav.groupKnowledge");
    assert.deepEqual(knowledge?.more, []);
    assert.deepEqual(knowledge?.ids, ["docs", "memory", "skills"]);
    assert.deepEqual(webMenu(new Set()), [], "nothing shown, no groups");
  });

  it("lists every web page once across the groups and their folds", () => {
    const ids = WEB_MENU.flatMap((g) => [...g.ids, ...(g.more ?? [])]);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of Object.keys(WEB_SHORTCUTS)) assert.ok(ids.includes(id as (typeof ids)[number]), `${id} has a shortcut and an entry`);
  });

  it("has a label in both languages for every group heading", () => {
    for (const g of WEB_MENU) if (g.label) assert.ok(hasKey(g.label), g.label);
    assert.ok(hasKey("nav.more") && hasKey("nav.running"));
  });
});
