import { randomUUID } from "node:crypto";
import { docKey, skillName } from "@xdev-hive/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { findProject } from "../catalog/index.ts";
import { withTenant } from "../platform/index.ts";
import { findOrgUserByEmail, findSystemBySlug, resolveLegacyImportOrg, teams } from "../tenancy/index.ts";
import type { Scope } from "./access.ts";
import { type LegacyRow, readLegacySource } from "./legacy-source.ts";
import { EMBED_QUEUE, type EmbedJob, hasVectors, type KnowledgeDeps } from "./memory.ts";
import { docs, docVersions, legacyDocAssets, legacyImports, memories, skills, skillVersions } from "./schema.ts";

export interface LegacyImportOptions {
  db: string;
  org: string;
  projectMap?: ReadonlyMap<string, string>;
  dryRun?: boolean;
}
export interface ImportCount {
  added: number;
  skipped: number;
  errors: number;
  reasons: Record<string, number>;
}
export type ImportReport = Record<"memory" | "doc" | "docVersion" | "skill" | "skillVersion" | "asset", ImportCount>;
type Kind = "memory" | "doc" | "skill" | "asset";
type ImportRow = typeof legacyImports.$inferSelect;

class ImportIssue extends Error {}
function fail(message: string): never {
  throw new ImportIssue(message);
}
const text = (v: unknown): string => (typeof v === "string" ? v : fail("Giá trị chữ không hợp lệ."));
const date = (v: unknown): Date => {
  const d = new Date(text(v));
  if (!Number.isFinite(d.getTime())) fail("Thời điểm không hợp lệ.");
  return d;
};
const positiveInt = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) fail("Số phiên bản không hợp lệ.");
  return v;
};
const sourceKey = (kind: Kind, id: string) => JSON.stringify([kind, id]);
const count = (): ImportCount => ({ added: 0, skipped: 0, errors: 0, reasons: {} });
const increment = (counter: ImportCount, status: "added" | "skipped" | "errors", n = 1, reason?: string) => {
  counter[status] += n;
  if (reason) counter.reasons[reason] = (counter.reasons[reason] ?? 0) + n;
};

