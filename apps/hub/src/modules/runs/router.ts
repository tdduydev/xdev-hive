import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import { recordAudit } from "../audit/index.ts";
import { ConflictError, type RequestContext, withTenant } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { type RunsEngine, runForUser } from "./engine.ts";
import { getRun, latestRuns, listEvents, listLogs, listRuns, searchRuns, withMachineNames } from "./queries.ts";

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
      const { run, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, async (tx) => {
        const started = await e.startRun(tx, user.id, input);
        const [named = started.run] = await withMachineNames(tx, [started.run]);
        return { ...started, run: named };
      });
      afterCommit();
      return run;
    }),
    cancel: os.cancel.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
      const e = engine();
      const { run, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, async (tx) => {
        const cancelled = await e.cancelRun(tx, user.id, input.id);
        const [named = cancelled.run] = await withMachineNames(tx, [cancelled.run]);
        return { ...cancelled, run: named };
      });
      afterCommit();
      return run;
    }),
    steer: os.steer.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
      const e = engine();
      const { status, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, async (tx) => {
        await runForUser(tx, user.id, input.id, "member");
        const steered = await e.steerRun(tx, input.id, input.input, user.id);
        await recordAudit(tx, {
          action: "run.steer",
          targetType: "run",
          targetId: input.id,
          data: { status: steered.status },
        });
        return steered;
      });
      afterCommit();
      return { status };
    }),
    latest: os.latest
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => latestRuns(tx, user.id, input.projectId)),
    search: os.search.use(inOrg).handler(({ context: { tx, user }, input }) => searchRuns(tx, user.id, input)),
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
