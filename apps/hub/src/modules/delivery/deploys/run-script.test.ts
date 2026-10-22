import { describe, expect, it } from "vitest";
import {
  buildRunScript,
  buildVarsFile,
  normalizeWorkdir,
  parseRunStatus,
  type RunStatus,
  type SshScriptConfig,
  scriptSteps,
  shellQuote,
} from "./run-script.ts";

const DEPLOY_ID = "0192f3a0-0000-7000-8000-000000000001";
const COMMIT = "4f1c2d3e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d";

const config = (over: Partial<SshScriptConfig> = {}): SshScriptConfig => ({
  method: "ssh-script",
  schemaVersion: 1,
  serverId: "0192f3a0-0000-7000-8000-0000000000aa",
  workdir: "/opt/billing/",
  composeProject: "billing",
  branch: null,
  steps: {
    precheck: { script: "docker compose config -q", timeoutSec: 60 },
    backup: { script: "pg_dump -Fc billing > backup/$HIVE_DEPLOY_ID.dump\r\n", timeoutSec: 300 },
    upload: { mode: "git-archive" },
    deploy: { script: "rm -rf src && mv src.new src\ndocker compose -p billing up -d --build", timeoutSec: 900 },
  },
  health: null,
  variables: [],
  ...over,
});

describe("buildRunScript", () => {
  it("sinh run.sh và file bước đủ bốn bước", () => {
    const script = buildRunScript({
      deployId: DEPLOY_ID,
      config: config(),
      version: { commit: COMMIT, tag: "v1.4.0" },
      skipBackup: false,
    });
    expect(script.runSh).toMatchSnapshot("run.sh");
    expect(script.stepFiles).toMatchSnapshot("steps");
    expect(script.steps.map((s) => [s.key, s.timeoutSec, s.skip])).toEqual([
      ["precheck", 60, null],
      ["backup", 300, null],
      ["upload", 600, null],
      ["deploy", 900, null],
    ]);
  });

  it("bỏ bước không cấu hình, bỏ qua sao lưu theo yêu cầu, không gửi mã khi upload none", () => {
    const skipped = buildRunScript({
      deployId: DEPLOY_ID,
      config: config({
        steps: { ...config().steps, upload: { mode: "none" } },
      }),
      version: { commit: null, tag: "v1.4.0" },
      skipBackup: true,
    });
    expect(Object.keys(skipped.stepFiles).sort()).toEqual(["steps/deploy.sh", "steps/precheck.sh"]);
    expect(skipped.runSh).toMatchSnapshot("run.sh bỏ qua sao lưu, không gửi mã");

    const noBackup = buildRunScript({
      deployId: DEPLOY_ID,
      config: config({ steps: { ...config().steps, backup: null } }),
      version: { commit: COMMIT, tag: null },
      skipBackup: true,
    });
    expect(noBackup.steps.find((s) => s.key === "backup")?.skip).toBe("not_configured");
    expect(noBackup.runSh).toContain("_hive_st_backup=skipped");
    expect(noBackup.runSh).toContain("_hive_reason_backup=not_configured");
  });

  it("thoát nháy đơn trong thư mục, phiên bản và lệnh của đích không lọt vào run.sh", () => {
    const script = buildRunScript({
      deployId: DEPLOY_ID,
      config: config({ workdir: "/opt/it's here", composeProject: "billing" }),
      version: { commit: COMMIT, tag: "v1'; rm -rf /; '" },
      skipBackup: false,
    });
    expect(script.runSh).toContain(`HIVE_WORKDIR='/opt/it'\\''s here'`);
    expect(script.runSh).toContain(`HIVE_TAG='v1'\\''; rm -rf /; '\\'''`);
    expect(script.runSh).not.toContain("pg_dump");
    expect(script.stepFiles["steps/backup.sh"]).toContain("pg_dump -Fc billing > backup/$HIVE_DEPLOY_ID.dump\n");
    expect(script.stepFiles["steps/backup.sh"]).not.toContain("\r");
  });
});

describe("buildVarsFile", () => {
  it("ghi NAME='giá trị', giữ nguyên ký tự đặc biệt trong nháy", () => {
    expect(
      buildVarsFile([
        { name: "DB_URL", value: "postgres://u:p@db/x?a=1&b=$HOME" },
        { name: "QUOTE", value: "it's" },
        { name: "MULTI", value: "a\nb" },
      ]),
    ).toBe(`DB_URL='postgres://u:p@db/x?a=1&b=$HOME'\nQUOTE='it'\\''s'\nMULTI='a\nb'\n`);
    expect(buildVarsFile([])).toBe("");
  });

  it("từ chối tên biến có thể chạy lệnh", () => {
    expect(() => buildVarsFile([{ name: "X;id", value: "1" }])).toThrow(/Tên biến/);
  });
});

