import { randomBytes, randomUUID } from "node:crypto";
import type { McpServerRuleInput } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { findProject } from "../catalog/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { allowWith, requireOrgRole } from "../tenancy/index.ts";
import { McpToolRegistry } from "./registry.ts";
import {
  createServerRule,
  deleteServerRule,
  listServerRules,
  mcpServersForProject,
  previewServers,
  updateServerRule,
} from "./server-rules-service.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const pool = createPool(db.appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
// Ghép như app.ts: vai trò tự tạo có mcp.servers được nhận thay quản trị tổ chức.
const registry = new McpToolRegistry();
registry.provideAuthorization(async (tx, userId, min, permission) =>
  permission
    ? ((await allowWith(tx, userId, permission, () => requireOrgRole(tx, userId, min))) ?? "member")
    : requireOrgRole(tx, userId, min),
);
registry.provideProjects(findProject);

let org: Awaited<ReturnType<typeof seedOrg>>;
let other: typeof org;
let projectId = "";
let projectKey = "";
let otherProjectId = "";
const as = <T>(user: string, fn: (tx: Tx) => Promise<T>, orgId = org.orgId) =>
  withTenant(pool, { userId: user, orgId }, fn);
const owner = () => org.user("owner");
const create = (input: McpServerRuleInput, user = owner()) =>
  as(user, (tx) => createServerRule(tx, user, registry, input));
const npx = (...args: string[]) => ({ transport: "stdio" as const, command: "npx", args });

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  org = await seedOrg(admin, `mcp-servers-${tag}`);
  other = await seedOrg(admin, `mcp-servers-other-${tag}`);
  projectKey = `mob-${tag}`;
  const seeded = (key: string, o = org) =>
    seedProject(admin, pool, {
      orgId: o.orgId,
      teamId: o.teamId,
      systemId: o.systemId,
      adminUserId: o.user("admin"),
      masterKey,
      key,
    });
  projectId = (await seeded(projectKey)).projectId;
  otherProjectId = (await seeded(`pay-${tag}`, other)).projectId;
});
afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

