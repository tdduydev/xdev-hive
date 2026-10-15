import { ORPCError } from "@orpc/server";
import { ConflictSecretError, getConflict, listConflicts, resolveConflict } from "../conflicts.ts";
import { queuePush } from "../jobs.ts";
import { type DocSyncRouteDeps, docSyncApi } from "./common.ts";

export function conflictsRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).docConflicts;
  return {
    list: api.list.handler(({ context, input }) =>
      listConflicts(context.tx, { kind: "user", userId: context.user.id }, input),
    ),
    get: api.get.handler(({ context, input }) =>
      getConflict(context.tx, { kind: "user", userId: context.user.id }, input.id),
    ),
    resolve: api.resolve.handler(async ({ context, input }) => {
      try {
        return await resolveConflict(context.tx, { kind: "user", userId: context.user.id }, input, (tx, home) => {
          if (!deps.jobs)
            throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Hub chưa cấu hình hàng đợi đồng bộ tài liệu." });
          return queuePush(deps.jobs, home, { tx });
        });
      } catch (error) {
        if (error instanceof ConflictSecretError)
          throw new ORPCError("DOC_SECRET_FOUND", {
            status: 400,
            message: error.message,
            data: { code: "DOC_SECRET_FOUND", findings: error.findings },
            cause: error,
          });
        throw error;
      }
    }),
  };
}
