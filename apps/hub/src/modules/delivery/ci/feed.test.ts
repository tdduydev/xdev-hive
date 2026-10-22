import { ciRun, jenkinsParam } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import type { JenkinsBuild } from "../clients/jenkins.ts";
import { jenkinsParamView } from "./detail.ts";
import { gitRun, gitStatus, jenkinsRun, jenkinsRunId, jenkinsStageStatus, parseRunId } from "./feed.ts";

const JOB_ID = "6f1d3c1e-7a4b-4c2d-9e8f-0a1b2c3d4e5f";
const job = { id: JOB_ID, connectionId: JOB_ID, connectionName: "ACME", watcherUserId: null, jobPath: "billing/build" };

const build = (patch: Partial<JenkinsBuild> = {}): JenkinsBuild => ({
  number: 12,
  url: "https://ci.example.com/job/billing/job/build/12/",
  result: "SUCCESS",
  building: false,
  startedAt: Date.parse("2026-10-20T08:00:00Z"),
  durationMs: 90_000,
  causes: [{ description: "Started by user An", userId: "an.nguyen", userName: "An Nguyen" }],
  commit: { sha: "abc123", branch: "refs/remotes/origin/main" },
  parameters: {},
  ...patch,
});

describe("định danh lượt CI", () => {
  it("đọc lại được id do hub ghép", () => {
    expect(parseRunId("gitlab:42")).toEqual({ source: "gitlab", pipelineId: "42" });
    expect(parseRunId(jenkinsRunId(JOB_ID, 7))).toEqual({ source: "jenkins", jobId: JOB_ID, build: 7 });
  });

  it.each(["gitlab:abc", "gitlab:1:2", "jenkins:not-a-uuid:3", `jenkins:${JOB_ID}:x`, "svn:1"])("từ chối %s", (id) => {
    expect(() => parseRunId(id)).toThrow(expect.objectContaining({ code: "CI_RUN_ID_INVALID" }));
  });
});

describe("trạng thái chung", () => {
  it("GitLab: job chờ tay là waiting, các trạng thái chờ là queued", () => {
    expect(gitStatus("manual")).toBe("waiting");
    expect(gitStatus("waiting_for_resource")).toBe("queued");
    expect(gitStatus("canceling")).toBe("running");
    expect(gitStatus("failed")).toBe("failed");
  });

  it("Jenkins: giai đoạn chờ input là waiting, lạ thì queued", () => {
    expect(jenkinsStageStatus("PAUSED_PENDING_INPUT")).toBe("waiting");
    expect(jenkinsStageStatus("FAILED")).toBe("failed");
    expect(jenkinsStageStatus("NOT_EXECUTED")).toBe("skipped");
    expect(jenkinsStageStatus("WHATEVER")).toBe("queued");
  });
});

describe("chuyển sang lượt CI của hợp đồng", () => {
  it("build Jenkins đã xong: nhánh rút gọn, thời gian ISO, người bấm", () => {
    const run = ciRun.parse(jenkinsRun(job, build()));
    expect(run).toMatchObject({
      id: `jenkins:${JOB_ID}:12`,
      title: "billing/build #12",
      branch: "main",
      status: "success",
      rawStatus: "SUCCESS",
      startedAt: "2026-10-20T08:00:00.000Z",
      finishedAt: "2026-10-20T08:01:30.000Z",
      durationSec: 90,
      triggeredBy: "An Nguyen",
    });
  });

  it("build Jenkins đang chạy và UNSTABLE", () => {
    expect(jenkinsRun(job, build({ building: true, result: null }))).toMatchObject({
      status: "running",
      rawStatus: "BUILDING",
      finishedAt: null,
      durationSec: null,
    });
    expect(jenkinsRun(job, build({ result: "UNSTABLE", commit: null })).status).toBe("unstable");
  });

  it("pipeline GitLab", () => {
    const run = ciRun.parse(
      gitRun("gitlab", {
        id: "77",
        ref: "main",
        sha: "abc",
        status: "manual",
        url: "https://gitlab.example.com/x/-/pipelines/77",
        createdAt: "2026-10-20T08:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        durationSec: null,
        user: "an",
      }),
    );
    expect(run).toMatchObject({
      id: "gitlab:77",
      number: 77,
      status: "waiting",
      startedAt: "2026-10-20T08:00:00.000Z",
    });
  });
});

describe("tham số Jenkins", () => {
  it("mật khẩu không có giá trị mặc định; kiểu lạ thành other", () => {
    const pass = jenkinsParamView({
      name: "DB_PASS",
      kind: "password",
      type: "PasswordParameterDefinition",
      description: "",
      default: "s3cret",
      choices: null,
    });
    expect(jenkinsParam.parse(pass)).toEqual({ type: "password", name: "DB_PASS", description: null });
    expect(JSON.stringify(pass)).not.toContain("s3cret");
    expect(
      jenkinsParamView({
        name: "X",
        kind: "other",
        type: "GitParameterDefinition",
        description: "nhánh",
        default: "main",
        choices: null,
      }),
    ).toEqual({ type: "other", name: "X", description: "nhánh", rawType: "GitParameterDefinition", default: "main" });
  });
});
