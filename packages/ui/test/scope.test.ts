import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HiveSystem } from "@xdev-hive/core";
import { ALL, defaultOwner, inScope, nameMatches, outsideSystems, projectScope, readScope, resolveScope, sameScope, scopeFilter, scopeKey, scopeProjects, SHARED, systemScope, writeScope } from "#ui/lib/scope.ts";

const shop: HiveSystem = { name: "shop", projects: ["api", "web"], updatedAt: "2026-09-30T08:00:00.000Z", updatedBy: "duy" };

describe("the sidebar scope", () => {
  it("narrows the lists to a system's projects, the shared data still in view", () => {
    const s = systemScope("shop", ["api", "web"]);
    assert.deepEqual(scopeFilter(s), { projects: ["api", "web"] });
    assert.deepEqual(scopeFilter(projectScope("web")), { project: "web" });
    assert.deepEqual(scopeFilter(ALL), {});
    assert.deepEqual(scopeFilter(SHARED), {});
    assert.deepEqual(scopeProjects(s), ["api", "web"]);
    assert.equal(scopeProjects(ALL), null);
    assert.ok(inScope(s, "api") && inScope(s, null));
    assert.ok(!inScope(s, "billing"));
  });

  it("fills in a picked system from the hub's list, and falls back to all when it is gone", () => {
    const picked = systemScope("shop");
    assert.deepEqual(resolveScope(picked, undefined), picked, "still loading: no projects yet");
    assert.deepEqual(resolveScope(picked, [shop]), systemScope("shop", ["api", "web"]));
    assert.deepEqual(resolveScope(picked, []), ALL);
    assert.deepEqual(resolveScope(projectScope("web"), []), projectScope("web"));
    // The same system whatever its projects; its lists reload when they change.
    assert.ok(sameScope(picked, systemScope("shop", ["api"])));
    assert.ok(!sameScope(systemScope("web"), projectScope("web")));
    assert.notEqual(scopeKey(systemScope("shop", ["api"])), scopeKey(systemScope("shop", ["api", "web"])));
  });

  it("remembers a system apart from a project of the same name", () => {
    const store = new Map<string, string>();
    Object.assign(globalThis, { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
    try {
      writeScope(systemScope("web", ["web-api"]));
      assert.deepEqual(readScope(), systemScope("web"));
      writeScope(projectScope("web"));
      assert.deepEqual(readScope(), projectScope("web"));
      writeScope(SHARED);
      assert.deepEqual(readScope(), SHARED);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("projects outside every system (roadmap 36c)", () => {
  const billing: HiveSystem = { ...shop, name: "billing", projects: ["invoice", "api"] };

  it("keeps the projects no system has, sorted and once each", () => {
    assert.deepEqual(outsideSystems(["web", "zeta", "api", "alpha", "zeta"], [shop]), ["alpha", "zeta"]);
    assert.deepEqual(outsideSystems(["api", "web", "invoice", "crm"], [shop, billing]), ["crm"]);
  });

  it("is every project when there is no system, none when all are in one", () => {
    assert.deepEqual(outsideSystems(["b", "a"], []), ["a", "b"]);
    assert.deepEqual(outsideSystems(["api", "web"], [shop]), []);
  });

  it("matches names case-insensitively, an empty search keeps all", () => {
    assert.ok(nameMatches("payment-api", "API"));
    assert.ok(nameMatches("payment", "  "));
    assert.ok(!nameMatches("payment", "shop"));
  });
});

describe("where new docs and memory go (roadmap 40c)", () => {
  const billing: HiveSystem = { ...shop, name: "billing", projects: ["api", "ledger"] };
  it("puts them in the system's own space for a system and for a service of one", () => {
    assert.equal(defaultOwner(systemScope("shop", ["api", "web"]), [shop]), "sys:shop");
    assert.equal(defaultOwner(projectScope("web"), [shop]), "sys:shop");
    // A service of two systems: the first by name.
    assert.equal(defaultOwner(projectScope("api"), [shop, billing]), "sys:billing");
  });

  it("keeps a repo in no system, the shared scope and all where they were", () => {
    assert.equal(defaultOwner(projectScope("solo"), [shop]), "solo");
    assert.equal(defaultOwner(SHARED, [shop]), null);
    assert.equal(defaultOwner(ALL, [shop]), null);
  });

  it("falls back to the service when the person may not write the system's", () => {
    assert.equal(defaultOwner(projectScope("api"), [shop, billing], (o) => o !== "sys:billing"), "sys:shop");
    assert.equal(defaultOwner(projectScope("web"), [shop], (o) => o === "web"), "web");
  });
});
