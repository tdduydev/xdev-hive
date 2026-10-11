import { sql } from "drizzle-orm";
import { foreignKey, pgPolicy, pgRole, pgSchema, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { authUser } from "../identity/index.ts";

export const hive = pgSchema("hive");
// Role tạo ở bước bootstrap (cần quyền superuser), migration chỉ tham chiếu.
export const hiveApp = pgRole("hive_app").existing();
const hiveOwner = pgRole("hive_owner").existing();

export const orgRole = hive.enum("org_role", ["owner", "admin", "member"]);
export const memberStatus = hive.enum("member_status", ["active", "pending", "blocked"]);
export const teamRole = hive.enum("team_role", ["admin", "member", "viewer"]);
/** Người đăng nhập SSO lần đầu: vào hàng chờ duyệt (pending) hay thành thành viên ngay (member). */
export const ssoJoin = hive.enum("sso_join", ["pending", "member"]);

const inOrg = sql`org_id = hive.ctx_org()`;
/** Policy chuẩn cho bảng thuộc một tổ chức: đọc và ghi chỉ trong tổ chức của context. */
const orgScoped = (name: string) => [
  pgPolicy(`${name}_rw`, { as: "permissive", for: "all", to: hiveApp, using: inOrg, withCheck: inOrg }),
];

export const orgs = hive
  .table(
    "orgs",
    {
      id: uuid("id").primaryKey(),
      slug: text("slug").notNull().unique(),
      name: text("name").notNull(),
      emailDomain: text("email_domain"),
      ssoJoin: ssoJoin("sso_join").notNull().default("pending"),
      createdBy: text("created_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    () => [
      // Thấy tổ chức đang làm việc, và mọi tổ chức mình là thành viên (để chọn tổ chức khi đăng nhập).
      pgPolicy("orgs_select", {
        for: "select",
        to: hiveApp,
        using: sql`id = hive.ctx_org() or exists (select 1 from hive.org_members m where m.org_id = orgs.id and m.user_id = hive.ctx_user() and m.status = 'active')`,
      }),
      // Tạo tổ chức: app sinh id trước rồi đặt nó làm context, nên WITH CHECK vẫn chặn ghi sang tổ chức khác.
      pgPolicy("orgs_insert", { for: "insert", to: hiveApp, withCheck: sql`id = hive.ctx_org()` }),
      pgPolicy("orgs_update", {
        for: "update",
        to: hiveApp,
        using: sql`id = hive.ctx_org()`,
        withCheck: sql`id = hive.ctx_org()`,
      }),
      // Hàm hive.any_org() (SECURITY DEFINER, chủ là hive_owner) cần biết hub đã có tổ chức nào chưa để quyết định
      // ai được tạo tổ chức. FORCE RLS áp cả lên chủ bảng nên phải cho hive_owner đọc; hive_app không được gì thêm.
      pgPolicy("orgs_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();

export const orgMembers = hive
  .table(
    "org_members",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => orgs.id, { onDelete: "cascade" }),
      userId: text("user_id")
        .notNull()
        .references(() => authUser.id, { onDelete: "cascade" }),
      role: orgRole("role").notNull().default("member"),
      status: memberStatus("status").notNull().default("active"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.userId] }),
      pgPolicy("org_members_select", {
        for: "select",
        to: hiveApp,
        using: sql`org_id = hive.ctx_org() or user_id = hive.ctx_user()`,
      }),
      pgPolicy("org_members_write", { for: "insert", to: hiveApp, withCheck: inOrg }),
      pgPolicy("org_members_update", { for: "update", to: hiveApp, using: inOrg, withCheck: inOrg }),
      pgPolicy("org_members_delete", { for: "delete", to: hiveApp, using: inOrg }),
    ],
  )
  .enableRLS();

export const teams = hive
  .table(
    "teams",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id")
        .notNull()
        .references(() => orgs.id, { onDelete: "cascade" }),
      slug: text("slug").notNull(),
      name: text("name").notNull(),
      color: text("color"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("teams_org_slug").on(t.orgId, t.slug),
      // Khoá kép để bảng con không thể trỏ tới đội của tổ chức khác.
      unique("teams_id_org").on(t.id, t.orgId),
      ...orgScoped("teams"),
    ],
  )
  .enableRLS();

export const teamMembers = hive
  .table(
    "team_members",
    {
      teamId: uuid("team_id").notNull(),
      orgId: uuid("org_id").notNull(),
      userId: text("user_id")
        .notNull()
        .references(() => authUser.id, { onDelete: "cascade" }),
      role: teamRole("role").notNull().default("member"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.teamId, t.userId] }),
      foreignKey({ columns: [t.teamId, t.orgId], foreignColumns: [teams.id, teams.orgId] }).onDelete("cascade"),
      ...orgScoped("team_members"),
    ],
  )
  .enableRLS();

export const systems = hive
  .table(
    "systems",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      slug: text("slug").notNull(),
      name: text("name").notNull(),
      description: text("description"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("systems_team_slug").on(t.teamId, t.slug),
      foreignKey({ columns: [t.teamId, t.orgId], foreignColumns: [teams.id, teams.orgId] }).onDelete("cascade"),
      ...orgScoped("systems"),
    ],
  )
  .enableRLS();

export const invitations = hive
  .table(
    "invitations",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id")
        .notNull()
        .references(() => orgs.id, { onDelete: "cascade" }),
      email: text("email").notNull(),
      orgRole: orgRole("org_role").notNull().default("member"),
      teamId: uuid("team_id"),
      teamRole: teamRole("team_role"),
      // Chỉ lưu băm của mã mời; mã gốc chỉ hiện một lần cho người tạo.
      tokenHash: text("token_hash").notNull().unique(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      acceptedAt: timestamp("accepted_at", { withTimezone: true }),
      acceptedBy: text("accepted_by"),
      createdBy: text("created_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    () => [
      pgPolicy("invitations_select", {
        for: "select",
        to: hiveApp,
        using: sql`org_id = hive.ctx_org() or token_hash = hive.ctx_invite()`,
      }),
      pgPolicy("invitations_insert", { for: "insert", to: hiveApp, withCheck: inOrg }),
      pgPolicy("invitations_update", { for: "update", to: hiveApp, using: inOrg, withCheck: inOrg }),
      pgPolicy("invitations_delete", { for: "delete", to: hiveApp, using: inOrg }),
    ],
  )
  .enableRLS();
