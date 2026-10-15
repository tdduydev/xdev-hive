import { docKey } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import {
  isHardExcluded,
  keyFromPath,
  matchesHome,
  overlaps,
  type PathHome,
  pathFromKey,
  resolveRelative,
  uniqueKey,
} from "./paths.ts";

const project: PathHome = { scope: "project", projectKey: "shop", root: "docs/" };
const org: PathHome = { scope: "org" };

describe("key và đường dẫn repo", () => {
  it.each([
    ["docs/Thiết kế/API.md", "project/shop/thiet-ke/api"],
    ["docs/ĐĂNG NHẬP/README.MD", "project/shop/dang-nhap/readme"],
    ["docs/Thiết kế/API.md", "project/shop/thiet-ke/api"],
    ["docs/___/🤖.md", "project/shop/doc/doc"],
    ["docs/.Ẩn/a___b..c.md", "project/shop/an/a___b..c"],
    ["specs/018-docs/spec.md", "project/shop/specs/018-docs/spec"],
    ["README.md", "project/shop/readme"],
  ])("%s → %s", (path, expected) => {
    expect(keyFromPath(path, project)).toBe(expected);
  });

  it("ánh xạ tổ chức và đội, kể cả root tuỳ chỉnh", () => {
    expect(keyFromPath("org/Quy trình.md", org)).toBe("org/quy-trinh");
    expect(keyFromPath("teams/dev/README.md", org)).toBe("team/dev/readme");
    expect(keyFromPath("teams/DEV/a.md", org)).toBeNull();
    expect(keyFromPath("README.md", org)).toBeNull();
    expect(keyFromPath("manual/org/a.md", { ...org, root: "manual/" })).toBe("org/a");
    expect(keyFromPath("org/a.md", { ...org, root: "manual/" })).toBeNull();
  });

  it("key ghim phải hợp lệ, đúng phạm vi, không lấy tài liệu SDLC", () => {
    expect(keyFromPath("docs/a.md", project, "project/shop/ghim")).toBe("project/shop/ghim");
    for (const key of ["org/a", "project/shop-other/a", "Project/shop/A", "project/shop/../a"]) {
      expect(keyFromPath("docs/a.md", project, key)).toBe("project/shop/a");
    }
    expect(keyFromPath("teams/dev/a.md", org, "team/ops/ghim")).toBe("team/dev/a");
    expect(keyFromPath("docs/sdlc/a.md", project)).toBeNull();
    expect(keyFromPath("docs/a.md", project, "project/shop/sdlc/spec")).toBeNull();
    expect(keyFromPath("docs/a.pdf", project)).toBeNull();
  });

  it("tạo đường dẫn mới theo root, chặn key khác phạm vi", () => {
    expect(pathFromKey("project/shop/a/b", project)).toBe("docs/a/b.md");
    expect(pathFromKey("org/quy-trinh", org)).toBe("org/quy-trinh.md");
    expect(pathFromKey("team/dev/a", org)).toBe("teams/dev/a.md");
    expect(pathFromKey("team/dev/a", { ...org, root: "manual" })).toBe("manual/teams/dev/a.md");
    for (const key of ["org/a", "project/other/a", "project/shop/sdlc/a", "project/shop/../a"]) {
      expect(() => pathFromKey(key, project)).toThrow();
    }
    expect(() => pathFromKey("project/shop/a", org)).toThrow();
  });

  it("cắt key dài kèm hash đường dẫn, hậu tố trùng vẫn tối đa 200 ký tự", () => {
    const path = `docs/${"a".repeat(250)}.md`;
    const key = keyFromPath(path, project) as string;
    expect(key).toHaveLength(200);
    expect(key).toMatch(/-[a-f0-9]{8}$/);
    expect(keyFromPath(path, project)).toBe(key);
    expect(keyFromPath(`${path.slice(0, -3)}b.md`, project)).not.toBe(key);
    const occupied = new Set([key]);
    const second = uniqueKey(key, occupied);
    expect(second).toHaveLength(200);
    expect(second).toMatch(/-2$/);
    expect(docKey.safeParse(second).success).toBe(true);
    occupied.add(second);
    expect(uniqueKey(key, occupied)).toMatch(/-3$/);
    expect(uniqueKey("org/a", new Set())).toBe("org/a");
    expect(uniqueKey("org/a", new Set(["org/a", "org/a-2"]))).toBe("org/a-3");
    expect(() => uniqueKey("../a", new Set())).toThrow();
    const longScope = `project/${"a".repeat(190)}/b`;
    expect(() => uniqueKey(longScope, new Set([longScope]))).toThrow();
  });

  it.each(["../a.md", "/a.md", "docs/../a.md", "a\\b.md", "a//b.md", "a/./b.md", "C:/a.md", "a\u0000.md"])(
    "chặn đường dẫn không an toàn %j",
    (path) => {
      expect(() => keyFromPath(path, project)).toThrow();
      expect(isHardExcluded(path)).toBe(true);
    },
  );
});

