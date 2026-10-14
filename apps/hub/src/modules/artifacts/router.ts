import { implement, ORPCError, os } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type pg from "pg";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  type Jobs,
  NotFoundError,
  type RequestContext,
  type Tx,
} from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares, type SessionUser } from "../tenancy/index.ts";
import type { ArtifactErrorDetail } from "./access.ts";
import { readerFor } from "./access.ts";
import { createPreview, frameDocument, frameUrl, libManifestLoader } from "./frame-routes.ts";
import { createPublicLink, listPublicLinks, orgListPublicLinks, revokePublicLink } from "./public-links.ts";
import {
  addLink,
  createArtifact,
  deleteArtifact,
  duplicateArtifact,
  getArtifact,
  getSettings,
  listArtifacts,
  listLinks,
  removeLink,
  renameArtifact,
  restoreArtifact,
  restoreVersion,
  setScope,
  transferOwner,
  updateArtifact,
  usage,
} from "./service.ts";
import { isSecretBlocked, listVersions, recordSecretBlocked, renameVersion, tombstoneVersion } from "./versions.ts";

export interface ArtifactsRouterDeps extends OrgDeps {
  jobs?: Jobs | undefined;
  publicUrl?: string | undefined;
  /** Khoá vé khung (`frameTicketKey`); không có thì `frameUrl` và `preview` báo hub chưa đặt khoá chủ. */
  frameKey?: Buffer | undefined;
}

const STATUS = [
  [ForbiddenError, "FORBIDDEN"],
  [NotFoundError, "NOT_FOUND"],
  [ConflictError, "CONFLICT"],
  [BadRequestError, "BAD_REQUEST"],
] as const;

/**
 * Lỗi `ARTIFACT_*` có chi tiết (dòng bí mật, bản mới nhất khi xung đột, giới hạn) thì đổi thành lỗi oRPC ngay ở đây:
 * `mapDomainErrors` chung chỉ giữ `code`. Lỗi bí mật còn được ghi audit bằng transaction riêng, vì transaction của
 * request đã rollback cùng lỗi.
 */
const artifactErrors = os
  .$context<RequestContext & { user: SessionUser; pool: pg.Pool }>()
  .middleware(async ({ context, next }) => {
    try {
      return await next();
    } catch (error) {
      const orgId = (error as { orgId?: string }).orgId;
      if (isSecretBlocked(error) && orgId)
        await recordSecretBlocked(context.pool, { orgId, userId: context.user.id }, error);
      const detail = (error as { detail?: ArtifactErrorDetail }).detail;
      const status = STATUS.find(([cls]) => error instanceof cls)?.[1];
      if (!detail || !status) throw error;
      const { code, message } = error as { code: string; message: string };
      throw new ORPCError(status, { message, data: { code, ...detail }, cause: error });
    }
  });

/** Ghi tổ chức vào lỗi bí mật trước khi rời transaction, để `artifactErrors` biết ghi audit vào đâu. */
const stampOrg = os.$context<{ orgId: string }>().middleware(async ({ context, next }) => {
  try {
    return await next();
  } catch (error) {
    if (isSecretBlocked(error)) Object.assign(error, { orgId: context.orgId });
    throw error;
  }
});

/**
 * Route `artifacts.*`. `askLeaderFix` ở T016, `toDoc`/`toRepo` sau MVP: chưa đăng ký thì oRPC
 * trả 404 cho route đó.
 */
