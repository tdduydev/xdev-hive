import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_AGENT_POLICY, type OrgArtifactPolicy } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { type Principal, type Reader, readerFor } from "./access.ts";
import { provideLinkTarget } from "./hooks.ts";
import { purgeArtifacts } from "./purge.ts";
import {
  addLink,
  createArtifact,
  deleteArtifact,
  duplicateArtifact,
  getArtifact,
  listArtifacts,
  listLinks,
  renameArtifact,
  restoreArtifact,
  restoreVersion,
  transferOwner,
  updateArtifact,
} from "./service.ts";
import { listVersions, renameVersion, tombstoneVersion } from "./versions.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
// Mẫu PAT GitHub giả: đủ dạng để bộ quét bắt, không phải token thật.
const FAKE_TOKEN = `ghp_${"A1b2C3d4".repeat(5)}abcd`;

type Org = OrgFixture & { user: (n: string) => string };
let org: Org;
let projectKey = "";
let projectId = "";

function principalOf(fixture: Org, who: string): Principal {
  return { kind: "user", userId: fixture.user(who) };
}

function as<T>(who: string, fn: (tx: Tx, reader: Reader) => Promise<T>, fixture: Org = org): Promise<T> {
  return withTenant(app, { userId: fixture.user(who), orgId: fixture.orgId }, async (tx) =>
    fn(tx, await readerFor(tx, principalOf(fixture, who))),
  );
}

function asRun<T>(runId: string, fn: (tx: Tx, reader: Reader) => Promise<T>): Promise<T> {
  return withTenant(app, { orgId: org.orgId }, async (tx) =>
    fn(
      tx,
      await readerFor(tx, {
        kind: "run",
        runId,
        runKind: "leader",
        projectId,
        userId: org.user("tmember"),
        taskId: null,
        threadId: null,
      }),
    ),
  );
}

async function setPolicy(orgId: string, artifacts: Partial<OrgArtifactPolicy>) {
  await admin.query(
    `insert into hive.agent_policies (org_id, policy) values ($1, $2)
     on conflict (org_id) do update set policy = excluded.policy`,
    [orgId, JSON.stringify({ ...DEFAULT_AGENT_POLICY, artifacts })],
  );
}

const md = (who: string, content: string, extra: Record<string, unknown> = {}) =>
  as(who, (tx, r) => createArtifact(tx, r, { type: "markdown", title: "Ghi chú", content, ...extra }));

async function seedPublicLink(artifactId: string, version: number, createdBy: string): Promise<string> {
  const { rows } = await admin.query(
    `insert into hive.artifact_public_links (org_id, artifact_id, version, token_sha256, created_by, expires_at)
     values ($1, $2, $3, $4, $5, now() + interval '7 days') returning id`,
    [org.orgId, artifactId, version, createHash("sha256").update(randomUUID()).digest("hex"), createdBy],
  );
  return rows[0].id;
}

const linkState = async (id: string) =>
  (await admin.query("select revoked_at, revoke_reason from hive.artifact_public_links where id = $1", [id])).rows[0];

const auditRows = async (orgId: string, action: string) =>
  (await admin.query("select data, target_id from hive.audit_log where org_id = $1 and action = $2", [orgId, action]))
    .rows as { data: Record<string, unknown>; target_id: string | null }[];

beforeAll(async () => {
  org = await seedOrg(admin, `art-${tag}`);
  projectKey = `art${tag}`;
  projectId = (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: projectKey,
    })
  ).projectId;
});

afterAll(async () => {
  provideLinkTarget("task", undefined);
  await Promise.all([admin.end(), app.end()]);
});

