import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import { cli } from "@xdev-hive/contracts/worker-protocol";
import type { HubConfig, RequestContext } from "../platform/index.ts";
import { DesktopReleaseCache, findDesktopUpdate } from "./desktop-updates.ts";

export function systemRouter(
  config: HubConfig,
  desktopReleases: DesktopReleaseCache = new DesktopReleaseCache(config.desktopReleases),
) {
  const os = implement(contract.system).$context<RequestContext>();
  return {
    health: os.health.handler(() => ({
      status: "ok" as const,
      version: config.version,
      time: new Date().toISOString(),
      clis: [...cli.options],
    })),
    desktopUpdate: os.desktopUpdate.handler(async ({ input }) => {
      const result = await findDesktopUpdate(desktopReleases, input.os, input.arch, input.currentVersion);
      return result.kind === "update" ? result.update : null;
    }),
  };
}
