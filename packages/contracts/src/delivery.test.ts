import { describe, expect, it } from "vitest";
import {
  DELIVERY_ERRORS,
  DEPLOY_ACTIVE_STATES,
  deployCreateInput,
  deployState,
  hostKeyFingerprint,
  jenkinsJobPath,
  jenkinsParam,
  serverTestResult,
  targetConfig,
  targetUpsertInput,
} from "./delivery.ts";
import { contract, createRedactor } from "./index.ts";
import { notificationChannelCreateInput, notificationChannelEvent, notificationChannelUpdateInput } from "./notify.ts";

const id = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const other = "0e3c2a4b-1f2d-4c5e-8a9b-112233445566";
const sha = "a".repeat(40);
const health = { url: "https://hive.xdev.asia/api/v1/health", match: { path: "version", equals: "{{commit8}}" } };

const sshScript = {
  method: "ssh-script",
  schemaVersion: 1,
  serverId: id,
  workdir: "/home/adminvm/xdev-hive",
  composeProject: "xdev-hive",
  steps: {
    precheck: { script: "test -f .env" },
    backup: { script: "cd src && sh deploy/backup.sh" },
    upload: { mode: "git-archive" },
    deploy: { script: "docker compose up -d --build", timeoutSec: 1200 },
  },
  health,
  variables: [
    { name: "HIVE_VERSION", secret: false, value: "{{commit}}" },
    { name: "DB_PASSWORD", secret: true, value: "s3cret-value" },
  ],
};
const configs = {
  "ssh-script": sshScript,
  "jenkins-job": {
    method: "jenkins-job",
    schemaVersion: 1,
    connectionId: id,
    jobPath: "his-portal/build-dev",
    params: [{ name: "BRANCH", value: "{{commit}}" }],
  },
  "gitlab-manual": { method: "gitlab-manual", schemaVersion: 1, jobName: "deploy:dev" },
  argocd: { method: "argocd", schemaVersion: 1, connectionId: id, application: "his-portal", syncToRevision: true },
  kubectl: {
    method: "kubectl",
    schemaVersion: 1,
    connectionId: id,
    namespace: "his-portal",
    kind: "Deployment",
    name: "his-portal",
    container: "app",
    imageTemplate: "harbor.ehospital-v3.azladin.com/his/his-portal:{{tag}}",
  },
} as const;
const upsert = (config: unknown) =>
  targetUpsertInput.safeParse({ projectId: id, environmentId: other, config, expectedConfigVersion: null });

describe("cấu hình đích triển khai", () => {
  it("nhận đủ năm cách triển khai", () => {
    for (const [method, config] of Object.entries(configs)) {
      const parsed = upsert(config);
      expect(parsed.success, method).toBe(true);
      expect(parsed.data?.config.method).toBe(method);
    }
  });

  it("từ chối cách triển khai lạ và schemaVersion lạ", () => {
    expect(upsert({ ...configs.argocd, method: "helm" }).success).toBe(false);
    expect(upsert({ ...configs.argocd, schemaVersion: 2 }).success).toBe(false);
    expect(upsert({ ...configs.argocd, schemaVersion: undefined }).success).toBe(false);
  });

  it("từ chối cấu hình sai kiểu của từng cách", () => {
    // Trường của cách này đặt vào cách khác: thiếu trường bắt buộc của cách đã chọn.
    expect(upsert({ ...configs.kubectl, method: "argocd" }).success).toBe(false);
    expect(upsert({ ...sshScript, serverId: undefined }).success).toBe(false);
    expect(upsert({ ...sshScript, workdir: "relative/dir" }).success).toBe(false);
    expect(upsert({ ...sshScript, steps: { ...sshScript.steps, upload: { mode: "rsync" } } }).success).toBe(false);
    expect(upsert({ ...configs["jenkins-job"], jobPath: "/his-portal//build" }).success).toBe(false);
    expect(upsert({ ...configs.kubectl, kind: "DaemonSet" }).success).toBe(false);
    expect(upsert({ ...configs.kubectl, imageTemplate: "harbor/his/his-portal:latest" }).success).toBe(false);
    expect(upsert({ ...configs.argocd, connectionId: "argocd-1" }).success).toBe(false);
  });

  it("sao lưu là tuỳ chọn; tên biến phải là tên biến môi trường", () => {
    expect(upsert({ ...sshScript, steps: { ...sshScript.steps, backup: null } }).success).toBe(true);
    expect(upsert({ ...sshScript, variables: [{ name: "1BAD", secret: false, value: "x" }] }).success).toBe(false);
    const dup = [
      { name: "A", secret: false, value: "1" },
      { name: "A", secret: false, value: "2" },
    ];
    expect(upsert({ ...sshScript, variables: dup }).success).toBe(false);
  });

  it("biến bí mật bỏ trống giá trị khi sửa là giữ giá trị cũ", () => {
    const keep = upsert({ ...sshScript, variables: [{ name: "DB_PASSWORD", secret: true }] });
    expect(keep.success).toBe(true);
    // Biến thường bắt buộc có giá trị.
    expect(upsert({ ...sshScript, variables: [{ name: "A", secret: false }] }).success).toBe(false);
  });

  it("cấu hình đọc ra không chứa giá trị biến bí mật", () => {
    const out = targetConfig.parse({
      ...sshScript,
      steps: { ...sshScript.steps, precheck: { script: "x", timeoutSec: 60 } },
      variables: [
        { name: "HIVE_VERSION", secret: false, value: "{{commit}}" },
        { name: "DB_PASSWORD", secret: true, set: true, value: "lộ" },
      ],
    });
    expect(out.method).toBe("ssh-script");
    if (out.method !== "ssh-script") return;
    expect(out.variables[1]).toEqual({ name: "DB_PASSWORD", secret: true, set: true });
  });

  it("đích promote của Jenkins chỉ đẩy từ môi trường khác", () => {
    const promote = { ...configs["jenkins-job"], promote: { fromEnvironmentId: other, buildParam: "BUILD" } };
    expect(upsert(promote).success).toBe(true);
    expect(upsert({ ...promote, promote: { fromEnvironmentId: other, buildParam: "" } }).success).toBe(false);
  });
});