describe("phiên bản", () => {
  it("tạo v1, lưu v2 theo baseVersion, khôi phục thành v3 có restoredFrom; lịch sử mới nhất trước", async () => {
    const created = await md("tmember", "# Một");
    const id = created.artifact.id;
    expect(created.version).toMatchObject({ version: 1, authorUser: { id: org.user("tmember") }, origin: "manual" });
    expect(created.version.sha256).toBe(createHash("sha256").update("# Một").digest("hex"));
    const v2 = await as("tmember", (tx, r) =>
      updateArtifact(tx, r, { id, content: "# Hai", baseVersion: 1, message: "sửa" }),
    );
    expect(v2.artifact.latestVersion).toBe(2);
    const v3 = await as("tmember", (tx, r) => restoreVersion(tx, r, { id, version: 1, baseVersion: 2 }));
    expect(v3.version).toMatchObject({ version: 3, restoredFrom: 1 });
    const detail = await as("tmember", (tx, r) => getArtifact(tx, r, { id }));
    expect(detail.version.content).toBe("# Một");
    expect(detail.access).toEqual({ write: true, manage: true, owner: true });
    expect((await as("tmember", (tx, r) => getArtifact(tx, r, { id, version: 2 }))).version.content).toBe("# Hai");
    const history = await as("tmember", (tx, r) => listVersions(tx, r, id));
    expect(history.map((v) => v.version)).toEqual([3, 2, 1]);
    // Kích thước cộng dồn mọi phiên bản (D13).
    expect(v3.artifact.sizeBytes).toBe(Buffer.byteLength("# Một") * 2 + Buffer.byteLength("# Hai"));
  });

  it("baseVersion cũ → ARTIFACT_VERSION_CONFLICT kèm bản mới nhất", async () => {
    const id = (await md("tmember", "gốc")).artifact.id;
    await as("tmember", (tx, r) => updateArtifact(tx, r, { id, content: "mới", baseVersion: 1 }));
    const error = await as("tmember", (tx, r) => updateArtifact(tx, r, { id, content: "cũ", baseVersion: 1 })).catch(
      (e) => e,
    );
    expect(error.code).toBe("ARTIFACT_VERSION_CONFLICT");
    expect(error.detail).toEqual({ latest: { version: 2, content: "mới" } });
  });

  it("thiếu baseVersion: nhận khi người gọi viết bản mới nhất, từ chối khi người khác viết", async () => {
    const id = (await md("tmember", "x", { scope: "project", projectKey })).artifact.id;
    await as("tmember", (tx, r) => updateArtifact(tx, r, { id, content: "y" }));
    expect(await errorCode(() => as("tadmin", (tx, r) => updateArtifact(tx, r, { id, content: "z" })))).toBe(
      "ARTIFACT_VERSION_CONFLICT",
    );
    await as("tadmin", (tx, r) => updateArtifact(tx, r, { id, content: "z", baseVersion: 2 }));
  });

  it("hai lần lưu cùng lúc từ một bản: một lần thành công, một lần xung đột", async () => {
    const id = (await md("tmember", "gốc")).artifact.id;
    const results = await Promise.allSettled(
      ["a", "b"].map((c) => as("tmember", (tx, r) => updateArtifact(tx, r, { id, content: c, baseVersion: 1 }))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason.code).toBe("ARTIFACT_VERSION_CONFLICT");
  });

  it("giới hạn 200 phiên bản (mặc định) → ARTIFACT_VERSION_LIMIT", async () => {
    const id = (await md("tmember", "v1")).artifact.id;
    await as("tmember", async (tx, r) => {
      for (let v = 2; v <= 200; v++) await updateArtifact(tx, r, { id, content: `v${v}`, baseVersion: v - 1 });
    });
    const error = await as("tmember", (tx, r) =>
      updateArtifact(tx, r, { id, content: "v201", baseVersion: 200 }),
    ).catch((e) => e);
    expect(error.code).toBe("ARTIFACT_VERSION_LIMIT");
    expect(error.detail).toEqual({ limit: 200 });
  });

  it("đổi tiêu đề không tạo phiên bản; đặt tên phiên bản qua hàm của database", async () => {
    const id = (await md("tmember", "nội dung")).artifact.id;
    const renamed = await as("tmember", (tx, r) => renameArtifact(tx, r, { id, title: "Tiêu đề mới" }));
    expect(renamed).toMatchObject({ title: "Tiêu đề mới", latestVersion: 1 });
    const named = await as("tmember", (tx, r) => renameVersion(tx, r, { id, version: 1, name: "Bản duyệt" }));
    expect(named.name).toBe("Bản duyệt");
    const cleared = await as("tmember", (tx, r) => renameVersion(tx, r, { id, version: 1, name: null }));
    expect(cleared.name).toBeNull();
  });
});

describe("giới hạn và chính sách", () => {
  it("vượt cỡ phiên bản → ARTIFACT_TOO_LARGE kèm giới hạn; tắt loại, tắt artifact", async () => {
    const q = await seedOrg(admin, `artq-${tag}`);
    await setPolicy(q.orgId, { maxVersionBytes: 2048, types: ["markdown"] });
    const big = await as(
      "owner",
      (tx, r) => createArtifact(tx, r, { type: "markdown", title: "Lớn", content: "é".repeat(1100) }),
      q,
    ).catch((e) => e);
    expect(big.code).toBe("ARTIFACT_TOO_LARGE");
    expect(big.detail).toEqual({ limit: 2048 });
    const html = () => as("owner", (tx, r) => createArtifact(tx, r, { type: "html", title: "T", content: "<p/>" }), q);
    expect(await errorCode(html)).toBe("ARTIFACT_TYPE_DISABLED");
    // Loại tắt bị từ chối trước khi biên dịch.
    const react = () =>
      as("owner", (tx, r) => createArtifact(tx, r, { type: "react", title: "T", content: "export default <p" }), q);
    expect(await errorCode(react)).toBe("ARTIFACT_TYPE_DISABLED");
    await setPolicy(q.orgId, { enabled: false });
    expect(
      await errorCode(() =>
        as("owner", (tx, r) => createArtifact(tx, r, { type: "markdown", title: "T", content: "x" }), q),
      ),
    ).toBe("ARTIFACTS_DISABLED");
    // Phạm vi `team` tắt theo mặc định (MVP chỉ private, project).
    await setPolicy(q.orgId, {});
    expect(
      await errorCode(() =>
        as(
          "owner",
          (tx, r) =>
            createArtifact(tx, r, { type: "markdown", title: "T", content: "x", scope: "team", teamId: q.teamId }),
          q,
        ),
      ),
    ).toBe("ARTIFACT_SCOPE_DISABLED");
  });

  it("dung lượng tổ chức: hai lần lưu đồng thời không vượt hạn mức; vượt 80% báo quản trị một lần mỗi ngày", async () => {
    const q = await seedOrg(admin, `artc-${tag}`);
    await setPolicy(q.orgId, { orgQuotaBytes: 1024 * 1024 });
    const half = "a".repeat(600 * 1024);
    const results = await Promise.allSettled(
      ["owner", "admin"].map((who) =>
        as(who, (tx, r) => createArtifact(tx, r, { type: "markdown", title: "Nửa", content: half }), q),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason.code).toBe("ARTIFACT_QUOTA_EXCEEDED");
    expect(failed.reason.detail).toEqual({ limit: 1024 * 1024 });
    // 600 KiB = 58%: chưa báo. Thêm 250 KiB → 83%: báo. Thêm nữa trong ngày: không báo lại.
    expect(await auditRows(q.orgId, "artifact.quota.warn")).toHaveLength(0);
    for (const n of [250, 10]) {
      await as(
        "owner",
        (tx, r) => createArtifact(tx, r, { type: "markdown", title: "Thêm", content: "b".repeat(n * 1024) }),
        q,
      );
    }
    expect(await auditRows(q.orgId, "artifact.quota.warn")).toHaveLength(1);
    const inbox = await admin.query(
      "select user_id from hive.inbox_items where org_id = $1 and event = 'artifact.quota' order by user_id",
      [q.orgId],
    );
    expect(inbox.rows.map((r) => r.user_id)).toEqual([q.user("admin"), q.user("owner")].sort());
  });

  it("giới hạn mỗi run: số artifact và số phiên bản; tác giả là run, không phải người", async () => {
    await setPolicy(org.orgId, { runLimits: { artifacts: 2, versions: 3 } });
    try {
      const runId = randomUUID();
      const create = () =>
        asRun(runId, (tx, r) =>
          createArtifact(tx, r, { type: "markdown", title: "Run", content: "x", scope: "project", projectKey }),
        );
      const first = await create();
      expect(first.version).toMatchObject({ authorUser: null, authorRunId: runId, origin: "leader" });
      expect(first.artifact.originProjectId).toBe(projectId);
      await create();
      expect(await errorCode(create)).toBe("ARTIFACT_RUN_LIMIT");
      // Artifact run tạo được gắn với run, nên run sửa được nó tới khi chạm số phiên bản.
      const links = await as("tmember", (tx, r) => listLinks(tx, r, { id: first.artifact.id }));
      expect(links).toEqual([expect.objectContaining({ targetKind: "run", targetId: runId, createdByRunId: runId })]);
      await asRun(runId, (tx, r) => updateArtifact(tx, r, { id: first.artifact.id, content: "y", baseVersion: 1 }));
      expect(
        await errorCode(() =>
          asRun(runId, (tx, r) => updateArtifact(tx, r, { id: first.artifact.id, content: "z", baseVersion: 2 })),
        ),
      ).toBe("ARTIFACT_RUN_LIMIT");
    } finally {
      await setPolicy(org.orgId, {});
    }
  });
});

describe("react", () => {
  const react = (who: string, content: string) =>
    as(who, (tx, r) => createArtifact(tx, r, { type: "react", title: "Bảng", content }));
  const stored = async (id: string) =>
    (
      await admin.query(
        "select version, compiled, compile_error from hive.artifact_versions where artifact_id = $1 order by version",
        [id],
      )
    ).rows as { version: number; compiled: string | null; compile_error: string | null }[];

  it("biên dịch khi lưu; lỗi cú pháp vẫn lưu phiên bản kèm compile_error; khôi phục biên dịch lại", async () => {
    const ok = await react(
      "tmember",
      `import { useState } from "react";
export default function App() { const [n] = useState<number>(1); return <p>{n}</p>; }`,
    );
    expect(ok.compileError).toBeNull();
    const id = ok.artifact.id;
    const broken = await as("tmember", (tx, r) =>
      updateArtifact(tx, r, { id, content: "export default function App() { return <p>; }", baseVersion: 1 }),
    );
    expect(broken.version.version).toBe(2);
    expect(broken.compileError).toEqual(expect.any(String));
    const restored = await as("tmember", (tx, r) => restoreVersion(tx, r, { id, version: 1, baseVersion: 2 }));
    expect(restored.compileError).toBeNull();
    const rows = await stored(id);
    expect(rows.map((v) => [v.version, v.compiled !== null, v.compile_error !== null])).toEqual([
      [1, true, false],
      [2, false, true],
      [3, true, false],
    ]);
    expect(rows[0]?.compiled).toContain('from "react/jsx-runtime"');
    // Bản biên dịch tính vào dung lượng cùng nguồn (D13).
    const size = (await admin.query("select size_bytes from hive.artifacts where id = $1", [id])).rows[0].size_bytes;
    expect(Number(size)).toBeGreaterThan(rows.reduce((n, v) => n + Buffer.byteLength(v.compiled ?? ""), 0));
  });

  it("import ngoài bộ đóng gói hay import() động: không lưu gì, lỗi kèm tên module", async () => {
    const before = (
      await admin.query("select count(*)::int as n from hive.artifacts where org_id = $1 and type = 'react'", [
        org.orgId,
      ])
    ).rows[0].n;
    const err: unknown = await react(
      "tmember",
      `import _ from "lodash";\nexport default function App() { return <p>{_.noop()}</p>; }`,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "ARTIFACT_IMPORT_NOT_ALLOWED",
      detail: { imports: ["lodash"] },
      message: expect.stringContaining("recharts"),
    });
    expect(
      await errorCode(() => react("tmember", `export default function App() { import("react"); return null; }`)),
    ).toBe("ARTIFACT_IMPORT_NOT_ALLOWED");
    const after = (
      await admin.query("select count(*)::int as n from hive.artifacts where org_id = $1 and type = 'react'", [
        org.orgId,
      ])
    ).rows[0].n;
    expect(after).toBe(before);

    const id = (await react("tmember", "export default () => <p>gốc</p>;")).artifact.id;
    expect(
      await errorCode(() =>
        as("tmember", (tx, r) =>
          updateArtifact(tx, r, {
            id,
            content: `import x from "https://evil.example/x.js";\nexport default () => <p>{x}</p>;`,
            baseVersion: 1,
          }),
        ),
      ),
    ).toBe("ARTIFACT_IMPORT_NOT_ALLOWED");
    expect((await stored(id)).map((v) => v.version)).toEqual([1]);
  });
});

describe("bí mật", () => {
  it("chặn khi lưu và khôi phục, trả dòng và loại, không tạo gì", async () => {
    const content = `# Cấu hình\n\ntoken = ${FAKE_TOKEN}\n`;
    const error = await md("tmember", content).catch((e) => e);
    expect(error.code).toBe("ARTIFACT_SECRET_FOUND");
    expect(error.detail.findings.length).toBeGreaterThan(0);
    expect(error.detail.findings.every((f: { line: number }) => f.line === 3)).toBe(true);
    expect(JSON.stringify(error.detail)).not.toContain(FAKE_TOKEN);
    expect(error.message).not.toContain(FAKE_TOKEN);
    const { rows } = await admin.query("select count(*)::int as n from hive.artifact_versions where content like $1", [
      `%${FAKE_TOKEN}%`,
    ]);
    expect(rows[0].n).toBe(0);
  });
});

describe("thùng rác, xoá phiên bản, nhân bản, link công khai", () => {
  it("xoá mềm: biến khỏi thư viện, có trong thùng rác, khôi phục được; link công khai bị thu hồi và không sống lại", async () => {
    const id = (await md("tmember", "rác", { title: "Sắp xoá" })).artifact.id;
    const link = await seedPublicLink(id, 1, org.user("tmember"));
    await as("tmember", (tx, r) => deleteArtifact(tx, r, { id }));
    expect((await linkState(link)).revoke_reason).toBe("deleted");
    const live = await as("tmember", (tx, r) => listArtifacts(tx, r, { limit: 100 }));
    expect(live.items.map((a) => a.id)).not.toContain(id);
    const trash = await as("tmember", (tx, r) => listArtifacts(tx, r, { limit: 100, trash: true }));
    expect(trash.items.map((a) => a.id)).toContain(id);
    expect(
      await errorCode(() => as("tmember", (tx, r) => updateArtifact(tx, r, { id, content: "x", baseVersion: 1 }))),
    ).toBe("ARTIFACT_NOT_FOUND");
    const restored = await as("tmember", (tx, r) => restoreArtifact(tx, r, { id }));
    expect(restored.deletedAt).toBeNull();
    expect((await linkState(link)).revoked_at).not.toBeNull();
    expect((await auditRows(org.orgId, "artifact.public_link.revoke")).some((a) => a.target_id === id)).toBe(true);
  });

  it("chuyển chủ thu hồi link và báo chủ cũ khi người khác làm", async () => {
    const id = (await md("tmember", "chia sẻ", { scope: "project", projectKey })).artifact.id;
    const link = await seedPublicLink(id, 1, org.user("tmember"));
    const moved = await as("tadmin", (tx, r) => transferOwner(tx, r, { id, userId: org.user("tadmin") }));
    expect(moved.owner.id).toBe(org.user("tadmin"));
    expect((await linkState(link)).revoke_reason).toBe("owner_changed");
    const inbox = await admin.query(
      "select count(*)::int as n from hive.inbox_items where org_id = $1 and user_id = $2 and event = 'artifact.public_link.revoked'",
      [org.orgId, org.user("tmember")],
    );
    expect(inbox.rows[0].n).toBeGreaterThan(0);
    expect(await errorCode(() => as("tadmin", (tx, r) => transferOwner(tx, r, { id, userId: "khong-ton-tai" })))).toBe(
      "MEMBER_NOT_FOUND",
    );
  });

  it("xoá phiên bản vì bí mật: mất nội dung, giữ số; trả dung lượng; thu hồi link của đúng bản đó", async () => {
    const created = await md("tmember", "v1 dài hơn");
    const id = created.artifact.id;
    await as("tmember", (tx, r) => updateArtifact(tx, r, { id, content: "v2", baseVersion: 1 }));
    const l1 = await seedPublicLink(id, 1, org.user("tmember"));
    const l2 = await seedPublicLink(id, 2, org.user("tmember"));
    const meta = await as("tmember", (tx, r) => tombstoneVersion(tx, r, { id, version: 1 }, {}));
    expect(meta.tombstonedAt).not.toBeNull();
    const v1 = await as("tmember", (tx, r) => getArtifact(tx, r, { id, version: 1 }));
    expect(v1.version).toMatchObject({ content: null, version: 1, sha256: created.version.sha256 });
    expect(v1.artifact.sizeBytes).toBe(Buffer.byteLength("v2"));
    expect((await linkState(l1)).revoke_reason).toBe("tombstoned");
    expect((await linkState(l2)).revoked_at).toBeNull();
    // Bản đã xoá nội dung không khôi phục hay nhân bản được.
    expect(await errorCode(() => as("tmember", (tx, r) => restoreVersion(tx, r, { id, version: 1 })))).toBe(
      "ARTIFACT_NOT_FOUND",
    );
    expect(await errorCode(() => as("tmember", (tx, r) => duplicateArtifact(tx, r, { id, version: 1 })))).toBe(
      "ARTIFACT_NOT_FOUND",
    );
    // hive_app vẫn không sửa thẳng được phiên bản (D3).
    await expect(
      as("tmember", (tx) => tx.execute(`update hive.artifact_versions set content = 'x' where artifact_id = '${id}'`)),
    ).rejects.toThrow();
  });

  it("nhân bản ghi duplicated_from_* và thành artifact private của người gọi", async () => {
    const id = (await md("tmember", "gốc", { scope: "project", projectKey, title: "Báo cáo" })).artifact.id;
    const copy = await as("tviewer", (tx, r) => duplicateArtifact(tx, r, { id }));
    expect(copy.artifact).toMatchObject({
      title: "Báo cáo",
      scope: "private",
      owner: { id: org.user("tviewer") },
      duplicatedFrom: { id, version: 1 },
    });
    const row = await admin.query(
      "select duplicated_from_id, duplicated_from_version from hive.artifacts where id = $1",
      [copy.artifact.id],
    );
    expect(row.rows[0]).toEqual({ duplicated_from_id: id, duplicated_from_version: 1 });
    expect(
      (await auditRows(org.orgId, "artifact.create")).find((a) => a.target_id === copy.artifact.id)?.data,
    ).toMatchObject({ duplicatedFrom: { id, version: 1 } });
  });

  it("purge: thùng rác quá 30 ngày bị xoá hẳn (thẻ chat còn), liên kết mồ côi, link của chủ đã rời tổ chức", async () => {
    const old = (await md("tmember", "cũ")).artifact.id;
    await as("tmember", (tx, r) => deleteArtifact(tx, r, { id: old }));
    await admin.query("update hive.artifacts set deleted_at = now() - interval '31 days' where id = $1", [old]);
    const fresh = (await md("tmember", "mới xoá")).artifact.id;
    await as("tmember", (tx, r) => deleteArtifact(tx, r, { id: fresh }));

    const kept = (await md("tmember", "giữ", { scope: "project", projectKey })).artifact.id;
    const liveTask = randomUUID();
    const goneTask = randomUUID();
    provideLinkTarget("task", {
      kind: "task",
      assertWritable: async () => {},
      projectOf: async () => projectId,
      existing: async (_tx, targetIds) => new Set(targetIds.filter((t) => t === liveTask)),
    });
    for (const t of [liveTask, goneTask])
      await as("tmember", (tx, r) => addLink(tx, r, { id: kept, targetKind: "task", targetId: t }));

    const leaver = org.user("leaver");
    await admin.query(
      `insert into auth."user" (id, name, email) values ($1, $1, $1 || '@seed.test') on conflict do nothing`,
      [leaver],
    );
    await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
      org.orgId,
      leaver,
    ]);
    const theirs = (await md("leaver", "của người sắp rời")).artifact.id;
    const theirLink = await seedPublicLink(theirs, 1, leaver);
    const mineLink = await seedPublicLink(kept, 1, org.user("tmember"));
    await admin.query("update hive.org_members set status = 'blocked' where org_id = $1 and user_id = $2", [
      org.orgId,
      leaver,
    ]);

    const result = await purgeArtifacts(app);
    expect(result.artifacts).toBeGreaterThanOrEqual(1);
    const left = await admin.query("select id from hive.artifacts where id = any($1::uuid[])", [[old, fresh]]);
    expect(left.rows.map((r) => r.id)).toEqual([fresh]);
    const links = await as("tmember", (tx, r) => listLinks(tx, r, { id: kept }));
    expect(links.map((l) => l.targetId)).toEqual([liveTask]);
    expect((await linkState(theirLink)).revoke_reason).toBe("owner_left");
    expect((await linkState(mineLink)).revoked_at).toBeNull();
    expect((await auditRows(org.orgId, "artifact.purge")).length).toBeGreaterThan(0);
  });
});

