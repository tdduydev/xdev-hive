import { describe, expect, it } from "vitest";
import { DEPLOY_RUNNER_LABEL, type RunnerCandidate, type RunnerNeeds, selectRunner } from "./runner-select.ts";

const ORG = "org-a";
const machine = (id: string, over: Partial<RunnerCandidate> = {}): RunnerCandidate => ({
  machineId: id,
  orgId: ORG,
  online: true,
  labels: [DEPLOY_RUNNER_LABEL],
  methods: ["argocd", "kubectl"],
  credentials: ["argo-prod"],
  ...over,
});
const needs = (over: Partial<RunnerNeeds> = {}): RunnerNeeds => ({
  orgId: ORG,
  method: "argocd",
  credential: "argo-prod",
  requireLabel: true,
  ...over,
});

describe("selectRunner", () => {
  it("picks the first eligible machine in the admin's order", () => {
    const r = selectRunner([machine("m1"), machine("m2")], ["m2", "m1"], needs());
    expect(r).toEqual({ ok: true, machineId: "m2" });
  });

  it("falls back to the next machine when the first is offline", () => {
    const r = selectRunner([machine("m1", { online: false }), machine("m2")], ["m1", "m2"], needs());
    expect(r).toEqual({ ok: true, machineId: "m2" });
  });

  it("skips machines without the method, the label or the credential", () => {
    const list = [
      machine("m1", { methods: ["kubectl"] }),
      machine("m2", { labels: [] }),
      machine("m3", { credentials: [] }),
      machine("m4"),
    ];
    expect(selectRunner(list, ["m1", "m2", "m3", "m4"], needs())).toEqual({ ok: true, machineId: "m4" });
  });

  it("does not require the label when the environment does not ask for it", () => {
    const r = selectRunner([machine("m1", { labels: [] })], ["m1"], needs({ requireLabel: false }));
    expect(r.ok).toBe(true);
  });

  it("does not require a credential for methods that need none", () => {
    const r = selectRunner([machine("m1", { credentials: [] })], ["m1"], needs({ credential: null }));
    expect(r.ok).toBe(true);
  });

  it("reports the furthest stage that some machine passed", () => {
    const wait = (list: RunnerCandidate[]) => {
      const r = selectRunner(
        list,
        list.map((m) => m.machineId),
        needs(),
      );
      return r.ok ? "ok" : r.reason;
    };
    expect(wait([])).toBe("no_machines");
    expect(wait([machine("m1", { online: false })])).toBe("offline");
    expect(wait([machine("m1", { methods: [] })])).toBe("no_capability");
    expect(wait([machine("m1", { labels: [] })])).toBe("no_label");
    expect(wait([machine("m1", { credentials: [] })])).toBe("missing_credential");
  });

  it("gives the wait reason a Vietnamese message", () => {
    const r = selectRunner([machine("m1", { online: false })], ["m1"], needs());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/trực tuyến/);
  });

  it("only considers registrations of the deploy's own organization", () => {
    // Cùng một máy đăng ký với hai tổ chức: khả năng và credential của tổ chức kia không được dùng.
    const other = machine("m1", { orgId: "org-b" });
    expect(selectRunner([other], ["m1"], needs())).toMatchObject({ ok: false, reason: "no_machines" });
    const both = [other, machine("m1", { orgId: ORG, credentials: [] })];
    expect(selectRunner(both, ["m1"], needs())).toMatchObject({ ok: false, reason: "missing_credential" });
  });

  it("ignores machines not in the environment's list", () => {
    expect(selectRunner([machine("m9")], ["m1"], needs())).toMatchObject({ ok: false, reason: "no_machines" });
  });
});
