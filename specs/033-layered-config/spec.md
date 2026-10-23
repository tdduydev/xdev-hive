# Feature Specification: Cấu hình theo tầng: toàn hệ thống → công ty → phòng ban/đội → dự án

**Feature Branch**: `ai/SPEC033`

**Created**: 2026-10-23

**Status**: Draft. Có 3 câu hỏi mở (đều có khuyến nghị, spec đã viết theo khuyến nghị).

**Input**: Chủ dự án (2026-10-23): "cấu hình chung cho all và cấu hình theo từng cty, phòng ban, dự án".

## Vì sao làm

Hub chỉ giữ dữ liệu và tiến độ, không chạy agent (spec 027). Client (desktop, `hive-worker`) làm việc trên máy người dùng và đọc cấu hình hiệu lực từ hub.

Hiện nay cấu hình có hai tầng và không đồng nhất:

1. **Chỉ có công ty và dự án.** Chính sách agent nằm ở công ty. Dự án chỉ được thu hẹp (`resolvePermission`, `clampBudget`). Đội (team) có và mỗi dự án thuộc một đội, nhưng đội **không có cấu hình riêng** (trừ chế độ SDLC và skill tự tạo).
2. **Không có tầng "cho cả hệ thống".** Cái gần nhất là biến môi trường (`HubConfig`), đổi phải khởi động lại hub.
3. **Mỗi loại một luật gộp.** Gói skill: dự án ghi đè tự do. MCP: cộng dồn, chặn thắng. Sandbox: công ty có cờ `locked`. Spec 030: công ty là trần. Tính năng mới lại tự nghĩ luật.
4. **Không thấy giá trị đến từ đâu.** Admin phải mở nhiều trang mới đoán được vì sao run dùng model hay quyền đó.

Spec này đưa **một mô hình tầng chung**: bốn tầng, ba kiểu gộp, khoá ở tầng trên, xem giá trị hiệu lực kèm nguồn, audit, và cách client lấy và giữ cấu hình khi hub vắng.

**Ràng buộc:** không đổi hành vi hệ đang chạy (FR-070). Không thêm quyền chạy agent cho hub. Không đổi mô hình hub–client của spec 027.

## Câu hỏi mở

Spec đã viết theo cột "Khuyến nghị".

| # | Câu hỏi | Khuyến nghị | Ghi ở |
|---|---|---|---|
| Q1 | Ai là quản trị toàn hệ thống? Hiện hub không có vai trò này | Danh sách email trong biến môi trường `HIVE_INSTANCE_ADMINS` (mặc định lấy từ `HIVE_ORG_CREATORS`), không thêm vai trò trong database | FR-050, FR-051 |
| Q2 | "Phòng ban" là đội hiện có, hay thêm cấp mới trên đội? | Là đội hiện có, một cấp, không lồng nhau | FR-030, Out of Scope |
| Q3 | Nới giá trị nguy hiểm ở tầng hệ thống hoặc công ty có cần hai người duyệt? | Chưa. Dùng quyền nguy hiểm `policies.fullaccess` có sẵn, cộng audit | FR-043 |

## Hiện trạng: dùng lại, mở rộng, làm mới

Đã kiểm trong code ngày 2026-10-23:

| Phần | Có gì | Spec này |
|---|---|---|
| Chính sách agent của công ty | Bảng `agent_policies`, mỗi công ty một dòng JSON (`governance/schema.ts`, `policies.ts`). Quyền `policies.write`; toàn quyền cần thêm `policies.fullaccess` | **Tầng công ty**. Không đổi cách lưu |
| Dự án thu hẹp chính sách | `resolveModel`, `resolvePermission`, `clampBudget`, `machineSlots` | Dùng lại, gom thành kiểu **trần** (FR-016) |
| Cấu hình dự án | Cột `projects.settings` (`catalog/settings.ts`, `projectSettings`): `runPermissions`, `models`, `merge`, `outcome`, `features`, `issueIntake`, `tokenSaving`, `routing`, `devOptimizer`, `defaultCli`, `budget`. Quyền `projects.settings` hoặc quản trị đội | **Tầng dự án** |
| Đội | `teams`, `team_members` (`admin/member/viewer/ba`). Dự án có `team_id` và `system_id` bắt buộc | Dùng lại. **Chưa có cấu hình cấp đội**: làm mới |
| Hệ thống (system) | `systems` thuộc một đội | Không phải tầng cấu hình |
| Gói skill | `skill_pack_settings`: công ty và dự án, dự án thắng | Đổi luật theo kiểu ghi đè, thêm tầng đội và khoá |
| Quy tắc MCP ngoài | `mcp_server_rules` có `project_id` null là công ty; deny thắng | Giữ luật, thêm tầng đội |
| Sandbox | `sandbox_org_settings.locked`; `egress_allowlists` | **Tiền lệ cho khoá**, tổng quát hoá (FR-020) |
| Chế độ SDLC | `sdlc_modes` cấp công ty hoặc đội; `autoApprove` chỉ ở công ty | Thêm tầng đội cho tự duyệt |
| Thông báo | `notification_channels` chỉ công ty | Giữ (Out of Scope) |
| Chi phí | `limits.perRunUsd/dailyUsd` ở công ty, `budget` ở dự án | Thêm tầng đội và hệ thống |
| Plugin (030), bí mật (031) | Mới là spec | Khai báo kiểu gộp theo mục này khi làm |
| Cấu hình toàn hệ thống | Chỉ `HubConfig` từ biến môi trường (`platform/config.ts`). Không có bảng, màn hình, vai trò | **Tầng hệ thống làm mới** (US5) |
| Audit | `recordAudit` trong cùng transaction (`audit/record.ts`) | Dùng lại, thêm tầng và đối tượng |
| Gửi cấu hình xuống máy | Mỗi job mang `policy`; desktop đọc `policies.get` qua `hub_rpc` | Mở rộng thành **ảnh chụp cấu hình hiệu lực** (US6) |
| Hộp thư đi, hub vắng | Spec 027: hộp thư chỉ cho **ghi**. Đọc không có bộ đệm (FR-013) | Cấu hình là đọc nên có bộ đệm riêng, có hạn (FR-062) |

