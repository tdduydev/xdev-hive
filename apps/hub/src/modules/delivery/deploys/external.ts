import type { Jobs } from "../../platform/index.ts";
import type { DeliveryDeps } from "../deps.ts";

/** Ghi lần triển khai "ngoài Hive" từ build Jenkins (plan.md mục 4). Làm ở task sau. */
export async function registerExternalDeploys(_jobs: Jobs, _deps: DeliveryDeps): Promise<void> {}
