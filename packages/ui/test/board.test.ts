import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentProfileStatus, TaskStatus } from "@xdev-hive/core";
import { boardProjects, fitsEveryColumn, foldedColumns, profileState, profileSummary } from "#ui/lib/board.ts";

const counts = (n: Partial<Record<TaskStatus, number>>) => (status: TaskStatus) => n[status] ?? 0;
const none = new Set<TaskStatus>();

describe("board columns", () => {
  it("fits five columns on a wide board and not on a 1100px window", () => {
    // 1100px window: the sidebar (236) and the board's padding (28) leave this much.
    assert.equal(fitsEveryColumn(1100 - 236 - 28), false);
    assert.equal(fitsEveryColumn(1440 - 236 - 28), true);
    assert.equal(fitsEveryColumn(0), true, "not measured yet: do not flash folded");
  });

  it("folds Xong and Bị chặn when the board is narrow, and the empty ones at any width", () => {
    const full = counts({ todo: 3, doing: 1, review: 2, blocked: 1, done: 9 });
    assert.deepEqual([...foldedColumns(1176, full, none)], []);
    assert.deepEqual([...foldedColumns(836, full, none)].sort(), ["blocked", "done"]);
    assert.deepEqual([...foldedColumns(1176, counts({ todo: 3, blocked: 1 }), none)], ["done"]);
    assert.deepEqual([...foldedColumns(1176, counts({ todo: 3 }), none)].sort(), ["blocked", "done"]);
  });

  it("leaves open the column the reader opened, and never folds the work in front of them", () => {
    const full = counts({ todo: 3, doing: 1, review: 2, blocked: 1, done: 9 });
    assert.deepEqual([...foldedColumns(836, full, new Set<TaskStatus>(["done"]))], ["blocked"]);
    assert.deepEqual([...foldedColumns(400, counts({}), none)].sort(), ["blocked", "done"], "todo, doing and review always show");
  });
});

const profile = (p: Partial<AgentProfileStatus>) =>
  ({ enabled: true, cooldownUntil: null, login: null, usage: null, stopAtSession: 90, stopAtWeek: 90, ...p }) as AgentProfileStatus;

describe("subscription chip", () => {
  it("names why a subscription is not taking work, off first and the limit before a rest", () => {
    assert.equal(profileState(profile({ enabled: false, login: { loggedIn: false, checkedAt: "" } as never })), "off");
    assert.equal(profileState(profile({ login: { loggedIn: false } as never })), "signedOut");
    assert.equal(profileState(profile({ cooldownUntil: "2026-10-03T10:00:00.000Z", usage: { session: { percent: 95 } } as never })), "overLimit");
    assert.equal(profileState(profile({ cooldownUntil: "2026-10-03T10:00:00.000Z" })), "resting");
    assert.equal(profileState(profile({ usage: { session: { percent: 40 } } as never })), "ready");
  });

  it("counts them for the chip, a running subscription among the ready ones", () => {
    const sum = profileSummary([
      profile({}),
      profile({ running: 1 } as Partial<AgentProfileStatus>),
      profile({ cooldownUntil: "2026-10-03T10:00:00.000Z" }),
      profile({ enabled: false }),
      profile({ login: { loggedIn: false } as never }),
    ]);
    assert.deepEqual(sum, { total: 5, ready: 2, resting: 1, overLimit: 0, off: 1, signedOut: 1 });
  });
});

describe("board projects", () => {
  const local = ["demo", "api"];
  const seen = ["web", "demo", "docs"];

  it("offers every project in local mode, this machine's first", () => {
    assert.deepEqual(boardProjects({ local, seen, system: null, machineOnly: false }), ["demo", "api", "web", "docs"]);
  });

  it("offers only the projects in this machine's config when connected to a hub", () => {
    assert.deepEqual(boardProjects({ local, seen, system: null, machineOnly: true }), ["demo", "api"]);
    assert.deepEqual(boardProjects({ local: ["demo", "demo"], seen, system: null, machineOnly: true }), ["demo"]);
  });

  it("narrows to the picked system's projects", () => {
    assert.deepEqual(boardProjects({ local, seen, system: ["api", "web"], machineOnly: false }), ["api", "web"]);
    assert.deepEqual(boardProjects({ local, seen, system: ["api", "web"], machineOnly: true }), ["api"]);
  });

  it("offers nothing on a machine without a project, so the Board says where to add one", () => {
    assert.deepEqual(boardProjects({ local: [], seen, system: null, machineOnly: true }), []);
    assert.deepEqual(boardProjects({ local, seen, system: ["web"], machineOnly: true }), []);
  });
});
