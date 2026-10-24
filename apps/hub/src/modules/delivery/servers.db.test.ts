import { randomBytes, randomUUID } from "node:crypto";
import { deployServer, serverTestResult } from "@xdev-hive/contracts";
import pg from "pg";
import ssh2 from "ssh2";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { createPool, decryptSecret, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { generateServerKey } from "./clients/ssh.ts";
import {
  confirmServerHostKey,
  confirmServerRotation,
  createServer,
  listServers,
  removeServer,
  rotateServerKey,
  serverKeyContext,
  testServer,
  updateServer,
} from "./servers.ts";
import { type FakeSsh, fingerprintOf, startFakeSsh } from "./testing/fake-ssh.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));

let org: Awaited<ReturnType<typeof seedOrg>>;
let ssh: FakeSsh;
/** Dòng authorized_keys của máy chủ giả; test cài và gỡ khoá công khai hub trả về. */
let authorized: string[] = [];
const deps = () => ({ pool: app, masterKey });
const actor = (name: string) => ({ orgId: org.orgId, userId: org.user(name) });

const as = <T>(name: string, run: (tx: Tx) => Promise<T>) =>
  withTenant(app, { orgId: org.orgId, userId: org.user(name) }, run);
const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return {
      name: (error as Error).name,
      code: (error as { code?: string }).code,
      data: (error as { data?: unknown }).data,
    };
  }
  return undefined;
};

/** Khoá riêng đang lưu (giải mã thẳng từ DB bằng quyền admin) để kiểm không nơi nào lộ ra. */
async function storedPrivateKeys(): Promise<string[]> {
  const { rows } = await admin.query<{ id: string; private_key_enc: string; pending_private_key_enc: string | null }>(
    "select id, private_key_enc, pending_private_key_enc from hive.deploy_servers where org_id = $1",
    [org.orgId],
  );
  return rows.flatMap((r) =>
    [r.private_key_enc, r.pending_private_key_enc]
      .filter((e): e is string => e !== null)
      .map((e) => decryptSecret(masterKey, e, serverKeyContext(r.id))),
  );
}
const seen: unknown[] = [];
const keep = <T>(v: T): T => {
  seen.push(v);
  return v;
};

const auditRows = async (action: string) =>
  (
    await admin.query<{ target_id: string; data: Record<string, unknown> }>(
      "select target_id, data from hive.audit_log where org_id = $1 and action = $2 order by created_at",
      [org.orgId, action],
    )
  ).rows;

beforeAll(async () => {
  org = await seedOrg(admin, `delivery-srv-${randomUUID().slice(0, 8)}`);
  ssh = await startFakeSsh({
    authorizedKeys: () => authorized,
    exec: () => ({ stdout: "os=Ubuntu 24.04.1 LTS\ndocker=27.3.1\ncompose=2.29.7\ndisk=2097152\n" }),
  });
});

afterAll(async () => {
  await ssh.close();
  await app.end();
  await admin.end();
});

beforeEach(() => {
  ssh.commands.length = 0;
  ssh.logins = 0;
});

const create = (name: string, over: Record<string, unknown> = {}) =>
  as("tadmin", (tx) =>
    createServer(tx, deps(), org.user("tadmin"), {
      teamId: org.teamId,
      name,
      host: ssh.host,
      port: ssh.port,
      user: "deploy",
      labels: ["web", "web"],
      ...over,
    }),
  );

