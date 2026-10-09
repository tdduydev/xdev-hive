import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MachineSystem, ReportedProfile } from "@xdev-hive/core";
import { register } from "tsx/esm/api";

register({ tsconfig: new URL("../tsconfig.json", import.meta.url).pathname });
const { MachineSystemBlock, PlanTile } = await import("#ui/components/MachineCards.tsx");

const profile = (over: Partial<ReportedProfile> = {}): ReportedProfile => ({ id: "claude-1", label: "claude-max-1", kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0, ...over });

describe("machine cards (72g)", () => {
  it("draws a plan from the usage the machine reported and invents nothing", () => {
    const full = renderToStaticMarkup(createElement(PlanTile, { profile: profile({ sessionPercent: 100, weekPercent: 61, sessionResets: "15:40", weekResets: "T2", resetsLeft: 2 }), pick: null }));
    assert.match(full, /0%/);
    assert.match(full, /Hết · reset 15:40/);
    assert.match(full, /Tuần còn 39% · T2/);
    assert.match(full, /Reset tuần · 2/);
    assert.match(full, /planet-violet/);
    const unknown = renderToStaticMarkup(createElement(PlanTile, { profile: profile({ kind: "other" }), pick: null }));
    assert.doesNotMatch(unknown, />\d+%</);
    assert.match(unknown, /Reset tuần/);
  });
  it("is a checkbox only when the plan can be picked", () => {
    const picked = renderToStaticMarkup(createElement(PlanTile, { profile: profile(), pick: { on: true, toggle() {} } }));
    assert.match(picked, /role="checkbox"/);
    assert.match(picked, /aria-checked="true"/);
  });
  it("shows the system block with what the machine reported, and its levels", () => {
    const system: MachineSystem = { os: "macos", osName: "macOS 26", hardware: "Mac mini", cpu: { percent: 92, detail: "14 nhân" } };
    const html = renderToStaticMarkup(createElement(MachineSystemBlock, { system }));
    assert.match(html, /92%/);
    assert.match(html, /var\(--accent-red\)/);
    assert.doesNotMatch(html, /RAM/, "a gauge the machine did not report is not drawn");
  });
});
