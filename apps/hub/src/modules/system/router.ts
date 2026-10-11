import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { HubConfig } from "../platform/index.ts";

export function systemRouter(config: HubConfig) {
  const os = implement(contract.system);
  return {
    health: os.health.handler(() => ({
      status: "ok" as const,
      version: config.version,
      time: new Date().toISOString(),
    })),
  };
}
