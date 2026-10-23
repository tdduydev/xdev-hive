# Feature Specification: Một máy làm việc cho nhiều tổ chức

**Feature Branch**: `ai/SPEC034` (số feature `034-multi-org-machine`)

**Created**: 2026-10-23

**Status**: Draft (chờ chủ dự án xem mục "Câu hỏi cho chủ dự án" và các mặc định ở Assumptions)

**Input**: Chủ dự án (2026-10-23): một máy của người dùng phải chạy được dự án của hai đơn vị khác nhau cùng lúc. Ví dụ
một người làm thuê cho công ty A và công ty B. Hai đơn vị có thể ở cùng một hub hoặc ở hai hub khác nhau. Chủ dự án
cũng yêu cầu "xem lại bộ phân quyền" (kết quả ở [rbac-review.md](rbac-review.md), các sửa cần thiết nằm trong FR-090
đến FR-098 của spec này).

## Vì sao làm

Hiện một máy thuộc đúng một tổ chức trên một hub. Người làm cho hai đơn vị phải chọn một trong hai cách:

1. Dùng hai máy. Tốn tiền và bất tiện.
2. Gỡ đăng ký rồi đăng ký lại mỗi lần đổi đơn vị. Mất hàng chờ, mất gắn dự án, run đang chạy bị mất.

Cả hai cách đều không cách ly dữ liệu của hai đơn vị trên máy: worker dùng chung một thư mục dữ liệu, một bộ tài khoản
CLI với chung skill, memory, cấu hình MCP và plugin.

Chiến lược giữ nguyên (spec 027): hub chỉ điều phối và giữ dữ liệu, tiến độ. Hub không chạy agent, không kết nối vào
máy. Worker (`worker/`, Go) và app desktop (`apps/desktop`, Tauri) làm việc trên máy. Code, bí mật, log terminal và tài
khoản AI ở lại máy.

## Mục tiêu

1. Một máy có N **đăng ký** (registration). Mỗi đăng ký là một cặp (hub, tổ chức), có machine token, thư mục dữ liệu,
   hộp thư đi, worktree, bộ đệm chính sách, gắn dự án và phạm vi bí mật riêng.
2. Run của tổ chức A không đọc được dữ liệu của tổ chức B trên máy, và không gửi được gì tới hub của B.
3. Mỗi dự án trên máy theo đúng chính sách của tổ chức sở hữu nó. Dự án tại máy chưa gắn tổ chức nào có quy tắc rõ ràng.
4. Chủ máy quyết định tài khoản AI nào dùng cho tổ chức nào. Tổ chức có thể cấm dùng chung tài khoản.
5. Quản trị của mỗi tổ chức chỉ thấy phần máy làm cho tổ chức mình. Họ không biết tổ chức kia có tồn tại.
6. Máy đang có một đăng ký nâng cấp lên bản mới mà không phải làm lại gì.
7. Sửa các lỗ phân quyền tìm thấy khi rà soát (rbac-review.md).

## Không làm (non-goals)

- Hub không biết một máy có bao nhiêu đăng ký. Hub không có bảng "máy vật lý" nối các đăng ký với nhau.
- Không gộp hai tổ chức thành một, không chia sẻ dự án, task hay tài liệu giữa hai tổ chức.
- Không chống được phần mềm độc hại hay agent cố ý phá rào khi chạy cùng tài khoản hệ điều hành và có toàn quyền
  (ADR 0020). Mức cách ly mạnh hơn dùng tài khoản hệ điều hành riêng (US3, mức "tách người dùng").
- Không đổi giao thức xác thực máy (khoá máy, access token ngắn hạn) của spec 027. Spec này dùng lại kết quả đó.
- Không làm cấu hình phân lớp tổng quát. Phần đó thuộc spec 033 (đang viết). Spec này chỉ định nghĩa lớp "đăng ký".

## Điều làm tính năng thất bại (anti-goals)

- Một byte code, bí mật, memory, skill, cấu hình MCP, plugin hay log của tổ chức B có mặt trong worktree, biến môi
  trường, ngữ cảnh, transcript hay thư mục cấu hình CLI của một run thuộc tổ chức A.
- Một gói, sự kiện, đề xuất, điểm token hay tóm tắt tài khoản của tổ chức A đi tới hub hay tổ chức B.
- Quản trị tổ chức A thấy tên, số lượng hay sự tồn tại của tổ chức B qua hub, trừ khi chủ máy cho phép.
- Gỡ đăng ký B làm mất gắn dự án, hàng chờ, bí mật hay run của A.
- Một tổ chức chiếm hết chỗ chạy của máy khiến tổ chức kia chờ mãi.
- Máy đang dùng một đăng ký phải đăng ký lại sau khi nâng cấp.

## Hiện trạng: dùng lại, mở rộng, làm mới

Đã kiểm trong code ngày 2026-10-23:

