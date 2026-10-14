import { describe, expect, it } from "vitest";
import { can, navGroups, screenFromHash } from "@/lib/nav.ts";

describe("AI SDLC trong menu app", () => {
  for (const profile of ["dev", "writer", "lead"] as const) {
    it(`${profile}: màn hub, cần kết nối Hive`, () => {
      const items = navGroups(profile).find((g) => g.id === "sdlc")?.items;
      expect(items?.map((i) => i.id)).toEqual(["sdlc", "sdlc-questions", "sdlc-progress"]);
      expect(items?.every((i) => i.hub)).toBe(true);
      expect(can(profile, "sdlc.manage")).toBe(profile === "lead");
    });
  }
  it("mở thẳng tab vẫn chọn đúng màn", () => {
    expect(screenFromHash("#/sdlc/payment-api/012/trace")).toBe("sdlc");
    expect(screenFromHash("#/sdlc-questions")).toBe("sdlc-questions");
  });
});
