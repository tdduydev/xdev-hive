import type { Jobs } from "../platform/index.ts";
import type { DeliveryDeps } from "./deps.ts";

/** Xoá log triển khai quá hạn qua hive.purge_deploy_logs(). Làm ở task sau. */
export async function registerRetention(_jobs: Jobs, _deps: DeliveryDeps): Promise<void> {}
