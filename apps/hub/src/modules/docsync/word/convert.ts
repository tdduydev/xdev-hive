import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_MAX_CHARS, scanSecrets, WORD_IMPORT_ERRORS, type WordImportErrorCode } from "@xdev-hive/contracts";
import { and, count, eq, inArray, lt, sql } from "drizzle-orm";
import {
  BadRequestError,
  createPostgresBlobStore,
  detectMediaType,
  type Jobs,
  type Tx,
  withTenant,
} from "../../platform/index.ts";
import { EXTRACT_LIMITS, ExtractError } from "../extract/types.ts";
import { readZip } from "../extract/zip.ts";
import { DOCSYNC_WORD_IMPORT_QUEUE, type WordImportFileJob } from "../queues.ts";
import type { DocSyncDeps } from "../routes/deps.ts";
import { docWordImportFiles, docWordImports, type WordImportCountsRow } from "../schema.ts";
import { prepareLink } from "./link.ts";
import { type PandocCommand, runPandoc } from "./pandoc.ts";
import { countStats, frontMatter, type MediaFile, parsePandocLog, renameImages } from "./postprocess.ts";
import { type WordImportFileRow, type WordTools, wordTools } from "./tools.ts";
import { prepareUpdate } from "./update.ts";

type FileError = NonNullable<WordImportFileRow["error"]>;
type Warning = WordImportFileRow["warnings"][number];
type ConvertDeps = { pool: NonNullable<DocSyncDeps["pool"]>; tools: WordTools };

export type WordImportJob = WordImportFileJob | { scan: true };

export const DOCSYNC_WORD_IMPORT_CRON = "*/10 * * * *";
/** File `queued`/`converting` không job nào nhận (hub tắt giữa chừng, job hết hạn) thì xếp lại sau khoảng này. */
const STALE_MS = 15 * 60_000;
const SWEEP_BATCH = 200;
const FILTER = fileURLToPath(new URL("./filter.lua", import.meta.url));
// File OOXML có mật khẩu là container OLE, không phải zip.
const OLE_MAGIC = Buffer.from("d0cf11e0a1b11ae1", "hex");
const VECTOR_IMAGE = /\.(?:emf|wmf|emz|wmz)$/i;
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const fileError = (code: WordImportErrorCode, detail?: string, message?: string): FileError => ({
  code,
  message: message ?? WORD_IMPORT_ERRORS[code].message,
  ...(detail ? { detail: detail.slice(0, 2000) } : {}),
});

const titleOf = (file: WordImportFileRow): string =>
  file.titleOverride ?? file.proposedTitle ?? file.fileName.replace(/\.[^.]+$/, "");

const COUNT_KEYS: Record<string, keyof WordImportCountsRow> = {
  queued: "queued",
  converting: "converting",
  ready: "ready",
  skipped: "skipped",
  blocked_secret: "blockedSecret",
  failed: "failed",
  proposed: "proposed",
  cancelled: "cancelled",
  done: "done",
};

/**
 * Đếm lại file theo trạng thái và chuyển trạng thái lượt khi đang chuyển: còn file chờ chuyển thì `converting`, còn file
 * chờ tạo thì `ready`, chuyển xong mà không còn gì để tạo thì `done`. Lượt đã sang bước tạo, huỷ hay hỏng thì chỉ đổi
 * `counts`.
 */
export async function refreshWordImportCounts(tx: Tx, importId: string): Promise<void> {
  const rows = await tx
    .select({ state: docWordImportFiles.state, excluded: docWordImportFiles.excluded, n: count() })
    .from(docWordImportFiles)
    .where(eq(docWordImportFiles.importId, importId))
    .groupBy(docWordImportFiles.state, docWordImportFiles.excluded);
  const counts: WordImportCountsRow = {
    queued: 0,
    converting: 0,
    ready: 0,
    skipped: 0,
    blockedSecret: 0,
    failed: 0,
    proposed: 0,
    cancelled: 0,
    done: 0,
  };
  let converting = 0;
  let waiting = 0;
  for (const r of rows) {
    const key = COUNT_KEYS[r.state];
    if (key) counts[key] += r.n;
    if (r.state === "queued" || r.state === "converting") converting += r.n;
    if (!r.excluded && ["queued", "converting", "ready", "blocked_secret"].includes(r.state)) waiting += r.n;
  }
  const [imp] = await tx
    .select({ state: docWordImports.state })
    .from(docWordImports)
    .where(eq(docWordImports.id, importId));
  if (!imp) return;
  // Từ `ready` chỉ bước tạo mới đóng lượt: người nhập bỏ hết file rồi vẫn phải bỏ chọn lại được.
  const next = converting > 0 ? "converting" : waiting > 0 ? "ready" : imp.state === "converting" ? "done" : imp.state;
  const moves = imp.state === "converting" || imp.state === "ready";
  await tx
    .update(docWordImports)
    .set({ counts, ...(moves ? { state: next } : {}), updatedAt: new Date() })
    .where(eq(docWordImports.id, importId));
}

