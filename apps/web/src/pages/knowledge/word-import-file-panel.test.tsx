// @vitest-environment jsdom
import { ORPCError } from "@orpc/client";
import { cleanup, render, screen } from "@testing-library/react";
import type { WordImportFile, WordImportGetOutput } from "@xdev-hive/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  findingLine,
  importErrorMessage,
  linkDiffRows,
  previewMarkdown,
  updateOutcome,
  warningText,
} from "@/pages/knowledge/word-import-file-panel.tsx";
import { filterFiles, pathProblem, stillWorking } from "@/pages/knowledge/word-import-page.tsx";

afterEach(cleanup);

const image = {
  name: "9f2c4b7a1d3e.png",
  mediaType: "image/png",
  bytes: 67,
  url: "/api/v1/docs/word-imports/i/files/f/media/9f2c4b7a1d3e.png",
};

describe("updateOutcome", () => {
  const of = (state: WordImportFile["state"], linkMatches: boolean | null, docVersion: number | null = null) =>
    updateOutcome({ state, linkMatches, docVersion } as WordImportFile);
  it("phân loại lượt cập nhật trước và sau khi áp dụng", () => {
    expect(of("skipped", null)).toBe("unchanged");
    expect(of("ready", null)).toBe("pending");
    expect(of("ready", true)).toBe("clean");
    expect(of("ready", false)).toBe("overlap");
    expect(of("done", true, 3)).toBe("updated");
    expect(of("done", false)).toBe("conflict");
  });
});

describe("previewMarkdown", () => {
  it("viết lại link ảnh theo tên đã băm thành URL tuyệt đối kèm org", () => {
    const out = previewMarkdown("![Sơ đồ](media/9f2c4b7a1d3e.png)", [image], "https://hive.test", "org 1");
    expect(out).toBe(`![Sơ đồ](https://hive.test${image.url}?org=org%201)`);
  });

  it("giữ nguyên link không có trong danh sách ảnh và link ngoài", () => {
    const md = "![x](media/other.png) và [web](https://example.com/a.png)";
    expect(previewMarkdown(md, [image], "https://hive.test", "o")).toBe(md);
  });

  it("giữ title của link", () => {
    const out = previewMarkdown('![a](9f2c4b7a1d3e.png "chú thích")', [image], "https://h", "o");
    expect(out).toBe(`![a](https://h${image.url}?org=o "chú thích")`);
  });

  it("đổi <br> trong ô bảng thành ký hiệu xuống dòng", () => {
    expect(previewMarkdown("| a<br>b | c<br/>d |", [], "https://h", "o")).toBe("| a ⏎ b | c ⏎ d |");
  });
});

describe("chữ của cảnh báo và bí mật", () => {
  it("dịch cảnh báo theo mã, thêm số chỗ và chi tiết", () => {
    expect(warningText({ code: "nested_table", count: 1, detail: null })).toContain("bảng lồng");
    expect(warningText({ code: "equation", count: 3, detail: null })).toContain("(3 chỗ)");
    expect(warningText({ code: "skipped_older", count: 1, detail: "srs-v2.docx" })).toMatch(/srs-v2\.docx$/);
  });

  it("chỉ nói loại và dòng của bí mật", () => {
    expect(findingLine({ line: 12, kind: "credential_assignment" })).toBe("dòng 12 (mật khẩu hoặc token)");
  });
});

describe("importErrorMessage", () => {
  it("lấy câu của hợp đồng theo data.code", () => {
    const error = new ORPCError("CONFLICT", { defined: true, message: "x", data: { code: "WORD_IMPORT_EXISTS" } });
    expect(importErrorMessage(error)).toBe("Đường dẫn này đã có tài liệu. Đổi tên, hoặc cập nhật tài liệu đó từ Word.");
  });

  it("lỗi khác thì dùng câu chung", () => {
    expect(importErrorMessage(new Error("boom"))).not.toBe("");
  });
});

describe("linkDiffRows", () => {
  it("chỉ giữ các khối khác nhau và đếm khối giống", () => {
    const { changed, same } = linkDiffRows("# A\n\nmột\n\nhai\n", "# A\n\nmột\n\nba\n");
    expect(same).toBe(2);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.base).toEqual(["hai"]);
    expect(changed[0]?.repo).toEqual(["ba"]);
  });

  it("hai bản giống nhau thì không có khác biệt", () => {
    expect(linkDiffRows("# A\n\nx\n", "# A\n\nx\n").changed).toEqual([]);
  });
});

const file = (state: WordImportFile["state"]) => ({ state }) as WordImportFile;

describe("trang lượt nhập", () => {
  it("lọc file theo nhóm trạng thái", () => {
    const files = [file("ready"), file("queued"), file("converting"), file("done"), file("proposed")];
    expect(filterFiles(files, "all")).toHaveLength(5);
    expect(filterFiles(files, "working")).toHaveLength(2);
    expect(filterFiles(files, "finished")).toHaveLength(2);
    expect(filterFiles(files, "failed")).toHaveLength(0);
  });

  it("đường dẫn phải có và kết thúc bằng .md", () => {
    expect(pathProblem("  ")).toMatch(/Nhập/);
    expect(pathProblem("docs/a.docx")).toMatch(/\.md/);
    expect(pathProblem("docs/a.MD")).toBeNull();
  });

  it("chỉ hỏi lại khi hub còn làm việc", () => {
    const output = (importState: string, ...states: WordImportFile["state"][]) =>
      ({ import: { state: importState }, files: states.map(file) }) as unknown as WordImportGetOutput;
    expect(stillWorking(undefined)).toBe(false);
    expect(stillWorking(output("converting", "ready"))).toBe(true);
    expect(stillWorking(output("ready", "ready", "converting"))).toBe(true);
    expect(stillWorking(output("ready", "ready", "blocked_secret"))).toBe(false);
    expect(stillWorking(output("done", "done"))).toBe(false);
  });
});

describe("kiểm thử môi trường", () => {
  it("jsdom dựng được", () => {
    render(<p>ok</p>);
    expect(screen.getByText("ok")).toBeTruthy();
  });
});
