import type { Jobs } from "../../platform/index.ts";
import type { DeliveryDeps } from "../deps.ts";

/** Hàng delivery-deploy và delivery-deploy-watch: máy trạng thái, khoá đích (plan.md mục 5). Làm ở task sau. */
export async function registerOrchestrator(_jobs: Jobs, _deps: DeliveryDeps): Promise<void> {}