export function artifactsRouter(deps: ArtifactsRouterDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const o = implement(contract.artifacts)
    .$context<RequestContext>()
    .use(authed)
    .use(artifactErrors)
    .use(inOrg)
    .use(stampOrg);
  const write = { jobs: deps.jobs, publicUrl: deps.publicUrl };
  const as = (tx: Tx, user: SessionUser) => readerFor(tx, { kind: "user", userId: user.id });
  const frame = { frameKey: deps.frameKey, publicUrl: deps.publicUrl ?? "http://localhost:3000" };
  const manifest = libManifestLoader();
  return {
    settings: o.settings.handler(({ context: { tx } }) => getSettings(tx)),
    list: o.list.handler(async ({ context: { tx, user }, input }) => listArtifacts(tx, await as(tx, user), input)),
    get: o.get.handler(async ({ context: { tx, user }, input }) => getArtifact(tx, await as(tx, user), input)),
    create: o.create.handler(async ({ context: { tx, user }, input }) =>
      createArtifact(tx, await as(tx, user), input, write),
    ),
    update: o.update.handler(async ({ context: { tx, user }, input }) =>
      updateArtifact(tx, await as(tx, user), input, write),
    ),
    rename: o.rename.handler(async ({ context: { tx, user }, input }) => renameArtifact(tx, await as(tx, user), input)),
    setScope: o.setScope.handler(async ({ context: { tx, user }, input }) => setScope(tx, await as(tx, user), input)),
    transferOwner: o.transferOwner.handler(async ({ context: { tx, user }, input }) =>
      transferOwner(tx, await as(tx, user), input, write),
    ),
    duplicate: o.duplicate.handler(async ({ context: { tx, user }, input }) =>
      duplicateArtifact(tx, await as(tx, user), input, write),
    ),
    delete: o.delete.handler(async ({ context: { tx, user }, input }) =>
      deleteArtifact(tx, await as(tx, user), input, write),
    ),
    restore: o.restore.handler(async ({ context: { tx, user }, input }) =>
      restoreArtifact(tx, await as(tx, user), input),
    ),
    versions: {
      list: o.versions.list.handler(async ({ context: { tx, user }, input }) =>
        listVersions(tx, await as(tx, user), input.id),
      ),
      rename: o.versions.rename.handler(async ({ context: { tx, user }, input }) =>
        renameVersion(tx, await as(tx, user), input),
      ),
      restore: o.versions.restore.handler(async ({ context: { tx, user }, input }) =>
        restoreVersion(tx, await as(tx, user), input, write),
      ),
      tombstone: o.versions.tombstone.handler(async ({ context: { tx, user }, input }) =>
        tombstoneVersion(tx, await as(tx, user), input, write),
      ),
    },
    links: {
      list: o.links.list.handler(async ({ context: { tx, user }, input }) => listLinks(tx, await as(tx, user), input)),
      add: o.links.add.handler(async ({ context: { tx, user }, input }) => addLink(tx, await as(tx, user), input)),
      remove: o.links.remove.handler(async ({ context: { tx, user }, input }) =>
        removeLink(tx, await as(tx, user), input),
      ),
    },
    frameUrl: o.frameUrl.handler(async ({ context: { tx, user }, input }) =>
      frameUrl(tx, await as(tx, user), input, frame),
    ),
    preview: o.preview.handler(async ({ context: { tx, user }, input }) =>
      createPreview(tx, await as(tx, user), input, frame),
    ),
    frameDocument: o.frameDocument.handler(async ({ context: { tx, user }, input }) =>
      frameDocument(tx, await as(tx, user), input, manifest),
    ),
    usage: o.usage.handler(({ context: { tx, user } }) => usage(tx, user.id)),
    publicLinks: {
      create: o.publicLinks.create.handler(async ({ context: { tx, user }, input }) =>
        createPublicLink(tx, await as(tx, user), input, frame),
      ),
      list: o.publicLinks.list.handler(async ({ context: { tx, user }, input }) =>
        listPublicLinks(tx, await as(tx, user), input),
      ),
      revoke: o.publicLinks.revoke.handler(async ({ context: { tx, user }, input }) =>
        revokePublicLink(tx, await as(tx, user), input, write),
      ),
      orgList: o.publicLinks.orgList.handler(({ context: { tx, user }, input }) =>
        orgListPublicLinks(tx, user.id, input),
      ),
    },
  };
}
