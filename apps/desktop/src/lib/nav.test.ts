import { describe, expect, it } from "vitest";
import { can, navGroups, screenFromHash } from "@/lib/nav.ts";

describe("AI SDLC trong menu app", () => {
  for (const profile of ["dev", "writer", "lead"] as const) {
    it(`${profile}: màn hub, cần kết nối Hive`, () => {
      const items = navGroups(profile).find((g) => g.id === "sdlc")?.items;
      expect(items?.map((i) => i.id)).toEqual(["sdlc", "sdlc-questions", "sdlc-progress", "sdlc-metrics"]);
      expect(items?.every((i) => i.hub)).toBe(true);
      expect(can(profile, "sdlc.manage")).toBe(profile === "lead");
    });
  }
  it("mở thẳng tab vẫn chọn đúng màn", () => {
    expect(screenFromHash("#/sdlc/payment-api/012/trace")).toBe("sdlc");
    expect(screenFromHash("#/sdlc-questions")).toBe("sdlc-questions");
  });
});

describe("Leader và Artifact trong menu app", () => {
  const ids = (profile: Parameters<typeof navGroups>[0], features?: Parameters<typeof navGroups>[2]) =>
    navGroups(profile, undefined, features).flatMap((g) => g.items.map((i) => i.id));

  it("Artifact cho dev, writer, lead; Leader chỉ dev và lead", () => {
    expect(ids("dev")).toEqual(expect.arrayContaining(["leader", "artifacts"]));
    expect(ids("lead")).toEqual(expect.arrayContaining(["leader", "artifacts"]));
    expect(ids("writer")).toContain("artifacts");
    expect(ids("writer")).not.toContain("leader");
  });

  it("hub không có artifacts thì ẩn mục Artifact, giữ Leader", () => {
    expect(ids("dev", { artifacts: false })).not.toContain("artifacts");
    expect(ids("dev", { artifacts: false })).toContain("leader");
    expect(ids("dev", { artifacts: true })).toContain("artifacts");
  });

  it("hash chi tiết vẫn chọn đúng màn", () => {
    expect(screenFromHash("#/artifacts/abc/2")).toBe("artifacts");
    expect(screenFromHash("#/leader/abc")).toBe("leader");
  });
});
