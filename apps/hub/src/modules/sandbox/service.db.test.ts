import { randomBytes, randomUUID } from "node:crypto";
import { SUGGESTED_EGRESS_RULES } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import {
  addAllowlist,
  getEffectiveAllowlist,
  getImage,
  getOrgSettings,
  listAllowlist,
  loadSandboxJobConfig,
  removeAllowlist,
  setImage,
  updateOrgSettings,
} from "./service.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const tag = randomUUID().slice(0, 8);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
type Org = OrgFixture & { user: (n: string) => string };
let org: Org;
let other: Org;
let projectId: string;
let siblingId: string;
let foreignId: string;
const as = <T>(who: string, fn: (tx: Tx) => Promise<T>, tenant = org) =>
  withTenant(app, { orgId: tenant.orgId, userId: tenant.user(who) }, fn);
const add = (who: string, rule: string, project?: string) =>
  as(who, (tx) => addAllowlist(tx, org.user(who), { rule, projectId: project }));
const effective = () => as("tviewer", (tx) => getEffectiveAllowlist(tx, org.user("tviewer"), projectId));
const settings = (locked: boolean, useSuggestedDefaults = false) =>
  as("admin", (tx) => updateOrgSettings(tx, org.user("admin"), { locked, useSuggestedDefaults }));
const image = { baseImage: `registry.internal/hive@sha256:${"b".repeat(64)}`, setupScriptHash: "a".repeat(64) };

