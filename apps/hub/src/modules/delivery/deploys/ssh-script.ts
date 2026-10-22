import { DELIVERY_ERRORS, type DeployStep, type DeployVersion, type TargetConfig } from "@xdev-hive/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { loadProject } from "../../catalog/index.ts";
import { ConflictError, decryptSecret, NotFoundError, withTenant } from "../../platform/index.ts";
import { GitProviderError } from "../../scm/index.ts";
import { type ScmTarget, scmDomainError, scmTarget } from "../ci/feed.ts";
import { type SshConnection, SshError, type SshTarget, withSsh } from "../clients/ssh.ts";
import { requireMasterKey } from "../connections/jenkins.ts";
import { deploys, deployTargets, type HostKey } from "../schema.ts";
import { reportHostKeyChanged, serverSshTarget } from "../servers.ts";
import { targetVariableContext } from "../targets.ts";
import { type HealthResult, runHealthCheck } from "./health.ts";
import type { DeployMethod, DeployMethodContext, DeployProgress, DeployRun, DeployStarted } from "./method.ts";
import {
  buildRunScript,
  buildVarsFile,
  parseRunStatus,
  type RunStatus,
  type SshScriptConfig,
  type StepContext,
  scriptSteps,
  shellQuote,
} from "./run-script.ts";

// Cách `ssh-script` (US4, FR-016..018, plan.md mục 5 "Chạy bước tách khỏi phiên SSH", "Đưa mã lên"). `start` gửi
// `run.sh`, file bước, file biến và mã nguồn vào `~/.hive-deploy/<deployId>/` rồi chạy tách khỏi phiên SSH; `poll` mở
// phiên ngắn đọc `status.json` và phần log mới theo byte; `cancel` gửi TERM cho nhóm tiến trình của `run.sh`. Hub
// khởi động lại giữa chừng thì `poll` đọc tiếp từ `deploys.remote`, các bước trên máy chủ không bị ảnh hưởng.

const DEPLOY_ROOT = ".hive-deploy";
/** Thư mục của lần triển khai cũ hơn số ngày này bị xoá khi bắt đầu lần mới trên cùng máy chủ. */
const KEEP_DAYS = 14;
/** Mỗi lần đọc tối đa từng này byte log; log dài hơn thì đọc tiếp ở lần sau. */
export const LOG_CHUNK_BYTES = 256 * 1024;
const LOG_MARK = "--hive-log--";
const DEPLOY_ID = /^[0-9A-Za-z-]{1,64}$/;

/** Trạng thái phía máy chủ lưu ở `deploys.remote`. */
export interface SshScriptRemote {
  /** Thư mục của lần triển khai trên máy chủ (đường dẫn tuyệt đối). */
  dir: string;
  /** PID của `run.sh`, cũng là id nhóm tiến trình (`setsid`). */
  pid: number;
  /** Số byte log đã đọc. */
  offset: number;
}

function scriptConfig(config: TargetConfig): SshScriptConfig {
  if (config.method !== "ssh-script") throw new Error(`Đích dùng cách ${config.method}, không phải ssh-script.`);
  return config;
}

function remoteOf(remote: Record<string, unknown> | null): SshScriptRemote | null {
  if (!remote) return null;
  const { dir, pid, offset } = remote;
  if (typeof dir !== "string" || !dir.startsWith("/")) return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return null;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return null;
  return { dir, pid, offset };
}

// ---- Lỗi SSH ----------------------------------------------------------------------------------------------------------

/** Như servers.ts: lỗi SSH thành lỗi nghiệp vụ, không kèm khoá hay lệnh. */
function sshFailure(e: unknown): unknown {
  if (!(e instanceof SshError)) return e;
  const code =
    e.kind === "auth"
      ? "SSH_AUTH_FAILED"
      : e.kind === "hostkey_changed" || e.kind === "hostkey_unconfirmed"
        ? "SSH_HOSTKEY_CHANGED"
        : "SSH_UNREACHABLE";
  const message =
    code === "SSH_UNREACHABLE" ? `${e.message} ${DELIVERY_ERRORS[code].message}` : DELIVERY_ERRORS[code].message;
  return new ConflictError(code, message, e.hostKey ? { fingerprint: e.hostKey.fingerprint } : undefined);
}

/**
 * Host key đổi khi bắt đầu: audit và báo quản trị trong giao dịch riêng, vì lỗi ném ra làm orchestrator huỷ giao dịch
 * của lần gọi. `poll` không báo: nó chạy 2 giây một lần, báo ở đó là một thông báo mỗi 2 giây.
 */