describe("thêm, sửa, xoá máy chủ", () => {
  it("quản trị đội tạo: hub sinh ed25519, trả khoá công khai và lệnh cài, mã hoá khoá riêng theo id", async () => {
    const s = keep(await create("may-1"));
    expect(deployServer.parse(s)).toEqual(s);
    expect(s.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ xdev-hive$/);
    expect(s.installCommand).toContain(`echo '${s.publicKey}' >> ~/.ssh/authorized_keys`);
    expect(s.installCommand).toContain("mkdir -p ~/.ssh");
    expect(s).toMatchObject({ labels: ["web"], hostKeyFingerprints: [], pendingKey: null, lastTest: null });
    const { rows } = await admin.query("select private_key_enc from hive.deploy_servers where id = $1", [s.id]);
    expect(rows[0].private_key_enc).not.toContain("PRIVATE KEY");
    // Ngữ cảnh mã hoá gắn với id: chép bản mã sang dòng khác thì không giải được.
    expect(() => decryptSecret(masterKey, rows[0].private_key_enc, serverKeyContext(randomUUID()))).toThrow();
    const audits = await auditRows("delivery.server.create");
    expect(audits.at(-1)?.target_id).toBe(s.id);
  });

  it("thiếu servers.manage thì bị chặn; đội khác thì không thấy", async () => {
    const input = { teamId: org.teamId, name: "x", host: ssh.host, port: 22, user: "deploy", labels: [] };
    for (const name of ["tmember", "tviewer", "oadmin", "loner"])
      expect(await failure(() => as(name, (tx) => createServer(tx, deps(), org.user(name), input)))).toMatchObject({
        name: "ForbiddenError",
      });
    const s = await create("may-quyen");
    for (const name of ["tmember", "oadmin"])
      expect(
        await failure(() => as(name, (tx) => updateServer(tx, org.user(name), { id: s.id, name: "doi-ten" }))),
      ).toMatchObject({ name: "ForbiddenError" });
    expect(await failure(() => testServer(deps(), actor("tviewer"), { id: s.id }))).toMatchObject({
      name: "ForbiddenError",
    });
    expect(
      await failure(() => as("tmember", (tx) => rotateServerKey(tx, deps(), org.user("tmember"), s.id))),
    ).toMatchObject({ name: "ForbiddenError" });
  });

  it("trùng tên trong đội thì báo rõ", async () => {
    await create("may-trung");
    expect(await failure(() => create("may-trung"))).toMatchObject({ code: "SERVER_NAME_TAKEN" });
  });

  it("danh sách: người có ci.view của đội xem được, không có khoá riêng", async () => {
    await create("may-ds");
    const list = keep(await as("tviewer", (tx) => listServers(tx, org.user("tviewer"), { teamId: org.teamId })));
    expect(list.map((s) => s.name)).toContain("may-ds");
    for (const s of list) expect(deployServer.parse(s)).toEqual(s);
    const all = await as("tmember", (tx) => listServers(tx, org.user("tmember"), {}));
    expect(all.length).toBe(list.length);
  });

  it("đổi địa chỉ hay cổng thì xoá dấu vân tay đã xác nhận; đổi tên thì giữ", async () => {
    const s = await create("may-sua");
    await admin.query("update hive.deploy_servers set host_keys = $2 where id = $1", [
      s.id,
      JSON.stringify(ssh.hostKeys),
    ]);
    const renamed = await as("tadmin", (tx) =>
      updateServer(tx, org.user("tadmin"), { id: s.id, name: "may-sua-2", labels: ["db"] }),
    );
    expect(renamed).toMatchObject({
      name: "may-sua-2",
      labels: ["db"],
      hostKeyFingerprints: [ssh.hostKeys[0]?.fingerprint],
    });
    const moved = await as("tadmin", (tx) => updateServer(tx, org.user("tadmin"), { id: s.id, port: 2222 }));
    expect(moved).toMatchObject({ port: 2222, hostKeyFingerprints: [] });
    expect((await auditRows("delivery.server.update")).length).toBeGreaterThanOrEqual(2);
  });

  it("xoá máy chủ; đích còn dùng thì chặn", async () => {
    const s = await create("may-xoa");
    expect(await as("tadmin", (tx) => removeServer(tx, org.user("tadmin"), s.id))).toEqual({ id: s.id });
    expect(await failure(() => as("tadmin", (tx) => removeServer(tx, org.user("tadmin"), s.id)))).toMatchObject({
      name: "NotFoundError",
    });
    expect((await auditRows("delivery.server.remove")).at(-1)?.target_id).toBe(s.id);
  });
});

