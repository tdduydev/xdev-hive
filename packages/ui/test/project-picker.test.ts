import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HiveSystem } from "@xdev-hive/core";
import { pickerGroups, readRecent, rememberRecent, rootScope, scopeRows, systemTree, type ScopeRow } from "#ui/lib/project-picker.ts";
import { projectScope, scopeId, scopeTitle } from "#ui/lib/scope.ts";

const system = (name: string, projects: string[]): HiveSystem => ({ name, projects, updatedAt: "", updatedBy: "" });
const projects = ["thanh-toan", "demo", "mobile", "orphan"];
const systems = [system("Bán hàng", ["thanh-toan", "demo"]), system("Ứng dụng", ["demo", "mobile"])];

describe("project picker choices", () => {
  it("groups permitted projects, repeating a member of two systems and keeping orphans separate", () => {
    const groups = pickerGroups(projects, systems, "scope", "", []);
    assert.deepEqual(groups.map((group) => [group.kind, group.name, group.items.map(scopeId)]), [
      ["other", undefined, ["all", "shared"]],
      ["system", "Bán hàng", ["system:Bán hàng", "project:thanh-toan", "project:demo"]],
      ["system", "Ứng dụng", ["system:Ứng dụng", "project:demo", "project:mobile"]],
      ["other", "projects", ["project:orphan"]],
    ]);
  });

  it("folds accents in project and system names and exposes a matching system's children", () => {
    assert.deepEqual(pickerGroups(projects, systems, "scope", "ban hang", []).find((group) => group.name === "Bán hàng")?.items.map(scopeId), ["system:Bán hàng", "project:thanh-toan", "project:demo"]);
    assert.deepEqual(pickerGroups(projects, systems, "project", "thanh", []).flatMap((group) => group.items.map(scopeId)), ["project:thanh-toan"]);
  });

  it("limits project-only choices to permitted projects and optional shared", () => {
    assert.deepEqual(pickerGroups(["demo"], systems, "project", "", []).flatMap((group) => group.items.map(scopeId)), ["project:demo", "project:demo"]);
    assert.equal(pickerGroups(["demo"], systems, "project", "", [], true).flatMap((group) => group.items.map(scopeId))[0], "shared");
  });

  it("finds all and shared by their shown labels, accents folded", () => {
    const labels = { all: "Tất cả service", shared: "Chung" };
    const ids = (mode: "scope" | "project", query: string) => pickerGroups(projects, systems, mode, query, [], true, labels).flatMap((group) => group.items.map(scopeId));
    assert.deepEqual(ids("scope", "chung"), ["shared"]);
    assert.deepEqual(ids("scope", "tat ca"), ["all"]);
    assert.deepEqual(ids("project", "Chung"), ["shared"]);
    assert.deepEqual(ids("scope", "shared"), []);
    assert.deepEqual(pickerGroups(projects, systems, "scope", "chung", ["shared"], false, labels).map((group) => [group.kind, group.items.map(scopeId)]), [["recent", ["shared"]], ["other", ["shared"]]]);
  });

  it("keeps five unique recent choices and survives blocked storage", () => {
    const original = globalThis.localStorage;
    let stored = "[]";
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } } });
    try {
      for (const id of ["project:a", "project:b", "project:c", "project:d", "project:e", "project:f", "project:b"]) rememberRecent(id);
      assert.deepEqual(readRecent(), ["project:b", "project:f", "project:e", "project:d", "project:c"]);
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("blocked"); } } });
      assert.deepEqual(readRecent(), ["project:b", "project:f", "project:e", "project:d", "project:c"]);
      assert.deepEqual(rememberRecent("project:a"), ["project:a", "project:b", "project:f", "project:e", "project:d"]);
    } finally { Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original }); }
  });
});

// Roadmap 40a: the sidebar's picker lists systems first, a repo in no system as a system of its own.
describe("scope picker: systems first", () => {
  const shop = [system("ban-hang", ["payment", "demo", "secret"])];
  const permitted = ["payment", "demo", "kho"];
  const rows = (query: string, expanded: string[] = [], recent: string[] = []) => scopeRows(permitted, shop, query, recent, new Set(expanded), { all: "Tất cả service", shared: "Chung" });
  const shown = (list: ScopeRow[]) => list.map((row) => `${row.section}:${row.depth}:${scopeId(row.scope)}`);

  it("builds real systems with the permitted services and a virtual one per repo in no system, by name", () => {
    assert.deepEqual(systemTree(permitted, shop), [
      { name: "ban-hang", services: ["payment", "demo"], virtual: false },
      { name: "kho", services: ["kho"], virtual: true },
    ]);
    // A virtual system named like a real one still shows: one is a system, the other a repo.
    assert.deepEqual(systemTree(["a", "x"], [system("a", ["x"])]).map((root) => [root.name, root.virtual]), [["a", false], ["a", true]]);
  });

  it("puts all and shared first, then one row per system with its services hidden until opened", () => {
    assert.deepEqual(shown(rows("")), ["top:0:all", "top:0:shared", "systems:0:system:ban-hang", "systems:0:project:kho"]);
    assert.deepEqual(shown(rows("", ["ban-hang"])), ["top:0:all", "top:0:shared", "systems:0:system:ban-hang", "systems:1:project:payment", "systems:1:project:demo", "systems:0:project:kho"]);
  });

  it("finds a service inside its system and starts on it; a system found by name shows all its services", () => {
    const pay = rows("pay");
    assert.deepEqual(shown(pay), ["systems:0:system:ban-hang", "systems:1:project:payment"]);
    assert.equal(pay.findIndex((row) => row.match), 1);
    assert.deepEqual(shown(rows("BAN-H")), ["systems:0:system:ban-hang", "systems:1:project:payment", "systems:1:project:demo"]);
    assert.deepEqual(shown(rows("kho")), ["systems:0:project:kho"]);
    assert.deepEqual(shown(rows("chung")), ["top:0:shared"]);
    assert.deepEqual(rows("khong-co"), []);
  });

  it("picks a system as its scope and a virtual one as its project's; names a service as system › service", () => {
    const [real, lone] = systemTree(permitted, shop);
    assert.deepEqual(rootScope(real!), { kind: "system", system: "ban-hang", projects: ["payment", "demo"] });
    assert.deepEqual(rootScope(lone!), { kind: "project", project: "kho" });
    assert.equal(scopeTitle(projectScope("payment"), shop), "ban-hang › payment");
    assert.equal(scopeTitle(projectScope("kho"), shop), "kho");
    assert.equal(scopeTitle(rootScope(real!), shop), "ban-hang");
    assert.deepEqual(rows("", [], ["all", "project:payment", "project:gone"]).filter((row) => row.section === "recent").map((row) => row.label), ["ban-hang › payment"]);
  });
});
