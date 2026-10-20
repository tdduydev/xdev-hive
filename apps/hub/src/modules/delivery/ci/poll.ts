import type { Jobs } from "../../platform/index.ts";
import type { DeliveryDeps } from "../deps.ts";

/** Đọc Jenkins theo lịch, so với ci_runs_seen để báo đỏ/xanh (plan.md mục 4). Làm ở task sau. */
export async function registerCiPoll(_jobs: Jobs, _deps: DeliveryDeps): Promise<void> {}
