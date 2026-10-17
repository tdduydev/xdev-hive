# Cây tài liệu theo đơn vị và "Dự án của tôi" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trang Tài liệu gom cây theo Đơn vị → Hệ thống → Dự án và mặc định chỉ hiện dự án mình là thành viên. Admin
đội quản lý thành viên dự án.

**Architecture:** Hub thêm bảng `hive.project_members` (module `catalog`), 4 route `projectMembers.*`, và trường
`scope` trên `DocTreeItem`. Web lọc và gom cây hoàn toàn ở giao diện, từ dữ liệu `docTree.list` + `docs.list` đã có.
Quyền đọc tài liệu ở hub giữ nguyên.

**Tech Stack:** Hono + oRPC, drizzle-orm + Postgres RLS, zod (`packages/contracts`), React + TanStack Query, vitest,
Playwright (`apps/web/e2e`, fake hub).

**Spec:** [specs/019-docs-my-projects/spec.md](spec.md)

## Global Constraints

- KHÔNG ĐƯỢC sửa `canRead`, `visibleWhere`, `authorize` trong `apps/hub/src/modules/knowledge/access.ts` (FR-021).
- Chữ trên giao diện và thông báo lỗi viết tiếng Việt. Commit message viết tiếng Anh, kết thúc bằng
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Import file TypeScript ghi rõ đuôi `.ts`/`.tsx`. Web import bằng alias `@/…`. Hub giữ import tương đối.
- Module hub chỉ import module khác qua `index.ts` của module đó (`pnpm deps` kiểm).
- Bảng mới bật và ép RLS, có `GRANT SELECT, INSERT, UPDATE, DELETE` và `REVOKE TRUNCATE` cho `hive_app`.
- Đổi `packages/contracts` thì chạy `pnpm openapi` và commit `openapi.json` trong cùng commit.
- API chỉ thêm trường hoặc thêm route, không đổi nghĩa trường đang có (FR-016).
- Comment giải thích vì sao, không giải thích cái gì.
- Máy Windows của chủ dự án: dùng `corepack pnpm`; test `*.db.test.ts` cần
  `HIVE_TEST_POSTGRES_IMAGE=public.ecr.aws/docker/library/postgres:18-trixie TESTCONTAINERS_RYUK_DISABLED=true`.
  `docsync/roundtrip.test.ts` và `scm/local.test.ts` hỏng sẵn do CRLF, không phải lỗi của thay đổi.
- Lệnh test trong plan viết dạng `pnpm --filter <gói> exec vitest run <file>`; thêm tiền tố env ở trên khi chạy test DB.

## Review Focus

1. Bộ lọc đã lưu là "Dự án của tôi" nhưng người dùng không còn thuộc dự án nào → trang hiện "Tất cả", không trống
   (Task 4: `defaultFilter`).
2. Tên đội, hệ thống hoặc dự án chưa tải xong hoặc không có trong danh sách → cây vẫn hiện bằng nhãn dự phòng, không
   lỗi (Task 4: `buildScopeTree`).
3. Admin đội A thêm hoặc gỡ thành viên dự án của đội B → hub từ chối (Task 2).
4. `userIds` có một người ngoài đội (kể cả người của tổ chức khác) → hub từ chối cả lô, không ghi ai (Task 2).
5. Danh sách "Đã lưu trữ" (chỉ có `DocSummary`, không có nhà) → gom theo `scope`, không có nhóm "Chưa có nhà"
   (Task 4).

---

### Task 1: Bảng `project_members`, migration, RLS

**Files:**
- Modify: `apps/hub/src/modules/catalog/schema.ts` (thêm bảng sau `projects`)
- Create: `apps/hub/db/migrations/0078_<tên drizzle sinh>.sql` + file trong `apps/hub/db/migrations/meta/`
- Create: `apps/hub/src/modules/catalog/rls.db.test.ts`

**Interfaces:**
- Produces: `projectMembers` (drizzle table) export từ `catalog/schema.ts`, cột `projectId`, `orgId`, `teamId`,
  `userId`, `addedBy`, `createdAt`.

- [ ] **Step 1: Viết test RLS hỏng**

`catalog/rls.db.test.ts` dựng 2 tổ chức bằng `seedOrg` (`test/org-fixture.ts`) và mỗi tổ chức 1 dự án bằng
`seedProject` (`test/project-fixture.ts`), chèn 1 dòng `project_members` cho mỗi tổ chức bằng superuser (`admin`).

