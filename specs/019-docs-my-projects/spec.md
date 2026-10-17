# Feature Specification: Cây tài liệu theo Đơn vị → Hệ thống → Dự án, mặc định "Dự án của tôi"

**Feature Branch**: `ai/DOCSMYPROJECTS`
**Ngày**: 2026-10-17
**Trạng thái**: Chủ dự án đã duyệt (2026-10-17)

## Vì sao làm

Tổ chức fis-hc có nhiều đơn vị con. Mỗi đơn vị có nhiều dự án. Trang Tài liệu hiện gom mọi tài liệu vào một cây:

- Cây gom theo repo (nhà tài liệu), không theo đơn vị hay dự án ([doc-tree.tsx](../../apps/web/src/pages/knowledge/doc-tree.tsx) `buildDocTree`).
- Mọi thư mục mở sẵn (`FolderRow`: `useState(true)`).
- Trang chỉ lọc theo trạng thái đồng bộ. Trang không lọc theo đội hay dự án.
- Người thuộc nhiều đội thấy tài liệu của mọi đội đó. Owner/admin tổ chức thấy tài liệu của mọi đội.

Kết quả: người làm dự án A phải lướt qua tài liệu của các dự án khác để tìm tài liệu của A.

Chủ dự án đã xác nhận: vấn đề là **xem bị rối**, không phải **cần giấu tài liệu**. Ai đang có quyền đọc tài liệu
thì vẫn giữ quyền đó.

## Mục tiêu

1. Trang Tài liệu gom cây theo cơ cấu: Chung toàn tổ chức → Đơn vị (đội) → Chung đơn vị → Hệ thống → Dự án → thư mục.
2. Trang Tài liệu mặc định chỉ hiện dự án mình là thành viên, cộng phần chung của tổ chức và của đơn vị.
3. Admin đội (trưởng đơn vị) thêm và gỡ thành viên dự án.

## Không làm (non-goals)

- KHÔNG ĐƯỢC đổi quyền đọc tài liệu. `canRead`, `visibleWhere`, `authorize` trong
  [knowledge/access.ts](../../apps/hub/src/modules/knowledge/access.ts) giữ nguyên.
- Không đổi tìm kiếm tài liệu (`docs.search`), agent/MCP, task, run, code review.
- Không có vai trò trong dự án. Thành viên dự án chỉ có hai trạng thái: là thành viên, không là thành viên.
- Không cho người dùng tự bấm tham gia hoặc rời dự án.
- Không gửi thông báo khi thêm hoặc gỡ thành viên dự án.

## Điều làm tính năng thất bại (anti-goals)

- Một người mất quyền đọc một tài liệu mà trước đây người đó đọc được.
- Bộ lọc "Tất cả" hiện ít hoặc nhiều tài liệu hơn trang hiện tại.
- Người chưa được xếp vào dự án nào thấy trang Tài liệu trống.
- Trang Tài liệu chỉ dùng được sau khi admin xếp xong thành viên cho mọi dự án.

## Hiện trạng: dùng lại, mở rộng, làm mới

