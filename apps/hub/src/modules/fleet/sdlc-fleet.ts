import type { SdlcFleetMachine } from "@xdev-hive/contracts";
import type { WorkerAccountSummary } from "@xdev-hive/contracts/worker-protocol";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "../platform/index.ts";
import { allowWith, requireTeamRole, teamRolesOf, teams } from "../tenancy/index.ts";
import { ACCOUNTS_REMOTE } from "./accounts.ts";
import { toMachineFor } from "./machines.ts";
import { machines } from "./schema.ts";

/** Run đang chạy trên một máy, để trang Đội máy AI SDLC hiện việc của máy. */
export type SdlcFleetRun = SdlcFleetMachine["runs"][number];

/**
 * Module runs (và sdlc) cung cấp run đang chạy theo máy; fleet không import runs vì runs đã import fleet. Chưa đăng ký
 * thì máy không có run nào.
 */
type RunsOfMachines = (tx: Tx, machineIds: string[]) => Promise<Map<string, SdlcFleetRun[]>>;
let runsOfMachines: RunsOfMachines = async () => new Map();

export function provideSdlcFleetRuns(fn: RunsOfMachines): () => void {
  runsOfMachines = fn;
  return () => {
    if (runsOfMachines === fn) runsOfMachines = async () => new Map();
  };
}

/**
 * Mọi gói đang bật và đã đăng nhập đều chạm ngưỡng dừng phiên: lúc sớm nhất một gói dùng lại được. null khi còn gói
 * dùng được hoặc không biết.
 */
export function quotaResetsAt(accounts: WorkerAccountSummary[] | null | undefined): string | null {
  const usable = (accounts ?? []).filter((a) => a.enabled && a.loggedIn !== false);
  if (usable.length === 0) return null;
  const blocked = usable.filter((a) => a.stopAtSession > 0 && (a.sessionPct ?? 0) >= a.stopAtSession);
  if (blocked.length < usable.length) return null;
  const times = blocked.map((a) => a.resetsAt).filter((t): t is string => t !== null);
  return times.sort()[0] ?? null;
}

/**
 * Máy có nhãn của đội (hoặc của mọi đội người dùng quản trị khi không chọn đội), kèm run đang chạy, gói và quota
 * (specs/011 US15). Máy cá nhân của người khác không lộ gói (ADR 0017).
 */
export async function listSdlcFleet(tx: Tx, userId: string, teamId?: string): Promise<SdlcFleetMachine[]> {
  let teamIds: string[];
  if (teamId) {
    await allowWith(tx, userId, "machines.read", () => requireTeamRole(tx, userId, teamId, "admin"), teamId);
    teamIds = [teamId];
  } else {
    const roles = await teamRolesOf(tx, userId);
    teamIds = [...roles].filter(([, role]) => role === "admin").map(([id]) => id);
  }
  if (teamIds.length === 0) return [];
  const rows = await tx
    .select({ machine: machines, teamName: teams.name })
    .from(machines)
    .innerJoin(teams, eq(teams.id, machines.teamId))
    .where(
      and(
        inArray(machines.teamId, teamIds),
        isNull(machines.revokedAt),
        sql`cardinality(${machines.labels}) > 0`,
        eq(machines.kind, "worker"),
      ),
    )
    .orderBy(asc(teams.name), asc(machines.name));
  const runs = await runsOfMachines(
    tx,
    rows.map((r) => r.machine.id),
  );
  return rows.map(({ machine: m, teamName }) => {
    const view = toMachineFor(m, userId);
    const list = runs.get(m.id) ?? [];
    return {
      ...view,
      teamName,
      slotsUsed: list.length,
      runs: list,
      quotaResetsAt: quotaResetsAt(view.accounts),
      canSetAccounts: m.shared && m.capabilities.includes(ACCOUNTS_REMOTE),
    };
  });
}
