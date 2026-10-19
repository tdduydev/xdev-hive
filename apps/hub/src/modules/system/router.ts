import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import { cli } from "@xdev-hive/contracts/worker-protocol";
import type { HubConfig, RequestContext } from "../platform/index.ts";
import { DesktopReleaseCache, findDesktopUpdate } from "./desktop-updates.ts";

/** Công cụ nhập Word đã dò lúc khởi động; lớp ghép đưa vào để `system` không phụ thuộc `docsync`. */
export type WordImportHealth = () => { wordImport: boolean; wordImportDoc: boolean };

export function systemRouter(
  config: HubConfig,
  desktopReleases: DesktopReleaseCache = new DesktopReleaseCache(config.desktopReleases),
  wordImport: WordImportHealth = () => ({ wordImport: false, wordImportDoc: false }),
) {
  const os = implement(contract.system).$context<RequestContext>();
  return {
    health: os.health.handler(() => ({
      status: "ok" as const,
      version: config.version,
      time: new Date().toISOString(),
      builtAt: config.builtAt ?? null,
      clis: [...cli.options],
      artifacts: true as const,
      ...wordImport(),
    })),
    desktopUpdate: os.desktopUpdate.handler(async ({ input }) => {
      const result = await findDesktopUpdate(desktopReleases, input.os, input.arch, input.currentVersion);
      return result.kind === "update" ? result.update : null;
    }),
  };
}
