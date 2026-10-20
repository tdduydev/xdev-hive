import type { DeployMethod as DeployMethodName } from "@xdev-hive/contracts";
import { argocd } from "./argocd.ts";
import { gitlabManual } from "./gitlab-manual.ts";
import { jenkinsJob } from "./jenkins-job.ts";
import { kubectl } from "./kubectl.ts";
import type { DeployMethod } from "./method.ts";
import { sshScript } from "./ssh-script.ts";

/** Kiểu Record buộc thêm cách mới vào DEPLOY_METHODS (contracts) là phải có cài đặt ở đây. */
export const deployMethods: Readonly<Record<DeployMethodName, DeployMethod>> = {
  "ssh-script": sshScript,
  "jenkins-job": jenkinsJob,
  "gitlab-manual": gitlabManual,
  argocd,
  kubectl,
};

export function methodFor(method: DeployMethodName): DeployMethod {
  return deployMethods[method];
}