| Phần | Hiện có (file) | Spec này |
|---|---|---|
| Cấu hình worker | Một `HubURL`, một `MachineID`, một `MachineToken` trong `worker.json` (`worker/internal/config/config.go:12`). `HIVE_WORKER_CONFIG` cho phép trỏ file khác | Mở rộng: chỉ mục đăng ký `registrations.json`; mỗi đăng ký một thư mục cấu hình |
| Một worker mỗi người dùng | Khoá `~/.xdev-hive/worker.lock` dùng chung cho mọi `--config` (`worker/internal/instancelock/lock.go:19`) | Giữ một tiến trình worker; tiến trình đó mở N kết nối |
| Thư mục dữ liệu | Một `DataDir` = `UserCacheDir/xdev-hive/worker`, chứa repo cache, worktree, `pending`, `active`, `terminal`, `guard` (`worker/internal/repolock/repolock.go:29`, `worker/internal/channel/channel.go:67`) | Mỗi đăng ký một `DataDir` riêng, kể cả repo cache |
| Tài khoản CLI ("Gói agent") | `accounts.json` cạnh `worker.json`, mỗi tài khoản có `ConfigDir` (`~/.xdev-hive/accounts/<id>`, `~/.claude`) chứa cả đăng nhập lẫn skill, memory, MCP, plugin (`worker/internal/accounts/accounts.go:42`) | Gán tài khoản cho đăng ký; tách trạng thái CLI theo đăng ký |
| Dự án trên máy | `projects.json` cạnh `worker.json`; `ProjectID` rỗng là repo chưa gắn hub (`worker/internal/projects/projects.go:19`) | Mỗi đăng ký một danh sách; một thư mục chỉ thuộc một đăng ký |
| Chọn số run cùng lúc | `--capacity` hoặc `maxParallel`/tổng `maxConcurrent` trong `accounts.json` (`worker/cmd/hive-worker/main.go:414`) | Thêm giới hạn theo đăng ký và chia công bằng |
| Từ chối việc | `job_reject` làm hub thêm máy vào `rejectedBy` của run vĩnh viễn (`apps/hub/src/modules/runs/engine.ts:1128`) | Thêm lý do "máy bận tạm thời" không loại máy khỏi run |
| Hộp thư đi | `~/.xdev-hive/outbox/<identity>`; `Identity{HubURL, OrgID, MachineID}`, thư mục theo `machine-<machineId>` (`worker/internal/outbox/store.go:66`; spec 027 đang làm) | Dùng lại; mỗi đăng ký một danh tính |
| Chính sách bí mật đã biết | `secrets-policy.json` theo khoá hub URL (`specs/031-local-secrets/data-model.md` mục 5; spec 031 đang làm) | Phải đổi khoá thành đăng ký: hai tổ chức cùng hub sẽ ghi đè nhau |
| Token cá nhân trên desktop | Keychain `dev.xdev.hive` theo khoá hub URL; token `hive_pat_<orgId>_…` (`apps/desktop/src-tauri/src/account.rs:76`, `hub.rs:141`) | Đổi khoá thành (hub, tổ chức): hai tổ chức cùng hub hiện ghi đè nhau |
| Đổi hub | `hub_switch.rs` đổi `hubUrl` của một đăng ký duy nhất | Áp cho từng đăng ký |
| Phiên từ xa | `remote.json` cạnh `worker.json`, có `ownerUserId` theo hub (`worker/internal/remoteauth/config.go:36`) | Mỗi đăng ký một `remote.json` |
| Máy trên hub | `machines` và `machine_tokens` theo tổ chức, bật RLS; `machines_org_name` duy nhất theo tổ chức; `name` = `machineId` của hello (`apps/hub/src/modules/fleet/schema.ts:42`, `registration.ts:125`) | Mỗi đăng ký là một dòng `machines` độc lập; hub không nối chúng |
| Tóm tắt tài khoản lên hub | `machines.accounts` từ heartbeat (nhãn, CLI, quota) (`fleet/schema.ts`, specs/011 FR-043) | Chỉ gửi tài khoản được gán cho đăng ký đó |
| Người dùng nhiều tổ chức | `org_members` cho phép một người ở nhiều tổ chức; vai trò tổ chức owner/admin/member, vai trò đội admin/member/viewer/ba, vai trò tuỳ chỉnh theo tổ chức hoặc đội (`apps/hub/src/modules/tenancy/schema.ts:10,13,187`) | Dùng lại; rà soát ở rbac-review.md |
| Biến môi trường của run | `HIVE_HUB_URL`, `HIVE_RUN_TOKEN` của run; cấu hình MCP của run trỏ `HIVE_HUB_URL/mcp` (`worker/internal/runner/runner.go:1070`, `mcp.go:193`) | Giữ; thêm kiểm tra rằng mọi đường gửi đi khớp đăng ký của run |
| Socket cục bộ | Unix socket 0600 kiểm UID, named pipe theo SID (ADR 0019, `worker/internal/localipc`) | Mỗi lệnh ghi qua socket mang đăng ký; run chỉ dùng được đăng ký của mình |

## Khái niệm

| Khái niệm | Nghĩa |
|---|---|
| Đăng ký | Một cặp (hub, tổ chức) mà máy đã đăng ký vào. Có id cục bộ (`reg_…`), machine token, `machineId` hub cấp, tên hiển thị máy gửi hub, nhãn tổ chức do chủ máy đặt. |
| Đăng ký cũ | Đăng ký duy nhất của bản trước, nằm ở đường dẫn cũ (`worker.json`). Sau nâng cấp nó là đăng ký đầu tiên, không chuyển file. |
| Thư mục đăng ký | Thư mục cấu hình và thư mục dữ liệu riêng của một đăng ký. |
| Chủ máy | Người dùng hệ điều hành chạy worker và app desktop. Quyết định đăng ký, gán tài khoản, giới hạn. |
| Quản trị tổ chức | Owner/admin của tổ chức hay admin đội trên hub. Chỉ có quyền với đăng ký của tổ chức mình. |
| Dự án tại máy | Thư mục repo trên máy. Có thể gắn với một dự án hub của đúng một đăng ký, hoặc không gắn đăng ký nào. |
| Trạng thái CLI | Mọi thứ CLI agent đọc ngoài đăng nhập: skill, memory, cấu hình MCP, plugin, lịch sử phiên, cài đặt. |
| Mức cách ly | `chung-người-dùng` (mặc định): cùng tài khoản hệ điều hành, cách ly bằng đường dẫn, môi trường và kiểm tra của worker. `tách-người-dùng`: run của đăng ký chạy dưới tài khoản hệ điều hành riêng. |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Thêm đăng ký thứ hai (Priority: P1)

Hà đã đăng ký máy với công ty A trên `hive.a.vn`. Hà nhận mã đăng ký của công ty B trên `hive.b.vn`. Trong app, Hà mở
"Tổ chức trên máy", bấm Thêm, dán lệnh đăng ký. Máy kết nối cả hai hub. Công ty A không thấy thay đổi gì.

**Why this priority**: Không có bước này thì không có gì khác để làm.

**Independent Test**: Trên máy có một đăng ký, thêm đăng ký thứ hai ở hub khác và ở cùng hub nhưng tổ chức khác. Thấy
hai kết nối trực tuyến, hai dòng `machines` ở hai tổ chức, và đăng ký đầu không đổi token, thư mục hay hàng chờ.

**Acceptance Scenarios**:

1. **Given** máy có một đăng ký, **When** chủ máy thêm đăng ký bằng mã của tổ chức khác, **Then** worker tạo thư mục đăng
   ký mới, lưu machine token mới, mở kết nối thứ hai; kết nối đầu không bị ngắt.
2. **Given** mã đăng ký thuộc tổ chức đã có đăng ký trên máy (cùng hub, cùng tổ chức), **Then** app từ chối và đề nghị
   "Đăng ký lại" cho đăng ký đó (thay token), không tạo đăng ký thứ hai cho cùng tổ chức.
3. **Given** hai tổ chức ở cùng một hub, **Then** hai đăng ký có hai `machineId`, hai machine token, hai khoá máy
   (spec 027), và tên máy gửi hub do chủ máy chọn riêng cho mỗi đăng ký.
4. **Given** đăng ký mới, **Then** chủ máy đặt nhãn tổ chức hiển thị trên máy (ví dụ "Công ty B"). Nhãn mặc định là tên
   tổ chức hub trả về lúc đăng ký; nhãn chỉ nằm trên máy.
5. **Given** đã có số đăng ký tối đa (A3), **Then** app báo lỗi và không thêm.

---

### User Story 2 - Run của hai tổ chức chạy cùng lúc, không thấy nhau (Priority: P1)

Hub A giao run cho dự án `shop` của A. Cùng lúc hub B giao run cho dự án `crm` của B. Hai run chạy song song. Run của
A không đọc được worktree, bí mật, memory, skill hay log của B, và ngược lại.

