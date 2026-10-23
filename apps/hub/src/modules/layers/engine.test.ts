import { describe, expect, it } from "vitest";
import { configVersion, type LayerInput, resolveConfig, withoutChain } from "./engine.ts";

const L = (
  layer: LayerInput["layer"],
  values: Record<string, unknown>,
  locks: string[] = [],
  targetId = layer,
): LayerInput => ({
  layer,
  targetId,
  values,
  locks,
});
const get = (layers: LayerInput[], key: string) => {
  const s = resolveConfig(layers).find((x) => x.key === key);
  if (!s) throw new Error(key);
  return s;
};

describe("engine: không tầng nào đặt gì", () => {
  it("trả mặc định như hành vi hiện tại", () => {
    expect(get([], "agent.allowFullPermission")).toMatchObject({ value: true, source: null });
    expect(get([], "limits.perRunUsd").value).toBeNull();
    expect(get([], "limits.runLogRetentionDays").value).toBe(365);
    expect(get([], "agent.permissionMode").value).toBe("workspace");
    expect(get([], "agent.hooks").value).toEqual([]);
  });
});

describe("engine: trần", () => {
  it("số: lấy giá trị nhỏ nhất, tầng dưới đặt cao hơn bị hạ và được đánh dấu", () => {
    const s = get(
      [
        L("org", { "limits.perRunUsd": 20 }),
        L("team", { "limits.perRunUsd": 5 }),
        L("project", { "limits.perRunUsd": 8 }),
      ],
      "limits.perRunUsd",
    );
    expect(s.value).toBe(5);
    expect(s.source).toEqual({ layer: "team", targetId: "team" });
    expect(s.overCeiling).toEqual({ layer: "project", targetId: "project", value: 8 });
  });
  it("số: null là không giới hạn, không thắng giá trị có số", () => {
    const s = get(
      [L("org", { "limits.perRunUsd": 20 }), L("project", { "limits.perRunUsd": null })],
      "limits.perRunUsd",
    );
    expect(s.value).toBe(20);
    expect(s.overCeiling).toBeNull();
  });
  it("tầng ngoài đặt lỏng hơn tầng trong không bị coi là vượt trần", () => {
    const s = get([L("org", { "limits.perRunUsd": 20 }), L("team", { "limits.perRunUsd": 5 })], "limits.perRunUsd");
    expect(s.value).toBe(5);
    expect(s.overCeiling).toBeNull();
  });
  it("bool: false thắng ở allowFullPermission, true thắng ở requireSandbox", () => {
    expect(
      get(
        [L("org", { "agent.allowFullPermission": false }), L("team", { "agent.allowFullPermission": true })],
        "agent.allowFullPermission",
      ),
    ).toMatchObject({
      value: false,
      overCeiling: { layer: "team" },
    });
    expect(
      get(
        [L("org", { "agent.requireSandbox": true }), L("team", { "agent.requireSandbox": false })],
        "agent.requireSandbox",
      ).value,
    ).toBe(true);
  });
  it("thang: giá trị thấp nhất thắng", () => {
    expect(
      get([L("org", { "agent.memoryMode": "direct" }), L("team", { "agent.memoryMode": "off" })], "agent.memoryMode")
        .value,
    ).toBe("off");
    expect(
      get(
        [L("org", { "agent.memoryMode": "propose" }), L("team", { "agent.memoryMode": "direct" })],
        "agent.memoryMode",
      ),
    ).toMatchObject({
      value: "propose",
      overCeiling: { layer: "team", value: "direct" },
    });
  });
  it("khoá không có tác dụng với trần", () => {
    const s = get(
      [L("org", { "limits.perRunUsd": 20 }, ["limits.perRunUsd"]), L("team", { "limits.perRunUsd": 5 })],
      "limits.perRunUsd",
    );
    expect(s.value).toBe(5);
  });
  it("bỏ qua giá trị sai schema và tầng không được phép đặt khoá", () => {
    expect(get([L("org", { "limits.perRunUsd": -3 })], "limits.perRunUsd").value).toBeNull();
    expect(get([L("project", { "agent.requireSandbox": true })], "agent.requireSandbox").value).toBe(false);
  });
});

