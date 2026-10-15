import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHUNK_CHARS, chunkMarkdown, embeddingText, snippetOf, splitFrontMatter } from "./doc-search.ts";

describe("splitFrontMatter", () => {
  it("tách front-matter và đọc nhãn confidential", () => {
    expect(splitFrontMatter("---\ntitle: A\nconfidential: true\n---\n# A\n")).toEqual({
      body: "# A\n",
      confidential: true,
    });
    expect(splitFrontMatter("---\r\nconfidential: True # nội bộ\r\n...\r\nThân")).toEqual({
      body: "Thân",
      confidential: true,
    });
  });

  it("chỉ nhận boolean true ở cấp cao nhất", () => {
    for (const fm of ["confidential: false", 'confidential: "true"', "meta:\n  confidential: true", "title: A"])
      expect(splitFrontMatter(`---\n${fm}\n---\nThân`)).toEqual({ body: "Thân", confidential: false });
  });

  it("không có front-matter thì giữ nguyên", () => {
    expect(splitFrontMatter("# A\n---\nconfidential: true\n---\n")).toEqual({
      body: "# A\n---\nconfidential: true\n---\n",
      confidential: false,
    });
  });
});

describe("chunkMarkdown", () => {
  it("chia theo tiêu đề và giữ đường tiêu đề", () => {
    const md = [
      "Mở đầu.",
      "# Hướng dẫn",
      "Giới thiệu.",
      "## Cài đặt",
      "Chạy pnpm install.",
      "### Windows",
      "Dùng WSL.",
      "## Chạy",
      "pnpm dev",
      "# Phụ lục",
      "#### Chi tiết",
      "Không tách ở cấp 4.",
    ].join("\n");
    expect(chunkMarkdown(md, "Tài liệu")).toEqual([
      { headingPath: [], content: "Mở đầu." },
      { headingPath: ["Hướng dẫn"], content: "# Hướng dẫn\n\nGiới thiệu." },
      { headingPath: ["Hướng dẫn", "Cài đặt"], content: "## Cài đặt\n\nChạy pnpm install." },
      { headingPath: ["Hướng dẫn", "Cài đặt", "Windows"], content: "### Windows\n\nDùng WSL." },
      { headingPath: ["Hướng dẫn", "Chạy"], content: "## Chạy\n\npnpm dev" },
      { headingPath: ["Phụ lục"], content: "# Phụ lục\n\n#### Chi tiết\nKhông tách ở cấp 4." },
    ]);
  });

  it("bỏ mục chỉ có tiêu đề, bỏ dấu # đóng", () => {
    expect(chunkMarkdown("# A #\n## B\nNội dung", "T")).toEqual([
      { headingPath: ["A", "B"], content: "## B\n\nNội dung" },
    ]);
  });

  it("không tách tiêu đề trong code fence, giữ fence trọn một khối", () => {
    const md = "# A\n\n```md\n# không phải tiêu đề\n\nvẫn trong fence\n```\nSau fence.";
    expect(chunkMarkdown(md, "T")).toEqual([
      {
        headingPath: ["A"],
        content: "# A\n\n```md\n# không phải tiêu đề\n\nvẫn trong fence\n```\n\nSau fence.",
      },
    ]);
  });

  it("fence đóng phải cùng ký tự và đủ dài", () => {
    const md = "````\n```\n# trong\n````\n# Ngoài\nX";
    expect(chunkMarkdown(md, "T").map((c) => c.headingPath)).toEqual([[], ["Ngoài"]]);
  });

  it("đoạn không vượt giới hạn, khối dài bị cắt theo dòng rồi cắt cứng", () => {
    const para = "câu ".repeat(100).trim();
    const longLine = "x".repeat(CHUNK_CHARS * 2 + 10);
    const md = `# Dài\n\n${Array.from({ length: 10 }, () => para).join("\n\n")}\n\n${longLine}`;
    const chunks = chunkMarkdown(md, "T");
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(CHUNK_CHARS);
      expect(c.headingPath).toEqual(["Dài"]);
    }
    expect(chunks.map((c) => c.content).join("").replaceAll(/\s/g, "")).toContain(longLine);
  });

  it("CRLF như LF", () => {
    expect(chunkMarkdown("# A\r\nB\r\n\r\nC", "T")).toEqual([{ headingPath: ["A"], content: "# A\n\nB\n\nC" }]);
  });

  it("tài liệu rỗng có một đoạn là tiêu đề", () => {
    expect(chunkMarkdown("", "Ghi chú")).toEqual([{ headingPath: [], content: "Ghi chú" }]);
    expect(chunkMarkdown("# Chỉ tiêu đề", "Ghi chú")).toEqual([{ headingPath: [], content: "Ghi chú" }]);
    expect(chunkMarkdown("  ", " ")).toEqual([]);
  });
});

describe("embeddingText", () => {
  it("thêm tiêu đề tài liệu và đường tiêu đề", () => {
    expect(embeddingText("Sổ tay", { headingPath: ["Triển khai", "Máy chủ"], content: "Chạy script." })).toBe(
      "Sổ tay › Triển khai › Máy chủ\n\nChạy script.",
    );
    expect(embeddingText("", { headingPath: [], content: "X" })).toBe("X");
  });
});

describe("snippetOf", () => {
  it("đoạn ngắn trả nguyên, gộp khoảng trắng", () => {
    expect(snippetOf("a\n\n  b", "a")).toBe("a b");
  });

  it("lấy cửa sổ quanh từ khớp đầu tiên", () => {
    const text = `${"đầu ".repeat(100)}máy chủ triển khai ${"cuối ".repeat(100)}`;
    const s = snippetOf(text, "Triển khai", 80);
    expect(s).toContain("triển khai");
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(82);
  });

  it("không khớp từ nào thì lấy phần đầu", () => {
    const s = snippetOf(`mở đầu ${"chữ ".repeat(200)}`, "không có", 50);
    expect(s.startsWith("mở đầu")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("bộ câu hỏi SC-008", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/doc-search-sc008.json", import.meta.url), "utf8")) as {
    docs: Array<{ key: string; title: string; content: string }>;
    questions: Array<{ query: string; expect: string }>;
  };

  it("đủ 50 câu, mỗi câu trỏ tới một tài liệu có trong bộ", () => {
    const keys = new Set(fixture.docs.map((d) => d.key));
    expect(fixture.questions).toHaveLength(50);
    for (const q of fixture.questions) expect(keys).toContain(q.expect);
    for (const d of fixture.docs) expect(chunkMarkdown(d.content, d.title).length).toBeGreaterThan(0);
  });
});
