import { notImplemented, type QaRouteDeps, qaApi } from "../deps.ts";

export function roundsExportRoutes(deps: QaRouteDeps) {
  const api = qaApi(deps).rounds;
  return {
    export: api.export.handler(notImplemented),
  };
}
