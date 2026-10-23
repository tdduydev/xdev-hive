import {
  type ArtifactCreate,
  type ArtifactDetail,
  type ArtifactLink,
  type ArtifactLinkKind,
  type ArtifactListPage,
  type ArtifactListQuery,
  type ArtifactOrigin,
  type ArtifactScope,
  type ArtifactSettings,
  type ArtifactSummary,
  type ArtifactType,
  type ArtifactUpdate,
  type ArtifactUsage,
  type ArtifactWriteResult,
  artifactCreate,
  artifactListQuery,
  artifactUpdate,
  type OrgArtifactPolicy,
} from "@xdev-hive/contracts";
import { and, count, desc, eq, inArray, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import { findProject } from "../catalog/index.ts";
import { BadRequestError, ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { orgRoleOf, requireOrgRole } from "../tenancy/index.ts";
import {
  type ArtifactAction,
  accessView,
  artifactError,
  assertCan,
  audit,
  factsFor,
  manageableArtifactsWhere,
  type Reader,
  readerUserId,
  visibleArtifactsWhere,
} from "./access.ts";
import { isBlobType } from "./blob-types.ts";
import { allowedReactImports, compileReact, reactLibManifest } from "./compile.ts";
import { linkTargetOf } from "./hooks.ts";
import { artifactPolicyOf, settingsView } from "./limits.ts";
import { artifactLinks, artifactPublicLinks, artifacts, artifactVersions } from "./schema.ts";
import {
  type ArtifactDeps,
  type ArtifactRow,
  afterWrite,
  appendVersion,
  assertWritable,
  type BlobInput,
  type Compiled,
  checkContent,
  insertVersion,
  metaOf,
  reserve,
  revokePublicLinks,
  searchVector,
  userNames,
  versionRow,
  versionView,
} from "./versions.ts";

/*
 * Nghiệp vụ artifact (specs/012 T010): tạo, phiên bản, đổi tên, phạm vi, chủ, nhân bản, thùng rác, thư viện, liên kết,
 * dung lượng. Mọi hàm nhận `Reader` nên route (người) và tool MCP (run, T011) đi cùng một đường quyền.
 */

const TEAM_RANK = { viewer: 1, ba: 2, member: 3, admin: 4 } as const;

// ---- Biên dịch `react` ---------------------------------------------------------------------------------------------

/**
 * Điểm gọi biên dịch `react` (plan.md D8), chạy trước khi giữ khoá dung lượng. Lỗi cú pháp lưu cùng phiên bản; import
 * ngoài bộ đóng gói thì không lưu và trả tên module để agent sửa ngay trong lời gọi đó.
 */
export async function compileFor(type: ArtifactType, content: string): Promise<Compiled> {
  if (type !== "react") return { compiled: null, compileError: null };
  const manifest = reactLibManifest();
  const result = await compileReact(content, manifest);
  if ("importNotAllowed" in result) {
    throw artifactError(
      "ARTIFACT_IMPORT_NOT_ALLOWED",
      `Import không có trong bộ thư viện đóng gói của hub: ${result.importNotAllowed.join(", ")}. Chỉ dùng được: ${[
        ...allowedReactImports(manifest),
      ].join(", ")}.`,
      { imports: result.importNotAllowed },
    );
  }
  return result;
}

// ---- Dạng trả về ---------------------------------------------------------------------------------------------------

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function summaries(tx: Tx, rows: ArtifactRow[]): Promise<ArtifactSummary[]> {
  const names = await userNames(
    tx,
    rows.map((r) => r.ownerUserId),
  );
  const projects = new Map<string, { id: string; key: string; name: string } | null>();
  for (const id of new Set(rows.map((r) => r.projectId).filter((p): p is string => !!p))) {
    const p = await findProject(tx, id);
    projects.set(id, p ? { id: p.id, key: p.key, name: p.name } : null);
  }
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    language: r.language,
    scope: r.scope,
    teamId: r.teamId,
    project: r.projectId ? (projects.get(r.projectId) ?? null) : null,
    originProjectId: r.originProjectId,
    owner: { id: r.ownerUserId, name: names.get(r.ownerUserId) ?? r.ownerUserId },
    origin: r.origin,
    latestVersion: r.latestVersion,
    sizeBytes: r.sizeBytes,
    duplicatedFrom:
      r.duplicatedFromId && r.duplicatedFromVersion
        ? { id: r.duplicatedFromId, version: r.duplicatedFromVersion }
        : null,
    deletedAt: iso(r.deletedAt),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function summary(tx: Tx, row: ArtifactRow): Promise<ArtifactSummary> {
  const [out] = await summaries(tx, [row]);
  if (!out) throw new Error("Không dựng được artifact.");
  return out;
}

async function writeResult(
  tx: Tx,
  artifact: ArtifactRow,
  version: Awaited<ReturnType<typeof insertVersion>>,
): Promise<ArtifactWriteResult> {
  return {
    artifact: await summary(tx, artifact),
    version: await metaOf(tx, version),
    compileError: version.compileError,
  };
}

// ---- Đọc -----------------------------------------------------------------------------------------------------------

export async function getSettings(tx: Tx): Promise<ArtifactSettings> {
  return settingsView(await artifactPolicyOf(tx));
}

interface LoadOptions {
  /** Khoá dòng cho thao tác đổi artifact. */
  lock?: boolean;
  /** Quyền cần có; mặc định đọc. */
  action?: ArtifactAction;
}

/** Artifact người gọi có quyền `action`; trong thùng rác thì chỉ người khôi phục được mới thấy. */
export async function artifactFor(tx: Tx, reader: Reader, id: string, opts: LoadOptions = {}): Promise<ArtifactRow> {
  const q = tx.select().from(artifacts).where(eq(artifacts.id, id));
  const [row] = opts.lock ? await q.for("update") : await q;
  if (!row) throw artifactError("ARTIFACT_NOT_FOUND");
  await assertCan(tx, reader, row, row.deletedAt ? "manage" : (opts.action ?? "read"));
  return row;
}

async function liveArtifact(tx: Tx, reader: Reader, id: string, opts: LoadOptions = {}): Promise<ArtifactRow> {
  const row = await artifactFor(tx, reader, id, opts);
  if (row.deletedAt) throw artifactError("ARTIFACT_NOT_FOUND", "Artifact đang ở thùng rác. Khôi phục trước khi sửa.");
  return row;
}

export async function getArtifact(tx: Tx, reader: Reader, input: { id: string; version?: number | undefined }) {
  const row = await artifactFor(tx, reader, input.id);
  const v = await versionRow(tx, row.id, input.version ?? row.latestVersion);
  if (!v) throw artifactError("ARTIFACT_NOT_FOUND", "Không tìm thấy phiên bản này.");
  const facts = await factsFor(tx, reader, row);
  const names = await userNames(tx, [v.authorUserId]);
  return {
    artifact: await summary(tx, row),
    version: versionView(v, names),
    access: accessView(reader, facts),
  } satisfies ArtifactDetail;
}

/** Con trỏ giữ `updated_at` dạng chữ của Postgres (độ chính xác micro giây) và id, để trang sau không sót hay lặp. */
const encodeCursor = (at: string, id: string) => Buffer.from(JSON.stringify([at, id])).toString("base64url");
function decodeCursor(cursor: string): [string, string] | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string"
      ? [value[0], value[1]]
      : null;
  } catch {
    return null;
  }
}

const linkedTo = (kind: ArtifactLinkKind, targetId: string) =>
  sql`exists (select 1 from ${artifactLinks} where ${and(
    eq(artifactLinks.artifactId, artifacts.id),
    eq(artifactLinks.targetKind, kind),
    eq(artifactLinks.targetId, targetId),
  )})`;

/** Thư viện (SC-005): lọc theo quyền, bộ lọc, tìm chữ; mới sửa trước, phân trang bằng con trỏ. */
export async function listArtifacts(tx: Tx, reader: Reader, raw: ArtifactListQuery): Promise<ArtifactListPage> {
  const input = artifactListQuery.parse(raw);
  const where: (SQL | undefined)[] = [visibleArtifactsWhere(reader)];
  if (input.trash) where.push(isNotNull(artifacts.deletedAt), manageableArtifactsWhere(reader));
  else where.push(isNull(artifacts.deletedAt));
  if (input.scope) where.push(eq(artifacts.scope, input.scope));
  if (input.type) where.push(eq(artifacts.type, input.type));
  if (input.origin) where.push(eq(artifacts.origin, input.origin));
  if (input.mine) {
    const me = readerUserId(reader);
    where.push(me ? eq(artifacts.ownerUserId, me) : sql`false`);
  }
  if (input.projectKey) {
    const project = await findProject(tx, input.projectKey);
    where.push(
      project ? or(eq(artifacts.projectId, project.id), eq(artifacts.originProjectId, project.id)) : sql`false`,
    );
  }
  if (input.threadId) where.push(linkedTo("chat_thread", input.threadId));
  if (input.terminalSessionId) where.push(linkedTo("terminal_session", input.terminalSessionId));
  if (input.runId) where.push(linkedTo("run", input.runId));
  if (input.taskId) where.push(linkedTo("task", input.taskId));
  if (input.sdlcItemId) where.push(linkedTo("sdlc_item", input.sdlcItemId));
  if (input.docId) where.push(linkedTo("doc", input.docId));
  if (input.query) {
    const pattern = `%${input.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      or(
        sql`${artifacts.search} @@ websearch_to_tsquery('simple', ${input.query})`,
        sql`${artifacts.title} ilike ${pattern}`,
      ),
    );
  }
  if (input.cursor) {
    const at = decodeCursor(input.cursor);
    if (at) where.push(sql`(${artifacts.updatedAt}, ${artifacts.id}) < (${at[0]}::timestamptz, ${at[1]}::uuid)`);
  }
  const rows = await tx
    .select({ row: artifacts, at: sql<string>`${artifacts.updatedAt}::text` })
    .from(artifacts)
    .where(and(...where))
    .orderBy(desc(artifacts.updatedAt), desc(artifacts.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: await summaries(
      tx,
      page.map((r) => r.row),
    ),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.at, last.row.id) : null,
  };
}

// ---- Phạm vi -------------------------------------------------------------------------------------------------------

interface ResolvedScope {
  scope: ArtifactScope;
  teamId: string | null;
  projectId: string | null;
}

/**
 * Phạm vi đích của tạo/đổi phạm vi: bật trong chính sách (FR-024), và người gọi là `member` trở lên ở đội của phạm vi
 * (FR-021). Run chỉ có `private` của người nó làm thay hoặc `project` của dự án run (FR-032).
 */
async function resolveScope(
  tx: Tx,
  reader: Reader,
  policy: OrgArtifactPolicy,
  input: { scope?: ArtifactScope | undefined; projectKey?: string | undefined; teamId?: string | undefined },
): Promise<ResolvedScope> {
  const scope = input.scope ?? "private";
  if (!policy.scopes.includes(scope)) throw artifactError("ARTIFACT_SCOPE_DISABLED");
  if (scope === "private") return { scope, teamId: null, projectId: null };
  if (reader.kind === "run") {
    const project = input.projectKey ? await findProject(tx, input.projectKey) : null;
    if (scope !== "project" || (project && project.id !== reader.projectId))
      throw new ForbiddenError("RUN_NOT_ALLOWED", "Agent chỉ tạo artifact riêng hoặc trong dự án của run.");
    return { scope, teamId: reader.teamId, projectId: reader.projectId };
  }
  if (scope === "org") return { scope, teamId: null, projectId: null };
  let teamId: string;
  let projectId: string | null = null;
  if (scope === "project") {
    const project = input.projectKey ? await findProject(tx, input.projectKey) : null;
    if (!project || !reader.teams.has(project.teamId))
      throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
    teamId = project.teamId;
    projectId = project.id;
  } else {
    if (!input.teamId || !reader.teams.has(input.teamId))
      throw new NotFoundError("TEAM_NOT_FOUND", "Không tìm thấy đội trong tổ chức.");
    teamId = input.teamId;
  }
  const role = reader.teams.get(teamId);
  if (!role || TEAM_RANK[role] < TEAM_RANK.member)
    throw new ForbiddenError("TEAM_ROLE_REQUIRED", "Cần vai trò thành viên của đội trở lên để chia sẻ artifact.");
  return { scope, teamId, projectId };
}

// ---- Tạo và phiên bản ----------------------------------------------------------------------------------------------

export interface CreateOptions extends ArtifactDeps {
  /** Mặc định `manual` cho người, `leader`/`run` cho run. */
  origin?: ArtifactOrigin | undefined;
  /** Dự án của chat/run sinh ra artifact (chỉ gợi ý chia sẻ, D2). */
  originProjectId?: string | null | undefined;
  /** Chủ của artifact khi run tạo `private` cho người mở cuộc trò chuyện (khác người run làm thay). */
  ownerUserId?: string | undefined;
  /** Ảnh/PDF đã lưu vào `BlobStore` (T062); `content` của đầu vào bỏ qua. */
  blob?: BlobInput | undefined;
}

const defaultOrigin = (reader: Reader): ArtifactOrigin =>
  reader.kind === "user" ? "manual" : reader.runKind === "leader" ? "leader" : "run";

/** Bản gốc của "Nhân bản": người gọi đọc được và phiên bản còn nội dung. */
async function sourceVersion(tx: Tx, reader: Reader, ref: { id: string; version?: number | undefined }) {
  const source = await liveArtifact(tx, reader, ref.id);
  const v = await versionRow(tx, source.id, ref.version ?? source.latestVersion);
  if (!v) throw artifactError("ARTIFACT_NOT_FOUND", "Không tìm thấy phiên bản này.");
  if (v.content === null && !v.blobId)
    throw artifactError("ARTIFACT_NOT_FOUND", "Phiên bản này đã bị xoá nội dung, không nhân bản được.");
  return { source, v };
}

export async function createArtifact(
  tx: Tx,
  reader: Reader,
  raw: ArtifactCreate,
  opts: CreateOptions = {},
): Promise<ArtifactWriteResult> {
  const input = artifactCreate.parse(raw);
  const policy = await artifactPolicyOf(tx);
  assertWritable(policy, input.type);
  const owner = opts.ownerUserId ?? readerUserId(reader);
  if (!owner) throw new ForbiddenError("RUN_NOT_ALLOWED", "Run không có người dùng để làm chủ artifact.");
  const scope = await resolveScope(tx, reader, policy, input);
  const duplicated = input.duplicateOf ? await sourceVersion(tx, reader, input.duplicateOf) : null;
  if (isBlobType(input.type) !== !!opts.blob)
    throw artifactError("ARTIFACT_TYPE_DISABLED", "Ảnh và PDF chỉ tạo bằng cách tải tệp lên.");
  const compiled = await compileFor(input.type, input.content);
  const bytes = opts.blob
    ? opts.blob.size
    : checkContent(policy, input.type, { content: input.content, compiled }, null);
  const used = await reserve(tx, reader, policy, bytes, { newArtifact: true });
  const origin = opts.origin ?? defaultOrigin(reader);
  const [artifact] = await tx
    .insert(artifacts)
    .values({
      orgId: sql`hive.ctx_org()`,
      ...scope,
      originProjectId: opts.originProjectId ?? (reader.kind === "run" ? reader.projectId : null),
      ownerUserId: owner,
      title: input.title,
      type: input.type,
      language: input.type === "code" ? (input.language ?? null) : null,
      origin,
      latestVersion: 1,
      duplicatedFromId: duplicated?.source.id ?? null,
      duplicatedFromVersion: duplicated?.v.version ?? null,
      sizeBytes: bytes,
      search: searchVector(input.title, opts.blob ? null : input.content),
    })
    .returning();
  if (!artifact) throw new Error("Không tạo được artifact.");
  await audit(tx, reader, "artifact.create", artifact.id, {
    type: artifact.type,
    scope: artifact.scope,
    projectId: artifact.projectId,
    origin,
    ...(duplicated ? { duplicatedFrom: { id: duplicated.source.id, version: duplicated.v.version } } : {}),
  });
  const version = await insertVersion(tx, reader, artifact, 1, {
    content: input.content,
    blob: opts.blob,
    compiled,
    origin,
    message: input.message,
  });
  // Run sửa được artifact chính nó tạo nhờ liên kết này (FR-032); liên kết task/cuộc trò chuyện do tool MCP thêm.
  if (reader.kind === "run") await linkInternal(tx, reader, artifact, { kind: "run", id: reader.runId });
  await afterWrite(tx, policy, used, bytes, artifact.orgId, opts);
  return writeResult(tx, artifact, version);
}

export async function updateArtifact(
  tx: Tx,
  reader: Reader,
  raw: ArtifactUpdate,
  opts: ArtifactDeps & { origin?: ArtifactOrigin | undefined } = {},
): Promise<ArtifactWriteResult> {
  const input = artifactUpdate.parse(raw);
  const policy = await artifactPolicyOf(tx);
  const current = await liveArtifact(tx, reader, input.id, { action: "write" });
  if (isBlobType(current.type))
    throw artifactError("ARTIFACT_TYPE_DISABLED", "Ảnh và PDF chỉ thay bằng cách tải tệp mới lên.");
  const compiled = await compileFor(current.type, input.content);
  checkContent(policy, current.type, { content: input.content, compiled }, current.id);
  const { artifact, version } = await appendVersion(
    tx,
    reader,
    policy,
    current.id,
    {
      content: input.content,
      compiled,
      origin: opts.origin ?? defaultOrigin(reader),
      message: input.message,
      baseVersion: input.baseVersion,
      title: input.title,
    },
    opts,
  );
  return writeResult(tx, artifact, version);
}

/** Thay ảnh/PDF bằng tệp mới: phiên bản mới trỏ vào blob khác, bản cũ vẫn còn trong lịch sử. */
export async function replaceBlob(
  tx: Tx,
  reader: Reader,
  input: {
    id: string;
    type: ArtifactType;
    blob: BlobInput;
    baseVersion?: number | undefined;
    title?: string | undefined;
    message?: string | undefined;
  },
  opts: ArtifactDeps = {},
): Promise<ArtifactWriteResult> {
  const policy = await artifactPolicyOf(tx);
  const current = await liveArtifact(tx, reader, input.id, { action: "write" });
  if (!isBlobType(current.type))
    throw artifactError("ARTIFACT_TYPE_DISABLED", "Chỉ ảnh và PDF mới thay bằng tệp tải lên.");
  if (current.type !== input.type)
    throw new BadRequestError(
      "ARTIFACT_BLOB_TYPE",
      "Tệp mới phải cùng loại với artifact (ảnh thay ảnh, PDF thay PDF).",
    );
  assertWritable(policy, current.type);
  const { artifact, version } = await appendVersion(
    tx,
    reader,
    policy,
    current.id,
    {
      content: "",
      blob: input.blob,
      compiled: { compiled: null, compileError: null },
      origin: defaultOrigin(reader),
      message: input.message,
      baseVersion: input.baseVersion,
      title: input.title,
    },
    opts,
  );
  return writeResult(tx, artifact, version);
}

/** Khôi phục = phiên bản mới mang nội dung bản cũ và `restoredFrom` (FR-006); bản ở giữa vẫn còn. */
export async function restoreVersion(
  tx: Tx,
  reader: Reader,
  input: { id: string; version: number; baseVersion?: number | undefined },
  opts: ArtifactDeps = {},
): Promise<ArtifactWriteResult> {
  const policy = await artifactPolicyOf(tx);
  const current = await liveArtifact(tx, reader, input.id, { action: "write" });
  const old = await versionRow(tx, current.id, input.version);
  if (!old) throw artifactError("ARTIFACT_NOT_FOUND", "Không tìm thấy phiên bản này.");
  if (old.content === null && !old.blobId)
    throw artifactError("ARTIFACT_NOT_FOUND", "Phiên bản này đã bị xoá nội dung, không khôi phục được.");
  // Ảnh/PDF khôi phục bằng cách trỏ phiên bản mới vào cùng tệp; không có chữ để biên dịch hay quét bí mật.
  const blob = old.blobId ? { id: old.blobId, sha256: old.sha256, size: old.sizeBytes } : undefined;
  const content = old.content ?? "";
  const compiled = blob ? { compiled: null, compileError: null } : await compileFor(current.type, content);
  if (!blob) checkContent(policy, current.type, { content, compiled }, current.id);
  const { artifact, version } = await appendVersion(
    tx,
    reader,
    policy,
    current.id,
    {
      content,
      blob,
      compiled,
      origin: defaultOrigin(reader),
      message: `Khôi phục từ phiên bản ${old.version}`,
      restoredFrom: old.version,
      baseVersion: input.baseVersion,
    },
    opts,
  );
  return writeResult(tx, artifact, version);
}

/** Nhân bản thành artifact `private` của người gọi, ghi "Nhân bản từ …" (US9-5). */
export async function duplicateArtifact(
  tx: Tx,
  reader: Reader,
  input: { id: string; version?: number | undefined; title?: string | undefined },
  opts: CreateOptions = {},
): Promise<ArtifactWriteResult> {
  const { source, v } = await sourceVersion(tx, reader, input);
  return createArtifact(
    tx,
    reader,
    {
      type: source.type,
      title: input.title ?? source.title,
      content: v.content ?? "",
      ...(source.language ? { language: source.language } : {}),
      scope: "private",
      duplicateOf: { id: source.id, version: v.version },
    },
    {
      ...opts,
      blob: v.blobId ? { id: v.blobId, sha256: v.sha256, size: v.sizeBytes } : undefined,
      origin: opts.origin ?? defaultOrigin(reader),
      originProjectId: opts.originProjectId ?? source.originProjectId,
    },
  );
}

// ---- Đổi thuộc tính ------------------------------------------------------------------------------------------------

/** Đổi tiêu đề không tạo phiên bản (FR-004); chỉ mục tìm dựng lại với nội dung bản mới nhất. */
export async function renameArtifact(
  tx: Tx,
  reader: Reader,
  input: { id: string; title: string },
): Promise<ArtifactSummary> {
  const row = await liveArtifact(tx, reader, input.id, { lock: true, action: "write" });
  if (row.title === input.title) return summary(tx, row);
  const latest = sql`(select ${artifactVersions.content} from ${artifactVersions} where ${and(
    eq(artifactVersions.artifactId, row.id),
    eq(artifactVersions.version, row.latestVersion),
  )})`;
  const [after] = await tx
    .update(artifacts)
    .set({
      title: input.title,
      search: sql`${searchVector(input.title, null)} || to_tsvector('simple', left(coalesce(${latest}, ''), 200000))`,
      updatedAt: sql`now()`,
    })
    .where(eq(artifacts.id, row.id))
    .returning();
  if (!after) throw artifactError("ARTIFACT_NOT_FOUND");
  await audit(tx, reader, "artifact.rename", row.id, {});
  return summary(tx, after);
}

export async function setScope(
  tx: Tx,
  reader: Reader,
  input: { id: string; scope: ArtifactScope; projectKey?: string | undefined; teamId?: string | undefined },
): Promise<ArtifactSummary> {
  const row = await liveArtifact(tx, reader, input.id, { lock: true, action: "manage" });
  const next = await resolveScope(tx, reader, await artifactPolicyOf(tx), input);
  if (next.scope === row.scope && next.teamId === row.teamId && next.projectId === row.projectId)
    return summary(tx, row);
  const [after] = await tx
    .update(artifacts)
    .set({ ...next, updatedAt: sql`now()` })
    .where(eq(artifacts.id, row.id))
    .returning();
  if (!after) throw artifactError("ARTIFACT_NOT_FOUND");
  await audit(tx, reader, "artifact.scope.change", row.id, {
    from: { scope: row.scope, teamId: row.teamId, projectId: row.projectId },
    to: next,
  });
  return summary(tx, after);
}

/** Chuyển chủ: người nhận phải đang là thành viên tổ chức; mọi link công khai bị thu hồi (C17: link gắn với chủ). */
export async function transferOwner(
  tx: Tx,
  reader: Reader,
  input: { id: string; userId: string },
  deps: ArtifactDeps = {},
): Promise<ArtifactSummary> {
  const row = await liveArtifact(tx, reader, input.id, { lock: true, action: "manage" });
  if (row.ownerUserId === input.userId) return summary(tx, row);
  if (!(await orgRoleOf(tx, input.userId)))
    throw new NotFoundError("MEMBER_NOT_FOUND", "Người nhận không phải thành viên của tổ chức.");
  const [after] = await tx
    .update(artifacts)
    .set({ ownerUserId: input.userId, updatedAt: sql`now()` })
    .where(eq(artifacts.id, row.id))
    .returning();
  if (!after) throw artifactError("ARTIFACT_NOT_FOUND");
  const revoked = await revokePublicLinks(
    tx,
    reader,
    row,
    eq(artifactPublicLinks.artifactId, row.id),
    "owner_changed",
    deps,
  );
  await audit(tx, reader, "artifact.owner.change", row.id, {
    from: row.ownerUserId,
    to: input.userId,
    revokedLinks: revoked,
  });
  return summary(tx, after);
}

/** Xoá mềm vào thùng rác 30 ngày (job purge xoá hẳn); link công khai bị thu hồi ngay. */
export async function deleteArtifact(
  tx: Tx,
  reader: Reader,
  input: { id: string },
  deps: ArtifactDeps = {},
): Promise<ArtifactSummary> {
  const row = await liveArtifact(tx, reader, input.id, { lock: true, action: "manage" });
  const [after] = await tx
    .update(artifacts)
    .set({ deletedAt: sql`now()`, deletedBy: readerUserId(reader) })
    .where(eq(artifacts.id, row.id))
    .returning();
  if (!after) throw artifactError("ARTIFACT_NOT_FOUND");
  const revoked = await revokePublicLinks(tx, reader, row, eq(artifactPublicLinks.artifactId, row.id), "deleted", deps);
  await audit(tx, reader, "artifact.delete", row.id, { revokedLinks: revoked });
  return summary(tx, after);
}

/** Khôi phục từ thùng rác. Link công khai đã thu hồi không sống lại: chủ tạo link mới nếu muốn. */
export async function restoreArtifact(tx: Tx, reader: Reader, input: { id: string }): Promise<ArtifactSummary> {
  const row = await artifactFor(tx, reader, input.id, { lock: true, action: "manage" });
  if (!row.deletedAt) return summary(tx, row);
  const [after] = await tx
    .update(artifacts)
    .set({ deletedAt: null, deletedBy: null, updatedAt: sql`now()` })
    .where(eq(artifacts.id, row.id))
    .returning();
  if (!after) throw artifactError("ARTIFACT_NOT_FOUND");
  await audit(tx, reader, "artifact.restore", row.id, {});
  return summary(tx, after);
}

// ---- Liên kết ------------------------------------------------------------------------------------------------------

/** Đích riêng của một người: gắn artifact `private` vào được, không đòi phạm vi rộng. */
const PERSONAL_TARGETS: readonly ArtifactLinkKind[] = ["chat_thread", "terminal_session"];

type LinkRow = typeof artifactLinks.$inferSelect;

async function linkViews(tx: Tx, reader: Reader, rows: LinkRow[]): Promise<ArtifactLink[]> {
  const titles = new Map<string, string>();
  for (const kind of new Set(rows.map((r) => r.targetKind))) {
    const target = linkTargetOf(kind);
    if (!target?.titles) continue;
    const ids = rows.filter((r) => r.targetKind === kind).map((r) => r.targetId);
    for (const [id, title] of await target.titles(tx, reader, ids)) titles.set(`${kind}:${id}`, title);
  }
  return rows.map((r) => ({
    targetKind: r.targetKind,
    targetId: r.targetId,
    title: titles.get(`${r.targetKind}:${r.targetId}`) ?? null,
    createdByUserId: r.createdByUserId,
    createdByRunId: r.createdByRunId,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function listLinks(tx: Tx, reader: Reader, input: { id: string }): Promise<ArtifactLink[]> {
  const row = await artifactFor(tx, reader, input.id);
  const rows = await tx
    .select()
    .from(artifactLinks)
    .where(eq(artifactLinks.artifactId, row.id))
    .orderBy(desc(artifactLinks.createdAt));
  return linkViews(tx, reader, rows);
}

/**
 * Gắn do hub tự tạo (run, task, cuộc trò chuyện, phiên terminal của principal; D11): nơi gọi đã kiểm đích. Gắn trùng
 * thì bỏ qua.
 */
export async function linkInternal(
  tx: Tx,
  reader: Reader,
  artifact: { id: string; orgId: string },
  target: { kind: ArtifactLinkKind; id: string },
): Promise<void> {
  await tx
    .insert(artifactLinks)
    .values({
      orgId: artifact.orgId,
      artifactId: artifact.id,
      targetKind: target.kind,
      targetId: target.id,
      createdByUserId: reader.kind === "user" ? reader.userId : null,
      createdByRunId: reader.kind === "run" ? reader.runId : null,
    })
    .onConflictDoNothing();
}

/** Phạm vi đủ rộng cho đích dùng chung (US10-1): đích của dự án P cần artifact của P, của đội P, hay của tổ chức. */
async function assertWideEnough(tx: Tx, row: ArtifactRow, kind: ArtifactLinkKind, projectId: string | null) {
  if (PERSONAL_TARGETS.includes(kind) || projectId === null || row.scope === "org") return;
  if (row.scope === "project" && row.projectId === projectId) return;
  if (row.scope === "team" && row.teamId === (await findProject(tx, projectId))?.teamId) return;
  throw artifactError("ARTIFACT_SCOPE_TOO_NARROW");
}

export async function addLink(
  tx: Tx,
  reader: Reader,
  input: { id: string; targetKind: ArtifactLinkKind; targetId: string },
): Promise<ArtifactLink> {
  const row = await liveArtifact(tx, reader, input.id);
  const target = linkTargetOf(input.targetKind);
  if (!target) throw artifactError("ARTIFACT_LINK_FORBIDDEN");
  await target.assertWritable(tx, reader, input.targetId);
  await assertWideEnough(tx, row, input.targetKind, await target.projectOf(tx, input.targetId));
  await linkInternal(tx, reader, row, { kind: input.targetKind, id: input.targetId });
  await audit(tx, reader, "artifact.link.add", row.id, { targetKind: input.targetKind, targetId: input.targetId });
  const [link] = await tx
    .select()
    .from(artifactLinks)
    .where(
      and(
        eq(artifactLinks.artifactId, row.id),
        eq(artifactLinks.targetKind, input.targetKind),
        eq(artifactLinks.targetId, input.targetId),
      ),
    );
  if (!link) throw artifactError("ARTIFACT_LINK_FORBIDDEN");
  const [view] = await linkViews(tx, reader, [link]);
  if (!view) throw artifactError("ARTIFACT_LINK_FORBIDDEN");
  return view;
}

/** Bỏ gắn cần quyền sửa đích như khi gắn; loại đích chưa có module cài thì cần quyền quản trị artifact. */
export async function removeLink(
  tx: Tx,
  reader: Reader,
  input: { id: string; targetKind: ArtifactLinkKind; targetId: string },
): Promise<{ removed: boolean }> {
  const target = linkTargetOf(input.targetKind);
  const row = await artifactFor(tx, reader, input.id, { action: target ? "read" : "manage" });
  if (target) await target.assertWritable(tx, reader, input.targetId);
  const removed = await tx
    .delete(artifactLinks)
    .where(
      and(
        eq(artifactLinks.artifactId, row.id),
        eq(artifactLinks.targetKind, input.targetKind),
        eq(artifactLinks.targetId, input.targetId),
      ),
    )
    .returning({ id: artifactLinks.artifactId });
  if (removed.length > 0)
    await audit(tx, reader, "artifact.link.remove", row.id, {
      targetKind: input.targetKind,
      targetId: input.targetId,
    });
  return { removed: removed.length > 0 };
}

// ---- Dung lượng ----------------------------------------------------------------------------------------------------

/** Dung lượng theo dự án và chủ cho quản trị tổ chức: chỉ số liệu, không nội dung (C5). */
export async function usage(tx: Tx, userId: string): Promise<ArtifactUsage> {
  await requireOrgRole(tx, userId, "admin");
  const policy = await artifactPolicyOf(tx);
  const bytes = sql<string>`coalesce(sum(${artifacts.sizeBytes}), 0)`;
  const [total] = await tx.select({ bytes, n: count() }).from(artifacts);
  const byProject = await tx
    .select({ projectId: artifacts.projectId, bytes, n: count() })
    .from(artifacts)
    .where(isNotNull(artifacts.projectId))
    .groupBy(artifacts.projectId)
    .orderBy(desc(bytes));
  const byUser = await tx
    .select({ userId: artifacts.ownerUserId, bytes, n: count() })
    .from(artifacts)
    .groupBy(artifacts.ownerUserId)
    .orderBy(desc(bytes));
  const names = await userNames(
    tx,
    byUser.map((u) => u.userId),
  );
  const projects = [];
  for (const p of byProject) {
    const project = p.projectId ? await findProject(tx, p.projectId) : null;
    if (project)
      projects.push({
        project: { id: project.id, key: project.key, name: project.name },
        bytes: Number(p.bytes),
        artifacts: p.n,
      });
  }
  return {
    usedBytes: Number(total?.bytes ?? 0),
    quotaBytes: policy.orgQuotaBytes,
    artifacts: total?.n ?? 0,
    byProject: projects,
    byUser: byUser.map((u) => ({
      user: { id: u.userId, name: names.get(u.userId) ?? u.userId },
      bytes: Number(u.bytes),
      artifacts: u.n,
    })),
  };
}

/** Artifact còn sống trong danh sách id mà người gọi đọc được (thẻ trong chat, trang task…), theo id. */
export async function visibleSummaries(tx: Tx, reader: Reader, ids: string[]): Promise<Map<string, ArtifactSummary>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(artifacts)
    .where(and(inArray(artifacts.id, [...new Set(ids)]), isNull(artifacts.deletedAt), visibleArtifactsWhere(reader)));
  return new Map((await summaries(tx, rows)).map((s) => [s.id, s]));
}
