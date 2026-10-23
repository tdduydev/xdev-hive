import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { loadPolicy, saveAgentPolicy } from "../governance/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { effectiveConfig, setOrgLock, setTeamEntry, teamEntries } from "./service.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
let org: Awaited<ReturnType<typeof seedOrg>>;
let projectId: string;

const as = <T>(who: string, fn: (tx: Tx, userId: string) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, (tx) => fn(tx, org.user(who)));
const setLimit = (who: string, value: unknown, extra: object = {}) =>
  as(who, (tx, u) => setTeamEntry(tx, u, { teamId: org.teamId, key: "limits.perRunUsd", value, ...extra }));
const setKey = (who: string, key: string, value: unknown) =>
  as(who, (tx, u) => setTeamEntry(tx, u, { teamId: org.teamId, key, value }));
const effective = async (who = "tmember") =>
  new Map((await as(who, (tx, u) => effectiveConfig(tx, u, projectId))).settings.map((s) => [s.key, s]));

/** Đổi chính sách công ty bằng đường ghi thật, giữ nguyên phần còn lại. */
const patchPolicy = (patch: (p: Awaited<ReturnType<typeof loadPolicy>>) => object) =>
  as("admin", async (tx, u) => saveAgentPolicy(tx, u, patch(await loadPolicy(tx)) as never));

beforeAll(async () => {
  org = await seedOrg(admin, `cfg-${tag}`);
  projectId = (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: `cfg-${tag}`,
    })
  ).projectId;
});
beforeEach(async () => {
  await admin.query("delete from hive.config_layer_entries where org_id = $1", [org.orgId]);
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("effective config", () => {
  it("returns a stable configVersion for the same inputs", async () => {
    const a = await as("tmember", (tx, u) => effectiveConfig(tx, u, projectId));
    const b = await as("tmember", (tx, u) => effectiveConfig(tx, u, projectId));
    expect(a.orgId).toBe(org.orgId);
    expect(a.configVersion).toBe(b.configVersion);
  });

  it("is hidden from a user outside the team", async () => {
    expect(await errorCode(() => as("oadmin", (tx, u) => effectiveConfig(tx, u, projectId)))).toBe("PROJECT_NOT_FOUND");
  });

  it("shows the chain to members but not to viewers", async () => {
    expect((await effective("tmember")).get("limits.perRunUsd")?.chain).toBeDefined();
    expect((await effective("tviewer")).get("limits.perRunUsd")?.chain).toBeUndefined();
  });
});

describe("team layer", () => {
  it("lets a team admin lower the org ceiling but not exceed it", async () => {
    await patchPolicy((p) => ({ ...p, limits: { ...p.limits, perRunUsd: 20 } }));
    await setLimit("tadmin", 5);
    expect((await effective()).get("limits.perRunUsd")).toMatchObject({ value: 5, source: { layer: "team" } });
    expect(await errorCode(() => setLimit("tadmin", 50))).toBe("CONFIG_ABOVE_CEILING");
  });

  it("rejects members, unknown keys, bad values and stale versions", async () => {
    expect(await errorCode(() => setLimit("tmember", 5))).toBe("TEAM_ROLE_REQUIRED");
    expect(await errorCode(() => setKey("tadmin", "nope", 1))).toBe("CONFIG_UNKNOWN_KEY");
    expect(await errorCode(() => setLimit("tadmin", -1))).toBe("CONFIG_VALUE_INVALID");
    await setLimit("tadmin", 5);
    expect(await errorCode(() => setLimit("tadmin", 4, { expectedVersion: 7 }))).toBe("CONFIG_VERSION_CONFLICT");
    expect((await setLimit("tadmin", 4, { expectedVersion: 1 }))?.version).toBe(2);
  });

  it("lets org owner and admin write for any team", async () => {
    expect(await setLimit("owner", 3)).toMatchObject({ value: 3 });
    expect(await setLimit("admin", 2)).toMatchObject({ value: 2 });
    expect(await errorCode(() => setLimit("oadmin", 1))).toBe("NOT_TEAM_MEMBER");
  });

  it("lets team viewers read entries but not write", async () => {
    await setLimit("tadmin", 5);
    expect(await as("tviewer", (tx, u) => teamEntries(tx, u, org.teamId))).toHaveLength(1);
    expect(await errorCode(() => setLimit("tviewer", 4))).toBe("TEAM_ROLE_REQUIRED");
  });

  it("removes the entry when the value is cleared, and audits both writes", async () => {
    await setLimit("tadmin", 5);
    await setLimit("tadmin", null);
    expect(await as("tadmin", (tx, u) => teamEntries(tx, u, org.teamId))).toEqual([]);
    const { rows } = await admin.query(
      "select count(*)::int as n from hive.audit_log where org_id = $1 and action = 'config.team.set'",
      [org.orgId],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it("needs policies.fullaccess to loosen a dangerous setting", async () => {
    await setKey("tadmin", "agent.allowFullPermission", false);
    expect(await errorCode(() => setKey("tadmin", "agent.allowFullPermission", true))).toBe(
      "CONFIG_FULLACCESS_REQUIRED",
    );
  });
});

describe("org lock", () => {
  it("blocks the team from changing a locked override and needs an org admin", async () => {
    expect(await errorCode(() => as("tadmin", (tx, u) => setOrgLock(tx, u, "merge.mode", true)))).toBe(
      "ORG_ROLE_REQUIRED",
    );
    await as("admin", (tx, u) => setOrgLock(tx, u, "merge.mode", true));
    expect(await errorCode(() => setKey("tadmin", "merge.mode", "auto"))).toBe("CONFIG_LOCKED");
    expect((await effective()).get("merge.mode")?.lock).toEqual({ layer: "org" });
    await as("admin", (tx, u) => setOrgLock(tx, u, "merge.mode", false));
    expect((await effective()).get("merge.mode")?.lock).toBeNull();
  });

  it("refuses to lock a ceiling", async () => {
    expect(await errorCode(() => as("admin", (tx, u) => setOrgLock(tx, u, "limits.perRunUsd", true)))).toBe(
      "CONFIG_LAYER_NOT_ALLOWED",
    );
  });
});
