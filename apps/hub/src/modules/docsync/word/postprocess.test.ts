import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseFrontMatter } from "../content.ts";
import { countStats, frontMatter, parsePandocLog, relinkImages, renameImages } from "./postprocess.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("renameImages", () => {
  it("đặt tên ảnh bằng 12 ký tự đầu SHA-256 và đổi link, chỉ giữ tên ảnh", () => {
    const hash = sha("abc");
    expect(hash.slice(0, 12)).toBe("ba7816bf8f01");
    const result = renameImages("Đây là ảnh:\n\n![](m/media/image1.png)\n", [
      { path: "m/media/image1.png", bytes: bytes("abc") },
    ]);
    expect(result.markdown).toBe("Đây là ảnh:\n\n![](ba7816bf8f01.png)\n");
    expect(result.images).toEqual([{ name: "ba7816bf8f01.png", sha256: hash, bytes: bytes("abc") }]);
  });

  it("hai ảnh cùng nội dung ra cùng một tên và một dòng trong danh sách", () => {
    const result = renameImages("![](m/media/image1.png)\n\n![](m/media/image7.png)\n", [
      { path: "m/media/image1.png", bytes: bytes("abc") },
      { path: "m/media/image7.png", bytes: bytes("abc") },
    ]);
    expect(result.markdown).toBe("![](ba7816bf8f01.png)\n\n![](ba7816bf8f01.png)\n");
    expect(result.images.map((i) => i.name)).toEqual(["ba7816bf8f01.png"]);
  });

  it("đuôi hạ chữ thường, lấy từ ext nếu có (kết quả của inspectFileType)", () => {
    const result = renameImages("![](m/media/a.PNG) ![](m/media/b.bin)", [
      { path: "m/media/a.PNG", bytes: bytes("a") },
      { path: "m/media/b.bin", bytes: bytes("b"), ext: "jpg" },
    ]);
    expect(result.images.map((i) => i.name)).toEqual(
      [`${sha("a").slice(0, 12)}.png`, `${sha("b").slice(0, 12)}.jpg`].sort(),
    );
  });

  it("đổi cả ảnh trong ô bảng, giữ chữ thay thế, không đụng link ngoài hay ảnh không có trong danh sách", () => {
    const md =
      "| A | B |\n| --- | --- |\n| ![hình](m/media/image1.png) | ![](https://x.test/m/media/image1.png) |\n\n![](m/media/lạ.png)\n";
    const result = renameImages(md, [{ path: "m/media/image1.png", bytes: bytes("abc") }]);
    expect(result.markdown).toBe(
      "| A | B |\n| --- | --- |\n| ![hình](ba7816bf8f01.png) | ![](https://x.test/m/media/image1.png) |\n\n![](m/media/lạ.png)\n",
    );
  });

  it("ảnh có trong danh sách mà Markdown không dùng vẫn được trả về để lưu đính kèm", () => {
    const result = renameImages("Không ảnh", [{ path: "m/media/image1.png", bytes: bytes("abc") }]);
    expect(result.markdown).toBe("Không ảnh");
    expect(result.images).toHaveLength(1);
  });

  it("tất định: cùng đầu vào ra cùng đầu ra, danh sách ảnh theo thứ tự tên", () => {
    const input = [
      { path: "m/media/image2.png", bytes: bytes("zzz") },
      { path: "m/media/image1.png", bytes: bytes("abc") },
    ];
    const md = "![](m/media/image2.png)![](m/media/image1.png)";
    const first = renameImages(md, input);
    expect(renameImages(md, [...input].reverse())).toEqual(first);
    expect(first.images.map((i) => i.name)).toEqual([...first.images.map((i) => i.name)].sort());
  });
});

describe("relinkImages", () => {
  const link = "![](ba7816bf8f01.png)";

  it("tính đường dẫn tương đối từ tài liệu tới thư mục ảnh", () => {
    expect(relinkImages(link, "docs/srs/OPD/OPD17.md", "docs/assets")).toBe("![](../../assets/ba7816bf8f01.png)");
    expect(relinkImages(link, "docs/huong-dan.md", "docs/assets")).toBe("![](assets/ba7816bf8f01.png)");
    expect(relinkImages(link, "docs/srs/OPD/OPD17.md", "docs/srs/OPD/assets/")).toBe("![](assets/ba7816bf8f01.png)");
  });

  it("đổi được đường dẫn tài liệu rồi tính lại từ Markdown gốc", () => {
    const md = "# A\n\n![hình](ba7816bf8f01.png)\n\n| x |\n| - |\n| ![](ba7816bf8f01.png) |\n";
    expect(relinkImages(md, "docs/a.md", "docs/assets")).toBe(
      "# A\n\n![hình](assets/ba7816bf8f01.png)\n\n| x |\n| - |\n| ![](assets/ba7816bf8f01.png) |\n",
    );
  });

  it("chỉ đổi ảnh trỏ tới tên băm; link thường, link ngoài và ảnh có đường dẫn giữ nguyên", () => {
    const md = "[ảnh](ba7816bf8f01.png) ![](anh.png) ![](https://x.test/ba7816bf8f01.png) ![](a/ba7816bf8f01.png)";
    expect(relinkImages(md, "docs/a.md", "docs/assets")).toBe(md);
  });
});

