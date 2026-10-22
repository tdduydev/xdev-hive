import {
  type KnowledgeScope,
  type Memory,
  type MemoryListInput,
  type MemoryPinInput,
  type MemorySearchHit,
  type MemorySearchInput,
  type MemorySupersedeInput,
  type MemoryWriteInput,
  memoryListInput,
  memoryPinInput,
  memorySearchInput,
  memorySupersedeInput,
  memoryWriteInput,
} from "@xdev-hive/contracts";
import { and, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type pg from "pg";
import { loadPolicy } from "../governance/index.ts";
import { ConflictError, ForbiddenError, type Jobs, NotFoundError, type Tx, withTenant } from "../platform/index.ts";
import {
  audit,
  authorColumns,
  authorize,
  authorView,
  canRead,
  type Principal,
  projectContext,
  readerFor,
  resolveScope,
  type Scope,
  scopeView,
  visibleWhere,
} from "./access.ts";
import { type Embedder, vectorLiteral } from "./embedder.ts";
import { memories } from "./schema.ts";

export interface KnowledgeDeps {
  /** Không có thì chỉ tìm theo từ và không tạo embedding. */
  embedder?: Embedder | undefined;
  /** Hàng đợi để tạo embedding sau khi ghi, ngoài transaction của request. */
  jobs?: Jobs | undefined;
  /** Địa chỉ web của hub, để link trong thông báo của quy trình duyệt. */
  publicUrl?: string | undefined;
}

export const EMBED_QUEUE = "knowledge-embed";

/** Payload của job embedding. Chỉ mang id; job đọc lại nội dung trong tenant của tổ chức. */
export interface EmbedJob {
  orgId: string;
  memoryId: string;
}

export const embedQueue = {
  name: EMBED_QUEUE,
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 5 * 60,
} as const;

type MemoryRow = typeof memories.$inferSelect;

const notFound = () => new NotFoundError("MEMORY_NOT_FOUND", "Không tìm thấy memory.");

/**
 * Chuẩn hoá về NFC: macOS và một số bộ gõ gửi chữ có dấu ở dạng tách (NFD), Postgres so byte nên "kiến" NFD không
 * khớp "kiến" NFC. Nội dung và câu tìm cùng chuẩn thì tìm được bất kể nguồn.
 */
const nfc = (s: string) => s.normalize("NFC");

export function memoryView(m: MemoryRow): Memory {
  return {
    id: m.id,
    kind: m.kind,
    status: m.status === "pending" ? "pending" : "approved",
    content: m.content,
    files: m.files,
    scope: scopeView(m),
    author: authorView(m),
    createdAt: m.createdAt.toISOString(),
    supersededBy: m.supersededBy,
    pinned: m.pinned,
  };
}

/** Cột embedding chỉ có khi database cài pgvector (migration 0015). Hỏi catalog mỗi lần: rẻ, và đúng cả khi vừa bật. */
export async function hasVectors(tx: Tx): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`
    select exists (
      select 1 from pg_attribute
      where attrelid = 'hive.memories'::regclass and attname = 'embedding' and not attisdropped
    ) as ok`);
  return rows[0]?.ok === true;
}

const writeInput = memoryWriteInput.extend({
  /** Run bỏ trống thì ghi cho dự án của run. */
  scope: memoryWriteInput.shape.scope.optional(),
});
export type WriteMemoryInput = Omit<MemoryWriteInput, "scope"> & { scope?: KnowledgeScope | undefined };

async function insertMemory(
  tx: Tx,
  principal: Principal,
  scope: Scope,
  values: { kind: Memory["kind"]; content: string; files: string[]; status?: Memory["status"] },
  deps: KnowledgeDeps,
): Promise<MemoryRow> {
  const [row] = await tx
    .insert(memories)
    .values({
      orgId: sql`hive.ctx_org()`,
      teamId: scope.teamId,
      projectId: scope.projectId,
      kind: values.kind,
      content: nfc(values.content),
      files: values.files,
      status: values.status ?? "approved",
      ...authorColumns(principal),
    })
    .returning();
  if (!row) throw new Error("Không ghi được memory.");
  if (row.status !== "approved") return row;
  // Embedding tạo ở job, sau commit: không giữ transaction trong lúc gọi API ngoài, và API lỗi không làm mất memory.
  if (deps.embedder && deps.jobs && (await hasVectors(tx))) {
    await deps.jobs.enqueue<EmbedJob>(EMBED_QUEUE, { orgId: row.orgId, memoryId: row.id }, { tx });
  }
  return row;
}