```ts
it("không có context thì project_members trả 0 dòng", ...)            // withTenant(app, {}) → length 0
it("context tổ chức A chỉ thấy thành viên dự án của A", ...)          // mọi dòng có orgId === orgA
it("không ghi được thành viên dự án vào tổ chức khác", ...)           // pgCode(...) === "42501"
it("khoá ngoại chặn người không thuộc đội", ...)                       // insert user "loner" bằng admin → "23503"
it("gỡ khỏi đội thì mất thành viên dự án", ...)                         // delete team_members → 0 dòng project_members
```

- [ ] **Step 2: Chạy test, thấy hỏng**

Run: `pnpm --filter @xdev-hive/hub exec vitest run src/modules/catalog/rls.db.test.ts`
Expected: FAIL (bảng `hive.project_members` chưa có).

- [ ] **Step 3: Thêm bảng vào `catalog/schema.ts`**

```ts
export const projectMembers = hive
  .table(
    "project_members",
    {
      projectId: uuid("project_id").notNull(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      userId: text("user_id").notNull(),
      addedBy: text("added_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.projectId, t.userId] }),
      foreignKey({
        columns: [t.projectId, t.orgId, t.teamId],
        foreignColumns: [projects.id, projects.orgId, projects.teamId],
      }).onDelete("cascade"),
      index("project_members_user").on(t.orgId, t.userId),
      orgScoped("project_members"),
    ],
  )
  .enableRLS();
```

Comment trên bảng: thành viên dự án chỉ chọn tài liệu hiện mặc định, không mang quyền (spec 019).

- [ ] **Step 4: Sinh migration**

Run: `pnpm --filter @xdev-hive/hub db:generate`
Expected: một file `0078_*.sql` mới có `CREATE TABLE "hive"."project_members"`, policy `project_members_rw`, khoá ngoại
tới `projects`.

- [ ] **Step 5: Viết tay phần cuối của migration**

Nối vào cuối file `0078_*.sql`, mỗi lệnh cách nhau `--> statement-breakpoint`, theo mẫu `0074_docs_repo_sync.sql`:

1. `FORCE ROW LEVEL SECURITY`, `GRANT SELECT, INSERT, UPDATE, DELETE ... TO hive_app`, `REVOKE TRUNCATE ... FROM hive_app`.
2. `ADD CONSTRAINT project_members_team_member_fk FOREIGN KEY (team_id, user_id) REFERENCES hive.team_members (team_id, user_id) ON DELETE CASCADE` (FR-003, FR-005).
3. Điền dữ liệu cũ (FR-040). Chủ bảng cũng chịu FORCE RLS, nên tắt FORCE trên `hive.projects` và `hive.team_members`
   trong transaction migration, chèn, rồi bật lại:

```sql
INSERT INTO hive.project_members (project_id, org_id, team_id, user_id, added_by)
SELECT p.id, p.org_id, p.team_id, p.created_by, p.created_by
  FROM hive.projects p
  JOIN hive.team_members m ON m.team_id = p.team_id AND m.user_id = p.created_by;
```

Bước điền dữ liệu đặt trước lệnh `FORCE` của `project_members`.

- [ ] **Step 6: Chạy test RLS của module và của tenancy**

Run: `pnpm --filter @xdev-hive/hub exec vitest run src/modules/catalog/rls.db.test.ts src/modules/tenancy/rls.db.test.ts`
Expected: PASS. Test "mọi bảng trong schema hive đều bật và ép RLS" của tenancy cũng pass với bảng mới.

- [ ] **Step 7: Commit**

```bash
git add apps/hub/src/modules/catalog/schema.ts apps/hub/src/modules/catalog/rls.db.test.ts apps/hub/db/migrations
git commit -m "feat(catalog): add project_members table with RLS"
```

---

### Task 2: API thành viên dự án

**Files:**
- Modify: `packages/contracts/src/projects.ts` (schema + `projectMembersContract`)
- Modify: `packages/contracts/src/index.ts` (đăng ký `projectMembers: projectMembersContract`)
- Modify: `apps/hub/src/modules/tenancy/permissions.ts`, `apps/hub/src/modules/tenancy/index.ts`
- Create: `apps/hub/src/modules/catalog/members.ts`
- Modify: `apps/hub/src/modules/catalog/router.ts`, `apps/hub/src/modules/catalog/index.ts`, `apps/hub/src/app.ts`
- Modify: `apps/hub/src/modules/catalog/projects.ts` (`createProject`: thêm người tạo, FR-041)
- Modify: `openapi.json`
- Test: `apps/hub/src/modules/catalog/members.db.test.ts`