describe("quy tắc MCP server ngoài", () => {
  it("quản trị thêm quy tắc tổ chức và dự án, mỗi thay đổi có audit", async () => {
    const github = await create({
      name: "GitHub",
      rule: "allow",
      matchType: "name",
      projectId: null,
      launch: npx("-y", "@modelcontextprotocol/server-github"),
    });
    // Bỏ trống mẫu khi có cấu hình: hub lấy tên trong cấu hình CLI.
    expect(github).toMatchObject({ key: "github", pattern: "github", projectId: null, projectKey: null });
    const filesystem = await create({
      name: "Filesystem",
      rule: "deny",
      matchType: "command",
      pattern: "  npx   @modelcontextprotocol/server-filesystem ",
      projectId: null,
      launch: null,
    });
    expect(filesystem.pattern).toBe("npx @modelcontextprotocol/server-filesystem");
    const everything = await create({
      name: "Mọi server khác",
      rule: "deny",
      matchType: "wildcard",
      pattern: "bị bỏ qua",
      projectId: null,
      launch: null,
    });
    expect(everything.pattern).toBe("*");
    const playwright = await create({
      name: "Playwright",
      rule: "allow",
      matchType: "command",
      projectId,
      launch: npx("@playwright/mcp@latest"),
    });
    expect(playwright).toMatchObject({ projectKey, pattern: "npx @playwright/mcp@latest" });
    await create({
      name: "Filesystem",
      rule: "allow",
      matchType: "name",
      projectId,
      launch: npx("-y", "@modelcontextprotocol/server-filesystem", "/tmp"),
    });
    await create({
      name: "Context7",
      rule: "allow",
      matchType: "url",
      projectId,
      launch: { transport: "http", url: "https://mcp.context7.com/mcp" },
    });

    const { rules } = await as(owner(), (tx) => listServerRules(tx, owner(), registry));
    expect(rules.map((r) => [r.name, r.rule, r.projectKey])).toEqual([
      ["GitHub", "allow", null],
      ["Filesystem", "deny", null],
      ["Mọi server khác", "deny", null],
      ["Playwright", "allow", projectKey],
      ["Filesystem", "allow", projectKey],
      ["Context7", "allow", projectKey],
    ]);
    const audit = await admin.query(
      "select action, data from hive.audit_log where org_id = $1 and target_type = 'mcp_server_rule' order by created_at",
      [org.orgId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(Array(6).fill("mcp.server_rule_create"));
    // Tham số và URL có thể chứa khoá API nên không vào audit.
    expect(JSON.stringify(audit.rows)).not.toContain("server-github");
  });

  it("chặn thắng cho phép: dự án không mở lại được server tổ chức đã chặn; * chỉ chặn phần còn lại", async () => {
    const preview = await as(owner(), (tx) => previewServers(tx, owner(), registry, projectId));
    expect(preview.servers.map((s) => [s.key, s.allowed, s.decidedBy?.name])).toEqual([
      ["context7", true, "Context7"],
      ["filesystem", false, "Filesystem"],
      ["github", true, "GitHub"],
      ["playwright", true, "Playwright"],
    ]);
    expect(preview.servers.find((s) => s.key === "filesystem")?.decidedBy?.rule).toBe("deny");
    const orgPreview = await as(owner(), (tx) => previewServers(tx, owner(), registry));
    expect(orgPreview.servers.map((s) => [s.key, s.allowed])).toEqual([["github", true]]);
    const job = await withTenant(pool, { orgId: org.orgId }, (tx) => mcpServersForProject(tx, projectId));
    expect(job).toEqual([
      { name: "context7", transport: "http", url: "https://mcp.context7.com/mcp" },
      { name: "github", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      { name: "playwright", transport: "stdio", command: "npx", args: ["@playwright/mcp@latest"] },
    ]);
  });

  it("sửa và xoá quy tắc, có audit trước/sau", async () => {
    const { rules } = await as(owner(), (tx) => listServerRules(tx, owner(), registry));
    const github = rules.find((r) => r.key === "github" && !r.projectId);
    if (!github) throw new Error("thiếu quy tắc github");
    const denied = await as(owner(), (tx) =>
      updateServerRule(tx, owner(), registry, github.id, {
        name: github.name,
        rule: "deny",
        matchType: github.matchType,
        pattern: github.pattern,
        projectId: null,
        launch: github.launch,
      }),
    );
    expect(denied.rule).toBe("deny");
    const job = await withTenant(pool, { orgId: org.orgId }, (tx) => mcpServersForProject(tx, projectId));
    expect(job.map((s) => s.name)).toEqual(["context7", "playwright"]);
    const context7 = rules.find((r) => r.key === "context7");
    if (!context7) throw new Error("thiếu quy tắc context7");
    await as(owner(), (tx) => deleteServerRule(tx, owner(), registry, context7.id));
    expect(await errorCode(() => as(owner(), (tx) => deleteServerRule(tx, owner(), registry, context7.id)))).toBe(
      "MCP_SERVER_RULE_NOT_FOUND",
    );
    const audit = await admin.query(
      `select action, data from hive.audit_log where org_id = $1 and target_type = 'mcp_server_rule'
       and action <> 'mcp.server_rule_create' order by created_at`,
      [org.orgId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["mcp.server_rule_update", "mcp.server_rule_delete"]);
    expect(audit.rows[0]?.data).toMatchObject({ before: { rule: "allow" }, after: { rule: "deny" } });
  });

  it("kiểm tra đầu vào: mẫu phải khớp chính server, tên dành cho hub, trùng tên, dự án lạ, biến môi trường", async () => {
    const base = { rule: "allow" as const, projectId: null };
    expect(
      await errorCode(() =>
        create({ ...base, name: "Sentry", matchType: "name", pattern: "khac", launch: npx("@sentry/mcp") }),
      ),
    ).toBe("MCP_SERVER_SELF_MATCH");
    expect(
      await errorCode(() =>
        create({
          ...base,
          name: "xDev Hive",
          matchType: "wildcard",
          launch: { transport: "http", url: "https://x.io" },
        }),
      ),
    ).toBe("MCP_SERVER_RESERVED");
    expect(await errorCode(() => create({ ...base, name: "github", matchType: "name", launch: npx("other") }))).toBe(
      "MCP_SERVER_DUPLICATE",
    );
    expect(await errorCode(() => create({ ...base, name: "Shell", matchType: "name", launch: null }))).toBe(
      "MCP_SERVER_PATTERN",
    );
    expect(
      await errorCode(() =>
        create({ ...base, name: "Lạ", matchType: "name", pattern: "la", projectId: otherProjectId, launch: null }),
      ),
    ).toBe("PROJECT_NOT_FOUND");
    expect(
      await errorCode(() =>
        create({
          ...base,
          name: "Leak",
          matchType: "wildcard",
          launch: npx("server", `--token=\${HIVE_RUN_TOKEN}`),
        }),
      ),
    ).toBe("MCP_SERVER_INPUT");
  });

  it("thành viên không xem hay sửa được; vai trò tự tạo có mcp.servers thì được", async () => {
    const member = org.user("tmember");
    expect(await errorCode(() => as(member, (tx) => listServerRules(tx, member, registry)))).toBe("ORG_ROLE_REQUIRED");
    expect(
      await errorCode(() =>
        create(
          { name: "Shell", rule: "deny", matchType: "name", pattern: "shell", projectId: null, launch: null },
          member,
        ),
      ),
    ).toBe("ORG_ROLE_REQUIRED");
    const {
      rows: [role],
    } = await admin.query(
      `insert into hive.custom_roles (org_id, name, scope, permissions, created_by)
       values ($1, 'Quản lý MCP', 'org', '{mcp.servers}', $2) returning id`,
      [org.orgId, owner()],
    );
    await admin.query("insert into hive.member_custom_roles (role_id, org_id, user_id) values ($1, $2, $3)", [
      role.id,
      org.orgId,
      member,
    ]);
    const shell = await create(
      { name: "Shell", rule: "deny", matchType: "name", pattern: "shell", projectId: null, launch: null },
      member,
    );
    expect(shell.updatedBy).toBe(member);
  });

  it("tổ chức khác không thấy quy tắc, cũng không nhận server khi giao job", async () => {
    const otherOwner = other.user("owner");
    expect((await as(otherOwner, (tx) => listServerRules(tx, otherOwner, registry), other.orgId)).rules).toEqual([]);
    expect(await withTenant(pool, { orgId: other.orgId }, (tx) => mcpServersForProject(tx, projectId))).toEqual([]);
  });
});
