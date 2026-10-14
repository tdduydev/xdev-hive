import { createHash } from "node:crypto";
import {
  type PackSkill,
  type PackSkillFiles,
  type SkillPack,
  type SkillPackGetInput,
  type SkillPackListInput,
  type SkillPackSetInput,
  skillPackGetInput,
  skillPackListInput,
  skillPackSetInput,
} from "@xdev-hive/contracts";
import type { RunSkillsResponse } from "@xdev-hive/contracts/worker-protocol";
import { type PackSkillMeta, readManifest, type SkillPackManifest, skillFiles, skillText } from "@xdev-hive/skill-pack";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import {
  audit,
  authorize,
  type Principal,
  type ProjectView,
  projectContext,
  projectFor,
  type Reader,
  readerFor,
  visibleWhere,
} from "./access.ts";
import { skillPackSettings, skills, skillVersions } from "./schema.ts";
import { renderSkillFile } from "./skill-repo.ts";

// Gói đọc từ đĩa một lần mỗi tiến trình: nội dung chỉ đổi khi triển khai bản hub mới.
let loaded: { manifest: SkillPackManifest; byName: Map<string, PackSkillMeta> } | undefined;

function pack() {
  if (!loaded) {
    const manifest = readManifest();
    loaded = { manifest, byName: new Map(manifest.skills.map((s) => [s.name, s])) };
  }
  return loaded;
}

const notFound = () => new NotFoundError("SKILL_NOT_FOUND", "Không tìm thấy skill.");

function metaOf(name: string): PackSkillMeta {
  const meta = pack().byName.get(name);
  if (!meta) throw notFound();
  return meta;
}

type Level = "org" | "team" | "project";

interface Overrides {
  org: Map<string, boolean>;
  project: Map<string, boolean>;
}

async function overrides(tx: Tx, projectId: string | null): Promise<Overrides> {
  const rows = await tx
    .select({
      projectId: skillPackSettings.projectId,
      name: skillPackSettings.name,
      enabled: skillPackSettings.enabled,
    })
    .from(skillPackSettings)
    .where(
      projectId
        ? or(isNull(skillPackSettings.projectId), eq(skillPackSettings.projectId, projectId))
        : isNull(skillPackSettings.projectId),
    );
  const out: Overrides = { org: new Map(), project: new Map() };
  for (const r of rows) (r.projectId ? out.project : out.org).set(r.name, r.enabled);
  return out;
}

/**
 * Skill cùng tên của tổ chức, đội, dự án mà người gọi thấy: bản đó được dùng thay bản mặc định. Không hỏi theo dự án
 * thì chỉ skill cấp tổ chức che được, vì skill của đội chỉ áp cho dự án của đội.
 */
async function shadows(tx: Tx, reader: Reader, project: ProjectView | undefined): Promise<Map<string, Level>> {
  const rows = await tx
    .select({ name: skills.name, teamId: skills.teamId, projectId: skills.projectId })
    .from(skills)
    .where(project ? visibleWhere(reader, skills, project) : isNull(skills.teamId));
  const rank = { org: 0, team: 1, project: 2 } as const;
  const out = new Map<string, Level>();
  for (const r of rows) {
    const level: Level = r.projectId ? "project" : r.teamId ? "team" : "org";
    const cur = out.get(r.name);
    if (!cur || rank[level] > rank[cur]) out.set(r.name, level);
  }
  return out;
}

function view(meta: PackSkillMeta, o: Overrides, shadowedBy: Level | null, withProject: boolean): PackSkill {
  const org = o.org.get(meta.name) ?? null;
  const project = withProject ? (o.project.get(meta.name) ?? null) : null;
  return {
    name: meta.name,
    description: meta.description,
    group: meta.group,
    license: meta.license,
    upstream: meta.upstream,
    defaultOn: meta.defaultOn,
    org,
    project,
    enabled: project ?? org ?? meta.defaultOn,
    shadowedBy,
    version: meta.version,
    files: meta.files,
    bytes: meta.bytes,
  };
}

async function state(tx: Tx, reader: Reader, project: ProjectView | undefined) {
  const [o, shadowed] = await Promise.all([overrides(tx, project?.projectId ?? null), shadows(tx, reader, project)]);
  return (meta: PackSkillMeta) => view(meta, o, shadowed.get(meta.name) ?? null, project !== undefined);
}

/** Cả bộ skill mặc định, kèm trạng thái bật của tổ chức hoặc của dự án (`project`). Thành viên nào cũng đọc được. */
export async function listSkillPack(tx: Tx, principal: Principal, input: SkillPackListInput = {}): Promise<SkillPack> {
  const data = skillPackListInput.parse(input);
  const reader = await readerFor(tx, principal);
  const project = await projectContext(tx, reader, data.project);
  const of = await state(tx, reader, project);
  const { manifest } = pack();
  return {
    source: { repo: manifest.source.repo, commit: manifest.source.commit },
    skills: manifest.skills.map(of),
  };
}

/**
 * Skill mặc định đang dùng được ở phạm vi đang hỏi: bật và không bị skill cùng tên của tổ chức, đội, dự án che. Bản bị
 * che trả riêng để skill_list báo cho agent và app desktop.
 */