**Interfaces:**
- Consumes: `projectMembers` (Task 1).
- Produces (contracts):

```ts
export const projectMember = z.object({
  userId: z.string(), name: z.string(), email: z.string(), image: z.string().nullable(),
  addedBy: z.string(), addedAt: z.iso.datetime(),
});
export const projectMembership = z.object({ projectIds: z.array(id), teamIds: z.array(id) });
export const projectMembersContract = {
  list:   orgRoute("GET",    "/v1/projects/{id}/members", …).input(z.object({ id })).output(z.array(projectMember)),
  add:    orgRoute("POST",   "/v1/projects/{id}/members", …)
            .input(z.object({ id, userIds: z.array(z.string().min(1)).min(1).max(100) })).output(z.array(projectMember)),
  remove: orgRoute("DELETE", "/v1/projects/{id}/members/{userId}", …)
            .input(z.object({ id, userId: z.string().min(1) })).output(z.object({ ok: z.literal(true) })),
  mine:   orgRoute("GET",    "/v1/project-members/mine", …).input(z.object({})).output(projectMembership),
};
export type ProjectMember = z.output<typeof projectMember>;
export type ProjectMembership = z.output<typeof projectMembership>;
```

  `mine` dùng tiền tố riêng để không trùng mẫu `/v1/projects/{id}`. Mô tả route viết tiếng Việt, tag `"projects"`.
- Produces (hub, `catalog/members.ts`):
  - `listProjectMembers(tx: Tx, userId: string, projectId: string): Promise<ProjectMember[]>`
  - `addProjectMembers(tx: Tx, userId: string, projectId: string, userIds: string[]): Promise<ProjectMember[]>`
  - `removeProjectMember(tx: Tx, userId: string, projectId: string, memberId: string): Promise<{ ok: true }>`
  - `myProjectMembership(tx: Tx, userId: string): Promise<ProjectMembership>`
  - `addCreatorAsMember(tx: Tx, project: { id: string; teamId: string }, userId: string): Promise<void>`
- Produces (tenancy): `directTeamIds(tx: Tx, userId: string): Promise<string[]>` và
  `directTeamMembers(tx: Tx, teamId: string, userIds: string[]): Promise<Set<string>>`. Hai hàm chỉ đọc
  `team_members`, không cộng owner/admin tổ chức như `teamRolesOf`/`teamMemberIds`.

- [ ] **Step 1: Viết test hỏng** (`members.db.test.ts`, dùng `seedOrg` + `seedProject`, gọi thẳng hàm trong
  `withTenant`)

```ts
it("admin đội thêm thành viên đội vào dự án và ghi audit", ...)
//   addProjectMembers(tadmin, p, [tmember]) → [{ userId: tmember, addedBy: tadmin }]; audit_log có action "project_member.add"
it("thêm lại người đã là thành viên không lỗi, không trùng", ...)        // gọi 2 lần → list length 1, audit 1 dòng
it("từ chối cả lô khi có người ngoài đội", ...)
//   add(tadmin, p, [tmember, loner]) → errorCode === "PROJECT_MEMBER_NOT_IN_TEAM"; list rỗng
//   add(tadmin, p, [người dùng của tổ chức khác]) → cùng mã lỗi; list rỗng
it("thành viên thường và viewer chỉ xem được", ...)
//   list(tviewer) ok; add(tmember) → errorCode "TEAM_ROLE_REQUIRED"
it("vai trò tự tạo projects.settings của đội được thêm", ...)            // gán custom role cho tmember → add ok
it("admin đội khác không quản lý được dự án đội này", ...)
//   thêm tadmin2 làm admin của otherTeamId; add(tadmin2, p, …) → errorCode "PROJECT_NOT_FOUND"
it("gỡ thành viên và ghi audit; gỡ người không phải thành viên báo PROJECT_MEMBER_NOT_FOUND", ...)
it("mine trả dự án mình tham gia và đội mình là thành viên trực tiếp", ...)
//   myProjectMembership(tmember) → { projectIds: [p], teamIds: [teamId] }
//   myProjectMembership(owner) → { projectIds: [], teamIds: [] }   // owner tổ chức không ở team_members
it("tạo dự án thêm người tạo làm thành viên khi người tạo thuộc đội", ...)
//   addCreatorAsMember(p, tadmin) → member; addCreatorAsMember(p, owner) → không thêm, không lỗi
```