describe("kiểm kết nối và host key", () => {
  it("lần đầu: trả dấu vân tay, không xác thực, không chạy lệnh, không giải mã khoá", async () => {
    const s = await create("may-kiem-1");
    authorized = [s.publicKey];
    const before = (await auditRows("delivery.secret_used")).length;
    const r = keep(await testServer(deps(), actor("tadmin"), { id: s.id }));
    expect(serverTestResult.parse(r)).toEqual(r);
    expect(r).toEqual({ result: "hostkey_unconfirmed", fingerprints: ssh.hostKeys.map((k) => k.fingerprint) });
    expect(ssh.logins).toBe(0);
    expect(ssh.commands).toEqual([]);
    expect((await auditRows("delivery.secret_used")).length).toBe(before);
  });

  it("xác nhận dấu vân tay sai thì từ chối; đúng thì lưu, kiểm lại chạy lệnh và đọc OS, Docker, Compose, đĩa", async () => {
    const s = await create("may-kiem-2");
    authorized = [s.publicKey];
    const wrong = `SHA256:${"C".repeat(43)}`;
    expect(
      await failure(() => confirmServerHostKey(deps(), actor("tadmin"), { id: s.id, fingerprint: wrong })),
    ).toMatchObject({ code: "SSH_HOSTKEY_CHANGED", data: { fingerprint: ssh.hostKeys[0]?.fingerprint } });
    const fingerprint = ssh.hostKeys[0]?.fingerprint ?? "";
    const confirmed = keep(await confirmServerHostKey(deps(), actor("tadmin"), { id: s.id, fingerprint }));
    expect(confirmed.hostKeyFingerprints).toEqual([fingerprint]);
    expect(ssh.commands).toEqual([]);

    const r = keep(await testServer(deps(), actor("tadmin"), { id: s.id }));
    expect(r).toEqual({
      result: "ok",
      fingerprint,
      key: "current",
      os: "Ubuntu 24.04.1 LTS",
      docker: "27.3.1",
      compose: "2.29.7",
      diskFreeBytes: 2097152 * 1024,
    });
    expect(ssh.commands).toHaveLength(1);
    const [row] = await as("tadmin", (tx) => listServers(tx, org.user("tadmin"), { teamId: org.teamId })).then((l) =>
      l.filter((x) => x.id === s.id),
    );
    expect(row?.lastTest).toMatchObject({ ok: true });
    // Mỗi lần giải mã khoá có một dòng audit, không chứa khoá.
    const used = (await auditRows("delivery.secret_used")).filter((a) => a.target_id === s.id);
    expect(used).toHaveLength(1);
    expect(used[0]?.data).toMatchObject({ kind: "ssh_key", id: s.id, reason: "server.test" });
  });

  it("máy chủ không nhận khoá: lỗi xác thực; cổng đóng: lỗi mạng", async () => {
    const s = await create("may-kiem-3");
    authorized = [];
    await confirmServerHostKey(deps(), actor("tadmin"), { id: s.id, fingerprint: ssh.hostKeys[0]?.fingerprint ?? "" });
    expect(await testServer(deps(), actor("tadmin"), { id: s.id })).toMatchObject({ result: "error", kind: "auth" });
    const closed = await create("may-dong", { port: 1 });
    await admin.query("update hive.deploy_servers set host_keys = $2 where id = $1", [
      closed.id,
      JSON.stringify(ssh.hostKeys),
    ]);
    const r = await testServer(deps(), actor("tadmin"), { id: closed.id });
    expect(r).toMatchObject({ result: "error", kind: "network" });
    expect(ssh.commands).toEqual([]);
  });

  it("host key đổi: dừng trước mọi lệnh, audit và báo quản trị đội, kèm dấu vân tay vừa thấy", async () => {
    const s = await create("may-doi-hostkey");
    authorized = [s.publicKey];
    const old = ssh2.utils.parseKey(generateServerKey().privateKey);
    if (old instanceof Error || Array.isArray(old)) throw new Error("khoá giả hỏng");
    const stale = { algorithm: "ssh-ed25519", fingerprint: fingerprintOf(old.getPublicSSH()) };
    await admin.query("update hive.deploy_servers set host_keys = $2 where id = $1", [s.id, JSON.stringify([stale])]);
    const r = keep(await testServer(deps(), actor("tadmin"), { id: s.id }));
    expect(r).toMatchObject({ result: "error", kind: "hostkey_changed", fingerprint: ssh.hostKeys[0]?.fingerprint });
    expect(ssh.logins).toBe(0);
    expect(ssh.commands).toEqual([]);
    const audits = (await auditRows("delivery.server.hostkey_changed")).filter((a) => a.target_id === s.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.data).toMatchObject({ expected: [stale.fingerprint], presented: ssh.hostKeys[0]?.fingerprint });
    const { rows } = await admin.query<{ user_id: string }>(
      "select user_id from hive.inbox_items where org_id = $1 and event = 'server.hostkey_changed'",
      [org.orgId],
    );
    expect(rows.map((x) => x.user_id)).toContain(org.user("tadmin"));
    // Host key đã lưu giữ nguyên: chỉ quản trị xác nhận lại mới đổi.
    const [row] = (await as("tadmin", (tx) => listServers(tx, org.user("tadmin"), {}))).filter((x) => x.id === s.id);
    expect(row?.hostKeyFingerprints).toEqual([stale.fingerprint]);
  });
});

