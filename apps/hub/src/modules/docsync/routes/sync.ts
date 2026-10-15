import { type DocSyncRouteDeps, docSyncApi, notImplemented } from "./common.ts";

export function syncRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).docHomes;
  return {
    pause: api.pause.handler(notImplemented),
    resume: api.resume.handler(notImplemented),
    acceptBranch: api.acceptBranch.handler(notImplemented),
    syncNow: api.syncNow.handler(notImplemented),
    status: api.status.handler(notImplemented),
  };
}
