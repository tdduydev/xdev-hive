import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { seedOrg } from "../test/org-fixture.ts";
import { checkMachineOffline, fleetOfflineQueue, registerFleetOfflineWorker } from "./modules/fleet/index.ts";
import { type AuthedMachine, type FleetOfflineJob, markOffline, markOnline } from "./modules/fleet/machines.ts";
import { createChannel, notifyQueue } from "./modules/notify/index.ts";
import { createJobs, createPool, type Jobs, parseMasterKey, withTenant } from "./modules/platform/index.ts";

const { adminUrl, appUrl, jobsUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const jobs = createJobs({ connectionString: jobsUrl, queues: [fleetOfflineQueue, notifyQueue], maintenance: false });
const publicUrl = "https://hive.example.com/";
let org: Awaited<ReturnType<typeof seedOrg>>;
let other: Awaited<ReturnType<typeof seedOrg>>;
let channelId: string;

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  org = await seedOrg(admin, `offline-${tag}`);
  other = await seedOrg(admin, `offline2-${tag}`);
  const key = parseMasterKey(randomBytes(32).toString("base64"));
  channelId = (
    await withTenant(pool, { orgId: org.orgId, userId: org.user("admin") }, (tx) =>
      createChannel(
        tx,
        key,
        org.user("admin"),
        {
          name: "Máy mất kết nối",
          events: ["machine.offline"],
          config: { kind: "email", host: "smtp.example.com", from: "hive@example.com", to: ["admin@example.com"] },
        },
        { lookup: async () => [{ address: "8.8.8.8", family: 4 }] },
      ),
    )
  ).id;
  await jobs.start();
});

afterAll(async () => {
  await jobs.stop();
  await Promise.all([admin.end(), pool.end()]);
});

async function machine(status = "offline"): Promise<{ machine: AuthedMachine; job: FleetOfflineJob }> {
  const id = randomUUID();
  const name = `may-${id.slice(0, 8)}`;
  const { rows } = await admin.query(
    `insert into hive.machines (id, org_id, team_id, name, os, version, status, last_seen_at)
     values ($1, $2, $3, $4, 'linux', 'test', $5, date_trunc('milliseconds', now() - interval '10 minutes'))
     returning last_seen_at`,
    [id, org.orgId, org.teamId, name, status],
  );
  return {
    machine: { id, orgId: org.orgId, teamId: org.teamId, name },
    job: { orgId: org.orgId, machineId: id, offlineAt: (rows[0].last_seen_at as Date).toISOString() },
  };
}

async function notices(m: AuthedMachine) {
  return (
    await admin.query("select * from hive.notifications where channel_id = $1 and title like $2", [
      channelId,
      `Máy ${m.name} %`,
    ])
  ).rows;
}

async function queued(m: AuthedMachine) {
  return (
    await admin.query(
      "select data, singleton_key, start_after from pgboss.job where name = $1 and singleton_key = $2 order by created_on",
      [fleetOfflineQueue.name, m.id],
    )
  ).rows;
}