/** Ghi memory. Hàm public cho MCP: run bỏ trống phạm vi thì ghi cho dự án của run. */
export async function writeMemory(
  tx: Tx,
  principal: Principal,
  input: WriteMemoryInput,
  deps: KnowledgeDeps = {},
): Promise<Memory> {
  const data = writeInput.parse(input);
  const reader = await readerFor(tx, principal);
  let scope: Scope;
  if (data.scope) scope = await resolveScope(tx, reader, data.scope);
  else if (reader.kind === "run") scope = { teamId: reader.teamId, projectId: reader.projectId };
  else throw new ConflictError("SCOPE_REQUIRED", "Cần chọn phạm vi cho memory (tổ chức, đội hoặc dự án).");
  await authorize(tx, reader, scope, "write");
  const status =
    principal.kind === "run"
      ? await agentWriteStatus(tx, principal.runId)
      : data.source === "machine"
        ? await machineWriteStatus(tx)
        : "approved";
  const { source, ...values } = data;
  const row = await insertMemory(tx, principal, scope, { ...values, status }, deps);
  await audit(tx, principal, "memory.write", { type: "memory", id: row.id }, { kind: row.kind, status, source });
  return memoryView(row);
}

/**
 * Memory đẩy lên từ máy người dùng là chữ agent ghi cục bộ, nên theo cùng chính sách với memory agent: tổ chức tắt thì
 * không nhận, còn lại luôn chờ người duyệt (kể cả khi chính sách cho agent tự duyệt, vì chưa ai đọc nội dung này).
 * Không tính giới hạn mỗi run: không có run, và người dùng tự chọn từng file để gửi.
 */
async function machineWriteStatus(tx: Tx): Promise<Memory["status"]> {
  const { agentMemory } = await loadPolicy(tx);
  if (agentMemory.mode === "off") {
    throw new ForbiddenError("AGENT_MEMORY_OFF", "Chính sách của tổ chức không cho agent ghi memory.");
  }
  return "pending";
}

/**
 * Memory agent ghi trong run theo chính sách tổ chức (ADR 0022): agent đọc lầm repo thì không được tự đưa điều sai
 * vào prompt của mọi run sau, nên mặc định chờ người duyệt; giới hạn mỗi run để agent không chép cả repo vào memory.
 */
async function agentWriteStatus(tx: Tx, runId: string): Promise<Memory["status"]> {
  const { agentMemory } = await loadPolicy(tx);
  if (agentMemory.mode === "off") {
    throw new ForbiddenError("AGENT_MEMORY_OFF", "Chính sách của tổ chức không cho agent ghi memory.");
  }
  // Khoá theo run để hai lệnh ghi song song của cùng run không cùng lọt qua giới hạn.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('memory-run'), hashtext(${runId}))`);
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memories)
    .where(eq(memories.authorRunId, runId));
  if ((row?.n ?? 0) >= agentMemory.maxPerRun) {
    throw new ConflictError(
      "AGENT_MEMORY_LIMIT",
      `Run đã ghi đủ ${agentMemory.maxPerRun} memory; chỉ ghi điều quan trọng nhất.`,
    );
  }
  return agentMemory.mode === "propose" ? "pending" : "approved";
}

/** Duyệt memory agent đề xuất: từ đây nó hiện khi tìm và có embedding. */
export async function approveMemory(
  tx: Tx,
  principal: Principal,
  id: string,
  deps: KnowledgeDeps = {},
): Promise<Memory> {
  const old = await pendingForDecision(tx, principal, id);
  const [row] = await tx.update(memories).set({ status: "approved" }).where(eq(memories.id, old.id)).returning();
  if (!row) throw notFound();
  if (deps.embedder && deps.jobs && (await hasVectors(tx))) {
    await deps.jobs.enqueue<EmbedJob>(EMBED_QUEUE, { orgId: row.orgId, memoryId: row.id }, { tx });
  }
  await audit(tx, principal, "memory.approve", { type: "memory", id: row.id }, { runId: row.authorRunId });
  return memoryView(row);
}

/** Bỏ đề xuất thì xoá hẳn: memory chưa từng hiện cho ai nên không cần giữ lịch sử như supersede. */
export async function rejectMemory(tx: Tx, principal: Principal, id: string): Promise<void> {
  const old = await pendingForDecision(tx, principal, id);
  await tx.delete(memories).where(eq(memories.id, old.id));
  await audit(tx, principal, "memory.reject", { type: "memory", id: old.id }, { runId: old.authorRunId });
}

async function pendingForDecision(tx: Tx, principal: Principal, id: string): Promise<MemoryRow> {
  const reader = await readerFor(tx, principal);
  // Khoá dòng: hai người cùng duyệt và bỏ một đề xuất thì người sau thấy nó đã được quyết.
  const [old] = await tx.select().from(memories).where(eq(memories.id, id)).for("update");
  if (!old || !canRead(reader, old)) throw notFound();
  await authorize(tx, reader, old, "write");
  if (old.status !== "pending") throw new ConflictError("MEMORY_DECIDED", "Memory này đã được duyệt hoặc bỏ.");
  return old;
}

