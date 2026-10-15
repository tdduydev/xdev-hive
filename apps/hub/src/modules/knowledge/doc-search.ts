import { type DocSearchHit, type DocSearchInput, type DocSearchOutput, docSearchInput } from "@xdev-hive/contracts";
import { and, eq, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import type pg from "pg";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { canRead, type Principal, projectContext, type Reader, readerFor, visibleWhere } from "./access.ts";
import { type Embedder, vectorLiteral } from "./embedder.ts";
import { embedQuery, orQuery } from "./memory.ts";
import { docChunks, docs, docVersions } from "./schema.ts";

// Chỉ mục đoạn và tìm theo nghĩa cho tài liệu và bản trích đã duyệt (spec 018, FR-036…FR-038, plan.md mục 10).

// ---- Chia đoạn -----------------------------------------------------------------------------------------------------

/** Khoảng ký tự mỗi đoạn (FR-036): đủ một mục ngắn trọn vẹn, vẫn vừa giới hạn đầu vào của mô hình embedding. */
export const CHUNK_CHARS = 1500;

export interface DocChunk {
  headingPath: string[];
  content: string;
}

const FRONT_MATTER = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
// Chỉ nhận đúng giá trị boolean của YAML như docsync/content.ts: chuỗi "true" không tính là nhãn.
const CONFIDENTIAL = /^confidential[ \t]*:[ \t]*(?:true|True|TRUE)[ \t]*(?:#.*)?$/m;

/**
 * Tách front-matter khỏi phần thân. knowledge không import được bộ đọc YAML của docsync (docsync phụ thuộc knowledge),
 * mà ở đây chỉ cần một nhãn cấp cao nhất nên dò theo dòng là đủ.
 */
export function splitFrontMatter(content: string): { body: string; confidential: boolean } {
  const match = FRONT_MATTER.exec(content);
  if (!match) return { body: content, confidential: false };
  return { body: content.slice(match[0].length), confidential: CONFIDENTIAL.test(match[1] ?? "") };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/;

interface Section {
  path: string[];
  blocks: string[];
}

/** Chia thành mục theo tiêu đề `#`–`###` và khối (đoạn văn, code fence) trong mục; bỏ tiêu đề nằm trong code fence. */
function sectionsOf(markdown: string): Section[] {
  const sections: Section[] = [{ path: [], blocks: [] }];
  const stack: { level: number; title: string }[] = [];
  let block: string[] = [];
  let fence: { char: string; length: number } | undefined;
  const current = () => sections[sections.length - 1] as Section;
  const flush = () => {
    const text = block.join("\n").trim();
    if (text) current().blocks.push(text);
    block = [];
  };
  for (const line of markdown.split("\n")) {
    const marker = FENCE.exec(line);
    if (marker) {
      const run = marker[1] ?? "";
      if (!fence) {
        flush();
        fence = { char: run[0] ?? "", length: run.length };
      } else if (run[0] === fence.char && run.length >= fence.length && !marker[2]?.trim()) {
        block.push(line);
        fence = undefined;
        flush();
        continue;
      }
      block.push(line);
      continue;
    }
    if (fence) {
      block.push(line);
      continue;
    }
    const heading = HEADING.exec(line);
    const level = heading?.[1]?.length ?? 0;
    if (heading && level <= 3) {
      flush();
      const title = (heading[2] ?? "")
        .trim()
        .replace(/[ \t]+#+$/, "")
        .trim();
      while (stack.length && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
      stack.push({ level, title });
      sections.push({ path: stack.map((h) => h.title).filter(Boolean), blocks: [line.trim()] });
      continue;
    }
    if (!line.trim()) flush();
    else block.push(line);
  }
  flush();
  return sections;
}

/** Khối dài hơn một đoạn (bảng, code lớn) thì cắt theo dòng, dòng quá dài thì cắt cứng. */
function splitBlock(block: string, max: number): string[] {
  if (block.length <= max) return [block];
  const parts: string[] = [];
  let part = "";
  for (const line of block.split("\n")) {
    for (let i = 0; i < Math.max(line.length, 1); i += max) {
      const piece = line.slice(i, i + max);
      if (part && part.length + 1 + piece.length > max) {
        parts.push(part);
        part = "";
      }
      part = part ? `${part}\n${piece}` : piece;
    }
  }
  if (part.trim()) parts.push(part);
  return parts;
}

/**
 * Chia tài liệu Markdown thành đoạn để tìm (research.md mục 3.8). Mỗi đoạn thuộc một mục và mang đường tiêu đề để
 * kết quả dễ đọc; mục chỉ có tiêu đề thì bỏ. Không còn đoạn nào thì lấy tiêu đề tài liệu, để tài liệu rỗng vẫn tìm
 * được theo tên và lượt điền chỉ mục không coi nó là còn thiếu.
 */
export function chunkMarkdown(markdown: string, title: string, max = CHUNK_CHARS): DocChunk[] {
  const chunks: DocChunk[] = [];
  for (const section of sectionsOf(markdown.replace(/\r\n?/g, "\n"))) {
    const hasBody = section.path.length === 0 ? section.blocks.length > 0 : section.blocks.length > 1;
    if (!hasBody) continue;
    let content = "";
    for (const piece of section.blocks.flatMap((b) => splitBlock(b, max))) {
      if (content && content.length + 2 + piece.length > max) {
        chunks.push({ headingPath: section.path, content });
        content = "";
      }
      content = content ? `${content}\n\n${piece}` : piece;
    }
    if (content) chunks.push({ headingPath: section.path, content });
  }
  if (chunks.length === 0 && title.trim()) chunks.push({ headingPath: [], content: title.trim() });
  return chunks;
}

/** Văn bản gửi đi embedding: thêm tên tài liệu và đường tiêu đề để đoạn ngắn vẫn mang đủ ngữ cảnh. */
export function embeddingText(title: string, chunk: DocChunk): string {
  const head = [title, ...chunk.headingPath].filter(Boolean).join(" › ");
  return (head ? `${head}\n\n${chunk.content}` : chunk.content).normalize("NFC");
}

const SNIPPET_CHARS = 240;

/** Trích đoạn quanh từ khớp đầu tiên; khớp theo nghĩa (không trùng từ nào) thì lấy phần đầu đoạn. */
export function snippetOf(content: string, query: string, max = SNIPPET_CHARS): string {
  const text = content.normalize("NFC").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  const words = (query.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1);
  const hits = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  let start = Math.max(0, Math.min(at - Math.floor(max / 4), text.length - max));
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space >= 0 && space < at) start = space + 1;
  }
  let end = Math.min(text.length, start + max);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start) end = space;
  }
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

// ---- Job chỉ mục ---------------------------------------------------------------------------------------------------

export const DOC_INDEX_QUEUE = "knowledge-doc-index";

/** Một tài liệu, một bản trích, hoặc lượt điền cho mọi thứ còn thiếu của tổ chức. Job đọc lại nội dung khi chạy. */
export type DocIndexJob = { orgId: string } & ({ docId: string } | { extractId: string } | { backfill: true });

/**
 * Đoạn cố ý không gửi đi embedding (bí mật, `confidential`). Ghi vào embedding_model để lượt điền phân biệt với đoạn
 * chưa kịp tạo embedding, khỏi thử lại mãi; tìm theo vector so đúng tên mô hình nên không bao giờ khớp giá trị này.
 */
export const EMBEDDING_SKIPPED = "skipped";

// Lưu tài liệu không nhận deps (applyDocSave được gọi từ nhiều đường), nên hàng đợi tiêm một lần lúc khởi động như
// provideDocSaved; không có thì không xếp job, tìm theo từ vẫn chạy trên chỉ mục đã có.
let indexJobs: Jobs | undefined;
export function provideDocIndexJobs(jobs: Jobs | undefined): void {
  indexJobs = jobs;
}

const singletonOf = (job: DocIndexJob) =>
  "docId" in job ? `doc:${job.docId}` : "extractId" in job ? `extract:${job.extractId}` : `backfill:${job.orgId}`;

/** Xếp job chỉ mục trong transaction đang ghi, để job chỉ chạy khi phiên bản thật sự được lưu. */
export async function queueDocIndex(tx: Tx, job: DocIndexJob): Promise<void> {
  await indexJobs?.enqueue(DOC_INDEX_QUEUE, job, { tx, singletonKey: singletonOf(job) });
}

/** Đánh chỉ mục bản trích vừa được duyệt (hoặc bị từ chối, để gỡ đoạn cũ). docsync gọi trong transaction duyệt. */
export async function indexExtract(tx: Tx, extractId: string): Promise<void> {
  const { rows } = await tx.execute<{ org: string }>(sql`select hive.ctx_org()::text as org`);
  const orgId = rows[0]?.org;
  if (orgId) await queueDocIndex(tx, { orgId, extractId });
}

/** Cột embedding của doc_chunks chỉ có khi database cài pgvector (hive.enable_doc_vectors). */
export async function hasDocVectors(tx: Tx): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`
    select exists (
      select 1 from pg_attribute
      where attrelid = 'hive.doc_chunks'::regclass and attname = 'embedding' and not attisdropped
    ) as ok`);
  return rows[0]?.ok === true;
}