**Why this priority**: Đây là lý do của tính năng.

**Independent Test**: Chạy đồng thời một run ở mỗi đăng ký, mỗi run in danh sách biến môi trường, thư mục cấu hình CLI,
skill và MCP server nó thấy, và thử đọc đường dẫn thư mục dữ liệu của đăng ký kia qua công cụ của worker. Không thấy gì
của đăng ký kia.

**Acceptance Scenarios**:

1. **Given** hai đăng ký A và B, **When** mỗi hub giao một run, **Then** mỗi run chạy trong `DataDir` của đăng ký mình;
   worktree, repo cache, log, `pending`, `guard` của A nằm dưới thư mục của A.
2. **Given** run của A, **Then** môi trường của run chỉ có `HIVE_HUB_URL`, run token và cấu hình MCP của A. Không có
   biến, file hay đường dẫn nào chỉ tới thư mục, hub hay token của B.
3. **Given** run của A, **Then** CLI agent đọc trạng thái CLI của A (skill, memory, MCP, plugin, lịch sử) và không đọc
   trạng thái của B, kể cả khi hai run dùng chung một tài khoản AI (US5).
4. **Given** run của A dùng `hive` CLI hay socket cục bộ để ghi (đề xuất memory, cập nhật task), **Then** worker gắn lần
   ghi vào đăng ký của run; yêu cầu nêu đăng ký khác bị từ chối với lỗi "Run không thuộc tổ chức này".
5. **Given** bí mật tại máy (spec 031), **Then** run của A chỉ nhận bí mật trong phạm vi của A (FR-030).
6. **Given** memory và ngữ cảnh dùng chung (spec 029), **Then** bản ghi nhớ và nguồn ngữ cảnh của A nằm dưới thư mục
   đăng ký A và chỉ đồng bộ với hub A.

---

### User Story 3 - Mức cách ly và giới hạn của cùng người dùng hệ điều hành (Priority: P1)

Công ty B yêu cầu chặt: agent làm việc cho B không được có khả năng đọc file của khách hàng khác, kể cả khi agent bị
lừa bằng prompt. Hà bật mức "tách người dùng" cho đăng ký B.

**Why this priority**: Phải nói rõ cách ly mặc định bảo vệ tới đâu. Hứa quá mức là lỗi bảo mật.

**Independent Test**: Ở mức mặc định, chạy run toàn quyền của A cố đọc thư mục của B và ghi kết quả; thấy hệ thống cảnh
báo đúng như FR-025. Ở mức tách người dùng, cùng thử nghiệm bị hệ điều hành từ chối.

**Acceptance Scenarios**:

1. **Given** mức `chung-người-dùng`, **Then** worker không đưa đường dẫn, biến, token hay cấu hình của B vào run của A,
   và các công cụ của worker (socket cục bộ, `hive` CLI, MCP cục bộ) từ chối yêu cầu chéo. Tài liệu và app ghi rõ: tiến
   trình agent có toàn quyền vẫn đọc được mọi file mà tài khoản hệ điều hành đọc được.
2. **Given** mức `chung-người-dùng` và máy có từ hai đăng ký, **When** chủ máy bật toàn quyền (ADR 0020) cho một dự án,
   **Then** app cảnh báo rằng agent toàn quyền đọc được dữ liệu của tổ chức khác trên máy, và yêu cầu xác nhận.
3. **Given** trên Linux và macOS, ở mức `chung-người-dùng` với run không toàn quyền, **Then** worker chặn đọc thư mục
   đăng ký khác bằng cơ chế hạn chế tiến trình có sẵn của hệ điều hành khi có (FR-024). Windows không có cơ chế này ở
   mức này; app nói rõ.
4. **Given** mức `tách-người-dùng` cho đăng ký B, **Then** run của B chạy dưới tài khoản hệ điều hành riêng do chủ máy
   tạo và cấp quyền một lần; thư mục đăng ký B chỉ tài khoản đó đọc được; worker chính chỉ giữ kênh tới hub B.
5. **Given** chính sách tổ chức B đòi `tách-người-dùng` (FR-061), **When** máy chưa bật mức đó cho B, **Then** worker không
   nhận run của B và báo lý do trên app; hub B thấy máy "không đủ điều kiện chính sách", không thấy lý do liên quan tới
   tổ chức khác.

---

### User Story 4 - Dự án trên máy theo chính sách của đúng tổ chức (Priority: P1)

Hà có ba thư mục: `shop` gắn dự án của A, `crm` gắn dự án của B, `blog` là dự án riêng không gắn ai. Mở terminal agent
từ app cho `shop` thì áp chính sách của A; cho `crm` thì của B; cho `blog` thì chính sách tại máy của Hà.

**Why this priority**: Áp nhầm chính sách là lỗi tuân thủ (ví dụ cho bí mật vào agent khi tổ chức cấm).

**Independent Test**: Đặt `secretInjection = deny` ở A, `allow` ở B. Mở phiên cho ba thư mục. Thấy phiên `shop` không
có bí mật, phiên `crm` có, phiên `blog` theo chính sách tại máy.

**Acceptance Scenarios**:

1. **Given** thư mục đã gắn với dự án hub của đăng ký A, **When** gắn thư mục đó với dự án của đăng ký B, **Then** app
   từ chối và chỉ ra đăng ký đang giữ; muốn chuyển thì bỏ gắn ở A trước.
2. **Given** dự án gắn đăng ký A, **Then** mọi run và phiên desktop của dự án dùng chính sách đã biết của A (ảnh chụp chính
   sách theo run khi có run), bí mật trong phạm vi A, tài khoản AI được gán cho A, token cá nhân của A.
3. **Given** dự án tại máy không gắn đăng ký nào, **Then** áp "chính sách tại máy" do chủ máy đặt (mặc định ở A5); phiên
   không có MCP của hub nào, không có token cá nhân nào, không gửi gì lên hub nào.
4. **Given** người dùng muốn dùng MCP của hub cho dự án chưa gắn, **Then** phải gắn dự án với một đăng ký trước; app
   không tự chọn tổ chức.
5. **Given** repo chứa remote `origin` của tổ chức B mà bị gắn nhầm vào dự án của A, **Then** kiểm `origin` hiện có
   (ADR 0020) báo không khớp như hiện nay.

---

### User Story 5 - Tài khoản AI dùng chung hay riêng theo tổ chức (Priority: P1)

Hà có hai gói Claude: gói cá nhân và gói công ty B cấp. Hà gán gói công ty B chỉ cho đăng ký B. Gói cá nhân dùng chung
cho A và B. Công ty B cấm dùng gói đã dùng cho tổ chức khác, nên run của B chỉ dùng gói B.

**Why this priority**: Tài khoản AI là chi phí và là nơi lẫn trạng thái CLI giữa hai tổ chức.