## Khái niệm

- **Tầng**: từ rộng đến hẹp: **Hệ thống**, **Công ty** (org), **Đội** (team, cũng gọi là phòng ban), **Dự án**. Mỗi dự án thuộc một đội, mỗi đội thuộc một công ty.
- **Cài đặt**: một mục cấu hình có khoá ổn định, ví dụ `agent.allowFullPermission`.
- **Kiểu gộp** (mỗi cài đặt đúng một):
  - **Trần**: tầng dưới chỉ thu hẹp. Ví dụ cờ cho phép, số tối đa, danh sách model.
  - **Ghi đè**: tầng dưới thay giá trị của tầng trên, trong miền hợp lệ.
  - **Cộng dồn**: tầng dưới thêm mục, không gỡ được mục của tầng trên. "Chặn" thắng "cho phép".
- **Khoá**: tầng trên cấm tầng dưới đổi một cài đặt ghi đè hoặc cộng dồn. Giá trị tầng dưới vẫn lưu nhưng không áp dụng.
- **Giá trị hiệu lực** và **nguồn**: kết quả gộp bốn tầng cho một dự án, và tầng đã quyết định.
- **Vượt trần**: tầng dưới đặt rộng hơn trần mới của tầng trên. Hiệu lực hạ về trần, giá trị đã lưu giữ nguyên, có nhãn.
- **Ảnh chụp cấu hình**: giá trị hiệu lực của một dự án tại một lúc, có `configVersion`, gửi cho client.

## Kiểm kê cài đặt

H = hệ thống, C = công ty, Đ = đội, D = dự án.

| Nhóm | Cài đặt | Hiện tại | Tầng cho phép đặt | Kiểu gộp |
|---|---|---|---|---|
| Agent | `allowedModels` | C | H, C, Đ, D | Trần (giao danh sách) |
| Agent | `neverAutoUpgrade`, `requireSandbox`, `managedHooksOnly` | C | H, C, Đ | Trần (bật là bật) |
| Agent | `allowFullPermission` | C (D thu hẹp) | H, C, Đ | Trần |
| Agent | `defaultPermissionMode`, `runPermissions` | C, D | C, Đ, D | Ghi đè, trong trần |
| Agent | `hooks` | C | H, C, Đ | Cộng dồn |
| Agent | `templates`, `autoSyncTemplates` | C | C, Đ | Ghi đè |
| Agent | `agentMemory`, `skillLearning` | C | C, Đ, D | Trần (mức thấp nhất thắng) |
| Agent | `remote.totpFallback` | C | H, C | Trần (chỉ tắt được) |
| Giới hạn | `perRunUsd`, `dailyUsd` | C; D có `budget` | H, C, Đ, D | Trần (số nhỏ nhất) |
| Giới hạn | `maxParallelPerMachine`, `runLogRetentionDays` | C | H, C | Trần |
| SDLC | `autoApprove` | C | H, C, Đ, D | Trần cho cờ và ngưỡng, cộng dồn cho danh sách cấm |
| SDLC | chế độ SDLC của dự án | C/Đ có chế độ, D chọn | C, Đ, D | Ghi đè |
| Artifact | `artifacts` | C | C, Đ | Trần |
| Dự án | `merge` | D | C, Đ, D | Ghi đè; `requiredApprovals` có sàn |
| Dự án | `outcome` | D | C, Đ, D | Cộng dồn |
| Dự án | `features` | D | C, Đ, D | Ghi đè, trong trần "được phép" |
| Dự án | `issueIntake`, `defaultCli`, `models`, `routing`, `tokenSaving`, `devOptimizer` | D | C, Đ, D | Ghi đè |
| Skill | gói skill bật/tắt | C, D | C, Đ, D | Ghi đè |
| MCP | quy tắc server ngoài | C, D | H, C, Đ, D | Cộng dồn, chặn thắng |
| MCP | bật/tắt tool MCP của Hive | C | H, C | Trần |
| Sandbox | `egress_allowlists` | C, D | H, C, Đ, D | Cộng dồn, có khoá |
| Sandbox | `locked` | C | C | Cơ chế khoá (FR-020) |
| Sandbox | `env_images` | D | D | Chỉ dự án |
| Thông báo | kênh thông báo | C | C | Chỉ công ty |
| Plugin (030) | plugin được duyệt | spec | C, D | Trần |
| Bí mật (031) | `secretInjection` | spec | H, C, Đ | Trần (`deny` > `approve` > `allow`) |
| Vận hành | đăng ký email, `orgCreators`, `deliveryOutbound`, `notifyAllowPrivate`, `mcpAllowHttp`, `remoteTerminal`, giới hạn tài liệu | Biến môi trường | Giữ biến môi trường | Không phải cài đặt tầng (FR-052) |