export async function listMemories(tx: Tx, principal: Principal, input: MemoryListInput): Promise<Memory[]> {
  const data = memoryListInput.parse(input);
  const reader = await readerFor(tx, principal);
  const project = await projectContext(tx, reader, data.project);
  const rows = await tx
    .select()
    .from(memories)
    .where(
      and(
        visibleWhere(reader, memories, project),
        eq(memories.status, data.status),
        data.kind ? eq(memories.kind, data.kind) : undefined,
        data.includeSuperseded ? undefined : isNull(memories.supersededBy),
      ),
    )
    .orderBy(desc(memories.pinned), desc(memories.createdAt), desc(memories.id))
    .limit(data.limit)
    .offset(data.offset);
  return rows.map(memoryView);
}

/** Ghim hoặc bỏ ghim: quyền như duyệt memory (`write` ở phạm vi của memory). Chỉ memory đã duyệt và còn hiệu lực. */
export async function pinMemory(tx: Tx, principal: Principal, input: MemoryPinInput): Promise<Memory> {
  const data = memoryPinInput.parse(input);
  const reader = await readerFor(tx, principal);
  const [old] = await tx.select().from(memories).where(eq(memories.id, data.id)).for("update");
  if (old?.status !== "approved" || !canRead(reader, old)) throw notFound();
  await authorize(tx, reader, old, "write");
  if (old.supersededBy) throw new ConflictError("MEMORY_SUPERSEDED", "Memory này đã được thay bằng memory khác.");
  const [row] = await tx.update(memories).set({ pinned: data.pinned }).where(eq(memories.id, old.id)).returning();
  if (!row) throw notFound();
  await audit(tx, principal, "memory.pin", { type: "memory", id: row.id }, { pinned: row.pinned });
  return memoryView(row);
}

/** Thay memory cũ bằng nội dung mới cùng phạm vi; memory cũ giữ lại, trỏ sang memory mới và không hiện khi tìm. */
export async function supersedeMemory(
  tx: Tx,
  principal: Principal,
  input: MemorySupersedeInput,
  deps: KnowledgeDeps = {},
): Promise<Memory> {
  const data = memorySupersedeInput.parse(input);
  const reader = await readerFor(tx, principal);
  // Khoá dòng cũ: hai người cùng thay một memory thì người sau thấy nó đã bị thay, không tạo hai bản mới.
  const [old] = await tx.select().from(memories).where(eq(memories.id, data.id)).for("update");
  if (old?.status !== "approved" || !canRead(reader, old)) throw notFound();
  await authorize(tx, reader, old, "write");
  if (old.supersededBy) throw new ConflictError("MEMORY_SUPERSEDED", "Memory này đã được thay bằng memory khác.");
  const row = await insertMemory(
    tx,
    principal,
    old,
    { kind: data.kind ?? old.kind, content: data.content, files: data.files ?? old.files },
    deps,
  );
  await tx.update(memories).set({ supersededBy: row.id }).where(eq(memories.id, old.id));
  await audit(tx, principal, "memory.supersede", { type: "memory", id: old.id }, { by: row.id });
  return memoryView(row);
}

// ---------------------------------------------------------------------------------------------------------------
// Tìm kiếm

/** Số ứng viên lấy từ mỗi nguồn trước khi trộn; đủ rộng để kết quả tốt của một nguồn không bị cắt mất. */
const CANDIDATES = 50;
/** Hằng số của Reciprocal Rank Fusion, giá trị thường dùng trong tài liệu gốc (Cormack và cộng sự, 2009). */
const RRF_K = 60;

/**
 * Câu tìm thành tsquery dạng OR của từng từ, có so khớp tiền tố: agent hay hỏi bằng cả câu, AND mọi từ thì gần như
 * không ra gì; xếp hạng ts_rank_cd đẩy memory khớp nhiều từ lên trước. Chỉ giữ chữ và số nên không cần thoát ký tự
 * đặc biệt của tsquery.
 */
export function orQuery(query: string): string | null {
  const words =
    nfc(query)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const unique = [...new Set(words)].slice(0, 32);
  return unique.length ? unique.map((w) => `'${w}':*`).join(" | ") : null;
}

/** Embedding của câu tìm, hoặc null khi không có embedder hay API lỗi: tìm theo từ vẫn chạy. */
export async function embedQuery(embedder: Embedder | undefined, query: string): Promise<number[] | null> {
  if (!embedder) return null;
  try {
    const [v] = await embedder.embed([nfc(query)]);
    return v ?? null;
  } catch (error) {
    console.warn("Không tạo được embedding cho câu tìm, chỉ tìm theo từ:", (error as Error).message);
    return null;
  }
}