async function reportChanged(ctx: DeployMethodContext, run: DeployRun, serverId: string, presented: HostKey) {
  const report = (tx: DeployMethodContext["tx"]) => reportHostKeyChanged(tx, ctx.deps, run.orgId, serverId, presented);
  if (!ctx.deps.pool) return report(ctx.tx);
  return withTenant(ctx.deps.pool, { orgId: run.orgId, userId: run.requestedBy ?? undefined }, report);
}

// ---- Lệnh trên máy chủ -------------------------------------------------------------------------------------------------

// SFTP không hiểu `~`: lấy đường dẫn tuyệt đối từ shell. Dọn thư mục cũ ở đây để mỗi lần bắt đầu chỉ một phiên SSH.
// Có `pid` là lần bắt đầu trước đã chạy `run.sh` (hub chết ngay sau đó): không gửi, không chạy lại.
const prepareCommand = (deployId: string) => `umask 077
base="$HOME/${DEPLOY_ROOT}"
mkdir -p "$base" || exit 3
find "$base" -mindepth 1 -maxdepth 1 -type d -mtime +${KEEP_DAYS} ! -name ${shellQuote(deployId)} -exec rm -rf {} + 2>/dev/null
d="$base/${deployId}"
if [ -f "$d/pid" ]; then printf 'launched %s %s\\n' "$(cat "$d/pid")" "$d"; exit 0; fi
rm -rf "$d" && mkdir -p "$d/steps" || exit 3
printf 'new %s\\n' "$d"`;

// `setsid` tách `run.sh` khỏi phiên SSH; sh không bật job control nên tiến trình nền không làm trưởng nhóm, setsid
// không fork thêm: `$!` là PID và cũng là id nhóm để huỷ (spike T001).
const launchCommand = (dir: string) => `cd ${shellQuote(dir)} || exit 3
if [ -f pid ]; then cat pid; exit 0; fi
nohup setsid sh run.sh > /dev/null 2>&1 < /dev/null &
echo $! > pid
cat pid`;

// Đọc status trước, log sau: `run.sh` ghi log xong mới ghi `done`, nên thấy `done` là log đã đủ. Log chuyển dạng
// base64 để vị trí đọc tiếp tính đúng theo byte, không vỡ ở ký tự nhiều byte.
const pollCommand = (r: SshScriptRemote) => `cd ${shellQuote(r.dir)} 2>/dev/null || { echo nodir; exit 0; }
if kill -0 ${r.pid} 2>/dev/null; then echo alive; else echo dead; fi
cat status.json 2>/dev/null
printf '\\n${LOG_MARK}\\n'
tail -c +${r.offset + 1} log 2>/dev/null | head -c ${LOG_CHUNK_BYTES} | base64`;

// Chỉ gửi TERM khi `pid` vẫn là của lần này và `run.sh` chưa xong: PID cũ có thể đã thuộc tiến trình khác.
const cancelCommand = (r: SshScriptRemote) => `cd ${shellQuote(r.dir)} 2>/dev/null || exit 0
if [ "$(cat pid 2>/dev/null)" = "${r.pid}" ] && ! grep -q '"done":true' status.json 2>/dev/null; then
  kill -TERM -- -${r.pid} 2>/dev/null
fi
exit 0`;

/** Số byte đầu của `buf` gồm trọn ký tự UTF-8; ký tự bị cắt ở cuối để lần đọc sau. */
export function completeUtf8Length(buf: Buffer): number {
  let i = buf.length - 1;
  let continuation = 0;
  while (i >= 0 && continuation < 3 && ((buf[i] ?? 0) & 0xc0) === 0x80) {
    i--;
    continuation++;
  }
  if (i < 0) return buf.length;
  const lead = buf[i] ?? 0;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return i + need <= buf.length ? buf.length : i;
}

interface PollOutput {
  presence: "alive" | "dead" | "nodir";
  status: RunStatus | null;
  log: Buffer;
}

function parsePollOutput(stdout: string): PollOutput {
  const mark = stdout.indexOf(`\n${LOG_MARK}\n`);
  const head = mark < 0 ? stdout : stdout.slice(0, mark);
  const tail = mark < 0 ? "" : stdout.slice(mark + LOG_MARK.length + 2);
  const newline = head.indexOf("\n");
  const first = (newline < 0 ? head : head.slice(0, newline)).trim();
  const presence = first === "alive" || first === "dead" ? first : "nodir";
  return {
    presence,
    status: newline < 0 ? null : parseRunStatus(head.slice(newline + 1)),
    log: Buffer.from(tail.replace(/\s+/g, ""), "base64"),
  };
}

