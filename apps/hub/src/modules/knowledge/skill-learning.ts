import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { findProject } from "../catalog/index.ts";
import { ConflictError, type Tx } from "../platform/index.ts";
import { audit, authorize, readerFor, type Scope } from "./access.ts";
import { memories, skills, skillVersions } from "./schema.ts";
import { packSkillNames } from "./skill-pack.ts";
import { hasSkillRepo, openSkillPR, type SkillRepoDeps } from "./skill-repo.ts";
import { applySkillSave } from "./skills.ts";

// Cầu nối cho module skilllearn (specs/014): nó không đụng bảng của knowledge mà đi qua các hàm này.

/** Skill và memory đã có mà dự án thấy, để bỏ đề xuất trùng và để agent biết skill nào đã có. */
export interface LearningCorpus {
  skills: { name: string; description: string; level: "org" | "team" | "project" }[];
  /** Tên skill mặc định của Hive (skill-pack): cũng không đề xuất trùng. */
  packNames: string[];
  memories: { id: string; content: string }[];
}

const MAX_CORPUS = 500;

/** Skill và memory áp dụng cho dự án: của tổ chức, của đội sở hữu dự án và của chính dự án. */
export async function skillLearningCorpus(tx: Tx, projectId: string): Promise<LearningCorpus> {
  const project = await findProject(tx, projectId);
  if (!project) return { skills: [], packNames: packSkillNames(), memories: [] };
  const inScope = (c: { teamId: PgColumn; projectId: PgColumn }) =>
    or(isNull(c.teamId), and(eq(c.teamId, project.teamId), or(isNull(c.projectId), eq(c.projectId, project.id))));
  const skillRows = await tx
    .select({ name: skills.name, description: skills.description, teamId: skills.teamId, projectId: skills.projectId })
    .from(skills)
    .where(inScope(skills))
    .limit(MAX_CORPUS);
  const memoryRows = await tx
    .select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(and(inScope(memories), eq(memories.status, "approved"), isNull(memories.supersededBy)))
    .orderBy(desc(memories.createdAt))
    .limit(MAX_CORPUS);
  return {
    skills: skillRows.map((s) => ({
      name: s.name,
      description: s.description,
      level: s.projectId ? "project" : s.teamId ? "team" : "org",
    })),
    packNames: packSkillNames(),
    memories: memoryRows,
  };
}

/** Skill cùng tên áp dụng cho dự án, phạm vi hẹp nhất thắng (như skill_get): đích của đề xuất `edit`. */
export async function findSkillForProject(
  tx: Tx,
  projectId: string,
  name: string,
): Promise<{ scope: Scope; version: number; description: string } | null> {
  const project = await findProject(tx, projectId);
  if (!project) return null;
  const rows = await tx
    .select()
    .from(skills)
    .where(
      and(
        eq(skills.name, name),
        or(
          isNull(skills.teamId),
          and(eq(skills.teamId, project.teamId), or(isNull(skills.projectId), eq(skills.projectId, project.id))),
        ),
      ),
    );
  const best = rows.sort(
    (a, b) => Number(!!b.projectId) - Number(!!a.projectId) || Number(!!b.teamId) - Number(!!a.teamId),
  )[0];
  return best
    ? {
        scope: { teamId: best.teamId, projectId: best.projectId },
        version: best.currentVersion,
        description: best.description,
      }
    : null;
}

/** Nội dung bản hiện tại của skill (đề xuất `edit` so với nó); null khi skill đã bị xoá. */
export async function currentSkillContent(tx: Tx, scope: Scope, name: string): Promise<string | null> {
  const [row] = await tx
    .select({ content: skillVersions.content })
    .from(skills)
    .innerJoin(
      skillVersions,
      and(eq(skillVersions.skillId, skills.id), eq(skillVersions.version, skills.currentVersion)),
    )
    .where(
      and(
        eq(skills.name, name),
        sql`${skills.teamId} is not distinct from ${scope.teamId}::uuid`,
        sql`${skills.projectId} is not distinct from ${scope.projectId}::uuid`,
      ),
    );
  return row?.content ?? null;
}

export { hasSkillRepo };

export interface LearnedSkillWrite {
  name: string;
  description: string;
  content: string;
  baseVersion: number;
  message: string;
}

/**
 * Lưu skill đề xuất thành skill của tổ chức khi chưa nối kho Git. Người duyệt phải có quyền quản trị phạm vi đích (đội
 * hoặc tổ chức), như `saveSkill`. Skill đã đổi sau khi agent đề xuất thì CONFLICT, đề xuất vẫn chờ.
 */
export async function applyLearnedSkill(
  tx: Tx,
  userId: string,
  scope: Scope,
  input: LearnedSkillWrite,
  proposalId: string,
): Promise<{ skillId: string; version: number }> {
  const principal = { kind: "user", userId } as const;
  await authorize(tx, await readerFor(tx, principal), scope, "manage");
  const skill = await applySkillSave(tx, principal, scope, input);
  await audit(
    tx,
    principal,
    "skill.save",
    { type: "skill", id: skill.id },
    {
      name: skill.name,
      version: skill.version,
      learnedFrom: proposalId,
    },
  );
  return { skillId: skill.id, version: skill.version };
}

/** Người duyệt có quyền ghi vào phạm vi đích không (kiểm trước khi hub nhận quyết định, để không mở PR rồi mới từ chối). */
export async function assertCanManageScope(tx: Tx, userId: string, scope: Scope): Promise<void> {
  await authorize(tx, await readerFor(tx, { kind: "user", userId }), scope, "manage");
}

/**
 * Mở PR vào kho skill Git cho một đề xuất đã duyệt (SKILL-04): nhánh riêng, một commit, một PR. Chạy lại an toàn khi
 * nhánh đã có. Bản vào nhánh chính khi PR được merge, qua webhook đồng bộ của kho.
 */
export async function openLearnedSkillPR(
  deps: SkillRepoDeps,
  orgId: string,
  input: {
    proposalId: string;
    scope: Scope;
    name: string;
    description: string;
    content: string;
    kind: "new" | "edit";
    reason: string;
  },
): Promise<{ number: number; url: string }> {
  const pr = await openSkillPR(deps, orgId, {
    branch: `hive/learned-skill-${input.proposalId.slice(0, 8)}`,
    scope: input.scope,
    name: input.name,
    description: input.description,
    content: input.content,
    message: `${input.kind === "new" ? "Thêm" : "Sửa"} skill ${input.name} (agent đề xuất)`,
    title: `${input.kind === "new" ? "Thêm" : "Sửa"} skill ${input.name} (agent đề xuất)`,
    body: `${input.reason}\n\nĐề xuất từ xDev Hive (${input.proposalId}), đã được người trong đội duyệt.`,
  });
  if (!pr) throw new ConflictError("SKILL_REPO_MISSING", "Tổ chức chưa nối kho skill Git.");
  return pr;
}
