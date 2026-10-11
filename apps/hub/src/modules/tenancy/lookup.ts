import { eq } from "drizzle-orm";
import type { Tx } from "../platform/index.ts";
import { systems } from "./schema.ts";

export interface SystemRef {
  id: string;
  orgId: string;
  teamId: string;
  slug: string;
  name: string;
}

/** Hệ thống trong tổ chức của context; RLS lọc hệ thống của tổ chức khác nên id lạ trả null. */
export async function findSystem(tx: Tx, id: string): Promise<SystemRef | null> {
  const [row] = await tx
    .select({ id: systems.id, orgId: systems.orgId, teamId: systems.teamId, slug: systems.slug, name: systems.name })
    .from(systems)
    .where(eq(systems.id, id));
  return row ?? null;
}