- [ ] **Step 2: Chạy test, thấy hỏng**

Run: `pnpm --filter @xdev-hive/hub exec vitest run src/modules/catalog/members.db.test.ts`
Expected: FAIL (module `./members.ts` chưa có).

- [ ] **Step 3: Thêm contract, chạy `pnpm openapi`**

- [ ] **Step 4: Thêm `directTeamIds`, `directTeamMembers` vào `tenancy/permissions.ts`, export qua `tenancy/index.ts`**

- [ ] **Step 5: Viết `catalog/members.ts`**

- Đọc dự án bằng `loadProject`. Người gọi không có vai trò đội (`teamRoleOf`) → `NotFoundError("PROJECT_NOT_FOUND",
  "Không tìm thấy dự án trong tổ chức.")`, như `projectFor`.
- `add`/`remove` kiểm quyền bằng
  `allowWith(tx, userId, "projects.settings", () => requireTeamRole(tx, userId, project.teamId, "admin"), project.teamId)`.
- `add`: người ngoài đội → `BadRequestError("PROJECT_MEMBER_NOT_IN_TEAM", "<tên> chưa thuộc đội. Thêm người này vào
  đội trước.")`. Kiểm hết trước khi ghi. Chèn bằng `onConflictDoNothing`; chỉ ghi audit cho dòng mới chèn.
- `remove`: không có dòng → `NotFoundError("PROJECT_MEMBER_NOT_FOUND", "Người này không phải thành viên dự án.")`.
- Audit: `recordAudit(tx, { action: "project_member.add" | "project_member.remove", targetType: "project",
  targetId: projectId, data: { userId } })`.
- Tên, email, ảnh lấy bằng join `authUser` như `teamMembers.list` trong `tenancy/teams.ts`.
- `addCreatorAsMember`: chỉ chèn khi `directTeamMembers` có người tạo, vì khoá ngoại sẽ làm hỏng cả transaction tạo dự án.

- [ ] **Step 6: Gắn router và gọi `addCreatorAsMember` trong `createProject`**

`catalog/router.ts` export `projectMembersRouter(deps: CatalogDeps & OrgDeps)` (dùng `implement(contract.projectMembers)`
+ `inOrg`), `catalog/index.ts` export nó, `app.ts` gắn `projectMembers: projectMembersRouter({ ...shared, jobs, publicUrl })`
cạnh `projects`. Trong `createProject`, gọi `addCreatorAsMember(tx, { id, teamId: p.system.teamId }, actor.userId)`
ngay sau khi chèn `projectProvisionSteps`.

- [ ] **Step 7: Chạy test**

Run: `pnpm --filter @xdev-hive/hub exec vitest run src/modules/catalog/members.db.test.ts src/modules/catalog/projects.db.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts openapi.json apps/hub/src
git commit -m "feat(catalog): let team admins manage project members"
```

---

### Task 3: `scope` trên `DocTreeItem`

**Files:**
- Modify: `packages/contracts/src/doc-sync.ts:391` (`docTreeItem` thêm `scope: scopeView`), `openapi.json`
- Modify: `apps/hub/src/modules/docsync/routes/tree.ts` (`TreeRow`, câu SQL `listTree`, `treeItem`)
- Modify: `apps/web/src/pages/knowledge/doc-tree.tsx` (`withUnhomedDocs` chép `doc.scope`)
- Modify: các nơi dựng `DocTreeItem` trong test: `apps/web/src/pages/knowledge/doc-tree.test.tsx` (`item`),
  `apps/web/e2e/docsync-docs-fixture.ts` (`makeItem`) và mọi fixture e2e khác gọi `docTreeItem.parse`
  (tìm bằng `rg "docTreeItem" apps/web/e2e`)
- Test: `apps/hub/src/modules/docsync/sync.db.test.ts`

**Interfaces:**
- Consumes: `scopeView` từ `packages/contracts/src/knowledge.ts` (đã dùng cho `DocSummary.scope`).
- Produces: `DocTreeItem.scope: ScopeView` (bắt buộc).

