import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../../test/org-fixture.ts";
import { auditByData } from "../../audit/index.ts";
import { createPool, encryptSecret, parseMasterKey, type Tx, withTenant } from "../../platform/index.ts";
import { infraAuth, infraTokenContext, jenkinsAuth, jenkinsTokenContext, SECRET_USED_ACTION } from "./credentials.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
let orgId: string;
let owner: string;
let member: string;
let watcherConn: string;
let noWatcherConn: string;
let infraConn: string;
let ownerTokenId: string;

const asUser = <T>(userId: string | undefined, run: (tx: Tx) => Promise<T>) => withTenant(app, { orgId, userId }, run);
const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return { name: (error as Error).name, code: (error as { code?: string }).code };
  }
  return undefined;
};
const secretUses = (group: string) =>
  asUser(owner, (tx) => auditByData(tx, { actionLike: SECRET_USED_ACTION, key: "group", value: group, limit: 10 }));

beforeAll(async () => {
  const org = await seedOrg(admin, `delivery-cred-${randomUUID().slice(0, 8)}`);
  orgId = org.orgId;
  owner = org.user("owner");
  member = org.user("tmember");
  watcherConn = randomUUID();
  noWatcherConn = randomUUID();
  infraConn = randomUUID();
  ownerTokenId = randomUUID();
  await asUser(owner, async (tx) => {
    for (const [id, name, watcher] of [
      [watcherConn, "ci", owner],
      [noWatcherConn, "ci-cu", null],
    ] as const)
      await tx.execute(
        sql`insert into hive.ci_jenkins_connections (id, org_id, name, url, watcher_user_id, created_by)
            values (${id}, ${orgId}, ${name}, 'https://jenkins.example.invalid', ${watcher}, ${owner})`,
      );
    await tx.execute(
      sql`insert into hive.ci_jenkins_user_tokens (id, org_id, connection_id, user_id, jenkins_user, token_enc)
          values (${ownerTokenId}, ${orgId}, ${watcherConn}, ${owner}, 'chu-du-an',
            ${encryptSecret(masterKey, "jenkins-token-cua-chu", jenkinsTokenContext(ownerTokenId))})`,
    );
    await tx.execute(
      sql`insert into hive.deploy_connections (id, org_id, kind, name, url, token_enc, created_by)
          values (${infraConn}, ${orgId}, 'argocd', 'argo', 'https://argocd.example.invalid',
            ${encryptSecret(masterKey, "argo-token", infraTokenContext(infraConn))}, ${owner})`,
    );
  });
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("jenkinsAuth", () => {
  it("trả token của chính người bấm và ghi audit dùng secret", async () => {
    const group = `deploy:${randomUUID()}`;
    const auth = await asUser(owner, (tx) =>
      jenkinsAuth(tx, masterKey, { connectionId: watcherConn, userId: owner, reason: "ci.retry", group }),
    );
    expect(auth).toEqual({
      connectionId: watcherConn,
      baseUrl: "https://jenkins.example.invalid",
      user: "chu-du-an",
      token: "jenkins-token-cua-chu",
      userId: owner,
    });
    const uses = await secretUses(group);
    expect(uses.map((u) => u.data)).toEqual([{ kind: "jenkins_token", id: ownerTokenId, reason: "ci.retry", group }]);
    expect(JSON.stringify(uses)).not.toContain("jenkins-token-cua-chu");
  });

  it("người chưa có token thì JENKINS_NO_TOKEN, không mượn token người khác", async () => {
    expect(
      await failure(() =>
        asUser(member, (tx) => jenkinsAuth(tx, masterKey, { connectionId: watcherConn, userId: member, reason: "x" })),
      ),
    ).toEqual({ name: "ForbiddenError", code: "JENKINS_NO_TOKEN" });
  });

  it("watcher dùng token của người theo dõi; kết nối không có người theo dõi thì JENKINS_NO_TOKEN", async () => {
    const auth = await asUser(undefined, (tx) =>
      jenkinsAuth(tx, masterKey, { connectionId: watcherConn, userId: "watcher", reason: "ci.poll" }),
    );
    expect(auth.userId).toBe(owner);
    expect(auth.token).toBe("jenkins-token-cua-chu");
    expect(
      await failure(() =>
        asUser(undefined, (tx) =>
          jenkinsAuth(tx, masterKey, { connectionId: noWatcherConn, userId: "watcher", reason: "ci.poll" }),
        ),
      ),
    ).toEqual({ name: "ForbiddenError", code: "JENKINS_NO_TOKEN" });
  });

  it("kết nối không có hoặc của tổ chức khác thì NOT_FOUND", async () => {
    const other = await seedOrg(admin, `delivery-cred-o-${randomUUID().slice(0, 8)}`);
    expect(
      await failure(() =>
        withTenant(app, { orgId: other.orgId, userId: other.user("owner") }, (tx) =>
          jenkinsAuth(tx, masterKey, { connectionId: watcherConn, userId: owner, reason: "x" }),
        ),
      ),
    ).toEqual({ name: "NotFoundError", code: "NOT_FOUND" });
  });

  it("cùng nhóm chỉ ghi một dòng audit cho mỗi secret; không nhóm thì mỗi lần một dòng", async () => {
    const group = `deploy:${randomUUID()}`;
    for (let i = 0; i < 3; i++)
      await asUser(owner, (tx) =>
        jenkinsAuth(tx, masterKey, { connectionId: watcherConn, userId: owner, reason: "deploy.watch", group }),
      );
    expect(await secretUses(group)).toHaveLength(1);
    const count = () =>
      asUser(owner, async (tx) =>
        Number(
          (
            await tx.execute<{ n: string }>(
              sql`select count(*) as n from hive.audit_log where action = ${SECRET_USED_ACTION} and data->>'reason' = 'ci.rebuild'`,
            )
          ).rows[0]?.n,
        ),
      );
    for (let i = 0; i < 2; i++)
      await asUser(owner, (tx) =>
        jenkinsAuth(tx, masterKey, { connectionId: watcherConn, userId: owner, reason: "ci.rebuild" }),
      );
    expect(await count()).toBe(2);
  });
});

describe("infraAuth", () => {
  it("giải mã token kết nối Argo CD và ghi audit", async () => {
    const group = `deploy:${randomUUID()}`;
    const auth = await asUser(owner, (tx) => infraAuth(tx, masterKey, infraConn, { reason: "deploy.start", group }));
    expect(auth).toEqual({
      connectionId: infraConn,
      kind: "argocd",
      url: "https://argocd.example.invalid",
      caPem: null,
      token: "argo-token",
    });
    expect((await secretUses(group)).map((u) => u.data)).toEqual([
      { kind: "infra_token", id: infraConn, reason: "deploy.start", group },
    ]);
    expect(await failure(() => asUser(owner, (tx) => infraAuth(tx, masterKey, randomUUID(), { reason: "x" })))).toEqual(
      { name: "NotFoundError", code: "NOT_FOUND" },
    );
  });
});