**Independent Test**: Gán gói theo trên, chạy run ở mỗi đăng ký, xem gói được chọn; bật cấm dùng chung ở B và thấy gói
cá nhân không còn được chọn cho B, kèm lý do trên app.

**Acceptance Scenarios**:

1. **Given** tài khoản không gán đăng ký nào cụ thể, **Then** tài khoản dùng chung cho mọi đăng ký (mặc định, giữ hành vi
   hiện nay cho máy một đăng ký).
2. **Given** tài khoản gán cho một tập đăng ký, **Then** bộ chọn tài khoản của run chỉ xét tài khoản gán cho đăng ký
   của run hoặc dùng chung.
3. **Given** chính sách tổ chức B có `aiAccountSharing = dedicated`, **Then** run của B chỉ dùng tài khoản chỉ gán cho
   B; tài khoản dùng chung hay gán thêm cho đăng ký khác không được chọn. Không có tài khoản hợp lệ thì máy không nhận
   run của B và app báo lý do.
4. **Given** hai run của hai đăng ký dùng chung một tài khoản, **Then** quota của tài khoản được tính chung (một bộ đếm),
   nhưng trạng thái CLI tách theo đăng ký (FR-041).
5. **Given** quản trị đội A gửi `account_set` từ web (máy dùng chung, specs/011), **Then** worker chỉ áp lên tài khoản
   chỉ gán cho A; tài khoản dùng chung hay gán cho đăng ký khác bị từ chối với lý do "Tài khoản do chủ máy quản lý".
6. **Given** heartbeat gửi tóm tắt tài khoản lên hub A, **Then** chỉ có tài khoản dùng được cho A; nhãn tài khoản chỉ gán
   cho B không bao giờ tới hub A.

---

### User Story 6 - Lập lịch: giới hạn theo tổ chức và cả máy (Priority: P2)

Máy của Hà chạy tối đa 4 run. Hà đặt A tối đa 3, B tối đa 2. Khi cả hai đều có việc chờ, máy không để A chiếm cả 4
chỗ.

**Why this priority**: Không có chia công bằng thì tổ chức có hàng chờ dài chiếm cả máy.

**Independent Test**: Hai hub cùng xếp 10 run. Đo số run đang chạy của mỗi đăng ký theo thời gian: tổng không vượt 4,
mỗi đăng ký không vượt giới hạn riêng, và đăng ký có việc chờ nhận chỗ trống trong một chu kỳ heartbeat.

**Acceptance Scenarios**:

1. **Given** giới hạn máy `M` và giới hạn đăng ký `L(r)`, **Then** số run đang chạy của r không vượt `L(r)` và tổng không
   vượt `M`.
2. **Given** cả hai đăng ký có việc chờ và máy đầy, **When** một chỗ trống ra, **Then** chỗ đó dành cho đăng ký đang chạy
   ít hơn phần công bằng của mình (FR-052), không phải ai gửi đề nghị trước.
3. **Given** worker phải từ chối đề nghị vì máy đầy do đăng ký khác, **Then** worker gửi `job_reject` với lý do
   `machine_busy`; hub không loại máy khỏi run đó, chỉ thử máy khác hoặc chờ (FR-055).
4. **Given** sức chứa báo cho hub A, **Then** con số đó là `L(A)`, không lộ `M` hay số run của B.
5. **Given** phiên terminal và `hive chat` mở từ desktop, **Then** chúng tính vào bộ đếm của đúng đăng ký của dự án và vào
   bộ đếm quota tài khoản như hiện nay (specs/010 D2).

---

### User Story 7 - App desktop cho nhiều tổ chức (Priority: P2)

Hà mở app, thấy danh sách "Tổ chức trên máy": A (hive.a.vn, trực tuyến, 1 run), B (hive.b.vn, trực tuyến, 0 run). Mỗi
run, dự án, terminal có nhãn màu của tổ chức. Hà gỡ đăng ký B mà A không đổi.

**Why this priority**: Người dùng phải luôn biết mình đang làm cho ai.

**Independent Test**: Với hai đăng ký, mở từng màn (trang chủ máy, run, dự án, terminal, tài khoản, bí mật, hộp thư đi).
Mọi mục có nhãn tổ chức. Gỡ B rồi kiểm A vẫn chạy, dữ liệu A còn nguyên.

**Acceptance Scenarios**:

1. **Given** màn "Tổ chức trên máy", **Then** mỗi dòng hiện nhãn, hub, tên tổ chức, tên máy gửi hub, trạng thái kết nối,
   số run đang chạy, giới hạn, mức cách ly, số mục hộp thư đi chờ.
2. **Given** màn run, dự án, terminal, hộp thư đi, bí mật, tài khoản AI, **Then** mỗi mục hiện nhãn tổ chức; có bộ lọc
   theo tổ chức; mục không gắn tổ chức ghi "Riêng trên máy".
3. **Given** chủ máy chọn Gỡ đăng ký B, **Then** app liệt kê sẽ xoá gì (token B, kết nối B, gắn dự án của B, phạm vi bí
   mật B, trạng thái CLI của B, worktree B) và hỏi xử lý hộp thư đi B (gửi nốt, xuất file, bỏ). Đăng ký A không đổi.
4. **Given** đăng ký B có run đang chạy, **When** gỡ B, **Then** app đề nghị chờ run xong hoặc huỷ; không bỏ run lửng.
5. **Given** hub B thu hồi máy (quản trị B), **Then** đăng ký B chuyển "Đã bị tổ chức gỡ"; dữ liệu cục bộ của B giữ tới khi
   chủ máy xoá; A không đổi.
6. **Given** đổi địa chỉ hub (`hub_switch`), **Then** chỉ áp cho đăng ký được chọn.
7. **Given** đăng nhập tài khoản cá nhân (token cá nhân), **Then** mỗi đăng ký có token cá nhân riêng; đăng xuất B không
   đụng token A.
8. **Given** app có một đăng ký, **Then** giao diện giống hiện nay; danh sách tổ chức chỉ hiện khi có từ hai đăng ký hoặc
   khi người dùng mở cài đặt.

---

### User Story 8 - Quản trị tổ chức chỉ thấy phần của mình (Priority: P2)

Quản trị của A mở trang Máy trên hub A. Họ thấy máy của Hà, run của A trên máy đó, phiên bản, hệ điều hành, tài khoản
dùng cho A. Họ không thấy B.

**Why this priority**: Người làm thuê cho hai công ty có nghĩa vụ giữ bí mật với cả hai.

**Independent Test**: Hai tổ chức ở cùng một hub. Quản trị A gọi mọi API về máy, run, tài khoản, điểm token, sự kiện máy.
Không có dữ liệu nào cho biết máy có đăng ký khác.

**Acceptance Scenarios**:

