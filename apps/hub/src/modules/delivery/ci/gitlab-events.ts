import type { Jobs } from "../../platform/index.ts";
import type { DeliveryDeps } from "../deps.ts";

/** Sự kiện pipeline/job từ webhook GitLab (plan.md mục 3). Làm ở task sau. */
export async function registerGitlabEvents(_jobs: Jobs, _deps: DeliveryDeps): Promise<void> {}