export interface DocIndexDeps {
  /** Pool của hive_app; job chạy trong tenant của tổ chức trong payload. */
  pool: pg.Pool;
  /** Không có thì chỉ dựng tsvector. */
  embedder?: Embedder | undefined;
}

interface Pending {
  id: string;
  text: string;
}

/** Số đoạn mỗi lần gọi API embeddings. */
const EMBED_BATCH = 32;
/** Số tài liệu mỗi lượt điền; còn nữa thì lượt sau làm tiếp, để một job không giữ worker quá lâu. */
const BACKFILL_BATCH = 200;

type Source = { docId: string; extractId?: undefined } | { extractId: string; docId?: undefined };

/** Ghi lại đoạn của một nguồn: xoá đoạn cũ (mọi phiên bản) rồi chèn đoạn mới. */
async function replaceChunks(
  tx: Tx,
  source: Source,
  version: number,
  chunks: DocChunk[],
  embed: boolean,
): Promise<Array<{ id: string; ord: number }>> {
  const owner =
    source.extractId === undefined ? eq(docChunks.docId, source.docId) : eq(docChunks.extractId, source.extractId);
  await tx.delete(docChunks).where(owner);
  if (chunks.length === 0) return [];
  return tx
    .insert(docChunks)
    .values(
      chunks.map((c, ord) => ({
        orgId: sql`hive.ctx_org()`,
        docId: source.docId ?? null,
        extractId: source.extractId ?? null,
        version,
        ord,
        headingPath: c.headingPath,
        content: c.content.normalize("NFC"),
        embeddingModel: embed ? null : EMBEDDING_SKIPPED,
      })),
    )
    .returning({ id: docChunks.id, ord: docChunks.ord });
}