// ---- Bước --------------------------------------------------------------------------------------------------------------

const HEALTH = "health";

function healthStep(config: SshScriptConfig, state: DeployStep["state"], message: string | null): DeployStep {
  if (!config.health) {
    return {
      key: HEALTH,
      state: "skipped",
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      message: "Đích không cấu hình kiểm health.",
    };
  }
  return { key: HEALTH, state, startedAt: null, finishedAt: null, exitCode: null, message };
}

/** Bước lúc vừa bắt đầu: bốn bước của `run.sh` rồi health. */
export function initialSteps(config: SshScriptConfig, skipBackupReason: string | null): DeployStep[] {
  return [...scriptSteps(null, { config, skipBackupReason }), healthStep(config, "pending", null)];
}

async function deployRow(ctx: DeployMethodContext, deployId: string) {
  const [row] = await ctx.tx
    .select({ skipBackupReason: deploys.skipBackupReason, steps: deploys.steps })
    .from(deploys)
    .where(eq(deploys.id, deployId));
  if (!row) throw new NotFoundError("NOT_FOUND", "Không tìm thấy lần triển khai.");
  return row;
}

// ---- start -------------------------------------------------------------------------------------------------------------

interface StoredVariable {
  name: string;
  secret: boolean;
  valueEnc?: string;
}

/** Biến của đích: biến thường lấy từ cấu hình của lần triển khai, biến bí mật giải mã từ bản đã lưu của đích. */
async function targetVariables(
  ctx: DeployMethodContext,
  run: DeployRun,
  config: SshScriptConfig,
  stored: Record<string, unknown>,
): Promise<Array<{ name: string; value: string }>> {
  const saved = (Array.isArray(stored.variables) ? stored.variables : []) as StoredVariable[];
  return config.variables.map((v) => {
    if (!v.secret) return { name: v.name, value: v.value };
    const enc = saved.find((s) => s.name === v.name && s.secret)?.valueEnc;
    if (!enc) {
      throw new ConflictError(
        "DEPLOY_VARIABLE_MISSING",
        `Biến bí mật ${v.name} của đích chưa có giá trị. Quản trị đội nhập lại ở cấu hình đích rồi triển khai lại.`,
      );
    }
    return {
      name: v.name,
      value: decryptSecret(requireMasterKey(ctx.deps), enc, targetVariableContext(run.targetId, v.name)),
    };
  });
}

function archiveError(e: unknown, scm: ScmTarget, commit: string): unknown {
  if (e instanceof GitProviderError && e.code === "not_found") {
    return new NotFoundError(
      "DEPLOY_COMMIT_NOT_FOUND",
      `Không tải được mã của commit ${commit.slice(0, 8)} từ ${scm.ref.owner}/${scm.ref.name}. Kiểm lại commit còn trong repo.`,
    );
  }
  return scmDomainError(e, scm, "tải mã nguồn");
}

interface Upload {
  runSh: string;
  stepFiles: Record<string, string>;
  vars: string;
  archive: { scm: ScmTarget; commit: string } | null;
}

async function upload(conn: SshConnection, deployId: string, files: Upload): Promise<SshScriptRemote> {
  const prepared = await conn.exec(prepareCommand(deployId));
  const line = prepared.stdout.trim();
  const launched = /^launched (\d+) (\/.+)$/.exec(line);
  if (launched) return { dir: launched[2] as string, pid: Number(launched[1]), offset: 0 };
  const fresh = /^new (\/.+)$/.exec(line);
  if (prepared.code !== 0 || !fresh) {
    throw new Error(`Không tạo được thư mục ~/${DEPLOY_ROOT}/${deployId} trên máy chủ: ${prepared.stderr.trim()}`);
  }
  const dir = fresh[1] as string;
  try {
    await conn.writeFile(`${dir}/run.sh`, files.runSh);
    for (const [path, content] of Object.entries(files.stepFiles)) await conn.writeFile(`${dir}/${path}`, content);
    // Biến (có biến bí mật) chỉ đọc được bởi người dùng SSH; run.sh xoá ngay sau khi đọc.
    await conn.writeFile(`${dir}/vars`, files.vars, { mode: 0o600 });
    if (files.archive) {
      const { scm, commit } = files.archive;
      let stream: ReadableStream<Uint8Array>;
      try {
        stream = await scm.provider.archive(scm.ref, commit);
      } catch (e) {
        throw archiveError(e, scm, commit);
      }
      await conn.writeFile(`${dir}/src.new.tar.gz`, stream);
    }
    const started = await conn.exec(launchCommand(dir));
    const pid = Number(started.stdout.trim());
    if (started.code !== 0 || !Number.isInteger(pid) || pid <= 1) {
      throw new Error(`Không chạy được run.sh trên máy chủ: ${started.stderr.trim()}`);
    }
    return { dir, pid, offset: 0 };
  } catch (e) {
    // Chưa chạy được thì không để biến bí mật và bản dở nằm lại; lần thử sau làm lại từ đầu.
    await conn.exec(`[ -f ${shellQuote(`${dir}/pid`)} ] || rm -rf ${shellQuote(dir)}`).catch(() => undefined);
    throw e;
  }
}

