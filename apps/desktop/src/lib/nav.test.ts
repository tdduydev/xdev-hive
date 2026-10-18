import { describe, expect, it } from "vitest";
import { can, NAV_GROUPS, navGroups, navItems, screenFromHash } from "@/lib/nav.ts";

describe("menu theo hồ sơ", () => {
  it("dev: mọi mục trên máy, Tài liệu từ code chỉ đọc vì không có quyền viết tài liệu", () => {
    const items = navItems("dev");
    expect(items.map((i) => i.id)).toEqual([
      "home",
      "agents",
      "terminal",
      "runs",
      "remote",
      "plans",
      "skills",
      "memory",
      "tokens",
      "projects",
      "setup",
      "ssh",
      "docs",
      "settings",
    ]);
    expect(items.find((i) => i.id === "docs")?.readOnly).toBe(true);
    expect(items.find((i) => i.id === "skills")?.readOnly).toBe(false);
  });

  it("writer: không có worker, gói, môi trường; Skills và Tài liệu từ code chỉ đọc", () => {
    const items = navItems("writer");
    expect(items.map((i) => i.id)).toEqual([
      "home",
      "agents",
      "terminal",
      "skills",
      "memory",
      "tokens",
      "ssh",
      "docs",
      "settings",
    ]);
    expect(items.filter((i) => i.readOnly).map((i) => i.id)).toEqual(["skills", "docs"]);
  });

  it("lead: thấy hết, Tài liệu từ code sửa được", () => {
    const items = navItems("lead");
    expect(items).toHaveLength(14);
    expect(items.some((i) => i.readOnly)).toBe(false);
  });

  it("Máy này đứng đầu không tiêu đề, rồi ba nhóm Chạy, Agent, Dự án", () => {
    const groups = navGroups("lead");
    expect(groups.map((g) => [g.label.vi, g.untitled ?? false, g.items.map((i) => i.label.vi)])).toEqual([
      ["Máy này", true, ["Máy này"]],
      ["Chạy", false, ["Agent trên máy", "Terminal", "Lượt chạy", "Điều khiển từ xa"]],
      ["Agent", false, ["Gói agent", "Skills", "Memory", "Token và ngữ cảnh"]],
      ["Dự án", false, ["Dự án trên máy", "Môi trường", "Máy chủ SSH", "Tài liệu từ code"]],
    ]);
    expect(groups.map((g) => g.label.en)).toEqual(["This machine", "Runs", "Agents", "Projects"]);
  });

  it("chỉ Lượt chạy cần hub; mọi mục khác dùng được khi chưa đăng nhập", () => {
    expect(
      navItems("lead")
        .filter((i) => i.hub)
        .map((i) => i.id),
    ).toEqual(["runs"]);
  });

  it("nhóm không còn mục nào theo hồ sơ thì bỏ cả nhóm", () => {
    expect(navGroups("writer").map((g) => g.id)).toEqual(["machine", "run", "agent", "project"]);
    const onlyRuns = NAV_GROUPS.map((g) => (g.id === "agent" ? { ...g, items: [] } : g));
    expect(navGroups("dev", onlyRuns).map((g) => g.id)).toEqual(["machine", "run", "project"]);
  });

  it("quyền của hồ sơ", () => {
    expect(can("lead", "docs.write")).toBe(true);
    expect(can("dev", "docs.write")).toBe(false);
    expect(can("dev", "docs.propose")).toBe(true);
    expect(can("writer", "runs.local")).toBe(false);
  });
});

describe("đường dẫn", () => {
  it("màn của app theo #/", () => {
    expect(screenFromHash("#/skills")).toBe("skills");
    expect(screenFromHash("#/settings")).toBe("settings");
    expect(screenFromHash("")).toBe("home");
    expect(screenFromHash("#/khong-co")).toBe("home");
  });

  it("màn đã chuyển sang web (liên kết cũ, lịch sử) về Máy này", () => {
    for (const old of [
      "#/work",
      "#/reviews",
      "#/leader/abc",
      "#/artifacts/abc/2",
      "#/sdlc/payment-api/012/trace",
      "#/sdlc-questions",
      "#/knowledge",
      "#/write/project%2Fpay%2Fprd",
    ])
      expect(screenFromHash(old)).toBe("home");
  });
});