/** Đoạn của nguồn còn thiếu embedding của mô hình hiện tại. */
async function missingEmbeddings(tx: Tx, owner: SQL, title: string, model: string): Promise<Pending[]> {
  const rows = await tx
    .select({ id: docChunks.id, headingPath: docChunks.headingPath, content: docChunks.content })
    .from(docChunks)
    .where(
      and(
        owner,
        sql`${docChunks.embeddingModel} is distinct from ${model}`,
        sql`${docChunks.embeddingModel} is distinct from ${EMBEDDING_SKIPPED}`,
      ),
    )
    .orderBy(docChunks.ord);
  return rows.map((r) => ({ id: r.id, text: embeddingText(title, r) }));
}

/**
 * Bước trong transaction của một tài liệu: dựng lại đoạn khi phiên bản hiện tại chưa có, trả các đoạn cần embedding.
 * Tài liệu đã xoá hoặc lưu trữ thì gỡ đoạn (FR-024: lưu trữ ẩn khỏi tìm kiếm).
 */
async function prepareDoc(tx: Tx, docId: string, model: string | null): Promise<Pending[]> {
  const [d] = await tx
    .select({
      title: docs.title,
      version: docs.currentVersion,
      archivedAt: docs.archivedAt,
      content: docVersions.content,
      secretFlag: docVersions.secretFlag,
    })
    .from(docs)
    .innerJoin(docVersions, and(eq(docVersions.docId, docs.id), eq(docVersions.version, docs.currentVersion)))
    .where(eq(docs.id, docId));
  if (!d || d.archivedAt) {
    await tx.delete(docChunks).where(eq(docChunks.docId, docId));
    return [];
  }
  const owner = and(eq(docChunks.docId, docId), eq(docChunks.version, d.version)) as SQL;
  const [has] = await tx.select({ id: docChunks.id }).from(docChunks).where(owner).limit(1);
  if (!has) {
    const { body, confidential } = splitFrontMatter(d.content);
    // FR-038: nội dung có dấu hiệu bí mật hoặc gắn nhãn confidential không rời hub sang nhà cung cấp embedding.
    await replaceChunks(tx, { docId }, d.version, chunkMarkdown(body, d.title), !d.secretFlag && !confidential);
  }
  return model ? missingEmbeddings(tx, owner, d.title, model) : [];
}