describe("chọn phạm vi và loại trừ", () => {
  it.each([".git/config", "a/.hive/a.md", "docs/.claude/a.md", "node_modules/x/a.md", "docs/AGENTS.md", "CLAUDE.md"])(
    "không cho ghi đè loại trừ cứng %s",
    (path) => {
      expect(isHardExcluded(path)).toBe(true);
      expect(matchesHome(path, { ...project, include: ["**"], exclude: [] })).toBe(false);
    },
  );

  it("loại SDLC và kho skill theo ranh giới thư mục", () => {
    const managed = { sdlcRoot: "specs/", sdlcPaths: ["docs/legacy.md"], skillRoots: ["skills/"] };
    for (const path of ["specs/a.md", "docs/legacy.md", "skills/SKILL.md"]) {
      expect(matchesHome(path, project, managed)).toBe(false);
    }
    expect(isHardExcluded("specs-old/a.md", managed)).toBe(false);
    expect(isHardExcluded("docs/a.md", { key: "project/shop/sdlc/a" })).toBe(true);
    expect(isHardExcluded("docs/a.md", { key: "project/shop/sdlc-old/a" })).toBe(false);
  });

  it("mẫu mặc định Q11, root tuỳ chỉnh, mẫu người dùng và nhà tổ chức", () => {
    for (const path of ["docs/a.md", "doc/a.md", "specs/a.md", "adr/a.md", "x/adr/a.md", "x/README.md", "a.md"]) {
      expect(matchesHome(path, project), path).toBe(true);
    }
    for (const path of [
      "vendor/README.md",
      ".github/README.md",
      "docs/CHANGELOG.md",
      "docs/LICENSE.txt",
      "src/code.ts",
      "x/a.md",
    ]) {
      expect(matchesHome(path, project), path).toBe(false);
    }
    expect(matchesHome("manual/img/a.png", { ...project, root: "manual" })).toBe(true);
    expect(matchesHome("x/a.md", { ...project, include: ["x/**"], exclude: [] })).toBe(true);
    expect(matchesHome("docs/a.md", { ...project, include: [] })).toBe(false);
    expect(matchesHome("org/a.md", org)).toBe(true);
    expect(matchesHome("teams/dev/a.md", org)).toBe(true);
    expect(matchesHome("docs/a.md", org)).toBe(false);
  });

  it.each([
    ["docs", "docs/", true],
    ["docs", "docs/a", true],
    ["docs/a", "docs", true],
    ["docs", "docs-other", false],
    ["", "docs", true],
    ["org", "teams/dev", false],
  ])("chồng root %s và %s", (a, b, expected) => {
    expect(overlaps(a, b)).toBe(expected);
  });

  it("root phải tương đối với repo", () => {
    expect(() => overlaps("/", "docs")).toThrow();
    expect(() => overlaps("../docs", "docs")).toThrow();
    expect(() => pathFromKey("project/shop/a", { ...project, root: "/" })).toThrow();
  });
});

describe("link tương đối", () => {
  it.each([
    ["./img/a.png", "docs/guide/img/a.png", "", ""],
    ["../assets/a%20b.png?raw=1#view", "docs/assets/a b.png", "?raw=1", "#view"],
    ["../../specs/a.md#api", "specs/a.md", "", "#api"],
    ["#muc-1", "docs/guide/a.md", "", "#muc-1"],
    ["?raw=1", "docs/guide/a.md", "?raw=1", ""],
    ["", "docs/guide/a.md", "", ""],
  ])("%s", (href, path, query, fragment) => {
    expect(resolveRelative("docs/guide/a.md", href)).toEqual({ path, query, fragment });
  });

  it.each([
    "../../../a.md",
    "%2e%2e/%2e%2e/%2e%2e/a.md",
    "https://example.com/a",
    "mailto:a@example.com",
    "javascript:alert(1)",
    "data:image/png;base64,a",
    "//host/a",
    "/docs/a",
    "%2fhost/a",
    "a%00b",
    "%zz",
    "..\\a",
    " a.md",
    "../../.git/config",
    "%6aavascript%3Aalert(1)",
  ])("không phân giải %j vào kho file", (href) => {
    expect(resolveRelative("docs/guide/a.md", href)).toBeNull();
  });
});
