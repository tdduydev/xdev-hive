import { eq, inArray } from "drizzle-orm";
import { artifactError, type LinkTarget, readerUserId } from "../artifacts/index.ts";
import { ForbiddenError, NotFoundError } from "../platform/index.ts";
import { canReadItem, hasTeamPermission, itemForUser } from "./access.ts";
import { sdlcItems } from "./schema.ts";

/**
 * Hạng mục AI SDLC làm đích gắn artifact (specs/012 T065). Chỉ cài đặt đích: màn hạng mục và luồng AI SDLC thuộc
 * specs/035. Gắn đòi `sdlc.write` ở đội chủ trì, quyền ghi thông thường của hạng mục.
 */
export function createSdlcItemLinkTarget(): LinkTarget {
  return {
    kind: "sdlc_item",
    assertWritable: async (tx, reader, itemId) => {
      const userId = readerUserId(reader);
      if (!userId) throw artifactError("ARTIFACT_LINK_FORBIDDEN");
      try {
        const item = await itemForUser(tx, userId, itemId);
        if (!(await hasTeamPermission(tx, userId, item.teamId, "sdlc.write")))
          throw artifactError("ARTIFACT_LINK_FORBIDDEN");
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof ForbiddenError)
          throw artifactError("ARTIFACT_LINK_FORBIDDEN");
        throw error;
      }
    },
    projectOf: async (tx, itemId) => {
      const [item] = await tx
        .select({ projectId: sdlcItems.projectId })
        .from(sdlcItems)
        .where(eq(sdlcItems.id, itemId));
      return item?.projectId ?? null;
    },
    titles: async (tx, reader, itemIds) => {
      const userId = readerUserId(reader);
      const titles = new Map<string, string>();
      if (!userId) return titles;
      const rows = await tx.select().from(sdlcItems).where(inArray(sdlcItems.id, itemIds));
      for (const row of rows) if (await canReadItem(tx, userId, row)) titles.set(row.id, row.title);
      return titles;
    },
    existing: async (tx, itemIds) => {
      const rows = await tx.select({ id: sdlcItems.id }).from(sdlcItems).where(inArray(sdlcItems.id, itemIds));
      return new Set(rows.map((r) => r.id));
    },
  };
}