export interface SearchOptions extends KnowledgeDeps {
  /**
   * Embedding của câu tìm đã tính sẵn ngoài transaction (router làm vậy để không giữ kết nối khi gọi API).
   * Bỏ trống thì hàm tự gọi embedder nếu có.
   */
  queryEmbedding?: number[] | null | undefined;
}

/**
 * Tìm memory còn hiệu lực: full-text (tsvector 'simple') và, khi có embedding, vector similarity (pgvector, khoảng
 * cách cosine), trộn hai bảng xếp hạng bằng Reciprocal Rank Fusion. Hàm public cho MCP.
 */
export async function searchMemory(
  tx: Tx,
  principal: Principal,
  input: MemorySearchInput,
  opts: SearchOptions = {},
): Promise<MemorySearchHit[]> {
  const data = memorySearchInput.parse(input);
  const reader = await readerFor(tx, principal);
  const project = await projectContext(tx, reader, data.project);
  const where = and(
    visibleWhere(reader, memories, project),
    eq(memories.status, "approved"),
    isNull(memories.supersededBy),
  );

  const sources: SQL[] = [];
  const text = orQuery(data.query);
  if (text) {
    const q = sql`to_tsquery('simple', ${text})`;
    sources.push(sql`select ${memories.id} as id, 'text' as source,
        row_number() over (order by ts_rank_cd(${memories.search}, ${q}) desc, ${memories.createdAt} desc) as r
      from ${memories} where ${where} and ${memories.search} @@ ${q}
      order by r limit ${CANDIDATES}`);
  }
  const embedder = opts.embedder;
  if (embedder && (await hasVectors(tx))) {
    const v = opts.queryEmbedding === undefined ? await embedQuery(embedder, data.query) : opts.queryEmbedding;
    if (v) {
      const e = sql`${vectorLiteral(v)}::vector`;
      sources.push(sql`select ${memories.id} as id, 'vector' as source,
          row_number() over (order by embedding <=> ${e}) as r
        from ${memories}
        where ${where} and embedding is not null and ${memories.embeddingModel} = ${embedder.model}
        order by r limit ${CANDIDATES}`);
    }
  }
  if (sources.length === 0) return [];

  const ranked = sql.join(
    sources.map((s) => sql`(${s})`),
    sql` union all `,
  );
  const { rows } = await tx.execute<{ id: string; score: number; sources: string[] }>(sql`
    select id, sum(1.0 / (${RRF_K} + r))::float8 as score, array_agg(source order by source) as sources
    from (${ranked}) ranked
    group by id
    order by score desc, id
    limit ${data.limit}`);
  if (rows.length === 0) return [];
  const found = await tx
    .select()
    .from(memories)
    .where(
      inArray(
        memories.id,
        rows.map((r) => r.id),
      ),
    );
  const byId = new Map(found.map((m) => [m.id, m]));
  return rows.flatMap((r) => {
    const m = byId.get(r.id);
    if (!m) return [];
    return [{ ...memoryView(m), score: r.score, matchedBy: r.sources as Array<"text" | "vector"> }];
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Job tạo embedding

export interface EmbedDeps {
  /** Pool của hive_app. Job chạy với tenant là tổ chức trong payload, không có người dùng. */
  pool: pg.Pool;
  embedder: Embedder;
}

export type EmbedOutcome = "embedded" | "skipped";

/** Tạo embedding cho một memory. Gọi API ngoài giữa hai transaction ngắn, không giữ kết nối khi chờ mạng. */
export async function runEmbed(deps: EmbedDeps, job: EmbedJob, signal?: AbortSignal): Promise<EmbedOutcome> {
  const ctx = { orgId: job.orgId };
  const row = await withTenant(deps.pool, ctx, async (tx) => {
    if (!(await hasVectors(tx))) return null;
    const [m] = await tx
      .select({ content: memories.content, model: memories.embeddingModel })
      .from(memories)
      .where(and(eq(memories.id, job.memoryId), eq(memories.status, "approved")));
    return m ?? null;
  });
  // Memory đã xoá, hoặc đã có embedding của đúng mô hình (job chạy lại) thì thôi.
  if (!row || row.model === deps.embedder.model) return "skipped";
  const [v] = await deps.embedder.embed([row.content], signal);
  if (!v) return "skipped";
  await withTenant(deps.pool, ctx, (tx) =>
    tx.execute(sql`update ${memories}
      set embedding = ${vectorLiteral(v)}::vector, embedding_model = ${deps.embedder.model}
      where ${memories.id} = ${job.memoryId}`),
  );
  return "embedded";
}

export async function registerEmbedWorker(jobs: Jobs, deps: EmbedDeps): Promise<void> {
  await jobs.work<EmbedJob>(EMBED_QUEUE, async (job) => {
    await runEmbed(deps, job.data, job.signal);
  });
}
