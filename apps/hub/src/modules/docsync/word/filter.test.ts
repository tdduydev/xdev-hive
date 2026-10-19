import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PANDOC_VERSION = "3.12";
const pandoc = process.env.HIVE_PANDOC_PATH || "pandoc";
const filterPath = fileURLToPath(new URL("./filter.lua", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
// Duyệt bằng mắt rồi mới ghi đè: HIVE_UPDATE_GOLDEN=1 pnpm --filter @xdev-hive/hub test -- word/filter
const updateGolden = process.env.HIVE_UPDATE_GOLDEN === "1";

const versionLine = spawnSync(pandoc, ["--version"], { encoding: "utf8" }).stdout?.split("\n")[0] ?? "";
const pandocReady = versionLine.trim() === `pandoc ${PANDOC_VERSION}`;
// Trong CI thiếu pandoc là lỗi; tại máy thì bỏ qua kèm thông báo (plan.md mục 12).
const inCi = process.env.CI === "true";
if (!pandocReady && !inCi) {
  console.warn(`Bỏ qua test bộ lọc Word: cần pandoc ${PANDOC_VERSION}, có "${versionLine || "không tìm thấy"}"`);
}

// Đọc đúng bản codec của editor như roundtrip.test.ts, không thêm phụ thuộc cho hub.
const editorUrl = new URL("../../../../../../packages/doc-editor/src/markdown.ts", import.meta.url).href;
const coreUrl = new URL(
  "../../../../../../packages/doc-editor/node_modules/@tiptap/core/dist/index.js",
  import.meta.url,
).href;
const [{ MarkdownCodec, docExtensions }, { getSchema }] = await Promise.all([import(editorUrl), import(coreUrl)]);
const schema = getSchema(docExtensions());

type Case = {
  name: string;
  input: string;
  golden: string;
  keepFront?: boolean;
  warnings: string[];
};

const cases: Case[] = [
  {
    name: "docx: mẫu SRS đủ các trường hợp",
    input: "srs.docx",
    golden: "srs.md",
    warnings: ["nested_table:1", "emf_image:1", "tracked_changes:2", "comments:1"],
  },
  {
    name: "docx: giữ phần trước tiêu đề cấp 1 (Q5)",
    input: "srs.docx",
    golden: "srs.keep-front.md",
    keepFront: true,
    warnings: ["nested_table:1", "emf_image:1", "tracked_changes:2", "comments:1"],
  },
  {
    name: "odt: cùng nội dung với srs.docx",
    input: "srs.odt",
    golden: "srs.odt.md",
    warnings: ["nested_table:1", "emf_image:1", "tracked_changes:2", "comments:1"],
  },
  {
    name: "docx: không có tiêu đề cấp 1, chú thích cuối trang, công thức, hộp chữ",
    input: "no-h1.docx",
    golden: "no-h1.md",
    warnings: ["equation:1", "footnote:1", "no_h1:1", "textbox:1"],
  },
];

type Result = { markdown: Buffer; warnings: string[]; media: Map<string, Buffer> };

// Đúng tham số ở plan.md mục 3 bước 3, chạy trong thư mục tạm riêng như job của hub. Thêm --eol=lf vì pandoc mặc định
// xuống dòng theo hệ điều hành: trên Windows ra CRLF, khác byte với hub chạy Linux.
function convert(input: string, keepFront = false): Result {
  const dir = mkdtempSync(join(tmpdir(), "hive-word-filter-"));
  try {
    const ext = input.endsWith(".odt") ? "odt" : "docx";
    copyFileSync(join(fixtureDir, input), join(dir, `in.${ext}`));
    const args = [
      `in.${ext}`,
      "-f",
      ext,
      "-t",
      "gfm",
      "--wrap=none",
      "--eol=lf",
      "--track-changes=accept",
      "--sandbox",
      "--extract-media=m",
      `--lua-filter=${filterPath}`,
      "--log=log.json",
      ...(keepFront ? ["--metadata", "keep-front=true"] : []),
      "-o",
      "out.md",
      "+RTS",
      "-M512m",
      "-RTS",
    ];
    const run = spawnSync(pandoc, args, { cwd: dir, encoding: "utf8", shell: false, timeout: 60_000 });
    expect(run.status, run.stderr).toBe(0);
    const log = JSON.parse(readFileSync(join(dir, "log.json"), "utf8")) as { type: string; message: string }[];
    const media = new Map<string, Buffer>();
    const mediaDir = join(dir, "m", "media");
    if (existsSync(mediaDir)) {
      for (const file of readdirSync(mediaDir).sort()) {
        media.set(file, readFileSync(join(mediaDir, file)));
      }
    }
    return {
      markdown: readFileSync(join(dir, "out.md")),
      warnings: log.filter((entry) => entry.type === "ScriptingWarning").map((entry) => entry.message),
      media,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("filter.lua: đầu file", () => {
  it("ghi FILTER_VERSION và commit gốc của srs.lua đã chép (FR-014)", () => {
    const head = readFileSync(filterPath, "utf8").split("\n").slice(0, 15).join("\n");
    expect(head).toMatch(/^local FILTER_VERSION = "\d+\.\d+\.\d+"$/m);
    expect(head).toContain("440f2f5b50287009788f4cf944840c023bff41e7");
    expect(head).toContain("tools/srs2md/srs.lua");
  });
});

describe.runIf(inCi && !pandocReady)("pandoc trong CI", () => {
  it(`có pandoc ${PANDOC_VERSION}`, () => {
    expect.fail(`CI cần pandoc ${PANDOC_VERSION}, có "${versionLine || "không tìm thấy"}"`);
  });
});

describe.runIf(pandocReady)("filter.lua: mẫu vàng (SC-002, FR-013)", () => {
  for (const sample of cases) {
    it(sample.name, () => {
      const first = convert(sample.input, sample.keepFront);
      const goldenPath = join(fixtureDir, sample.golden);
      if (updateGolden) {
        writeFileSync(goldenPath, first.markdown);
      }
      // So chữ trước để thấy diff khi hỏng, rồi so từng byte.
      expect(first.markdown.toString("utf8")).toBe(readFileSync(goldenPath, "utf8"));
      expect(first.markdown.equals(readFileSync(goldenPath))).toBe(true);
      expect(first.warnings).toEqual(sample.warnings);

      const second = convert(sample.input, sample.keepFront);
      expect(second.markdown.equals(first.markdown)).toBe(true);
      expect(second.warnings).toEqual(first.warnings);
      expect([...second.media.keys()]).toEqual([...first.media.keys()]);
      for (const [file, bytes] of first.media) {
        expect(second.media.get(file)?.equals(bytes)).toBe(true);
      }
    });
  }
});

describe("filter.lua: Markdown vàng mở được trong editor", () => {
  type Node = { type: string; content?: Node[]; text?: string };
  const count = (node: Node, type: string): number =>
    (node.type === type ? 1 : 0) + (node.content ?? []).reduce((sum, child) => sum + count(child, type), 0);
  const delimiterRow = /^\|(?:\s*:?-+:?\s*\|)+$/gm;

  for (const golden of [...new Set(cases.map((sample) => sample.golden))]) {
    it(golden, () => {
      const markdown = readFileSync(join(fixtureDir, golden), "utf8");
      const codec = new MarkdownCodec();
      const { doc } = codec.parse(markdown);
      schema.nodeFromJSON(doc);
      const tables = markdown.match(delimiterRow)?.length ?? 0;
      expect(count(doc, "table")).toBe(tables);
      // Không còn thẻ HTML nào ngoài <br> trong ô bảng (SC-001).
      for (const line of markdown.split("\n")) {
        for (const tag of line.match(/<\/?[a-zA-Z][^>]*>/g) ?? []) {
          expect({ tag, inTable: line.startsWith("|") }).toEqual({ tag: "<br>", inTable: true });
        }
      }
    });
  }
});
