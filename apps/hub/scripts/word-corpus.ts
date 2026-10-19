// Đo bộ lọc Word của hub trên một thư mục Word thật (SC-001, plan.md mục 14 "Bộ thật", R3, R4). Chạy tại máy có dữ liệu:
//   pnpm --filter @xdev-hive/hub word:corpus <thư mục Word> [--out <thư mục ngoài repo>] [--all] [--jobs 2]
// Dữ liệu thật không được vào repo: Markdown, ảnh và báo cáo chi tiết ghi ra --out, script từ chối --out nằm trong repo.
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pick } from "../src/modules/docsync/word/names.ts";
import { detectPandoc, runPandoc } from "../src/modules/docsync/word/pandoc.ts";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const filterPath = fileURLToPath(new URL("../src/modules/docsync/word/filter.lua", import.meta.url));

// Đọc đúng bản codec và schema của editor như roundtrip.test.ts, không thêm phụ thuộc cho hub.
const editorUrl = new URL("../../../packages/doc-editor/src/markdown.ts", import.meta.url).href;
const coreUrl = new URL("../../../packages/doc-editor/node_modules/@tiptap/core/dist/index.js", import.meta.url).href;

interface Node {
  type: string;
  content?: Node[];
  text?: string;
}
interface Codec {
  parse(markdown: string): { doc: Node };
}
interface EditorModule {
  MarkdownCodec: new () => Codec;
  docExtensions: () => unknown[];
}
interface CoreModule {
  getSchema: (extensions: unknown[]) => { nodeFromJSON: (json: Node) => unknown };
}

