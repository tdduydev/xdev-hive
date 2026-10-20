import type { Jobs } from "../../platform/index.ts";
import type { DeliveryDeps } from "../deps.ts";

/** Đăng ký lại webhook GitLab có thêm pipeline_events, job_events (plan.md mục 3). Làm ở task sau. */
export async function registerWebhookRefresh(_jobs: Jobs, _deps: DeliveryDeps): Promise<void> {}
