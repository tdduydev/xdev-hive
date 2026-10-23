import { describe, expect, it } from "vitest";
import { configVersion, type LayerInput, resolveConfig } from "./engine.ts";

const org = (values: Record<string, unknown>, locks: string[] = []): LayerInput => ({
  layer: "org",
  targetId: "org",
  values,
  locks,
});
const project = (values: Record<string, unknown>): LayerInput => ({ layer: "project", targetId: "project", values });
const setting = (layers: LayerInput[], key = "limits.perRunUsd") => resolveConfig(layers).find((s) => s.key === key);

describe("cấu hình hai lớp", () => {
  it("uses registry defaults when neither layer has a value", () => {
    expect(setting([])?.value).toBeNull();
    expect(setting([], "merge.mode")).toMatchObject({ value: "review", source: null, locked: false });
  });
  it("allows project values above and below the organization value without clamping", () => {
    for (const value of [5, 50])
      expect(setting([org({ "limits.perRunUsd": 20 }), project({ "limits.perRunUsd": value })])).toMatchObject({
        value,
        source: { layer: "project" },
        locked: false,
      });
  });
  it("resolves in organization/project order regardless of input order", () => {
    expect(setting([project({ "limits.perRunUsd": 50 }), org({ "limits.perRunUsd": 20 })])?.value).toBe(50);
  });
  it("retains a suspended project value and restores it after unlocking", () => {
    const lower = project({ "merge.mode": "auto" });
    const locked = setting([org({ "merge.mode": "review" }, ["merge.mode"]), lower], "merge.mode");
    expect(locked).toMatchObject({ value: "review", locked: true, source: { layer: "org" } });
    expect(locked?.chain[1]).toMatchObject({ value: "auto", applied: false });
    expect(setting([org({ "merge.mode": "review" }), lower], "merge.mode")?.value).toBe("auto");
  });
  it("can lock a registry default without an explicit organization value", () => {
    expect(setting([org({}, ["merge.mode"]), project({ "merge.mode": "auto" })], "merge.mode")).toMatchObject({
      value: "review",
      locked: true,
    });
  });
  it("ignores invalid persisted values and unknown keys", () => {
    expect(setting([org({ "limits.perRunUsd": 20 }), project({ "limits.perRunUsd": -2 })])?.value).toBe(20);
    expect(resolveConfig([project({ unknown: 1 })]).some((s) => s.key === "unknown")).toBe(false);
  });
  it("hashes sources, locks and organization identity deterministically", () => {
    const a = resolveConfig([org({ "merge.mode": "review" })]);
    expect(configVersion("a", a)).toBe(configVersion("a", a));
    expect(configVersion("b", a)).not.toBe(configVersion("a", a));
    expect(configVersion("a", resolveConfig([org({ "merge.mode": "review" }, ["merge.mode"])]))).not.toBe(
      configVersion("a", a),
    );
  });
});