const DELIMITER_ROW = /^\|(?:\s*:?-+:?\s*\|)+$/gm;
// `\<` là chữ "<" đã được pandoc thoát (ví dụ `Nullable\<int\>`), không phải thẻ.
const HTML_TAG = /(?<!\\)<\/?[a-zA-Z][^>]*>/g;
const FENCE = /^\s*(?:```|~~~)/;

export interface FileReport {
  /** Đường dẫn tương đối với thư mục gốc. */
  file: string;
  bytes: number;
  ms: number;
  pandoc: { ok: true } | { ok: false; reason: string; message: string; stderr: string };
  warnings: Record<string, number>;
  tables: number;
  /** Số node `table` codec dựng được. */
  tableNodes: number;
  /** Bảng thành khối thô `rawMarkdown` (không sửa trực quan được). */
  rawTables: number;
  rawBlocks: number;
  /** Thẻ HTML còn sót, tính theo tên thẻ; `<br>` trong ô bảng không tính. */
  strayTags: Record<string, number>;
  codecError: string | null;
}

function count(node: Node, type: string): number {
  return (node.type === type ? 1 : 0) + (node.content ?? []).reduce((sum, child) => sum + count(child, type), 0);
}

function rawTables(doc: Node): number {
  const text = (node: Node) => (node.content ?? []).map((child) => child.text ?? "").join("");
  return (doc.content ?? []).filter((node) => node.type === "rawMarkdown" && /^\s*\|/.test(text(node))).length;
}

function strayTags(markdown: string): Record<string, number> {
  const found: Record<string, number> = {};
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const inTable = line.startsWith("|");
    for (const tag of line.match(HTML_TAG) ?? []) {
      if (tag === "<br>" && inTable) continue;
      const name = (/^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)?.[1] ?? tag).toLowerCase();
      found[name] = (found[name] ?? 0) + 1;
    }
  }
  return found;
}

async function listWord(root: string): Promise<{ path: string; rel: string; modified: number }[]> {
  const out: { path: string; rel: string; modified: number }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      // `~$` là file khoá của Word khi đang mở.
      else if (entry.isFile() && /\.(?:docx|odt)$/i.test(entry.name) && !entry.name.startsWith("~$")) {
        out.push({ path, rel: relative(root, path).split(sep).join("/"), modified: (await stat(path)).mtimeMs });
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      all: { type: "boolean", default: false },
      jobs: { type: "string", default: "2" },
      limit: { type: "string" },
    },
  });
  const input = positionals[0];
  if (!input) {
    console.error("Cách dùng: word:corpus <thư mục Word> [--out <thư mục>] [--all] [--jobs 2] [--limit n]");
    process.exit(2);
  }
  const root = resolve(input);
  const outDir = resolve(values.out ?? join(tmpdir(), "hive-word-corpus"));
  if (outDir === repoRoot || outDir.startsWith(repoRoot + sep)) {
    console.error(`--out phải nằm ngoài repo (${repoRoot}): chi tiết bộ thật không được vào Git.`);
    process.exit(2);
  }
  const jobs = Math.max(1, Number(values.jobs) || 2);

  const pandoc = process.env.HIVE_PANDOC_PATH || "pandoc";
  const check = await detectPandoc(pandoc);
  if (!check.ok) {
    console.error(check.reason);
    process.exit(2);
  }

  const [{ MarkdownCodec, docExtensions }, { getSchema }] = (await Promise.all([
    import(editorUrl),
    import(coreUrl),
  ])) as [EditorModule, CoreModule];
  const schema = getSchema(docExtensions());

  const all = await listWord(root);
  // Mặc định chọn một bản cho mỗi tài liệu trong từng thư mục như hub (FR-006); --all chạy hết mọi file.
  let files = all;
  const dropped: string[] = [];
  if (!values.all) {
    const byDir = new Map<string, typeof all>();
    for (const file of all) byDir.set(dirname(file.rel), [...(byDir.get(dirname(file.rel)) ?? []), file]);
    files = [];
    for (const group of byDir.values()) {
      const picked = pick(group.map((file) => ({ ...file, name: basename(file.rel), lastModified: file.modified })));
      files.push(...picked.kept);
      dropped.push(...picked.dropped.map((d) => d.file.rel));
    }
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  }
  if (values.limit) files = files.slice(0, Number(values.limit));
  console.log(`pandoc ${check.version}; ${all.length} file Word, chạy ${files.length}, ${jobs} file cùng lúc`);

  await mkdir(join(outDir, "md"), { recursive: true });
  const reports: FileReport[] = [];
  const started = performance.now();

  const convert = async (file: (typeof files)[number]): Promise<FileReport> => {
    const bytes = (await stat(file.path)).size;
    const from = file.path.toLowerCase().endsWith(".odt") ? "odt" : "docx";
    const cwd = await mkdtemp(join(tmpdir(), "hive-word-corpus-run-"));
    const t0 = performance.now();
    try {
      // Như job của hub: file đầu vào đặt tên cố định trong thư mục tạm riêng, tên gốc không đi vào dòng lệnh.
      await copyFile(file.path, join(cwd, `in.${from}`));
      const run = await runPandoc({
        path: pandoc,
        input: `in.${from}`,
        from,
        cwd,
        filter: filterPath,
        keepFront: false,
      });
      const ms = Math.round(performance.now() - t0);
      const base = { file: file.rel, bytes, ms, warnings: {}, tables: 0, tableNodes: 0, rawTables: 0, rawBlocks: 0 };
      if (!run.ok) {
        return { ...base, pandoc: run, strayTags: {}, codecError: null };
      }
      const warnings: Record<string, number> = {};
      for (const entry of run.log) {
        if (entry.type !== "ScriptingWarning" || !entry.message) continue;
        const code = /^([a-z0-9_]+)(?::(\d+))?/.exec(entry.message);
        if (code?.[1]) warnings[code[1]] = (warnings[code[1]] ?? 0) + (code[2] ? Number(code[2]) : 1);
      }
      // Windows ra CRLF; hub chạy Linux ra LF.
      const markdown = run.markdown.replace(/\r\n/g, "\n");
      await writeFile(join(outDir, "md", `${file.rel.replaceAll("/", "__")}.md`), markdown);
      const report: FileReport = {
        ...base,
        pandoc: { ok: true },
        warnings,
        tables: markdown.match(DELIMITER_ROW)?.length ?? 0,
        strayTags: strayTags(markdown),
        codecError: null,
      };
      try {
        const { doc } = new MarkdownCodec().parse(markdown);
        schema.nodeFromJSON(doc);
        report.tableNodes = count(doc, "table");
        report.rawBlocks = count(doc, "rawMarkdown");
        report.rawTables = rawTables(doc);
      } catch (error) {
        report.codecError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
      return report;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  };

  let next = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      for (;;) {
        const file = files[next++];
        if (!file) return;
        const report = await convert(file);
        reports.push(report);
        const state = !report.pandoc.ok ? "LỖI pandoc" : report.codecError ? "LỖI codec" : "ok";
        console.log(`[${reports.length}/${files.length}] ${state} ${report.ms} ms ${report.file}`);
      }
    }),
  );
  const wallMs = Math.round(performance.now() - started);

  reports.sort((a, b) => (a.file < b.file ? -1 : 1));
  const ok = reports.filter((r) => r.pandoc.ok);
  const codecOk = ok.filter((r) => !r.codecError);
  const sum = (list: FileReport[], f: (r: FileReport) => number) => list.reduce((total, r) => total + f(r), 0);
  const merge = (of: (r: FileReport) => Record<string, number>) => {
    const total: Record<string, number> = {};
    for (const r of reports) for (const [k, v] of Object.entries(of(r))) total[k] = (total[k] ?? 0) + v;
    return Object.fromEntries(Object.entries(total).sort(([a], [b]) => (a < b ? -1 : 1)));
  };
  const times = reports.map((r) => r.ms).sort((a, b) => a - b);
  const tablesLoaded = sum(codecOk, (r) => r.tables);
  const tableNodes = sum(codecOk, (r) => r.tableNodes);
  const summary = {
    pandoc: check.version,
    files: reports.length,
    wordFilesFound: all.length,
    droppedByPick: dropped.length,
    pandocFailed: reports.length - ok.length,
    pandocFailures: reports.filter((r) => !r.pandoc.ok).map((r) => r.file),
    codecFailed: ok.length - codecOk.length,
    codecFailures: ok.filter((r) => r.codecError).map((r) => ({ file: r.file, error: r.codecError })),
    tablesTotal: sum(ok, (r) => r.tables),
    tablesInCodecFiles: tablesLoaded,
    tableNodes,
    tableRatio: tablesLoaded ? tableNodes / tablesLoaded : null,
    rawTables: sum(codecOk, (r) => r.rawTables),
    rawBlocks: sum(codecOk, (r) => r.rawBlocks),
    filesWithStrayTags: ok.filter((r) => Object.keys(r.strayTags).length).length,
    strayTags: merge((r) => r.strayTags),
    warnings: merge((r) => r.warnings),
    ms: {
      wall: wallMs,
      perFileP50: percentile(times, 50),
      perFileP95: percentile(times, 95),
      perFileMax: times.at(-1) ?? 0,
      perFileTotal: sum(reports, (r) => r.ms),
    },
  };
  await writeFile(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(outDir, "report.json"), `${JSON.stringify(reports, null, 2)}\n`);

  const percent = summary.tableRatio === null ? "—" : `${(summary.tableRatio * 100).toFixed(1)}%`;
  console.log(`
File Word: ${summary.wordFilesFound}; chạy ${summary.files}${values.all ? " (--all)" : `, bỏ ${summary.droppedByPick} bản cũ`}
pandoc lỗi: ${summary.pandocFailed}
codec ném lỗi: ${summary.codecFailed}
bảng: ${summary.tablesInCodecFiles}, thành table: ${summary.tableNodes} (${percent}), thành khối thô: ${summary.rawTables}
file còn thẻ HTML ngoài <br> trong ô: ${summary.filesWithStrayTags}; thẻ: ${JSON.stringify(summary.strayTags)}
cảnh báo của bộ lọc: ${JSON.stringify(summary.warnings)}
thời gian: cả bộ ${wallMs} ms; mỗi file p50 ${summary.ms.perFileP50} ms, p95 ${summary.ms.perFileP95} ms, lớn nhất ${summary.ms.perFileMax} ms
chi tiết: ${outDir}`);
}

await main();
