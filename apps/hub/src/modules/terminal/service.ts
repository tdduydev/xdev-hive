import {
  type Approval,
  defaultRouting,
  leaderAction,
  type TaskTier,
  type TerminalAction,
  type TerminalModel,
  type TerminalOptions,
  type TerminalSession,
  taskTier,
  terminalErrors,
} from "@xdev-hive/contracts";
import { TERMINAL_CAPABILITY, TERMINAL_LIMITS, type TerminalMode } from "@xdev-hive/contracts/worker-protocol";
import { and, avg, count, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { auditByData, recordAudit } from "../audit/index.ts";
import { loadProject, type ProjectRow } from "../catalog/index.ts";
import { isConnected, sendToMachine, sharedWorkerMachines } from "../fleet/index.ts";
import { loadPolicy, resolvePermission } from "../governance/index.ts";
import { approvals, chatThreads, TIER_RULE } from "../leader/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { runs } from "../runs/index.ts";
import { teamRoleOf } from "../tenancy/index.ts";
import { canOpenTerminal } from "./access.ts";
import { broadcast, issueTicket, liveSession, trackSession, untrackSession } from "./live.ts";
import { terminalChunks, terminalSessions } from "./schema.ts";
import { signTerminalToken } from "./token.ts";

export interface TerminalDeps {
  /** HIVE_REMOTE_TERMINAL: tắt thì không mở phiên mới (phiên cũ vẫn xem được). */
  enabled: boolean;
  publicUrl: string;
  /** Khoá ký token MCP của phiên (từ HIVE_AUTH_SECRET); không có thì không mở được phiên. */
  tokenKey: Buffer | undefined;
}

type SessionRow = typeof terminalSessions.$inferSelect;
type Joined = SessionRow & { projectKey: string; projectName: string; machineName: string; ownerName: string | null };

const ACTIVE = ["opening", "running"] as const;

const forbidden = (code: keyof typeof terminalErrors) => new ForbiddenError(code, terminalErrors[code]);
const conflict = (code: keyof typeof terminalErrors) => new ConflictError(code, terminalErrors[code]);
const notFound = () => new NotFoundError("TERMINAL_NOT_FOUND", terminalErrors.TERMINAL_NOT_FOUND);

/** Model claude cho alias người mở chọn: CLI tự hiểu `sonnet`/`opus` là bản mới nhất. */
const MODEL_EFFORT: Record<TerminalModel, "high"> = { sonnet: "high", opus: "high" };

async function joined(tx: Tx, where: ReturnType<typeof sql>): Promise<Joined[]> {
  // Bảng dự án, máy và người dùng thuộc module khác; đọc tên qua join chỉ để hiển thị.
  const { rows } = await tx.execute<{
    id: string;
    project_key: string;
    project_name: string;
    machine_name: string;
    owner_name: string | null;
  }>(
    sql`select s.id, p.key as project_key, p.name as project_name, m.name as machine_name, u.name as owner_name
      from hive.terminal_sessions s
      join hive.projects p on p.id = s.project_id
      join hive.machines m on m.id = s.machine_id
      left join auth."user" u on u.id = s.owner_user_id
      where ${where}
      order by s.created_at desc
      limit 100`,
  );
  if (rows.length === 0) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const full = await tx
    .select()
    .from(terminalSessions)
    .where(inArray(terminalSessions.id, [...byId.keys()]))
    .orderBy(desc(terminalSessions.createdAt));
  return full.map((s) => {
    const r = byId.get(s.id);
    return {
      ...s,
      projectKey: r?.project_key ?? "",
      projectName: r?.project_name ?? "",
      machineName: r?.machine_name ?? "",
      ownerName: r?.owner_name ?? null,
    };
  });
}

export function sessionView(s: Joined, viewerId: string): TerminalSession {
  return {
    id: s.id,
    projectId: s.projectId,
    projectKey: s.projectKey,
    projectName: s.projectName,
    machineId: s.machineId,
    machineName: s.machineName,
    ownerId: s.ownerUserId,
    ownerName: s.ownerName,
    isOwner: s.ownerUserId === viewerId,
    mode: s.mode,
    model: s.model === "opus" ? "opus" : "sonnet",
    advisor: s.advisor,
    state: s.state,
    visibility: s.visibility,
    permissions: s.permissions === "full" || s.permissions === "workspace" ? s.permissions : null,
    accountLabel: s.accountLabel,
    threadId: s.threadId,
    cols: s.cols,
    rows: s.rows,
    exitCode: s.exitCode,
    endReason: s.endReason,
    bytes: s.bytes,
    createdAt: s.createdAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
  };
}

/** Phiên riêng tư chỉ chủ phiên thấy; "Cho đội xem" thì thành viên của đội sở hữu dự án thấy (chỉ xem). */
async function canView(tx: Tx, userId: string, s: SessionRow): Promise<boolean> {
  if (s.ownerUserId === userId) return true;
  return s.visibility === "team" && (await teamRoleOf(tx, userId, s.teamId)) !== null;
}

export async function loadSession(tx: Tx, id: string): Promise<Joined | null> {
  return (await joined(tx, sql`s.id = ${id}`))[0] ?? null;
}

async function visibleSession(tx: Tx, userId: string, id: string): Promise<Joined> {
  const s = await loadSession(tx, id);
  if (!s || !(await canView(tx, userId, s))) throw notFound();
  return s;
}

/** Quyền thật của Claude trên máy (ADR 0020), như `machinePermission` của run: worker tính lại y hệt lúc chạy. */
function machineMode(
  m: { boundProjects: string[]; fullProjects: string[] },
  projectId: string,
  projectMode: "workspace" | "full",
  fullAllowed: boolean,
): "workspace" | "full" {
  if (!m.boundProjects.includes(projectId)) return projectMode;
  return fullAllowed && m.fullProjects.includes(projectId) ? "full" : "workspace";
}

async function activeCounts(tx: Tx, machineIds: string[]): Promise<Map<string, number>> {
  if (machineIds.length === 0) return new Map();
  const rows = await tx
    .select({ machineId: terminalSessions.machineId, n: count() })
    .from(terminalSessions)
    .where(and(inArray(terminalSessions.machineId, machineIds), inArray(terminalSessions.state, [...ACTIVE])))
    .groupBy(terminalSessions.machineId);
  return new Map(rows.map((r) => [r.machineId, r.n]));
}

/** Chi phí trung bình mỗi run code 30 ngày qua theo họ model: số đo thật của tổ chức, không phải bảng giá. */
async function costHints(tx: Tx): Promise<TerminalOptions["costs"]> {
  const family = sql<string>`case when ${runs.model} ilike '%opus%' then 'opus' when ${runs.model} ilike '%sonnet%' then 'sonnet' end`;
  const rows = await tx
    .select({ family, avgUsd: avg(runs.costUsd), n: count() })
    .from(runs)
    .where(
      and(
        eq(runs.kind, "code"),
        sql`${runs.costUsd} is not null`,
        gte(runs.createdAt, sql`now() - interval '30 days'`),
      ),
    )
    .groupBy(family);
  return (["sonnet", "opus"] as const).map((model) => {
    const r = rows.find((x) => x.family === model);
    return { model, avgRunUsd: r?.avgUsd == null ? null : Number(r.avgUsd), runs: r?.n ?? 0 };
  });
}

function projectRouting(project: ProjectRow) {
  return project.settings.routing ?? defaultRouting;
}

export async function terminalOptions(
  tx: Tx,
  userId: string,
  projectId: string,
  deps: TerminalDeps,
): Promise<TerminalOptions> {
  const project = await loadProject(tx, projectId);
  if (!project || !(await teamRoleOf(tx, userId, project.teamId)))
    throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.");
  const allowed = await canOpenTerminal(tx, userId, project.teamId);
  const policy = await loadPolicy(tx);
  const mode = resolvePermission(policy, project.settings.runPermissions?.mode ?? "workspace").mode;
  const list = (await sharedWorkerMachines(tx, project.teamId)).filter((m) =>
    m.capabilities.includes(TERMINAL_CAPABILITY),
  );
  const active = await activeCounts(
    tx,
    list.map((m) => m.id),
  );
  const routing = projectRouting(project);
  return {
    enabled: deps.enabled && deps.tokenKey !== undefined,
    allowed,
    machines: list.map((m) => ({
      id: m.id,
      name: m.name,
      online: m.online && isConnected(m.id),
      fullAccess: machineMode(m, project.id, mode, policy.allowFullPermission) === "full",
      busy: (active.get(m.id) ?? 0) >= TERMINAL_LIMITS.sessionsPerMachine,
      accounts: (m.accounts ?? [])
        .filter((a) => a.cli === "claude" && a.enabled)
        .map((a) => ({
          id: a.id,
          label: a.label,
          loggedIn: a.loggedIn,
          sessionPct: a.sessionPct,
          weekPct: a.weekPct,
        })),
    })),
    defaultModel: "sonnet",
    // Phiên Leader chạy như việc cấp vừa (sonnet, effort high): dự án bật cố vấn cho cấp vừa thì phiên cũng có cố vấn.
    advisor: routing.enabled ? routing.tiers.medium.advisor : null,
    costs: await costHints(tx),
  };
}

export function leaderSystemPrompt(p: {
  projectName: string;
  projectKey: string;
  baseBranch: string;
  mode: TerminalMode;
  ownerName: string;
}): string {
  const mode =
    p.mode === "propose"
      ? "Chế độ Đề xuất: mọi hành động lên hub (tạo task, giao run, huỷ run, đổi cài đặt dự án) gọi tool MCP `leader_action`; hành động thành đề xuất chờ người duyệt ở khung bên cạnh, chưa làm ngay. Báo người dùng là đã gửi đề xuất."
      : "Chế độ Bypass: `leader_action` và các tool hub khác chạy ngay bằng quyền của người mở phiên, không qua duyệt; mọi lần gọi được ghi audit. Chỉ hành động khi người dùng yêu cầu rõ, nói trước sẽ làm gì.";
  return [
    `Bạn là Leader của dự án ${p.projectName} (${p.projectKey}) trong xDev Hive, đang chạy trong terminal tương tác do ${p.ownerName} mở trên web. Người dùng gõ trực tiếp với bạn.`,
    `Thư mục hiện tại là worktree tạm của repo, HEAD tách ở nhánh ${p.baseBranch}. Không push, không mở PR: thay đổi code đi qua task và run của hub để được review và merge.`,
    "Công cụ hub nằm ở MCP server `xdev-hive` (task, run, tài liệu, memory, skill).",
    mode,
    TIER_RULE,
    "Trả lời bằng tiếng Việt, ngắn gọn.",
  ].join("\n\n");
}

export interface OpenInput {
  projectId: string;
  machineId: string;
  accountId?: string | undefined;
  mode: TerminalMode;
  confirmBypass?: boolean | undefined;
  model: TerminalModel;
  planId?: string | undefined;
  cols: number;
  rows: number;
}

/**
 * Mở phiên: kiểm cờ hub, vai trò, máy dùng chung có capability và còn chỗ, gói; tạo cuộc trò chuyện chứa đề xuất và
 * dòng phiên rồi trả hàm gửi `term_open` sau khi commit (token MCP chỉ đi hub → worker, không tới trình duyệt).
 */
export async function openSession(
  tx: Tx,
  user: { id: string; name: string },
  orgId: string,
  input: OpenInput,
  deps: TerminalDeps,
): Promise<{ session: TerminalSession; afterCommit: () => void }> {
  if (!deps.enabled || !deps.tokenKey) throw conflict("TERMINAL_DISABLED");
  if (input.mode === "bypass" && input.confirmBypass !== true)
    throw new BadRequestError("TERMINAL_BYPASS_CONFIRM", terminalErrors.TERMINAL_BYPASS_CONFIRM);
  const project = await loadProject(tx, input.projectId);
  if (!project || !(await teamRoleOf(tx, user.id, project.teamId)))
    throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.");
  if (!(await canOpenTerminal(tx, user.id, project.teamId))) throw forbidden("TERMINAL_ROLE_REQUIRED");
  if (!project.repoHttpUrl) throw new ConflictError("PROJECT_NOT_READY", "Dự án chưa có repo để mở terminal.");
  const machine = (await sharedWorkerMachines(tx, project.teamId)).find((m) => m.id === input.machineId);
  if (!machine?.online || !isConnected(machine.id) || !machine.capabilities.includes(TERMINAL_CAPABILITY))
    throw conflict("TERMINAL_MACHINE_INVALID");
  // Khoá dòng máy trong lúc đếm để hai lần mở cùng lúc không cùng lọt qua giới hạn số phiên.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`terminal:${machine.id}`}, 0))`);
  if (((await activeCounts(tx, [machine.id])).get(machine.id) ?? 0) >= TERMINAL_LIMITS.sessionsPerMachine)
    throw conflict("TERMINAL_MACHINE_BUSY");
  const account = input.accountId ? machine.accounts?.find((a) => a.id === input.accountId) : undefined;
  if (input.accountId && (account?.cli !== "claude" || !account.enabled))
    throw new NotFoundError("ACCOUNT_NOT_FOUND", "Không tìm thấy gói Claude đang bật trên máy.");
  const policy = await loadPolicy(tx);
  const runPermissions = resolvePermission(policy, project.settings.runPermissions?.mode ?? "workspace").mode;
  const routing = projectRouting(project);
  const advisor = input.model === "sonnet" && routing.enabled ? routing.tiers.medium.advisor : null;
  const [thread] = await tx
    .insert(chatThreads)
    .values({ orgId, projectId: project.id, createdBy: user.id, title: `Terminal Leader · ${project.key}` })
    .returning();
  if (!thread) throw new Error("Không tạo được cuộc trò chuyện của phiên.");
  const [row] = await tx
    .insert(terminalSessions)
    .values({
      orgId,
      teamId: project.teamId,
      projectId: project.id,
      machineId: machine.id,
      ownerUserId: user.id,
      mode: input.mode,
      model: input.model,
      advisor,
      accountId: input.accountId ?? null,
      accountLabel: account?.label ?? null,
      threadId: thread.id,
      planId: input.planId ?? null,
      cols: input.cols,
      rows: input.rows,
    })
    .returning();
  if (!row) throw new Error("Không tạo được phiên terminal.");
  await recordAudit(tx, {
    action: "terminal.open",
    targetType: "terminal_session",
    targetId: row.id,
    data: {
      projectId: project.id,
      machineId: machine.id,
      mode: input.mode,
      model: input.model,
      advisor,
      accountId: input.accountId ?? null,
      ...(input.mode === "bypass" ? { bypassConfirmed: true } : {}),
    },
  });
  const token = signTerminalToken(deps.tokenKey, deps.publicUrl, { sessionId: row.id, orgId, userId: user.id });
  const systemPrompt = leaderSystemPrompt({
    projectName: project.name,
    projectKey: project.key,
    baseBranch: project.defaultBranch ?? "main",
    mode: input.mode,
    ownerName: user.name,
  });
  const session = sessionView(
    { ...row, projectKey: project.key, projectName: project.name, machineName: machine.name, ownerName: user.name },
    user.id,
  );
  return {
    session,
    afterCommit: () => {
      trackSession({
        id: row.id,
        orgId,
        teamId: project.teamId,
        machineId: machine.id,
        ownerUserId: user.id,
        threadId: thread.id,
      });
      sendToMachine(machine.id, {
        type: "term_open",
        sessionId: row.id,
        projectId: project.id,
        ...(input.planId ? { planId: input.planId } : {}),
        mode: input.mode,
        cols: input.cols,
        rows: input.rows,
        cli: "claude",
        repoUrl: project.repoHttpUrl ?? "",
        baseBranch: project.defaultBranch ?? "main",
        projectKey: project.key,
        ...(input.accountId ? { accountId: input.accountId } : {}),
        model: input.model,
        effort: MODEL_EFFORT[input.model],
        ...(advisor ? { advisor } : {}),
        runPermissions,
        fullAllowed: policy.allowFullPermission,
        mcpToken: token,
        systemPrompt,
        tokenSaving: (project.settings.tokenSaving ?? undefined) as Record<string, unknown> | undefined,
      });
    },
  };
}

export async function listSessions(tx: Tx, userId: string, projectId: string | undefined): Promise<TerminalSession[]> {
  const project = projectId ? sql` and s.project_id = ${projectId}` : sql``;
  const rows = await joined(tx, sql`(s.owner_user_id = ${userId} or s.visibility = 'team')${project}`);
  // Vai trò đội tra một lần mỗi đội; quản trị tổ chức không có dòng team_members nhưng vẫn là quản trị mọi đội.
  const member = new Map<string, boolean>();
  const visible: Joined[] = [];
  for (const r of rows) {
    if (r.ownerUserId !== userId) {
      if (!member.has(r.teamId)) member.set(r.teamId, (await teamRoleOf(tx, userId, r.teamId)) !== null);
      if (!member.get(r.teamId)) continue;
    }
    visible.push(r);
  }
  return visible.map((r) => sessionView(r, userId));
}

export async function getSession(tx: Tx, userId: string, id: string): Promise<TerminalSession> {
  return sessionView(await visibleSession(tx, userId, id), userId);
}

/** Đánh dấu phiên đã kết thúc (nếu chưa); trả dòng mới hay null khi phiên đã kết thúc từ trước. */
export async function endSession(
  tx: Tx,
  id: string,
  state: "closed" | "failed",
  reason: string,
  exitCode: number | null = null,
): Promise<SessionRow | null> {
  const [row] = await tx
    .update(terminalSessions)
    .set({ state, endReason: reason, exitCode, endedAt: new Date() })
    .where(and(eq(terminalSessions.id, id), inArray(terminalSessions.state, [...ACTIVE])))
    .returning();
  return row ?? null;
}

/** Chủ phiên hoặc quản trị đội đóng phiên; gửi `term_close` sau khi commit. */
export async function closeSession(
  tx: Tx,
  userId: string,
  id: string,
): Promise<{ session: TerminalSession; afterCommit: () => void }> {
  const s = await loadSession(tx, id);
  if (!s) throw notFound();
  const owner = s.ownerUserId === userId;
  if (!owner && (await teamRoleOf(tx, userId, s.teamId)) !== "admin") {
    if (await canView(tx, userId, s))
      throw new ForbiddenError("TERMINAL_OWNER_REQUIRED", "Chỉ chủ phiên hoặc quản trị đội đóng được phiên.");
    throw notFound();
  }
  const reason = owner ? "Người mở đã đóng phiên." : "Quản trị đội đã đóng phiên.";
  const ended = await endSession(tx, id, "closed", reason);
  if (ended) {
    await recordAudit(tx, {
      action: "terminal.close",
      targetType: "terminal_session",
      targetId: id,
      data: { by: owner ? "owner" : "team_admin" },
    });
  }
  const fresh = (await loadSession(tx, id)) ?? s;
  const view = sessionView(fresh, userId);
  return {
    session: view,
    afterCommit: () => {
      if (!ended) return;
      sendToMachine(s.machineId, { type: "term_close", sessionId: id, reason });
      notifyEnded(id, fresh);
    },
  };
}

/** Báo người xem trạng thái cuối rồi bỏ phiên khỏi bộ nhớ. */
export function notifyEnded(id: string, row: Joined): void {
  const live = liveSession(id);
  if (!live) return;
  for (const viewer of live.viewers) viewer.send({ t: "state", session: sessionView(row, viewer.userId) });
  untrackSession(id);
}

export async function setVisibility(
  tx: Tx,
  userId: string,
  id: string,
  visibility: "private" | "team",
): Promise<TerminalSession> {
  const s = await visibleSession(tx, userId, id);
  if (s.ownerUserId !== userId)
    throw new ForbiddenError("TERMINAL_OWNER_REQUIRED", "Chỉ chủ phiên đổi được Cho đội xem.");
  await tx.update(terminalSessions).set({ visibility }).where(eq(terminalSessions.id, id));
  await recordAudit(tx, {
    action: "terminal.visibility",
    targetType: "terminal_session",
    targetId: id,
    data: { visibility },
  });
  // Tắt "Cho đội xem": người xem không phải chủ bị ngắt ngay, không chờ tới lần nối lại.
  const live = liveSession(id);
  if (live && visibility === "private") {
    for (const viewer of live.viewers) if (viewer.userId !== userId) viewer.close(4403, "Phiên không còn cho đội xem.");
  }
  return sessionView({ ...s, visibility }, userId);
}

export async function sessionTicket(tx: Tx, userId: string, orgId: string, id: string) {
  const s = await visibleSession(tx, userId, id);
  const running = (ACTIVE as readonly string[]).includes(s.state);
  const canInput = running && s.ownerUserId === userId && (await canOpenTerminal(tx, userId, s.teamId));
  if (running)
    trackSession({
      id: s.id,
      orgId,
      teamId: s.teamId,
      machineId: s.machineId,
      ownerUserId: s.ownerUserId,
      threadId: s.threadId,
    });
  const { ticket, expiresAt } = issueTicket({ sessionId: s.id, orgId, userId, canInput });
  return { ticket, expiresAt: expiresAt.toISOString(), canInput };
}

export async function sessionChunks(tx: Tx, userId: string, input: { id: string; after: number; limit: number }) {
  await visibleSession(tx, userId, input.id);
  return readChunks(tx, input.id, input.after, input.limit);
}

export async function readChunks(tx: Tx, id: string, after: number, limit: number) {
  const rows = await tx
    .select({ seq: terminalChunks.seq, data: terminalChunks.data })
    .from(terminalChunks)
    .where(and(eq(terminalChunks.sessionId, id), gt(terminalChunks.seq, after)))
    .orderBy(terminalChunks.seq)
    .limit(limit + 1);
  return {
    chunks: rows.slice(0, limit).map((r) => ({ seq: r.seq, data: r.data.toString("base64") })),
    more: rows.length > limit,
  };
}

function approvalView(row: typeof approvals.$inferSelect): Approval {
  return {
    id: row.id,
    threadId: row.threadId,
    action: leaderAction.parse(row.action),
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    decidedBy: row.decidedBy,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const tierOf = (v: unknown): TaskTier | null => {
  const parsed = taskTier.safeParse(v);
  return parsed.success ? parsed.data : null;
};

/** Khung bên phải: đề xuất của phiên và nhật ký tool hub đã gọi (chỉ trường đã biết kiểu, không có tham số tool). */
export async function sessionActivity(
  tx: Tx,
  userId: string,
  id: string,
): Promise<{ proposals: Approval[]; actions: TerminalAction[] }> {
  const s = await visibleSession(tx, userId, id);
  await tx
    .update(approvals)
    .set({ status: "expired" })
    .where(and(eq(approvals.status, "pending"), sql`expires_at <= now()`));
  const proposals = s.threadId
    ? (
        await tx
          .select()
          .from(approvals)
          .where(eq(approvals.threadId, s.threadId))
          .orderBy(desc(approvals.createdAt))
          .limit(50)
      ).map(approvalView)
    : [];
  const entries = await auditByData(tx, { actionLike: "%", key: "terminalSessionId", value: id, limit: 200 });
  const actions: TerminalAction[] = [];
  for (const e of entries) {
    if (e.action === "terminal.action") {
      actions.push({
        id: e.id,
        at: e.createdAt.toISOString(),
        tool: "leader_action",
        outcome: "success",
        action: str(e.data.summary),
        tier: tierOf(e.data.tier),
        model: str(e.data.model),
        reason: str(e.data.tierReason),
      });
    } else if (e.action.startsWith("mcp.")) {
      const tool = e.action.slice(4);
      const outcome = e.data.outcome === "error" ? "error" : "success";
      // leader_action thành công đã có dòng terminal.action đủ hơn; leader_tiers chỉ là tra cứu.
      if (tool === "leader_tiers" || (tool === "leader_action" && outcome === "success")) continue;
      actions.push({
        id: e.id,
        at: e.createdAt.toISOString(),
        tool,
        outcome,
        action: null,
        tier: null,
        model: null,
        reason: null,
      });
    }
  }
  return { proposals, actions };
}

/** Đẩy trạng thái mới của phiên cho mọi người xem (mỗi người thấy `isOwner` của mình). */
export function broadcastState(row: Joined): void {
  const live = liveSession(row.id);
  if (!live) return;
  for (const viewer of live.viewers) viewer.send({ t: "state", session: sessionView(row, viewer.userId) });
}

export { broadcast };