| Phần | Hiện có | Việc cần làm |
|---|---|---|
| Cây phân cấp | `teams` → `systems` → `projects` ([tenancy/schema.ts](../../apps/hub/src/modules/tenancy/schema.ts), [catalog/schema.ts](../../apps/hub/src/modules/catalog/schema.ts)). Dự án không đổi đội sau khi tạo | Dùng lại |
| Phạm vi tài liệu | `docs.team_id`, `docs.project_id`; `DocSummary.scope` (`ScopeView`) | Dùng lại |
| API cây tài liệu | `docTree.list` ([docsync/routes/tree.ts](../../apps/hub/src/modules/docsync/routes/tree.ts) `listTree`). `DocTreeItem` không có `teamId`, `projectId` | Mở rộng: thêm `scope` |
| Danh sách tên | `teams.list`, `systems.list`, `projects.list` (web đã dùng ở [projects-page.tsx](../../apps/web/src/pages/projects-page.tsx)) | Dùng lại |
| Thành viên dự án | Chưa có. Task và run chỉ ghi `created_by`, không có người được giao | Làm mới |
| Quyền quản lý dự án | `allowWith(..., "projects.settings", () => requireTeamRole(..., "admin"), teamId)` (như `projectAccess` trong [docsync/homes.ts](../../apps/hub/src/modules/docsync/homes.ts)) | Dùng lại |
| Gỡ thành viên đội | `teamMembers.remove` ([tenancy/teams.ts](../../apps/hub/src/modules/tenancy/teams.ts)) xoá dòng `team_members` | Dùng lại qua khoá ngoại cascade |
| Cài đặt dự án | `SettingsSection` trong [project-settings-page.tsx](../../apps/web/src/pages/project-settings-page.tsx) | Thêm một section |
| Nhớ lựa chọn trong trình duyệt | Mẫu kho [org-store.ts](../../apps/web/src/lib/org-store.ts) (chịu được localStorage bị chặn) | Dùng lại cách làm |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Admin đội xếp thành viên dự án (Priority: P1)

Trưởng đơn vị HC1 (admin đội HC1) mở cài đặt dự án EMR. Người đó thêm 3 thành viên đội HC1 vào dự án EMR.

**Acceptance Scenarios**:

1. **Given** người dùng là admin đội sở hữu dự án, **When** người dùng thêm một thành viên đội vào dự án,
   **Then** người được thêm xuất hiện trong danh sách thành viên dự án và audit log ghi `project_member.add`.
2. **Given** người dùng có quyền tự tạo `projects.settings` ở đội đó, **When** người dùng thêm thành viên,
   **Then** hub cho phép như admin đội.
3. **Given** người dùng là thành viên đội nhưng không phải admin và không có `projects.settings`, **When** người dùng
   mở cài đặt dự án, **Then** người dùng xem được danh sách thành viên dự án và không thấy nút thêm hoặc gỡ.
4. **Given** một người không thuộc đội sở hữu dự án, **When** admin đội thử thêm người đó, **Then** hub từ chối với
   thông báo tiếng Việt yêu cầu thêm người đó vào đội trước.
5. **Given** admin đội gỡ một người khỏi dự án, **Then** audit log ghi `project_member.remove`.
6. **Given** admin đội gỡ một người khỏi đội, **Then** người đó không còn là thành viên của mọi dự án thuộc đội đó.

### User Story 2 - Mặc định chỉ thấy dự án của mình (Priority: P1)

Thành viên dự án EMR mở trang Tài liệu. Cây hiện: Chung toàn tổ chức, Đơn vị HC1 → Chung đơn vị, Hệ thống → Dự án
EMR. Cây không hiện HIS, LIS, PACS.

**Acceptance Scenarios**:

1. **Given** người dùng là thành viên của ít nhất một dự án, **When** người dùng mở trang Tài liệu lần đầu,
   **Then** bộ lọc là "Dự án của tôi".
2. **Given** bộ lọc "Dự án của tôi", **Then** cây hiện đúng ba nhóm tài liệu:
   - tài liệu cấp tổ chức (`team_id` null);
   - tài liệu cấp đội (`project_id` null) của mọi đội người dùng là thành viên trực tiếp (`team_members`);
   - tài liệu của các dự án người dùng là thành viên.
3. **Given** bộ lọc "Tất cả", **Then** cây hiện đúng tập tài liệu mà trang hiện tại hiện cho người dùng đó.
4. **Given** người dùng không là thành viên của dự án nào, **When** người dùng mở trang lần đầu, **Then** bộ lọc là
   "Tất cả".
5. **Given** người dùng chọn một bộ lọc, **When** người dùng tải lại trang, **Then** trang giữ bộ lọc đó cho tổ chức
   đang làm việc.
