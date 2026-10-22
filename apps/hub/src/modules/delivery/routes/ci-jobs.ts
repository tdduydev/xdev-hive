import { addProjectJob, listProjectJobs, removeProjectJob } from "../ci/project-jobs.ts";
import { type DeliveryRouteDeps, deliveryApi } from "../deps.ts";

/** Job Jenkins gắn với dự án (FR-002). */
export function ciJobsRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).ciJobs;
  return {
    list: api.list.handler(({ context, input }) => listProjectJobs(context.tx, context.user.id, input.projectId)),
    add: api.add.handler(({ context, input }) => addProjectJob(context.tx, deps, context.user.id, input)),
    remove: api.remove.handler(({ context, input }) => removeProjectJob(context.tx, context.user.id, input)),
  };
}
