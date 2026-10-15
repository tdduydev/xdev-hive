import { createHash } from "node:crypto";
import { DOC_MAX_CHARS, scanSecrets } from "@xdev-hive/contracts";
import { and, eq, sql } from "drizzle-orm";
import type pg from "pg";
import { Parser, type ReadEntry } from "tar";
import { loadProject } from "../catalog/index.ts";
import { type Jobs, loadDocStorageLimits, type Tx, withTenant } from "../platform/index.ts";
import { type GitProvider, isGitProviderError, type RepoRef } from "../scm/index.ts";
import { sdlcManagedPaths } from "../sdlc/index.ts";
import { parseFrontMatter, parseLfsPointer } from "./content.ts";
import { type HomeRow, homeById, homeProvider } from "./homes.ts";
import { isHardExcluded, keyFromPath, matchesHome, type PathHome, uniqueKey } from "./paths.ts";
import { DOCSYNC_SCAN_IMPORT_QUEUE, queuePull } from "./queues.ts";
import type { DocSyncDeps } from "./routes/deps.ts";
import { docAssets, docImportFiles, docImports, docRepoFiles } from "./schema.ts";

/** Cảnh báo hiện cho người dùng ở bản xem trước và báo cáo; giữ cố định để màn hình đếm theo loại. */
export const W = {
  managed: "Do SDLC quản lý, bỏ qua",
  exists: "Đã có trên hub",
  changed: "Đã đổi trong repo, hub sẽ kéo bản mới",
  collision: "Trùng key có sẵn",
  renamed: "Trùng key trong lần nhập, đã thêm hậu tố",
  secret: "Có dấu hiệu bí mật",
  tooLarge: "Quá lớn, chỉ ghi đường dẫn và kích thước",
  tooLong: "Quá lớn để soạn trên hub, lưu như đính kèm chỉ đọc",
  lfs: "Con trỏ LFS",
  nonUtf8: "Không phải UTF-8, nhập như file đính kèm",
  noKey: "Không tạo được key tài liệu",
} as const;

/** Trên ngưỡng này tải một archive thay vì gọi API từng file, để không cạn hạn mức của nhà cung cấp. */
export const ARCHIVE_THRESHOLD = 100;
const IMAGE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const OFFICE = /\.(?:docx|xlsx|pptx|pdf|csv|doc|xls|ppt|odt|ods|odp)$/i;
export const EXTRACTABLE = /\.(?:docx|xlsx|pptx|pdf|csv)$/i;

export type FileKind = "markdown" | "image" | "office" | "other";
export const kindOf = (path: string): FileKind =>
  /\.md$/i.test(path) ? "markdown" : IMAGE.test(path) ? "image" : OFFICE.test(path) ? "office" : "other";

export type ImportRow = typeof docImports.$inferSelect;
export type ImportFileRow = typeof docImportFiles.$inferSelect;
export type ImportJob = { orgId: string; homeId: string; importId: string };

export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export type RepoEntry = {
  path: string;
  size: number;
  /** SHA của blob theo cách git tính, để bản xem trước đối chiếu được với repo. */
  blobSha: string;
  sha256: string;
  /** null khi file vượt trần giữ trong bộ nhớ: chỉ còn kích thước và hash. */
  bytes: Uint8Array | null;
  /** readFile của provider đã thay byte hỏng bằng U+FFFD nên không còn biết nội dung gốc. */
  lossy?: boolean;
};

export type ReadOptions = {
  archive: boolean;
  /** Trần tổng byte của các file được chọn (HIVE_DOC_IMPORT_MAX_BYTES). */
  maxBytes: number;
  keep: (path: string, size: number) => boolean;
};

const archiveTooLarge = () =>
  new Error("Repo vượt giới hạn dung lượng nhập (HIVE_DOC_IMPORT_MAX_BYTES). Thu hẹp mẫu include rồi quét lại.");