6. **Given** người dùng mở link trực tiếp tới tài liệu của một dự án ngoài bộ lọc, **Then** tài liệu mở được như hiện
   nay.

### User Story 3 - Cây theo cơ cấu (Priority: P1)

**Acceptance Scenarios**:

1. **Given** bất kỳ bộ lọc nào, **Then** cây có thứ tự cấp: Chung toàn tổ chức → Đơn vị (tên đội) → Chung đơn vị →
   Hệ thống (tên hệ thống) → Dự án (tên dự án) → thư mục theo đường dẫn repo.
2. **Given** một nút không có tài liệu nào sau khi lọc, **Then** cây không hiện nút đó.
3. **Given** trang vừa mở, **Then** các nút trên đường tới mỗi dự án người dùng là thành viên (đơn vị, hệ thống, dự
   án) mở sẵn. Các nút khác đóng. Trang không có link mở sẵn một tài liệu (route `/knowledge/docs` không có tham số).
4. **Given** một tài liệu chưa có nhà (không gắn file repo), **Then** tài liệu nằm theo `scope` của nó, không nằm
   trong nhóm "Chưa có nhà" riêng.
5. **Given** bộ lọc trạng thái đồng bộ đang bật, **Then** bộ lọc trạng thái áp cùng lúc với bộ lọc phạm vi.

### Edge Cases

- Owner/admin tổ chức không là thành viên trực tiếp của đội nào: người đó không là thành viên dự án nào (FR-003), nên
  mặc định thấy "Tất cả" (US2-4).
- Owner/admin tổ chức muốn là thành viên dự án: phải được thêm vào đội trước (FR-003).
- Dự án đã lưu trữ (`state = archived`): xem mục "Để người làm quyết định".
- Tài liệu có `project_id` không có trong `projects.list` của người dùng: cây xếp tài liệu vào nút "Dự án khác"
  dưới đơn vị của tài liệu.
- Tài liệu cấp đội nằm trong repo của tổ chức (spec 018 US4): cây xếp theo `scope`, không theo repo.
- Đội đổi tên hoặc slug: cây lấy tên theo `teamId`, nên tài liệu không đổi chỗ.

## Requirements *(mandatory)*

### Functional Requirements

**Dữ liệu**

- **FR-001**: Hub PHẢI lưu thành viên dự án trong bảng mới `hive.project_members` thuộc module `catalog`: `org_id`,
  `project_id`, `team_id`, `user_id`, `added_by`, `created_at`. Khoá chính: (`project_id`, `user_id`).
- **FR-002**: Bảng `project_members` PHẢI bật và ép RLS với policy `project_members_rw` theo `hive.ctx_org()`.
  `rls.db.test.ts` PHẢI có bảng này.
- **FR-003**: Bảng PHẢI có khoá ngoại (`team_id`, `user_id`) → `team_members` (`team_id`, `user_id`) với
  `on delete cascade`. Khoá ngoại này bảo đảm thành viên dự án là thành viên đội, và gỡ khỏi đội thì gỡ khỏi dự án.
- **FR-004**: Bảng PHẢI có khoá ngoại (`project_id`, `org_id`, `team_id`) → `projects` (unique `projects_id_org_team`)
  với `on delete cascade`.
- **FR-005**: Khoá ngoại sang bảng của module khác (`team_members`) PHẢI viết tay trong migration, như các khoá ngoại
  hiện có của `projects`.

**API** (trong `packages/contracts`, chạy `pnpm openapi` và commit `openapi.json`)

- **FR-010**: Hub PHẢI có `projectMembers.list({ project })`. Người đọc được dự án PHẢI gọi được.
- **FR-011**: Hub PHẢI có `projectMembers.add({ project, userIds })` và `projectMembers.remove({ project, userId })`.
  Hai thao tác PHẢI kiểm quyền bằng `allowWith(..., "projects.settings", requireTeamRole(..., "admin"), teamId)`.
