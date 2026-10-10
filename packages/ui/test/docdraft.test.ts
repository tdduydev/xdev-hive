import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { HiveError } from "@xdev-hive/core";
import { DRAFTS_EVENT, isUnreachable, readDrafts, writeDrafts, type DocDraft } from "#ui/lib/docdraft.ts";

const draft = (over: Partial<DocDraft> = {}): DocDraft => ({
  title: "Quy ước",
  content: "# Quy ước\n",
  includeInAgents: true,
  paths: "src/**",
  note: "",
  baseVersion: 3,
  savedAt: "2026-10-01T08:00:00.000Z",
  ...over,
});

/** A localStorage over a Map; `blocked` makes every call throw, as a browser with storage turned off does. */
function storage(blocked = false) {
  const store = new Map<string, string>();
  const no = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  Object.assign(globalThis, {
    localStorage: {
      getItem: blocked ? no : (k: string) => store.get(k) ?? null,
      setItem: blocked ? no : (k: string, v: string) => void store.set(k, v),
    },
  });
  return store;
}

/** Stands in for the browser window, counting the change events the open views listen for. */
function windowEvents() {
  const target = new EventTarget();
  let events = 0;
  target.addEventListener(DRAFTS_EVENT, () => events++);
  Object.assign(globalThis, { window: target });
  return () => events;
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  delete (globalThis as { window?: unknown }).window;
});

describe("doc drafts on the device", () => {
  it("starts with no drafts", () => {
    storage();
    assert.deepEqual(readDrafts(), {});
  });

  it("keeps drafts, the outbox's queued ones too, and tells the open views", () => {
    const store = storage();
    const events = windowEvents();
    const queued = draft({ queued: { mode: "propose", at: "2026-10-01T08:05:00.000Z" }, parent: "guides" });
    writeDrafts({ "xdev-hive/conventions": draft(), "xdev-hive/new-page": queued });
    assert.equal(events(), 1);
    assert.deepEqual(readDrafts(), { "xdev-hive/conventions": draft(), "xdev-hive/new-page": queued });
    assert.ok(store.has("hive-doc-drafts"), "one key holds them all");

    // Sent (or thrown away): the outbox writes the rest back.
    writeDrafts(Object.fromEntries(Object.entries(readDrafts()).filter(([key]) => key !== "xdev-hive/new-page")));
    assert.equal(events(), 2);
    assert.deepEqual(Object.keys(readDrafts()), ["xdev-hive/conventions"]);
    writeDrafts({});
    assert.deepEqual(readDrafts(), {});
  });

  it("reads broken storage as no drafts", () => {
    const store = storage();
    store.set("hive-doc-drafts", "{not json");
    assert.deepEqual(readDrafts(), {});
  });

  it("still works, for this session only, when storage is blocked", () => {
    storage(true);
    const events = windowEvents();
    assert.deepEqual(readDrafts(), {});
    assert.doesNotThrow(() => writeDrafts({ a: draft() }));
    assert.equal(events(), 1, "the views still hear of the change");
  });

  it("writes without a window (no view to tell)", () => {
    storage();
    assert.doesNotThrow(() => writeDrafts({ a: draft() }));
    assert.deepEqual(Object.keys(readDrafts()), ["a"]);
  });
});

describe("an unreachable hub", () => {
  it("is a HiveError unavailable on the desktop, a TypeError from fetch on the web", () => {
    assert.ok(isUnreachable(new HiveError("unavailable", "Cannot reach the hub")));
    assert.ok(isUnreachable(new TypeError("Failed to fetch")));
    assert.ok(isUnreachable(new DOMException("timed out", "TimeoutError")));
    assert.ok(!isUnreachable(new HiveError("conflict", "stale")));
    assert.ok(!isUnreachable(new Error("boom")));
    assert.ok(!isUnreachable(null));
    assert.ok(!isUnreachable(undefined));
  });
});
