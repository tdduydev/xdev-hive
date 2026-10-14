import { randomBytes, randomUUID } from "node:crypto";
import { type ArtifactScope, DEFAULT_AGENT_POLICY } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { type Reader, readerFor } from "./access.ts";
import {
  createArtifact,
  deleteArtifact,
  duplicateArtifact,
  getArtifact,
  listArtifacts,
  listLinks,
  renameArtifact,
  restoreArtifact,
  restoreVersion,
  setScope,
  transferOwner,
  updateArtifact,
} from "./service.ts";
import { listVersions, renameVersion, tombstoneVersion } from "./versions.ts";

/*
 * SC-002: 0 lần lộ artifact ngoài phạm vi. Người × bốn phạm vi × mọi route của T010, gọi đúng hàm router dùng; mỗi lần
 * thử chạy trong transaction rồi huỷ để route ghi (xoá, đổi chủ…) không làm hỏng ô khác. Không đọc được thì phải là
 * ARTIFACT_NOT_FOUND (không lộ id), đọc được mà thiếu quyền thì ARTIFACT_FORBIDDEN.
 */

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let other: OrgFixture & { user: (n: string) => string };
let projectKey = "";
let projectId = "";
const SCOPES: ArtifactScope[] = ["private", "project", "team", "org"];
const ids = {} as Record<ArtifactScope, string>;
const trashed = {} as Record<ArtifactScope, string>;

type Need = "read" | "write" | "manage";
const R: Need[] = ["read"];
const RW: Need[] = ["read", "write"];
const RWM: Need[] = ["read", "write", "manage"];
const NONE: Need[] = [];

/** Ai làm được gì ở từng phạm vi (FR-020, FR-021). `tmember` là chủ của mọi artifact trong file này. */
const MATRIX: Record<string, Record<ArtifactScope, Need[]>> = {
  tmember: { private: RWM, project: RWM, team: RWM, org: RWM },
  tviewer: { private: NONE, project: R, team: R, org: RW },
  tadmin: { private: NONE, project: RWM, team: RWM, org: RW },
  oadmin: { private: NONE, project: NONE, team: NONE, org: RW },
  loner: { private: NONE, project: NONE, team: NONE, org: RW },
  // Quản trị tổ chức là quản trị mọi đội nhưng không đọc `private` của người khác (C5).
  admin: { private: NONE, project: RWM, team: RWM, org: RWM },
};

type Route = { need: Need; call: (tx: Tx, reader: Reader, id: string) => Promise<unknown> };
const ROUTES: Record<string, Route> = {
  get: { need: "read", call: (tx, r, id) => getArtifact(tx, r, { id }) },
  "get v1": { need: "read", call: (tx, r, id) => getArtifact(tx, r, { id, version: 1 }) },
  "versions.list": { need: "read", call: (tx, r, id) => listVersions(tx, r, id) },
  "links.list": { need: "read", call: (tx, r, id) => listLinks(tx, r, { id }) },
  duplicate: { need: "read", call: (tx, r, id) => duplicateArtifact(tx, r, { id }) },
  update: {
    need: "write",
    call: (tx, r, id) => updateArtifact(tx, r, { id, content: "# Bản 2", baseVersion: 1 }),
  },
  rename: { need: "write", call: (tx, r, id) => renameArtifact(tx, r, { id, title: "Tên mới" }) },
  "versions.rename": { need: "write", call: (tx, r, id) => renameVersion(tx, r, { id, version: 1, name: "Mốc" }) },
  "versions.restore": {
    need: "write",
    call: (tx, r, id) => restoreVersion(tx, r, { id, version: 1, baseVersion: 1 }),
  },
  setScope: { need: "manage", call: (tx, r, id) => setScope(tx, r, { id, scope: "private" }) },
  transferOwner: {
    need: "manage",
    call: (tx, r, id) => transferOwner(tx, r, { id, userId: org.user("tadmin") }),
  },
  delete: { need: "manage", call: (tx, r, id) => deleteArtifact(tx, r, { id }) },
  "versions.tombstone": { need: "manage", call: (tx, r, id) => tombstoneVersion(tx, r, { id, version: 1 }, {}) },
};

class Rollback extends Error {}

/** Chạy một route bằng quyền của `who` rồi huỷ transaction; trả "ok" hoặc mã lỗi nghiệp vụ. */
async function probe(
  fixture: OrgFixture & { user: (n: string) => string },
  who: string,
  fn: (tx: Tx, reader: Reader) => Promise<unknown>,
) {
  const userId = fixture.user(who);
  try {
    await withTenant(app, { userId, orgId: fixture.orgId }, async (tx) => {
      await fn(tx, await readerFor(tx, { kind: "user", userId }));
      throw new Rollback();
    });
  } catch (error) {
    if (error instanceof Rollback) return "ok";
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
    throw error;
  }
  return "ok";
}

const as = <T>(who: string, fn: (tx: Tx, reader: Reader) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, async (tx) =>
    fn(tx, await readerFor(tx, { kind: "user", userId: org.user(who) })),
  );

async function seedArtifact(scope: ArtifactScope, title: string): Promise<string> {
  const result = await as("tmember", (tx, r) =>
    createArtifact(tx, r, {
      type: "markdown",
      title,
      content: "# Bản 1",
      scope,
      ...(scope === "project" ? { projectKey } : {}),
      ...(scope === "team" ? { teamId: org.teamId } : {}),
    }),
  );
  return result.artifact.id;
}