describe("đường dẫn job Jenkins", () => {
  it("nhận folder và multibranch, từ chối đoạn rỗng hay `..`", () => {
    expect(jenkinsJobPath.safeParse("his-portal/build-dev").success).toBe(true);
    expect(jenkinsJobPath.safeParse("org/repo/feature%2Fx").success).toBe(true);
    for (const bad of ["", "/a", "a/", "a//b", "a/../b", "a/./b"])
      expect(jenkinsJobPath.safeParse(bad).success, bad).toBe(false);
  });
});

describe("tham số Jenkins", () => {
  it("tham số mật khẩu không trả giá trị mặc định", () => {
    const parsed = jenkinsParam.parse({ type: "password", name: "TOKEN", description: null, default: "lộ" });
    expect(parsed).toEqual({ type: "password", name: "TOKEN", description: null });
    expect(
      jenkinsParam.parse({ type: "choice", name: "TO_ENV", description: null, choices: ["dev", "stg"], default: "dev" })
        .type,
    ).toBe("choice");
  });
});

describe("lần triển khai", () => {
  it("có đủ mười trạng thái, ba trạng thái đang đi", () => {
    expect(deployState.options).toEqual([
      "pending_approval",
      "queued",
      "running",
      "succeeded",
      "failed",
      "failed_needs_review",
      "unknown",
      "canceled",
      "rejected",
      "expired",
    ]);
    expect(DEPLOY_ACTIVE_STATES).toEqual(["pending_approval", "queued", "running"]);
  });

  it("phiên bản là commit, tag, image hoặc đẩy từ môi trường", () => {
    const ok = [
      { kind: "commit", sha },
      { kind: "commit" },
      { kind: "tag", tag: "v1.2.3" },
      { kind: "image", tag: "dev-123" },
      { kind: "fromEnv", environmentId: other },
    ];
    for (const version of ok) expect(deployCreateInput.safeParse({ targetId: id, version }).success).toBe(true);
    expect(deployCreateInput.safeParse({ targetId: id, version: { kind: "commit", sha: "main" } }).success).toBe(false);
    expect(deployCreateInput.safeParse({ targetId: id, version: { kind: "branch" } }).success).toBe(false);
  });

  it("bỏ qua sao lưu phải ghi lý do", () => {
    const base = { targetId: id, version: { kind: "commit", sha } };
    expect(deployCreateInput.safeParse({ ...base, skipBackup: { reason: "  " } }).success).toBe(false);
    expect(deployCreateInput.parse({ ...base, skipBackup: { reason: " Đã sao lưu tay " } }).skipBackup).toEqual({
      reason: "Đã sao lưu tay",
    });
  });
});

describe("máy chủ", () => {
  it("dấu vân tay host key theo định dạng ssh-keygen -lf", () => {
    expect(hostKeyFingerprint.safeParse(`SHA256:${"A".repeat(43)}`).success).toBe(true);
    expect(hostKeyFingerprint.safeParse("MD5:aa:bb").success).toBe(false);
  });

  it("kết quả kiểm phân biệt lỗi mạng, xác thực, host key đổi", () => {
    for (const kind of ["network", "auth", "hostkey_changed"])
      expect(serverTestResult.safeParse({ result: "error", kind, message: "x" }).success).toBe(true);
    expect(serverTestResult.safeParse({ result: "error", kind: "timeout", message: "x" }).success).toBe(false);
    const unconfirmed = { result: "hostkey_unconfirmed", fingerprints: [`SHA256:${"B".repeat(43)}`] };
    expect(serverTestResult.safeParse(unconfirmed).success).toBe(true);
  });
});