export async function activePackSkills(
  tx: Tx,
  reader: Reader,
  project: ProjectView | undefined,
): Promise<{ active: PackSkill[]; shadowed: PackSkill[] }> {
  const of = await state(tx, reader, project);
  const on = pack()
    .manifest.skills.map(of)
    .filter((s) => s.enabled);
  return { active: on.filter((s) => !s.shadowedBy), shadowed: on.filter((s) => s.shadowedBy) };
}

/** SKILL.md và danh sách file của một skill mặc định; đọc được cả khi đang tắt, để xem trước khi bật. */
export async function getPackSkill(tx: Tx, principal: Principal, input: SkillPackGetInput) {
  const data = skillPackGetInput.parse(input);
  const meta = metaOf(data.name);
  const reader = await readerFor(tx, principal);
  const project = await projectContext(tx, reader, data.project);
  const of = await state(tx, reader, project);
  return { ...of(meta), content: skillText(meta.name), paths: skillFiles(meta.name).map((f) => f.path) };
}

export async function packSkillFiles(tx: Tx, principal: Principal, input: SkillPackGetInput): Promise<PackSkillFiles> {
  const data = skillPackGetInput.parse(input);
  const meta = metaOf(data.name);
  await readerFor(tx, principal);
  return { name: meta.name, hash: meta.hash, files: skillFiles(meta.name) };
}

/** Một file trong thư mục skill mặc định (vd. `references/x.md`), cho agent không có bản cài trên máy. */
export function packSkillFile(name: string, path: string): string {
  const file = skillFiles(metaOf(name).name).find((f) => f.path === path);
  if (!file) throw new NotFoundError("SKILL_FILE_NOT_FOUND", `Skill ${name} không có file ${path}.`);
  return file.text;
}

/**
 * Bật, tắt, hoặc bỏ đặt riêng (enabled null) một skill mặc định. Cấp tổ chức cần quản trị tổ chức; cấp dự án cần
 * quản trị đội sở hữu dự án, như lưu skill của dự án.
 */
export async function setSkillPack(tx: Tx, principal: Principal, input: SkillPackSetInput): Promise<PackSkill> {
  const data = skillPackSetInput.parse(input);
  const meta = metaOf(data.name);
  const reader = await readerFor(tx, principal);
  const project = data.project ? await projectFor(tx, reader, data.project) : undefined;
  if (principal.kind !== "user") throw new ForbiddenError("RUN_NOT_ALLOWED", "Agent không được bật, tắt skill.");
  await authorize(tx, reader, project ?? { teamId: null, projectId: null }, "manage");
  const projectId = project?.projectId ?? null;
  await tx
    .delete(skillPackSettings)
    .where(
      and(
        eq(skillPackSettings.name, meta.name),
        sql`${skillPackSettings.projectId} is not distinct from ${projectId}::uuid`,
      ),
    );
  if (data.enabled !== null) {
    await tx.insert(skillPackSettings).values({
      orgId: sql`hive.ctx_org()`,
      projectId,
      name: meta.name,
      enabled: data.enabled,
      updatedByUserId: principal.userId,
    });
  }
  await audit(
    tx,
    principal,
    "skill_pack.set",
    { type: "skill_pack", id: meta.name },
    { enabled: data.enabled, projectId },
  );
  return (await state(tx, reader, project))(meta);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Skill worker chép vào worktree của run: skill của tổ chức, đội, dự án áp cho dự án của run (mỗi tên bản hẹp nhất)
 * và skill mặc định đang bật mà không bị che. Bỏ `files` của skill có hash nằm trong `have` (worker đã cache).
 */
export async function runSkillBundle(
  tx: Tx,
  principal: Principal & { kind: "run" },
  have: readonly string[],
): Promise<RunSkillsResponse> {
  const reader = await readerFor(tx, principal);
  const cached = new Set(have);
  const rows = await tx
    .select({
      name: skills.name,
      description: skillVersions.description,
      content: skillVersions.content,
      teamId: skills.teamId,
      projectId: skills.projectId,
    })
    .from(skills)
    .innerJoin(
      skillVersions,
      and(eq(skillVersions.skillId, skills.id), eq(skillVersions.version, skills.currentVersion)),
    )
    .where(visibleWhere(reader, skills))
    .orderBy(asc(skills.name));
  const rank = (r: { teamId: string | null; projectId: string | null }) => (r.projectId ? 2 : r.teamId ? 1 : 0);
  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = best.get(r.name);
    if (!cur || rank(r) > rank(cur)) best.set(r.name, r);
  }
  const out: RunSkillsResponse["skills"] = [];
  for (const r of best.values()) {
    const text = renderSkillFile(r.name, r.description, r.content);
    const hash = sha256(text);
    out.push({
      name: r.name,
      hash,
      source: r.projectId ? "project" : r.teamId ? "team" : "org",
      ...(cached.has(hash) ? {} : { files: [{ path: "SKILL.md", text }] }),
    });
  }
  const { active } = await activePackSkills(tx, reader, reader.kind === "run" ? reader : undefined);
  for (const s of active) {
    const meta = metaOf(s.name);
    out.push({
      name: s.name,
      hash: meta.hash,
      source: "hive",
      ...(cached.has(meta.hash) ? {} : { files: skillFiles(s.name) }),
    });
  }
  return { skills: out };
}
