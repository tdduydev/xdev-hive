import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { authUser } from "../identity/index.ts";
import type { McpToolRegistry } from "../mcp/index.ts";
import type { Tx } from "../platform/index.ts";
import { orgRoleOf } from "./permissions.ts";
import { iso } from "./procedures.ts";
import { orgMembers, orgs, systems, teams } from "./schema.ts";

/** Tổ chức người dùng đang là thành viên hoạt động. RLS của org_members luôn cho thấy dòng của chính người gọi. */
async function myOrgs(tx: Tx, userId: string, limit?: number, offset = 0) {
  return tx
    .select({ id: orgs.id, slug: orgs.slug, name: orgs.name, role: orgMembers.role })
    .from(orgMembers)
    .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.status, "active")))
    .orderBy(asc(orgs.name))
    .limit(limit ?? 2_147_483_647)
    .offset(offset);
}

const OFFSET = z.number().int().min(0).optional().describe("Vị trí bắt đầu danh sách.");
const LIMIT = z.number().int().min(1).max(50).optional().describe("Số mục; mặc định 10.");

/** Tool chỉ đọc về tổ chức, đội, hệ thống. Cổng MCP đã chọn tổ chức và mở withTenant trước khi gọi handler. */
export function registerMcpTools(registry: McpToolRegistry): void {
  registry.provideMemberships(async (tx, userId) =>
    (await myOrgs(tx, userId)).map(({ id, slug, name }) => ({ id, slug, name })),
  );

  registry.register({
    name: "hive_whoami",
    title: "Tôi là ai",
    description: "Cho biết người dùng hoặc run đang gọi, tổ chức đang làm việc và vai trò trong tổ chức đó.",
    input: z.object({}),
    readOnly: true,
    handler: async (_args, { tx, orgId, principal }) => {
      const [user] = await tx
        .select({ id: authUser.id, name: authUser.name, email: authUser.email })
        .from(authUser)
        .where(eq(authUser.id, principal.userId));
      const [org] = await tx
        .select({ id: orgs.id, slug: orgs.slug, name: orgs.name })
        .from(orgs)
        .where(eq(orgs.id, orgId));
      return {
        kind: principal.kind,
        user: user ?? { id: principal.userId },
        ...(principal.runId ? { runId: principal.runId } : {}),
        clientId: principal.clientId ?? null,
        scopes: principal.scopes,
        org: org ? { ...org, role: await orgRoleOf(tx, principal.userId) } : { id: orgId },
      };
    },
  });

  registry.register({
    name: "orgs_list",
    title: "Danh sách tổ chức",
    description: "Liệt kê các tổ chức bạn là thành viên, kèm vai trò.",
    input: z.object({ limit: LIMIT, offset: OFFSET }),
    readOnly: true,
    handler: async ({ limit, offset = 0 }, { tx, principal }) => {
      const size = limit ?? 10;
      const rows = await myOrgs(tx, principal.userId, size + 1, offset);
      return {
        orgs: rows.slice(0, size),
        truncated: rows.length > size,
        nextOffset: rows.length > size ? offset + size : null,
      };
    },
  });

  registry.register({
    name: "teams_list",
    title: "Danh sách đội",
    description: "Liệt kê các đội trong tổ chức, kèm số hệ thống và số thành viên.",
    input: z.object({ limit: LIMIT, offset: OFFSET }),
    readOnly: true,
    handler: async ({ limit, offset = 0 }, { tx }) => {
      const size = limit ?? 10;
      const rows = await tx
        .select({
          id: teams.id,
          slug: teams.slug,
          name: teams.name,
          createdAt: teams.createdAt,
          // Ghi rõ "teams"."id" vì trong subquery "id" sẽ trỏ nhầm sang bảng con (xem teams.ts).
          systemCount: sql<number>`(select count(*)::int from hive.systems s where s.team_id = "teams"."id")`,
          memberCount: sql<number>`(select count(*)::int from hive.team_members m where m.team_id = "teams"."id")`,
        })
        .from(teams)
        .orderBy(asc(teams.name))
        .limit(size + 1)
        .offset(offset);
      return {
        teams: rows.slice(0, size).map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
        truncated: rows.length > size,
        nextOffset: rows.length > size ? offset + size : null,
      };
    },
  });

  registry.register({
    name: "systems_list",
    title: "Danh sách hệ thống",
    description: "Liệt kê các hệ thống trong tổ chức; truyền teamId để lọc theo một đội.",
    input: z.object({
      limit: LIMIT,
      offset: OFFSET,
      teamId: z.uuid().optional().describe("Mã đội cần lọc (lấy từ teams_list)."),
    }),
    readOnly: true,
    handler: async ({ teamId, limit, offset = 0 }, { tx }) => {
      const size = limit ?? 10;
      const rows = await tx
        .select({
          id: systems.id,
          teamId: systems.teamId,
          slug: systems.slug,
          name: systems.name,
          description: systems.description,
          createdAt: systems.createdAt,
        })
        .from(systems)
        .where(teamId ? eq(systems.teamId, teamId) : undefined)
        .orderBy(asc(systems.name))
        .limit(size + 1)
        .offset(offset);
      return {
        systems: rows.slice(0, size).map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
        truncated: rows.length > size,
        nextOffset: rows.length > size ? offset + size : null,
      };
    },
  });
}
