import { randomUUID } from "node:crypto";
import { type MachineEventInput, machineEventInput, type TokenScoreReport } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPool, ForbiddenError, withTenant } from "../platform/index.ts";
import { type AuthedMachine, listMachines } from "./machines.ts";
import { getMachineTokenScore, purgeTokenScores, receiveMachineEvent } from "./token-scores.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);

const orgA = randomUUID();
const tag = randomUUID().slice(0, 8);
const user = (name: string) => `${name}-${tag}`;
let teamA = "";
const machine = (id: string): AuthedMachine => ({ id, orgId: orgA, teamId: teamA, name: `m-${id}`, kind: "worker" });
let m1: AuthedMachine;
let m2: AuthedMachine;

beforeAll(async () => {
  await admin.query(
    `insert into auth."user" (id, name, email) select id, id, id || '@seed.test' from unnest($1::text[]) as id
     on conflict (id) do nothing`,
    [[user("admin"), user("member")]],
  );
  await admin.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, 'A', $3)", [
    orgA,
    `score-${tag}`,
    user("admin"),
  ]);
  await admin.query(
    "insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member')",
    [orgA, user("admin"), user("member")],
  );
  teamA = (
    await admin.query("insert into hive.teams (org_id, slug, name) values ($1, 'ta', 'TA') returning id", [orgA])
  ).rows[0].id;
  await admin.query(
    "insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'admin'), ($1, $2, $4, 'member')",
    [teamA, orgA, user("admin"), user("member")],
  );
  const newMachine = async (name: string) =>
    (
      await admin.query(
        "insert into hive.machines (org_id, team_id, name, os, version) values ($1, $2, $3, 'linux', '1') returning id",
        [orgA, teamA, `${name}-${tag}`],
      )
    ).rows[0].id as string;
  m1 = machine(await newMachine("m1"));
  m2 = machine(await newMachine("m2"));
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const report = (score: number | null = 62.5): TokenScoreReport => ({
  scoreVersion: 2,
  generatedAt: new Date().toISOString(),
  days: 7,
  machine: {
    score,
    level: score === null ? null : score >= 80 ? "good" : score >= 60 ? "fair" : "low",
    coverage: 87,
    provisional: false,
  },
  profiles: [
    {
      cli: "claude",
      score,
      coverage: 87,
      share: 1,
      groups: { A: { earned: 19.3, max: 38 }, B: { earned: 22.2, max: 49 } },
      criteria: [
        { id: "A1", status: "low", earned: 0, max: 10, value: 967000, unit: "tokens" },
        { id: "B7", status: "unknown", earned: 0, max: 6, reason: "not_enough_sessions" },
      ],
    },
  ],
});

const event = (payload = report(), key = `k${randomUUID().replaceAll("-", "")}`): MachineEventInput => ({
  key,
  kind: "machine.token_score",
  createdAt: new Date().toISOString(),
  payload,
});

describe("máy gửi điểm token (ADR 0036)", () => {
  it("nhận lần đầu, gửi lại cùng khoá thì duplicate và không ghi thêm", async () => {
    const e = event();
    const first = await receiveMachineEvent(app, m1, e);
    expect(first).toMatchObject({ key: e.key, outcome: "accepted" });
    const again = await receiveMachineEvent(app, m1, e);
    expect(again).toMatchObject({ key: e.key, outcome: "duplicate", receivedAt: first.receivedAt });
    const { rows } = await admin.query(
      "select count(*)::int as n from hive.machine_token_scores where machine_id = $1",
      [m1.id],
    );
    expect(rows[0].n).toBe(1);
    const ev = await admin.query(
      "select source, machine_id, user_id, kind, target_type, outcome from hive.client_events where idempotency_key = $1",
      [e.key],
    );
    expect(ev.rows).toEqual([
      {
        source: "worker",
        machine_id: m1.id,
        user_id: null,
        kind: "machine.token_score",
        target_type: "machine",
        outcome: "accepted",
      },
    ]);
  });

  it("gửi lần hai trong 10 phút thì rejected; gửi lại khoá đó trả đúng lần từ chối", async () => {
    const e = event(report(70));
    const out = await receiveMachineEvent(app, m1, e);
    expect(out).toMatchObject({ outcome: "rejected", code: "TOKEN_SCORE_TOO_FREQUENT" });
    expect(out.reason).toMatch(/10 phút/);
    const again = await receiveMachineEvent(app, m1, e);
    expect(again).toMatchObject({ outcome: "duplicate", code: "TOKEN_SCORE_TOO_FREQUENT" });
    const { rows } = await admin.query(
      "select count(*)::int as n from hive.machine_token_scores where machine_id = $1",
      [m1.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("hai lần gửi cùng lúc cùng khoá chỉ ghi một điểm", async () => {
    const e = event(report(55));
    const outs = await Promise.all([receiveMachineEvent(app, m2, e), receiveMachineEvent(app, m2, e)]);
    expect(outs.map((o) => o.outcome).sort()).toEqual(["accepted", "duplicate"]);
    const { rows } = await admin.query(
      "select count(*)::int as n from hive.machine_token_scores where machine_id = $1",
      [m2.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("schema strict từ chối đường dẫn, id gói hay trường lạ", () => {
    const withPath = { ...event(), payload: { ...report(), profiles: [{ ...report().profiles[0], id: "claude-2" }] } };
    expect(machineEventInput.safeParse(withPath).success).toBe(false);
    const withProjects = { ...event(), payload: { ...report(), projects: [{ path: "~/Codes/x" }] } };
    expect(machineEventInput.safeParse(withProjects).success).toBe(false);
    expect(machineEventInput.safeParse(event()).success).toBe(true);
  });
});

describe("xem điểm token", () => {
  it("danh sách máy có điểm mới nhất của từng máy", async () => {
    const list = await withTenant(app, { userId: user("admin"), orgId: orgA }, (tx) =>
      listMachines(tx, user("admin"), teamA),
    );
    const byId = new Map(list.map((m) => [m.id, m]));
    expect(byId.get(m1.id)?.tokenScore).toMatchObject({ score: 62.5, level: "fair", coverage: 87, provisional: false });
    expect(byId.get(m2.id)?.tokenScore).toMatchObject({ score: 55, level: "low" });
  });

  it("quản trị đội xem chi tiết và lịch sử; thành viên thường không xem được", async () => {
    const detail = await withTenant(app, { userId: user("admin"), orgId: orgA }, (tx) =>
      getMachineTokenScore(tx, user("admin"), m1.id),
    );
    expect(detail.latest?.report.profiles[0]?.criteria.map((c) => c.id)).toEqual(["A1", "B7"]);
    expect(detail.history).toHaveLength(1);
    await expect(
      withTenant(app, { userId: user("member"), orgId: orgA }, (tx) => getMachineTokenScore(tx, user("member"), m1.id)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("job dọn xoá điểm quá 90 ngày", async () => {
    await admin.query(
      `insert into hive.machine_token_scores (org_id, team_id, machine_id, coverage, score_version, report, generated_at, reported_at)
       values ($1, $2, $3, 1, 2, '{}', now() - interval '100 days', now() - interval '100 days')`,
      [orgA, teamA, m2.id],
    );
    expect(await purgeTokenScores(app)).toBeGreaterThanOrEqual(1);
    const { rows } = await admin.query(
      "select count(*)::int as n from hive.machine_token_scores where machine_id = $1 and reported_at < now() - interval '90 days'",
      [m2.id],
    );
    expect(rows[0].n).toBe(0);
  });
});