describe("helpers", () => {
  it("shellQuote và normalizeWorkdir", () => {
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(normalizeWorkdir("/opt/app///")).toBe("/opt/app");
    expect(normalizeWorkdir("/")).toBe("/");
  });
});

const status = (over: Partial<RunStatus> = {}): RunStatus => ({
  v: 1,
  pid: 4242,
  current: null,
  done: true,
  exit: 1,
  steps: [
    {
      key: "precheck",
      state: "failed",
      startedAt: "2026-10-22T03:00:00Z",
      finishedAt: "2026-10-22T03:00:01Z",
      exitCode: 2,
      reason: "project_elsewhere",
    },
    {
      key: "backup",
      state: "skipped",
      startedAt: null,
      finishedAt: "2026-10-22T03:00:01Z",
      exitCode: null,
      reason: "previous_failed",
    },
    {
      key: "upload",
      state: "skipped",
      startedAt: null,
      finishedAt: "2026-10-22T03:00:01Z",
      exitCode: null,
      reason: "previous_failed",
    },
    {
      key: "deploy",
      state: "skipped",
      startedAt: null,
      finishedAt: "2026-10-22T03:00:01Z",
      exitCode: null,
      reason: "previous_failed",
    },
  ],
  ...over,
});

describe("status.json", () => {
  it("đọc status hợp lệ, bỏ qua file rỗng hoặc hỏng", () => {
    expect(parseRunStatus(`${JSON.stringify(status())}\n`)).toEqual(status());
    expect(parseRunStatus("")).toBeNull();
    expect(parseRunStatus('{"v":1,"pid":')).toBeNull();
    expect(parseRunStatus('{"v":2}')).toBeNull();
  });

  it("đổi status thành bước cho người dùng, nói rõ lệch cấu hình", () => {
    const steps = scriptSteps(status(), { config: config(), skipBackupReason: null });
    expect(steps[0]).toEqual({
      key: "precheck",
      state: "failed",
      startedAt: "2026-10-22T03:00:00.000Z",
      finishedAt: "2026-10-22T03:00:01.000Z",
      exitCode: 2,
      message:
        "Compose project billing không chạy từ thư mục /opt/billing. Kiểm lại cấu hình đích trước khi triển khai.",
    });
    expect(steps.slice(1).map((s) => [s.key, s.state, s.message])).toEqual([
      ["backup", "skipped", "Bỏ qua vì bước trước lỗi."],
      ["upload", "skipped", "Bỏ qua vì bước trước lỗi."],
      ["deploy", "skipped", "Bỏ qua vì bước trước lỗi."],
    ]);
  });

  it("chưa có status thì lấy kế hoạch: sao lưu bỏ qua kèm lý do người triển khai ghi", () => {
    const steps = scriptSteps(null, { config: config(), skipBackupReason: "Đã sao lưu tay lúc 9 giờ" });
    expect(steps.map((s) => [s.key, s.state, s.message])).toEqual([
      ["precheck", "pending", null],
      ["backup", "skipped", "Bỏ qua sao lưu lần này: Đã sao lưu tay lúc 9 giờ"],
      ["upload", "pending", null],
      ["deploy", "pending", null],
    ]);
  });

  it("bước quá giờ và bước lỗi có mã thoát", () => {
    const steps = scriptSteps(
      status({
        steps: [
          { key: "precheck", state: "succeeded", startedAt: null, finishedAt: null, exitCode: 0, reason: null },
          { key: "backup", state: "failed", startedAt: null, finishedAt: null, exitCode: 124, reason: "timeout" },
          { key: "upload", state: "failed", startedAt: null, finishedAt: null, exitCode: 3, reason: "exit" },
          { key: "deploy", state: "canceled", startedAt: null, finishedAt: null, exitCode: null, reason: "canceled" },
        ],
      }),
      { config: config(), skipBackupReason: null },
    );
    expect(steps.map((s) => s.message)).toEqual([null, "Quá 300 giây, đã dừng.", "Thoát với mã 3.", "Đã huỷ."]);
  });
});