Tóm tắt: khoảng 40 cài đặt. **Không cài đặt nào hiện có tầng đội hoặc tầng hệ thống.** Cài đặt chỉ ở công ty: thông báo. Chỉ ở dự án: `env_images`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Xem giá trị hiệu lực và biết nó đến từ đâu (Priority: P1)

Admin hỏi "vì sao run của dự án Payments không dùng được toàn quyền CLI?" Mở trang cấu hình hiệu lực, thấy `allowFullPermission` = tắt, nguồn "Công ty ACME", kèm chuỗi bốn tầng.

**Why this priority**: không xem được nguồn thì thêm tầng chỉ làm hệ khó hiểu hơn.

**Independent Test**: dự án có giá trị ở cả bốn tầng cho cùng một cài đặt. Trang hiện đúng giá trị cuối, tầng quyết định và giá trị ba tầng còn lại.

**Acceptance Scenarios**:

1. **Given** cài đặt có giá trị ở công ty và dự án, **When** mở hiệu lực, **Then** thấy giá trị cuối, tầng nguồn và giá trị từng tầng.
2. **Given** dự án đặt vượt trần, **When** mở hiệu lực, **Then** hiệu lực là trần, có nhãn "Vượt trần" kèm giá trị đã đặt.
3. **Given** cài đặt bị công ty khoá, **When** chủ dự án mở cấu hình dự án, **Then** ô nhập bị vô hiệu, ghi "Khoá bởi công ty".
4. **Given** thành viên không có quyền sửa, **Then** vẫn xem được giá trị và nguồn, không thấy giá trị lưu của tầng họ không có quyền xem (FR-044).

---

### User Story 2 - Admin công ty đặt mặc định và khoá (Priority: P1)

Admin công ty đặt `requireSandbox` bật, tắt `allowFullPermission`, khoá `merge.requireCi`. Từ run kế tiếp mọi dự án theo đó. Dự án đã đặt khác bị hạ về trần và đánh dấu "Vượt trần".

**Why this priority**: tầng đang có, chỗ phần lớn giá trị nằm.

**Independent Test**: công ty có ba dự án giá trị khác nhau. Đặt trần và khoá. Cả ba ra hiệu lực đúng luật.

**Acceptance Scenarios**:

1. **Given** công ty tắt `allowFullPermission`, **When** dự án `full` giao run, **Then** chạy ở `workspace` (hành vi hiện có).
2. **Given** công ty khoá `merge.requireCi`, **When** chủ dự án sửa mục đó, **Then** hub từ chối với mã ổn định, lý do tiếng Việt; giá trị đã lưu không bị xoá.
3. **Given** công ty mở khoá, **Then** giá trị dự án đã lưu áp dụng lại.
4. **Given** công ty thu hẹp trần, **When** lưu, **Then** trang liệt kê số dự án và đội sẽ "Vượt trần" để xem trước.

---

### User Story 3 - Đội (phòng ban) có cấu hình riêng (Priority: P1)

Trưởng phòng Data đặt model rẻ hơn, trần USD mỗi run thấp hơn công ty, và thêm một hook. Mọi dự án của đội (hiện có và mới) nhận cấu hình này, trừ mục công ty đã khoá.

**Why this priority**: tầng chủ dự án đòi, hiện chưa có.

**Independent Test**: đội có hai dự án. Đặt trần USD cho đội. Hai dự án ra trần mới; dự án đội khác không đổi.

**Acceptance Scenarios**:

1. **Given** đội đặt `perRunUsd = 5`, công ty 20, **Then** hiệu lực 5; dự án đặt 8 vẫn ra 5 và có nhãn "Vượt trần".
2. **Given** đội thêm hook H (cộng dồn), **Then** run trong đội chạy hook công ty rồi H; đội khác không chạy H.
3. **Given** công ty khoá một cài đặt ghi đè, **Then** mục đó chỉ đọc ở trang đội.
4. **Given** thành viên không phải quản trị đội, **Then** xem được nhưng không sửa.
5. **Given** đội còn dự án, **Then** hub chặn xoá đội (hành vi hiện có).

---

