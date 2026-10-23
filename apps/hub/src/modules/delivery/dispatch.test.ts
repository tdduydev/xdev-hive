import { type TargetConfig, targetConfig } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { buildJobSpec, DispatchError, renderParam } from "./dispatch.ts";

const CONNECTION = "30303030-0000-4000-8000-000000000001";
const OLD_DEPLOY = "40404040-0000-4000-8000-000000000001";
const version = {
  commit: "a".repeat(40),
  tag: "v1.4.2",
  jenkinsBuild: null as number | null,
  image: null,
  images: [],
  revision: null as string | null,
};
const deploy = (extra: { rollbackOf?: string; jenkinsBuild?: number; revision?: string } = {}) => ({
  id: "50505050-0000-4000-8000-000000000001",
  configVersion: 3,
  rollbackOf: extra.rollbackOf ?? null,
  version: { ...version, jenkinsBuild: extra.jenkinsBuild ?? null, revision: extra.revision ?? null },
});
const config = (value: Record<string, unknown>): TargetConfig => targetConfig.parse({ schemaVersion: 1, ...value });

const jenkins = (extra: Record<string, unknown> = {}) =>
  config({
    method: "jenkins-job",
    connectionId: CONNECTION,
    jobPath: "pay/deploy",
    branch: null,
    params: [
      { name: "COMMIT", value: "{{commit}}" },
      { name: "TARGET", value: "{{env}}-{{tag}}" },
    ],
    credential: "jenkins-ci",
    ...extra,
  });

const argocd = (extra: Record<string, unknown> = {}) =>
  config({
    method: "argocd",
    connectionId: CONNECTION,
    application: "pay-prod",
    branch: null,
    credential: "argocd-prod",
    ...extra,
  });

describe("renderParam", () => {
  it("thay commit, tag, môi trường; thiếu tag thì để rỗng", () => {
    expect(renderParam("{{commit}}/{{tag}}/{{env}}", version, "prod")).toBe(`${"a".repeat(40)}/v1.4.2/prod`);
    expect(renderParam("v={{tag}}", { ...version, tag: null }, "dev")).toBe("v=");
  });
});

describe("buildJobSpec", () => {
  it("Jenkins: job và tham số của đích, credential là tên, không có giá trị bí mật", () => {
    const spec = buildJobSpec({
      deploy: deploy(),
      config: jenkins(),
      baseUrl: "https://ci.example.test",
      envName: "prod",
    });
    expect(spec).toEqual({
      kind: "jenkins-job",
      deployId: deploy().id,
      configVersion: 3,
      target: { baseUrl: "https://ci.example.test", job: "pay/deploy" },
      credential: "jenkins-ci",
      params: { parameters: { COMMIT: "a".repeat(40), TARGET: "prod-v1.4.2" } },
      timeoutSeconds: 3600,
    });
  });

  it("Jenkins: đẩy từ môi trường điền số build; quay về chạy job quay về nếu đích có", () => {
    const promote = jenkins({ promote: { fromEnvironmentId: CONNECTION, buildParam: "BUILD" } });
    const promoted = buildJobSpec({
      deploy: deploy({ jenkinsBuild: 482 }),
      config: promote,
      baseUrl: "https://ci",
      envName: "prod",
    });
    expect(promoted.params).toEqual({ parameters: expect.objectContaining({ BUILD: "482" }) });

    const withRollback = jenkins({
      rollbackJob: { jobPath: "pay/rollback", params: [{ name: "TO", value: "{{tag}}" }] },
    });
    const rollback = buildJobSpec({
      deploy: deploy({ rollbackOf: OLD_DEPLOY }),
      config: withRollback,
      baseUrl: "https://ci",
      envName: "prod",
    });
    expect(rollback.target).toEqual({ baseUrl: "https://ci", job: "pay/rollback" });
    expect(rollback.params).toEqual({ parameters: { TO: "v1.4.2" } });
    // Lần thường vẫn chạy job chính dù đích có job quay về.
    expect(
      buildJobSpec({ deploy: deploy(), config: withRollback, baseUrl: "https://ci", envName: "prod" }).target,
    ).toEqual({ baseUrl: "https://ci", job: "pay/deploy" });
  });

  it("Argo CD: chỉ ghim revision khi đích bật hoặc khi quay về", () => {
    const plain = buildJobSpec({ deploy: deploy(), config: argocd(), baseUrl: "https://argo", envName: "prod" });
    expect(plain).toMatchObject({
      kind: "argocd",
      target: { baseUrl: "https://argo", app: "pay-prod" },
      credential: "argocd-prod",
      params: { action: "sync" },
      timeoutSeconds: 600,
    });
    expect(plain.params).not.toHaveProperty("revision");
    const pinned = buildJobSpec({
      deploy: deploy({ revision: "rev-9" }),
      config: argocd({ syncToRevision: true }),
      baseUrl: "https://argo",
      envName: "prod",
    });
    expect(pinned.params).toEqual({ action: "sync", revision: "rev-9" });
    const rollback = buildJobSpec({
      deploy: deploy({ rollbackOf: OLD_DEPLOY }),
      config: argocd(),
      baseUrl: "https://argo",
      envName: "prod",
    });
    expect(rollback.params).toEqual({ action: "sync", revision: "a".repeat(40) });
  });

  it("cách chạy trên hub (ssh-script, kubectl) không giao cho máy chạy", () => {
    const ssh = { method: "ssh-script" } as TargetConfig;
    expect(() => buildJobSpec({ deploy: deploy(), config: ssh, baseUrl: "", envName: "dev" })).toThrow(DispatchError);
  });
});
