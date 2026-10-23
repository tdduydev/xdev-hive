import {
  type DeployMethod,
  type DeployTarget,
  TARGET_CONFIG_SCHEMA_VERSION,
  type TargetConfig,
} from "@xdev-hive/contracts";

/*
 * Bản nháp của form đích triển khai (specs/020 T022). Form giữ mọi ô là chuỗi để người dùng gõ dở không làm mất giá
 * trị; `draftToConfig` đổi sang cấu hình gửi hub, hub và zod của hợp đồng kiểm lại. Biến bí mật chỉ ghi: bản nháp biết
 * biến đã có giá trị trên hub (`stored`) nhưng không bao giờ có giá trị đó.
 */

export interface VariableDraft {
  name: string;
  secret: boolean;
  /** Biến thường: giá trị. Biến bí mật: giá trị mới, bỏ trống khi sửa là giữ giá trị đã lưu. */
  value: string;
  /** Biến bí mật đã có giá trị trên hub. */
  stored: boolean;
}

export interface ParamDraft {
  name: string;
  value: string;
}

export interface TargetDraft {
  method: DeployMethod;
  /** Rỗng là nhánh mặc định của repo. */
  branch: string;
  healthOn: boolean;
  healthUrl: string;
  healthStatus: string;
  healthMatchPath: string;
  healthMatchEquals: string;
  healthTimeout: string;
  healthInterval: string;
  // ssh-script
  serverId: string;
  workdir: string;
  composeProject: string;
  precheck: string;
  precheckTimeout: string;
  backupOn: boolean;
  backup: string;
  backupTimeout: string;
  uploadMode: "git-archive" | "none";
  deploy: string;
  deployTimeout: string;
  variables: VariableDraft[];
  // jenkins-job, argocd, kubectl
  connectionId: string;
  // jenkins-job
  jobPath: string;
  params: ParamDraft[];
  promoteOn: boolean;
  promoteFrom: string;
  promoteParam: string;
  rollbackOn: boolean;
  rollbackJobPath: string;
  rollbackParams: ParamDraft[];
  // jenkins-job, argocd: tên credential trong kho của máy chạy (specs/032), không phải giá trị
  credential: string;
  // gitlab-manual
  jobName: string;
  // argocd, kubectl
  timeoutSec: string;
  // argocd
  application: string;
  syncToRevision: boolean;
  // kubectl
  namespace: string;
  kind: "Deployment" | "StatefulSet";
  workload: string;
  container: string;
  imageTemplate: string;
}

export function emptyDraft(method: DeployMethod): TargetDraft {
  return {
    method,
    branch: "",
    healthOn: false,
    healthUrl: "",
    healthStatus: "200",
    healthMatchPath: "",
    healthMatchEquals: "",
    healthTimeout: "180",
    healthInterval: "5",
    serverId: "",
    workdir: "",
    composeProject: "",
    precheck: "",
    precheckTimeout: "600",
    backupOn: false,
    backup: "",
    backupTimeout: "600",
    uploadMode: "git-archive",
    deploy: "",
    deployTimeout: "600",
    variables: [],
    connectionId: "",
    jobPath: "",
    params: [],
    promoteOn: false,
    promoteFrom: "",
    promoteParam: "",
    rollbackOn: false,
    rollbackJobPath: "",
    rollbackParams: [],
    credential: "",
    jobName: "",
    timeoutSec: "600",
    application: "",
    syncToRevision: false,
    namespace: "",
    kind: "Deployment",
    workload: "",
    container: "",
    imageTemplate: "",
  };
}

/** Đổi cấu hình đọc từ hub (không có giá trị bí mật) thành bản nháp để sửa. */
export function draftFromConfig(config: TargetConfig): TargetDraft {
  const draft = emptyDraft(config.method);
  draft.branch = "branch" in config ? (config.branch ?? "") : "";
  const health = config.health;
  if (health) {
    draft.healthOn = true;
    draft.healthUrl = health.url;
    draft.healthStatus = String(health.expectStatus);
    draft.healthMatchPath = health.match?.path ?? "";
    draft.healthMatchEquals = health.match?.equals ?? "";
    draft.healthTimeout = String(health.timeoutSec);
    draft.healthInterval = String(health.intervalSec);
  }
  switch (config.method) {
    case "ssh-script":
      draft.serverId = config.serverId;
      draft.workdir = config.workdir;
      draft.composeProject = config.composeProject;
      draft.precheck = config.steps.precheck.script;
      draft.precheckTimeout = String(config.steps.precheck.timeoutSec);
      draft.backupOn = config.steps.backup !== null;
      draft.backup = config.steps.backup?.script ?? "";
      draft.backupTimeout = String(config.steps.backup?.timeoutSec ?? 600);
      draft.uploadMode = config.steps.upload.mode;
      draft.deploy = config.steps.deploy.script;
      draft.deployTimeout = String(config.steps.deploy.timeoutSec);
      draft.variables = config.variables.map((v) =>
        v.secret
          ? { name: v.name, secret: true, value: "", stored: v.set }
          : { name: v.name, secret: false, value: v.value, stored: false },
      );
      break;
    case "jenkins-job":
      draft.connectionId = config.connectionId;
      draft.jobPath = config.jobPath;
      draft.params = config.params.map((p) => ({ name: p.name, value: p.value }));
      draft.promoteOn = config.promote !== null;
      draft.promoteFrom = config.promote?.fromEnvironmentId ?? "";
      draft.promoteParam = config.promote?.buildParam ?? "";
      draft.rollbackOn = config.rollbackJob !== null;
      draft.rollbackJobPath = config.rollbackJob?.jobPath ?? "";
      draft.rollbackParams = (config.rollbackJob?.params ?? []).map((p) => ({ name: p.name, value: p.value }));
      draft.credential = config.credential ?? "";
      break;
    case "gitlab-manual":
      draft.jobName = config.jobName;
      break;
    case "argocd":
      draft.connectionId = config.connectionId;
      draft.application = config.application;
      draft.syncToRevision = config.syncToRevision;
      draft.timeoutSec = String(config.timeoutSec);
      draft.credential = config.credential ?? "";
      break;
    case "kubectl":
      draft.connectionId = config.connectionId;
      draft.namespace = config.namespace;
      draft.kind = config.kind;
      draft.workload = config.name;
      draft.container = config.container;
      draft.imageTemplate = config.imageTemplate;
      draft.timeoutSec = String(config.timeoutSec);
      break;
  }
  return draft;
}

