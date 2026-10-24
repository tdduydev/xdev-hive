import { implement, ORPCError } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import { cli } from "@xdev-hive/contracts/worker-protocol";
import type { HubConfig, RequestContext } from "../platform/index.ts";
import { type DbEpochCache, dbEpochCache } from "./db-epoch.ts";
import { DesktopReleaseCache, findDesktopUpdate } from "./desktop-updates.ts";
import { type JobsHeartbeat, jobsHeartbeat } from "./jobs-health.ts";

/** Công cụ nhập Word đã dò lúc khởi động; lớp ghép đưa vào để `system` không phụ thuộc `docsync`. */
export type WordImportHealth = () => { wordImport: boolean; wordImportDoc: boolean };

export function systemRouter(
  config: HubConfig,
  desktopReleases: DesktopReleaseCache = new DesktopReleaseCache(config.desktopReleases),
  wordImport: WordImportHealth = () => ({ wordImport: false, wordImportDoc: false }),
  heartbeat: JobsHeartbeat = jobsHeartbeat,
  epoch: DbEpochCache = dbEpochCache,
) {
  const os = implement(contract.system).$context<RequestContext>();
  const roles = config.roles ?? ["api", "jobs"];
  return {
    health: os.health.handler(async () => ({
      status: "ok" as const,
      version: config.version,
      time: new Date().toISOString(),
      builtAt: config.builtAt ?? null,
      clis: [...cli.options],
      artifacts: true as const,
      ...wordImport(),
      roles: [...roles],
      ...(await epoch.current()),
    })),
    healthJobs: os.healthJobs.handler(() => {
      const status = heartbeat.status();
      // 503 để healthcheck của compose chỉ cần xem mã HTTP, không phải đọc body.
      if (!status.ok)
        throw new ORPCError("SERVICE_UNAVAILABLE", { message: status.reason, data: { lastTickAt: status.lastTickAt } });
      return status;
    }),
    desktopUpdate: os.desktopUpdate.handler(async ({ input }) => {
      const result = await findDesktopUpdate(desktopReleases, input.os, input.arch, input.currentVersion);
      return result.kind === "update" ? result.update : null;
    }),
  };
}
