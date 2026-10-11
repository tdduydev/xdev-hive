import { asc, eq } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { NotFoundError, type Tx } from "../platform/index.ts";
import { requireTeamRole } from "./permissions.ts";
import { iso, onUnique, type Procedures, slugTaken } from "./procedures.ts";
import { systems } from "./schema.ts";
import { getTeam } from "./teams.ts";

const toSystem = (s: typeof systems.$inferSelect) => ({
  id: s.id,
  teamId: s.teamId,
  slug: s.slug,
  name: s.name,
  description: s.description,
  createdAt: iso(s.createdAt),
});

async function getSystem(tx: Tx, systemId: string) {
  const [row] = await tx.select().from(systems).where(eq(systems.id, systemId));
  if (!row) throw new NotFoundError("SYSTEM_NOT_FOUND", "Không tìm thấy hệ thống.");
  return row;
}

export function systemsRouter({ inOrg }: Procedures) {
  return {
    // Mọi thành viên tổ chức xem được danh sách hệ thống để chọn khi tạo dự án (M2); sửa thì cần quản trị đội.
    list: inOrg.systems.list.handler(async ({ context: { tx }, input }) => {
      const rows = await tx
        .select()
        .from(systems)
        .where(input.teamId ? eq(systems.teamId, input.teamId) : undefined)
        .orderBy(asc(systems.name));
      return rows.map(toSystem);
    }),

    create: inOrg.systems.create.handler(async ({ context: { tx, user, orgId }, input }) => {
      const team = await getTeam(tx, input.teamId);
      await requireTeamRole(tx, user.id, team.id, "admin");
      const [row] = await onUnique(
        () =>
          tx
            .insert(systems)
            .values({ orgId, teamId: team.id, slug: input.slug, name: input.name, description: input.description })
            .returning(),
        slugTaken("systems_team_slug", "hệ thống", input.slug),
      );
      if (!row) throw new Error("Không tạo được hệ thống.");
      await recordAudit(tx, {
        action: "system.create",
        targetType: "system",
        targetId: row.id,
        data: { teamId: team.id, name: row.name, slug: row.slug },
      });
      return toSystem(row);
    }),

    update: inOrg.systems.update.handler(async ({ context: { tx, user }, input }) => {
      const current = await getSystem(tx, input.systemId);
      await requireTeamRole(tx, user.id, current.teamId, "admin");
      const { systemId: _, ...changes } = input;
      const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      if (Object.keys(set).length === 0) return toSystem(current);
      const [row] = await onUnique(
        () => tx.update(systems).set(set).where(eq(systems.id, current.id)).returning(),
        slugTaken("systems_team_slug", "hệ thống", input.slug ?? ""),
      );
      if (!row) throw new NotFoundError("SYSTEM_NOT_FOUND", "Không tìm thấy hệ thống.");
      await recordAudit(tx, { action: "system.update", targetType: "system", targetId: row.id, data: set });
      return toSystem(row);
    }),

    remove: inOrg.systems.remove.handler(async ({ context: { tx, user }, input }) => {
      const current = await getSystem(tx, input.systemId);
      await requireTeamRole(tx, user.id, current.teamId, "admin");
      await tx.delete(systems).where(eq(systems.id, current.id));
      await recordAudit(tx, {
        action: "system.delete",
        targetType: "system",
        targetId: current.id,
        data: { teamId: current.teamId, name: current.name, slug: current.slug },
      });
      return { ok: true as const };
    }),
  };
}