1. **Given** quản trị A, **Then** họ thấy máy (theo đăng ký A), run của A, sức chứa `L(A)`, tải chỉ tính run của A, tóm tắt
   tài khoản dùng được cho A.
2. **Given** hai tổ chức cùng hub, **Then** hai dòng `machines` không có trường chung nào ngoài những gì chủ máy chọn
   giống nhau (hệ điều hành, phiên bản worker). `machineId`, khoá công khai, token, tên máy là riêng.
3. **Given** chủ máy bật "Cho tổ chức này biết máy cũng làm cho tổ chức khác" cho đăng ký A, **Then** hub A chỉ nhận một
   cờ và nhãn chủ máy tự viết, không nhận tên hay hub của tổ chức kia.
4. **Given** quản trị hệ thống của hub (khác quản trị tổ chức), **Then** spec ghi rõ họ có thể suy ra hai đăng ký cùng máy
   qua địa chỉ IP và thời điểm kết nối; đây là rủi ro dư (A7).
5. **Given** quản trị A thu hồi hay tạm dừng máy, **Then** chỉ đăng ký A bị ảnh hưởng.

---

### User Story 9 - Nâng cấp từ máy một đăng ký (Priority: P1)

Máy của Hà đang chạy bản cũ với một đăng ký. Hà cập nhật app. Mọi thứ chạy như cũ. Đăng ký cũ thành đăng ký đầu tiên.

**Why this priority**: Mọi máy đang dùng đều đi qua bước này.

**Independent Test**: Cài bản cũ, đăng ký, gắn dự án, có hàng chờ chưa gửi và một run đang chạy. Nâng cấp. Thấy cùng
`machineId`, run đang chạy được nhận lại (`resumeRuns`), hàng chờ được gửi, gắn dự án còn nguyên, không phải đăng ký lại.

**Acceptance Scenarios**:

1. **Given** máy có `worker.json` và chưa có `registrations.json`, **When** worker mới khởi động, **Then** worker tạo chỉ
   mục với một đăng ký trỏ tới các file và thư mục hiện có (đăng ký cũ). Không chuyển, không đổi tên file nào.
2. **Given** đăng ký cũ, **Then** đường dẫn `DataDir`, `projects.json`, `accounts.json`, `remote.json`, hộp thư đi, kho
   bí mật giữ nguyên; tài khoản AI hiện có tính là dùng chung.
3. **Given** quay về bản cũ (rollback), **Then** bản cũ bỏ qua `registrations.json` và chạy đăng ký cũ như trước. Đăng ký
   thêm sau nâng cấp không chạy ở bản cũ; app bản cũ không thấy chúng.
4. **Given** `HIVE_WORKER_CONFIG` đặt sẵn (máy chạy nhiều worker bằng tay), **Then** hành vi cũ giữ nguyên: một tiến trình
   một đăng ký, không đọc chỉ mục.
5. **Given** runner host (`hive-worker host`), **Then** giữ một đăng ký; nhiều đăng ký cho runner host ngoài phạm vi.

---

### Edge Cases

- **Cùng hub, cùng người dùng là thành viên của cả A và B**: hai đăng ký riêng. Token cá nhân riêng cho từng tổ chức
  (token `hive_pat_<orgId>_…` đã gắn tổ chức). Hub không nối hai dòng máy dù cùng `registeredBy`; trang "Máy của tôi"
  của người đó trên hub hiện máy theo tổ chức đang chọn.
- **Cùng repo ở hai tổ chức** (fork, hay dự án chuyển chủ): hai thư mục riêng, mỗi thư mục gắn một đăng ký. Repo cache
  không dùng chung giữa đăng ký dù cùng URL (tốn đĩa, đổi lại không lẫn object git).
- **Tên máy trùng ở cùng hub**: `machines_org_name` duy nhất theo tổ chức, nên hai tổ chức có thể cùng tên; chủ máy vẫn
  được gợi ý đặt khác để quản trị hệ thống không nối dễ dàng.
- **Hub A trả lỗi, hub B bình thường**: kết nối độc lập; lỗi, backoff, hộp thư đi của A không chặn B.
- **Một tổ chức buộc cập nhật worker (`update`)**: worker là một tiến trình. Cập nhật làm mọi kết nối ngừng nhận việc
  mới, chờ run của mọi đăng ký xong rồi khởi động lại. Hub B không biết lý do; B chỉ thấy máy offline ngắn. App hỏi chủ
  máy trước khi áp cập nhật do một tổ chức yêu cầu (FR-064).
- **Hai tổ chức yêu cầu phiên bản khác nhau** (`protoRange` không giao nhau): đăng ký không tương thích báo "Hub cần bản
  worker khác" và tạm dừng; các đăng ký khác vẫn chạy.
- **Bí mật cùng tên ở hai tổ chức** (`DB_PASSWORD`): spec 031 bắt tên duy nhất trên máy. Spec này đổi thành duy nhất trong
  một phạm vi (FR-030); hai phạm vi được cùng tên.
- **Chủ máy chuyển máy cho người khác**: ngoài phạm vi; gỡ mọi đăng ký rồi người mới đăng ký lại.
- **Máy offline lâu**: chính sách đã biết của mỗi đăng ký dùng như spec 031 FR-053 (chưa biết thì `deny` với dự án đã
  gắn).
- **Run cha của A giao việc cho agent con (spec 028)**: agent con cùng máy thuộc cùng đăng ký A; hub không giao agent con
  của A sang đăng ký B dù cùng máy (hub không biết là cùng máy).
- **Desktop mở `hive chat` (phiên Leader) không chọn dự án**: phải chọn đăng ký; không có mặc định ngầm khi có từ hai đăng
  ký.
- **Phiên điều khiển từ xa (specs/010)**: thiết bị ghép theo đăng ký; thiết bị ghép qua hub A không mở được phiên cho dự
  án của B.

## Requirements *(mandatory)*

### Functional Requirements

**Đăng ký và lưu trữ trên máy**

- **FR-001**: Worker PHẢI đọc chỉ mục `registrations.json` trong thư mục cấu hình (`UserConfigDir/xdev-hive`). Mỗi mục có
  `id` cục bộ, `hubUrl`, `orgId`, `orgName`, `label`, `machineId`, `configDir`, `dataDir`, `isolation`, `limit`, `enabled`.
  Machine token KHÔNG nằm trong chỉ mục.
- **FR-002**: Mỗi đăng ký mới PHẢI có thư mục cấu hình `…/xdev-hive/orgs/<id>/` (chứa `worker.json`, `projects.json`,
  `remote.json`, chính sách đã biết, phạm vi bí mật) và thư mục dữ liệu `UserCacheDir/xdev-hive/worker/orgs/<id>/` (repo
  cache, worktree, `pending`, `active`, `terminal`, `guard`, codegraph, log run). Quyền 0700/0600, DACL tương đương trên
  Windows.
