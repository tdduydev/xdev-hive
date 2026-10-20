import type { Jobs } from "../platform/index.ts";
import type { DeliveryDeps } from "./deps.ts";

/** Hết hạn lần chờ duyệt (plan.md mục 8). Làm ở task sau. */
export async function registerApprovals(_jobs: Jobs, _deps: DeliveryDeps): Promise<void> {}
