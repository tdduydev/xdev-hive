import { type DocSyncRouteDeps, docSyncApi, notImplemented } from "./common.ts";

export function homesRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).docHomes;
  return {
    get: api.get.handler(notImplemented),
    configureProject: api.configureProject.handler(notImplemented),
    configureOrg: api.configureOrg.handler(notImplemented),
    remove: api.remove.handler(notImplemented),
    adoptPreview: api.adoptPreview.handler(notImplemented),
    adopt: api.adopt.handler(notImplemented),
  };
}
