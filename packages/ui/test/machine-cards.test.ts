import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MachineSystem, ReportedProfile } from "@xdev-hive/core";
import { register } from "tsx/esm/api";

register({ tsconfig: new URL("../tsconfig.json", import.meta.url).pathname });
const { MachineSystemBlock, PlanTile, machineDisks } = await import("#ui/components/MachineCards.tsx");

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


it("formats numeric system measurements in the viewer's language", async () => {
  const { setActiveLocale } = await import("#ui/i18n/translate.ts");
  const system: MachineSystem = { os: "linux", osName: "Linux", hardware: "CPU", uptimeSeconds: 6 * 86400, cpu: { percent: 10, detail: "", cores: 14, load: 10.1 }, ram: { percent: 75, detail: "", usedBytes: 48e9, totalBytes: 64e9 }, disk: { percent: 58, detail: "", freeBytes: 420e9, totalBytes: 1e12 } };
  try {
    setActiveLocale("vi");
    let html = renderToStaticMarkup(createElement(MachineSystemBlock, { system }));
    assert.match(html, /Bật 6 ngày/); assert.match(html, /14 nhân · tải 10.1/); assert.match(html, /48 \/ 64 GB/); assert.match(html, /Còn 420 GB \/ 1 TB/);
    setActiveLocale("en");
    html = renderToStaticMarkup(createElement(MachineSystemBlock, { system }));
    assert.match(html, /Up 6 days/); assert.match(html, /14 cores · load 10.1/); assert.match(html, /Free 420 GB \/ 1 TB/);
  } finally { setActiveLocale("vi"); }
});

it("draws one row per disk, the worktree disk first and tagged, a full one warned (79o)", async () => {
  const { setActiveLocale } = await import("#ui/i18n/translate.ts");
  const system: MachineSystem = {
    os: "windows", osName: "Windows 11", hardware: "PC",
    disk: { percent: 31, detail: "", freeBytes: 345e9, totalBytes: 500e9 },
    disks: [
      { mount: "C:", label: "OS", totalBytes: 512e9, freeBytes: 20e9, percent: 96 },
      { mount: "D:", label: "Data", totalBytes: 500e9, freeBytes: 345e9, percent: 31, worktree: true },
    ],
  };
  assert.deepEqual(machineDisks(system).map((d) => d.mount), ["D:", "C:"]);
  assert.deepEqual(machineDisks({ os: "linux", osName: "Linux", hardware: "x" }), []);
  try {
    setActiveLocale("vi");
    const html = renderToStaticMarkup(createElement(MachineSystemBlock, { system }));
    assert.equal(html.match(/data-disk="/g)?.length, 2);
    assert.match(html, /data-disk="D:"[^>]*>.*?data-disk-worktree/);
    assert.match(html, /data-disk="C:" data-disk-warn="true"/);
    assert.match(html, /Sắp đầy: còn 20 GB/);
    assert.doesNotMatch(html, /Còn 345 GB/, "the single disk gauge gives way to the list");
    setActiveLocale("en");
    assert.match(renderToStaticMarkup(createElement(MachineSystemBlock, { system })), /Almost full: 20 GB left/);
    // An app older than 79o reports one disk: it stays the gauge it was.
    const old = renderToStaticMarkup(createElement(MachineSystemBlock, { system: { ...system, disks: undefined } }));
    assert.match(old, /Free 345 GB \/ 500 GB/);
    assert.doesNotMatch(old, /data-disk=/);
  } finally { setActiveLocale("vi"); }
});