/** Mỗi tổ chức nhận một snapshot hub cũ. Chạy lại chỉ bỏ qua nguồn đã chuyển, không ghi đè chỉnh sửa ở hub mới. */
export async function importLegacy(
  pool: pg.Pool,
  options: LegacyImportOptions,
  deps: KnowledgeDeps = {},
): Promise<ImportReport> {
  const source = readLegacySource(options.db);
  const report: ImportReport = {
    memory: count(),
    doc: count(),
    docVersion: count(),
    skill: count(),
    skillVersion: count(),
    asset: count(),
  };
  // Chặn nhầm URL owner/superuser trước khi giải slug hay đọc dữ liệu tenant.
  const orgId = await withTenant(pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ ok: boolean }>(
      sql`select current_user = 'hive_app' and not rolsuper and not rolbypassrls as ok from pg_roles where rolname = current_user`,
    );
    if (!rows[0]?.ok) throw new Error("Import phải kết nối bằng role hive_app.");
    const id = await resolveLegacyImportOrg(tx, options.org);
    if (!id) throw new Error("Không tìm thấy tổ chức đích.");
    return id;
  });
  return withTenant(pool, { orgId }, async (tx) => {
    if (options.dryRun) await tx.execute(sql`set transaction read only`);
    else await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`legacy-import:${orgId}`}, 0))`);
    const existing = new Map(
      (await tx.select().from(legacyImports)).map((r) => [sourceKey(r.kind as Kind, r.sourceId), r]),
    );
    const emailCache = new Map<string, string>();
    const scopeCache = new Map<string, Scope & { keyPrefix: string }>();
    const embeddings = !!deps.embedder && !!deps.jobs && (await hasVectors(tx));
    const author = async (value: unknown): Promise<string> => {
      const name = text(value);
      if (emailCache.has(name)) return emailCache.get(name) as string;
      const email = source.authorEmails.get(name) ?? name;
      const id = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? await findOrgUserByEmail(tx, email) : null;
      // Các cột tác giả hiện tại không có FK tới identity; marker này không tạo tài khoản đăng nhập giả.
      const result = id ?? "hệ cũ";
      emailCache.set(name, result);
      return result;
    };
    const scopeFor = async (project: string): Promise<Scope & { keyPrefix: string }> => {
      const cached = scopeCache.get(project);
      if (cached) return cached;
      let scope: Scope & { keyPrefix: string };
      if (!project) scope = { teamId: null, projectId: null, keyPrefix: "org" };
      else if (project.startsWith("sys:")) {
        const slug = project.slice(4);
        const system = await findSystemBySlug(tx, slug);
        if (!system) fail("Không tìm thấy hệ thống duy nhất trong tổ chức đích.");
        const [team] = await tx.select({ slug: teams.slug }).from(teams).where(eq(teams.id, system.teamId));
        if (!team) fail("Không tìm thấy đội của hệ thống.");
        scope = { teamId: system.teamId, projectId: null, keyPrefix: `team/${team.slug}/legacy-system/${slug}` };
      } else {
        const target = options.projectMap?.get(project) ?? project;
        const p = await findProject(tx, target);
        if (!p || p.key !== target) fail("Không tìm thấy project key trong tổ chức đích.");
        scope = { teamId: p.teamId, projectId: p.id, keyPrefix: `project/${p.key}` };
      }
      scopeCache.set(project, scope);
      return scope;
    };
    const remember = async (
      kind: Kind,
      sourceId: string,
      targetIds: string[],
      metadata: Record<string, unknown>,
    ): Promise<ImportRow> => {
      const row: ImportRow = { id: randomUUID(), orgId, kind, sourceId, targetIds, metadata, createdAt: new Date() };
      if (!options.dryRun) await tx.insert(legacyImports).values(row);
      existing.set(sourceKey(kind, sourceId), row);
      return row;
    };
    // Savepoint giữ lỗi của một bản ghi không làm hỏng cả đợt; lỗi SQL được thay bằng thông báo không chứa nội dung.
    const attempt = async (fn: () => Promise<void>): Promise<string | null> => {
      if (!options.dryRun) await tx.execute(sql`savepoint legacy_record`);
      try {
        await fn();
        if (!options.dryRun) await tx.execute(sql`release savepoint legacy_record`);
        return null;
      } catch (error) {
        if (!options.dryRun) {
          await tx.execute(sql`rollback to savepoint legacy_record`);
          await tx.execute(sql`release savepoint legacy_record`);
        }
        return error instanceof ImportIssue ? error.message : "Bản ghi không hợp lệ hoặc xung đột dữ liệu đích.";
      }
    };

    for (const m of source.memories) {
      const id = String(m.id);
      if (existing.has(sourceKey("memory", id))) {
        increment(report.memory, "skipped");
        continue;
      }
      const issue = await attempt(async () => {
        const scope = await scopeFor(text(m.project));
        if (m.status !== "approved" && m.status !== "pending") fail("Trạng thái memory không hợp lệ.");
        const kind = m.kind === "context" ? "note" : m.kind;
        if (!memories.kind.enumValues.includes(kind as never)) fail("Loại memory không hợp lệ.");
        const content = text(m.content).normalize("NFC");
        if (!content) fail("Memory rỗng.");
        const rawFiles: unknown = JSON.parse(text(m.files ?? "[]"));
        if (!Array.isArray(rawFiles)) fail("Danh sách tệp memory không hợp lệ.");
        const files = rawFiles.map((f) => text(typeof f === "string" ? f : f?.path));
        const createdAt = date(m.created_at);
        const authorUserId = await author(m.on_behalf ?? m.author);
        // Postgres char_length đếm code point; không cắt đôi surrogate pair hay bỏ nội dung vượt 2.000 ký tự.
        const points = Array.from(content);
        const ids: string[] = [];
        for (let offset = 0; offset < points.length; offset += 2000) {
          const memoryId = randomUUID();
          ids.push(memoryId);
          if (options.dryRun) continue;
          await tx.insert(memories).values({
            id: memoryId,
            orgId,
            teamId: scope.teamId,
            projectId: scope.projectId,
            kind: kind as typeof memories.$inferInsert.kind,
            status: m.status,
            content: points.slice(offset, offset + 2000).join(""),
            files,
            authorUserId,
            createdAt,
          });
          if (m.status === "approved" && embeddings && deps.jobs)
            await deps.jobs.enqueue<EmbedJob>(EMBED_QUEUE, { orgId, memoryId }, { tx });
        }
        await remember("memory", id, ids, {
          kind: m.kind,
          status: m.status,
          files: rawFiles,
          supersededBy: m.superseded_by ?? null,
          authorLabel: authorUserId === "hệ cũ" ? "hệ cũ" : null,
        });
      });
      increment(report.memory, issue ? "errors" : "added", 1, issue ?? undefined);
    }
    if (!options.dryRun) {
      for (const m of source.memories) {
        if (m.superseded_by == null) continue;
        const old = existing.get(sourceKey("memory", String(m.id)));
        const next = existing.get(sourceKey("memory", String(m.superseded_by)));
        if (old && next?.targetIds[0]) {
          for (const id of old.targetIds)
            await tx
              .update(memories)
              .set({ supersededBy: next.targetIds[0] })
              .where(and(eq(memories.id, id), isNull(memories.supersededBy)));
        }
      }
    }

    const versionsByKey = new Map<string, LegacyRow[]>();
    for (const v of source.versions) {
      const key = text(v.key);
      const versions = versionsByKey.get(key) ?? [];
      versions.push(v);
      versionsByKey.set(key, versions);
    }
    const plannedDocKeys = new Set<string>();
    const plannedSkillKeys = new Set<string>();
    const documents = new Map<string, ImportRow>();
    for (const d of source.docs) {
      const sourceId = text(d.key);
      const isSkill = /^(?:org|project\/[^/]+)\/skills\/[^/]+$/.test(sourceId);
      const kind = isSkill ? "skill" : "doc";
      const vc = isSkill ? report.skillVersion : report.docVersion;
      const history = [...(versionsByKey.get(sourceId) ?? [])].sort((a, b) => Number(a.version) - Number(b.version));
      const prior = existing.get(sourceKey(kind, sourceId));
      if (prior || d.removed_at != null) {
        increment(report[kind], "skipped");
        increment(vc, "skipped", history.length);
        if (prior) documents.set(sourceId, prior);
        continue;
      }
      const issue = await attempt(async () => {
        const scope = await scopeFor(d.project == null ? "" : text(d.project));
        const match = /^(org|project\/[^/]+|system\/[^/]+)\/(.+)$/.exec(sourceId);
        if (!match) fail("Key nguồn không hợp lệ.");
        const expectedPrefix =
          d.scope === "org" && d.project == null
            ? "org"
            : d.scope === "project" && typeof d.project === "string"
              ? `project/${d.project}`
              : d.scope === "system" && typeof d.project === "string" && d.project.startsWith("sys:")
                ? `system/${d.project.slice(4)}`
                : null;
        if (match[1] !== expectedPrefix) fail("Phạm vi tài liệu không khớp key nguồn.");
        const key = `${scope.keyPrefix}/${match[2]}`;
        const version = positiveInt(d.version);
        const current = history.find((v) => v.version === version);
        if (!current || current.content !== d.content || history.some((v) => Number(v.version) > version))
          fail("Lịch sử không khớp phiên bản hiện tại.");
        if (new Set(history.map((v) => v.version)).size !== history.length) fail("Lịch sử có phiên bản trùng.");
        const updatedAt = date(d.updated_at);
        const createdAt = date(history[0]?.created_at);
        const updatedByUserId = await author(d.updated_by);
        const id = randomUUID();
        const title = text(d.title);
        if (!title || title.length > 200) fail("Tiêu đề không hợp lệ.");
        const name = match[2]?.slice("skills/".length) ?? "";
        const skillKey = JSON.stringify([scope.teamId, scope.projectId, name]);
        const description = isSkill ? parseLegacySkill(text(d.content), name) : "";
        if (isSkill) {
          if (!skillName.safeParse(name).success) fail("Tên skill không hợp lệ.");
          const [collision] = await tx
            .select({ id: skills.id })
            .from(skills)
            .where(
              and(
                eq(skills.name, name),
                sql`${skills.teamId} is not distinct from ${scope.teamId}`,
                sql`${skills.projectId} is not distinct from ${scope.projectId}`,
              ),
            );
          if (collision || plannedSkillKeys.has(skillKey)) fail("Skill đích đã tồn tại; không ghi đè.");
        } else {
          if (!docKey.safeParse(key).success) fail("Key tài liệu đích không hợp lệ.");
          const [collision] = await tx.select({ id: docs.id }).from(docs).where(eq(docs.key, key));
          if (collision || plannedDocKeys.has(key)) fail("Tài liệu đích đã tồn tại; không ghi đè.");
        }
        const prepared = await Promise.all(
          history.map(async (v) => ({
            version: positiveInt(v.version),
            content: text(v.content),
            message: text(v.note),
            createdAt: date(v.created_at),
            authorUserId: await author(v.author),
            description: isSkill ? parseLegacySkill(text(v.content), name) : "",
          })),
        );
        const missingAssets = source.assets.filter((a) => a.doc_key === sourceId);
        if (!options.dryRun) {
          const header = {
            id,
            orgId,
            teamId: scope.teamId,
            projectId: scope.projectId,
            currentVersion: version,
            updatedByUserId,
            createdAt,
            updatedAt,
          };
          if (isSkill) await tx.insert(skills).values({ ...header, name, description });
          else await tx.insert(docs).values({ ...header, key, title });
          for (const v of prepared) {
            const common = {
              orgId,
              version: v.version,
              content: markMissingAssets(v.content, missingAssets),
              message: v.message,
              createdAt: v.createdAt,
              authorUserId: v.authorUserId,
            };
            if (isSkill) await tx.insert(skillVersions).values({ ...common, skillId: id, description: v.description });
            else await tx.insert(docVersions).values({ ...common, docId: id, title });
          }
        }
        const imported = await remember(kind, sourceId, [id], {
          key: isSkill ? name : key,
          versions: history.length,
          folder: d.folder ?? 0,
          parent: d.parent ?? null,
          paths: d.paths ?? null,
          authorLabel: updatedByUserId === "hệ cũ" ? "hệ cũ" : null,
        });
        documents.set(sourceId, imported);
        if (isSkill) plannedSkillKeys.add(skillKey);
        else plannedDocKeys.add(key);
      });
      increment(report[kind], issue ? "errors" : "added", 1, issue ?? undefined);
      increment(vc, issue ? "errors" : "added", history.length, issue ?? undefined);
    }
    // Không bỏ lặng các phiên bản mồ côi: không đủ header để biết phạm vi, phải báo lỗi để quản trị xử lý.
    const documentKeys = new Set(source.docs.map((d) => d.key));
    for (const v of source.versions) {
      if (!documentKeys.has(v.key))
        increment(
          /\/skills\//.test(text(v.key)) ? report.skillVersion : report.docVersion,
          "errors",
          1,
          "Phiên bản không có tài liệu nguồn.",
        );
    }
    for (const a of source.assets) {
      const sourceId = String(a.id);
      if (existing.has(sourceKey("asset", sourceId))) {
        increment(report.asset, "skipped");
        continue;
      }
      const issue = await attempt(async () => {
        const document = documents.get(text(a.doc_key));
        if (!document) fail("Asset chưa có tài liệu đích.");
        const size = Number(a.size);
        if (!Number.isSafeInteger(size) || size < 0) fail("Kích thước asset không hợp lệ.");
        const row = {
          id: randomUUID(),
          orgId,
          documentImportId: document.id,
          sourceId,
          name: text(a.name),
          mediaType: text(a.type),
          size,
          sha256: a.sha256 == null ? null : text(a.sha256),
          storageLocator: a.stored == null ? null : text(a.stored),
          status: "missing",
          uploadedBy: await author(a.uploaded_by),
          createdAt: date(a.created_at),
        };
        if (!options.dryRun) await tx.insert(legacyDocAssets).values(row);
        await remember("asset", sourceId, [row.id], { documentSourceId: a.doc_key, status: "missing" });
      });
      increment(report.asset, issue ? "errors" : "added", 1, issue ?? undefined);
    }
    return report;
  });
}

/** Định dạng front matter của hệ cũ hỗ trợ chuỗi có quote và block YAML; không chạy hay tải skill. */
export function parseLegacySkill(content: string, expectedName: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!front) fail("Skill thiếu front matter.");
  const fields = new Map<string, string>();
  const lines = (front[1] ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const field = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i] ?? "");
    if (!field) continue;
    let value = (field[2] ?? "").trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1] ?? "") || !lines[i + 1]?.trim()))
        block.push((lines[++i] ?? "").trim());
      value = block.join(value.startsWith(">") ? " " : "\n").trim();
    } else if (value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
    fields.set(field[1] ?? "", value);
  }
  const description = fields.get("description") ?? "";
  if (fields.get("name") !== expectedName || !description || description.length > 1024)
    fail("Front matter skill không hợp lệ.");
  return description;
}

function markMissingAssets(content: string, assets: LegacyRow[]): string {
  if (!assets.length) return content;
  // Giữ nguyên link và nội dung lịch sử, chỉ thêm dấu nhận biết; metadata lưu locator để chuyển blob sau.
  return `${content}\n\n> Tệp đính kèm từ hệ cũ chưa được chuyển (${assets.length} tệp); các liên kết tệp có thể bị hỏng.\n`;
}
