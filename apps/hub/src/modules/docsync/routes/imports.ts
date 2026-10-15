import { ORPCError } from "@orpc/server";
import type { Jobs } from "../../platform/index.ts";
import {
  cancelImport,
  confirmSecret,
  getImport,
  listImportFiles,
  listImports,
  scanImport,
  startImport,
} from "../import.ts";
import { type DocSyncRouteDeps, docSyncApi } from "./common.ts";

export function requireJobs(deps: DocSyncRouteDeps): Jobs {
  if (!deps.jobs)
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Hub chưa cấu hình hàng đợi đồng bộ tài liệu." });
  return deps.jobs;
}

export function importsRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).docImports;
  return {
    scan: api.scan.handler(({ context, input }) =>
      scanImport(context.tx, requireJobs(deps), { orgId: context.orgId, userId: context.user.id }, input),
    ),
    get: api.get.handler(({ context, input }) =>
      getImport(context.tx, { orgId: context.orgId, userId: context.user.id }, input.id),
    ),
    files: api.files.handler(({ context, input }) =>
      listImportFiles(context.tx, { orgId: context.orgId, userId: context.user.id }, input),
    ),
    start: api.start.handler(({ context, input }) =>
      startImport(context.tx, requireJobs(deps), { orgId: context.orgId, userId: context.user.id }, input),
    ),
    cancel: api.cancel.handler(({ context, input }) =>
      cancelImport(context.tx, { orgId: context.orgId, userId: context.user.id }, input.id),
    ),
    confirmSecret: api.confirmSecret.handler(({ context, input }) =>
      confirmSecret(context.tx, requireJobs(deps), { orgId: context.orgId, userId: context.user.id }, input),
    ),
    list: api.list.handler(({ context, input }) =>
      listImports(context.tx, { orgId: context.orgId, userId: context.user.id }, input),
    ),
  };
}