async function readBlob(tx: Tx, orgId: string, blobId: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of await createPostgresBlobStore().get(tx, orgId, blobId)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

interface Prepared {
  file: WordImportFileRow;
  confidential: boolean;
  bytes: Uint8Array;
}

async function failFile(tx: Tx, file: WordImportFileRow, error: FileError): Promise<void> {
  await tx
    .update(docWordImportFiles)
    .set({ state: "failed", error, updatedAt: new Date() })
    .where(eq(docWordImportFiles.id, file.id));
  await refreshWordImportCounts(tx, file.importId);
}

async function prepare(tx: Tx, job: WordImportFileJob): Promise<Prepared | null> {
  const [file] = await tx.select().from(docWordImportFiles).where(eq(docWordImportFiles.id, job.fileId)).for("update");
  // File đã `ready` (job chạy lại sau khi hub khởi động lại) hay đã huỷ thì không chuyển lần nữa.
  if (!file || (file.state !== "queued" && file.state !== "converting") || file.format === "doc") return null;
  const [imp] = await tx.select().from(docWordImports).where(eq(docWordImports.id, file.importId));
  if (!imp || imp.state === "cancelled" || imp.state === "failed") return null;
  if (!file.blobId) {
    await failFile(
      tx,
      file,
      fileError("WORD_IMPORT_CONVERT_FAILED", undefined, "File Word gốc không còn trong kho file. Tải lên lại."),
    );
    return null;
  }
  const bytes = await readBlob(tx, job.orgId, file.blobId);
  if (file.state === "queued") {
    await tx
      .update(docWordImportFiles)
      .set({ state: "converting", updatedAt: new Date() })
      .where(eq(docWordImportFiles.id, file.id));
    await refreshWordImportCounts(tx, file.importId);
  }
  return { file, confidential: imp.confidential, bytes };
}

interface Converted {
  markdown: string;
  images: Array<{ name: string; bytes: Uint8Array; mediaType: string }>;
  warnings: Warning[];
}

type Outcome = { ok: true; result: Converted } | { ok: false; error: FileError };

async function listMedia(root: string): Promise<MediaFile[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  const media: MediaFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const bytes = await readFile(path);
    const type = detectMediaType(bytes);
    // Link trong Markdown của pandoc là `m/<đường dẫn trong thư mục ảnh>`.
    const link = `m/${relative(root, path).replaceAll("\\", "/")}`;
    media.push({ path: link, bytes, ...(type && EXTENSIONS[type] ? { ext: EXTENSIONS[type] } : {}) });
  }
  return media.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Gộp cảnh báo của bộ lọc theo mã; bộ lọc ghi `<mã>:<số lần>`. */
function warningsOf(log: unknown[], hasVector: boolean): Warning[] {
  const counts = new Map<string, number>();
  for (const { code, detail } of parsePandocLog(JSON.stringify(log))) {
    const n = /^\d+$/.test(detail) ? Math.max(1, Number(detail)) : 1;
    counts.set(code, (counts.get(code) ?? 0) + n);
  }
  if (hasVector && !counts.has("emf_image")) counts.set("emf_image", 1);
  return [...counts].map(([code, n]) => ({ code, count: n, detail: null }) as Warning);
}

/** Chuyển một file ngoài transaction: pandoc chạy tới vài phút, không giữ kết nối database trong lúc đó. */
async function convert(tools: WordTools, prepared: Prepared): Promise<Outcome> {
  const { file, bytes } = prepared;
  if (Buffer.from(bytes.subarray(0, 8)).equals(OLE_MAGIC))
    return { ok: false, error: fileError("WORD_IMPORT_PASSWORD") };
  const from = file.format === "odt" ? "odt" : "docx";
  let entries: Map<string, Uint8Array>;
  try {
    entries = await readZip(bytes, EXTRACT_LIMITS);
  } catch (error) {
    if (!(error instanceof ExtractError)) throw error;
    const code = /zip bomb/.test(error.message) ? "WORD_IMPORT_FILE_TOO_LARGE" : "WORD_IMPORT_NOT_WORD";
    return { ok: false, error: fileError(code, error.message) };
  }
  if (!entries.has(from === "odt" ? "content.xml" : "word/document.xml"))
    return { ok: false, error: fileError("WORD_IMPORT_NOT_WORD") };
  entries.clear();

  const dir = await mkdtemp(join(tmpdir(), "hive-word-"));
  try {
    await writeFile(join(dir, `in.${from}`), bytes);
    const run = await runPandoc({
      path: tools.config.pandocPath as PandocCommand,
      input: `in.${from}`,
      from,
      cwd: dir,
      filter: FILTER,
      keepFront: file.keepFront,
      timeoutMs: tools.config.timeoutMs,
    });
    if (!run.ok) {
      const code = run.reason === "timeout" ? "WORD_IMPORT_TIMEOUT" : "WORD_IMPORT_CONVERT_FAILED";
      return { ok: false, error: fileError(code, [run.message, run.stderr].filter(Boolean).join("\n")) };
    }
    const renamed = renameImages(run.markdown, await listMedia(run.mediaDir));
    const hasVector = renamed.images.some((image) => VECTOR_IMAGE.test(image.name));
    // Trình duyệt không vẽ được EMF/WMF: giữ file làm đính kèm, trong bài là link tải (Q10).
    const body = renamed.markdown.replace(
      /!\[([^\]]*)\]\(([0-9a-f]{12}\.(?:emf|wmf|emz|wmz))\)/g,
      (_all, alt: string, name: string) => `[${alt || name}](${name})`,
    );
    const markdown =
      frontMatter({
        title: titleOf(file),
        file: file.fileName,
        sha256: file.sha256,
        confidential: prepared.confidential,
      }) + body;
    return {
      ok: true,
      result: {
        markdown,
        images: renamed.images.map((image) => ({
          name: image.name,
          bytes: image.bytes,
          mediaType: detectMediaType(image.bytes) ?? "application/octet-stream",
        })),
        warnings: warningsOf(run.log, hasVector),
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

/** Ghi kết quả nếu file vẫn đang chờ đúng lần chuyển này; người nhập đổi `keepFront` giữa chừng thì để job mới ghi. */
async function save(tx: Tx, orgId: string, prepared: Prepared, outcome: Outcome): Promise<string> {
  const [file] = await tx
    .select()
    .from(docWordImportFiles)
    .where(eq(docWordImportFiles.id, prepared.file.id))
    .for("update");
  const before = prepared.file;
  if (
    !file ||
    (file.state !== "queued" && file.state !== "converting") ||
    file.keepFront !== before.keepFront ||
    file.blobId !== before.blobId ||
    file.sha256 !== before.sha256
  )
    return "skipped";
  if (!outcome.ok) {
    await failFile(tx, file, outcome.error);
    return "failed";
  }
  const { markdown } = outcome.result;
  if (markdown.length > DOC_MAX_CHARS) {
    await failFile(tx, file, fileError("WORD_IMPORT_TOO_LONG", `${markdown.length} ký tự.`));
    return "failed";
  }
  const store = createPostgresBlobStore();
  const images: WordImportFileRow["images"] = [];
  // withTenant đã mở transaction: ảnh vượt giới hạn kho làm hỏng file này, không làm hỏng việc ghi trạng thái lỗi.
  await tx.execute(sql`savepoint word_convert_images`);
  try {
    for (const image of outcome.result.images) {
      const blob = await store.put(tx, orgId, once(image.bytes), image.mediaType);
      images.push({ name: image.name, blobId: blob.id, mediaType: blob.mediaType, bytes: blob.size });
    }
    await tx.execute(sql`release savepoint word_convert_images`);
  } catch (error) {
    await tx.execute(sql`rollback to savepoint word_convert_images`);
    if (!(error instanceof BadRequestError)) throw error;
    await failFile(tx, file, fileError("WORD_IMPORT_CONVERT_FAILED", error.message));
    return "failed";
  }
  // Chỉ lưu loại và số dòng, không lưu giá trị bí mật (FR-018).
  const findings = scanSecrets(markdown).map((f) => ({ kind: f.kind, line: f.line }));
  const state = findings.length ? "blocked_secret" : "ready";
  const [saved] = await tx
    .update(docWordImportFiles)
    .set({
      state,
      markdown,
      images,
      stats: countStats(markdown),
      warnings: outcome.result.warnings,
      findings,
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(docWordImportFiles.id, file.id))
    .returning();
  if (saved && state === "ready") {
    const [imp] = await tx
      .select({ mode: docWordImports.mode })
      .from(docWordImports)
      .where(eq(docWordImports.id, file.importId));
    if (imp?.mode === "link") await prepareLink(tx, saved);
    else if (imp?.mode === "update") await prepareUpdate(tx, saved);
  }
  await refreshWordImportCounts(tx, file.importId);
  return state;
}

/** Job `docsync-word-import` cho một file `.docx`/`.odt`: đọc blob trong tenant, chuyển ngoài transaction, ghi kết quả. */
export async function runWordImportJob(deps: ConvertDeps, job: WordImportFileJob): Promise<string> {
  const ctx = { orgId: job.orgId };
  const prepared = await withTenant(deps.pool, ctx, (tx) => prepare(tx, job));
  if (!prepared) return "skipped";
  let outcome: Outcome;
  try {
    outcome = await convert(deps.tools, prepared);
  } catch (error) {
    // Lỗi lạ (hết đĩa tạm, ảnh hỏng…) vẫn ghi vào file để người nhập thấy, không để file kẹt ở `converting`.
    outcome = { ok: false, error: fileError("WORD_IMPORT_CONVERT_FAILED", (error as Error).message) };
  }
  return withTenant(deps.pool, ctx, (tx) => save(tx, job.orgId, prepared, outcome));
}

/** Cron: file chờ chuyển mà không job nào nhận (hub tắt giữa chừng) thì xếp lại; khoá theo file nên không trùng. */
export async function sweepWordImports(deps: ConvertDeps & { jobs: Jobs }): Promise<number> {
  const orgs = await withTenant(deps.pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ org_id: string }>(sql`select org_id from hive.docsync_active_orgs()`);
    return rows.map((r) => r.org_id);
  });
  let queued = 0;
  for (const orgId of orgs)
    queued += await withTenant(deps.pool, { orgId }, async (tx) => {
      const stale = await tx
        .select({ id: docWordImportFiles.id })
        .from(docWordImportFiles)
        .where(
          and(
            inArray(docWordImportFiles.state, ["queued", "converting"]),
            inArray(docWordImportFiles.format, ["docx", "odt"]),
            lt(docWordImportFiles.updatedAt, new Date(Date.now() - STALE_MS)),
          ),
        )
        .limit(SWEEP_BATCH);
      for (const file of stale)
        await deps.jobs.enqueue(DOCSYNC_WORD_IMPORT_QUEUE, { orgId, fileId: file.id } satisfies WordImportJob, {
          tx,
          singletonKey: file.id,
        });
      return stale.length;
    });
  return queued;
}

export async function registerWordImport(jobs: Jobs, deps: DocSyncDeps): Promise<void> {
  const { pool } = deps;
  const tools = wordTools();
  // Tiến trình chỉ gửi job, hoặc hub chưa có pandoc dùng được (upload cũng từ chối), thì không nhận việc.
  if (!pool || !tools?.pandoc.ok) return;
  const full = { pool, tools, jobs };
  const handle = async ({ data }: { data: WordImportJob }) => {
    if ("scan" in data) await sweepWordImports(full);
    else await runWordImportJob(full, data);
  };
  // Hai luồng mỗi tiến trình như `docsync-extract` (plan.md mục 3): mỗi pandoc tới 512 MB heap.
  await jobs.work<WordImportJob>(DOCSYNC_WORD_IMPORT_QUEUE, handle);
  await jobs.work<WordImportJob>(DOCSYNC_WORD_IMPORT_QUEUE, handle);
  await jobs.schedule(DOCSYNC_WORD_IMPORT_QUEUE, DOCSYNC_WORD_IMPORT_CRON, { scan: true } satisfies WordImportJob);
}

/** Hàng `docsync-word-doc`: `.doc` qua LibreOffice rồi đi tiếp như `.docx` (T014). */
export async function registerWordDoc(_jobs: Jobs, _deps: DocSyncDeps): Promise<void> {}