interface ExtractRow extends Record<string, unknown> {
  asset_id: string;
  content: string;
  state: string;
  secret_flag: boolean;
  title: string;
}

/**
 * Bản trích nằm ở bảng của docsync; knowledge không import docsync (vòng phụ thuộc) nên đọc thẳng bảng, cùng
 * migration với doc_chunks nên luôn có. Chỉ bản `approved` vào chỉ mục (FR-034); duyệt bản mới thì gỡ đoạn của bản
 * cũ cùng đính kèm.
 */
async function prepareExtract(tx: Tx, extractId: string, model: string | null): Promise<Pending[]> {
  const { rows } = await tx.execute<ExtractRow>(sql`
    select e.asset_id, e.content, e.state, e.secret_flag, coalesce(d.title, a.repo_path) as title
    from hive.doc_extracts e
    join hive.doc_assets a on a.id = e.asset_id
    left join hive.docs d on d.id = a.owner_doc_id
    where e.id = ${extractId}`);
  const e = rows[0];
  if (!e || e.state !== "approved") {
    await tx.delete(docChunks).where(eq(docChunks.extractId, extractId));
    return [];
  }
  await tx.execute(sql`delete from ${docChunks} where ${docChunks.extractId} in (
    select id from hive.doc_extracts where asset_id = ${e.asset_id} and id <> ${extractId})`);
  const owner = eq(docChunks.extractId, extractId);
  const [has] = await tx.select({ id: docChunks.id }).from(docChunks).where(owner).limit(1);
  if (!has) await replaceChunks(tx, { extractId }, 1, chunkMarkdown(e.content, e.title), !e.secret_flag);
  return model ? missingEmbeddings(tx, owner, e.title, model) : [];
}

/** Gọi API embeddings theo lô, ngoài transaction, rồi ghi từng lô trong một transaction ngắn. */
async function embedPending(
  deps: DocIndexDeps & { embedder: Embedder },
  orgId: string,
  pending: Pending[],
  signal?: AbortSignal,
): Promise<number> {
  let done = 0;
  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const batch = pending.slice(i, i + EMBED_BATCH);
    const vectors = await deps.embedder.embed(
      batch.map((p) => p.text),
      signal,
    );
    await withTenant(deps.pool, { orgId }, async (tx) => {
      for (const [j, p] of batch.entries()) {
        const v = vectors[j];
        if (!v) continue;
        // Đoạn đã bị thay (phiên bản mới lưu trong lúc chờ API) thì id không còn, câu lệnh không làm gì.
        await tx.execute(sql`update ${docChunks}
          set embedding = ${vectorLiteral(v)}::vector, embedding_model = ${deps.embedder.model}, updated_at = now()
          where ${docChunks.id} = ${p.id} and ${docChunks.embeddingModel} is distinct from ${EMBEDDING_SKIPPED}`);
      }
    });
    done += batch.length;
  }
  return done;
}

