import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HiveSystem } from "@xdev-hive/core";
import { pickerGroups, readRecent, rememberRecent } from "#ui/lib/project-picker.ts";
import { scopeId } from "#ui/lib/scope.ts";

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
    const labels = { all: "Tất cả dự án", shared: "Chung" };
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