- [ ] **Step 1: Viết test hỏng** trong `sync.db.test.ts`, cạnh các test `listTree` hiện có:

```ts
it("cây trả scope của tài liệu và của đính kèm", ...)
//   tài liệu project/<key>/a → scope { level: "project", teamId, projectId }
//   tài liệu org/b trong nhà tổ chức → { level: "org", teamId: null, projectId: null }
//   đính kèm có owner_doc_id → scope của tài liệu sở hữu
//   đính kèm owner_doc_id null trong nhà dự án → { level: "project", teamId của dự án, projectId của nhà }
//   đính kèm owner_doc_id null trong nhà tổ chức → { level: "org", … null }
```

- [ ] **Step 2: Chạy test, thấy hỏng**

Run: `pnpm --filter @xdev-hive/hub exec vitest run src/modules/docsync/sync.db.test.ts -t "scope"`
Expected: FAIL (`scope` undefined).

- [ ] **Step 3: Sửa contract và `listTree`**

SQL lấy thêm `team_id`, `project_id` (của `d` hoặc `o`) và `owned boolean` (`a.owner_doc_id is not null`).
`treeItem` dựng `scope` bằng `scopeView`-cùng-quy-tắc với `knowledge` (level theo `projectId` → `teamId` → org).
Đính kèm không có chủ: lấy từ nhà; nhà dự án cần `teamId` của dự án → đọc một lần cho mọi nhà dự án trong trang bằng
`findProject` hoặc một câu `select id, team_id from hive.projects where id = any(...)`.
Không đổi điều kiện hiện tài liệu (`visible(...)`).

- [ ] **Step 4: Cập nhật fixture web và `withUnhomedDocs`**, rồi chạy `pnpm openapi`.

`makeItem` trong `docsync-docs-fixture.ts` nhận thêm `scope`; ba tài liệu hiện có là `org/...` → scope org.

- [ ] **Step 5: Chạy test**