### User Story 4 - Dự án ghi đè trong phạm vi tầng trên cho phép (Priority: P1)

Chủ dự án chỉnh merge và model mặc định. Mỗi mục hiện giá trị thừa kế từ đâu, cho đặt riêng hoặc "Dùng giá trị thừa kế". Mục có trần chỉ chọn trong miền hẹp; mục khoá chỉ đọc.

**Why this priority**: hành vi hiện có, phải giữ.

**Independent Test**: dự án đặt `merge.mode = auto` rồi "Dùng giá trị thừa kế". Hiệu lực về giá trị đội hoặc công ty.

**Acceptance Scenarios**:

1. **Given** dự án đã ghi đè, **When** bấm "Dùng giá trị thừa kế", **Then** giá trị dự án bị gỡ khỏi bản lưu.
2. **Given** mục kiểu trần, **When** nhập rộng hơn trần, **Then** form báo trần, không lưu.
3. **Given** mục cộng dồn, **When** thêm một mục, **Then** vào danh sách thừa kế; không gỡ được mục tầng trên, mục thừa kế có nhãn nguồn.
4. **Given** cấu hình đổi khi có run đang chạy, **Then** run giữ ảnh chụp lúc nhận job (FR-063).

---

### User Story 5 - Quản trị hệ thống đặt mặc định và trần cho mọi công ty (Priority: P2)

Người vận hành hub muốn không công ty nào mở được toàn quyền CLI và log run không quá 90 ngày. Vào "Cấu hình hệ thống" đặt hai mục. Công ty thu hẹp thêm được, không vượt trần.

**Why this priority**: chủ dự án đòi "cấu hình chung cho all". P2 vì hub hiện phục vụ ít công ty.

**Independent Test**: hai công ty. Trần hệ thống `runLogRetentionDays = 90`. Công ty A đang 365 bị hạ về 90, nhãn "Vượt trần hệ thống"; B không đặt thì thừa kế 90.

**Acceptance Scenarios**:

1. **Given** người dùng trong danh sách quản trị hệ thống, **Then** sửa được; người khác không thấy trang.
2. **Given** hệ thống đặt mặc định (không trần), **When** tạo công ty mới, **Then** thừa kế; công ty cũ có giá trị riêng giữ.
3. **Given** hệ thống khoá, **Then** quản trị công ty thấy mục chỉ đọc "Khoá bởi hệ thống".
4. **Given** quản trị hệ thống, **Then** không đọc được dữ liệu công ty nào (chỉ số công ty bị ảnh hưởng).
5. **Given** cài đặt vận hành (biến môi trường), **Then** trang chỉ hiện giá trị, chỉ đọc (FR-052).

---

### User Story 6 - Client lấy cấu hình hiệu lực và dùng khi hub vắng (Priority: P1)

Desktop và `hive-worker` lấy ảnh chụp cấu hình của dự án mình làm. Mỗi job mang ảnh chụp lúc giao. Hub vắng thì dùng bản lưu trên đĩa, hiện "Cấu hình lấy lúc 09:12". Bản quá cũ thì chuyển sang giá trị an toàn.

**Why this priority**: cấu hình phải đến nơi agent chạy; phải khớp spec 027.

**Independent Test**: lấy ảnh chụp, tắt hub, khởi động lại máy: client vẫn áp cấu hình. Chỉnh đồng hồ tiến 15 ngày: mục nguy hiểm về giá trị an toàn và báo người dùng.

**Acceptance Scenarios**:

1. **Given** admin đổi cài đặt, **Then** client đang kết nối lấy bản mới trong 60 giây; client ngoại tuyến lấy khi kết nối lại.
2. **Given** hub vắng, ảnh chụp dưới 24 giờ, **Then** dùng, hiện thời điểm lấy.
3. **Given** ảnh chụp 24 giờ đến 14 ngày, **Then** dùng, kèm cảnh báo.
4. **Given** ảnh chụp quá 14 ngày, **Then** cài đặt mở rộng quyền về giá trị an toàn, cài đặt thu hẹp giữ nguyên, người dùng thấy lý do.
5. **Given** dự án đã liên kết hub nhưng chưa có ảnh chụp, **Then** áp giá trị an toàn (khớp spec 031 FR-053).
6. **Given** admin sửa cấu hình khi hub vắng, **Then** lỗi "Hub đang vắng", không vào hộp thư đi.
7. **Given** job giao với V1, cấu hình đổi V2 giữa chừng, **Then** run chạy hết với V1.

---

### User Story 7 - Biết ai đổi cấu hình gì, lúc nào, ở tầng nào (Priority: P2)

Sau sự cố, admin mở lịch sử cấu hình của dự án thấy từng thay đổi ở các tầng kèm trước/sau, lọc theo tầng, cài đặt, người, thời gian.

**Why this priority**: cấu hình ảnh hưởng quyền agent nên cần truy vết. P2 vì audit đã có.

**Independent Test**: sửa năm cài đặt ở bốn tầng bởi bốn người. Lịch sử hiện đúng năm dòng; không lộ secret.