async function start(ctx: DeployMethodContext, run: DeployRun): Promise<DeployStarted> {
  const config = scriptConfig(run.config);
  if (!DEPLOY_ID.test(run.deployId)) throw new Error(`Mã lần triển khai không hợp lệ: ${run.deployId}`);
  const deploy = await deployRow(ctx, run.deployId);
  const [target] = await ctx.tx
    .select({ projectId: deployTargets.projectId, config: deployTargets.config })
    .from(deployTargets)
    .where(eq(deployTargets.id, run.targetId));
  if (!target) throw new NotFoundError("NOT_FOUND", "Không tìm thấy đích triển khai.");

  // Đọc hết từ database trước khi mở SSH.
  const vars = buildVarsFile(await targetVariables(ctx, run, config, target.config));
  let archive: Upload["archive"] = null;
  if (config.steps.upload.mode === "git-archive") {
    const commit = run.version.commit;
    if (!commit) {
      throw new ConflictError(
        "DEPLOY_NO_COMMIT",
        "Lần triển khai không có commit nên không gửi được mã nguồn lên máy chủ. Chọn commit rồi triển khai lại.",
      );
    }
    const project = await loadProject(ctx.tx, target.projectId);
    if (!project) throw new NotFoundError("NOT_FOUND", "Không tìm thấy dự án.");
    archive = { scm: await scmTarget(ctx.tx, ctx.deps, project), commit };
  }
  const ssh = await serverSshTarget(ctx.tx, ctx.deps, config.serverId, {
    reason: "deploy.start",
    group: `deploy:${run.deployId}`,
  });
  const script = buildRunScript({
    deployId: run.deployId,
    config,
    version: { commit: run.version.commit, tag: run.version.tag },
    skipBackup: deploy.skipBackupReason !== null,
  });

  const remote = await onServer(ctx, run, config.serverId, ssh, (conn) =>
    upload(conn, run.deployId, { runSh: script.runSh, stepFiles: script.stepFiles, vars, archive }),
  );
  return { steps: initialSteps(config, deploy.skipBackupReason), remote: { ...remote } };
}

async function onServer<T>(
  ctx: DeployMethodContext,
  run: DeployRun,
  serverId: string,
  target: SshTarget,
  fn: (conn: SshConnection) => Promise<T>,
): Promise<T> {
  try {
    return await withSsh(target, fn);
  } catch (e) {
    if (e instanceof SshError && e.kind === "hostkey_changed" && e.hostKey) {
      await reportChanged(ctx, run, serverId, e.hostKey);
    }
    throw sshFailure(e);
  }
}

// ---- poll --------------------------------------------------------------------------------------------------------------

async function poll(ctx: DeployMethodContext, run: DeployRun): Promise<DeployProgress> {
  const config = scriptConfig(run.config);
  const deploy = await deployRow(ctx, run.deployId);
  const stepCtx: StepContext = { config, skipBackupReason: deploy.skipBackupReason };
  const remote = remoteOf(run.remote);
  if (!remote) {
    return {
      state: "unknown",
      steps: deploy.steps.length ? deploy.steps : initialSteps(config, deploy.skipBackupReason),
    };
  }
  const ssh = await serverSshTarget(ctx.tx, ctx.deps, config.serverId, {
    reason: "deploy.poll",
    group: `deploy:${run.deployId}`,
  });
  let stdout: string;
  try {
    stdout = (await withSsh(ssh, (conn) => conn.exec(pollCommand(remote)))).stdout;
  } catch (e) {
    throw sshFailure(e);
  }
  const out = parsePollOutput(stdout);
  if (out.presence === "nodir") {
    return {
      state: "unknown",
      steps: deploy.steps.length ? deploy.steps : initialSteps(config, deploy.skipBackupReason),
    };
  }
  return progress(ctx, run, config, stepCtx, remote, out);
}