- **FR-003**: Đăng ký cũ PHẢI dùng đúng đường dẫn hiện có (FR-080).
- **FR-004**: Mỗi (hub, tổ chức) có tối đa một đăng ký trên máy. Thêm trùng PHẢI bị từ chối kèm đề nghị đăng ký lại.
- **FR-005**: Lệnh đăng ký PHẢI nhận `--label` và `--machine` (tên gửi hub) riêng cho từng đăng ký. Lần đăng ký mới PHẢI
  tạo khoá máy mới (spec 027 FR-020), không dùng lại khoá của đăng ký khác.
- **FR-006**: Hub PHẢI trả `orgId` và tên tổ chức trong kết quả đăng ký để máy ghi vào chỉ mục. Kết quả hiện đã có
  `orgId` (`registration.ts`); thêm tên tổ chức.
- **FR-007**: Worker PHẢI giữ một tiến trình mỗi người dùng hệ điều hành (giữ `instancelock`) và mở một kết nối WSS cho mỗi
  đăng ký đang bật. Kết nối, backoff, hộp thư đi, `pending`, ack của mỗi đăng ký độc lập.
- **FR-008**: Token cá nhân trên desktop PHẢI lưu trong keychain theo khoá (hub, tổ chức). Khoá cũ theo hub được đọc như
  token của đăng ký cũ rồi chép sang khoá mới.
- **FR-009**: Lệnh `hive-worker` hiện có (`projects`, `accounts`, `outbox`, `memory`, `context`, `ssh`, `config`) PHẢI nhận
  `--registration ID`; không đặt thì dùng đăng ký duy nhất, hoặc báo lỗi khi có từ hai đăng ký và lệnh cần đăng ký.

**Cách ly giữa các tổ chức**

- **FR-020**: Run và phiên của đăng ký r PHẢI chỉ nhận đường dẫn, biến môi trường, token, cấu hình MCP, skill, memory,
  plugin và bí mật thuộc r. Worker PHẢI xoá khỏi môi trường của run mọi biến `HIVE_*` thừa kế từ tiến trình worker trước
  khi đặt biến của r.
- **FR-021**: Mọi đường gửi lên hub từ trong run (MCP của run, `hive` CLI, socket cục bộ, hộp thư đi) PHẢI dùng danh tính
  của đăng ký sở hữu run. Socket cục bộ PHẢI nhận một mã phiên của run (cấp lúc tạo run, chỉ có trong môi trường run) và
  suy ra đăng ký từ mã đó; yêu cầu nêu đăng ký khác hay không có mã PHẢI bị từ chối khi máy có từ hai đăng ký.
- **FR-022**: Worker PHẢI kiểm `HIVE_HUB_URL` và hub của MCP trong spec run khớp hub của đăng ký nhận run. Không khớp thì
  từ chối run (`job_reject`, lý do `hub_mismatch`).
- **FR-023**: Repo cache, worktree, log, transcript, codegraph và bản ghi nhớ của run PHẢI nằm dưới thư mục dữ liệu của
  đăng ký. Dọn worktree mồ côi (`ReapOrphans`) PHẢI chạy theo từng đăng ký và không xoá gì của đăng ký khác.
- **FR-024**: Ở mức `chung-người-dùng`, với run không toàn quyền, worker PHẢI chặn tiến trình agent đọc thư mục cấu hình
  và dữ liệu của đăng ký khác bằng cơ chế của hệ điều hành khi có (Linux: Landlock; macOS: sandbox profile). Không có cơ
  chế thì ghi rõ trong trạng thái máy "không chặn được ở mức hệ điều hành".
- **FR-025**: App PHẢI ghi rõ giới hạn của mức `chung-người-dùng` ở màn đăng ký và khi bật toàn quyền cho dự án trên máy có
  từ hai đăng ký (US3 kịch bản 2).
- **FR-026**: Mức `tách-người-dùng` PHẢI chạy run của đăng ký dưới tài khoản hệ điều hành riêng, có thư mục đăng ký chỉ
  tài khoản đó đọc được. Worker chính giữ kết nối hub và chuyển việc qua kênh cục bộ có xác thực. Cách cài đặt theo từng
  hệ điều hành nằm trong plan.
- **FR-027**: Log và báo lỗi của worker và app PHẢI ghi id đăng ký, không ghi token. Log chung của tiến trình (khởi động,
  cập nhật) KHÔNG ĐƯỢC chứa dữ liệu run.

**Bí mật, chính sách và dự án**

- **FR-030**: Bí mật tại máy (spec 031) PHẢI có phạm vi: một đăng ký hoặc "riêng trên máy". Tên biến duy nhất trong một
  phạm vi. Bí mật chỉ gán được cho dự án cùng phạm vi.
- **FR-031**: Chính sách đã biết (spec 031 `secrets-policy.json`, và các điều khoản chính sách khác máy giữ) PHẢI lưu theo
  đăng ký, không theo hub URL.
- **FR-032**: Một thư mục dự án PHẢI gắn với nhiều nhất một đăng ký. Gắn thư mục đang thuộc đăng ký khác PHẢI bị từ chối.
- **FR-033**: Dự án gắn đăng ký r PHẢI áp chính sách của tổ chức của r cho mọi run và phiên (bí mật, toàn quyền, giữ log).
- **FR-034**: Dự án không gắn đăng ký nào PHẢI áp "chính sách tại máy" do chủ máy đặt (A5), không có MCP hub, không gửi gì
  lên hub nào, và ghi nhãn "Riêng trên máy".
- **FR-035**: Danh sách `localProjects` gửi hub r PHẢI chỉ có dự án gắn với r.

**Tài khoản AI**

- **FR-040**: Mỗi tài khoản trong `accounts.json` PHẢI có `registrations: []`. Rỗng là dùng chung. Có giá trị là chỉ các đăng
  ký đó. Bộ chọn tài khoản của run chỉ xét tài khoản dùng được cho đăng ký của run.
- **FR-041**: Run PHẢI dùng thư mục trạng thái CLI theo (tài khoản, đăng ký): đăng nhập lấy từ tài khoản; skill, memory,
  cấu hình MCP, plugin, lịch sử, cài đặt lấy từ thư mục của đăng ký. Với CLI không tách được đăng nhập khỏi trạng thái,
  tài khoản đó PHẢI chỉ gán được cho một đăng ký (plan liệt kê CLI nào).
- **FR-042**: Chính sách tổ chức PHẢI có điều khoản `aiAccountSharing` với `allow` (mặc định) và `dedicated`. Với
  `dedicated`, run của tổ chức chỉ dùng tài khoản gán riêng cho đăng ký của tổ chức đó. Máy tự kiểm; hub không biết tài
  khoản có gán cho đăng ký khác hay không.
- **FR-043**: Quota tài khoản PHẢI tính chung cho mọi đăng ký dùng tài khoản đó.
- **FR-044**: `account_set` từ hub r PHẢI chỉ áp cho tài khoản chỉ gán cho r. Tài khoản dùng chung hay gán cho đăng ký khác
  PHẢI bị từ chối kèm lý do.