async function indexOne(deps: DocIndexDeps, orgId: string, source: Source, signal?: AbortSignal): Promise<number> {
  const pending = await withTenant(deps.pool, { orgId }, async (tx) => {
    const model = deps.embedder && (await hasDocVectors(tx)) ? deps.embedder.model : null;
    return source.extractId === undefined
      ? prepareDoc(tx, source.docId, model)
      : prepareExtract(tx, source.extractId, model);
  });
  if (!deps.embedder || pending.length === 0) return 0;
  return embedPending({ ...deps, embedder: deps.embedder }, orgId, pending, signal);
}

/**
 * Tài liệu và bản trích của tổ chức còn thiếu đoạn của phiên bản hiện tại, hoặc thiếu embedding của mô hình đang cấu
 * hình (vừa bật embedding, đổi mô hình, API lỗi lúc lưu).
 */
async function backlog(tx: Tx, model: string | null, limit: number): Promise<Source[]> {
  const embedGap = model
    ? sql`or exists (select 1 from ${docChunks} c where c.doc_id = ${docs.id}
        and c.embedding_model is distinct from ${model} and c.embedding_model is distinct from ${EMBEDDING_SKIPPED})`
    : sql``;
  const docRows = await tx
    .select({ id: docs.id })
    .from(docs)
    .where(
      and(
        isNull(docs.archivedAt),
        sql`(not exists (select 1 from ${docChunks} c where c.doc_id = ${docs.id} and c.version = ${docs.currentVersion}) ${embedGap})`,
      ),
    )
    .orderBy(docs.id)
    .limit(limit);
  const extractGap = model
    ? sql`or exists (select 1 from ${docChunks} c where c.extract_id = e.id
        and c.embedding_model is distinct from ${model} and c.embedding_model is distinct from ${EMBEDDING_SKIPPED})`
    : sql``;
  const { rows } = await tx.execute<{ id: string }>(sql`
    select e.id from hive.doc_extracts e
    where e.state = 'approved'
      and (not exists (select 1 from ${docChunks} c where c.extract_id = e.id) ${extractGap})
    order by e.id limit ${Math.max(0, limit - docRows.length)}`);
  return [...docRows.map((r) => ({ docId: r.id })), ...rows.map((r) => ({ extractId: r.id }))];
}

export type DocIndexOutcome = { indexed: number; embedded: number; more: boolean };

/** Xử lý một job chỉ mục. Lượt điền làm một lô rồi tự xếp lượt kế khi còn việc. */
export async function runDocIndex(
  deps: DocIndexDeps,
  job: DocIndexJob,
  signal?: AbortSignal,
  jobs: Jobs | undefined = indexJobs,
): Promise<DocIndexOutcome> {
  if ("docId" in job) return { indexed: 1, embedded: await indexOne(deps, job.orgId, { docId: job.docId }, signal), more: false };
  if ("extractId" in job)
    return { indexed: 1, embedded: await indexOne(deps, job.orgId, { extractId: job.extractId }, signal), more: false };
  const todo = await withTenant(deps.pool, { orgId: job.orgId }, async (tx) => {
    const model = deps.embedder && (await hasDocVectors(tx)) ? deps.embedder.model : null;
    return backlog(tx, model, BACKFILL_BATCH);
  });
  let embedded = 0;
  for (const source of todo) {
    signal?.throwIfAborted();
    embedded += await indexOne(deps, job.orgId, source, signal);
  }
  const more = todo.length >= BACKFILL_BATCH;
  if (more) await jobs?.enqueue(DOC_INDEX_QUEUE, job, { singletonKey: singletonOf(job) });
  return { indexed: todo.length, embedded, more };
}

