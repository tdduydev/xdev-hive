import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, parseMasterKey, withTenant } from "../platform/index.ts";
import { createConnection } from "./connections.ts";
import { canIssueRunGitToken, issueRunGitToken, revokeRunGitTokens, sweepRunGitTokens } from "./run-token.ts";
import type { GitProvider } from "./types.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const master = parseMasterKey(randomBytes(32).toString("base64"));
const repo = { owner: "grp", name: "web" };

let org: OrgFixture & { user: (n: string) => string };
let other: OrgFixture & { user: (n: string) => string };
let connectionId: string;
let otherConnectionId: string;

const revoked: string[] = [];
let seq = 0;
// Giả lập GitLab: mỗi token một id, ghi lại id bị thu hồi.
const gitlab = {
  kind: "gitlab",
  async issueRunToken() {
    seq += 1;
    return {
      host: "gitlab.example.com",
      username: "oauth2",
      token: `glpat-run-${seq}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      externalId: String(seq),
    };
  },
  async revokeRunToken(_ref: unknown, id: string) {
    revoked.push(id);
  },
} as unknown as GitProvider;
const pat = { kind: "github" } as unknown as GitProvider;

const deps = (provider = gitlab) => ({ pool: app, masterKey: master, providerFactory: () => provider });
const target = (runId: string, attempt = 1) => ({ orgId: org.orgId, runId, attempt, connectionId, repo });

async function newConnection(of: OrgFixture & { user: (n: string) => string }, name: string): Promise<string> {
  const conn = await withTenant(app, { userId: of.user("owner"), orgId: of.orgId }, (tx) =>
    createConnection(tx, master, of.user("owner"), {
      kind: "gitlab",
      name,
      baseUrl: "https://gitlab.example.com",
      defaultOwner: "grp",
      token: "glpat-ket-noi",
    }),
  );
  return conn.id;
}

beforeAll(async () => {
  org = await seedOrg(admin, "rgt");
  other = await seedOrg(admin, "rgt2");
  connectionId = await newConnection(org, "GitLab");
  otherConnectionId = await newConnection(other, "GitLab khác");
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("token git theo run", () => {
  it("cấp token, ghi dòng và audit nhưng không lưu giá trị token", async () => {
    const runId = randomUUID();
    const git = await issueRunGitToken(deps(), target(runId));
    expect(git).toMatchObject({ host: "gitlab.example.com", username: "oauth2", repo: "grp/web" });
    expect(git?.token).toMatch(/^glpat-run-/);
    const rows = await admin.query("select * from hive.run_git_tokens where run_id = $1", [runId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ org_id: org.orgId, attempt: 1, provider: "gitlab", revoked_at: null });
    const audit = await admin.query("select action, data from hive.audit_log where target_id = $1", [runId]);
    expect(audit.rows.map((r) => r.action)).toEqual(["scm.run_token_issue"]);
    expect(JSON.stringify([rows.rows, audit.rows])).not.toContain(git?.token);
  });

  it("kết nối không cấp được (PAT) thì trả null, không ghi gì", async () => {
    const runId = randomUUID();
    expect(await issueRunGitToken(deps(pat), target(runId))).toBeNull();
    expect(await withTenant(app, { orgId: org.orgId }, (tx) => canIssueRunGitToken(tx, deps(pat), connectionId))).toBe(
      false,
    );
    expect(await withTenant(app, { orgId: org.orgId }, (tx) => canIssueRunGitToken(tx, deps(), connectionId))).toBe(
      true,
    );
    const rows = await admin.query("select 1 from hive.run_git_tokens where run_id = $1", [runId]);
    expect(rows.rows).toHaveLength(0);
  });

  it("không dùng được kết nối của tổ chức khác", async () => {
    expect(await issueRunGitToken(deps(), { ...target(randomUUID()), connectionId: otherConnectionId })).toBeNull();
  });

  it("thu hồi token còn mở của run một lần", async () => {
    const runId = randomUUID();
    await issueRunGitToken(deps(), target(runId, 1));
    await issueRunGitToken(deps(), target(runId, 2));
    expect(await revokeRunGitTokens(deps(), org.orgId, runId)).toBe(2);
    expect(await revokeRunGitTokens(deps(), org.orgId, runId)).toBe(0);
    const rows = await admin.query("select revoked_at from hive.run_git_tokens where run_id = $1", [runId]);
    expect(rows.rows.every((r) => r.revoked_at !== null)).toBe(true);
    const audit = await admin.query(
      "select count(*)::int as n from hive.audit_log where target_id = $1 and action = $2",
      [runId, "scm.run_token_revoke"],
    );
    expect(audit.rows[0].n).toBe(2);
  });

  it("job quét chỉ thu hồi token của run đã rời máy", async () => {
    const live = randomUUID();
    const gone = randomUUID();
    const liveToken = await issueRunGitToken(deps(), target(live));
    const goneToken = await issueRunGitToken(deps(), target(gone));
    const liveId = liveToken?.token.replace("glpat-run-", "");
    const goneId = goneToken?.token.replace("glpat-run-", "");
    await sweepRunGitTokens({ ...deps(), isLive: async (_tx, runId) => runId === live });
    expect(revoked).toContain(goneId);
    expect(revoked).not.toContain(liveId);
    const rows = await admin.query("select run_id, revoked_at from hive.run_git_tokens where run_id = any($1)", [
      [live, gone],
    ]);
    const byRun = Object.fromEntries(rows.rows.map((r) => [r.run_id, r.revoked_at]));
    expect(byRun[live]).toBeNull();
    expect(byRun[gone]).not.toBeNull();
  });
});
