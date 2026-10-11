// Kênh thông báo và hàng gửi của module notify: quyền, RLS, notify() trong transaction nghiệp vụ, gửi có thử lại.
import { randomBytes, randomUUID } from "node:crypto";
import type { NotificationChannelCreateInput } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import {
  createChannel,
  deliverNotification,
  deliverPending,
  listChannels,
  MAX_ATTEMPTS,
  notify,
  notifyQueue,
  registerNotifyWorker,
  removeChannel,
  updateChannel,
} from "./modules/notify/index.ts";
import { createJobs, createPool, parseMasterKey, type Tx, withTenant } from "./modules/platform/index.ts";

const { adminUrl, appUrl, jobsUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const quiet = { warn: () => {} };
const TOKEN = "123456:ABCdefGhIJKlmnOPQrstUVwxyz0123456789";

let org: OrgFixture & { user: (n: string) => string };
let other: OrgFixture & { user: (n: string) => string };

/** Telegram giả: trả lần lượt theo `statuses`, hết thì 200. */
function telegramFake(statuses: number[] = []) {
  const sent: Array<{ chatId: string; text: string }> = [];
  const queue = [...statuses];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
    const status = queue.shift() ?? 200;
    if (status === 200) sent.push({ chatId: body.chat_id, text: body.text });
    return new Response(JSON.stringify({ ok: status === 200, description: status === 200 ? undefined : "lỗi giả" }), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, sent };
}

const asUser = <T>(o: OrgFixture & { user: (n: string) => string }, n: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pool, { userId: o.user(n), orgId: o.orgId }, fn);

const telegramInput = (name: string, events: string[], chatId = "-100"): NotificationChannelCreateInput => ({
  name,
  events: events as never,
  config: { kind: "telegram", botToken: TOKEN, chatId },
});

async function newChannel(input: NotificationChannelCreateInput) {
  return asUser(org, "admin", (tx) => createChannel(tx, masterKey, org.user("admin"), input));
}

const notificationRows = async (ids: string[]) =>
  (await admin.query("select * from hive.notifications where id = any($1::uuid[]) order by created_at", [ids])).rows;

beforeAll(async () => {
  org = await seedOrg(admin, `ntf-${tag}`);
  other = await seedOrg(admin, `ntf2-${tag}`);
});

afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

describe("kênh thông báo", () => {
  it("tạo và sửa SMTP nội bộ bị từ chối; cờ cho phép được truyền qua deps", async () => {
    const input: NotificationChannelCreateInput = {
      name: `smtp-${tag}`,
      events: ["run.failed"],
      enabled: false,
      config: { kind: "email", host: "127.0.0.1", from: "a@example.com", to: ["b@example.com"] },
    };
    const blocked = { name: "BadRequestError", message: "Máy chủ SMTP trỏ vào địa chỉ nội bộ" };
    await expect(newChannel(input)).rejects.toMatchObject(blocked);
    const channel = await asUser(org, "admin", (tx) =>
      createChannel(tx, masterKey, org.user("admin"), input, { allowPrivate: true }),
    );
    await expect(
      asUser(org, "admin", (tx) =>
        updateChannel(tx, masterKey, org.user("admin"), {
          id: channel.id,
          config: input.config,
        }),
      ),
    ).rejects.toMatchObject(blocked);
    await expect(
      asUser(org, "admin", (tx) =>
        updateChannel(tx, masterKey, org.user("admin"), {
          id: channel.id,
          enabled: true,
        }),
      ),
    ).rejects.toMatchObject(blocked);
    // Đổi tên hay tắt kênh không gọi DNS: kênh đang hỏng vẫn sửa và tắt được dù host bị chặn.
    await asUser(org, "admin", (tx) =>
      updateChannel(tx, masterKey, org.user("admin"), { id: channel.id, name: `smtp-sua-${tag}`, enabled: false }),
    );
    await asUser(org, "admin", (tx) => removeChannel(tx, org.user("admin"), channel.id));
  });

  it("quản trị tổ chức tạo được; thành viên không tạo, không xem được", async () => {
    const ch = await newChannel(telegramInput(`tg-${tag}`, ["run.failed"]));
    expect(ch).toMatchObject({ kind: "telegram", events: ["run.failed"], enabled: true, target: "Telegram -100" });
    await expect(
      asUser(org, "tmember", (tx) =>
        createChannel(tx, masterKey, org.user("tmember"), telegramInput("x", ["run.failed"])),
      ),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
    await expect(asUser(org, "tmember", (tx) => listChannels(tx, org.user("tmember")))).rejects.toMatchObject({
      name: "ForbiddenError",
    });
  });

  it("secret không nằm trong kết quả API hay trong database dạng rõ; tổ chức khác không thấy kênh", async () => {
    const ch = await newChannel(telegramInput(`bi-mat-${tag}`, ["run.failed"]));
    const list = await asUser(org, "admin", (tx) => listChannels(tx, org.user("admin")));
    expect(JSON.stringify(list)).not.toContain(TOKEN);
    const { rows } = await admin.query("select config_enc from hive.notification_channels where id = $1", [ch.id]);
    expect(rows[0].config_enc).not.toContain(TOKEN);
    const theirs = await asUser(other, "admin", (tx) => listChannels(tx, other.user("admin")));
    expect(theirs.map((c) => c.id)).not.toContain(ch.id);
    // Dù biết id, tổ chức khác không sửa hay xoá được.
    await expect(asUser(other, "admin", (tx) => removeChannel(tx, other.user("admin"), ch.id))).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("sửa tên, sự kiện, tắt kênh, thay cấu hình; không đổi được loại kênh; tên trùng báo xung đột", async () => {
    const ch = await newChannel(telegramInput(`sua-${tag}`, ["run.failed"]));
    const updated = await asUser(org, "admin", (tx) =>
      updateChannel(tx, masterKey, org.user("admin"), {
        id: ch.id,
        events: ["machine.offline", "machine.offline", "member.pending"],
        enabled: false,
        config: { kind: "telegram", botToken: TOKEN, chatId: "@kenh_hive" },
      }),
    );
    expect(updated).toMatchObject({
      events: ["machine.offline", "member.pending"],
      enabled: false,
      target: "Telegram @kenh_hive",
    });
    await expect(
      asUser(org, "admin", (tx) =>
        updateChannel(tx, masterKey, org.user("admin"), {
          id: ch.id,
          config: { kind: "email", host: "smtp.example.com", from: "a@example.com", to: ["b@example.com"] },
        }),
      ),
    ).rejects.toMatchObject({ name: "BadRequestError", code: "NOTIFICATION_CHANNEL_KIND_FIXED" });
    await expect(
      asUser(org, "admin", (tx) => updateChannel(tx, masterKey, org.user("admin"), { id: ch.id, name: `tg-${tag}` })),
    ).rejects.toMatchObject({ name: "ConflictError" });
    const { rows } = await admin.query(
      "select action, data from hive.audit_log where target_id = $1 order by created_at",
      [ch.id],
    );
    expect(rows.map((r) => r.action)).toEqual(["notification_channel.create", "notification_channel.update"]);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });
});

describe("notify và gửi", () => {
  const fail = `run.failed`;

  it("chỉ kênh đang bật và nhận loại sự kiện mới có dòng thông báo; link lạ bị bỏ", async () => {
    const on = await newChannel(telegramInput(`nhan-${tag}`, [fail, "run.needs_review"]));
    const off = await newChannel({ ...telegramInput(`tat-${tag}`, [fail]), enabled: false });
    const ids = await asUser(org, "admin", (tx) =>
      notify(tx, {
        orgId: org.orgId,
        event: "run.needs_review",
        title: "Cần review",
        body: "PR #3",
        link: "javascript:alert(1)",
      }),
    );
    const rows = await notificationRows(ids);
    expect(rows.map((r) => r.channel_id)).toEqual([on.id]);
    expect(rows[0]).toMatchObject({ status: "queued", attempts: 0, link: null, event: "run.needs_review" });
    expect(rows.map((r) => r.channel_id)).not.toContain(off.id);
  });

  it("gửi thành công: sent; lỗi tạm thời: thử lại tới lần thứ 5 rồi failed; lỗi vĩnh viễn: failed ngay", async () => {
    const ch = await newChannel(telegramInput(`gui-${tag}`, ["project.provision_failed"], "-200"));
    const send = (statuses: number[]) => {
      const fake = telegramFake(statuses);
      return { fake, deps: { pool, masterKey, fetch: fake.fetch } };
    };
    const emit = (title: string) =>
      asUser(org, "admin", (tx) =>
        notify(tx, {
          orgId: org.orgId,
          event: "project.provision_failed",
          title,
          body: "Saga dừng ở bước tạo repo",
          link: "https://hive.example.com/projects/1",
        }),
      );
    const mine = async (ids: string[]) => (await notificationRows(ids)).filter((r) => r.channel_id === ch.id);

    const ok = send([]);
    const [okId] = (await mine(await emit("Lần 1"))).map((r) => r.id);
    expect(await deliverNotification(ok.deps, { orgId: org.orgId, notificationId: okId }, quiet)).toBe("sent");
    expect(ok.fake.sent).toEqual([{ chatId: "-200", text: expect.stringContaining("<b>Lần 1</b>") }]);
    expect((await notificationRows([okId]))[0]).toMatchObject({ status: "sent", attempts: 1, error: null });
    // Job chạy lại sau khi đã gửi thì không gửi lần hai.
    expect(await deliverNotification(ok.deps, { orgId: org.orgId, notificationId: okId }, quiet)).toBe("skipped");

    const flaky = send(Array(MAX_ATTEMPTS).fill(502));
    const [flakyId] = (await mine(await emit("Lần 2"))).map((r) => r.id);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(await deliverNotification(flaky.deps, { orgId: org.orgId, notificationId: flakyId }, quiet)).toBe("retry");
      expect((await notificationRows([flakyId]))[0]).toMatchObject({ status: "queued", attempts: i });
    }
    expect(await deliverNotification(flaky.deps, { orgId: org.orgId, notificationId: flakyId }, quiet)).toBe("failed");
    const failed = (await notificationRows([flakyId]))[0];
    expect(failed).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect(failed.error).toContain("502");
    expect(failed.error).not.toContain(TOKEN);

    const denied = send([401]);
    const [deniedId] = (await mine(await emit("Lần 3"))).map((r) => r.id);
    expect(await deliverNotification(denied.deps, { orgId: org.orgId, notificationId: deniedId }, quiet)).toBe(
      "failed",
    );
    expect((await notificationRows([deniedId]))[0]).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("kênh tắt sau khi đã xếp hàng: failed kèm lý do; deliverPending gửi phần còn lại; xoá kênh xoá lịch sử", async () => {
    const ch = await newChannel(telegramInput(`muon-${tag}`, ["member.pending"], "-300"));
    const emit = () =>
      asUser(org, "admin", (tx) =>
        notify(tx, { orgId: org.orgId, event: "member.pending", title: "Người chờ duyệt", body: "lan@example.com" }),
      );
    const first = await emit();
    await asUser(org, "admin", (tx) => updateChannel(tx, masterKey, org.user("admin"), { id: ch.id, enabled: false }));
    const fake = telegramFake();
    const counts = await deliverPending({ pool, masterKey, fetch: fake.fetch }, org.orgId, quiet);
    expect(counts.failed).toBeGreaterThanOrEqual(1);
    const mine = (await notificationRows(first)).find((r) => r.channel_id === ch.id);
    expect(mine).toMatchObject({ status: "failed" });
    expect(mine.error).toContain("Kênh đã tắt");
    expect(fake.sent.filter((s) => s.chatId === "-300")).toHaveLength(0);

    await asUser(org, "admin", (tx) => removeChannel(tx, org.user("admin"), ch.id));
    const { rows } = await admin.query("select count(*)::int as n from hive.notifications where channel_id = $1", [
      ch.id,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it("job pg-boss gửi sau khi transaction commit; transaction rollback thì không ai nhận", async () => {
    const ch = await newChannel(telegramInput(`job-${tag}`, ["machine.offline"], "-400"));
    const jobs = createJobs({ connectionString: jobsUrl, queues: [notifyQueue], maintenance: false });
    await jobs.start();
    try {
      const fake = telegramFake();
      await registerNotifyWorker(jobs, { pool, masterKey, fetch: fake.fetch }, { pollingIntervalSeconds: 0.5 });
      await expect(
        asUser(org, "admin", async (tx) => {
          await notify(tx, { orgId: org.orgId, event: "machine.offline", title: "Rollback", body: "x" }, { jobs });
          throw new Error("nghiệp vụ lỗi");
        }),
      ).rejects.toThrow("nghiệp vụ lỗi");
      const ids = await asUser(org, "admin", (tx) =>
        notify(
          tx,
          { orgId: org.orgId, event: "machine.offline", title: "Máy mac-mini mất kết nối", body: "Hơn 1 phút" },
          { jobs },
        ),
      );
      const id = (await notificationRows(ids)).find((r) => r.channel_id === ch.id)?.id;
      await vi.waitFor(async () => expect((await notificationRows([id]))[0].status).toBe("sent"), {
        timeout: 15_000,
        interval: 200,
      });
      const mine = fake.sent.filter((s) => s.chatId === "-400");
      expect(mine).toHaveLength(1);
      expect(mine[0]?.text).toContain("Máy mac-mini mất kết nối");
    } finally {
      await jobs.stop();
    }
  });
});
