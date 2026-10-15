import { describe, expect, it } from "vitest";
import {
  contentHash,
  detectEol,
  fromLf,
  hasBom,
  isLfsPath,
  isLfsPointer,
  lfsPointer,
  parseFrontMatter,
  parseGitattributes,
  parseLfsPointer,
  titleOf,
  toLf,
} from "./content.ts";

describe("front-matter chỉ đọc, giữ nguyên văn", () => {
  it("đọc metadata với YAML nhiều dòng, dấu nháy, bình luận và BOM/CRLF", () => {
    const raw =
      '\uFEFF---\r\n# Giữ bình luận\r\ntitle: >-\r\n  Thiết kế\r\n  API\r\ntags: [api, "thiết kế", 2]\r\nconfidential: true\r\nhive:\r\n  key: project/shop/api\r\n---\r\n';
    const body = "# Nội dung\r\n";
    const parsed = parseFrontMatter(raw + body);
    expect(parsed).toEqual({
      raw,
      body,
      title: "Thiết kế API",
      tags: ["api", "thiết kế"],
      confidential: true,
      key: "project/shop/api",
      warnings: [],
    });
    expect(parsed.raw + parsed.body).toBe(raw + body);
  });

  it("không front-matter, rỗng, dấu kết thúc ... và hive.key dạng phẳng", () => {
    expect(parseFrontMatter("# Nội dung\n")).toEqual({
      raw: null,
      body: "# Nội dung\n",
      tags: [],
      confidential: false,
      warnings: [],
    });
    expect(parseFrontMatter("---\n---\n").warnings).toEqual([]);
    expect(parseFrontMatter("---\nhive.key: org/a\n...\n").key).toBe("org/a");
    expect(parseFrontMatter('---\nconfidential: "true"\n---\n').confidential).toBe(false);
  });

  it.each([
    "title: [sai",
    "title: a\ntitle: b",
    "title: !custom giá-trị",
    "!!js/function '() => 1'",
    "- a\n- b",
    "a: &a [1, 2, 3, 4, 5, 6, 7, 8]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b]",
  ])("YAML không hợp lệ chỉ cảnh báo, không lộ dòng nguồn", (yaml) => {
    const content = `---\n${yaml}\n---\n# Tiêu đề dự phòng\n`;
    const parsed = parseFrontMatter(content);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toBe("Front-matter YAML không hợp lệ hoặc có cấu trúc không được hỗ trợ.");
    expect(parsed.raw + parsed.body).toBe(content);
    expect(titleOf(content, "a.md")).toBe("Tiêu đề dự phòng");
  });

  it("cảnh báo khi chưa đóng và không nhận delimiter ở giữa dòng", () => {
    const unclosed = "---\ntitle: a\nKhông đóng\n";
    expect(parseFrontMatter(unclosed).body).toBe(unclosed);
    expect(parseFrontMatter(unclosed).warnings).toHaveLength(1);
    expect(parseFrontMatter("# a\n---\ntitle: b\n---\n").raw).toBeNull();
    expect(parseFrontMatter("---\ntitle: x ---\n# a\n").warnings).toHaveLength(1);
  });

  it("ưu tiên title, rồi H1 thật đầu tiên, rồi tên file", () => {
    expect(titleOf("---\ntitle: Theo metadata\n---\n# Khác", "a.md")).toBe("Theo metadata");
    expect(titleOf("```md\n# Trong code\n```\n\n## H2\n\n# H1 ###\n# Tiếp", "a.md")).toBe("H1");
    expect(titleOf("Nội dung", "docs/Thiết kế.MD")).toBe("Thiết kế");
    expect(titleOf(`# ${"a".repeat(220)}`, "a.md")).toHaveLength(200);
  });
});