function hashers(size: number) {
  const sha1 = createHash("sha1").update(`blob ${size}\0`);
  const sha256 = createHash("sha256");
  return {
    update(chunk: Uint8Array) {
      sha1.update(chunk);
      sha256.update(chunk);
    },
    digest: () => ({ blobSha: sha1.digest("hex"), sha256: sha256.digest("hex") }),
  };
}

function entryOf(path: string, bytes: Uint8Array, keep: boolean, lossy = false): RepoEntry {
  const h = hashers(bytes.length);
  h.update(bytes);
  return { path, size: bytes.length, ...h.digest(), bytes: keep ? bytes : null, ...(lossy ? { lossy } : {}) };
}

/** Đường dẫn trong archive bỏ thư mục gốc do nhà cung cấp thêm; từ chối mọi đoạn có thể thoát khỏi repo. */
function archivePath(raw: string): string | null {
  const parts = raw.replace(/^\/+/, "").split("/").slice(1);
  if (!parts.length || parts.some((p) => !p || p === "." || p === "..") || raw.includes("\\")) return null;
  return parts.join("/");
}

async function concat(reader: ReadableStreamDefaultReader<Uint8Array>, first: Uint8Array, limit: number) {
  const chunks = [first];
  let size = first.length;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) throw archiveTooLarge();
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function* tarEntries(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  first: Uint8Array,
  wanted: ReadonlySet<string>,
  opts: ReadOptions,
): AsyncGenerator<RepoEntry> {
  const ready: RepoEntry[] = [];
  let failure: unknown = null;
  let selected = 0;
  let total = 0;
  const parser = new Parser();
  const fail = (error: Error) => {
    failure ??= error;
    parser.abort(error);
  };
  const finished = new Promise<void>((resolve, reject) => {
    parser.on("end", resolve);
    parser.on("error", reject);
  });
  finished.catch(() => {});
  parser.on("entry", (entry: ReadEntry) => {
    const path = archivePath(entry.path);
    // Symlink và hardlink có thể trỏ ra ngoài cây hoặc vào file bí mật khác; chỉ nhận file thường.
    if (!path || !["File", "OldFile", "ContiguousFile"].includes(entry.type) || !wanted.has(path)) {
      total += entry.size;
      // Archive còn chứa file ngoài phần chọn; vẫn chặn archive phình bất thường.
      if (total > opts.maxBytes * 4) fail(archiveTooLarge());
      entry.resume();
      return;
    }
    selected += entry.size;
    if (selected > opts.maxBytes) {
      fail(archiveTooLarge());
      entry.resume();
      return;
    }
    const keep = opts.keep(path, entry.size);
    const h = hashers(entry.size);
    const chunks: Buffer[] = [];
    entry.on("data", (chunk: Buffer) => {
      h.update(chunk);
      if (keep) chunks.push(chunk);
    });
    entry.on("end", () =>
      ready.push({ path, size: entry.size, ...h.digest(), bytes: keep ? Buffer.concat(chunks) : null }),
    );
  });
  parser.on("error", (error: Error) => {
    failure ??= error;
  });
  let chunk: Uint8Array | undefined = first;
  while (chunk) {
    parser.write(chunk);
    // Cho zlib và các entry kịp xả dữ liệu trước khi đưa cho bên đọc.
    await new Promise((resolve) => setImmediate(resolve));
    if (failure) throw failure;
    while (ready.length) yield ready.shift() as RepoEntry;
    const next = await reader.read();
    chunk = next.done ? undefined : next.value;
  }
  parser.end();
  await finished;
  if (failure) throw failure;
  while (ready.length) yield ready.shift() as RepoEntry;
}

/**
 * Đọc nội dung các file `wanted` ở commit `sha`. File không có trong repo thì không trả; bên gọi tự đánh lỗi.
 * Lỗi provider (kể cả ngắt giữa chừng khi đang tải archive) ném ra nguyên vẹn để job hẹn chạy lại.
 */