beforeAll(async () => {
  org = await seedOrg(admin, `sandbox-${tag}`);
  other = await seedOrg(admin, `sandbox-other-${tag}`);
  const seed = async (tenant: Org, key: string) =>
    (
      await seedProject(admin, app, {
        orgId: tenant.orgId,
        teamId: tenant.teamId,
        systemId: tenant.systemId,
        adminUserId: tenant.user("admin"),
        masterKey,
        key,
      })
    ).projectId;
  projectId = await seed(org, `sb-${tag}`);
  siblingId = await seed(org, `sb-sibling-${tag}`);
  foreignId = await seed(other, `sb-other-${tag}`);
});
beforeEach(async () => {
  await admin.query("delete from hive.egress_allowlists where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.sandbox_org_settings where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.env_images where org_id = $1", [org.orgId]);
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("effective sandbox policy", () => {
  it("denies all by default and offers suggestions without enabling them", async () => {
    expect(await effective()).toEqual({
      locked: false,
      useSuggestedDefaults: false,
      rules: [],
      suggestedRules: [...SUGGESTED_EGRESS_RULES],
    });
    expect(await as("tmember", (tx) => getOrgSettings(tx, org.user("tmember")))).toEqual({
      locked: false,
      useSuggestedDefaults: false,
    });
  });
  it("unions opted-in defaults, organization and project rules, deduplicating normalized rules", async () => {
    await settings(false, true);
    await add("admin", "Registry.Internal.:00443");
    await add("tadmin", "registry.internal:443", projectId);
    await add("tadmin", "*.packages.internal:443", projectId);
    await add("tadmin", "10.0.0.0/8:8080", siblingId);
    expect((await effective()).rules).toEqual([
      ...SUGGESTED_EGRESS_RULES,
      "registry.internal:443",
      "*.packages.internal:443",
    ]);
    expect(
      (await as("tviewer", (tx) => listAllowlist(tx, org.user("tviewer"), projectId))).map((r) => r.projectId),
    ).toEqual([projectId, projectId]);
  });
  it("lock excludes existing project rules, blocks widening, and still permits cleanup", async () => {
    const entry = await add("tadmin", "packages.internal:443", projectId);
    await add("owner", "api.internal:443");
    await settings(true, true);
    expect((await effective()).rules).toEqual([...SUGGESTED_EGRESS_RULES, "api.internal:443"]);
    expect(await errorCode(() => add("tadmin", "new.internal:443", projectId))).toBe("ALLOWLIST_LOCKED");
    expect(await errorCode(() => add("owner", "new.internal:443", projectId))).toBe("ALLOWLIST_LOCKED");
    await as("tadmin", (tx) => removeAllowlist(tx, org.user("tadmin"), { projectId, entryId: entry.id }));
    await add("admin", "new.internal:443");
    await settings(false);
    expect((await effective()).rules).toEqual(["api.internal:443", "new.internal:443"]);
  });
  it("unlock restores retained project rules", async () => {
    await add("tadmin", "packages.internal", projectId);
    await settings(true);
    expect((await effective()).rules).toEqual([]);
    await settings(false);
    expect((await effective()).rules).toEqual(["packages.internal"]);
  });
  it("returns image and immutable policy snapshot for dispatch", async () => {
    expect(await as("owner", (tx) => getImage(tx, org.user("owner"), projectId))).toBeNull();
    expect(await errorCode(() => as("owner", (tx) => loadSandboxJobConfig(tx, projectId)))).toBe(
      "SANDBOX_IMAGE_REQUIRED",
    );
    await as("tadmin", (tx) => setImage(tx, org.user("tadmin"), { projectId, ...image }));
    await add("admin", "api.internal:443");
    const snapshot = await as("owner", (tx) => loadSandboxJobConfig(tx, projectId));
    await as("tadmin", (tx) =>
      setImage(tx, org.user("tadmin"), { projectId, ...image, setupScriptHash: "c".repeat(64) }),
    );
    expect(snapshot).toEqual({ allowlist: ["api.internal:443"], image });
    expect((await as("owner", (tx) => getImage(tx, org.user("owner"), projectId)))?.setupScriptHash).toBe(
      "c".repeat(64),
    );
  });
});

describe("sandbox permissions and audit", () => {
  it.each(["tadmin", "tmember", "tviewer", "oadmin", "loner"])("%s cannot change organization policy", async (who) => {
    expect(await errorCode(() => add(who, "api.internal"))).toBe("ORG_ROLE_REQUIRED");
    expect(
      await errorCode(() =>
        as(who, (tx) => updateOrgSettings(tx, org.user(who), { locked: true, useSuggestedDefaults: true })),
      ),
    ).toBe("ORG_ROLE_REQUIRED");
  });
  it.each([
    ["tmember", "TEAM_ROLE_REQUIRED"],
    ["tviewer", "TEAM_ROLE_REQUIRED"],
    ["oadmin", "PROJECT_NOT_FOUND"],
    ["loner", "PROJECT_NOT_FOUND"],
  ])("%s cannot manage project policy", async (who, code) => {
    expect(await errorCode(() => add(who, "api.internal", projectId))).toBe(code);
    expect(await errorCode(() => as(who, (tx) => setImage(tx, org.user(who), { projectId, ...image })))).toBe(code);
  });
  it("cannot delete an entry by claiming a different scope", async () => {
    const entry = await add("admin", "api.internal");
    expect(
      await errorCode(() =>
        as("tadmin", (tx) => removeAllowlist(tx, org.user("tadmin"), { projectId, entryId: entry.id })),
      ),
    ).toBe("ALLOWLIST_ENTRY_NOT_FOUND");
    expect(
      await errorCode(() => as("tadmin", (tx) => removeAllowlist(tx, org.user("tadmin"), { entryId: entry.id }))),
    ).toBe("ORG_ROLE_REQUIRED");
    const pEntry = await add("tadmin", "pkg.internal", projectId);
    expect(
      await errorCode(() =>
        as("tadmin", (tx) => removeAllowlist(tx, org.user("tadmin"), { projectId: siblingId, entryId: pEntry.id })),
      ),
    ).toBe("ALLOWLIST_ENTRY_NOT_FOUND");
  });
  it("conceals projects outside the team or tenant", async () => {
    expect(await errorCode(() => as("oadmin", (tx) => getEffectiveAllowlist(tx, org.user("oadmin"), projectId)))).toBe(
      "PROJECT_NOT_FOUND",
    );
    expect(await errorCode(() => as("owner", (tx) => getEffectiveAllowlist(tx, org.user("owner"), foreignId)))).toBe(
      "PROJECT_NOT_FOUND",
    );
    expect(await errorCode(() => as("owner", (tx) => getImage(tx, other.user("owner"), projectId), other))).toBe(
      "PROJECT_NOT_FOUND",
    );
  });
  it("audits successful changes and rolls back entry and audit together", async () => {
    const entry = await as("tadmin", (tx) =>
      addAllowlist(tx, org.user("tadmin"), { projectId, rule: "API.Internal.:443", note: "Registry của đội" }),
    );
    await as("tadmin", (tx) => removeAllowlist(tx, org.user("tadmin"), { projectId, entryId: entry.id }));
    const rows = (
      await admin.query("select actor_user_id, action, data from hive.audit_log where target_id = $1 order by action", [
        entry.id,
      ])
    ).rows;
    expect(rows.map((r) => r.action)).toEqual(["sandbox.allowlist.add", "sandbox.allowlist.remove"]);
    expect(rows.every((r) => r.actor_user_id === org.user("tadmin"))).toBe(true);
    expect(rows[0].data).toMatchObject({
      projectId,
      rule: "api.internal:443",
      note: "Registry của đội",
      addedBy: org.user("tadmin"),
    });
    await expect(
      as("admin", async (tx) => {
        await addAllowlist(tx, org.user("admin"), { rule: "rollback.internal" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(
      (
        await admin.query("select id from hive.audit_log where org_id = $1 and data->>'rule' = 'rollback.internal'", [
          org.orgId,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(await as("owner", (tx) => listAllowlist(tx, org.user("owner")))).toEqual([]);
  });
});

it("serializes locking and concurrent project widening even without a settings row", async () => {
  let release!: () => void;
  let written!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const locked = new Promise<void>((r) => {
    written = r;
  });
  const first = as("admin", async (tx) => {
    await updateOrgSettings(tx, org.user("admin"), { locked: true, useSuggestedDefaults: false });
    written();
    await hold;
  });
  await locked;
  const second = errorCode(() => add("tadmin", "new.internal", projectId));
  try {
    release();
    await first;
    expect(await second).toBe("ALLOWLIST_LOCKED");
  } finally {
    release();
  }
});