describe("frontMatter", () => {
  it("ra đúng định dạng FR-012, không có thời điểm nhập", () => {
    expect(
      frontMatter({
        title: "OPD17",
        file: "eHosV2i_SRS_OPD.OPD17_v1.0.docx",
        sha256: "a".repeat(64),
        confidential: false,
      }),
    ).toBe(
      `---\ntitle: "OPD17"\nword:\n  file: "eHosV2i_SRS_OPD.OPD17_v1.0.docx"\n  sha256: "${"a".repeat(64)}"\n---\n\n`,
    );
  });

  it("confidential: true chỉ khi chọn Tài liệu mật, và knowledge nhận ra nhãn", () => {
    const secret = frontMatter({ title: "T", file: "t.docx", sha256: "b".repeat(64), confidential: true });
    expect(secret).toContain("\nconfidential: true\n---\n");
    expect(parseFrontMatter(`${secret}# T`).confidential).toBe(true);
    const open = frontMatter({ title: "T", file: "t.docx", sha256: "b".repeat(64), confidential: false });
    expect(open).not.toContain("confidential");
    expect(parseFrontMatter(`${open}# T`).confidential).toBe(false);
  });

  it("chữ đặc biệt trong tiêu đề và tên file được thoát, đọc lại ra đúng chữ", () => {
    const title = 'Đặc tả "A": 100% # b\\c\nd';
    const file = "báo cáo: 'x' #1.docx";
    const out = frontMatter({ title, file, sha256: "c".repeat(64), confidential: false });
    const parsed = parseFrontMatter(`${out}# Thân`);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.title).toBe(title);
    expect(parsed.body.trim()).toBe("# Thân");
    expect(parsed.raw).toContain(JSON.stringify(file));
  });

  it("tất định: gọi hai lần ra cùng chuỗi", () => {
    const input = { title: "T", file: "t.docx", sha256: "d".repeat(64), confidential: true };
    expect(frontMatter(input)).toBe(frontMatter({ ...input }));
  });
});

describe("countStats", () => {
  it("đếm tiêu đề, bảng và ảnh", () => {
    const md = [
      '---\ntitle: "# không phải tiêu đề"\n---\n',
      "# Một",
      "",
      "Chữ #hashtag và ####### bảy dấu không phải tiêu đề.",
      "",
      "## Hai",
      "",
      "###### Sáu",
      "",
      "| A | B |",
      "| --- | :-: |",
      "| ![](aaaaaaaaaaaa.png) | y |",
      "",
      "Giữa hai bảng.",
      "",
      "A | B",
      "--|--",
      "1 | ![x](bbbbbbbbbbbb.png)",
      "",
      "![](cccccccccccc.png)",
      "",
    ].join("\n");
    expect(countStats(md)).toEqual({ headings: 3, tables: 2, images: 3 });
  });

  it("bỏ qua nội dung trong khối code", () => {
    const md = "# Thật\n\n```md\n# Giả\n| a | b |\n| - | - |\n![](x.png)\n```\n\n~~~\n## Giả\n~~~\n";
    expect(countStats(md)).toEqual({ headings: 1, tables: 0, images: 0 });
  });

  it("dòng gạch ngang đứng một mình không phải bảng", () => {
    expect(countStats("Chữ\n\n---\n\nChữ\n\n- - -\n")).toEqual({ headings: 0, tables: 0, images: 0 });
  });

  it("Markdown rỗng", () => {
    expect(countStats("")).toEqual({ headings: 0, tables: 0, images: 0 });
  });
});

describe("parsePandocLog", () => {
  const entry = (message: string, type = "ScriptingWarning") => ({
    type,
    verbosity: "WARNING",
    message,
    source: "filter.lua",
    line: 1,
  });

  it("lấy cảnh báo ScriptingWarning có mã cố định, tách mã và chi tiết", () => {
    const log = JSON.stringify([entry("nested_table: 2 bảng lồng ở bảng 5"), entry("emf_image"), entry("comments: 3")]);
    expect(parsePandocLog(log)).toEqual([
      { code: "nested_table", detail: "2 bảng lồng ở bảng 5" },
      { code: "emf_image", detail: "" },
      { code: "comments", detail: "3" },
    ]);
  });

  it("bỏ loại khác, bỏ thông điệp không có mã cố định", () => {
    const log = JSON.stringify([
      entry("emf_image", "Scripting"),
      entry("CouldNotFetchResource"),
      entry("nested_table_x: lạ"),
      entry("Dùng bộ lọc cũ"),
      { type: "ScriptingWarning" },
      "chuỗi",
      null,
    ]);
    expect(parsePandocLog(log)).toEqual([]);
  });

  it("thứ tự không đổi theo thứ tự pandoc ghi log (pandoc không ghi theo thứ tự tài liệu)", () => {
    const a = [entry("emf_image"), entry("nested_table: b"), entry("nested_table: a"), entry("no_h1")];
    const expected = parsePandocLog(JSON.stringify(a));
    expect(parsePandocLog(JSON.stringify([...a].reverse()))).toEqual(expected);
    expect(expected.map((w) => [w.code, w.detail])).toEqual([
      ["nested_table", "a"],
      ["nested_table", "b"],
      ["emf_image", ""],
      ["no_h1", ""],
    ]);
  });

  it("log rỗng hoặc hỏng thì không có cảnh báo, không ném lỗi", () => {
    expect(parsePandocLog("")).toEqual([]);
    expect(parsePandocLog("  \n")).toEqual([]);
    expect(parsePandocLog("không phải JSON")).toEqual([]);
    expect(parsePandocLog("{}")).toEqual([]);
    expect(parsePandocLog("[]")).toEqual([]);
  });
});
