import type { SdlcArtifactView } from "@xdev-hive/contracts";
import { inArray } from "drizzle-orm";
import { loadProject } from "../catalog/index.ts";
import type { Tx } from "../platform/index.ts";
import { sdlcArtifactSyncs, type sdlcArtifacts, type sdlcItems } from "./schema.ts";

type ArtifactRow = typeof sdlcArtifacts.$inferSelect;

/**
 * View tài liệu của hạng mục, cả trạng thái đồng bộ theo repo. Tách khỏi items.ts để contract (T016) trả đúng dạng này
 * mà không import items.ts (items → phases → contracts sẽ thành vòng).
 */
export async function artifactViews(
  tx: Tx,
  item: Pick<typeof sdlcItems.$inferSelect, "mode">,
  rows: readonly ArtifactRow[],
  projectKeys: ReadonlyMap<string, string> = new Map(),
): Promise<SdlcArtifactView[]> {
  if (!rows.length) return [];
  const syncs = await tx
    .select()
    .from(sdlcArtifactSyncs)
    .where(
      inArray(
        sdlcArtifactSyncs.artifactId,
        rows.map((a) => a.id),
      ),
    );
  const keys = new Map(projectKeys);
  for (const id of new Set(syncs.map((s) => s.projectId)))
    if (!keys.has(id)) keys.set(id, (await loadProject(tx, id))?.key ?? "");
  const nameOf = new Map(item.mode.phases.flatMap((p) => p.artifacts.map((a) => [`${p.id}/${a.id}`, a.name])));
  const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);
  return rows.map((a) => ({
    id: a.id,
    phaseId: a.phaseId,
    artifactId: a.artifactId,
    name: nameOf.get(`${a.phaseId}/${a.artifactId}`) ?? a.artifactId,
    scope: a.scope,
    instance: a.instance,
    required: a.required,
    docKey: a.docKey,
    repoPath: a.repoPath,
    projectId: a.projectId,
    consumerProjectIds: a.consumerProjectIds,
    contractFormat: (a.contractFormat as SdlcArtifactView["contractFormat"]) ?? null,
    baselineVersion: a.baselineVersion,
    approval: a.approval,
    // Phiên duyệt và bản nháp nằm ở `knowledge`; màn hạng mục mở trình soạn theo `docKey` để xem.
    reviewId: null,
    hasDraft: false,
    syncs: syncs
      .filter((s) => s.artifactId === a.id)
      .map((s) => ({
        projectId: s.projectId,
        projectKey: keys.get(s.projectId) ?? "",
        kind: s.kind,
        repoPath: s.repoPath,
        state: s.syncState,
        syncedVersion: s.syncedVersion,
        syncedCommit: s.syncedCommit,
        error: s.syncError,
        attempts: s.syncAttempts,
        syncedAt: isoOrNull(s.syncedAt),
        prUrl: null,
      })),
  }));
}