async function progress(
  ctx: DeployMethodContext,
  run: DeployRun,
  config: SshScriptConfig,
  stepCtx: StepContext,
  remote: SshScriptRemote,
  out: PollOutput,
): Promise<DeployProgress> {
  const { status } = out;
  const more = out.log.length >= LOG_CHUNK_BYTES;
  const done = status?.done === true && !more;
  // Còn đọc tiếp thì giữ ký tự bị cắt ở cuối cho lần sau; đã xong thì lấy hết.
  const used = done ? out.log.length : completeUtf8Length(out.log);
  const log = used ? out.log.subarray(0, used).toString("utf8") : undefined;
  const next = { ...remote, offset: remote.offset + used };
  const steps = scriptSteps(status, stepCtx);
  const result = (state: DeployProgress["state"], health: DeployStep, extra: Partial<DeployProgress> = {}) => ({
    state,
    steps: [...steps, health],
    remote: { ...next },
    log,
    ...extra,
  });

  if (!status?.done || more) {
    // Chưa xong mà run.sh không còn chạy: máy chủ khởi động lại hoặc ai đó giết tiến trình. Hub không đoán bước dở
    // đã làm gì trên máy chủ.
    const state = status?.done || more || out.presence === "alive" ? "running" : "unknown";
    return result(state, healthStep(config, "pending", null));
  }
  if (status.steps.some((s) => s.state === "canceled") || status.exit === 143) {
    return result("canceled", healthStep(config, "canceled", "Đã huỷ."));
  }
  if (status.exit !== 0 || status.steps.some((s) => s.state === "failed")) {
    return result("failed", healthStep(config, "skipped", "Bỏ qua vì bước trước lỗi."));
  }
  if (!config.health) return result("succeeded", healthStep(config, "skipped", null));

  const startedAt = new Date().toISOString();
  const health: HealthResult = await runHealthCheck(config.health, {
    version: { commit: run.version.commit, tag: run.version.tag },
    fetch: ctx.deps.fetch,
    signal: run.signal,
  });
  // Hub dừng giữa lúc chờ health: lần đọc sau kiểm lại từ đầu.
  if (run.signal.aborted) return result("running", healthStep(config, "running", null));
  const step: DeployStep = {
    key: HEALTH,
    state: health.ok ? "succeeded" : "failed",
    startedAt,
    finishedAt: health.at,
    exitCode: null,
    message: health.message,
  };
  return result(health.ok ? "succeeded" : "failed_needs_review", step, { health });
}

// ---- cancel, version --------------------------------------------------------------------------------------------------

async function cancel(ctx: DeployMethodContext, run: DeployRun): Promise<void> {
  const config = scriptConfig(run.config);
  const remote = remoteOf(run.remote);
  // Chưa chạy run.sh thì không có gì trên máy chủ để dừng.
  if (!remote) return;
  const ssh = await serverSshTarget(ctx.tx, ctx.deps, config.serverId, {
    reason: "deploy.cancel",
    group: `deploy:${run.deployId}`,
  });
  try {
    await withSsh(ssh, (conn) => conn.exec(cancelCommand(remote)));
  } catch (e) {
    throw sshFailure(e);
  }
}

/** Máy chủ không ghi phiên bản đang chạy theo cách chung: lấy lần gần nhất đã chạy xong các bước trên đích. */
async function version(
  ctx: DeployMethodContext,
  target: { targetId: string; config: TargetConfig },
): Promise<DeployVersion | null> {
  const [row] = await ctx.tx
    .select({ version: deploys.version })
    .from(deploys)
    .where(and(eq(deploys.targetId, target.targetId), inArray(deploys.state, ["succeeded", "failed_needs_review"])))
    .orderBy(sql`${deploys.finishedAt} desc nulls last`, sql`${deploys.createdAt} desc`)
    .limit(1);
  if (!row) return null;
  return {
    commit: row.version.commit,
    tag: row.version.tag,
    jenkinsBuild: null,
    image: null,
    images: [],
    revision: null,
  };
}

export const sshScript: DeployMethod = { method: "ssh-script", start, poll, cancel, version };
