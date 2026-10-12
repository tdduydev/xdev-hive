import {
  type Skill,
  type SkillGetInput,
  type SkillListInput,
  type SkillSaveInput,
  type SkillSummary,
  skillGetInput,
  skillListInput,
  skillSaveInput,
} from "@xdev-hive/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import { NotFoundError, type Tx } from "../platform/index.ts";
import {
  audit,
  authorColumns,
  authorize,
  authorView,
  canRead,
  iso,
  type Principal,
  projectContext,
  readerFor,
  resolveScope,
  type Scope,
  scopeView,
  versionConflict,
  visibleWhere,
} from "./access.ts";
import { skills, skillVersions } from "./schema.ts";

type SkillRow = typeof skills.$inferSelect;

const notFound = () => new NotFoundError("SKILL_NOT_FOUND", "Không tìm thấy skill.");

function summary(s: SkillRow): SkillSummary {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    scope: scopeView(s),
    version: s.currentVersion,
    updatedAt: iso(s.updatedAt),
    updatedBy: { userId: s.updatedByUserId, runId: s.updatedByRunId },
    repoPath: s.repoPath,
  };
}

/** Phạm vi hẹp đứng trước: skill của dự án che skill cùng tên của đội, của đội che của tổ chức. */
const specificity = (s: Scope) => (s.projectId ? 2 : s.teamId ? 1 : 0);

const sameScope = (scope: Scope) =>
  and(
    sql`${skills.teamId} is not distinct from ${scope.teamId}::uuid`,
    sql`${skills.projectId} is not distinct from ${scope.projectId}::uuid`,
  );

/** Phiên bản hiện tại của skill theo phạm vi và tên (0 khi chưa có). */
export async function currentSkillVersion(tx: Tx, scope: Scope, name: string): Promise<number> {
  const [row] = await tx
    .select({ v: skills.currentVersion })
    .from(skills)
    .where(and(sameScope(scope), eq(skills.name, name)));
  return row?.v ?? 0;
}

export interface SkillWrite {
  name: string;
  description: string;
  content: string;
  baseVersion: number;
  message?: string | undefined;
}

/** Lưu một phiên bản với khoá lạc quan như tài liệu. Không kiểm quyền: saveSkill và duyệt đề xuất tự kiểm. */
export async function applySkillSave(
  tx: Tx,
  principal: Principal,
  scope: Scope,
  input: SkillWrite,
  proposalId: string | null = null,
): Promise<Skill> {
  const author = authorColumns(principal);
  let row: SkillRow | undefined;
  if (input.baseVersion === 0) {
    [row] = await tx
      .insert(skills)
      .values({
        orgId: sql`hive.ctx_org()`,
        teamId: scope.teamId,
        projectId: scope.projectId,
        name: input.name,
        description: input.description,
        currentVersion: 1,
        updatedByUserId: author.authorUserId,
        updatedByRunId: author.authorRunId,
      })
      .onConflictDoNothing()
      .returning();
  } else {
    [row] = await tx
      .update(skills)
      .set({
        currentVersion: sql`${skills.currentVersion} + 1`,
        description: input.description,
        updatedByUserId: author.authorUserId,
        updatedByRunId: author.authorRunId,
        updatedAt: new Date(),
      })
      .where(and(sameScope(scope), eq(skills.name, input.name), eq(skills.currentVersion, input.baseVersion)))
      .returning();
  }
  if (!row) throw versionConflict("Skill", await currentSkillVersion(tx, scope, input.name), input.baseVersion);
  await tx.insert(skillVersions).values({
    orgId: row.orgId,
    skillId: row.id,
    version: row.currentVersion,
    description: input.description,
    content: input.content,
    message: input.message ?? null,
    proposalId,
    ...author,
  });
  return { ...summary(row), content: input.content };
}

/** Lưu skill trực tiếp (quản trị đội của phạm vi; cấp tổ chức: quản trị tổ chức). */
export async function saveSkill(tx: Tx, principal: Principal, input: SkillSaveInput): Promise<Skill> {
  const data = skillSaveInput.parse(input);
  const reader = await readerFor(tx, principal);
  const scope = await resolveScope(tx, reader, data.scope);
  await authorize(tx, reader, scope, "manage");
  const skill = await applySkillSave(tx, principal, scope, data);
  await audit(
    tx,
    principal,
    "skill.save",
    { type: "skill", id: skill.id },
    { name: skill.name, version: skill.version },
  );
  return skill;
}

/**
 * Skill mình thấy được. Có dự án (hoặc người gọi là run) thì trả bộ skill áp dụng cho dự án: mỗi tên một skill,
 * phạm vi hẹp nhất thắng. Hàm public cho MCP.
 */
export async function listSkills(tx: Tx, principal: Principal, input: SkillListInput = {}): Promise<SkillSummary[]> {
  const data = skillListInput.parse(input);
  const reader = await readerFor(tx, principal);
  const project = await projectContext(tx, reader, data.project);
  const rows = await tx
    .select()
    .from(skills)
    .where(visibleWhere(reader, skills, project))
    .orderBy(asc(skills.name));
  if (!project) return rows.map(summary);
  const best = new Map<string, SkillRow>();
  for (const r of rows) {
    const cur = best.get(r.name);
    if (!cur || specificity(r) > specificity(cur)) best.set(r.name, r);
  }
  return [...best.values()].map(summary);
}

/**
 * Đọc skill theo id, hoặc theo tên: trong dự án (đặt `project`, hoặc dự án của run) lấy skill áp dụng cho dự án;
 * không có dự án thì chỉ tìm ở cấp tổ chức. Hàm public cho MCP.
 */
export async function getSkill(tx: Tx, principal: Principal, input: SkillGetInput): Promise<Skill> {
  const data = skillGetInput.parse(input);
  const reader = await readerFor(tx, principal);
  let row: SkillRow | undefined;
  if (data.id) {
    [row] = await tx.select().from(skills).where(eq(skills.id, data.id));
    if (row && !canRead(reader, row)) row = undefined;
  } else {
    const project = await projectContext(tx, reader, data.project);
    const candidates = await tx
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.name, data.name ?? ""),
          project ? visibleWhere(reader, skills, project) : sql`${skills.teamId} is null`,
        ),
      );
    row = candidates.sort((a, b) => specificity(b) - specificity(a))[0];
  }
  if (!row) throw notFound();
  const version = data.version ?? row.currentVersion;
  const [v] = await tx
    .select()
    .from(skillVersions)
    .where(and(eq(skillVersions.skillId, row.id), eq(skillVersions.version, version)));
  if (!v) throw new NotFoundError("SKILL_VERSION_NOT_FOUND", `Skill không có phiên bản ${version}.`);
  return {
    ...summary(row),
    description: v.description,
    version: v.version,
    updatedAt: iso(v.createdAt),
    updatedBy: authorView(v),
    content: v.content,
  };
}