export async function registerDocIndexWorker(jobs: Jobs, deps: DocIndexDeps): Promise<void> {
  await jobs.work<DocIndexJob>(DOC_INDEX_QUEUE, async (job) => {
    await runDocIndex(deps, job.data, job.signal, jobs);
  });
}

// ---- Tìm -----------------------------------------------------------------------------------------------------------

/** Số ứng viên lấy từ mỗi nguồn trước khi trộn, như searchMemory. */
const CANDIDATES = 50;
/** Hằng số Reciprocal Rank Fusion, như searchMemory (FR-037). */
const RRF_K = 60;
/** Mỗi tiến trình kiểm "còn thiếu chỉ mục không" tối đa một lần trong khoảng này cho mỗi tổ chức. */
const BACKLOG_CHECK_MS = 10 * 60_000;
const backlogChecked = new Map<string, number>();

/**
 * Tài liệu có sẵn trước khi bật tìm kiếm (hoặc trước khi cấu hình embedding) chưa có đoạn. Không có hàm liệt kê mọi
 * tổ chức cho hive_app, nên lượt điền được xếp khi tổ chức tìm lần đầu và còn thiếu; sau đó mỗi phiên bản mới tự có
 * job riêng nên lượt điền chỉ chạy lại khi thật sự còn thiếu.
 */
async function ensureBackfill(tx: Tx, model: string | null): Promise<void> {
  if (!indexJobs) return;
  const { rows } = await tx.execute<{ org: string }>(sql`select hive.ctx_org()::text as org`);
  const orgId = rows[0]?.org;
  if (!orgId) return;
  const now = Date.now();
  if (now - (backlogChecked.get(orgId) ?? 0) < BACKLOG_CHECK_MS) return;
  backlogChecked.set(orgId, now);
  if ((await backlog(tx, model, 1)).length > 0) await queueDocIndex(tx, { orgId, backfill: true });
}

/** Chỉ dùng trong test: quên mốc kiểm để mỗi ca test tự kiểm lại. */
export function resetDocBackfillCheck(): void {
  backlogChecked.clear();
}

function scopeWhere(level: DocSearchInput["scope"]): SQL | undefined {
  if (level === "org") return isNull(docs.teamId);
  if (level === "team") return and(isNotNull(docs.teamId), isNull(docs.projectId));
  if (level === "project") return isNotNull(docs.projectId);
  return undefined;
}

/** Phiên bản hiện tại của tài liệu có dấu hiệu bí mật chưa xác nhận: không trả cho agent (FR-038). */
const docFlagged = sql`exists (select 1 from ${docVersions} v where v.doc_id = ${docs.id} and v.version = ${docs.currentVersion} and v.secret_flag)`;

export interface DocSearchOptions {
  embedder?: Embedder | undefined;
  /** Embedding của câu tìm đã tính ngoài transaction; bỏ trống thì hàm tự gọi embedder nếu có. */
  queryEmbedding?: number[] | null | undefined;
}

interface HitRow extends Record<string, unknown> {
  id: string;
  key: string;
  title: string;
  team_id: string | null;
  project_id: string | null;
  heading_path: string[];
  content: string;
  extract_id: string | null;
  repo_path: string | null;
}

/**
 * Tìm đoạn tài liệu và bản trích đã duyệt: full-text (tsvector 'simple') và, khi có embedding, vector (cosine), trộn
 * bằng RRF k = 60. Lọc phạm vi trong SQL như listDocs rồi kiểm lại `canRead` từng kết quả. Run chỉ thấy dự án của nó
 * và không thấy tài liệu có dấu hiệu bí mật chưa xác nhận. Hàm public cho MCP.
 */