const num = (value: string): number | undefined => (value.trim() === "" ? undefined : Number(value));

function healthConfig(d: TargetDraft) {
  if (!d.healthOn) return null;
  const path = d.healthMatchPath.trim();
  return {
    url: d.healthUrl.trim(),
    expectStatus: num(d.healthStatus),
    match: path ? { path, equals: d.healthMatchEquals } : null,
    timeoutSec: num(d.healthTimeout),
    intervalSec: num(d.healthInterval),
  };
}

const branchOf = (d: TargetDraft) => d.branch.trim() || null;
const credentialOf = (d: TargetDraft) => d.credential.trim() || null;
const paramsOf = (list: ParamDraft[]) => list.map((p) => ({ name: p.name.trim(), value: p.value }));

/** Cấu hình gửi hub từ bản nháp. Trả về dữ liệu chưa kiểm; `targetUpsertInput` của hợp đồng kiểm. */
export function draftToConfig(d: TargetDraft): unknown {
  const base = { schemaVersion: TARGET_CONFIG_SCHEMA_VERSION, health: healthConfig(d) };
  switch (d.method) {
    case "ssh-script":
      return {
        method: "ssh-script",
        ...base,
        serverId: d.serverId,
        workdir: d.workdir.trim(),
        composeProject: d.composeProject.trim(),
        branch: branchOf(d),
        steps: {
          precheck: { script: d.precheck, timeoutSec: num(d.precheckTimeout) },
          backup: d.backupOn ? { script: d.backup, timeoutSec: num(d.backupTimeout) } : null,
          upload: { mode: d.uploadMode },
          deploy: { script: d.deploy, timeoutSec: num(d.deployTimeout) },
        },
        variables: d.variables.map((v) =>
          v.secret
            ? { name: v.name.trim(), secret: true, ...(v.value === "" ? {} : { value: v.value }) }
            : { name: v.name.trim(), secret: false, value: v.value },
        ),
      };
    case "jenkins-job":
      return {
        method: "jenkins-job",
        ...base,
        connectionId: d.connectionId,
        jobPath: d.jobPath,
        branch: branchOf(d),
        params: paramsOf(d.params),
        promote: d.promoteOn ? { fromEnvironmentId: d.promoteFrom, buildParam: d.promoteParam.trim() } : null,
        rollbackJob: d.rollbackOn ? { jobPath: d.rollbackJobPath, params: paramsOf(d.rollbackParams) } : null,
        credential: credentialOf(d),
      };
    case "gitlab-manual":
      return { method: "gitlab-manual", ...base, jobName: d.jobName, branch: branchOf(d) };
    case "argocd":
      return {
        method: "argocd",
        ...base,
        connectionId: d.connectionId,
        application: d.application,
        syncToRevision: d.syncToRevision,
        branch: branchOf(d),
        timeoutSec: num(d.timeoutSec),
        credential: credentialOf(d),
      };
    case "kubectl":
      return {
        method: "kubectl",
        ...base,
        connectionId: d.connectionId,
        namespace: d.namespace,
        kind: d.kind,
        name: d.workload,
        container: d.container,
        imageTemplate: d.imageTemplate,
        timeoutSec: num(d.timeoutSec),
      };
  }
}

/**
 * Lỗi mà zod của hợp đồng báo bằng tiếng Anh hoặc không nói gì với người dùng: ô chọn còn trống, biến bí mật mới chưa
 * có giá trị. Kiểm trước để câu báo tiếng Việt và gắn đúng ô (khoá là đường dẫn trong cấu hình, vd. `serverId`).
 */