describe("đổi khoá", () => {
  it("khoá mới chờ ở pending; kiểm khoá mới chưa cài thì giữ khoá cũ; cài xong mới thay", async () => {
    const s = await create("may-doi-khoa");
    authorized = [s.publicKey];
    await confirmServerHostKey(deps(), actor("tadmin"), { id: s.id, fingerprint: ssh.hostKeys[0]?.fingerprint ?? "" });

    const rotated = keep(await as("tadmin", (tx) => rotateServerKey(tx, deps(), org.user("tadmin"), s.id)));
    expect(rotated.publicKey).toBe(s.publicKey);
    expect(rotated.pendingKey?.publicKey).toMatch(/^ssh-ed25519 /);
    expect(rotated.pendingKey?.publicKey).not.toBe(s.publicKey);
    expect(rotated.pendingKey?.installCommand).toContain(rotated.pendingKey?.publicKey);
    const pending = rotated.pendingKey?.publicKey ?? "";

    // Khoá mới chưa cài: không mất đường vào, khoá cũ vẫn chạy.
    expect(await failure(() => confirmServerRotation(deps(), actor("tadmin"), { id: s.id }))).toMatchObject({
      code: "SSH_AUTH_FAILED",
    });
    expect(await testServer(deps(), actor("tadmin"), { id: s.id })).toMatchObject({ result: "ok", key: "current" });

    authorized = [s.publicKey, pending];
    const swapped = keep(await confirmServerRotation(deps(), actor("tadmin"), { id: s.id }));
    expect(swapped).toMatchObject({ publicKey: pending, pendingKey: null });
    authorized = [pending];
    expect(await testServer(deps(), actor("tadmin"), { id: s.id })).toMatchObject({ result: "ok", key: "current" });
    expect((await auditRows("delivery.server.rotate_key")).some((a) => a.target_id === s.id)).toBe(true);
    expect((await auditRows("delivery.server.rotate_key_confirm")).some((a) => a.target_id === s.id)).toBe(true);
    const used = (await auditRows("delivery.secret_used")).filter((a) => a.target_id === s.id);
    expect(used.map((a) => a.data.reason)).toEqual(
      expect.arrayContaining(["server.test", "server.rotate_key_confirm"]),
    );
  });

  it("chưa xác nhận host key thì không đổi khoá được; không có khoá chờ thì báo", async () => {
    const s = await create("may-doi-khoa-2");
    expect(await failure(() => confirmServerRotation(deps(), actor("tadmin"), { id: s.id }))).toMatchObject({
      code: "NO_PENDING_KEY",
    });
    await as("tadmin", (tx) => rotateServerKey(tx, deps(), org.user("tadmin"), s.id));
    expect(await failure(() => confirmServerRotation(deps(), actor("tadmin"), { id: s.id }))).toMatchObject({
      code: "HOSTKEY_UNCONFIRMED",
    });
  });
});

describe("khoá riêng không lộ ra", () => {
  it("không có trong phản hồi, audit hay thông báo", async () => {
    const keys = await storedPrivateKeys();
    expect(keys.length).toBeGreaterThan(0);
    // Dòng giữa của khoá OpenSSH là phần bí mật; tìm cả khoá đầy đủ.
    const needles = keys.flatMap((k) => [k, ...k.split("\n").filter((l) => l.length > 40 && !l.startsWith("-----"))]);
    const { rows: audits } = await admin.query("select data from hive.audit_log where org_id = $1", [org.orgId]);
    const { rows: notes } = await admin.query("select title, body from hive.inbox_items where org_id = $1", [
      org.orgId,
    ]);
    const text = JSON.stringify([seen, audits, notes]);
    expect(text).not.toContain("PRIVATE KEY");
    for (const n of needles) expect(text).not.toContain(n);
  });
});
