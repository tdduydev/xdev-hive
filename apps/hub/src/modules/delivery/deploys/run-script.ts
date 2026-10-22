import type { DeployStep, TargetConfig } from "@xdev-hive/contracts";
import { z } from "zod";

// `run.sh` của cách ssh-script (plan.md mục 5 "Chạy bước tách khỏi phiên SSH"). Hub sinh script từ cấu hình đích, gửi
// lên `~/.hive-deploy/<deployId>/` rồi chạy tách khỏi phiên SSH: hub mất kết nối hay khởi động lại thì các bước vẫn
// chạy, hub đọc tiếp `log` và `status.json`. Script chỉ dùng POSIX sh và lệnh có sẵn trên Ubuntu (`timeout`, `setsid`).
//
// Lệnh của từng bước nằm ở file riêng (`steps/<bước>.sh`), không nhúng vào `run.sh`: lệnh của người dùng không phải
// thoát ký tự, và lỗi cú pháp trong lệnh chỉ làm hỏng bước đó, không làm hỏng script điều khiển.

export type SshScriptConfig = Extract<TargetConfig, { method: "ssh-script" }>;

export const SCRIPT_STEPS = ["precheck", "backup", "upload", "deploy"] as const;
export type ScriptStep = (typeof SCRIPT_STEPS)[number];

/** Bước giải nén chỉ chạy tar trên máy chủ; giới hạn để tar treo không giữ cả lần triển khai. */
export const UPLOAD_TIMEOUT_SEC = 600;

/** Lý do bước bị bỏ qua ngay từ đầu, theo cấu hình hoặc lựa chọn của người triển khai. */
export type SkipReason = "not_configured" | "skip_requested" | "upload_none";

/** Lý do `run.sh` ghi vào `status.json` khi bước không xong. */
export const PRECHECK_REASONS = [
  "workdir_missing",
  "env_missing",
  "compose_unavailable",
  "project_missing",
  "project_elsewhere",
] as const;
export type PrecheckReason = (typeof PRECHECK_REASONS)[number];

export interface PlannedStep {
  key: ScriptStep;
  /** Tên hiện trong log. */
  label: string;
  timeoutSec: number;
  skip: SkipReason | null;
}

const LABEL: Record<ScriptStep, string> = {
  precheck: "kiểm trước",
  backup: "sao lưu",
  upload: "đưa mã lên",
  deploy: "triển khai",
};

const SKIP_LOG: Record<SkipReason, string> = {
  not_configured: "đích không cấu hình sao lưu",
  skip_requested: "người triển khai chọn bỏ qua sao lưu lần này",
  upload_none: "đích không gửi mã nguồn, bước triển khai tự lấy mã",
};

/** Chuỗi trong `'…'` của sh: chỉ `'` phải thoát. */
export const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** `/opt/app/` và `/opt/app` là một thư mục; `/` giữ nguyên. */
export const normalizeWorkdir = (dir: string): string => dir.replace(/\/+$/, "") || "/";

/** Lệnh dán từ Windows có `\r`: sh đọc `\r` là một phần của lệnh. */
const normalizeScript = (s: string): string => {
  const text = s.replace(/\r\n?/g, "\n");
  return text.endsWith("\n") ? text : `${text}\n`;
};

export function planSteps(config: SshScriptConfig, skipBackup: boolean): PlannedStep[] {
  const { steps } = config;
  const plan = (key: ScriptStep, timeoutSec: number, skip: SkipReason | null): PlannedStep => ({
    key,
    label: LABEL[key],
    timeoutSec,
    skip,
  });
  return [
    plan("precheck", steps.precheck.timeoutSec, null),
    plan(
      "backup",
      steps.backup?.timeoutSec ?? 0,
      steps.backup === null ? "not_configured" : skipBackup ? "skip_requested" : null,
    ),
    plan("upload", UPLOAD_TIMEOUT_SEC, steps.upload.mode === "none" ? "upload_none" : null),
    plan("deploy", steps.deploy.timeoutSec, null),
  ];
}

// ---- File của từng bước -----------------------------------------------------------------------------------------------