export function validateDraft(d: TargetDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (d.method === "ssh-script") {
    if (!d.serverId) errors.serverId = "Chọn máy chủ.";
    d.variables.forEach((v, i) => {
      if (v.secret && v.value === "" && !v.stored) errors[`variables.${i}.value`] = "Nhập giá trị của biến bí mật.";
    });
  } else if (d.method !== "gitlab-manual") {
    if (!d.connectionId) errors.connectionId = "Chọn kết nối.";
  }
  if (d.method === "jenkins-job" && d.promoteOn) {
    if (!d.promoteFrom) errors["promote.fromEnvironmentId"] = "Chọn môi trường nguồn.";
    if (!d.promoteParam.trim()) errors["promote.buildParam"] = "Nhập tên tham số nhận số build.";
  }
  if (d.healthOn && !d.healthUrl.trim()) errors["health.url"] = "Nhập URL health.";
  return errors;
}

// ---- Mẫu ------------------------------------------------------------------------------------------------------------

export interface TargetPreset {
  id: string;
  label: string;
  description: string;
  method: DeployMethod;
  /** Bản nháp ban đầu; máy chủ để trống cho người dùng chọn. */
  draft: () => TargetDraft;
}

const HIVE_PRECHECK = `set -eu
# Máy chủ phải đã được cài hub lần đầu: có .env và compose project đang chạy.
test -f "$HIVE_DIR/.env" || { echo "Thiếu $HIVE_DIR/.env. Hub chưa được cài lần đầu trên máy chủ này." >&2; exit 2; }
docker compose ls --format json | grep -q "\\"Name\\":\\"$HIVE_COMPOSE_PROJECT\\"" ||
  { echo "Không thấy compose project $HIVE_COMPOSE_PROJECT trên máy chủ." >&2; exit 2; }
`;

const HIVE_BACKUP = `set -eu
cd "$HIVE_DIR/src"
sh deploy/backup.sh
`;

// [Unverified] Tên biến HIVE_COMMIT: chỉnh theo biến mà bộ chạy bước của hub (T020) đặt cho lần triển khai.
const HIVE_DEPLOY = `set -eu
dir=$HIVE_DIR
commit=\${HIVE_COMMIT:?Thiếu HIVE_COMMIT: commit của lần triển khai}

# Thay mã cũ bằng mã mới; giữ bản trước ở src.old để xem lại khi cần.
rm -rf "$dir/src.old"
[ -d "$dir/src" ] && mv "$dir/src" "$dir/src.old"
mv "$dir/src.new" "$dir/src"
cd "$dir/src"

compose() {
  BUILDX_BUILDER=default HIVE_VERSION="$commit" docker compose -p "$HIVE_COMPOSE_PROJECT" --env-file "$dir/.env" -f deploy/compose.yaml "$@"
}
compose up -d --build

# Caddyfile đổi thì tạo lại Caddy để gắn file mới.
mounted=$(compose exec -T caddy sha256sum /etc/caddy/Caddyfile | cut -d' ' -f1 || true)
next=$(sha256sum deploy/caddy/Caddyfile | cut -d' ' -f1)
[ "$mounted" = "$next" ] || compose up -d --no-deps --force-recreate caddy
`;

export const HIVE_COMPOSE_PRESET_ID = "hive-docker-compose";

function hiveComposeDraft(): TargetDraft {
  return {
    ...emptyDraft("ssh-script"),
    workdir: "/opt/xdev-hive",
    composeProject: "xdev-hive",
    precheck: HIVE_PRECHECK,
    precheckTimeout: "60",
    backupOn: true,
    backup: HIVE_BACKUP,
    backupTimeout: "900",
    uploadMode: "git-archive",
    deploy: HIVE_DEPLOY,
    deployTimeout: "1800",
    variables: [
      { name: "HIVE_DIR", secret: false, value: "/opt/xdev-hive", stored: false },
      { name: "HIVE_COMPOSE_PROJECT", secret: false, value: "xdev-hive", stored: false },
    ],
    healthOn: true,
    healthUrl: "https://hive.example.com/api/v1/health",
    healthStatus: "200",
    healthMatchPath: "version",
    healthMatchEquals: "{{commit8}}",
    healthTimeout: "180",
    healthInterval: "5",
  };
}

export const TARGET_PRESETS: TargetPreset[] = [
  {
    id: HIVE_COMPOSE_PRESET_ID,
    label: "Hub xDev Hive (docker compose)",
    description:
      "Triển khai lại hub như deploy/remote.sh: kiểm trước, sao lưu, đưa mã lên, docker compose up, rồi kiểm health theo commit.",
    method: "ssh-script",
    draft: hiveComposeDraft,
  },
];

export function presetById(presetId: string): TargetPreset | undefined {
  return TARGET_PRESETS.find((p) => p.id === presetId);
}

/** Nhãn ngắn của cấu hình đích trên bảng: máy chủ, job, application hay workload. */
export function targetSummary(target: DeployTarget): string {
  const c = target.config;
  switch (c.method) {
    case "ssh-script":
      return c.workdir;
    case "jenkins-job":
      return c.jobPath;
    case "gitlab-manual":
      return c.jobName;
    case "argocd":
      return c.application;
    case "kubectl":
      return `${c.namespace}/${c.name}`;
  }
}
