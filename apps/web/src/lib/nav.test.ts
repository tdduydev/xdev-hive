import { describe, expect, it } from "vitest";
import { activeNavItem, adminHome, inAdminArea, NAV_HOME, navGroupOf, visibleGroups } from "@/lib/nav.ts";

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

describe("inAdminArea", () => {
  it("covers every page of the admin menu, including pages under a project", () => {
    for (const path of ["/admin/members", "/admin/teams/t1", "/projects", "/projects/PAY/settings", "/machines"]) {
      expect(inAdminArea(path), path).toBe(true);
    }
    expect(inAdminArea("/notifications")).toBe(true);
  });

  it("leaves work pages and the project board outside", () => {
    for (const path of ["/", "/tasks", "/runs/r1", "/knowledge/docs", "/projects/PAY", "/projects/PAY/"]) {
      expect(inAdminArea(path), path).toBe(false);
    }
    expect(activeNavItem("/projects/PAY")?.id).toBe("tasks");
  });
});

describe("adminHome", () => {
  it("opens the first admin page the person may see", () => {
    expect(adminHome(visibleGroups(true))?.id).toBe("members");
    expect(adminHome(visibleGroups(false))?.to).toBe("/admin/members");
    expect(adminHome([])).toBeUndefined();
  });
});

describe("AI SDLC", () => {
  it("shows the group to people who can read items, with the questions page lit on its own", () => {
    const sdlc = (groups: ReturnType<typeof visibleGroups>) => groups.find((g) => g.id === "sdlc");
    expect(sdlc(visibleGroups(false, (p) => p === "sdlc.read"))?.items.map((i) => i.id)).toEqual([
      "sdlc-items",
      "sdlc-questions",
      "sdlc-metrics",
    ]);
    expect(sdlc(visibleGroups(false))).toBeUndefined();
    expect(sdlc(visibleGroups(false, (p) => p === "machines.read"))?.items.map((i) => i.id)).toEqual(["sdlc-fleet"]);
    expect(activeNavItem("/sdlc/fleet")?.id).toBe("sdlc-fleet");
    expect(
      visibleGroups(false, (p) => p === "sdlc.modes.write")
        .flatMap((g) => g.items)
        .some((i) => i.id === "sdlc-modes"),
    ).toBe(true);
    expect(activeNavItem("/sdlc/questions")?.id).toBe("sdlc-questions");
    expect(activeNavItem("/sdlc/metrics")?.id).toBe("sdlc-metrics");
    expect(activeNavItem("/sdlc/payment-api/12/tasks")?.id).toBe("sdlc-items");
    expect(inAdminArea("/sdlc")).toBe(false);
  });
});

describe("CI/CD", () => {
  const ids = (groups: ReturnType<typeof visibleGroups>) => groups.flatMap((g) => g.items.map((i) => i.id));

  it("shows the CI connection and server pages to org admins, or to people holding the dangerous permission", () => {
    expect(ids(visibleGroups(true))).toEqual(expect.arrayContaining(["ci-connections", "servers"]));
    expect(ids(visibleGroups(false, (p) => p === "ci.connections.manage"))).toContain("ci-connections");
    expect(ids(visibleGroups(false, (p) => p === "ci.connections.manage"))).not.toContain("servers");
    expect(ids(visibleGroups(false, (p) => p === "servers.manage"))).toContain("servers");
    expect(ids(visibleGroups(false, (p) => p === "servers.manage"))).not.toContain("ci-connections");
    expect(ids(visibleGroups(false))).not.toContain("ci-connections");
  });

  it("keeps the admin pages in the admin area and the project CI/CD page with the work pages", () => {
    expect(inAdminArea("/admin/ci-connections")).toBe(true);
    expect(inAdminArea("/admin/servers")).toBe(true);
    expect(activeNavItem("/admin/ci-connections")?.id).toBe("ci-connections");
    expect(activeNavItem("/admin/servers")?.id).toBe("servers");
    expect(inAdminArea("/projects/PAY/cicd")).toBe(false);
    expect(inAdminArea("/projects/PAY/cicd/")).toBe(false);
    expect(activeNavItem("/projects/PAY/cicd")?.id).toBe("tasks");
    expect(inAdminArea("/settings/jenkins-tokens")).toBe(false);
  });
});
