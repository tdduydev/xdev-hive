import { changeHomeState, configureOrgHome, configureProjectHome, getHome, homeView, removeHome } from "../homes.ts";
import { type DocSyncRouteDeps, docSyncApi, notImplemented } from "./common.ts";

export function homesRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).docHomes;
  return {
    get: api.get.handler(async ({ context, input }) => {
      const row = await getHome(context.tx, context.user.id, input.project);
      return row ? homeView(row, deps) : null;
    }),
    configureProject: api.configureProject.handler(async ({ context, input }) =>
      homeView(
        await configureProjectHome(context.tx, deps, { orgId: context.orgId, userId: context.user.id }, input),
        deps,
      ),
    ),
    configureOrg: api.configureOrg.handler(async ({ context, input }) =>
      homeView(
        await configureOrgHome(context.tx, deps, { orgId: context.orgId, userId: context.user.id }, input),
        deps,
      ),
    ),
    remove: api.remove.handler(({ context, input }) =>
      removeHome(context.tx, deps, { orgId: context.orgId, userId: context.user.id }, input.homeId),
    ),
    pause: api.pause.handler(async ({ context, input }) =>
      homeView(
        await changeHomeState(
          context.tx,
          deps,
          { orgId: context.orgId, userId: context.user.id },
          input.homeId,
          "pause",
        ),
        deps,
      ),
    ),
    resume: api.resume.handler(async ({ context, input }) =>
      homeView(
        await changeHomeState(
          context.tx,
          deps,
          { orgId: context.orgId, userId: context.user.id },
          input.homeId,
          "resume",
        ),
        deps,
      ),
    ),
    acceptBranch: api.acceptBranch.handler(async ({ context, input }) =>
      homeView(
        await changeHomeState(
          context.tx,
          deps,
          { orgId: context.orgId, userId: context.user.id },
          input.homeId,
          "acceptBranch",
          input.branch,
        ),
        deps,
      ),
    ),
    adoptPreview: api.adoptPreview.handler(notImplemented),
    adopt: api.adopt.handler(notImplemented),
  };
}