**Acceptance Scenarios**:

1. **Given** thay đổi ở bất kỳ tầng, **Then** có một dòng audit cùng giao dịch: người, tầng, đối tượng, cài đặt, trước, sau.
2. **Given** chỉ khoá hoặc mở khoá, **Then** vẫn có dòng audit.
3. **Given** mở lịch sử dự án, **Then** thấy cả thay đổi ở tầng trên làm đổi hiệu lực (đánh dấu "từ tầng trên").
4. **Given** giá trị có thể chứa secret, **Then** được che như audit hiện có.
5. **Given** thay đổi tầng hệ thống, **Then** ghi nhật ký quản trị hệ thống và tóm tắt cho công ty bị ảnh hưởng.

---

### User Story 8 - Chuyển sang mô hình tầng, không đổi hành vi (Priority: P1)

Sau nâng cấp, mọi dự án ra đúng giá trị hiệu lực như trước. `sandbox_org_settings.locked` thành khoá tầng công ty. Đội và hệ thống chưa đặt gì.

**Why this priority**: sai ở đây đổi hành vi của run thật.

**Independent Test**: chụp giá trị hiệu lực mọi dự án trước nâng cấp (golden), nâng cấp, chụp lại. Giống từng byte, kể cả dự án có `settings` hỏng.

**Acceptance Scenarios**:

1. **Given** dữ liệu hiện có, **When** nâng cấp, **Then** golden không đổi.
2. **Given** công ty `locked = true`, **Then** dự án vẫn không thêm được mạng và mục mạng dự án đã có vẫn không áp.
3. **Given** client cũ, **When** gọi API chính sách hiện có, **Then** nhận đúng dạng cũ.
4. **Given** client cũ lưu trang chính sách, **Then** mục mới không bị xoá.

---

### User Story 9 - Chuyển dự án sang đội khác (Priority: P3)

Admin chuyển dự án từ đội A sang B. Trang xem trước cho biết cài đặt nào đổi hiệu lực.

**Why this priority**: hiếm nhưng làm đổi cấu hình hiệu lực nên cần kiểm soát.

**Independent Test**: chuyển sang đội có trần thấp hơn. Xem trước liệt kê đúng mục bị hạ; sau xác nhận hiệu lực đổi và có audit.

**Acceptance Scenarios**:

1. **Given** dự án thuộc đội A, **When** admin chọn đội B, **Then** thấy danh sách cài đặt đổi (cũ, mới, nguồn mới).
2. **Given** người chỉ quản trị đội A, **When** chuyển sang đội B mình không quản trị, **Then** bị từ chối.
3. **Given** chuyển đội, **Then** hệ thống (`system_id`) phải thuộc đội B, chưa chọn thì không xác nhận.
4. **Given** đã chuyển, **Then** run đang chạy giữ ảnh chụp cũ.

---

### Edge Cases

- **Tầng trên thu hẹp trần khi tầng dưới đã rộng hơn**: hiệu lực hạ, giá trị lưu giữ nguyên, nhãn "Vượt trần".
- **Hai trần ở hai tầng**: lấy chặt hơn (giao). Giao danh sách model rỗng: cảnh báo khi lưu, không chặn.
- **Danh sách model rỗng** nghĩa "không giới hạn" (hiện nay). Tầng không đặt khác tầng đặt rỗng: tầng không đặt bị bỏ qua.
- **Đặt ở tầng không cho phép**: API từ chối, giao diện ẩn.
- **Khoá nhưng tầng dưới trống**: hiệu lực là giá trị tầng khoá; khoá chỉ cấm đặt mới.
- **Đổi tên đội**: không đổi cấu hình.
- **Quản trị công ty cũng là quản trị hệ thống**: hai vai trò độc lập; trang nêu rõ đang sửa tầng nào.
- **Hai người sửa cùng lúc**: người sau nhận lỗi xung đột kèm phiên bản hiện tại.
- **Giá trị lưu không khớp schema**: dùng mặc định, ghi cảnh báo; không làm hub dừng giao run (như `loadPolicy`).
- **Client cũ không biết cài đặt mới**: bỏ qua; cài đặt mới mở rộng quyền mặc định tắt.
- **Đồng hồ máy lệch**: tuổi ảnh chụp tính theo đồng hồ đơn điệu từ lúc nhận; lệch quá 5 phút so với hub thì coi là cũ theo mốc 24 giờ.
- **Máy phục vụ hai công ty**: mỗi công ty có ảnh chụp và tuổi riêng. Công ty A vắng hub chỉ làm ảnh chụp của A cũ đi, không ảnh hưởng B. Dự án trùng khoá giữa hai công ty vẫn là hai ảnh chụp khác nhau.
- **Hub khôi phục về thời điểm cũ** (spec 027 FR-042): client thấy mã đời database đổi thì lấy lại ngay.

## Requirements *(mandatory)*

### Functional Requirements

**Mô hình tầng và kiểu gộp**