describe("liên kết, thư viện", () => {
  it("gắn vào đích dùng chung đòi phạm vi đủ rộng; đích chưa có module cài thì từ chối", async () => {
    provideLinkTarget("task", {
      kind: "task",
      assertWritable: async () => {},
      projectOf: async () => projectId,
      titles: async (_tx, _r, targetIds) => new Map(targetIds.map((t) => [t, "TASK-1"])),
    });
    const priv = (await md("tmember", "riêng")).artifact.id;
    const shared = (await md("tmember", "chung", { scope: "project", projectKey })).artifact.id;
    const task = randomUUID();
    expect(
      await errorCode(() => as("tmember", (tx, r) => addLink(tx, r, { id: priv, targetKind: "task", targetId: task }))),
    ).toBe("ARTIFACT_SCOPE_TOO_NARROW");
    const link = await as("tmember", (tx, r) => addLink(tx, r, { id: shared, targetKind: "task", targetId: task }));
    expect(link).toMatchObject({ targetKind: "task", targetId: task, title: "TASK-1" });
    expect(
      await errorCode(() =>
        as("tmember", (tx, r) => addLink(tx, r, { id: shared, targetKind: "doc", targetId: randomUUID() })),
      ),
    ).toBe("ARTIFACT_LINK_FORBIDDEN");
    const byTask = await as("tviewer", (tx, r) => listArtifacts(tx, r, { taskId: task, limit: 10 }));
    expect(byTask.items.map((a) => a.id)).toEqual([shared]);
  });

  it("tìm theo nội dung và tiêu đề; phân trang bằng con trỏ không sót không lặp", async () => {
    const q = await seedOrg(admin, `artl-${tag}`);
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      made.push(
        (
          await as(
            "owner",
            (tx, r) =>
              createArtifact(tx, r, {
                type: "markdown",
                title: `Mục ${i}`,
                content: i === 3 ? "sơ đồ thanhtoan hoàn tiền" : "khác",
              }),
            q,
          )
        ).artifact.id,
      );
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await as("owner", (tx, r) => listArtifacts(tx, r, { limit: 2, ...(cursor ? { cursor } : {}) }), q);
      seen.push(...page.items.map((a) => a.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([...made].reverse());
    const found = await as("owner", (tx, r) => listArtifacts(tx, r, { query: "thanhtoan", limit: 10 }), q);
    expect(found.items.map((a) => a.id)).toEqual([made[3]]);
    const byTitle = await as("owner", (tx, r) => listArtifacts(tx, r, { query: "Mục 1", limit: 10 }), q);
    expect(byTitle.items.map((a) => a.id)).toContain(made[1]);
  });
});
