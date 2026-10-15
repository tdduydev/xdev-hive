import { eq } from "drizzle-orm";
import { loadProject } from "../catalog/index.ts";
import type { Tx } from "../platform/index.ts";
import { sdlcSettingsOf } from "./items.ts";
import { sdlcArtifactSyncs } from "./schema.ts";

/** Giữ cả đường dẫn đã đồng bộ khi SDLC tắt để hai hệ không cùng ghi một file. */
export async function sdlcManagedPaths(tx: Tx, projectId: string): Promise<string[]> {
  const project = await loadProject(tx, projectId);
  if (!project) return [];
  const paths = await tx
    .select({ path: sdlcArtifactSyncs.repoPath })
    .from(sdlcArtifactSyncs)
    .where(eq(sdlcArtifactSyncs.projectId, projectId));
  const root = sdlcSettingsOf(project).docsRoot;
  return [...new Set([...(root ? [root] : []), ...paths.map((row) => row.path)])];
}