Run: `pnpm --filter @xdev-hive/hub exec vitest run src/modules/docsync/sync.db.test.ts` và
`pnpm --filter @xdev-hive/web test` và `pnpm --filter @xdev-hive/web typecheck` (hoặc `pnpm check` ở gốc).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts openapi.json apps/hub/src/modules/docsync apps/web
git commit -m "feat(docsync): return each tree item's scope"
```

---

### Task 4: Logic lọc và gom cây (web, thuần)

**Files:**
- Create: `apps/web/src/pages/knowledge/doc-scope.ts`
- Create: `apps/web/src/pages/knowledge/doc-scope.test.ts`
- Modify: `apps/web/src/pages/knowledge/doc-tree.tsx` (tách `buildDocTree` thành `folderOf`, export type `Folder`)

**Interfaces:**
- Consumes: `DocTreeItem.scope` (Task 3), `ProjectMembership` (Task 2).
- Produces:

```ts
export type DocScopeFilter = "mine" | "all";
export interface MyMembership { projectIds: ReadonlySet<string>; teamIds: ReadonlySet<string> }
export interface ScopeNames {
  teams: ReadonlyMap<string, string>;                                   // teamId → tên
  systems: ReadonlyMap<string, { name: string; teamId: string }>;
  projects: ReadonlyMap<string, { name: string; systemId: string; teamId: string }>;
}
export type ScopeNodeKind = "org" | "team" | "team-common" | "system" | "project" | "other-projects";
export interface ScopeNode {
  kind: ScopeNodeKind; id: string; name: string; count: number;
  children: ScopeNode[]; folder: Folder | null;                           // folder chỉ có ở nút lá
}
export function defaultFilter(stored: DocScopeFilter | null, m: MyMembership): DocScopeFilter;
export function inFilter(item: DocTreeItem, filter: DocScopeFilter, m: MyMembership): boolean;
export function buildScopeTree(items: DocTreeItem[], names: ScopeNames): ScopeNode[];
export function openByDefault(nodes: ScopeNode[], m: MyMembership): Set<string>;   // id nút mở sẵn
// doc-tree.tsx
export function folderOf(items: DocTreeItem[], name: string, path: string): Folder;
```

Quy tắc đã chốt:
- `defaultFilter`: `m.projectIds` rỗng → `"all"` (kể cả khi `stored === "mine"`); không thì `stored ?? "mine"`.
- `inFilter("mine")`: `scope.teamId === null`, hoặc (`projectId === null` và `m.teamIds` có `teamId`), hoặc
  `m.projectIds` có `projectId`. `inFilter("all")` luôn `true`.
- Thứ tự gốc: nút `org` ("Chung toàn tổ chức") trước, rồi các nút `team` theo tên. Trong nút `team`: `team-common`
  ("Chung đơn vị") trước, rồi `system` theo tên, rồi `other-projects` ("Dự án khác") cuối. Trong `system`: `project`
  theo tên.
- Thiếu tên: đội không có trong `names.teams` → tên "Đơn vị khác"; dự án không có trong `names.projects` → nằm trong
  `other-projects` của đội.
- Nút không còn tài liệu thì không có trong cây. `count` = số item `kind === "doc"` trong nhánh.
- `id` của nút: `org`, `team:<teamId>`, `team-common:<teamId>`, `system:<systemId>`, `project:<projectId>`,
  `other:<teamId>`.
- `folder` của nút lá dựng bằng `folderOf(items, name, id)`, tách theo `item.path ?? item.key ?? item.title` như
  `buildDocTree` hiện nay.
- `openByDefault`: id của mỗi nút `project` có trong `m.projectIds` và mọi nút cha của nó. Nút khác, gồm cả thư mục
  repo, đóng.

- [ ] **Step 1: Viết test hỏng** (`doc-scope.test.ts`, không cần jsdom)

```ts
it("mặc định Dự án của tôi khi có dự án, Tất cả khi không có", ...)
//   defaultFilter(null, {projectIds:{p1}}) === "mine"; defaultFilter("mine", {projectIds:{}}) === "all"
//   defaultFilter("all", {projectIds:{p1}}) === "all"
it("Dự án của tôi giữ tài liệu chung tổ chức, chung đơn vị của đội mình và dự án mình", ...)
//   org doc → true; team doc của t1 (m.teamIds có t1) → true; team doc t2 → false; doc p1 → true; doc p2 → false
it("gom theo đơn vị, hệ thống, dự án đúng thứ tự và bỏ nút rỗng", ...)
//   kinds theo thứ tự: ["org", "team"(A), "team"(B)]; team A children: ["team-common", "system"(S1)]; S1 → ["project"(P1)]
it("dùng nhãn dự phòng khi thiếu tên", ...)
//   teamId lạ → name "Đơn vị khác"; projectId lạ → nằm trong "other-projects" tên "Dự án khác"
it("đính kèm nằm cùng dự án với tài liệu, count chỉ đếm tài liệu", ...)
it("tài liệu đã lưu trữ chưa có nhà vẫn gom theo scope", ...)
//   items từ withUnhomedDocs([], summaries) → không có nút tên "Chưa có nhà"
it("mở sẵn đường tới dự án của tôi, đóng phần còn lại", ...)
//   openByDefault(...) === new Set(["team:A", "system:S1", "project:P1"])
```

- [ ] **Step 2: Chạy test, thấy hỏng**

Run: `pnpm --filter @xdev-hive/web exec vitest run src/pages/knowledge/doc-scope.test.ts`
Expected: FAIL (module chưa có).

- [ ] **Step 3: Viết `doc-scope.ts`, tách `folderOf` trong `doc-tree.tsx`**

- [ ] **Step 4: Chạy test**

Run: `pnpm --filter @xdev-hive/web exec vitest run src/pages/knowledge`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/knowledge
git commit -m "feat(web): group docs by unit, system and project"
```

---

### Task 5: Trang Tài liệu dùng cây mới và bộ lọc

**Files:**
- Create: `apps/web/src/lib/doc-scope-store.ts`, `apps/web/src/lib/doc-scope-store.test.ts`
- Modify: `apps/web/src/pages/knowledge/doc-tree.tsx` (`DocTree` vẽ `ScopeNode[]`)
- Modify: `apps/web/src/pages/knowledge/docs-page.tsx`
- Modify: `apps/web/src/pages/knowledge/doc-tree.test.tsx`
- Modify: `apps/web/e2e/docsync-docs.spec.ts`, `apps/web/e2e/knowledge.spec.ts`, `apps/web/e2e/docsync-docs-fixture.ts`
- Create: `apps/web/e2e/docs-scope.spec.ts`