export async function searchDocs(
  tx: Tx,
  principal: Principal,
  input: DocSearchInput,
  opts: DocSearchOptions = {},
): Promise<DocSearchOutput> {
  const data = docSearchInput.parse(input);
  const reader: Reader = await readerFor(tx, principal);
  const project = await projectContext(tx, reader, data.project);
  const vectors = opts.embedder ? await hasDocVectors(tx) : false;
  await ensureBackfill(tx, vectors && opts.embedder ? opts.embedder.model : null);

  const from = sql`from ${docChunks}
    left join hive.doc_extracts e on e.id = ${docChunks.extractId}
    left join hive.doc_assets a on a.id = e.asset_id
    join ${docs} on ${docs.id} = coalesce(${docChunks.docId}, a.owner_doc_id)`;
  const where = and(
    visibleWhere(reader, docs, project),
    scopeWhere(data.scope),
    isNull(docs.archivedAt),
    sql`(${docChunks.docId} is null or ${docChunks.version} = ${docs.currentVersion})`,
    sql`(${docChunks.extractId} is null or e.state = 'approved')`,
    // Bản trích mang cờ thì chặn cả khi đã duyệt: thà agent thiếu kết quả còn hơn lộ bí mật.
    reader.kind === "run"
      ? sql`not (case when ${docChunks.docId} is null then coalesce(e.secret_flag, false) else ${docFlagged} end)`
      : undefined,
  );

  const sources: SQL[] = [];
  const text = orQuery(data.query);
  if (text) {
    const q = sql`to_tsquery('simple', ${text})`;
    sources.push(sql`select ${docChunks.id} as id,
        row_number() over (order by ts_rank_cd(${docChunks.search}, ${q}) desc, ${docChunks.id}) as r
      ${from} where ${where} and ${docChunks.search} @@ ${q}
      order by r limit ${CANDIDATES}`);
  }
  let hybrid = false;
  const embedder = opts.embedder;
  if (embedder && vectors) {
    const v = opts.queryEmbedding === undefined ? await embedQuery(embedder, data.query) : opts.queryEmbedding;
    if (v) {
      hybrid = true;
      const e = sql`${vectorLiteral(v)}::vector`;
      sources.push(sql`select ${docChunks.id} as id,
          row_number() over (order by "doc_chunks"."embedding" <=> ${e}, ${docChunks.id}) as r
        ${from} where ${where} and "doc_chunks"."embedding" is not null and ${docChunks.embeddingModel} = ${embedder.model}
        order by r limit ${CANDIDATES}`);
    }
  }
  const mode = hybrid ? "hybrid" : "keyword";
  if (sources.length === 0) return { mode, hits: [] };

  const ranked = sql.join(
    sources.map((s) => sql`(${s})`),
    sql` union all `,
  );
  const { rows } = await tx.execute<HitRow>(sql`
    with top as (
      select id, sum(1.0 / (${RRF_K} + r))::float8 as score
      from (${ranked}) ranked
      group by id
      order by score desc, id
      limit ${data.limit}
    )
    select ${docChunks.id} as id, ${docs.key} as key, ${docs.title} as title, ${docs.teamId} as team_id,
      ${docs.projectId} as project_id, ${docChunks.headingPath} as heading_path, ${docChunks.content} as content,
      ${docChunks.extractId} as extract_id, coalesce(a.repo_path, rf.repo_path) as repo_path
    from top join ${docChunks} on ${docChunks.id} = top.id
      left join hive.doc_extracts e on e.id = ${docChunks.extractId}
      left join hive.doc_assets a on a.id = e.asset_id
      join ${docs} on ${docs.id} = coalesce(${docChunks.docId}, a.owner_doc_id)
      left join hive.doc_repo_files rf on rf.doc_id = ${docChunks.docId}
    order by top.score desc, top.id`);
  const hits: DocSearchHit[] = rows
    .filter((r) => canRead(reader, { teamId: r.team_id, projectId: r.project_id }))
    .map((r) => ({
      key: r.key,
      title: r.title,
      headingPath: r.heading_path,
      snippet: snippetOf(r.content, data.query),
      repoPath: r.repo_path,
      extractId: r.extract_id,
    }));
  return { mode, hits };
}