beforeAll(async () => {
  org = await seedOrg(admin, `arta-${tag}`);
  other = await seedOrg(admin, `artb-${tag}`);
  projectKey = `arta${tag}`;
  projectId = (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey: parseMasterKey(randomBytes(32).toString("base64")),
      key: projectKey,
    })
  ).projectId;
  await admin.query("insert into hive.agent_policies (org_id, policy) values ($1, $2)", [
    org.orgId,
    JSON.stringify({ ...DEFAULT_AGENT_POLICY, artifacts: { scopes: SCOPES } }),
  ]);
  for (const scope of SCOPES) {
    ids[scope] = await seedArtifact(scope, `Artifact ${scope}`);
    trashed[scope] = await seedArtifact(scope, `Thùng rác ${scope}`);
    await as("tmember", (tx, r) => deleteArtifact(tx, r, { id: trashed[scope] }));
  }
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("ma trận quyền artifact (SC-002)", () => {
  for (const [who, row] of Object.entries(MATRIX)) {
    for (const scope of SCOPES) {
      it(`${who} × ${scope}`, async () => {
        const allowed = row[scope];
        const got: Record<string, string> = {};
        const want: Record<string, string> = {};
        for (const [name, route] of Object.entries(ROUTES)) {
          got[name] = await probe(org, who, (tx, r) => route.call(tx, r, ids[scope]));
          want[name] = allowed.includes(route.need)
            ? "ok"
            : allowed.includes("read")
              ? "ARTIFACT_FORBIDDEN"
              : "ARTIFACT_NOT_FOUND";
        }
        // Thùng rác: chỉ người khôi phục được mới thấy; người chỉ đọc biết là có nhưng không mở được.
        got.restore = await probe(org, who, (tx, r) => restoreArtifact(tx, r, { id: trashed[scope] }));
        got["get (thùng rác)"] = await probe(org, who, (tx, r) => getArtifact(tx, r, { id: trashed[scope] }));
        const trashCode = allowed.includes("manage")
          ? "ok"
          : allowed.includes("read")
            ? "ARTIFACT_FORBIDDEN"
            : "ARTIFACT_NOT_FOUND";
        want.restore = trashCode;
        want["get (thùng rác)"] = trashCode;
        expect(got).toEqual(want);

        const listed = await as(who, async (tx, r) => {
          const live = await listArtifacts(tx, r, { limit: 100 });
          const trash = await listArtifacts(tx, r, { limit: 100, trash: true });
          const search = await listArtifacts(tx, r, { limit: 100, query: `Artifact ${scope}` });
          return {
            live: live.items.some((a) => a.id === ids[scope]),
            trash: trash.items.some((a) => a.id === trashed[scope]),
            search: search.items.some((a) => a.id === ids[scope]),
          };
        });
        expect(listed).toEqual({
          live: allowed.includes("read"),
          trash: allowed.includes("manage"),
          search: allowed.includes("read"),
        });
      });
    }
  }

  it("tổ chức khác không thấy artifact nào, kể cả khi biết id", async () => {
    for (const scope of SCOPES) {
      expect(await probe(other, "owner", (tx, r) => getArtifact(tx, r, { id: ids[scope] }))).toBe("ARTIFACT_NOT_FOUND");
    }
    const page = await withTenant(app, { userId: other.user("owner"), orgId: other.orgId }, async (tx) =>
      listArtifacts(tx, await readerFor(tx, { kind: "user", userId: other.user("owner") }), { limit: 100 }),
    );
    expect(page.items).toEqual([]);
  });

  it("run của dự án chỉ thấy artifact phạm vi dự án đó, không thấy private/team/org không gắn với run", async () => {
    const seen = await withTenant(app, { orgId: org.orgId }, async (tx) => {
      const reader = await readerFor(tx, {
        kind: "run",
        runId: randomUUID(),
        runKind: "code",
        projectId,
        userId: org.user("tmember"),
        taskId: null,
        threadId: null,
      });
      const page = await listArtifacts(tx, reader, { limit: 100 });
      return SCOPES.filter((s) => page.items.some((a) => a.id === ids[s]));
    });
    expect(seen).toEqual(["project"]);
  });

  it("chủ rời tổ chức: mất quyền ngay; quản trị tổ chức dọn được artifact riêng của họ mà vẫn không đọc được", async () => {
    const leaver = org.user("leaver");
    await admin.query(
      `insert into auth."user" (id, name, email) values ($1, $1, $1 || '@seed.test') on conflict do nothing`,
      [leaver],
    );
    await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
      org.orgId,
      leaver,
    ]);
    const id = (
      await as("leaver", (tx, r) => createArtifact(tx, r, { type: "markdown", title: "Ghi chú riêng", content: "x" }))
    ).artifact.id;
    expect(await probe(org, "admin", (tx, r) => deleteArtifact(tx, r, { id }))).toBe("ARTIFACT_NOT_FOUND");
    await admin.query("update hive.org_members set status = 'blocked' where org_id = $1 and user_id = $2", [
      org.orgId,
      leaver,
    ]);
    expect(await probe(org, "leaver", (tx, r) => getArtifact(tx, r, { id }))).toBe("NOT_ORG_MEMBER");
    expect(await probe(org, "admin", (tx, r) => getArtifact(tx, r, { id }))).toBe("ARTIFACT_NOT_FOUND");
    expect(await probe(org, "admin", (tx, r) => deleteArtifact(tx, r, { id }))).toBe("ok");
    expect(await probe(org, "admin", (tx, r) => transferOwner(tx, r, { id, userId: org.user("tmember") }))).toBe("ok");
    expect(await probe(org, "tadmin", (tx, r) => deleteArtifact(tx, r, { id }))).toBe("ARTIFACT_NOT_FOUND");
  });
});
