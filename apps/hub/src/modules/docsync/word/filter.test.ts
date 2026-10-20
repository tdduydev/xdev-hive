import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPandoc } from "./pandoc.ts";

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

// Chạy đúng `runPandoc` của job (plan.md mục 3 bước 3), trong thư mục tạm riêng như job của hub.
async function convert(input: string, keepFront = false): Promise<Result> {
  const dir = await mkdtemp(join(tmpdir(), "hive-word-filter-"));
  try {
    const from = input.endsWith(".odt") ? "odt" : "docx";
    await copyFile(join(fixtureDir, input), join(dir, `in.${from}`));
    const run = await runPandoc({ path: pandoc, input: `in.${from}`, from, cwd: dir, filter: filterPath, keepFront });
    if (!run.ok) throw new Error(`${run.message}\n${run.stderr}`);
    const media = new Map<string, Buffer>();
    for (const file of await listFiles(run.mediaDir)) media.set(file, await readFile(join(run.mediaDir, file)));
    return {
      markdown: Buffer.from(run.markdown, "utf8"),
      warnings: run.log.filter((entry) => entry.type === "ScriptingWarning").map((entry) => entry.message ?? ""),
      media,
    };
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

// docx đặt ảnh ở m/media, odt ở m/Pictures.
async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
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

// Mỗi mẫu chạy pandoc hai lần; máy dev bận (nhiều agent cùng build) có lúc chậm.
describe.runIf(pandocReady)("filter.lua: mẫu vàng (SC-002, FR-013)", { timeout: 60_000 }, () => {
  for (const sample of cases) {
    it(sample.name, async () => {
      const first = await convert(sample.input, sample.keepFront);
      const goldenPath = join(fixtureDir, sample.golden);
      if (updateGolden) {
        writeFileSync(goldenPath, first.markdown);
      }
      // So chữ trước để thấy diff khi hỏng, rồi so từng byte.
      expect(first.markdown.toString("utf8")).toBe(readFileSync(goldenPath, "utf8"));
      expect(first.markdown.equals(readFileSync(goldenPath))).toBe(true);
      expect(first.warnings).toEqual(sample.warnings);

      const second = await convert(sample.input, sample.keepFront);
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
  // `\<b>` là chữ `<b>` đã thoát trong Markdown, không phải thẻ.
  const htmlTags = (line: string) => line.match(/(?<!\\)<\/?[a-zA-Z][^>]*>/g) ?? [];

  it("chữ <b> đã thoát không bị tính là thẻ", () => {
    expect(htmlTags("Dùng \\<b> để in đậm, còn <i>này</i> là thẻ")).toEqual(["<i>", "</i>"]);
  });

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
        for (const tag of htmlTags(line)) {
          expect({ tag, inTable: line.startsWith("|") }).toEqual({ tag: "<br>", inTable: true });
        }
      }
    });
  }
});
