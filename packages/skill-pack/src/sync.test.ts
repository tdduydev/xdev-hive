import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { check, pull } from "../scripts/sync.ts";
import { PACK_DIR, readManifest } from "./index.ts";

let fixture: string;
let source: string;
let pack: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: "pipe" }).trim();
const commit = () => {
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  );
};
const skill = "---\nname: demo\ndescription: Skill thử nghiệm\n---\nNội dung\n";

beforeEach(() => {
  const parent = resolve(PACK_DIR, "../../.e2e");
  mkdirSync(parent, { recursive: true });
  fixture = mkdtempSync(join(parent, "skill-pack-"));
  source = join(fixture, "xdev-skills");
  pack = join(fixture, "pack");
  mkdirSync(join(source, "library/demo"), { recursive: true });
  mkdirSync(pack);
  // Submodule dùng file .git thay vì thư mục; fixture cũng phải chạy được với cách lưu này.
  git("init", "--separate-git-dir", join(fixture, "source.git"));
  writeFileSync(join(source, "library/demo/SKILL.md"), skill);
  writeFileSync(join(source, "NOTICE.md"), "Giấy phép thử nghiệm\n");
  writeFileSync(
    join(source, "sources.json"),
    JSON.stringify({ repos: {}, skills: [{ name: "demo", group: "hive", license: "MIT" }] }),
  );
  commit();
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

describe("đồng bộ từ submodule", () => {
  it("chép nguồn, ghi commit và kiểm được bản vendored", () => {
    pull(source, pack);
    expect(readManifest(pack).source.commit).toBe(git("rev-parse", "HEAD"));
    expect(readFileSync(join(pack, "skills/demo/SKILL.md"), "utf8")).toBe(skill);
    expect(() => check(source, pack)).not.toThrow();
    pull(source, pack);
    expect(readManifest(pack).skills[0]?.version).toBe(1);
  });

  it("từ chối HEAD lệch manifest dù commit cũ vẫn có trong repo", () => {
    pull(source, pack);
    writeFileSync(join(source, "README.md"), "Commit mới\n");
    commit();
    expect(() => check(source, pack)).toThrow("Commit submodule xdev-skills");
    pull(source, pack);
    expect(() => check(source, pack)).not.toThrow();
  });

  it("không nhận HEAD repo cha khi submodule chưa init", () => {
    const missing = join(fixture, "missing");
    mkdirSync(missing);
    expect(() => check(missing, pack)).toThrow("git submodule update --init xdev-skills");
    expect(() => pull(missing, pack)).toThrow("git submodule update --init xdev-skills");
  });

  it.each(["library/demo/SKILL.md", "untracked.txt"])("từ chối nguồn bẩn: %s", (path) => {
    pull(source, pack);
    writeFileSync(join(source, path), "Chưa commit\n");
    expect(() => check(source, pack)).toThrow("còn thay đổi chưa commit");
    expect(() => pull(source, pack)).toThrow("còn thay đổi chưa commit");
  });

  it("không đóng gói file bị ignore dù git status báo sạch", () => {
    writeFileSync(join(source, ".gitignore"), "*.log\n");
    commit();
    pull(source, pack);
    writeFileSync(join(source, "library/demo/local.log"), "Dữ liệu cục bộ\n");
    expect(git("status", "--porcelain")).toBe("");
    expect(() => check(source, pack)).toThrow("có file bị Git ignore");
    expect(() => pull(source, pack)).toThrow("có file bị Git ignore");
  });

  it.each(["skills/demo/SKILL.md", "NOTICE.md", "pack.json"])("phát hiện bản vendored sửa tay: %s", (path) => {
    pull(source, pack);
    if (path === "pack.json") {
      const manifest = readManifest(pack);
      const first = manifest.skills[0];
      if (!first) throw new Error("Fixture thiếu skill");
      first.description = "Sai mô tả";
      writeFileSync(join(pack, path), JSON.stringify(manifest));
    } else writeFileSync(join(pack, path), "Nội dung sai\n");
    expect(() => check(source, pack)).toThrow("khác");
  });

  it("phát hiện skill thừa trong bản vendored", () => {
    pull(source, pack);
    mkdirSync(join(pack, "skills/extra"));
    expect(() => check(source, pack)).toThrow("Danh sách skills/");
  });

  it("tăng version khi cập nhật nội dung đã commit", () => {
    pull(source, pack);
    writeFileSync(join(source, "library/demo/SKILL.md"), `${skill}Bổ sung\n`);
    commit();
    pull(source, pack);
    expect(readManifest(pack).skills[0]?.version).toBe(2);
    expect(() => check(source, pack)).not.toThrow();
  });
});
