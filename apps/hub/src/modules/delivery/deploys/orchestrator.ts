import {
  createRedactor,
  DELIVERY_ERRORS,
  DEPLOY_ACTIVE_STATES,
  type Deploy,
  type DeployCreateInput,
  type DeployMethod as DeployMethodName,
  type DeployState,
  type DeployStep,
  type DeployVersion,
  type DeployVersionInput,
  PRIVATE_KEY_END,
  type Redactor,
  SECRET_PATTERNS,
  type TargetConfig,
} from "@xdev-hive/contracts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../../audit/index.ts";
import { findProject, loadProject } from "../../catalog/index.ts";
import {
  BadRequestError,
  ConflictError,
  decryptSecret,
  encryptSecret,
  ForbiddenError,
  type Jobs,
  NotFoundError,
  type Tx,
  withTenant,
} from "../../platform/index.ts";
import { effectivePermissions, teamMemberIds, teamRoleOf } from "../../tenancy/index.ts";
import { scmDomainError, scmTarget } from "../ci/feed.ts";
import { pgCode } from "../connections/jenkins.ts";
import type { DeliveryDeps } from "../deps.ts";
import { loadEnvironment, peopleOf } from "../environments.ts";
import { appendDeployLog, notifyDeploy } from "../logs.ts";
import { emitDeliveryEvent } from "../notifications.ts";
import { DELIVERY_DEPLOY_QUEUE, DELIVERY_DEPLOY_WATCH_QUEUE } from "../queues.ts";
import { deployApprovals, deploys, deployTargets } from "../schema.ts";
import { targetVariableContext } from "../targets.ts";
import { type DeployRow, deployNotFound, deployView, type LocatedDeploy, loadLocatedDeploy } from "./board.ts";
import type { DeployMethod, DeployMethodContext, DeployProgress, DeployRun } from "./method.ts";
import { methodFor as registeredMethodFor } from "./methods.ts";

// Bộ điều phối lần triển khai (FR-015…FR-019, FR-025, plan.md mục 5): tạo lần mới và giữ khoá đích, job
// `delivery-deploy` giao cho cách triển khai, job `delivery-deploy-watch` đọc tiến độ mỗi 2 giây tới khi xong. Mọi trạng
// thái đọc tiếp được nằm trong `deploys.remote`, nên hub khởi động lại giữa chừng thì watch chạy tiếp từ chỗ đã lưu.

/** Dữ liệu của cả hai job; `singletonKey` là id lần triển khai. */
export interface DeployJob {
  orgId: string;
  deployId: string;
}

export interface OrchestratorOptions {
  /** Test đăng ký cách triển khai giả ở đây, không phải sửa `deployMethods`. */
  methodFor?: ((method: DeployMethodName) => DeployMethod) | undefined;
  /** Đồng hồ giả để thử mốc 15 phút. */
  now?: (() => Date) | undefined;
}

interface JobOptions extends OrchestratorOptions {
  /** pg-boss huỷ khi worker dừng; job khi đó được nhận lại sau nên không đánh dấu thất bại. */
  signal?: AbortSignal | undefined;
}

export const WATCH_INTERVAL_MS = 2000;
/** Không đọc được máy chủ hay nguồn lâu hơn thế thì kết luận `unknown` (FR-025), không tự chạy lại. */
export const UNREACHABLE_AFTER_MS = 15 * 60 * 1000;
// Phần log chưa trọn dòng (hay khối khoá riêng chưa thấy END) giữ lại tối đa chừng này; dài hơn thì che và ghi luôn, giống
// ngưỡng của redactor, để một dòng không xuống dòng (thanh tiến độ) không làm phần giữ lớn mãi.
const MAX_HELD = 64 * 1024;
// Đang bỏ phần thân một khoá riêng quá dài: giữ đuôi đủ dài để dòng END bị cắt đôi giữa hai lần đọc vẫn khớp.
const KEY_END_TAIL = 200;
// Khoá của phần riêng Hive trong `deploys.remote`; phần còn lại thuộc về cách triển khai.
const HIVE_KEY = "_hive";
const UNIQUE_VIOLATION = "23505";

const clock = (opts: OrchestratorOptions) => opts.now ?? (() => new Date());
const methodOf = (opts: OrchestratorOptions, method: string) =>
  (opts.methodFor ?? registeredMethodFor)(method as DeployMethodName);

const targetNotFound = () => new NotFoundError("NOT_FOUND", "Không tìm thấy đích triển khai.");
const envLocked = (reason: string | null) =>
  new ConflictError("ENV_LOCKED", DELIVERY_ERRORS.ENV_LOCKED.message, reason !== null ? { reason } : undefined);
const notActive = () => new ConflictError("DEPLOY_NOT_ACTIVE", "Lần triển khai này đã kết thúc, không huỷ được.");

type TargetRow = typeof deployTargets.$inferSelect;
type EnvRow = NonNullable<Awaited<ReturnType<typeof loadEnvironment>>>;

// ---- Trạng thái riêng của Hive trong `remote` -----------------------------------------------------------------------