**Interfaces:**
- Consumes: Task 4 (`defaultFilter`, `inFilter`, `buildScopeTree`, `openByDefault`), `api.projectMembers.mine`
  (Task 2), `api.teams.list`, `api.systems.list`, `api.projects.list`.
- Produces:

```ts
// doc-scope-store.ts — theo mẫu createOrgStore, dùng lại KeyValueStorage của org-store.ts
export const DOC_SCOPE_STORAGE_PREFIX = "hive.docScope.";
export function createDocScopeStore(storage: KeyValueStorage | null): {
  get(orgId: string): DocScopeFilter | null;
  set(orgId: string, filter: DocScopeFilter): void;
};
export const docScopeStore: ReturnType<typeof createDocScopeStore>;
// doc-tree.tsx
export function DocTree(props: {
  nodes: ScopeNode[]; open: ReadonlySet<string>;
  selectedKey?: string | undefined; onSelect: (item: DocTreeItem) => void; archived?: boolean;
}): JSX.Element;
```

Quyết định giao diện:
- Tên nhóm điều khiển: "Phạm vi tài liệu"; hai lựa chọn "Dự án của tôi", "Tất cả". Dùng component có sẵn trong
  `@xdev-hive/ui` (người làm chọn component).
- Cây đổi tên truy cập từ "Cây tài liệu theo repo" thành "Cây tài liệu". Mỗi nút cấp hiện `name` và `(count)`.
- Nút dự án hiện tên repo (`repoLabel`) ở dòng phụ.
- Bộ lọc trạng thái đồng bộ chạy trước, bộ lọc phạm vi chạy sau, rồi mới gom cây.
- `useDocTree` giữ nguyên; `doc-editor-page.tsx` không đổi (FR-025).

- [ ] **Step 1: Viết test store hỏng** (`doc-scope-store.test.ts`)

```ts
it("nhớ bộ lọc theo tổ chức", ...)                 // set("o1","all"); get("o1")==="all"; get("o2")===null
it("vẫn chạy khi localStorage ném lỗi", ...)       // storage.getItem/setItem throw → get trả null, set không ném
it("bỏ giá trị lạ trong storage", ...)             // getItem trả "xyz" → get trả null
```

- [ ] **Step 2: Chạy, thấy hỏng; viết `doc-scope-store.ts`; chạy lại thấy pass**

Run: `pnpm --filter @xdev-hive/web exec vitest run src/lib/doc-scope-store.test.ts`

- [ ] **Step 3: Sửa test component `doc-tree.test.tsx` cho `DocTree` mới (hỏng trước)**

```ts
it("đóng mở nút cấp và thư mục, chọn file kèm nhãn PR", ...)
//   render với open = {"org"}; thấy "Chung toàn tổ chức (1)"; thư mục "docs" đóng sẵn → bấm "Mở thư mục docs"
//   → thấy "PR #128 đang mở"; bấm file → onSelect gọi với key "org/guide"
```

- [ ] **Step 4: Viết `DocTree` mới và nối `docs-page.tsx`**

`docs-page.tsx`: đọc `projectMembers.mine` → `MyMembership`; bộ lọc ban đầu = `defaultFilter(docScopeStore.get(org.id), m)`;
đổi bộ lọc thì `docScopeStore.set`. Đang tải `mine` thì coi là `"all"` để trang không trống.
`open` ban đầu = `openByDefault(...)`, người dùng bấm thì đổi trong state.
Danh sách đã lưu trữ đi cùng đường: `withUnhomedDocs([], list.data)` → lọc → `buildScopeTree` (FR-024).
`doc-scope.ts` chỉ `import type { Folder }` từ `doc-tree.tsx` cho kiểu, để hai file không vòng import lúc chạy;
`folderOf` là giá trị nên `doc-tree.tsx` chỉ được `import type` từ `doc-scope.ts`.

- [ ] **Step 5: Cập nhật e2e cũ và thêm `docs-scope.spec.ts`**

Fake hub cần thêm `projectMembers/mine`, `systems/list`, `projects/list` trong fixture. Locator
`"Cây tài liệu theo repo"` đổi thành `"Cây tài liệu"`; kiểm "Chưa có nhà" trong `docsync-docs.spec.ts` đổi thành kiểm
tài liệu chưa có nhà nằm dưới "Chung toàn tổ chức".

