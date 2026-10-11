import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import { ConflictError, type RequestContext, withTenant } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import type { RunsEngine } from "./engine.ts";
import { getRun, listEvents, listLogs, listRuns } from "./queries.ts";

export interface RunsRouterDeps extends OrgDeps {
  /** Không có khi hub thiếu HIVE_AUTH_SECRET (không ký được run token): chỉ xem được, không giao hay huỷ được. */
  engine?: RunsEngine | undefined;
}

export function runsRouter(deps: RunsRouterDeps) {
  const { authed, inOrg, orgMember } = orgMiddlewares(deps);
  const os = implement(contract.runs).$context<RequestContext>().use(authed);
  const engine = () => {
    if (!deps.engine) {
      throw new ConflictError("RUNS_DISABLED", "Hub chưa cấu hình HIVE_AUTH_SECRET nên chưa giao hay huỷ được run.");
    }
    return deps.engine;
  };
  return {
    // start và cancel tự mở transaction để gửi gói tới máy sau khi commit, không gửi khi transaction rollback.
    start: os.start.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
      const e = engine();
      const { run, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, (tx) =>
        e.startRun(tx, user.id, input),
      );
      afterCommit();
      return run;
    }),
    cancel: os.cancel.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
      const e = engine();
      const { run, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, (tx) =>
        e.cancelRun(tx, user.id, input.id),
      );
      afterCommit();
      return run;
    }),
    list: os.list.use(inOrg).handler(({ context: { tx, user }, input }) => listRuns(tx, user.id, input.taskId)),
    get: os.get.use(inOrg).handler(({ context: { tx, user }, input }) => getRun(tx, user.id, input.id)),
    events: os.events
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => listEvents(tx, user.id, input.id, input.after, input.limit)),
    logs: os.logs
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => listLogs(tx, user.id, input.id, input.after, input.limit)),
  };
}