// Kiểm trước (edge case `/opt/xdev-hive`): thư mục, `.env`, compose project đúng như cấu hình, rồi mới tới lệnh của
// đích. Lệch thì ghi lý do vào `reason` để hub nói rõ lệch gì, và dừng chuỗi.
const PRECHECK_BUILTIN = `_hive_reject() {
  printf '%s\\n' "$1" > "$HIVE_DEPLOY_DIR/reason"
  printf '%s\\n' "$2" >&2
  exit 2
}
[ -d "$HIVE_WORKDIR" ] || _hive_reject workdir_missing "Không có thư mục $HIVE_WORKDIR trên máy chủ."
[ -f "$HIVE_WORKDIR/.env" ] || _hive_reject env_missing "Không có file $HIVE_WORKDIR/.env."
_hive_ls=$(docker compose ls -a --format json) ||
  _hive_reject compose_unavailable "Không chạy được docker compose ls trên máy chủ."
# \`docker compose ls\` in JSON gọn một dòng; tách theo \`{\` để mỗi project một dòng.
_hive_entry=$(printf '%s\\n' "$_hive_ls" | tr '{' '\\n' | grep -F "\\"Name\\":\\"$HIVE_COMPOSE_PROJECT\\"" | head -n 1)
[ -n "$_hive_entry" ] ||
  _hive_reject project_missing "Máy chủ không có compose project $HIVE_COMPOSE_PROJECT."
_hive_files=$(printf '%s\\n' "$_hive_entry" | sed -n 's/.*"ConfigFiles":"\\([^"]*\\)".*/\\1/p')
[ -n "$_hive_files" ] ||
  _hive_reject project_elsewhere "Không đọc được file compose của project $HIVE_COMPOSE_PROJECT."
_hive_ifs=$IFS
IFS=,
set -f
for _hive_file in $_hive_files; do
  case "$_hive_file" in
    "\${HIVE_WORKDIR%/}"/*) ;;
    *) _hive_reject project_elsewhere "Compose project $HIVE_COMPOSE_PROJECT chạy từ $_hive_file, không nằm trong $HIVE_WORKDIR." ;;
  esac
done
set +f
IFS=$_hive_ifs
echo "Thư mục, .env và compose project $HIVE_COMPOSE_PROJECT khớp cấu hình."
`;

// Giải nén mã của commit vào `<thư mục>/src.new`; bước triển khai tự đổi `src.new` thành `src`. Tarball của GitHub,
// GitLab có một thư mục gốc (`repo-<sha>/`): bỏ cấp đó để `src.new` luôn là gốc repo.
const UPLOAD_SCRIPT = `rm -rf src.new src.new.tmp
mkdir src.new.tmp
tar -xzf "$HIVE_DEPLOY_DIR/src.new.tar.gz" -C src.new.tmp
_hive_top=$(ls -A src.new.tmp)
if [ -n "$_hive_top" ] && [ "$(printf '%s\\n' "$_hive_top" | wc -l)" -eq 1 ] && [ -d "src.new.tmp/$_hive_top" ]; then
  mv "src.new.tmp/$_hive_top" src.new
  rmdir src.new.tmp
else
  mv src.new.tmp src.new
fi
rm -f "$HIVE_DEPLOY_DIR/src.new.tar.gz"
echo "Đã giải nén mã của commit $HIVE_COMMIT vào $HIVE_WORKDIR/src.new."
`;