- **FR-012**: `projectMembers.add` PHẢI từ chối người không thuộc đội sở hữu dự án, với thông báo lỗi tiếng Việt.
  Thêm người đã là thành viên PHẢI không lỗi và không ghi trùng.
- **FR-013**: `add` và `remove` PHẢI ghi audit `project_member.add`, `project_member.remove` với `userId`.
- **FR-014**: Web PHẢI lấy được bằng một request cho cả tổ chức: tập id dự án mình là thành viên, và tập id đội mình
  là thành viên trực tiếp (`team_members`). `teamRolesOf` và `projects.list` coi owner/admin tổ chức là thành viên mọi
  đội, nên hai nguồn này không dùng được.
- **FR-015**: `DocTreeItem` PHẢI có `scope: ScopeView` lấy từ `docs.team_id`, `docs.project_id`. Với đính kèm có tài
  liệu sở hữu (`owner_doc_id`), `scope` PHẢI lấy từ tài liệu sở hữu. Với đính kèm không có tài liệu sở hữu
  (`owner_doc_id` null), `scope` PHẢI lấy từ nhà: nhà dự án → đội và dự án của dự án đó; nhà tổ chức → cấp tổ chức.
- **FR-016**: Thay đổi API PHẢI chỉ thêm trường hoặc thêm route. KHÔNG ĐƯỢC đổi nghĩa của trường đang có.

**Trang Tài liệu**

- **FR-020**: Trang Tài liệu PHẢI có bộ lọc phạm vi hai lựa chọn: "Dự án của tôi", "Tất cả". Trang KHÔNG ĐƯỢC có
  lựa chọn "Cả đơn vị": với thành viên thường, "Cả đơn vị" hiện đúng tập tài liệu của "Tất cả", vì thành viên thường
  chỉ đọc được đội mình thuộc (`canRead` trong [access.ts](../../apps/hub/src/modules/knowledge/access.ts)).
- **FR-021**: Bộ lọc phạm vi PHẢI chỉ lọc ở giao diện. Bộ lọc KHÔNG ĐƯỢC đổi quyền đọc ở hub.
- **FR-022**: Trang PHẢI nhớ bộ lọc theo tổ chức trong trình duyệt. Trang PHẢI chạy đúng khi localStorage bị chặn.
- **FR-023**: Cây PHẢI gom theo thứ tự cấp ở User Story 3, kịch bản 1.
- **FR-024**: Danh sách tài liệu đã lưu trữ PHẢI dùng cùng cách gom và cùng bộ lọc.
- **FR-025**: Cách gom và bộ lọc PHẢI chỉ áp cho `DocTree` trên trang Tài liệu. `useDocTree` PHẢI vẫn trả mọi item:
  [doc-editor-page.tsx](../../apps/web/src/pages/knowledge/doc-editor-page.tsx) dùng nó để lấy trạng thái đồng bộ
  của tài liệu đang mở, kể cả tài liệu ngoài bộ lọc.

**Cài đặt dự án**

- **FR-030**: Trang cài đặt dự án PHẢI có section "Thành viên dự án": danh sách tên, email, ngày thêm.
- **FR-031**: Người có quyền ở FR-011 PHẢI thêm được nhiều người một lần, chọn từ thành viên đội sở hữu dự án.
- **FR-032**: Người có quyền ở FR-011 PHẢI gỡ được từng người.
- **FR-033**: Người không có quyền ở FR-011 PHẢI chỉ xem danh sách.

**Dữ liệu cũ**

- **FR-040**: Migration PHẢI thêm người tạo dự án (`projects.created_by`) làm thành viên của dự án đó, khi người tạo
  vẫn là thành viên đội sở hữu dự án.
- **FR-041**: Tạo dự án mới PHẢI thêm người tạo làm thành viên, khi người tạo là thành viên đội.

### Key Entities

- **Thành viên dự án** (`project_members`): một người thuộc đội sở hữu, được admin đội xếp vào một dự án. Thành viên
  dự án chỉ dùng để chọn tài liệu hiện mặc định. Thành viên dự án không mang quyền.