```ts
test("mặc định Dự án của tôi, đổi sang Tất cả và nhớ qua lần tải lại", ...)
//   2 đội × 2 dự án; mine = { projectIds: [P1], teamIds: [A] }
//   thấy "Dự án P1", không thấy "Dự án P2", "Dự án Q1"; chọn "Tất cả" → thấy cả 4; reload → vẫn "Tất cả"
test("người chưa thuộc dự án nào mặc định thấy Tất cả", ...)
test("bộ lọc trạng thái đồng bộ áp cùng bộ lọc phạm vi", ...)
//   "Dự án của tôi" + trạng thái "Lỗi" → chỉ còn tài liệu lỗi của P1 (US3-5)
test("Tất cả hiện đúng tập tài liệu như trước", ...)
//   so tập key trên cây (filter "all") với tập key fixture trả về (SC-001)
```

- [ ] **Step 6: Chạy test**

Run: `pnpm --filter @xdev-hive/web test` và
`pnpm --filter @xdev-hive/web test:e2e -- docs-scope.spec.ts docsync-docs.spec.ts knowledge.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): default the docs tree to my projects"
```

---

### Task 6: Section "Thành viên dự án" trong cài đặt dự án

**Files:**
- Create: `apps/web/src/pages/project-members-section.tsx`
- Modify: `apps/web/src/pages/project-settings-page.tsx` (thêm section vào `SettingsEditor`)
- Create: `apps/web/e2e/project-members.spec.ts`

**Interfaces:**
- Consumes: `api.projectMembers.list/add/remove` (Task 2), `api.teamMembers.list({ teamId })`, `usePermissions`
  (`apps/web/src/lib/permissions.ts`), `SettingsSection` (`apps/web/src/components/page/settings.tsx`).
- Produces: `ProjectMembersSection(props: { project: Project; canManage: boolean }): JSX.Element`.

Quyết định giao diện:
- Section `id="members"`, tiêu đề "Thành viên dự án", mô tả: "Thành viên thấy dự án trong mục Dự án của tôi ở trang
  Tài liệu. Không đổi quyền xem."
- Hiện cho mọi người đọc được dự án (`canBrief` hiện có). `canManage = canEdit || can("projects.settings")`.
- Danh sách: tên, email, ngày thêm. `canManage` thì mỗi dòng có nút "Gỡ" và có ô chọn nhiều người từ thành viên đội
  chưa ở trong dự án, nút "Thêm".
- Lỗi từ hub hiện bằng `apiErrorMessage`.

- [ ] **Step 1: Viết e2e hỏng** (`project-members.spec.ts`, fake hub)

```ts
test("admin đội thêm và gỡ thành viên dự án", ...)
//   inOrg(page, "member", rpc) với orgMembers cho thấy mình là admin đội; mở /projects/<key>/settings
//   chọn 2 người, bấm "Thêm" → request projectMembers/add có userIds đúng 2 id; danh sách có 2 dòng
//   bấm "Gỡ" ở 1 dòng → request projectMembers/remove; danh sách còn 1 dòng
test("thành viên thường chỉ xem danh sách", ...)                 // không có nút "Thêm", "Gỡ"
test("hiện lỗi khi hub từ chối người ngoài đội", ...)            // add trả PROJECT_MEMBER_NOT_IN_TEAM → hiện thông báo
```

- [ ] **Step 2: Chạy, thấy hỏng**

Run: `pnpm --filter @xdev-hive/web test:e2e -- project-members.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Viết `ProjectMembersSection`, gắn vào `SettingsEditor`**

- [ ] **Step 4: Chạy test**

Run: `pnpm --filter @xdev-hive/web test:e2e -- project-members.spec.ts projects-runs.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): manage project members in project settings"
```

---

### Task 7: Kiểm toàn nhánh

- [ ] **Step 1:** Run: `pnpm check` ở gốc repo. Expected: PASS (ngoài 2 test CRLF đã biết trên máy Windows).
- [ ] **Step 2:** Run: `pnpm openapi` rồi `git status --short openapi.json`. Expected: không có thay đổi.
- [ ] **Step 3:** Trên database dev đã có dữ liệu, chạy `pnpm --filter @xdev-hive/hub db:migrate`, rồi bằng superuser:
  `select count(*) from hive.project_members` và so với
  `select count(*) from hive.projects p join hive.team_members m on m.team_id = p.team_id and m.user_id = p.created_by`.
  Expected: hai số bằng nhau (FR-040).