- **FR-001**: Hub PHẢI có sổ đăng ký cài đặt: khoá, kiểu gộp, tầng được đặt, mặc định, giá trị an toàn (nếu mở rộng quyền). Tính năng mới khai báo vào sổ, không tự viết luật gộp.
- **FR-002**: Có bốn tầng: hệ thống, công ty, đội, dự án. Hiệu lực của dự án là kết quả gộp bốn tầng, tính ở hub.
- **FR-003**: Tầng chưa có giá trị thì bị bỏ qua. Chưa tầng nào đặt thì dùng mặc định trong sổ, trùng mặc định đang dùng trong code.
- **FR-010**: Kiểu **trần**: tầng dưới chỉ lưu được giá trị không rộng hơn. Gộp lấy giá trị chặt nhất (số nhỏ nhất, "bật" thắng với cờ hạn chế, giao danh sách, mức thấp nhất của thang).
- **FR-011**: Kiểu **ghi đè**: tầng gần dự án nhất có giá trị thắng, nếu không bị khoá và trong miền hợp lệ.
- **FR-012**: Kiểu **cộng dồn**: hiệu lực là hợp các mục bốn tầng; "chặn" thắng "cho phép"; tầng dưới không gỡ mục tầng trên.
- **FR-013**: Tầng dưới đặt "dùng giá trị thừa kế" thì gỡ giá trị của mình.
- **FR-014**: Hub từ chối lưu giá trị rộng hơn trần hiện tại (mã lỗi ổn định, lý do tiếng Việt, nêu trần và tầng nguồn).
- **FR-015**: Giá trị đã lưu vượt trần (trần thu hẹp sau) giữ nguyên, hiệu lực là trần, có nhãn "Vượt trần" kèm tầng và đối tượng.
- **FR-016**: `resolveModel`, `resolvePermission`, `clampBudget`, `machineSlots` PHẢI thành trường hợp riêng của quy tắc trên (một đường tính). Kết quả và `notice` của run giữ nguyên.

**Khoá**

- **FR-020**: Tầng trên khoá được từng cài đặt ghi đè hoặc cộng dồn. `sandbox_org_settings.locked` PHẢI là một trường hợp của cơ chế này, giữ nguyên nghĩa.
- **FR-021**: Khoá hiệu lực với mọi tầng dưới. Khoá tầng trên thắng; tầng dưới không gỡ khoá tầng trên.
- **FR-022**: Giá trị tầng bị khoá giữ trong bản lưu, không áp dụng, hiện "Đang bị khoá". Mở khoá thì áp lại, không xoá gì.
- **FR-023**: Kiểu trần không cần khoá; giao diện không hiện nút khoá cho kiểu trần.
- **FR-024**: Mọi thay đổi khoá ghi audit (FR-080).

**Đội và ánh xạ dự án**

- **FR-030**: Tầng đội là đội (`teams`) hiện có, không lồng nhau (Q2). Quan hệ dự án–đội là nguồn duy nhất xác định tầng đội.
- **FR-031**: Chuyển dự án sang đội khác PHẢI: có quyền ở cả hai đội (hoặc quản trị công ty), chọn hệ thống thuộc đội đích, xem trước cài đặt đổi hiệu lực, ghi audit.
- **FR-032**: Cài đặt đội áp cho mọi dự án của đội, gồm dự án tạo sau. Xoá đội vẫn bị chặn khi còn dự án.
- **FR-033**: Dự án mới thừa kế ngay hiệu lực của đội và công ty, không sao chép giá trị.

**Hiển thị hiệu lực và quyền xem**

- **FR-040**: Hub trả hiệu lực của dự án, đội hoặc công ty; mỗi cài đặt kèm giá trị cuối, tầng và đối tượng nguồn, khoá, nhãn "Vượt trần", và (với người có quyền xem tầng) giá trị từng tầng.
- **FR-041**: Web có trang "Cấu hình hiệu lực" cho dự án, lọc theo nhóm, "khác mặc định", tìm theo tên.
- **FR-042**: Desktop hiện cùng thông tin cho dự án đang mở, kể cả thời điểm lấy ảnh chụp.
- **FR-043**: Nới giá trị nguy hiểm (toàn quyền CLI, tắt sandbox bắt buộc, `secretInjection = allow`) ở tầng hệ thống hoặc công ty cần `policies.fullaccess` (Q3).
- **FR-044**: Người xem chỉ thấy giá trị lưu của tầng họ có quyền xem: thành viên dự án thấy tầng dự án; thành viên đội thấy tầng đội; quản trị công ty thấy tầng công ty và đội; quản trị hệ thống thấy tầng hệ thống. Mọi người thấy hiệu lực và tên tầng nguồn.

**Quyền sửa từng tầng**

| Tầng | Ai sửa | Quyền dùng lại |
|---|---|---|
| Hệ thống | Quản trị hệ thống (Q1) | Mới: danh sách email trong biến môi trường |
| Công ty | Owner, admin hoặc vai trò tự tạo | `policies.write`, `sandbox.write`, `mcp.servers`, `sdlc.modes.write`, `costs.budget` |
| Đội | Quản trị đội, owner, admin công ty | `requireTeamRole(admin)`; thêm quyền lá `team.config.write` |
| Dự án | Quản trị đội sở hữu, người có `projects.settings` | `projects.settings` |