interface HiveState {
  /** Lần đầu không đọc được tiến độ trong chuỗi lỗi liền nhau. */
  failingSince?: string | undefined;
  /** Phần log chưa ghi (chưa trọn dòng), mã hoá vì chưa che bí mật. */
  logTail?: string | undefined;
  /** Đang bỏ thân một khoá riêng quá dài tới dòng END. */
  dropKey?: boolean | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function splitRemote(remote: Record<string, unknown> | null): {
  own: Record<string, unknown> | null;
  hive: HiveState;
} {
  if (!remote) return { own: null, hive: {} };
  const { [HIVE_KEY]: hive, ...own } = remote;
  return { own: Object.keys(own).length > 0 ? own : null, hive: isRecord(hive) ? (hive as HiveState) : {} };
}

function joinRemote(own: Record<string, unknown> | null, hive: HiveState): Record<string, unknown> | null {
  const kept = Object.fromEntries(Object.entries(hive).filter(([, v]) => v !== undefined && v !== false));
  if (Object.keys(kept).length === 0) return own;
  return { ...(own ?? {}), [HIVE_KEY]: kept };
}

// ---- Che bí mật trong log -------------------------------------------------------------------------------------------

/** Giá trị biến bí mật của đích, để che trong log (FR-019). Giá trị nhiều dòng che thêm từng dòng: log có thể in xen. */
function targetSecrets(deps: DeliveryDeps, target: TargetRow): string[] {
  const variables = (target.config as { variables?: unknown }).variables;
  if (!deps.masterKey || !Array.isArray(variables)) return [];
  const out: string[] = [];
  for (const v of variables as Array<{ name?: unknown; secret?: unknown; valueEnc?: unknown }>) {
    if (v.secret !== true || typeof v.valueEnc !== "string" || typeof v.name !== "string") continue;
    try {
      const value = decryptSecret(deps.masterKey, v.valueEnc, targetVariableContext(target.id, v.name));
      out.push(value, ...value.split(/\r?\n/).map((line) => line.trim()));
    } catch {
      // Biến hỏng không được làm hỏng việc ghi log; bộ mẫu chung vẫn che các dạng bí mật thường gặp.
    }
  }
  return out.filter((s) => s !== "");
}

/** Che cả đoạn như đoạn cuối: phần chưa chắc trọn vẹn đã được giữ lại trước khi tới đây. */
function maskAll(secrets: string[], text: string): string {
  const r = createRedactor(secrets);
  return r.push(text) + r.flush();
}

// appendDeployLog nhận redactor; chữ tới đây đã che xong nên đi thẳng.
const MASKED: Redactor = { push: (t) => t, flush: () => "" };

const keyBegin = () => new RegExp((SECRET_PATTERNS.find((p) => p.kind === "private_key")?.re ?? /$^/).source, "g");
const keyEnd = () => new RegExp(PRIVATE_KEY_END.source, "g");

/** Khoá riêng có dòng BEGIN mà chưa có END sau nó trong `text`: trả vị trí BEGIN, không có thì -1. */
function openKeyAt(text: string): number {
  for (const m of text.matchAll(keyBegin())) {
    const end = keyEnd();
    end.lastIndex = m.index + m[0].length;
    if (!end.exec(text)) return m.index;
  }
  return -1;
}

interface LogSplit {
  /** Chữ thô ghi được ngay (che bằng maskAll). */
  ready: string;
  /** Chữ thô giữ tới lần đọc sau. */
  hold: string;
  dropKey: boolean;
}

/**
 * Tách log mới thành phần ghi được và phần giữ lại. Chỉ ghi trọn dòng, và giữ cả khối khoá riêng chưa thấy END, để bí mật
 * bị cắt giữa hai lần đọc vẫn bị che; phần giữ được lưu (mã hoá) cùng giao dịch với vị trí đọc nên hub chết giữa chừng
 * không mất, không lặp.
 */
function splitLog(raw: string, final: boolean, dropping: boolean): LogSplit {
  let text = raw;
  if (dropping) {
    const end = keyEnd().exec(text);
    if (!end) return { ready: "", hold: final ? "" : text.slice(-KEY_END_TAIL), dropKey: !final };
    text = text.slice(end.index + end[0].length);
  }
  if (final) return { ready: text, hold: "", dropKey: false };
  let cut = text.lastIndexOf("\n") + 1;
  const open = openKeyAt(text.slice(0, cut));
  if (open !== -1) cut = text.lastIndexOf("\n", open) + 1;
  const hold = text.slice(cut);
  // Giữ quá nhiều: ghi luôn (redactor che khoá còn mở tới hết chữ), phần thân khoá còn lại bị bỏ tới dòng END.
  if (hold.length > MAX_HELD) return { ready: text, hold: "", dropKey: openKeyAt(hold) !== -1 };
  return { ready: text.slice(0, cut), hold, dropKey: false };
}

const tailContext = (deployId: string) => `deploys:${deployId}:log-tail`;

function heldLog(deps: DeliveryDeps, deployId: string, hive: HiveState): string {
  if (!hive.logTail || !deps.masterKey) return "";
  try {
    return decryptSecret(deps.masterKey, hive.logTail, tailContext(deployId));
  } catch {
    return "";
  }
}

/**
 * Ghi log mới cùng phần giữ từ lần trước; trả trạng thái Hive mới (phần giữ, cờ bỏ khoá). Không có master key thì không
 * lưu được phần giữ an toàn nên ghi hết mỗi lần. `close`: ghi hết và xuống dòng, vì Hive sắp viết dòng của nó (huỷ,
 * `unknown`).
 */
async function writeLog(
  tx: Tx,
  deps: DeliveryDeps,
  deploy: DeployRow,
  target: TargetRow,
  hive: HiveState,
  text: string,
  final: boolean | "close",
): Promise<HiveState> {
  const raw = heldLog(deps, deploy.id, hive) + text;
  if (raw === "" && !hive.dropKey) return { ...hive, logTail: undefined };
  const split = splitLog(raw, final !== false || !deps.masterKey, hive.dropKey === true);
  const ready =
    final === "close" && split.ready !== "" && !split.ready.endsWith("\n") ? `${split.ready}\n` : split.ready;
  if (ready !== "") await appendDeployLog(tx, deploy.id, maskAll(targetSecrets(deps, target), ready), MASKED);
  return {
    ...hive,
    logTail:
      split.hold !== "" && deps.masterKey
        ? encryptSecret(deps.masterKey, split.hold, tailContext(deploy.id))
        : undefined,
    dropKey: split.dropKey || undefined,
  };
}

/** Dòng do Hive viết vào log (lỗi đọc, huỷ); vẫn che vì thông báo lỗi có thể chứa giá trị của máy chủ. */
async function hiveLine(tx: Tx, deps: DeliveryDeps, deploy: DeployRow, target: TargetRow | null, line: string) {
  const secrets = target ? targetSecrets(deps, target) : [];
  await appendDeployLog(tx, deploy.id, maskAll(secrets, `[Hive] ${line}\n`), MASKED);
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- Đọc dữ liệu ----------------------------------------------------------------------------------------------------

async function lockDeploy(tx: Tx, id: string): Promise<DeployRow | null> {
  const [row] = await tx.select().from(deploys).where(eq(deploys.id, id)).for("update");
  return row ?? null;
}

async function loadTarget(tx: Tx, id: string): Promise<TargetRow | null> {
  const [row] = await tx.select().from(deployTargets).where(eq(deployTargets.id, id));
  return row ?? null;
}

/** Cấu hình như API trả ra: biến bí mật chỉ cho biết đã đặt; cách triển khai tự giải mã qua `targetVariableContext`. */
function viewConfig(config: Record<string, unknown>): TargetConfig {
  if (config.method !== "ssh-script") return config as TargetConfig;
  const variables = (
    (config.variables ?? []) as Array<{ name: string; secret: boolean; value?: string; valueEnc?: string }>
  ).map((v) =>
    v.secret
      ? { name: v.name, secret: true as const, set: typeof v.valueEnc === "string" }
      : { name: v.name, secret: false as const, value: v.value ?? "" },
  );
  return { ...config, variables } as TargetConfig;
}

function runOf(
  orgId: string,
  deploy: DeployRow,
  target: TargetRow,
  remote: Record<string, unknown> | null,
  signal: AbortSignal,
): DeployRun {
  return {
    orgId,
    deployId: deploy.id,
    targetId: deploy.targetId,
    config: viewConfig(target.config),
    version: deploy.version,
    requestedBy: deploy.requestedBy,
    remote,
    external: deploy.external,
    signal,
  };
}

function requirePool(deps: DeliveryDeps) {
  if (!deps.pool) throw new Error("Bộ điều phối triển khai cần pool database.");
  return deps.pool;
}

async function locate(tx: Tx, id: string): Promise<LocatedDeploy> {
  const row = await loadLocatedDeploy(tx, id);
  if (!row) throw deployNotFound();
  return row;
}

// ---- Thông báo ------------------------------------------------------------------------------------------------------

function versionLabel(v: DeployVersion): string {
  if (v.commit) return v.commit.slice(0, 8);
  if (v.tag) return v.tag;
  if (v.jenkinsBuild !== null) return `build #${v.jenkinsBuild}`;
  return v.image ?? v.revision ?? "bản mới";
}

const deployLink = (deps: DeliveryDeps, id: string) =>
  deps.publicUrl ? `${deps.publicUrl.replace(/\/+$/, "")}/deploys/${id}` : null;

async function describe(tx: Tx, row: LocatedDeploy) {
  const project = await findProject(tx, row.projectId);
  const env = await loadEnvironment(tx, row.environmentId);
  return { project: project?.name ?? "dự án", env: env?.name ?? "môi trường" };
}

const FINISH_TEXT: Partial<Record<DeployState, [string, string]>> = {
  succeeded: ["thành công", "Bản {v} đang chạy trên {env}."],
  failed: ["thất bại", "Bản {v} lỗi{step}. Xem log của lần triển khai."],
  failed_needs_review: ["cần xem lại", "Các bước của bản {v} đã chạy xong nhưng kiểm tra sức khoẻ không đạt."],
  unknown: [
    "không rõ kết quả",
    "Hive không đọc được máy chủ hay nguồn quá 15 phút khi triển khai bản {v}. Kiểm tra trên máy chủ trước khi chạy lại.",
  ],
};

/** started/succeeded/failed cho người bấm và người đã duyệt; `eventKey` ổn định nên job chạy lại không báo hai lần. */
async function emitDeployEvent(tx: Tx, deps: DeliveryDeps, deployId: string, state: DeployState): Promise<void> {
  const row = await locate(tx, deployId);
  const d = row.deploy;
  if (d.origin !== "hive") return;
  const { project, env } = await describe(tx, row);
  const approvers = await tx
    .select({ userId: deployApprovals.userId })
    .from(deployApprovals)
    .where(and(eq(deployApprovals.deployId, d.id), eq(deployApprovals.decision, "approve")));
  const recipientIds = [d.requestedBy, ...approvers.map((a) => a.userId)].filter((id): id is string => id !== null);
  const v = versionLabel(d.version);
  let event: "deploy.started" | "deploy.succeeded" | "deploy.failed";
  let title: string;
  let body: string;
  if (state === "running") {
    const who = d.requestedBy ? ((await peopleOf(tx, [d.requestedBy])).get(d.requestedBy)?.name ?? "") : "";
    event = "deploy.started";
    title = `Đang triển khai ${project} lên ${env}`;
    body = `${who ? `${who} triển khai` : "Triển khai"} bản ${v} lên ${env}.`;
  } else {
    const [outcome, template] = FINISH_TEXT[state] ?? ["thất bại", "Bản {v} lỗi{step}."];
    const failedStep = d.steps.find((s) => s.state === "failed");
    event = state === "succeeded" ? "deploy.succeeded" : "deploy.failed";
    title = `Triển khai ${project} lên ${env} ${outcome}`;
    body = template
      .replace("{v}", v)
      .replace("{env}", env)
      .replace("{step}", failedStep ? ` ở bước ${failedStep.key}` : "");
  }
  await emitDeliveryEvent(
    tx,
    {
      orgId: d.orgId,
      event,
      title,
      body,
      systemId: row.systemId,
      eventKey: `deploy:${d.id}:${event}`,
      recipientIds,
      link: deployLink(deps, d.id),
    },
    deps.jobs,
  );
}

// ---- Tạo ------------------------------------------------------------------------------------------------------------

/** Quyền bấm Triển khai/Huỷ: `deploy.run` của đội sở hữu môi trường, cộng vai trò trong `deployRoles` nếu có. */
async function requireDeployRun(tx: Tx, userId: string, env: EnvRow, notFound: () => NotFoundError): Promise<void> {
  const granted = await effectivePermissions(tx, userId, env.teamId);
  if (!granted.has("ci.view")) throw notFound();
  if (!granted.has("deploy.run"))
    throw new ForbiddenError(
      "DEPLOY_RUN_REQUIRED",
      "Bạn chưa có quyền deploy.run của đội sở hữu môi trường này nên chưa triển khai được.",
    );
  const roles = env.policy.deployRoles as string[];
  if (roles.length === 0) return;
  const role = await teamRoleOf(tx, userId, env.teamId);
  if (!role || !roles.includes(role))
    throw new ForbiddenError(
      "DEPLOY_ROLE_REQUIRED",
      `Môi trường ${env.name} chỉ cho một số vai trò của đội triển khai; vai trò của bạn chưa nằm trong đó.`,
    );
}

/** Lần do Hive tạo đang đi trên đích; lần "ngoài Hive" chỉ là ghi nhận nên không tính. */
async function inFlight(tx: Tx, targetId: string): Promise<DeployRow | null> {
  const [row] = await tx
    .select()
    .from(deploys)
    .where(
      and(
        eq(deploys.targetId, targetId),
        eq(deploys.origin, "hive"),
        inArray(deploys.state, [...DEPLOY_ACTIVE_STATES]),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function inProgressError(tx: Tx, active: DeployRow): Promise<ConflictError> {
  const by = active.requestedBy ? ((await peopleOf(tx, [active.requestedBy])).get(active.requestedBy) ?? null) : null;
  const since = active.startedAt ?? active.createdAt;
  const time = since.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
  return new ConflictError(
    "DEPLOY_IN_PROGRESS",
    by ? `Đang triển khai bởi ${by.name} từ ${time}.` : DELIVERY_ERRORS.DEPLOY_IN_PROGRESS.message,
    { deployId: active.id, by, since: since.toISOString() },
  );
}

async function resolveVersion(
  tx: Tx,
  deps: DeliveryDeps,
  target: TargetRow,
  env: EnvRow,
  input: DeployVersionInput,
): Promise<DeployVersion> {
  const empty: DeployVersion = { commit: null, tag: null, jenkinsBuild: null, image: null, images: [], revision: null };
  const config = target.config as { method?: string; branch?: string | null; imageTemplate?: string };
  switch (input.kind) {
    case "commit": {
      if (input.sha) return { ...empty, commit: input.sha };
      const project = await loadProject(tx, target.projectId);
      if (!project) throw new NotFoundError("NOT_FOUND", "Không tìm thấy dự án.");
      const branch = config.branch ?? project.defaultBranch;
      if (!branch)
        throw new BadRequestError(
          "BRANCH_REQUIRED",
          "Dự án chưa có nhánh mặc định. Chọn commit hoặc đặt nhánh cho đích.",
        );
      const scm = await scmTarget(tx, deps, project);
      let head: string | null;
      try {
        head = await scm.provider.branchHead(scm.ref, branch);
      } catch (e) {
        throw scmDomainError(e, scm, "đọc commit mới nhất");
      }
      if (!head) throw new BadRequestError("BRANCH_NOT_FOUND", `Không tìm thấy nhánh ${branch} trên kho mã.`);
      return { ...empty, commit: head };
    }
    case "tag":
      return { ...empty, tag: input.tag };
    case "image":
      return {
        ...empty,
        tag: input.tag,
        image:
          config.method === "kubectl" && config.imageTemplate
            ? config.imageTemplate.replaceAll("{{tag}}", input.tag)
            : null,
      };
    case "fromEnv": {
      const source = await loadEnvironment(tx, input.environmentId);
      if (!source || source.systemId !== env.systemId || source.id === env.id)
        throw new BadRequestError(
          "PROMOTE_SOURCE_INVALID",
          "Môi trường nguồn phải là môi trường khác của cùng hệ thống.",
        );
      // Bản đang chạy thật ở nguồn, kể cả do Jenkins chạy ngoài Hive.
      const [latest] = await tx
        .select({ version: deploys.version })
        .from(deploys)
        .innerJoin(deployTargets, eq(deployTargets.id, deploys.targetId))
        .where(
          and(
            eq(deployTargets.projectId, target.projectId),
            eq(deployTargets.environmentId, source.id),
            eq(deploys.state, "succeeded"),
          ),
        )
        .orderBy(desc(sql`coalesce(${deploys.finishedAt}, ${deploys.createdAt})`))
        .limit(1);
      if (!latest)
        throw new ConflictError(
          "NOTHING_TO_PROMOTE",
          `Môi trường ${source.name} chưa có lần triển khai thành công nào của dự án này để đẩy lên.`,
        );
      return latest.version;
    }
  }
}

export interface DeployRequest {
  targetId: string;
  version: DeployVersion;
  skipBackupReason?: string | null | undefined;
  /** Lần quay về (T028): id lần bị thay. */
  rollbackOf?: string | null | undefined;
}

/**
 * Ghi lần triển khai mới sau khi người gọi đã kiểm quyền. Khoá dòng đích nên hai lần bấm cùng lúc đi lần lượt: lần sau
 * thấy lần trước và nhận `DEPLOY_IN_PROGRESS` kèm người, giờ; partial unique index `deploys_target_in_flight` là chốt
 * cuối cho đường ghi nào quên khoá.
 */
export async function requestDeploy(
  tx: Tx,
  deps: DeliveryDeps,
  userId: string,
  req: DeployRequest,
  opts: OrchestratorOptions = {},
): Promise<Deploy> {
  const [target] = await tx.select().from(deployTargets).where(eq(deployTargets.id, req.targetId)).for("update");
  if (!target) throw targetNotFound();
  const env = await loadEnvironment(tx, target.environmentId);
  if (!env) throw targetNotFound();
  if (env.lockedAt) throw envLocked(env.lockReason);
  const active = await inFlight(tx, target.id);
  if (active) throw await inProgressError(tx, active);

  const approvals = env.policy.approvals;
  const now = clock(opts)();
  let row: DeployRow | undefined;
  try {
    [row] = await tx
      .insert(deploys)
      .values({
        orgId: sql`hive.ctx_org()`,
        targetId: target.id,
        method: target.method,
        origin: "hive",
        state: approvals > 0 ? "pending_approval" : "queued",
        version: req.version,
        requestedBy: userId,
        // Lần chạy theo đúng cấu hình lúc bấm; đích sửa sau đó thì thấy được lần này dùng bản cũ.
        configVersion: target.configVersion,
        rollbackOf: req.rollbackOf ?? null,
        skipBackupReason: req.skipBackupReason ?? null,
        approvalsRequired: approvals,
        approvalExpiresAt: approvals > 0 ? new Date(now.getTime() + env.policy.approvalTtlHours * 3_600_000) : null,
      })
      .returning();
  } catch (e) {
    if (pgCode(e) === UNIQUE_VIOLATION)
      throw new ConflictError("DEPLOY_IN_PROGRESS", DELIVERY_ERRORS.DEPLOY_IN_PROGRESS.message);
    throw e;
  }
  if (!row) throw new Error("Không tạo được lần triển khai.");

  if (row.skipBackupReason !== null)
    await recordAudit(tx, {
      action: "delivery.deploy.skip_backup",
      targetType: "deploy",
      targetId: row.id,
      actorUserId: userId,
      data: { targetId: target.id, environmentId: env.id, reason: row.skipBackupReason },
    });
  if (row.state === "queued") await enqueueStart(tx, deps, row);
  else await requestApprovals(tx, deps, row, env, userId);
  await notifyDeploy(tx, row.id);
  return deployView(tx, await locate(tx, row.id));
}

/** Bấm Triển khai (FR-015). */
export async function createDeploy(
  tx: Tx,
  deps: DeliveryDeps,
  userId: string,
  input: DeployCreateInput,
  opts: OrchestratorOptions = {},
): Promise<Deploy> {
  const target = await loadTarget(tx, input.targetId);
  if (!target) throw targetNotFound();
  const env = await loadEnvironment(tx, target.environmentId);
  if (!env) throw targetNotFound();
  await requireDeployRun(tx, userId, env, targetNotFound);
  // Báo khoá và lần đang đi trước khi đọc kho mã: người bấm biết ngay, không chờ GitLab.
  if (env.lockedAt) throw envLocked(env.lockReason);
  const active = await inFlight(tx, target.id);
  if (active) throw await inProgressError(tx, active);

  const skip = input.skipBackup?.reason.trim();
  if (skip) {
    const steps = (target.config as { steps?: { backup?: unknown } }).steps;
    // [Suy luận] Chỉ ssh-script có bước sao lưu do Hive chạy; đích không bật sao lưu thì "bỏ qua" vô nghĩa, báo luôn
    // thay vì ghi audit cho một việc không xảy ra.
    if (target.method !== "ssh-script" || !steps?.backup)
      throw new BadRequestError("SKIP_BACKUP_NOT_APPLICABLE", "Đích này không có bước sao lưu để bỏ qua.");
  }
  const version = await resolveVersion(tx, deps, target, env, input.version);
  return requestDeploy(tx, deps, userId, { targetId: target.id, version, skipBackupReason: skip || null }, opts);
}

async function enqueueStart(tx: Tx, deps: DeliveryDeps, deploy: DeployRow): Promise<void> {
  if (!deps.jobs) throw new Error("Hub chưa bật hàng đợi job nên chưa chạy được lần triển khai.");
  await deps.jobs.enqueue<DeployJob>(
    DELIVERY_DEPLOY_QUEUE,
    { orgId: deploy.orgId, deployId: deploy.id },
    { tx, singletonKey: deploy.id },
  );
}

async function enqueueWatch(tx: Tx, deps: DeliveryDeps, deploy: DeployRow, now: Date): Promise<void> {
  if (!deps.jobs) throw new Error("Hub chưa bật hàng đợi job nên chưa theo dõi được lần triển khai.");
  await deps.jobs.enqueue<DeployJob>(
    DELIVERY_DEPLOY_WATCH_QUEUE,
    { orgId: deploy.orgId, deployId: deploy.id },
    { tx, singletonKey: deploy.id, startAfter: new Date(now.getTime() + WATCH_INTERVAL_MS) },
  );
}

/** Báo người duyệt được: có `deploy.approve`, vai trò trong `approveRoles` nếu có, trừ người yêu cầu (FR-027). */
async function requestApprovals(tx: Tx, deps: DeliveryDeps, deploy: DeployRow, env: EnvRow, requester: string) {
  const roles = env.policy.approveRoles as string[];
  const recipientIds: string[] = [];
  for (const id of await teamMemberIds(tx, env.teamId, "viewer")) {
    if (id === requester || !(await effectivePermissions(tx, id, env.teamId)).has("deploy.approve")) continue;
    if (roles.length > 0 && !roles.includes((await teamRoleOf(tx, id, env.teamId)) ?? "")) continue;
    recipientIds.push(id);
  }
  const row = await locate(tx, deploy.id);
  const { project } = await describe(tx, row);
  const who = (await peopleOf(tx, [requester])).get(requester)?.name ?? requester;
  await emitDeliveryEvent(
    tx,
    {
      orgId: deploy.orgId,
      event: "deploy.approval_requested",
      title: `Cần duyệt: triển khai ${project} lên ${env.name}`,
      body: `${who} yêu cầu triển khai bản ${versionLabel(deploy.version)} lên ${env.name}. Cần ${deploy.approvalsRequired} người duyệt.`,
      systemId: row.systemId,
      eventKey: `deploy:${deploy.id}:approval_requested`,
      recipientIds,
      link: deployLink(deps, deploy.id),
    },
    deps.jobs,
  );
}

/**
 * Lần đã đủ duyệt chuyển sang `queued` và xếp job (cho T027). Môi trường có thể bị khoá trong lúc chờ duyệt nên kiểm
 * lại ở đây.
 */
export async function queueDeploy(tx: Tx, deps: DeliveryDeps, deployId: string): Promise<void> {
  const deploy = await lockDeploy(tx, deployId);
  if (!deploy) throw deployNotFound();
  if (deploy.state !== "pending_approval")
    throw new ConflictError("DEPLOY_NOT_PENDING", "Lần triển khai này không còn chờ duyệt.");
  const row = await locate(tx, deployId);
  const env = await loadEnvironment(tx, row.environmentId);
  if (env?.lockedAt) throw envLocked(env.lockReason);
  await tx.update(deploys).set({ state: "queued", updatedAt: new Date() }).where(eq(deploys.id, deployId));
  await enqueueStart(tx, deps, deploy);
  await notifyDeploy(tx, deployId);
}

// ---- Job delivery-deploy --------------------------------------------------------------------------------------------

/** Giao lần `queued` cho cách triển khai; lỗi khi bắt đầu thì `failed` ngay, không tự chạy lại. */
export async function startDeploy(deps: DeliveryDeps, job: DeployJob, opts: JobOptions = {}): Promise<void> {
  const pool = requirePool(deps);
  const signal = opts.signal ?? new AbortController().signal;
  try {
    await withTenant(pool, { orgId: job.orgId }, async (tx) => {
      const deploy = await lockDeploy(tx, job.deployId);
      if (deploy?.state !== "queued") return;
      const target = await loadTarget(tx, deploy.targetId);
      if (!target) return;
      const env = await loadEnvironment(tx, target.environmentId);
      const now = clock(opts)();
      if (env?.lockedAt) {
        // [Suy luận] Môi trường bị khoá trong khoảng xếp hàng: không chạy, ghi rõ lý do để người bấm biết.
        await hiveLine(tx, deps, deploy, target, `Môi trường đã bị khoá trước khi bắt đầu: ${env.lockReason ?? ""}`);
        await tx
          .update(deploys)
          .set({ state: "canceled", finishedAt: now, updatedAt: new Date() })
          .where(eq(deploys.id, deploy.id));
        await notifyDeploy(tx, deploy.id);
        return;
      }
      const method = methodOf(opts, deploy.method);
      const { own, hive } = splitRemote(deploy.remote);
      const ctx: DeployMethodContext = { tx, deps };
      const run = runOf(job.orgId, deploy, target, own, signal);
      // [Suy luận] Lần quay về (T028) dùng cơ chế riêng của cách nếu có (Argo CD history, rollout undo).
      const started =
        deploy.rollbackOf !== null && method.rollback
          ? await method.rollback(ctx, run, deploy.version)
          : await method.start(ctx, run);
      await tx
        .update(deploys)
        .set({
          state: "running",
          steps: started.steps,
          remote: joinRemote(started.remote ?? own, hive),
          external: started.external ?? deploy.external,
          startedAt: now,
          updatedAt: new Date(),
        })
        .where(eq(deploys.id, deploy.id));
      await emitDeployEvent(tx, deps, deploy.id, "running");
      await enqueueWatch(tx, deps, deploy, now);
      await notifyDeploy(tx, deploy.id);
    });
  } catch (e) {
    if (signal.aborted) throw e;
    await withTenant(pool, { orgId: job.orgId }, async (tx) => {
      const deploy = await lockDeploy(tx, job.deployId);
      if (deploy?.state !== "queued") return;
      const target = await loadTarget(tx, deploy.targetId);
      await hiveLine(tx, deps, deploy, target, `Không bắt đầu được: ${errorMessage(e)}`);
      await tx
        .update(deploys)
        .set({ state: "failed", finishedAt: clock(opts)(), updatedAt: new Date() })
        .where(eq(deploys.id, deploy.id));
      await emitDeployEvent(tx, deps, deploy.id, "failed");
      await notifyDeploy(tx, deploy.id);
    });
  }
}

// ---- Job delivery-deploy-watch --------------------------------------------------------------------------------------

const TERMINAL: ReadonlySet<string> = new Set(["succeeded", "failed", "failed_needs_review", "unknown"]);

/**
 * Tiến độ do cách triển khai trả. `failed_needs_review` và `health` dành cho cách chạy health sau các bước (T020) dù
 * `DeployProgress` chưa khai báo.
 */
type Progress = Omit<DeployProgress, "state"> & {
  state: DeployProgress["state"] | "failed_needs_review";
  health?: Record<string, unknown> | null | undefined;
};

/**
 * Một nhịp theo dõi: đọc tiến độ từ vị trí đã lưu, lưu bước, log, vị trí mới trong cùng giao dịch rồi xếp nhịp sau. Hub
 * chết giữa chừng thì giao dịch không commit, nhịp sau đọc lại từ vị trí cũ: không mất, không lặp.
 */
export async function watchDeploy(deps: DeliveryDeps, job: DeployJob, opts: JobOptions = {}): Promise<void> {
  const pool = requirePool(deps);
  const signal = opts.signal ?? new AbortController().signal;
  try {
    await withTenant(pool, { orgId: job.orgId }, async (tx) => {
      const deploy = await lockDeploy(tx, job.deployId);
      if (deploy?.state !== "running") return;
      const target = await loadTarget(tx, deploy.targetId);
      if (!target) return;
      const { own, hive } = splitRemote(deploy.remote);
      const progress = (await methodOf(opts, deploy.method).poll(
        { tx, deps },
        runOf(job.orgId, deploy, target, own, signal),
      )) as Progress;
      const now = clock(opts)();
      const done = TERMINAL.has(progress.state);
      const next = await writeLog(
        tx,
        deps,
        deploy,
        target,
        { ...hive, failingSince: undefined },
        progress.log ?? "",
        done,
      );
      const state = done ? progress.state : "running";
      await tx
        .update(deploys)
        .set({
          state,
          steps: progress.steps,
          remote: joinRemote(progress.remote !== undefined ? progress.remote : own, next),
          external: progress.external ?? deploy.external,
          health: progress.health !== undefined ? progress.health : deploy.health,
          finishedAt: done ? now : null,
          updatedAt: new Date(),
        })
        .where(eq(deploys.id, deploy.id));
      if (done) await emitDeployEvent(tx, deps, deploy.id, state as DeployState);
      else await enqueueWatch(tx, deps, deploy, now);
      await notifyDeploy(tx, deploy.id);
    });
  } catch (e) {
    if (signal.aborted) throw e;
    await withTenant(pool, { orgId: job.orgId }, (tx) => pollFailed(tx, deps, job, e, opts));
  }
}

/**
 * Không đọc được tiến độ (máy chủ tắt, mạng đứt, nguồn lỗi): thử lại mỗi nhịp; quá 15 phút liền thì `unknown` và
 * dừng, không tự chạy lại vì không biết các bước đã làm tới đâu.
 */
async function pollFailed(tx: Tx, deps: DeliveryDeps, job: DeployJob, error: unknown, opts: OrchestratorOptions) {
  const deploy = await lockDeploy(tx, job.deployId);
  if (deploy?.state !== "running") return;
  const target = await loadTarget(tx, deploy.targetId);
  const { own, hive } = splitRemote(deploy.remote);
  const now = clock(opts)();
  const since = hive.failingSince ? new Date(hive.failingSince) : now;
  if (!hive.failingSince)
    await hiveLine(tx, deps, deploy, target, `Không đọc được tiến độ: ${errorMessage(error)}. Hive thử lại liên tục.`);

  if (now.getTime() - since.getTime() < UNREACHABLE_AFTER_MS) {
    await tx
      .update(deploys)
      .set({ remote: joinRemote(own, { ...hive, failingSince: since.toISOString() }), updatedAt: new Date() })
      .where(eq(deploys.id, deploy.id));
    await enqueueWatch(tx, deps, deploy, now);
    await notifyDeploy(tx, deploy.id);
    return;
  }
  const next = target ? await writeLog(tx, deps, deploy, target, hive, "", "close") : {};
  await hiveLine(
    tx,
    deps,
    deploy,
    target,
    `Không đọc được máy chủ hay nguồn từ ${since.toISOString()} (quá 15 phút): ${errorMessage(error)}. Kết quả không rõ; kiểm tra trên máy chủ trước khi chạy lại.`,
  );
  await tx
    .update(deploys)
    .set({
      state: "unknown",
      remote: joinRemote(own, { ...next, failingSince: since.toISOString() }),
      finishedAt: now,
      updatedAt: new Date(),
    })
    .where(eq(deploys.id, deploy.id));
  await emitDeployEvent(tx, deps, deploy.id, "unknown");
  await notifyDeploy(tx, deploy.id);
}

// ---- Huỷ ------------------------------------------------------------------------------------------------------------

/** Huỷ lần đang đi (deploy.run). Lần đang chạy thì gọi `method.cancel` trước; huỷ trên máy chủ lỗi thì giữ nguyên. */
export async function cancelDeploy(
  tx: Tx,
  deps: DeliveryDeps,
  userId: string,
  id: string,
  opts: OrchestratorOptions = {},
): Promise<Deploy> {
  const deploy = await lockDeploy(tx, id);
  if (!deploy) throw deployNotFound();
  const row = await locate(tx, id);
  const env = await loadEnvironment(tx, row.environmentId);
  if (!env) throw deployNotFound();
  await requireDeployRun(tx, userId, env, deployNotFound);
  if (deploy.origin !== "hive" || !(DEPLOY_ACTIVE_STATES as readonly string[]).includes(deploy.state))
    throw notActive();

  const target = await loadTarget(tx, deploy.targetId);
  const { own, hive } = splitRemote(deploy.remote);
  if (deploy.state === "running" && target) {
    try {
      await methodOf(opts, deploy.method).cancel(
        { tx, deps },
        runOf(deploy.orgId, deploy, target, own, new AbortController().signal),
      );
    } catch (e) {
      // Không chắc tiến trình trên máy chủ đã dừng thì không nhả khoá đích.
      const message = maskAll(targetSecrets(deps, target), errorMessage(e));
      throw new ConflictError("DEPLOY_CANCEL_FAILED", `Không huỷ được trên máy chủ: ${message}`);
    }
  }
  const now = clock(opts)();
  const at = now.toISOString();
  const steps: DeployStep[] = deploy.steps.map((s) =>
    s.state === "running" || s.state === "pending"
      ? { ...s, state: "canceled", finishedAt: s.state === "running" ? at : s.finishedAt }
      : s,
  );
  const next = target ? await writeLog(tx, deps, deploy, target, hive, "", "close") : {};
  const who = (await peopleOf(tx, [userId])).get(userId)?.name ?? userId;
  await hiveLine(tx, deps, deploy, target, `Đã huỷ bởi ${who}.`);
  await tx
    .update(deploys)
    .set({ state: "canceled", steps, remote: joinRemote(own, next), finishedAt: now, updatedAt: new Date() })
    .where(eq(deploys.id, id));
  await recordAudit(tx, {
    action: "delivery.deploy.cancel",
    targetType: "deploy",
    targetId: id,
    actorUserId: userId,
    data: { targetId: deploy.targetId, from: deploy.state },
  });
  await notifyDeploy(tx, id);
  return deployView(tx, await locate(tx, id));
}

// ---- Đăng ký worker -------------------------------------------------------------------------------------------------

export async function registerOrchestrator(
  jobs: Jobs,
  deps: DeliveryDeps,
  opts: OrchestratorOptions = {},
): Promise<void> {
  // Không có database (test đăng ký worker với deps rỗng) thì không có lần triển khai nào để điều phối.
  if (!deps.pool) return;
  const withJobs: DeliveryDeps = { ...deps, jobs };
  await jobs.work<DeployJob>(DELIVERY_DEPLOY_QUEUE, (job) =>
    startDeploy(withJobs, job.data, { ...opts, signal: job.signal }),
  );
  await jobs.work<DeployJob>(
    DELIVERY_DEPLOY_WATCH_QUEUE,
    (job) => watchDeploy(withJobs, job.data, { ...opts, signal: job.signal }),
    { pollingIntervalSeconds: 1 },
  );
}
