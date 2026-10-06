import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Me } from "@xdev-hive/core";
import { adminTabs, machineTabs, pickTab, settingsTabs, WEB_MENU, WEB_SHORTCUTS, webPages, type WebCaps } from "#ui/lib/nav.ts";
import { hasKey } from "#ui/i18n/translate.ts";

const caps: WebCaps = { users: true, members: true, alerts: true, webhooks: true, releases: true, hub: true };
const account = (projects: NonNullable<Me["access"]>["projects"], role: Me["role"] = "member"): Me => ({ name: "person", role, mode: "hub", access: { projects } });
const viewer = account({ app: "viewer" }, "viewer");
const member = account({ app: "member" });
const lead = account({ app: "lead", other: "member" });
const admin: Me = { name: "admin", role: "admin", mode: "hub" };
const projects = ["app", "other"];
/** The menu as the sidebar lists it: WEB_MENU's order, what the person sees. */
const menu = (me: Me, c: WebCaps = caps) => {
  const shown = webPages(me, projects, c);
  return WEB_MENU.flatMap((g) => g.ids).filter((id) => shown.has(id));
};

describe("web menu by job (roadmap 49b)", () => {
  it("gives a viewer the work and the knowledge to read, no chat, settings or administration", () => {
    assert.deepEqual(menu(viewer), ["today", "graph", "features", "tasks", "runs", "docs", "skills", "memory", "pipeline", "machines"]);
  });

  it("gives a member the same: Chat needs chatUse, which the member role does not have", () => {
    assert.deepEqual(menu(member), ["today", "graph", "features", "tasks", "runs", "docs", "skills", "memory", "pipeline", "machines"]);
    assert.ok(menu(account({ app: { permissions: ["view", "chatUse"] } })).includes("chat"), "a grant with chatUse shows Chat");
  });

  it("adds Chat and Cài đặt dự án for a project lead, still no Quản trị", () => {
    assert.deepEqual(menu(lead), ["today", "chat", "graph", "features", "tasks", "runs", "docs", "skills", "memory", "pipeline", "settings", "machines"]);
  });

  it("gives the hub admin every entry: thirteen entries with proposals on knowledge tabs", () => {
    const all = menu(admin);
    assert.deepEqual(all, ["today", "chat", "graph", "features", "tasks", "runs", "docs", "skills", "memory", "pipeline", "settings", "machines", "admin"]);
    assert.equal(all.filter((id) => id !== "proposals").length, 13);
  });

  it("shows Cài đặt dự án to whoever manages members alone, with only what they may do", () => {
    const manager = account({ app: { permissions: ["view", "membersManage"] } });
    assert.ok(menu(manager).includes("settings"));
    assert.deepEqual(settingsTabs(manager, projects, caps), ["members", "systems"]);
    assert.deepEqual(settingsTabs(manager, projects, { members: false }), ["systems"], "an older hub without members: only systems");
  });

  it("gathers a lead's settings, Context agent only where contextEdit is granted (49a)", () => {
    assert.deepEqual(settingsTabs(lead, projects, caps), ["policy", "tools", "context", "leader", "members", "systems"]);
    const settingsOnly = account({ app: { permissions: ["view", "projectSettings"] } });
    assert.deepEqual(settingsTabs(settingsOnly, projects, caps), ["policy", "tools", "leader", "systems"]);
    assert.deepEqual(settingsTabs(member, projects, caps), []);
    assert.deepEqual(settingsTabs(admin, projects, caps), ["policy", "tools", "context", "leader", "members", "systems"]);
  });

  it("gives Máy & agent the fleet, queue and costs tabs for the hub admin only", () => {
    assert.deepEqual(machineTabs(admin), ["map", "quota", "fleet", "queue", "costs"]);
    assert.deepEqual(machineTabs(lead), ["map", "quota"]);
    assert.deepEqual(machineTabs(viewer), ["map", "quota"]);
  });

  it("puts the hub admin's jobs in Quản trị's tabs, leaving out what an older hub lacks", () => {
    assert.deepEqual(adminTabs(caps), ["ops", "users", "tools", "budgets", "alerts", "audit", "webhooks", "versions", "hub"]);
    assert.deepEqual(adminTabs({ ...caps, users: false, alerts: false, webhooks: false, releases: false, hub: false }), ["ops", "tools", "budgets", "audit"]);
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

  it("has a label in both languages for every group heading", () => {
    for (const g of WEB_MENU) if (g.label) assert.ok(hasKey(g.label), g.label);
  });
});
