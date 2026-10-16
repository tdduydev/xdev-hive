import { ORPCError } from "@orpc/server";
import {
  approveExtract,
  confirmExtractSecret,
  ExtractSecretError,
  getExtract,
  listExtracts,
  rejectExtract,
  updateExtract,
} from "../extracts.ts";
import { type DocSyncRouteDeps, docSyncApi } from "./common.ts";

export function extractsRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).docExtracts;
  return {
    list: api.list.handler(({ context, input }) =>
      listExtracts(context.tx, { kind: "user", userId: context.user.id }, input),
    ),
    get: api.get.handler(({ context, input }) =>
      getExtract(context.tx, { kind: "user", userId: context.user.id }, input.id),
    ),
    update: api.update.handler(({ context, input }) =>
      updateExtract(context.tx, { kind: "user", userId: context.user.id }, input),
    ),
    approve: api.approve.handler(async ({ context, input }) => {
      try {
        return await approveExtract(context.tx, { kind: "user", userId: context.user.id }, input);
      } catch (error) {
        if (error instanceof ExtractSecretError)
          throw new ORPCError("DOC_SECRET_FOUND", {
            status: 400,
            message: error.message,
            data: { code: "DOC_SECRET_FOUND", findings: error.findings },
            cause: error,
          });
        throw error;
      }
    }),
    reject: api.reject.handler(({ context, input }) =>
      rejectExtract(context.tx, { kind: "user", userId: context.user.id }, input),
    ),
    confirmSecret: api.confirmSecret.handler(({ context, input }) =>
      confirmExtractSecret(context.tx, { kind: "user", userId: context.user.id }, input),
    ),
  };
}
