import {
  type RemoteErrorCode,
  type RemoteMachine,
  type RemoteMachineState,
  type RemoteSession,
  remoteErrors,
} from "@xdev-hive/contracts";
import { cli, TERMINAL_CAPABILITY } from "@xdev-hive/contracts/worker-protocol";
import { eq, inArray, type SQL, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadPolicy } from "../governance/index.ts";
import { ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { teamRoleOf } from "../tenancy/index.ts";
import { liveSession } from "./live.ts";
import { machineRemoteState, terminalSessions } from "./schema.ts";
import { readChunks } from "./service.ts";

/**
 * Đọc phiên tương tác trên máy cá nhân (specs/010 US1, route `remote.*`). Phiên Leader (`origin = 'hub'`) không bao giờ
 * lọt vào đây và ngược lại (`service.ts` chỉ đọc `hub`), để quyền của hai bên không trộn nhau.
 */

const ACTIVE = ["opening", "running"];

const forbidden = (code: RemoteErrorCode) => new ForbiddenError(code, remoteErrors[code]);
const notFound = () => new NotFoundError("SESSION_NOT_FOUND", remoteErrors.SESSION_NOT_FOUND);

export type Row = {
  id: string;
  team_id: string;
  machine_id: string;
  machine_name: string;
  owner_user_id: string;
  owner_name: string | null;
  origin: "local" | "remote";
  cli: string;
  account_label: string | null;
  cwd_label: string | null;
  project_id: string | null;
  project_key: string | null;
  task_id: string | null;
  task_key: string | null;
  state: RemoteSession["state"];
  visibility: RemoteSession["visibility"];
  remote: boolean;
  cols: number;
  rows: number;
  exit_code: number | null;
  end_reason: string | null;
  bytes: string | number;
  created_at: Date | string;
  ended_at: Date | string | null;
};

const iso = (d: Date | string) => new Date(d).toISOString();

async function select(tx: Tx, where: SQL): Promise<Row[]> {
  // Máy, dự án, task và người dùng thuộc module khác; đọc tên qua join chỉ để hiển thị.
  const { rows } = await tx.execute<Row>(
    sql`select s.id, s.team_id, s.machine_id, m.name as machine_name, s.owner_user_id, u.name as owner_name, s.origin,
        s.cli, s.account_label, s.cwd_label, s.project_id, p.key as project_key, s.task_id, t.key as task_key, s.state,
        s.visibility, s.remote, s.cols, s.rows, s.exit_code, s.end_reason, s.bytes, s.created_at, s.ended_at
      from hive.terminal_sessions s
      join hive.machines m on m.id = s.machine_id
      left join hive.projects p on p.id = s.project_id
      left join hive.tasks t on t.id = s.task_id
      left join auth."user" u on u.id = s.owner_user_id
      where s.origin <> 'hub' and (${where})
      order by s.created_at desc
      limit 200`,
  );
  return rows;
}

function view(r: Row, viewerId: string): RemoteSession {
  return {
    id: r.id,
    machineId: r.machine_id,
    machineName: r.machine_name,
    ownerId: r.owner_user_id,
    ownerName: r.owner_name,
    isOwner: r.owner_user_id === viewerId,
    origin: r.origin,
    cli: cli.safeParse(r.cli).data ?? "claude",
    accountLabel: r.account_label,
    cwdLabel: r.cwd_label,
    projectId: r.project_id,
    projectKey: r.project_key,
    taskId: r.task_id,
    taskKey: r.task_key,
    state: r.state,
    visibility: r.visibility,
    remote: r.remote,
    // Ai giữ phím chỉ worker biết (`term_event controller`, `term_state`); hub chỉ nhớ cho phiên đang theo dõi.
    controller: liveSession(r.id)?.remote.controller ?? null,
    cols: r.cols,
    rows: r.rows,
    exitCode: r.exit_code,
    endReason: r.end_reason,
    bytes: Number(r.bytes),
    createdAt: iso(r.created_at),
    endedAt: r.ended_at ? iso(r.ended_at) : null,
  };
}

/** Phiên riêng tư chỉ chủ máy thấy; "Cho đội xem" thì thành viên đội sở hữu máy thấy (chỉ xem). */
async function canView(tx: Tx, userId: string, r: Row): Promise<boolean> {
  if (r.owner_user_id === userId) return true;
  return r.visibility === "team" && (await teamRoleOf(tx, userId, r.team_id)) !== null;
}

/** Phiên chưa qua kiểm quyền xem: chỉ cho thao tác có luật quyền riêng (ngắt phiên, `close.ts`). */
export async function remoteRow(tx: Tx, id: string): Promise<Row | undefined> {
  const [r] = await select(tx, sql`s.id = ${id}`);
  return r;
}

export const remoteView = view;

async function visible(tx: Tx, userId: string, id: string): Promise<Row> {
  const r = await remoteRow(tx, id);
  if (!r || !(await canView(tx, userId, r))) throw notFound();
  return r;
}

export interface RemoteListFilter {
  machineId?: string | undefined;
  projectId?: string | undefined;
  taskId?: string | undefined;
  active?: boolean | undefined;
}

export async function listRemoteSessions(tx: Tx, userId: string, f: RemoteListFilter): Promise<RemoteSession[]> {
  const where: SQL[] = [sql`(s.owner_user_id = ${userId} or s.visibility = 'team')`];
  if (f.machineId) where.push(sql`s.machine_id = ${f.machineId}`);
  if (f.projectId) where.push(sql`s.project_id = ${f.projectId}`);
  if (f.taskId) where.push(sql`s.task_id = ${f.taskId}`);
  if (f.active === true) where.push(sql`s.state in ('opening', 'running')`);
  if (f.active === false) where.push(sql`s.state not in ('opening', 'running')`);
  const rows = await select(tx, sql.join(where, sql` and `));
  const out: RemoteSession[] = [];
  for (const r of rows) if (await canView(tx, userId, r)) out.push(view(r, userId));
  return out;
}

export async function getRemoteSession(tx: Tx, userId: string, id: string): Promise<RemoteSession> {
  return view(await visible(tx, userId, id), userId);
}

export async function remoteSessionChunks(tx: Tx, userId: string, input: { id: string; after: number; limit: number }) {
  await visible(tx, userId, input.id);
  return readChunks(tx, input.id, input.after, input.limit);
}

export async function setRemoteVisibility(
  tx: Tx,
  userId: string,
  id: string,
  visibility: "private" | "team",
): Promise<RemoteSession> {
  const r = await visible(tx, userId, id);
  if (r.owner_user_id !== userId) throw forbidden("MACHINE_NOT_YOURS");
  await tx.update(terminalSessions).set({ visibility }).where(eq(terminalSessions.id, id));
  await recordAudit(tx, {
    action: "terminal.visibility",
    targetType: "terminal_session",
    targetId: id,
    data: { visibility, machineId: r.machine_id },
  });
  const live = liveSession(id);
  if (live && visibility === "private") {
    for (const viewer of live.viewers) if (viewer.userId !== userId) viewer.close(4403, "Phiên không còn cho đội xem.");
  }
  return view({ ...r, visibility }, userId);
}

function stateView(s: typeof machineRemoteState.$inferSelect): RemoteMachineState {
  const lockedUntil = s.totpLockedUntil && s.totpLockedUntil > new Date() ? s.totpLockedUntil : null;
  return {
    enabled: s.enabled,
    roots: s.roots,
    clis: s.clis.flatMap((c) => cli.safeParse(c).data ?? []),
    accounts: s.accounts.flatMap((a) => {
      const c = cli.safeParse(a.cli).data;
      const state = (["ready", "cooldown", "disabled", "logged_out"] as const).find((x) => x === a.state);
      return c && state ? [{ id: a.id, label: a.label, cli: c, state }] : [];
    }),
    totp: { enabled: s.totpEnabled, locked: lockedUntil !== null, lockedUntil: lockedUntil?.toISOString() ?? null },
    confirmOnMachine: s.confirmOnMachine,
    updatedAt: s.updatedAt.toISOString(),
  };
}

/**
 * Máy cá nhân của người dùng (người đăng ký máy, không dùng chung) cùng trạng thái từ xa và phiên đang chạy. Máy dùng
 * chung không bao giờ có ở đây: phiên trên đó là của Leader (FR-030).
 */
export async function remoteMachines(tx: Tx, userId: string): Promise<RemoteMachine[]> {
  const { rows } = await tx.execute<{ id: string; name: string; status: string; capabilities: string[] }>(
    sql`select id, name, status, capabilities from hive.machines
      where registered_by = ${userId} and not shared and kind = 'worker' and revoked_at is null
      order by name`,
  );
  return machineViews(
    tx,
    userId,
    rows.map((m) => ({
      id: m.id,
      name: m.name,
      online: m.status === "online",
      terminal: m.capabilities.includes(TERMINAL_CAPABILITY),
    })),
  );
}

/** Một máy đã qua kiểm quyền (`ownedMachine`), cùng dạng với `remoteMachines`. */
export async function remoteMachine(
  tx: Tx,
  userId: string,
  m: { id: string; name: string; online: boolean; terminal: boolean },
): Promise<RemoteMachine> {
  const [view] = await machineViews(tx, userId, [m]);
  if (!view) throw new Error("Không dựng được trạng thái máy.");
  return view;
}

async function machineViews(
  tx: Tx,
  userId: string,
  rows: Array<{ id: string; name: string; online: boolean; terminal: boolean }>,
): Promise<RemoteMachine[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((m) => m.id);
  // Một transaction là một kết nối: chạy lần lượt.
  const states = await tx.select().from(machineRemoteState).where(inArray(machineRemoteState.machineId, ids));
  const policy = await loadPolicy(tx);
  const sessions = await select(
    tx,
    sql`s.machine_id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )}) and s.state in ('opening', 'running')`,
  );
  const byMachine = new Map(states.map((s) => [s.machineId, s]));
  return rows.map((m) => {
    const state = byMachine.get(m.id);
    return {
      id: m.id,
      name: m.name,
      online: m.online,
      terminal: m.terminal,
      remote: state ? stateView(state) : null,
      totpAllowed: policy.remote.totpFallback,
      // Quản trị đội tắt khẩn cấp máy của thành viên cũng không thấy phiên riêng tư của chủ máy.
      sessions: sessions
        .filter((s) => s.machine_id === m.id && ACTIVE.includes(s.state))
        .filter((s) => s.owner_user_id === userId || s.visibility === "team")
        .map((s) => view(s, userId)),
    };
  });
}
