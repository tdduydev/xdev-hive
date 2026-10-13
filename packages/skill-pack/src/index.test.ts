import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACK_DIR, parseFrontmatter, readManifest, skillFiles, skillText, treeHash } from "./index.ts";

const manifest = readManifest();

describe("bộ skill mặc định", () => {
  it("mỗi thư mục trong skills/ có trong pack.json và ngược lại", () => {
    expect(readdirSync(join(PACK_DIR, "skills")).sort()).toEqual(manifest.skills.map((s) => s.name).sort());
  });

  // Bản sao phải trùng xdev-skills ở commit ghim; sửa tay ở đây sẽ mất ở lần đồng bộ sau.
  it.each(manifest.skills.map((s) => [s.name, s] as const))("%s khớp hash và frontmatter", (name, s) => {
    expect(treeHash(join(PACK_DIR, "skills", name))).toBe(s.hash);
    const fm = parseFrontmatter(skillText(name));
    expect(fm.name).toBe(name);
    expect(fm.description).toBe(s.description);
    expect(skillFiles(name)[0]?.path).toBe("SKILL.md");
    expect(skillFiles(name)).toHaveLength(s.files);
  });

  it("mỗi skill lấy từ nơi khác có giấy phép và SOURCE.md", () => {
    for (const s of manifest.skills) {
      const files = readdirSync(join(PACK_DIR, "skills", s.name));
      expect(
        files.some((f) => /^LICEN[CS]E/i.test(f)),
        s.name,
      ).toBe(true);
      expect(existsSync(join(PACK_DIR, "skills", s.name, "SOURCE.md")), s.name).toBe(true);
      expect(["MIT", "Apache-2.0", "MIT AND Apache-2.0", "CC-BY-SA-4.0"]).toContain(s.license);
    }
    expect(existsSync(join(PACK_DIR, "NOTICE.md"))).toBe(true);
  });

  it("chỉ bật sẵn nhóm nhỏ", () => {
    expect(manifest.skills.filter((s) => s.defaultOn).map((s) => s.name)).toEqual([
      "ui-ux-pro-max",
      "web-design-guidelines",
      "test-driven-development",
      "systematic-debugging",
      "verification-before-completion",
      "hive-run-etiquette",
      "vietnamese-ui-copy",
    ]);
  });
});

describe("parseFrontmatter", () => {
  it("đọc description nhiều dòng và trong ngoặc kép", () => {
    expect(
      parseFrontmatter("---\nname: a\ndescription:\n  dòng một\n  dòng hai\nlicense: MIT\n---\n").description,
    ).toBe("dòng một dòng hai");
    expect(parseFrontmatter('---\nname: "b"\ndescription: "x: y"\n---\n')).toEqual({ name: "b", description: "x: y" });
    expect(parseFrontmatter("không có frontmatter")).toEqual({ name: null, description: "" });
  });
});
