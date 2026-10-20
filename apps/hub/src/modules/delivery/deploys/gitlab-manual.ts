import { type DeployMethod, notImplementedMethod } from "./method.ts";

/** Bấm job chờ tay của pipeline GitLab (plan.md mục 6). Làm ở task sau. */
export const gitlabManual: DeployMethod = notImplementedMethod("gitlab-manual");