- **Bộ lọc phạm vi**: lựa chọn hiển thị của mỗi người, lưu trong trình duyệt theo tổ chức.

## Success Criteria *(mandatory)*

- **SC-001**: Với bộ lọc "Tất cả", tập `key` tài liệu trên cây bằng tập `key` của trang hiện tại, cho cùng người dùng
  và cùng dữ liệu. Test web hoặc e2e PHẢI kiểm điều này.
- **SC-002**: Với bộ lọc "Dự án của tôi", cây không có tài liệu của dự án người dùng không tham gia. Test e2e PHẢI
  kiểm với ít nhất 2 đội và 2 dự án mỗi đội.
- **SC-003**: Gỡ một người khỏi đội làm danh sách thành viên dự án của người đó trong đội về 0. Test `*.db.test.ts`
  PHẢI kiểm điều này.
- **SC-004**: `pnpm check` xanh, gồm `rls.db.test.ts` và `pnpm deps`.
- UNKNOWN: chưa có ngưỡng thời gian tải trang Tài liệu. Chủ dự án chưa đưa số liệu.

## Chủ dự án đã quyết định

1. Vấn đề là xem bị rối. Không giấu tài liệu, không đổi quyền đọc.
2. Cây theo Đơn vị → Hệ thống → Dự án (mockup B), mặc định "Dự án của tôi" (mockup C).
3. Admin đội (trưởng đơn vị) thêm và gỡ thành viên dự án.
4. Lần này chỉ tách tài liệu.
5. Bộ lọc chỉ có hai lựa chọn: "Dự án của tôi", "Tất cả". Người chưa thuộc dự án nào mặc định thấy "Tất cả".

## Quyết định của người viết (chủ dự án cần xem lại)

Các quyết định sau không do chủ dự án nói. Người viết chọn để bản thiết kế đủ chi tiết:

1. Thành viên dự án phải là thành viên đội (FR-003). Owner/admin tổ chức muốn là thành viên dự án thì phải vào đội.
2. Migration thêm người tạo dự án làm thành viên (FR-040), để "Dự án của tôi" không trống ngay khi phát hành.
3. "Chung đơn vị" trong "Dự án của tôi" lấy từ đội mình là thành viên trực tiếp (US2-2), không tính quyền admin mọi
   đội của owner/admin tổ chức.
4. Bộ lọc lưu trong trình duyệt, không lưu ở hub. Đổi máy thì về mặc định.
5. Tìm kiếm tài liệu không theo bộ lọc phạm vi.
6. Bỏ nhóm "Chưa có nhà"; tài liệu chưa có nhà nằm theo `scope`.
7. Đặt spec ở `specs/019-docs-my-projects/` theo cách đánh số của repo, không ở `docs/superpowers/specs/`.
8. Chỉ làm web. Cây tài liệu của app desktop (`DocFolders` trong `apps/desktop/src/screens/write-screen.tsx`) giữ
   nguyên, làm sau nếu cần.
9. Đính kèm không có tài liệu sở hữu nằm theo nhà (FR-015).
10. Không thêm link mở sẵn một tài liệu trên trang Tài liệu (US3-3).

## Để người làm quyết định

- Hình dạng request ở FR-014: route riêng (ví dụ `projectMembers.mine`) hay thêm trường vào `projects.list`.
- Cách hiện dự án đã lưu trữ trong cây.
- Cách hiện tên repo trên nút dự án (dòng phụ, tooltip, hoặc không hiện).
- Tên và vị trí bộ lọc trên trang, theo design system hiện có.

## Out of Scope

- Chặn quyền đọc theo dự án (`role_bindings` ở [architecture.md](../../docs/architecture.md) §3 vẫn chưa làm).
- Bộ lọc "Dự án của tôi" cho trang task, run, dự án, code review.
- Tự bấm tham gia dự án.
- Cây tài liệu của app desktop.