- **FR-050**: Quản trị hệ thống xác định theo danh sách email trong cấu hình triển khai, đọc lúc khởi động. Không có vai trò trong database. Log cảnh báo khi danh sách trống và có từ hai công ty (Q1).
- **FR-051**: Quản trị hệ thống KHÔNG tự có quyền trong công ty nào.
- **FR-052**: Cấu hình triển khai vẫn đặt bằng biến môi trường. Trang hệ thống hiện giá trị đang chạy, chỉ đọc.
- **FR-053**: Mỗi lần sửa kiểm quyền đúng tầng đang sửa.
- **FR-054**: Quyền lá `team.config.write` nằm mặc định trong vai trò quản trị đội, vai trò tự tạo cấp được.

**Client lấy và giữ cấu hình**

- **FR-060**: Hub cung cấp ảnh chụp cấu hình cho từng dự án mà người dùng hoặc máy có quyền: hiệu lực, nguồn, khoá, `configVersion`, phiên bản schema, thời điểm hub tạo, mã đời database.
- **FR-061**: Client lấy khi khởi động, kết nối lại, và khi `configVersion` đổi; đang kết nối thì trong 60 giây. Chỉ tải lại khi `configVersion` khác.
- **FR-062**: Client lưu ảnh chụp mới nhất trên đĩa (chỉ người dùng đó đọc, như hộp thư đi của spec 027). Hub vắng: dưới 24 giờ dùng; 24 giờ đến 14 ngày dùng kèm cảnh báo; quá 14 ngày (cùng hạn giữ hộp thư đi, spec 027 FR-015) cài đặt mở rộng quyền về giá trị an toàn, cài đặt thu hẹp giữ nguyên, người dùng thấy lý do.
- **FR-063**: Mỗi job mang ảnh chụp lúc giao. Run dùng ảnh chụp đó tới khi kết thúc và ghi vào bản ghi run.
- **FR-064**: Dự án đã liên kết hub mà chưa có ảnh chụp: áp giá trị an toàn (khớp spec 031 FR-053).
- **FR-065**: API đọc cấu hình không đi qua hộp thư đi. Sửa cấu hình khi hub vắng báo "Hub đang vắng", không xếp hàng.
- **FR-066**: Client không tự gộp tầng; hub là nơi duy nhất quyết định hiệu lực.
- **FR-067**: Client cũ bỏ qua cài đặt không biết; cài đặt mới mở rộng quyền mặc định tắt.
- **FR-068**: Ảnh chụp KHÔNG chứa secret.
- **FR-069**: Một máy có thể phục vụ hai công ty cùng lúc, trên cùng hub hoặc trên hai hub khác nhau (spec 034). Hiệu lực luôn tính theo **một công ty**. Ảnh chụp mang mã công ty và địa chỉ hub, client lưu và tra cứu theo từng đăng ký công ty (khoá: hub + công ty + dự án). Client không bao giờ gộp, thay thế hay dùng chung cấu hình giữa hai công ty; ảnh chụp thiếu hoặc sai công ty bị bỏ và coi như chưa có ảnh chụp (FR-064). Spec này không đổi cấu hình một-đăng-ký của worker (`worker/internal/config`); cách worker giữ nhiều đăng ký thuộc spec 034.

**Chuyển đổi**

- **FR-070**: Sau nâng cấp, hiệu lực mọi dự án và công ty hiện có PHẢI giống trước (so golden). Tầng hệ thống và đội ban đầu trống.
- **FR-071**: Dữ liệu hiện có không sao chép sang chỗ khác; mô hình tầng đọc từ chúng, hoặc có migration một chiều kiểm chứng được và có đường lui.
- **FR-072**: API chính sách và cấu hình dự án hiện có giữ dạng cũ ít nhất hai bản phát hành; lưu từ client cũ không xoá mục mới.
- **FR-073**: Migration chạy lại được, không khoá bảng lâu, không dừng vì `settings` hỏng.

**Audit**

- **FR-080**: Mọi thay đổi giá trị, khoá, mở khoá, chuyển đội ghi một dòng audit cùng giao dịch (người, tầng, đối tượng, khoá cài đặt, trước, sau). Dùng `recordAudit`.
- **FR-081**: Giá trị có thể chứa secret được che; quy tắc MCP chỉ ghi tên và kiểu.
- **FR-082**: "Lịch sử cấu hình" ở mỗi tầng, lọc theo cài đặt, người, thời gian, và chế độ "ảnh hưởng tới dự án này".
- **FR-083**: Thay đổi tầng hệ thống ghi nhật ký riêng; công ty bị ảnh hưởng nhận dòng tóm tắt, không có dữ liệu công ty khác.
- **FR-084**: Chính sách giữ audit hiện có áp cho các dòng này.

**Giao diện web**