- **FR-045**: Tóm tắt tài khoản trong heartbeat tới hub r PHẢI chỉ có tài khoản dùng được cho r.

**Lập lịch**

- **FR-050**: Máy PHẢI có giới hạn chung `M` (mặc định theo cách tính hiện có ở `main.go`) và giới hạn theo đăng ký `L(r)`
  (mặc định `M`).
- **FR-051**: `capacity` gửi trong `hello` tới hub r PHẢI là `L(r)`; `load` PHẢI chỉ đếm run của r.
- **FR-052**: Khi máy đầy và có từ hai đăng ký có việc, worker PHẢI chia theo phần công bằng có trọng số (mặc định trọng số
  bằng nhau): đăng ký đang chạy dưới phần của mình được ưu tiên nhận chỗ trống. Chủ máy đặt được trọng số.
- **FR-053**: Một đăng ký luôn có ít nhất một chỗ nếu `L(r) ≥ 1` và đang có việc, trừ khi `M` nhỏ hơn số đăng ký đang có
  việc; khi đó xoay vòng theo thời gian chờ.
- **FR-054**: Phiên desktop (terminal, `hive chat`) PHẢI tính vào bộ đếm của đăng ký của dự án, hoặc vào nhóm "Riêng trên
  máy" (chỉ tính vào `M`).
- **FR-055**: Hub PHẢI coi `job_reject` lý do `machine_busy` là tạm thời: không thêm máy vào `rejectedBy`, thử máy khác hoặc
  đề nghị lại máy đó sau khi heartbeat báo có chỗ.

**Desktop**

- **FR-060**: App PHẢI có màn "Tổ chức trên máy": danh sách đăng ký (US7 kịch bản 1), thêm, đăng ký lại, sửa nhãn, giới
  hạn, mức cách ly, trọng số, bật/tắt, gỡ.
- **FR-061**: Chính sách tổ chức PHẢI có điều khoản `machineIsolation` với `shared_user` (mặc định) và `separate_user`. Máy
  không đủ điều kiện thì không nhận run và báo hub một cờ `policy_unmet` không kèm lý do liên quan tổ chức khác.
- **FR-062**: Mọi màn có run, dự án, terminal, hộp thư đi, bí mật, tài khoản AI PHẢI hiện nhãn tổ chức và lọc được theo tổ
  chức khi có từ hai đăng ký.
- **FR-063**: Gỡ một đăng ký PHẢI: dừng kết nối, xử lý hộp thư đi theo lựa chọn, chờ hoặc huỷ run, xoá token khỏi
  keychain, xoá thư mục đăng ký, xoá phạm vi bí mật của đăng ký khỏi kho hệ điều hành (hỏi trước), bỏ gán tài khoản. Đăng
  ký khác không đổi.
- **FR-064**: Lệnh `update` từ một hub PHẢI chờ chủ máy đồng ý khi máy có từ hai đăng ký, trừ khi chủ máy bật tự cập nhật.
- **FR-065**: Chữ giao diện có bản tiếng Việt và tiếng Anh theo từ điển của app; thông báo lỗi tiếng Việt.

**Hub và quyền nhìn thấy**

- **FR-070**: Hub KHÔNG ĐƯỢC lưu hay nhận bất cứ thông tin nào nối hai đăng ký (id đăng ký cục bộ, id máy vật lý, danh sách
  tổ chức khác), trừ cờ và nhãn chủ máy chủ động bật (US8 kịch bản 3).
- **FR-071**: Quản trị tổ chức chỉ xem, tạm dừng, thu hồi, đặt dùng chung, đặt nhãn cho dòng máy của tổ chức mình (hiện
  có, RLS). Thao tác của họ không đổi gì ở đăng ký khác trên máy.
- **FR-072**: Trang "Máy của tôi" của một người thuộc nhiều tổ chức PHẢI chỉ liệt kê máy của tổ chức đang chọn.

**Nâng cấp**

- **FR-080**: Khi không có `registrations.json` mà có `worker.json` ở đường dẫn mặc định, worker PHẢI tạo chỉ mục với một
  đăng ký cũ trỏ tới các đường dẫn hiện có, không chuyển file.
- **FR-081**: Bản cũ PHẢI chạy được đăng ký cũ sau khi bản mới đã tạo chỉ mục (rollback). Bản mới KHÔNG ĐƯỢC đổi định dạng
  của `worker.json`, `projects.json`, `accounts.json` theo cách bản cũ không đọc được; trường mới phải là tuỳ chọn.
- **FR-082**: Có `HIVE_WORKER_CONFIG` hay `--config` thì worker chạy đúng một đăng ký như hiện nay.
- **FR-083**: Desktop PHẢI chép token cá nhân theo khoá hub cũ sang khoá (hub, tổ chức) ở lần chạy đầu.

**Sửa phân quyền (từ rbac-review.md)**

Các FR này sửa lỗ tìm thấy khi rà soát. Mức ưu tiên và lý do ở rbac-review.md.

- **FR-090**: Hội thoại Leader và đề xuất của Leader PHẢI chỉ hiện cho người có vai trò trong đội của dự án gắn với hội
  thoại. Hội thoại không gắn dự án chỉ người tạo và owner/admin tổ chức thấy. Từ chối đề xuất PHẢI cần vai trò `member`
  của đội trở lên (viewer và ba không quyết đề xuất). (R1)
- **FR-091**: Mọi router nhận tổ chức từ header hay đường dẫn PHẢI kiểm người gọi là thành viên đang hoạt động của tổ
  chức đó trước khi chạy handler, kể cả router fleet. Truy vấn theo id (`projectId`, `teamId`, `runId`, `machineId`,
  `threadId`) PHẢI kiểm đội sở hữu, không chỉ dựa vào RLS theo tổ chức. (R1, R4)
- **FR-092**: Gỡ vai trò tuỳ chỉnh PHẢI theo cùng luật với gán (`requireCanGrant`). Gán vai trò cho đội PHẢI từ chối vai trò
  phạm vi tổ chức. Quyền khai trong catalog mà chưa có điểm kiểm PHẢI ghi "chưa áp dụng" trên màn vai trò. (R8, R10, R13)
- **FR-093**: Đăng ký lại máy cùng tên trong đội PHẢI chỉ được khi người tạo mã là chủ máy cũ, hoặc là admin đội; chủ máy
  (`registeredBy`) giữ nguyên; audit `machine.register` ghi `reinstalled` và chủ cũ. Người khác nhận lỗi trùng tên. (R2)
- **FR-094**: Token cá nhân PHẢI chỉ dùng cho tổ chức ghi trong token, dù tổ chức được chọn bằng header hay đường dẫn.
  Token run PHẢI mất hiệu lực cho công cụ ghi khi người tạo run không còn là thành viên đang hoạt động. (R3, R7)
