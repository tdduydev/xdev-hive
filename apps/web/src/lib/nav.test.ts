import { describe, expect, it } from "vitest";
import { activeNavItem, NAV_HOME, navGroupOf } from "@/lib/nav.ts";

describe("navGroupOf", () => {
  it("finds the sidebar group of the page so the topbar can show it", () => {
    expect(navGroupOf(activeNavItem("/admin/members"))?.label.vi).toBe("Người và quyền");
    expect(navGroupOf(activeNavItem("/projects/PAY/settings"))?.label.vi).toBe("Dự án và hạ tầng");
  });

  it("has no group for the overview or unknown pages", () => {
    expect(navGroupOf(NAV_HOME)).toBeUndefined();
    expect(navGroupOf(undefined)).toBeUndefined();
  });
});