describe("thông báo máy offline", () => {
  it("offline quá hạn: nội dung có đội, link quản trị; chạy đồng thời và chạy lại không trùng", async () => {
    const { machine: m, job } = await machine();
    await Promise.all([
      checkMachineOffline(pool, publicUrl, job, { jobs }),
      checkMachineOffline(pool, publicUrl, job, { jobs }),
    ]);
    await checkMachineOffline(pool, publicUrl, job, { jobs });
    const rows = await notices(m);
    expect(rows).toHaveLength(1);
    const { rows: inbox } = await admin.query(
      "select user_id from hive.inbox_items where org_id = $1 and event_key = $2",
      [m.orgId, `${job.machineId}:${job.offlineAt}`],
    );
    expect(inbox.map((r) => r.user_id).sort()).toEqual([org.user("owner"), org.user("admin")].sort());
    expect(rows[0]).toMatchObject({
      event: "machine.offline",
      title: `Máy ${m.name} mất kết nối hơn 5 phút`,
      body: "Đội thanh-toan.",
      link: "https://hive.example.com/admin/machines",
    });
    const delivery = await admin.query("select data from pgboss.job where name = $1 and data->>'notificationId' = $2", [
      notifyQueue.name,
      rows[0].id,
    ]);
    expect(delivery.rows).toHaveLength(1);
  });

  it("nối lại trước hạn hoặc bị thu hồi thì không báo", async () => {
    const online = await machine();
    await markOnline(pool, online.machine);
    await checkMachineOffline(pool, publicUrl, online.job);
    expect(await notices(online.machine)).toHaveLength(0);
    const revoked = await machine();
    await admin.query("update hive.machines set revoked_at = now() where id = $1", [revoked.machine.id]);
    await checkMachineOffline(pool, publicUrl, revoked.job);
    expect(await notices(revoked.machine)).toHaveLength(0);
  });

  it("job cũ không báo cho lần offline mới; lần mới vẫn có job riêng và báo được", async () => {
    const { machine: m, job: oldJob } = await machine("online");
    await markOffline(pool, m, { jobs });
    const [first] = await queued(m);
    await markOnline(pool, m);
    await markOffline(pool, m, { jobs });
    const pending = await queued(m);
    expect(pending).toHaveLength(2);
    await checkMachineOffline(pool, publicUrl, oldJob);
    await checkMachineOffline(pool, publicUrl, first.data);
    expect(await notices(m)).toHaveLength(0);
    // Giả lập job mới đến hạn; việc trì hoãn thực tế được kiểm riêng qua worker pg-boss.
    await checkMachineOffline(pool, publicUrl, pending[1].data);
    expect(await notices(m)).toHaveLength(1);
  });

  it("tổ chức khác không đọc hoặc ghi dấu đã báo của máy", async () => {
    const { machine: m, job } = await machine();
    await checkMachineOffline(pool, publicUrl, { ...job, orgId: other.orgId });
    expect(await notices(m)).toHaveLength(0);
    await checkMachineOffline(pool, publicUrl, job);
    expect(await notices(m)).toHaveLength(1);
  });

  it("không có jobs vẫn ghi offline; xếp job lỗi hoặc notify lỗi thì rollback cùng dữ liệu", async () => {
    const withoutJobs = await machine("online");
    await markOffline(pool, withoutJobs.machine);
    expect(await queued(withoutJobs.machine)).toHaveLength(0);
    expect(
      (await admin.query("select status from hive.machines where id = $1", [withoutJobs.machine.id])).rows[0].status,
    ).toBe("offline");
    const failed = await machine("online");
    const broken: Jobs = {
      ...jobs,
      enqueue: async () => {
        throw new Error("Hàng đợi lỗi");
      },
    };
    await expect(markOffline(pool, failed.machine, { jobs: broken })).rejects.toThrow("Hàng đợi lỗi");
    expect(
      (await admin.query("select status from hive.machines where id = $1", [failed.machine.id])).rows[0].status,
    ).toBe("online");
    const retry = await machine();
    await expect(checkMachineOffline(pool, publicUrl, retry.job, { jobs: broken })).rejects.toThrow("Hàng đợi lỗi");
    expect(await notices(retry.machine)).toHaveLength(0);
    await checkMachineOffline(pool, publicUrl, retry.job, { jobs });
    expect(await notices(retry.machine)).toHaveLength(1);
  });

  it("markOffline hẹn job đúng thời gian, không xếp lại khi đã offline; worker chỉ báo sau hạn", async () => {
    const { machine: m } = await machine("online");
    await markOffline(pool, m, { jobs, notifyAfterSec: 1 });
    await markOffline(pool, m, { jobs, notifyAfterSec: 1 });
    const pending = await queued(m);
    expect(pending).toHaveLength(1);
    expect(pending[0].data).toMatchObject({ orgId: org.orgId, machineId: m.id });
    expect((pending[0].start_after as Date).getTime() - Date.parse(pending[0].data.offlineAt)).toBe(1000);
    expect(await notices(m)).toHaveLength(0);
    await registerFleetOfflineWorker(jobs, { pool, publicUrl, notifyAfterSec: 1 });
    await vi.waitFor(async () => expect(await notices(m)).toHaveLength(1), { timeout: 10_000, interval: 100 });
    expect((await notices(m))[0].created_at.getTime()).toBeGreaterThanOrEqual(pending[0].start_after.getTime());
    expect((await notices(m))[0].title).toBe(`Máy ${m.name} mất kết nối hơn 1 phút`);
  });
});
