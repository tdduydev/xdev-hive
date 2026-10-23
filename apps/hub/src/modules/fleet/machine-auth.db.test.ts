import { generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";
import { machineTokenMessage } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPool, withTenant } from "../platform/index.ts";
import { FleetError } from "./errors.ts";
import { createMachineAuth } from "./machine-auth.ts";
import { authenticateMachine, revokeMachine } from "./machines.ts";
import { createRegistration, registerMachine } from "./registration.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const publicUrl = "https://hub.test";
const auth = createMachineAuth({ pool: app, authSecret: "s".repeat(32), publicUrl });

const orgA = randomUUID();
let teamA = "";
const tag = randomUUID().slice(0, 8);
const adminUser = `admin-${tag}`;

beforeAll(async () => {
  await admin.query(`insert into auth."user" (id, name, email) values ($1, $1, $1 || '@seed.test')`, [adminUser]);
  await admin.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, 'A', $3)", [
    orgA,
    `mauth-${tag}`,
    adminUser,
  ]);
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
    orgA,
    adminUser,
  ]);
  teamA = (
    await admin.query("insert into hive.teams (org_id, slug, name) values ($1, 'ta', 'ta') returning id", [orgA])
  ).rows[0].id as string;
  await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'admin')", [
    teamA,
    orgA,
    adminUser,
  ]);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const keyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ format: "jwk" }).x as string, privateKey };
};

async function register(publicKey?: string, name = `m-${randomUUID().slice(0, 8)}`) {
  const { token } = await withTenant(app, { userId: adminUser, orgId: orgA }, (tx) =>
    createRegistration(tx, adminUser, teamA),
  );
  return registerMachine(app, {
    registrationToken: token,
    machineId: name,
    os: "linux",
    version: "0.1.0",
    clis: ["claude"],
    capacity: 1,
    ...(publicKey ? { publicKey, keyStorage: "file" as const } : {}),
  });
}

async function exchange(machineId: string, privateKey: KeyObject) {
  const { nonce } = auth.challenge(machineId);
  const signature = sign(null, Buffer.from(machineTokenMessage(publicUrl, machineId, nonce)), privateKey).toString(
    "base64url",
  );
  return auth.exchange({ machineId, nonce, signature });
}

async function fleetCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    if (error instanceof FleetError) return error.code;
    throw error;
  }
}

describe("đăng ký kèm khoá", () => {
  it("lưu khoá, machine token trả về không còn dùng được, đổi chữ ký lấy được access token", async () => {
    const { publicKey, privateKey } = keyPair();
    const machine = await register(publicKey);
    const row = await admin.query("select public_key, key_storage, public_key_at from hive.machines where id = $1", [
      machine.id,
    ]);
    expect(row.rows[0]).toMatchObject({ public_key: publicKey, key_storage: "file" });
    expect(row.rows[0].public_key_at).toBeInstanceOf(Date);
    expect(await authenticateMachine(app, machine.machineToken)).toBeNull();

    const { accessToken, expiresAt } = await exchange(machine.id, privateKey);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    const session = await auth.authenticate(accessToken);
    expect(session?.machine).toMatchObject({ id: machine.id, orgId: orgA, teamId: teamA });
    expect(session?.exp?.toISOString()).toBe(expiresAt);
  });

  it("chữ ký bằng khoá khác, nonce dùng lại hay máy không có thật đều là MACHINE_AUTH_FAILED", async () => {
    const { publicKey, privateKey } = keyPair();
    const machine = await register(publicKey);
    expect(await fleetCode(() => exchange(machine.id, keyPair().privateKey))).toBe("MACHINE_AUTH_FAILED");

    const { nonce } = auth.challenge(machine.id);
    const signature = sign(null, Buffer.from(machineTokenMessage(publicUrl, machine.id, nonce)), privateKey).toString(
      "base64url",
    );
    await auth.exchange({ machineId: machine.id, nonce, signature });
    expect(await fleetCode(() => auth.exchange({ machineId: machine.id, nonce, signature }))).toBe(
      "MACHINE_AUTH_FAILED",
    );
    expect(await fleetCode(() => exchange(randomUUID(), privateKey))).toBe("MACHINE_AUTH_FAILED");
  });

  it("thu hồi máy chặn cả lần đổi kế tiếp lẫn access token đang còn hạn", async () => {
    const { publicKey, privateKey } = keyPair();
    const machine = await register(publicKey);
    const { accessToken } = await exchange(machine.id, privateKey);
    await withTenant(app, { userId: adminUser, orgId: orgA }, (tx) => revokeMachine(tx, adminUser, machine.id));
    expect(await auth.authenticate(accessToken)).toBeNull();
    expect(await fleetCode(() => exchange(machine.id, privateKey))).toBe("MACHINE_AUTH_FAILED");
  });

  it("cài lại máy với khoá mới thì access token của bản cài cũ hết dùng", async () => {
    const old = keyPair();
    const machine = await register(old.publicKey);
    const { accessToken } = await exchange(machine.id, old.privateKey);
    const fresh = keyPair();
    const again = await register(fresh.publicKey, machine.machineId);
    expect(again.id).toBe(machine.id);
    expect(await auth.authenticate(accessToken)).toBeNull();
    expect(await fleetCode(() => exchange(machine.id, old.privateKey))).toBe("MACHINE_AUTH_FAILED");
    expect(await auth.authenticate((await exchange(machine.id, fresh.privateKey)).accessToken)).not.toBeNull();
  });
});

describe("máy cũ gửi khoá bằng machine token", () => {
  it("lần đầu lưu khoá và ghi audit, machine token hết dùng được nên không gửi khoá lần hai được", async () => {
    const machine = await register();
    expect((await auth.authenticate(machine.machineToken))?.exp).toBeUndefined();
    // Chưa có khoá thì không đổi được access token.
    expect(await fleetCode(() => exchange(machine.id, keyPair().privateKey))).toBe("MACHINE_AUTH_FAILED");

    const { publicKey, privateKey } = keyPair();
    const out = await auth.registerKey(machine.machineToken, { publicKey, keyStorage: "keychain" });
    expect(out.machineId).toBe(machine.id);
    expect(await authenticateMachine(app, machine.machineToken)).toBeNull();
    const audit = await admin.query(
      "select data from hive.audit_log where action = 'machine.key_register' and target_id = $1",
      [machine.id],
    );
    expect(audit.rows[0]?.data).toEqual({ keyStorage: "keychain" });
    expect(await exchange(machine.id, privateKey)).toHaveProperty("accessToken");

    // Token đã bị thay nên lần gửi khoá thứ hai không xác thực được, kẻ lấy được token cũ không thay được khoá.
    expect(
      await fleetCode(() =>
        auth.registerKey(machine.machineToken, { publicKey: keyPair().publicKey, keyStorage: "file" }),
      ),
    ).toBe("MACHINE_TOKEN_INVALID");
  });
});