export async function* readRepoFiles(
  provider: GitProvider,
  ref: RepoRef,
  sha: string,
  wanted: ReadonlySet<string>,
  opts: ReadOptions,
): AsyncGenerator<RepoEntry> {
  if (!wanted.size) return;
  if (!opts.archive) {
    let selected = 0;
    for (const path of [...wanted].sort()) {
      const text = await provider.readFile(ref, path, sha);
      if (text === null) continue;
      const bytes = new TextEncoder().encode(text);
      selected += bytes.length;
      if (selected > opts.maxBytes) throw archiveTooLarge();
      yield entryOf(path, bytes, opts.keep(path, bytes.length), text.includes("�"));
    }
    return;
  }
  const reader = (await provider.archive(ref, sha)).getReader();
  try {
    const first = await reader.read();
    if (first.done) return;
    // Provider memory (test và chạy tại máy) trả JSON {path: nội dung}; provider thật trả tar hoặc tar.gz.
    if (first.value[0] === 0x7b) {
      const files = JSON.parse((await concat(reader, first.value, opts.maxBytes * 4)).toString("utf8")) as Record<
        string,
        string
      >;
      let selected = 0;
      for (const path of Object.keys(files).sort()) {
        if (!wanted.has(path)) continue;
        const bytes = new TextEncoder().encode(files[path]);
        selected += bytes.length;
        if (selected > opts.maxBytes) throw archiveTooLarge();
        yield entryOf(path, bytes, opts.keep(path, bytes.length));
      }
      return;
    }
    yield* tarEntries(reader, first.value, wanted, opts);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export const useArchive = (paths: readonly string[]) =>
  paths.length > ARCHIVE_THRESHOLD || paths.some((p) => kindOf(p) !== "markdown");

export async function pathHomeOf(tx: Tx, home: HomeRow, patterns: { include: string[]; exclude: string[] }) {
  const common = {
    ...(patterns.include.length ? { include: patterns.include } : {}),
    ...(patterns.exclude.length ? { exclude: patterns.exclude } : {}),
  };
  if (!home.projectId) return { pathHome: { ...common, scope: "org", root: home.root } as PathHome, managed: [] };
  const project = await loadProject(tx, home.projectId);
  if (!project) throw new Error("Dự án của nhà tài liệu không còn tồn tại.");
  return {
    pathHome: { ...common, scope: "project", projectKey: project.key, root: home.root } as PathHome,
    managed: await sdlcManagedPaths(tx, home.projectId),
  };
}

export const repoRef = (home: HomeRow): RepoRef => ({ owner: home.owner, name: home.name });

/** Lỗi tạm của nhà cung cấp thì hẹn lại theo Retry-After; trả false khi lỗi phải dừng hẳn. */
export async function retryLater(jobs: Jobs, queue: string, data: ImportJob, error: unknown): Promise<boolean> {
  if (!isGitProviderError(error) || !error.retryable) return false;
  await jobs.enqueue(queue, data, {
    singletonKey: data.homeId,
    startAfter: new Date(Date.now() + (error.retryAfterMs ?? 60_000)),
  });
  return true;
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000);

type ScanOptions = { maxBytes?: number; assetMaxBytes?: number };

type Candidate = RepoEntry & { kind: FileKind };

/** Quét: đọc cây file ở đầu nhánh, phân loại, cảnh báo và ghi doc_import_files. Không ghi gì vào tài liệu. */
export async function runScan(deps: DocSyncDeps, job: ImportJob, opts: ScanOptions = {}): Promise<void> {
  const pool = deps.pool as pg.Pool;
  const limits = loadDocStorageLimits();
  const maxBytes = opts.maxBytes ?? limits.importMaxBytes;
  const assetMaxBytes = opts.assetMaxBytes ?? limits.assetMaxBytes;
  const ctx = { orgId: job.orgId };
  const loaded = await withTenant(pool, ctx, async (tx) => {
    const [imp] = await tx.select().from(docImports).where(eq(docImports.id, job.importId));
    if (imp?.state !== "scanning") return null;
    const home = await homeById(tx, imp.homeId);
    const provider = await homeProvider(tx, deps, home.connectionId);
    const { pathHome, managed } = await pathHomeOf(tx, home, imp);
    const mapped = await tx
      .select({ path: docRepoFiles.repoPath, repoHash: docRepoFiles.repoHash, docId: docRepoFiles.docId })
      .from(docRepoFiles)
      .where(eq(docRepoFiles.homeId, home.id));
    const assets = await tx
      .select({ path: docAssets.repoPath, sha256: docAssets.sha256 })
      .from(docAssets)
      .where(eq(docAssets.homeId, home.id));
    return { imp, home, provider, pathHome, managed, mapped, assets };
  });
  if (!loaded) return;
  const { home, provider, pathHome, managed } = loaded;
  try {
    const ref = repoRef(home);
    const head = await provider.branchHead(ref, home.branch);
    if (!head) throw new Error(`Không tìm thấy nhánh ${home.branch} trong repo.`);
    const paths = (await provider.listFiles(ref, head)).filter((p) => matchesHome(p, pathHome));
    const candidates: Candidate[] = [];
    for await (const entry of readRepoFiles(provider, ref, head, new Set(paths), {
      archive: useArchive(paths),
      maxBytes,
      // File nhỏ được giữ để nhận ra con trỏ LFS.
      keep: (path, size) => kindOf(path) === "markdown" || size < 200,
    }))
      candidates.push({ ...entry, kind: kindOf(entry.path) });
    candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    await withTenant(pool, ctx, (tx) =>
      writePreview(tx, deps, job, { ...loaded, head, candidates, managed, assetMaxBytes }),
    );
  } catch (error) {
    if (deps.jobs && (await retryLater(deps.jobs, DOCSYNC_SCAN_IMPORT_QUEUE, job, error))) return;
    await withTenant(pool, ctx, (tx) =>
      tx
        .update(docImports)
        .set({ state: "failed", error: errorText(error), updatedAt: new Date() })
        .where(and(eq(docImports.id, job.importId), eq(docImports.state, "scanning"))),
    );
  }
}

async function existingDocs(tx: Tx, keys: string[]) {
  if (!keys.length) return new Map<string, { id: string; mapped: boolean }>();
  // Bảng docs thuộc module knowledge; chỉ đọc key và id, không đi vòng qua listDocs vì job không có người dùng.
  const { rows } = await tx.execute<{ id: string; key: string; mapped: boolean }>(sql`
    select d.id, d.key, exists (select 1 from hive.doc_repo_files f where f.doc_id = d.id) as mapped
      from hive.docs d
     where d.key in (select jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))`);
  return new Map(rows.map((r) => [r.key, { id: r.id, mapped: r.mapped }]));
}

async function writePreview(
  tx: Tx,
  deps: DocSyncDeps,
  job: ImportJob,
  input: {
    home: HomeRow;
    pathHome: PathHome;
    managed: string[];
    mapped: Array<{ path: string; repoHash: string | null; docId: string }>;
    assets: Array<{ path: string; sha256: string }>;
    head: string;
    candidates: Candidate[];
    assetMaxBytes: number;
  },
) {
  const [imp] = await tx.select().from(docImports).where(eq(docImports.id, job.importId)).for("update");
  if (imp?.state !== "scanning") return;
  const mapped = new Map(input.mapped.map((m) => [m.path, m]));
  const assets = new Map(input.assets.map((a) => [a.path, a.sha256]));
  const managed = { sdlcPaths: input.managed, skillRoots: input.managed };
  const keys = new Map<string, { key: string | null; warnings: string[] }>();
  for (const c of input.candidates) {
    if (c.kind !== "markdown" || isHardExcluded(c.path, managed) || mapped.has(c.path) || !c.bytes) continue;
    const text = c.lossy ? null : decodeUtf8(c.bytes);
    if (text === null || text.length > DOC_MAX_CHARS || parseLfsPointer(text)) continue;
    const fm = parseFrontMatter(text);
    let key: string | null = null;
    try {
      key = keyFromPath(c.path, input.pathHome, fm.key);
    } catch {}
    keys.set(c.path, { key, warnings: fm.warnings });
  }
  const existing = await existingDocs(
    tx,
    [...keys.values()].flatMap((k) => (k.key ? [k.key] : [])),
  );
  const occupied = new Set<string>([...existing.keys()]);
  const assigned = new Set<string>();
  const rows: Array<typeof docImportFiles.$inferInsert> = [];
  let pull = false;
  for (const c of input.candidates) {
    const warnings: string[] = [];
    const base = {
      orgId: job.orgId,
      importId: job.importId,
      repoPath: c.path,
      blobSha: c.blobSha,
      kind: c.kind,
      size: c.size,
    };
    if (isHardExcluded(c.path, managed)) {
      rows.push({ ...base, state: "skipped", warnings: [W.managed] });
      continue;
    }
    const known = mapped.get(c.path);
    const asset = assets.get(c.path);
    if (known || asset !== undefined) {
      const changed = (known ? known.repoHash : asset) !== c.sha256;
      pull ||= changed;
      rows.push({ ...base, state: "skipped", warnings: [changed ? W.changed : W.exists] });
      continue;
    }
    if (c.kind !== "markdown") {
      if (c.size > input.assetMaxBytes) warnings.push(W.tooLarge);
      else if (c.size < 200 && c.bytes && parseLfsPointer(new TextDecoder().decode(c.bytes))) warnings.push(W.lfs);
      rows.push({ ...base, warnings });
      continue;
    }
    const text = c.lossy || !c.bytes ? null : decodeUtf8(c.bytes);
    if (text === null) {
      rows.push({ ...base, warnings: [W.nonUtf8] });
      continue;
    }
    if (parseLfsPointer(text)) {
      rows.push({ ...base, warnings: [W.lfs] });
      continue;
    }
    if (text.length > DOC_MAX_CHARS) {
      rows.push({ ...base, warnings: [W.tooLong] });
      continue;
    }
    const info = keys.get(c.path);
    warnings.push(...(info?.warnings ?? []));
    if (!info?.key) {
      rows.push({ ...base, state: "skipped", warnings: [...warnings, W.noKey] });
      continue;
    }
    const findings = scanSecrets(text);
    if (findings.length) warnings.push(W.secret);
    const secret = { secretScan: findings.length ? "found" : "clean", findings };
    const other = existing.get(info.key);
    if (other && !other.mapped && !assigned.has(info.key)) {
      // Tài liệu cùng key chưa gắn repo nào: người dùng chọn đổi tên, gắn vào hoặc bỏ qua.
      assigned.add(info.key);
      rows.push({ ...base, ...secret, key: info.key, existingKey: info.key, warnings: [...warnings, W.collision] });
      continue;
    }
    const key = uniqueKey(info.key, new Set([...occupied, ...assigned]));
    if (key !== info.key) warnings.push(W.renamed);
    assigned.add(key);
    rows.push({ ...base, ...secret, key, warnings });
  }
  for (let i = 0; i < rows.length; i += 500) await tx.insert(docImportFiles).values(rows.slice(i, i + 500));
  if (pull && deps.jobs) await queuePull(deps.jobs, { orgId: job.orgId, homeId: input.home.id }, { tx });
  const count = (kind: FileKind) => rows.filter((r) => r.kind === kind).length;
  const warnings: Record<string, number> = {};
  for (const r of rows) for (const w of r.warnings ?? []) warnings[w] = (warnings[w] ?? 0) + 1;
  await tx
    .update(docImports)
    .set({
      state: "ready",
      commitSha: input.head,
      progress: { done: 0, total: rows.filter((r) => (r.state ?? "pending") === "pending").length, cursor: null },
      preview: {
        files: rows.length,
        bytes: rows.reduce((sum, r) => sum + (r.size ?? 0), 0),
        markdown: count("markdown"),
        image: count("image"),
        office: count("office"),
        other: count("other"),
        warnings,
      },
      updatedAt: new Date(),
    })
    .where(eq(docImports.id, job.importId));
}