- **FR-090**: Trang "Cấu hình hệ thống" cho quản trị hệ thống: trần, mặc định, khoá, phần triển khai chỉ đọc, danh sách công ty bị ảnh hưởng.
- **FR-091**: Tầng công ty: dùng lại `/admin/policies`; mỗi mục có nhãn nguồn, nút khoá (kiểu cho phép), trần từ hệ thống.
- **FR-092**: Tầng đội: trang "Cấu hình đội" trong "Đội và hệ thống", cùng bố cục, chỉ hiện cài đặt cho phép ở đội.
- **FR-093**: Tầng dự án: dùng lại trang cấu hình dự án; mỗi mục hiện giá trị thừa kế, nguồn, nút "Dùng giá trị thừa kế", chỉ đọc khi khoá.
- **FR-094**: Mọi form dùng chung một thành phần hiển thị nguồn, khoá, vượt trần.
- **FR-095**: Chữ giao diện và lỗi bằng tiếng Việt. Màn hẹp: chuỗi bốn tầng xếp dọc, không cuộn ngang.

### Key Entities

- **Cài đặt** (đăng ký): khoá, nhóm, kiểu gộp, tầng được đặt, miền hợp lệ, mặc định, giá trị an toàn, mức nguy hiểm.
- **Giá trị theo tầng**: cài đặt, tầng, đối tượng, giá trị, cờ khoá, người sửa, thời điểm, phiên bản.
- **Giá trị hiệu lực**: cài đặt, đối tượng xem, giá trị cuối, nguồn, khoá, nhãn vượt trần, chuỗi tầng.
- **Ảnh chụp cấu hình**: công ty, địa chỉ hub, dự án, `configVersion`, phiên bản schema, thời điểm tạo, mã đời database, bộ giá trị hiệu lực.
- **Sự kiện đổi cấu hình** (audit): người, tầng, đối tượng, cài đặt, trước, sau, loại.
- **Danh sách quản trị hệ thống**: email từ cấu hình triển khai.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Sau nâng cấp, 100% dự án và công ty hiện có cho hiệu lực giống trước (0 khác biệt), 0 run đang chạy đổi hành vi.
- **SC-002**: Admin tìm ra tầng quyết định một giá trị của dự án trong dưới 30 giây, trên một trang.
- **SC-003**: Với 100 phép thử ngẫu nhiên (bốn tầng, ba kiểu gộp, có và không khoá), hiệu lực khớp bảng luật; 0 trường hợp tầng dưới nới được trần.
- **SC-004**: Sau khi đổi cài đặt, 95% client đang kết nối dùng giá trị mới trong 60 giây; run đang chạy giữ giá trị cũ.
- **SC-005**: Tắt hub 3 giờ: 100% phiên trên máy đã có ảnh chụp tiếp tục đúng cấu hình; 0 phiên bị chặn chỉ vì không lấy được cấu hình.
- **SC-006**: Ảnh chụp quá 14 ngày: 100% cài đặt mở rộng quyền về giá trị an toàn.
- **SC-007**: 100% thay đổi cấu hình có đúng một dòng audit; 0 secret trong audit và ảnh chụp.
- **SC-008**: Một cài đặt mới kiểu trần thêm vào sổ có đủ giao diện xem nguồn, audit mà không viết thêm luật gộp hay màn hình riêng.
- **SC-009**: Đổi cấu hình ở tầng đội và thấy hiệu lực trên dự án của đội trong dưới 2 phút, không sửa từng dự án.

## Assumptions

- "Phòng ban" là đội (Q2), không lồng nhau.
- Quản trị hệ thống là danh sách email trong biến môi trường (Q1), cùng cách `HIVE_ORG_CREATORS`.
- Hub hiện phục vụ ít công ty; tầng hệ thống có giá trị thật khi có từ hai công ty. Vẫn làm P2.
- Run luôn dùng ảnh chụp lúc giao; không áp dụng ngay cho run đang chạy.
- Mốc 24 giờ và 14 ngày là mặc định hợp lý, chưa đo trên người dùng thật.
- Cấu hình cá nhân trên máy (giao diện, phím tắt) không thuộc tầng nào.
- Plugin (030) và bí mật cục bộ (031) khai báo vào sổ khi làm; spec này không làm thay.
- [Suy luận] Vài chục đội và vài trăm dự án đủ để tính gộp theo yêu cầu, không cần bộ đệm phía hub.

## Out of Scope

- Cấp lồng nhau dưới công ty (Q2).
- `systems` làm tầng cấu hình.
- Cấu hình theo người dùng hoặc theo máy.
- Chuyển biến môi trường triển khai vào database (FR-052).
- Kênh thông báo theo đội.
- Duyệt hai người khi đổi giá trị nguy hiểm (Q3).
- Đổi mô hình hub–client, hộp thư đi hoặc token của spec 027.
- Làm nội dung plugin (030) và bí mật cục bộ (031).
- Hẹn giờ đổi cấu hình, môi trường nháp, xuất/nhập cấu hình giữa các công ty.
