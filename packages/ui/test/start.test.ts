import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentProfileStatus, DesktopSettings, SetupReport } from "@xdev-hive/core";
import { remainingSteps, shouldOpenStartGuide, startSteps } from "#ui/lib/start.ts";
const settings = (patch: Partial<DesktopSettings> = {}): DesktopSettings => ({ mode: "hub", hasHubToken: false, projects: [], runner: { acceptHubRuns: false }, ...patch } as DesktopSettings);
const report: SetupReport = { machine: [{ id: "shim", label: "Hive", state: "installed", detail: "", action: null }], projects: [{ project: "demo", repo: "/demo", items: [] }] };
const profile = (patch: Partial<AgentProfileStatus> = {}): AgentProfileStatus => ({ enabled: true, cliPath: "/bin/codex", login: { loggedIn: true }, ...patch } as AgentProfileStatus);
test("new hub machine needs connection, project, login and intake", () => {
  const steps = startSteps(settings(), { machine: [{ ...report.machine[0]!, state: "missing" }], projects: [] }, []);
  assert.equal(remainingSteps(steps), 5);
  assert.ok(Object.values(steps).every((s) => s === "todo"));
});
test("local mode skips hub steps and complete machine has no remaining work", () => {
  const s = settings({ mode: "local", projects: [{ name: "demo", repo: "/demo" }] });
  const steps = startSteps(s, report, [profile()]);
  assert.equal(steps.connection, "optional"); assert.equal(steps.intake, "optional");
  assert.equal(remainingSteps(steps), 0);
});
test("hub token and intake switch complete their own steps independently", () => {
  const steps = startSteps(settings({ hasHubToken: true, runner: { acceptHubRuns: true } as DesktopSettings["runner"] }), report, []);
  assert.equal(steps.connection, "done"); assert.equal(steps.intake, "done"); assert.equal(steps.agents, "todo");
});
test("disabled, missing CLI and unknown login do not satisfy agent step; stored token does", () => {
  for (const p of [profile({ enabled: false }), profile({ cliPath: null }), profile({ login: null })]) assert.equal(startSteps(settings(), report, [p]).agents, "todo");
  assert.equal(startSteps(settings(), report, [profile({ login: null, hasToken: true })]).agents, "done");
});
test("all configured repos must be checked and ready, manual items remain actionable", () => {
  const s = settings({ projects: [{ name: "demo", repo: "/demo" }] });
  assert.equal(startSteps(s, { ...report, projects: [] }, []).projects, "todo");
  assert.equal(startSteps(s, { ...report, projects: [{ ...report.projects[0]!, items: [{ ...report.machine[0]!, state: "manual" }] }] }, []).projects, "todo");
});
test("an installed CLI with an available update still counts as ready", () => {
  assert.equal(startSteps(settings(), { ...report, machine: [{ ...report.machine[0]!, version: "1.0.0", latest: "2.0.0" }] }, []).tools, "done");
});
test("startup still opens setup after Today selects an item, while deep links and navigation keep their destination", () => {
  const selected = "#/today?inbox=machine%3Ashim";
  assert.equal(shouldOpenStartGuide("", selected), true);
  assert.equal(shouldOpenStartGuide("#/today", selected), true);
  assert.equal(shouldOpenStartGuide(selected, selected), false);
  assert.equal(shouldOpenStartGuide("#/runs?run=R-1", selected), false);
  assert.equal(shouldOpenStartGuide("", "#/tasks"), false);
});