describe("lỗi", () => {
  it("có đủ mã của plan.md, câu tiếng Việt", () => {
    const codes = [
      "JENKINS_NO_TOKEN",
      "JENKINS_UNAUTHORIZED",
      "JENKINS_FORBIDDEN",
      "JENKINS_NOT_FOUND",
      "JENKINS_UNAVAILABLE",
      "SSH_UNREACHABLE",
      "SSH_AUTH_FAILED",
      "SSH_HOSTKEY_CHANGED",
      "DEPLOY_IN_PROGRESS",
      "ENV_LOCKED",
      "SELF_APPROVAL",
      "APPROVAL_EXPIRED",
      "TARGET_VERSION_CONFLICT",
      "ROLLBACK_UNAVAILABLE",
    ];
    expect(Object.keys(DELIVERY_ERRORS).sort()).toEqual(codes.sort());
    for (const { message } of Object.values(DELIVERY_ERRORS)) expect(message).toMatch(/[ạ-ỹà-ýđ]/i);
  });

  it("lỗi token Jenkins không dùng UNAUTHORIZED, để web không tưởng phiên Hive hết hạn", () => {
    for (const [code, { status }] of Object.entries(DELIVERY_ERRORS))
      expect(status, code).not.toBe("UNAUTHORIZED" as string);
  });
});

describe("route", () => {
  const groups = {
    ciConnections: ["list", "create", "update", "remove", "test", "setWatcher"],
    ciTokens: ["list", "upsert", "test", "remove"],
    infraConnections: ["list", "create", "update", "remove", "test"],
    ciJobs: ["list", "add", "remove"],
    ci: ["feed", "detail", "log", "jenkinsParams", "retry", "cancel", "play", "build", "stop", "input"],
    servers: ["list", "create", "update", "remove", "test", "confirmHostKey", "rotateKey", "confirmRotation"],
    environments: ["list", "create", "update", "reorder", "lock", "unlock"],
    deployTargets: ["list", "get", "upsert", "remove"],
    deploys: ["create", "get", "list", "board", "cancel", "rollback", "rollbackInfo"],
  } as const;
  type Proc = { "~orpc": { route: { method?: string; path?: string; summary?: string } } };
  const procs = (): [string, Proc][] => {
    const out: [string, Proc][] = [];
    for (const [group, names] of Object.entries(groups)) {
      const g = contract[group as keyof typeof groups] as unknown as Record<string, Proc>;
      for (const name of names) out.push([`${group}.${name}`, g[name] as Proc]);
    }
    const approvals = contract.deploys.approvals as unknown as Record<string, Proc>;
    for (const name of ["pending", "approve", "reject", "compare"])
      out.push([`deploys.approvals.${name}`, approvals[name] as Proc]);
    out.push(["ci.approveDeployment", (contract.ci as unknown as Record<string, Proc>).approveDeployment as Proc]);
    return out;
  };

  it("đủ route, mỗi route có mô tả tiếng Việt và đường dẫn riêng", () => {
    const seen = new Set<string>();
    for (const [name, proc] of procs()) {
      expect(proc, name).toBeDefined();
      const { method, path, summary } = proc["~orpc"].route;
      expect(summary, name).toMatch(/[ạ-ỹà-ýđ]/i);
      const key = `${method} ${path}`;
      expect(seen.has(key), `${name}: ${key}`).toBe(false);
      seen.add(key);
    }
  });
});

describe("thông báo", () => {
  it("có bảy sự kiện mới cho kênh của tổ chức", () => {
    for (const event of [
      "ci.failed",
      "ci.recovered",
      "deploy.started",
      "deploy.succeeded",
      "deploy.failed",
      "deploy.approval_requested",
      "server.hostkey_changed",
    ])
      expect(notificationChannelEvent.options).toContain(event);
  });

  it("kênh lọc được theo hệ thống; null là mọi hệ thống", () => {
    const base = {
      name: "Ops",
      events: ["deploy.failed"],
      config: { kind: "telegram", botToken: `123456:${"a".repeat(30)}`, chatId: "-100" },
    };
    expect(notificationChannelCreateInput.parse(base).systemIds).toBeUndefined();
    expect(notificationChannelCreateInput.parse({ ...base, systemIds: [id, id] }).systemIds).toEqual([id]);
    expect(notificationChannelUpdateInput.parse({ id, systemIds: null }).systemIds).toBeNull();
    expect(notificationChannelUpdateInput.safeParse({ id, systemIds: ["x"] }).success).toBe(false);
  });
});

describe("che bí mật", () => {
  it("createRedactor được export ở index", () => {
    expect(typeof createRedactor).toBe("function");
  });
});