describe("engine: ghi đè", () => {
  it("tầng gần nhất thắng", () => {
    const s = get(
      [
        L("org", { "merge.mode": "review" }),
        L("team", { "merge.mode": "auto" }),
        L("project", { "merge.mode": "review" }),
      ],
      "merge.mode",
    );
    expect(s).toMatchObject({ value: "review", source: { layer: "project" } });
  });
  it("khoá ở công ty: giá trị của dự án còn lưu nhưng không áp", () => {
    const s = get(
      [L("org", { "merge.mode": "review" }, ["merge.mode"]), L("project", { "merge.mode": "auto" })],
      "merge.mode",
    );
    expect(s).toMatchObject({ value: "review", lock: { layer: "org" }, source: { layer: "org" } });
    expect(s.chain?.find((c) => c.layer === "project")).toMatchObject({ value: "auto", applied: false });
  });
  it("khoá ở đội: tầng dự án bị chặn, tầng đội vẫn tính", () => {
    const s = get(
      [L("team", { "merge.mode": "auto" }, ["merge.mode"]), L("project", { "merge.mode": "review" })],
      "merge.mode",
    );
    expect(s.value).toBe("auto");
  });
  it("khoá không có giá trị giữ nguyên giá trị tầng ngoài hoặc mặc định", () => {
    const s = get([L("org", {}, ["merge.mode"]), L("project", { "merge.mode": "auto" })], "merge.mode");
    expect(s.value).toBe("review");
  });
  it("quyền full bị thu về workspace khi tổ chức cấm toàn quyền", () => {
    const s = get(
      [L("org", { "agent.allowFullPermission": false }), L("project", { "agent.permissionMode": "full" })],
      "agent.permissionMode",
    );
    expect(s).toMatchObject({ value: "workspace", overCeiling: { layer: "project", value: "full" } });
  });
  it("null không phải là đặt về mặc định: khoá sai schema bị bỏ qua", () => {
    expect(get([L("project", { "merge.mode": null })], "merge.mode").value).toBe("review");
  });
});

describe("engine: cộng dồn", () => {
  const hook = (name: string, command = "echo") => ({ event: "PreToolUse", name, command });
  it("gộp theo danh tính, tầng ngoài đi trước và không bị ghi đè", () => {
    const s = get(
      [L("org", { "agent.hooks": [hook("a", "org")] }), L("team", { "agent.hooks": [hook("a", "team"), hook("b")] })],
      "agent.hooks",
    );
    expect(s.value).toEqual([hook("a", "org"), hook("b")]);
  });
});

describe("engine: tính chất", () => {
  it("100 tổ hợp ngẫu nhiên không bao giờ làm trần rộng hơn tầng ngoài", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed / 2 ** 32;
    };
    const pick = () => (rnd() < 0.3 ? undefined : Math.ceil(rnd() * 50));
    for (let i = 0; i < 100; i++) {
      const [org, team, project] = [pick(), pick(), pick()];
      const layers = [org, team, project].map((v, n) =>
        L((["org", "team", "project"] as const)[n] as "org", v === undefined ? {} : { "limits.perRunUsd": v }),
      );
      const v = get(layers, "limits.perRunUsd").value as number | null;
      for (const x of [org, team, project]) if (x !== undefined && v !== null) expect(v).toBeLessThanOrEqual(x);
    }
  });
  it("thứ tự mảng đầu vào không đổi kết quả", () => {
    const a = L("org", { "limits.perRunUsd": 9 });
    const b = L("team", { "limits.perRunUsd": 4 });
    expect(resolveConfig([a, b])).toEqual(resolveConfig([b, a]));
  });
});

describe("configVersion", () => {
  const settings = resolveConfig([L("org", { "limits.perRunUsd": 9 })]);
  it("ổn định và đổi khi giá trị đổi", () => {
    expect(configVersion("o1", settings)).toBe(
      configVersion("o1", resolveConfig([L("org", { "limits.perRunUsd": 9 })])),
    );
    expect(configVersion("o1", settings)).not.toBe(
      configVersion("o1", resolveConfig([L("org", { "limits.perRunUsd": 8 })])),
    );
  });
  it("khác công ty thì khác mã dù cùng nội dung (FR-069)", () => {
    expect(configVersion("o1", settings)).not.toBe(configVersion("o2", settings));
  });
  it("không đổi khi chỉ đổi nguồn của cùng giá trị", () => {
    const viaTeam = resolveConfig([L("team", { "limits.perRunUsd": 9 })]);
    expect(configVersion("o1", viaTeam)).toBe(configVersion("o1", settings));
  });
  it("withoutChain bỏ chuỗi tầng", () => {
    expect(withoutChain(settings[0] as (typeof settings)[number])).not.toHaveProperty("chain");
  });
});