describe("EOL, BOM và hash byte", () => {
  it.each(["", "a", "# a\n\nNội dung\n", "# a\n\nNội dung", "a\rb\n", "---\ntitle: a\n---\n"])(
    "khôi phục LF/CRLF và BOM: %j",
    (lf) => {
      for (const eol of ["lf", "crlf"] as const) {
        for (const bom of [false, true]) {
          const original = (bom ? "\uFEFF" : "") + (eol === "crlf" ? lf.replace(/\n/g, "\r\n") : lf);
          expect(Buffer.from(fromLf(toLf(original), detectEol(original), hasBom(original)))).toEqual(
            Buffer.from(original),
          );
        }
      }
    },
  );

  it("không nhân BOM hoặc CRLF khi gọi nhiều lần, giữ BOM ở giữa nội dung", () => {
    expect(fromLf("\uFEFFa\r\nb\uFEFF", "crlf", true)).toBe("\uFEFFa\r\nb\uFEFF");
    expect(toLf(toLf("\uFEFFa\r\n"))).toBe("a\n");
    expect(contentHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(contentHash(Buffer.from("Thiết kế"))).toBe(contentHash("Thiết kế"));
    expect(contentHash("a\n")).not.toBe(contentHash("a\r\n"));
    expect(contentHash("a\n")).not.toBe(contentHash("\uFEFFa\n"));
  });
});

describe("Git LFS", () => {
  const oid = "a".repeat(64);
  it("sinh và đọc con trỏ chuẩn, CRLF, file rỗng", () => {
    for (const size of [0, 2, 80 * 1024 * 1024, Number.MAX_SAFE_INTEGER]) {
      const pointer = lfsPointer(oid, size);
      expect(parseLfsPointer(pointer)).toEqual({ oid, size });
      expect(parseLfsPointer(pointer.replace(/\n/g, "\r\n"))).toEqual({ oid, size });
      expect(isLfsPointer(pointer)).toBe(true);
    }
  });

  it("không nhận văn bản hay con trỏ hỏng/ngoài giới hạn", () => {
    const pointer = lfsPointer(oid, 2);
    for (const invalid of [
      "",
      "# a",
      pointer.replace(oid, "a"),
      pointer.replace("size 2", "size -2"),
      pointer.replace("size 2", "size 02"),
      pointer.replace("size 2", "size 9007199254740992"),
      `\uFEFF${pointer}`,
      `${pointer}\n`,
      pointer.replace("sha256", "sha1"),
    ]) {
      expect(parseLfsPointer(invalid), invalid).toBeNull();
      expect(isLfsPointer(invalid)).toBe(false);
    }
    for (const size of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      expect(() => lfsPointer(oid, size)).toThrow();
    expect(() => lfsPointer("b", 1)).toThrow();
  });

  it("gitattributes theo thứ tự, quy tắc không slash ở mọi cấp và ghi đè riêng filter", () => {
    const rules = parseGitattributes(`
# Chỉ các thuộc tính filter tác động tới LFS
*.psd filter=lfs diff=lfs -text
assets/**/*.mp4 filter=lfs
assets/private/*.psd -filter
assets/private/ok.psd filter=lfs
assets/private/ok.psd diff=custom
assets/other.psd filter=custom
assets/reset.psd !filter
/root.bin filter=lfs
"file có dấu.psd" filter=lfs
folder/ filter=lfs
!bad.psd filter=lfs
[attr]large filter=lfs
*.p[sd]d filter=lfs
`);
    for (const path of [
      "a.psd",
      "x/y/a.psd",
      "assets/a.mp4",
      "assets/x/a.mp4",
      "assets/private/ok.psd",
      "root.bin",
      "x/file có dấu.psd",
    ])
      expect(isLfsPath(path, rules), path).toBe(true);
    for (const path of [
      "a.png",
      "assets/private/no.psd",
      "assets/other.psd",
      "assets/reset.psd",
      "x/root.bin",
      "folder/a.bin",
      "a.psd/child.bin",
      "a.pdd",
    ])
      expect(isLfsPath(path, rules), path).toBe(false);
  });
});
