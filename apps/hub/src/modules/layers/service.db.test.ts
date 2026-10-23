import { randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_AGENT_POLICY, defaultProjectSettings, type ProjectSettingsPatch } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { loadProject, updateProjectSettings } from "../catalog/index.ts";
import { loadPolicy, saveAgentPolicy } from "../governance/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import {
  assertSettingsUnlocked,
  effectiveConfig,
  orgEntries,
  resolveProjectSettings,
  runSettingsOf,
  setOrgEntry,
  setProjectEntry,
  syncPolicyEntries,
} from "./service.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const tag = randomUUID().slice(0, 6);
let org: Awaited<ReturnType<typeof seedOrg>>;
let projectId: string;
const as = <T>(who: string, fn: (tx: Tx, userId: string) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, (tx) => fn(tx, org.user(who)));
const orgSet = (key: string, value: unknown, locked = false) =>
  as("owner", (tx, u) => setOrgEntry(tx, u, { key, value, locked }));
const projectSet = (key: string, value: unknown) =>
  as("tadmin", (tx, u) => setProjectEntry(tx, u, { projectId, key, value }));
const effective = () => as("tmember", (tx, u) => effectiveConfig(tx, u, projectId));

beforeAll(async () => {
  org = await seedOrg(admin, `cfg-${tag}`);
  projectId = (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey: parseMasterKey(randomBytes(32).toString("base64")),
      key: `cfg-${tag}`,
    })
  ).projectId;
});
beforeEach(async () => {
  await admin.query("delete from hive.config_layer_entries where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.agent_policies where org_id = $1", [org.orgId]);
  await admin.query("update hive.projects set settings = $1 where id = $2", [defaultProjectSettings(1), projectId]);
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("cấu hình tổ chức và dự án", () => {
  it("checks permissions, values, unknown keys and project visibility", async () => {
    expect(
      await errorCode(() => as("tadmin", (tx, u) => setOrgEntry(tx, u, { key: "merge.mode", value: "auto" }))),
    ).toBe("ORG_ROLE_REQUIRED");
    expect(await errorCode(() => orgSet("unknown", 1))).toBe("CONFIG_UNKNOWN_KEY");
    expect(await errorCode(() => orgSet("merge.mode", "bad"))).toBe("CONFIG_VALUE_INVALID");
    expect(await errorCode(() => as("oadmin", (tx, u) => effectiveConfig(tx, u, projectId)))).toBe("PROJECT_NOT_FOUND");
    expect(
      await errorCode(() =>
        as("tviewer", (tx, u) => setProjectEntry(tx, u, { projectId, key: "merge.mode", value: "auto" })),
      ),
    ).toBe("TEAM_ROLE_REQUIRED");
  });
  it("inherits, overrides, suspends and restores an existing project value", async () => {
    await orgSet("merge.mode", "review");
    await projectSet("merge.mode", "auto");
    await orgSet("merge.mode", "review", true);
    expect((await effective()).settings.find((s) => s.key === "merge.mode")).toMatchObject({
      value: "review",
      locked: true,
    });
    expect(await errorCode(() => projectSet("merge.mode", null))).toBe("CONFIG_LOCKED");
    await orgSet("merge.mode", "review", false);
    expect((await effective()).settings.find((s) => s.key === "merge.mode")?.value).toBe("auto");
    await projectSet("merge.mode", null);
    expect((await effective()).settings.find((s) => s.key === "merge.mode")).toMatchObject({
      value: "review",
      source: { layer: "org" },
    });
  });
  it("blocks legacy settings writes to locked keys and permits unrelated patches", async () => {
    await orgSet("merge.mode", "review", true);
    const patch = (settings: Parameters<typeof updateProjectSettings>[3]) =>
      as("tadmin", (tx, u) => updateProjectSettings(tx, u, `cfg-${tag}`, settings, assertSettingsUnlocked));
    expect(await errorCode(() => patch({ merge: { mode: "auto" } }))).toBe("CONFIG_LOCKED");
    await patch({ merge: { requireCi: true } });
    expect((await effective()).settings.find((s) => s.key === "merge.requireCi")?.value).toBe(true);
  });
  it.each([
    { key: "agent.permissionMode", value: "workspace", patch: { runPermissions: { mode: "full" } } },
    { key: "limits.perRunUsd", value: 20, patch: { budget: { perRunUsd: 50 } } },
    { key: "merge.requireCi", value: true, patch: { merge: { requireCi: false } } },
  ] satisfies { key: string; value: unknown; patch: ProjectSettingsPatch }[])(
    "enforces the organization lock for legacy $key writes",
    async ({ key, value, patch }) => {
      await orgSet(key, value, true);
      expect(
        await errorCode(() =>
          as("tadmin", (tx, u) => updateProjectSettings(tx, u, `cfg-${tag}`, patch, assertSettingsUnlocked)),
        ),
      ).toBe("CONFIG_LOCKED");
    },
  );
  it("does not let inheritance metadata conceal a write to a locked raw value", async () => {
    await projectSet("merge.mode", null);
    await orgSet("merge.mode", "review", true);
    expect(
      await errorCode(() =>
        as("tadmin", (tx, u) =>
          updateProjectSettings(
            tx,
            u,
            `cfg-${tag}`,
            {
              merge: { mode: "auto" },
              inheritedConfigKeys: ["merge.mode"],
            },
            assertSettingsUnlocked,
          ),
        ),
      ),
    ).toBe("CONFIG_LOCKED");
  });
  it("uses project budgets without ceiling and applies an organization lock at read time", async () => {
    await orgSet("limits.perRunUsd", 20);
    await projectSet("limits.perRunUsd", 50);
    const run = () =>
      as("tmember", async (tx) =>
        runSettingsOf(tx, (await loadProject(tx, projectId)) as NonNullable<Awaited<ReturnType<typeof loadProject>>>),
      );
    expect((await run()).resolveBudget({ perRunUsd: 50 })).toEqual({ perRunUsd: 50 });
    await orgSet("limits.perRunUsd", 20, true);
    expect((await run()).resolveBudget({ perRunUsd: 50 })).toEqual({ perRunUsd: 20 });
  });
  it("inherits merge settings and restores an overridden CLI permission after unlocking", async () => {
    await projectSet("merge.mode", null);
    await orgSet("merge.mode", "auto");
    await orgSet("merge.requireCi", true, true);
    const settings = await as("tmember", async (tx) => {
      const project = await loadProject(tx, projectId);
      if (!project) throw new Error("Không tìm thấy dự án thử nghiệm.");
      return resolveProjectSettings(tx, project);
    });
    expect(settings.merge).toMatchObject({ mode: "auto", requireCi: true });
    await projectSet("agent.permissionMode", "full");
    await orgSet("agent.permissionMode", "workspace", true);
    expect((await effective()).settings.find((s) => s.key === "agent.permissionMode")).toMatchObject({
      value: "workspace",
      locked: true,
      chain: [expect.anything(), expect.objectContaining({ value: "full", applied: false })],
    });
    await as("owner", (tx, u) => setOrgEntry(tx, u, { key: "agent.permissionMode", locked: false }));
    expect((await effective()).settings.find((s) => s.key === "agent.permissionMode")?.value).toBe("full");
  });
  it("serializes legacy policy reads with configuration writes", async () => {
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = as("owner", async (tx, u) => {
      await setOrgEntry(tx, u, { key: "limits.perRunUsd", value: 20 });
      entered();
      await gate;
    });
    await ready;
    let started!: () => void;
    const starting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const second = as("owner", async (tx, u) => {
      started();
      return saveAgentPolicy(tx, u, DEFAULT_AGENT_POLICY, async (tx, u, before, next) => {
        expect(before.limits.perRunUsd).toBe(20);
        await syncPolicyEntries(tx, u, before, next);
      });
    });
    try {
      await starting;
      // Hàng đợi khoá chứng minh writer thứ hai đã tới điểm tranh chấp, không dựa vào sleep.
      await expect
        .poll(async () => {
          const { rows } = await admin.query(
            "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted",
          );
          return rows[0].n;
        })
        .toBeGreaterThan(0);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect((await as("owner", (tx) => orgEntries(tx))).find((e) => e.key === "limits.perRunUsd")?.value).toBeNull();
  });
  it("keeps mapped policy values in sync and invalidates stale configuration forms", async () => {
    const saved = await orgSet("limits.perRunUsd", 20, true);
    await as("owner", async (tx, u) =>
      saveAgentPolicy(
        tx,
        u,
        { ...(await loadPolicy(tx)), limits: { ...DEFAULT_AGENT_POLICY.limits, perRunUsd: 7 } },
        syncPolicyEntries,
      ),
    );
    const entry = (await as("owner", (tx) => orgEntries(tx))).find((e) => e.key === "limits.perRunUsd");
    expect(entry).toMatchObject({ value: 7, locked: true });
    expect(
      await errorCode(() =>
        as("owner", (tx, u) =>
          setOrgEntry(tx, u, { key: "limits.perRunUsd", value: 8, expectedVersion: saved?.version }),
        ),
      ),
    ).toBe("CONFIG_VERSION_CONFLICT");
  });
  it("requires dangerous permission for full CLI defaults and records audit", async () => {
    expect(
      await errorCode(() => as("admin", (tx, u) => setOrgEntry(tx, u, { key: "agent.permissionMode", value: "full" }))),
    ).toBe("POLICY_FULLACCESS_REQUIRED");
    await orgSet("merge.requireCi", true, true);
    const { rows } = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'config.org.set'",
      [org.orgId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