- **FR-095**: Hub PHẢI coi `job_reject` lý do `machine_busy` là tạm thời (cùng nội dung FR-055).
- **FR-096**: Run Leader và run được giao (spec 028) PHẢI chỉ làm được điều người giao làm được (hiện đúng: hành động chạy
  bằng guard của người duyệt). Đổi cấp mô hình khi duyệt PHẢI ghi audit (hiện có).
- **FR-097**: Mỗi điểm kiểm quyền mới hay sửa PHẢI có test, gồm cả trường hợp người thuộc hai tổ chức gửi id của tổ chức
  kia.
- **FR-098**: Chủ máy cá nhân PHẢI tự tạm dừng, tiếp tục và thu hồi được máy của mình mà không cần admin đội (ADR 0017).
  (R6)

Chi tiết từng FR-09x và các mục còn lại xem rbac-review.md mục "Sửa đề xuất".

### Key Entities

- **Registration** (trên máy): `id`, `hubUrl`, `orgId`, `orgName`, `label`, `machineId`, `machineName`, `configDir`,
  `dataDir`, `isolation` (`shared_user` | `separate_user`), `limit`, `weight`, `enabled`, `legacy`, `discloseCoTenancy`,
  `createdAt`.
- **RegistrationIndex** (trên máy): `version`, `registrations[]`, `machineLimit`.
- **AccountAssignment** (trên máy, trong `accounts.json`): `registrations[]` của mỗi tài khoản.
- **CliStateDir** (trên máy): thư mục trạng thái CLI theo (tài khoản, đăng ký).
- **SecretScope** (trên máy, spec 031): `registrationId` hoặc `local`.
- **OrgPolicy** (hub): thêm `aiAccountSharing`, `machineIsolation`.
- **Machine** (hub, đã có): một dòng mỗi đăng ký; thêm `coTenancyNote` (tuỳ chọn, chủ máy bật).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Chủ máy thêm đăng ký thứ hai trong dưới 2 phút, không phải gỡ đăng ký đầu.
- **SC-002**: Trong bộ kiểm thử cách ly (100 run xen kẽ hai đăng ký), 0 run thấy đường dẫn, biến, token, skill, memory,
  cấu hình MCP, plugin hay bí mật của đăng ký kia.
- **SC-003**: 0 gói hay lần ghi của đăng ký A tới hub hay tổ chức B, kiểm bằng log nhận của hai hub thử.
- **SC-004**: Quản trị tổ chức A gọi mọi API về máy, run, tài khoản, điểm token và không nhận được dữ liệu nào cho biết máy
  có đăng ký khác (kiểm bằng so sánh phản hồi khi máy có và không có đăng ký B).
- **SC-005**: Với hai đăng ký cùng có việc, mỗi đăng ký nhận ít nhất phần công bằng của mình trừ 1 chỗ, đo trên cửa sổ 30
  phút.
- **SC-006**: 100% máy một đăng ký nâng cấp mà không phải đăng ký lại, không mất run đang chạy, hàng chờ hay gắn dự án.
- **SC-007**: Gỡ một đăng ký không làm đổi byte nào trong thư mục và keychain của đăng ký khác.
- **SC-008**: Mọi lỗ phân quyền mức Cao ở rbac-review.md có test chứng minh đã sửa trước khi tính năng phát hành.

## Assumptions

- **A1**: Một tiến trình worker cho mọi đăng ký (giữ `instancelock`), không phải một tiến trình mỗi đăng ký. Lý do: chia
  chỗ chạy và quota tài khoản cần một bộ đếm chung. Mức `tách-người-dùng` thêm tiến trình con theo người dùng.
- **A2**: Hub không cần biết khái niệm "nhiều đăng ký". Phần hub chỉ gồm: tên tổ chức trong kết quả đăng ký, `machine_busy`,
  hai điều khoản chính sách, cờ `coTenancyNote`, và các sửa phân quyền.
- **A3 (mặc định)**: Tối đa 8 đăng ký mỗi máy.
- **A4 (mặc định)**: Tài khoản AI hiện có khi nâng cấp là dùng chung.
- **A5 (mặc định)**: Chính sách tại máy cho dự án không gắn đăng ký: bí mật `allow`, toàn quyền theo công tắc của chủ máy,
  giữ log 30 ngày.
- **A6 (mặc định)**: Mức cách ly mặc định là `chung-người-dùng`. Lý do: `tách-người-dùng` cần quyền quản trị hệ điều hành
  để tạo tài khoản và làm khó dùng CLI có đăng nhập qua trình duyệt.
- **A7**: Quản trị hệ thống của một hub chung có thể suy ra hai đăng ký cùng máy qua IP và thời điểm. Spec không chống
  việc này; chủ máy muốn tránh thì dùng hai hub hoặc mạng khác.
- **A8**: Cách tách đăng nhập khỏi trạng thái CLI khác nhau theo CLI (Claude Code trên macOS giữ đăng nhập trong Keychain
  theo thư mục cấu hình). Plan nghiên cứu từng CLI; CLI không tách được thì theo FR-041 câu cuối.
- **A9**: Spec 027 (hộp thư đi, khoá máy) và 031 (bí mật) đang làm. Phần phụ thuộc chúng ghi rõ trong tasks.md.

## Câu hỏi cho chủ dự án

| # | Câu hỏi | Khuyến nghị | Ảnh hưởng nếu chọn khác |
|---|---|---|---|
| Q1 | Mức cách ly mặc định khi máy có từ hai đăng ký? | `chung-người-dùng`, kèm cảnh báo khi bật toàn quyền | `tách-người-dùng` mặc định an toàn hơn nhưng cần quyền admin máy và làm hỏng đăng nhập CLI qua trình duyệt |
| Q2 | Tài khoản AI hiện có khi thêm đăng ký thứ hai: dùng chung hay hỏi? | Dùng chung, app hỏi một lần lúc thêm đăng ký | Hỏi bắt buộc làm thêm bước; riêng mặc định làm run của đăng ký mới không có tài khoản |
| Q3 | Có cho quản trị tổ chức biết máy làm cho tổ chức khác? | Không, trừ khi chủ máy bật (US8 kịch bản 3) | Bắt buộc báo thì lộ thông tin khách hàng của người làm thuê |
| Q4 | Có cho tổ chức cấm máy làm cho tổ chức khác (máy độc quyền)? | Không trong bản này | Có thì máy phải báo hub số đăng ký, trái FR-070 |

## Out of Scope (có thể làm sau)

- Runner host nhiều đăng ký.
- Đồng bộ đăng ký giữa nhiều máy của cùng một người.
- Cách ly bằng container cho máy dev.
- Bảng "máy vật lý" trên hub và báo cáo tổng hợp theo máy.
- Máy độc quyền theo tổ chức (Q4).