function stepFile(key: ScriptStep, body: string): string {
  return [
    `# Bước ${LABEL[key]} (${key}) của xDev Hive. Dừng ở lệnh lỗi đầu tiên, như một job CI.`,
    "set -e",
    key === "precheck" ? PRECHECK_BUILTIN : "",
    'cd "$HIVE_WORKDIR"',
    body,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- run.sh ---------------------------------------------------------------------------------------------------------

// Phần điều khiển dùng chung. Biến nội bộ có tiền tố `_hive_` để không đụng biến của đích.
const RUN_FUNCTIONS = `_hive_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
_hive_log() { printf '== %s %s\\n' "$(date -u +%H:%M:%S)" "$*" >> log; }
_hive_q() { if [ -n "$1" ]; then printf '"%s"' "$1"; else printf null; fi; }
_hive_n() { if [ -n "$1" ]; then printf %s "$1"; else printf null; fi; }
_hive_step() {
  eval "_hive_s=\\$_hive_st_$1 _hive_b=\\$_hive_begin_$1 _hive_e=\\$_hive_end_$1 _hive_c=\\$_hive_code_$1 _hive_r=\\$_hive_reason_$1"
  printf '{"key":"%s","state":"%s","startedAt":' "$1" "$_hive_s"
  _hive_q "$_hive_b"
  printf ',"finishedAt":'
  _hive_q "$_hive_e"
  printf ',"exitCode":'
  _hive_n "$_hive_c"
  printf ',"reason":'
  _hive_q "$_hive_r"
  printf '}'
}
# Ghi file tạm rồi mv: hub đọc giữa chừng không bao giờ thấy JSON dở.
_hive_status() {
  {
    printf '{"v":1,"pid":%s,"current":' "$$"
    _hive_q "$_hive_current"
    printf ',"done":%s,"exit":' "$1"
    _hive_n "$2"
    printf ',"steps":['
    _hive_step precheck
    printf ,
    _hive_step backup
    printf ,
    _hive_step upload
    printf ,
    _hive_step deploy
    printf ']}\\n'
  } > status.json.tmp && mv -f status.json.tmp status.json
}
_hive_end() {
  eval "_hive_st_$1=\\$2 _hive_end_$1=\\$(_hive_now) _hive_code_$1=\\$3 _hive_reason_$1=\\$4"
  _hive_status false
}
_hive_skipped() { _hive_log "$2: bỏ qua, $3."; }
# Huỷ: hub gửi TERM cho cả nhóm tiến trình của run.sh. \`timeout\` tự tách nhóm riêng nên TERM không tới bước đang
# chạy: chuyển tiếp cho \`timeout\`, nó dừng cả nhóm của bước. Các bước sau ghi "đã huỷ".
_hive_on_term() {
  _hive_trapped=1
  _hive_canceled=1
  if [ -n "$_hive_child" ]; then kill -TERM "$_hive_child" 2>/dev/null; fi
}
# Chạy bước ở nền rồi \`wait\`: sh chỉ chạy trap khi lệnh tiền cảnh xong, \`wait\` thì bị TERM cắt ngang ngay.
_hive_run() {
  eval "_hive_s=\\$_hive_st_$1"
  [ "$_hive_s" = pending ] || return 0
  if [ -n "$_hive_canceled" ]; then
    _hive_end "$1" canceled "" canceled
    _hive_log "$3: đã huỷ."
    return 0
  fi
  if [ -n "$_hive_failed" ]; then
    _hive_end "$1" skipped "" previous_failed
    _hive_log "$3: bỏ qua vì bước trước lỗi."
    return 0
  fi
  _hive_current=$1
  eval "_hive_st_$1=running _hive_begin_$1=\\$(_hive_now)"
  _hive_status false
  _hive_log "$3: bắt đầu (tối đa $2 giây)."
  rm -f reason
  _hive_t0=$(date +%s)
  timeout -k 10 "$2" sh "$_hive_dir/steps/$1.sh" >> log 2>&1 < /dev/null &
  _hive_child=$!
  if [ -n "$_hive_canceled" ]; then kill -TERM "$_hive_child" 2>/dev/null; fi
  while :; do
    _hive_trapped=
    wait "$_hive_child"
    _hive_rc=$?
    if [ -n "$_hive_trapped" ] && kill -0 "$_hive_child" 2>/dev/null; then continue; fi
    break
  done
  _hive_child=
  _hive_current=
  if [ "$_hive_rc" -eq 0 ]; then
    _hive_end "$1" succeeded 0 ""
    _hive_log "$3: xong."
  elif [ -n "$_hive_canceled" ]; then
    _hive_end "$1" canceled "$_hive_rc" canceled
    _hive_log "$3: đã huỷ."
  else
    _hive_failed=$1
    # 124: \`timeout\` dừng bước; 137: bước không chịu dừng sau TERM nên bị KILL.
    if [ "$_hive_rc" -eq 124 ] || { [ "$_hive_rc" -eq 137 ] && [ $(($(date +%s) - _hive_t0)) -ge "$2" ]; }; then
      _hive_r=timeout
      _hive_log "$3: quá $2 giây, đã dừng."
    else
      _hive_r=exit
      if [ -f reason ]; then
        _hive_r=$(cat reason)
        case "$_hive_r" in
          ${PRECHECK_REASONS.join(" | ")}) ;;
          *) _hive_r=exit ;;
        esac
      fi
      _hive_log "$3: lỗi, mã thoát $_hive_rc."
    fi
    _hive_end "$1" failed "$_hive_rc" "$_hive_r"
  fi
}
`;

const RUN_FINISH = `_hive_current=
if [ -n "$_hive_canceled" ]; then
  _hive_exit=143
  _hive_log "Kết thúc: đã huỷ."
elif [ -n "$_hive_failed" ]; then
  _hive_exit=1
  _hive_log "Kết thúc: lỗi ở bước $_hive_failed."
else
  _hive_exit=0
  _hive_log "Kết thúc: các bước đều xong."
fi
# Log trước, status sau: hub thấy \`done\` thì log đã đủ.
_hive_status true "$_hive_exit"
exit "$_hive_exit"
`;

export interface RunScriptInput {
  deployId: string;
  config: SshScriptConfig;
  version: { commit: string | null; tag: string | null };
  /** Người triển khai chọn "Bỏ qua sao lưu lần này". */
  skipBackup: boolean;
}

export interface RunScript {
  runSh: string;
  /** Đường dẫn tương đối trong thư mục của lần triển khai → nội dung. Bước bị bỏ qua không có file. */
  stepFiles: Record<string, string>;
  steps: PlannedStep[];
}

export function buildRunScript(input: RunScriptInput): RunScript {
  const { config } = input;
  const steps = planSteps(config, input.skipBackup);
  const workdir = normalizeWorkdir(config.workdir);
  const body: Record<ScriptStep, string> = {
    precheck: config.steps.precheck.script,
    backup: config.steps.backup?.script ?? "",
    upload: UPLOAD_SCRIPT,
    deploy: config.steps.deploy.script,
  };
  const stepFiles: Record<string, string> = {};
  for (const s of steps) if (!s.skip) stepFiles[`steps/${s.key}.sh`] = stepFile(s.key, normalizeScript(body[s.key]));

  const version = [
    input.version.commit ? `commit ${input.version.commit}` : null,
    input.version.tag ? `tag ${input.version.tag}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const init = SCRIPT_STEPS.flatMap((key) => {
    const skip = steps.find((s) => s.key === key)?.skip ?? null;
    return [
      `_hive_st_${key}=${skip ? "skipped" : "pending"}`,
      `_hive_begin_${key}= _hive_end_${key}= _hive_code_${key}= _hive_reason_${key}=${skip ?? ""}`,
    ];
  });
  const sequence = steps.map((s) =>
    s.skip
      ? `_hive_skipped ${s.key} ${shellQuote(s.label)} ${shellQuote(SKIP_LOG[s.skip])}`
      : `_hive_run ${s.key} ${s.timeoutSec} ${shellQuote(s.label)}`,
  );

  const runSh = [
    "#!/bin/sh",
    `# Lần triển khai ${input.deployId} của xDev Hive. Hub sinh file này và đọc status.json theo đúng dạng ở đây:`,
    "# không sửa tay.",
    "umask 077",
    'cd "$(dirname "$0")" || exit 1',
    RUN_FUNCTIONS,
    "trap _hive_on_term TERM",
    "# Biến của đích (có biến bí mật) nằm trên đĩa tới lúc đọc xong; script dừng sớm thì EXIT vẫn xoá.",
    "trap 'rm -f \"$_hive_dir/vars\"' EXIT",
    "_hive_dir=$(pwd)",
    "if [ -f vars ]; then",
    "  set -a",
    "  . ./vars",
    "  set +a",
    "  rm -f vars",
    "fi",
    "",
    "# Đặt sau biến của đích để đích không ghi đè được.",
    "_hive_dir=$(pwd)",
    `HIVE_DEPLOY_ID=${shellQuote(input.deployId)}`,
    "HIVE_DEPLOY_DIR=$_hive_dir",
    `HIVE_WORKDIR=${shellQuote(workdir)}`,
    `HIVE_COMPOSE_PROJECT=${shellQuote(config.composeProject)}`,
    `HIVE_COMMIT=${shellQuote(input.version.commit ?? "")}`,
    `HIVE_TAG=${shellQuote(input.version.tag ?? "")}`,
    "export HIVE_DEPLOY_ID HIVE_DEPLOY_DIR HIVE_WORKDIR HIVE_COMPOSE_PROJECT HIVE_COMMIT HIVE_TAG",
    ...init,
    "_hive_current= _hive_failed= _hive_canceled= _hive_child= _hive_trapped=",
    "",
    ": >> log",
    "_hive_status false",
    `_hive_log ${shellQuote(`Bắt đầu: ${version || "không rõ phiên bản"}, thư mục ${workdir}, compose project ${config.composeProject}.`)}`,
    ...sequence,
    RUN_FINISH,
  ].join("\n");

  return { runSh, stepFiles, steps };
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * File biến `NAME='giá trị'` cho `run.sh` đọc bằng `.`. Giá trị trong `'…'` nên không có gì được thực thi; tên kiểm lại
 * ở đây dù contract đã kiểm, vì tên nằm ngoài dấu nháy.
 */
export function buildVarsFile(vars: ReadonlyArray<{ name: string; value: string }>): string {
  return vars
    .map((v) => {
      if (!VAR_NAME.test(v.name)) throw new Error(`Tên biến không hợp lệ: ${v.name}`);
      return `${v.name}=${shellQuote(v.value)}\n`;
    })
    .join("");
}

// ---- status.json ----------------------------------------------------------------------------------------------------

const statusStep = z.object({
  key: z.enum(SCRIPT_STEPS),
  state: z.enum(["pending", "running", "succeeded", "failed", "skipped", "canceled"]),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  reason: z.string().nullable(),
});

export const runStatus = z.object({
  v: z.literal(1),
  pid: z.number().int(),
  current: z.string().nullable(),
  done: z.boolean(),
  exit: z.number().int().nullable(),
  steps: z.array(statusStep),
});
export type RunStatus = z.output<typeof runStatus>;

/** `status.json` đọc được; null khi chưa có hoặc hỏng (máy chủ đầy đĩa, ai đó sửa tay). */
export function parseRunStatus(text: string): RunStatus | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = runStatus.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---- Bước cho người dùng ---------------------------------------------------------------------------------------------

const iso = (s: string | null): string | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export interface StepContext {
  config: SshScriptConfig;
  /** Lý do người triển khai ghi khi bỏ qua sao lưu. */
  skipBackupReason: string | null;
}

function stepMessage(
  s: { key: ScriptStep; state: DeployStep["state"]; exitCode: number | null; reason: string | null },
  ctx: StepContext,
  plan: PlannedStep | undefined,
): string | null {
  const workdir = normalizeWorkdir(ctx.config.workdir);
  const project = ctx.config.composeProject;
  switch (s.reason) {
    case "not_configured":
      return "Đích không cấu hình sao lưu.";
    case "skip_requested":
      return `Bỏ qua sao lưu lần này: ${ctx.skipBackupReason ?? "không ghi lý do"}`;
    case "upload_none":
      return "Đích không gửi mã nguồn; bước triển khai tự lấy mã.";
    case "previous_failed":
      return "Bỏ qua vì bước trước lỗi.";
    case "canceled":
      return "Đã huỷ.";
    case "timeout":
      return `Quá ${plan?.timeoutSec ?? "?"} giây, đã dừng.`;
    case "workdir_missing":
      return `Máy chủ không có thư mục ${workdir}. Kiểm lại thư mục làm việc trong cấu hình đích.`;
    case "env_missing":
      return `Thư mục ${workdir} không có file .env. Kiểm lại cấu hình đích.`;
    case "compose_unavailable":
      return "Không chạy được docker compose ls trên máy chủ.";
    case "project_missing":
      return `Máy chủ không có compose project ${project}. Kiểm lại tên project trong cấu hình đích.`;
    case "project_elsewhere":
      return `Compose project ${project} không chạy từ thư mục ${workdir}. Kiểm lại cấu hình đích trước khi triển khai.`;
    default:
      return s.state === "failed" && s.exitCode !== null ? `Thoát với mã ${s.exitCode}.` : null;
  }
}

/** Bước như người dùng thấy, từ `status.json` (hoặc từ kế hoạch khi script chưa ghi gì). */
export function scriptSteps(status: RunStatus | null, ctx: StepContext): DeployStep[] {
  const plan = planSteps(ctx.config, ctx.skipBackupReason !== null);
  return SCRIPT_STEPS.map((key) => {
    const planned = plan.find((p) => p.key === key);
    const s = status?.steps.find((x) => x.key === key) ?? {
      key,
      state: planned?.skip ? ("skipped" as const) : ("pending" as const),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      reason: planned?.skip ?? null,
    };
    return {
      key,
      state: s.state,
      startedAt: iso(s.startedAt),
      finishedAt: iso(s.finishedAt),
      exitCode: s.exitCode,
      message: stepMessage(s, ctx, planned),
    };
  });
}
