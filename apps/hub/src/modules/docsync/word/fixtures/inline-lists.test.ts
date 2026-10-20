import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPandoc } from "../pandoc.ts";

// Mẫu của T026 nằm riêng một file test trong thư mục mẫu (PHẠM VI của task); hợp vào filter.test.ts khi có dịp.
const PANDOC_VERSION = "3.12";
const pandoc = process.env.HIVE_PANDOC_PATH || "pandoc";
const filterPath = fileURLToPath(new URL("../filter.lua", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./", import.meta.url));
const updateGolden = process.env.HIVE_UPDATE_GOLDEN === "1";

const versionLine = spawnSync(pandoc, ["--version"], { encoding: "utf8" }).stdout?.split("\n")[0] ?? "";
const pandocReady = versionLine.trim() === `pandoc ${PANDOC_VERSION}`;
const inCi = process.env.CI === "true";
if (!pandocReady && !inCi) {
  console.warn(
    `Bỏ qua test mẫu chỉ số và danh sách: cần pandoc ${PANDOC_VERSION}, có "${versionLine || "không tìm thấy"}"`,
  );
}

const editorUrl = new URL("../../../../../../../packages/doc-editor/src/markdown.ts", import.meta.url).href;
const { MarkdownCodec } = await import(editorUrl);

type Node = { type: string; attrs?: { start?: number }; content?: Node[]; text?: string };
const count = (node: Node, type: string): number =>
  (node.type === type ? 1 : 0) + (node.content ?? []).reduce((sum, child) => sum + count(child, type), 0);
const textOf = (node: Node): string => node.text ?? (node.content ?? []).map(textOf).join("");
const goldenPath = join(fixtureDir, "inline-lists.md");

describe.runIf(pandocReady)("filter.lua: chỉ số dưới/trên và danh sách liền nhau (T026)", { timeout: 60_000 }, () => {
  it("mẫu vàng", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hive-word-inline-"));
    try {
      await copyFile(join(fixtureDir, "inline-lists.docx"), join(dir, "in.docx"));
      const run = await runPandoc({
        path: pandoc,
        input: "in.docx",
        from: "docx",
        cwd: dir,
        filter: filterPath,
        keepFront: false,
      });
      if (!run.ok) throw new Error(`${run.message}\n${run.stderr}`);
      if (updateGolden) writeFileSync(goldenPath, run.markdown);
      expect(run.markdown).toBe(readFileSync(goldenPath, "utf8"));
      expect(run.log.filter((entry) => entry.type === "ScriptingWarning")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("filter.lua: inline-lists.md vàng", () => {
  const markdown = readFileSync(goldenPath, "utf8");

  it("không còn thẻ HTML hay <!-- -->", () => {
    expect(markdown).not.toMatch(/<!--/);
    expect(markdown).not.toMatch(/(?<!\\)<\/?(?:sub|sup)>/);
  });

  it("bảng có chỉ số mở được thành bảng sửa được", () => {
    const { doc } = new MarkdownCodec().parse(markdown);
    expect(count(doc as Node, "table")).toBe(1);
    expect(count(doc as Node, "rawMarkdown")).toBe(0);
  });

  it("hai danh sách liền nhau vẫn là hai danh sách khi nạp lại", () => {
    const { doc } = new MarkdownCodec().parse(markdown);
    const lists = ((doc as Node).content ?? []).filter((node) => node.type === "orderedList");
    const starts = lists.map((list) => `${list.attrs?.start ?? 1}:${textOf(list)}`);
    expect(starts).toEqual(["1:Bước một", "2:Bước hai", "1:Bước ba", "2:Bước bốn"]);
  });
});
