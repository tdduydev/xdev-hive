# Rà soát phân quyền (spec 034)

**Ngày**: 2026-10-23. **Phạm vi**: hub (`apps/hub/src`), hợp đồng vai trò (`packages/contracts/src/roles.ts`), token máy
và token run, cộng phần worker và desktop liên quan tới máy nhiều tổ chức.

**Cách làm**: đọc từng middleware, từng hàm kiểm quyền, policy RLS và từng chỗ nhận token. Mục "chưa kiểm" ghi rõ
những gì chưa đọc hết. Đường dẫn dưới đây tính từ `apps/hub/src` nếu không ghi khác.

Ký hiệu phạm vi: **S** hệ thống, **O** tổ chức, **T** đội, **P** dự án, **M** máy, **R** run.

## 1. Mô hình vai trò hiện có

| Lớp | Giá trị | Nơi định nghĩa | Ghi chú |
|---|---|---|---|
| Vai trò tổ chức | owner > admin > member | `modules/tenancy/permissions.ts:8` | Owner/admin tổ chức được coi là admin mọi đội (`teamRolesOf`, dòng 91) |
| Vai trò đội | admin > member > ba > viewer | `permissions.ts:11` | `ba` xếp trên `viewer`, dưới `member` |
| Vai trò tuỳ chỉnh | tập quyền, phạm vi tổ chức hoặc đội | `modules/tenancy/roles.ts`, catalog `packages/contracts/src/roles.ts:17-66` | Chỉ **cộng thêm** quyền: `allowWith` thử kiểm theo hạng trước, hỏng mới xét quyền tuỳ chỉnh |
| Chủ máy | `machines.registeredBy` | `modules/fleet/schema.ts` | Không phải vai trò. Chỉ dùng cho máy cá nhân (ADR 0017) và xoá số liệu máy |
| Quản trị hệ thống | Không có trong code | — | Gần nhất: danh sách email `orgCreators` được tạo nhiều tổ chức (`procedures.ts:12`) |

## 2. Bảng các điểm kiểm quyền

### 2.1 Middleware và cách chọn tổ chức

| Điểm kiểm | Ai | Kiểm gì | Phạm vi | Lỗ |
|---|---|---|---|---|
| `authed` (`modules/tenancy/procedures.ts:41`) | Phiên Better Auth, hoặc token cá nhân qua `withPersonalTokens` | Đã đăng nhập | người dùng | — |
| `inOrg` (`procedures.ts:51`) | Người đăng nhập | `withTenant` + `requireOrgRole(member)` | O | — |
| `orgMember` (`procedures.ts:62`) | Người đăng nhập | Như trên, transaction ngắn | O | — |
| `selectedOrg` (`procedures.ts:72`) | — | `input.orgId` (đường dẫn) thắng header `x-hive-org` | O | **R3**: token cá nhân chỉ so tổ chức với header |
| Router fleet `orgContext`/`inOrg` (`modules/fleet/router.ts:77-91`) | Phiên Better Auth | Chỉ chọn tổ chức theo header. **Không** gọi `requireOrgRole` | O | **R4**: dựa vào từng hàm fleet tự kiểm |
| Router artifacts (`modules/artifacts/router.ts:60-92`) | Phiên | Middleware riêng + `stampOrg` | O | Chưa kiểm hết |
| Router audit (`app.ts:191-232`) | Phiên | `orgMember`; đọc cần `audit.read`; đổi thời hạn cần admin tổ chức | O | — |
| Router quản trị token MCP (`modules/mcp/admin-router.ts:22-33`) | Chỉ phiên Better Auth | Token cá nhân không quản lý được token | O | — |
| Không cần tổ chức | `orgs.mine`, `orgs.create`, `invitations.accept` | Đúng thiết kế | người dùng | — |

### 2.2 Token

| Token | Kiểm ở | Cấp phạm vi | Hạn, thu hồi | Lỗ |
|---|---|---|---|---|
| Cookie phiên | Better Auth `getSession` | người dùng; tổ chức qua `inOrg` | Better Auth | — |
| Token cá nhân `hive_pat_<org>_<bí mật>` | `modules/mcp/admin-service.ts:203-241`; cầu REST `personal-token-auth.ts:18-58` | O; **toàn bộ quyền người dùng**, không có scope | 1-90 ngày; chủ hoặc admin thu hồi; kiểm lại thành viên mỗi lần gọi MCP | **R3**; **R9** không có scope |
| Token desktop/CLI | `issueDesktopToken` (`admin-service.ts:145`); trao đổi mã `modules/fleet/desktop-connect.ts:99` | Như token cá nhân | 90 ngày | Keychain desktop chỉ theo hub URL (spec 034 FR-008) |
| Token run (HS256, khoá HKDF) | `modules/runs/token.ts:90`; kiểm run thuộc tổ chức, lần thử, task, trạng thái ON_MACHINE | R; hành động thay `run.createdBy`; danh sách công cụ theo `registry.list` | Hết hạn theo timeout run; mất hiệu lực khi run rời ON_MACHINE | **R7**: không kiểm lại tư cách thành viên của người tạo run |
| Token terminal | `modules/terminal/token.ts:55`, `modules/terminal/mcp-tokens.ts:26-69` | O/P; `propose` hay `bypass` | 24 giờ; đóng khi mất quyền (kiểm mỗi lần gọi và quét 60 giây) | — |
| JWT OAuth MCP | `modules/mcp/endpoint.ts:115`; chọn tổ chức `modules/mcp/server.ts:40-117` | người dùng; kiểm thành viên trong transaction | Theo JWT | — |
| Machine token `hwm_` | `withTokenLookup` (`modules/fleet/tokens.ts:24`) + `authenticateMachine` (`modules/fleet/machines.ts:232`) | M | Sống tới khi thu hồi (spec 027 thay bằng access token ngắn) | **R2** (đăng ký lại cùng tên) |
| Mã đăng ký `hwr_` | `registerMachine` (`modules/fleet/registration.ts:62`) | T | Có hạn, dùng một lần | **R2** |
| Liên kết công khai artifact | `modules/artifacts/public-links.ts:235-289` | Một bản artifact, chỉ đọc | Hạn + thu hồi + chính sách tổ chức + chủ còn là thành viên | Không thấy lỗ |
| Vé khung artifact | HMAC (`modules/artifacts/ticket.ts:55`) | Một khung | Chưa kiểm hạn | Chưa kiểm |
| Webhook git, skill repo, docsync | HMAC / token GitLab (`modules/scm/verify.ts`, `modules/knowledge/skill-repo.ts:598`, `modules/docsync/webhook.ts:46`) | P hoặc repo | Đổi bí mật | — |
| Webhook Slack / Telegram | `modules/chat/webhooks.ts:14,129` | bot chat | — | Telegram chưa kiểm |

### 2.3 Kiểm quyền theo module

| Module / thao tác | Ai được | Phạm vi | Lỗ |
|---|---|---|---|
| Leader `threads.list`, `threads.get` (`modules/leader/router.ts:37-55`) | Mọi thành viên tổ chức | O (RLS) | **R1**: đọc được hội thoại Leader của đội mình không thuộc, kể cả ngữ cảnh dự án |
| Leader `approvals.list` | Mọi thành viên tổ chức | O | **R1** |
| Leader `approvals.reject` (`modules/leader/service.ts:186`) | Mọi thành viên tổ chức, kể cả viewer đội khác | O | **R1** |
| Leader `approvals.approve` | Người có quyền làm hành động (dùng lại guard của task, run, cài đặt dự án, SDLC) | T/P | Người duyệt đổi được cấp mô hình không cần quyền thêm; `leader.approve` khai mà không kiểm |
| Leader `threads.send` | Người được `startLeaderRun` cho phép; tin được lưu trước, rollback nếu bị chặn | P | Thấp: guard nằm sau bước đọc ngữ cảnh dự án |
| Cây giao việc (`modules/leader/tree.ts`) | Lọc theo `teamRolesOf`, phần không thấy tính là ẩn | T | — |
| Máy: xem danh sách (`modules/fleet/machines.ts:47`) | Admin đội hoặc `machines.read` tuỳ chỉnh | T | **R8**: vai trò hệ thống `member` khai `machines.read` mà server chặn |
| Máy: nhãn, sửa, tạm dừng, dùng chung (`machines.ts:68-186`) | Admin đội | T | **R6**: chủ máy cá nhân không tự quản máy mình; vai trò tuỳ chỉnh không áp |
| Máy: thu hồi (`machines.ts:96`) | Admin đội hoặc `machines.remove` | T | **R6** |
| Máy: đăng ký (`registration.ts`, `desktop-connect.ts:40`) | Admin đội hoặc `machines.register` | T | **R2** |
| Máy: xoá số liệu máy gửi (`modules/fleet/project-usage.ts:85`) | Chỉ chủ máy | M | — |
| Máy: tài khoản AI (`modules/fleet/accounts.ts`) | Admin đội (`adminMachine`) | T/M | **R5** (máy nhiều tổ chức) |
| Giao run lên máy (`modules/runs/engine.ts:554-561`, `startRun` 2609-2651) | Thành viên đội + `tasks.assign`; máy cá nhân chỉ chạy run của chủ | T/M | — |
| Vai trò tuỳ chỉnh: gán (`roles.ts`) | Admin tổ chức hoặc `roles.write`; chỉ cấp được quyền mình có | O | **R10**: `unassign` không gọi `requireCanGrant`; gán cho đội không kiểm phạm vi của vai trò |
| Audit: đổi thời hạn | Admin tổ chức | O | Vai trò tuỳ chỉnh không cấp được (có vẻ cố ý) |

### 2.4 RLS và `withTenant`

| Điểm | Hiện trạng | Lỗ |
|---|---|---|
| `withTenant` (`modules/platform/db.ts:23-40`) | Đặt `app.user_id`, `app.org_id`, `app.invite_token_hash` theo transaction | — |
| Policy chuẩn | `org_id = hive.ctx_org()` cho `hive_app` | Chỉ theo tổ chức. Cách ly đội và dự án hoàn toàn ở code, nên mỗi truy vấn theo id phải tự kiểm đội (**R1**, FR-091) |
| Tra theo hash không có tổ chức | Token máy (migration 0009), webhook dự án (0016), skill repo (0047, 0075), kênh chat (0067) | — |
| Hàm SECURITY DEFINER | Liệt kê dọn dẹp và cron theo tổ chức; phần lớn chỉ trả id hoặc boolean | **Chưa kiểm** thân hàm ở migration 0039:51 và 0077:38 |

### 2.5 Máy nhiều tổ chức (worker, desktop)

| Điểm | Hiện trạng | Lỗ khi máy có hai đăng ký |
|---|---|---|
| Socket cục bộ (ADR 0019) | Kiểm UID/SID của tiến trình gọi | **R11**: mọi tiến trình cùng người dùng gửi được lệnh cho mọi đăng ký. Spec FR-021 |
| `account_set` từ web | Admin đội của máy dùng chung đổi tài khoản AI trên máy | **R5**: admin tổ chức A tắt hay đổi tài khoản B đang dùng. Spec FR-044 |
| Tóm tắt tài khoản trong heartbeat | Gửi mọi tài khoản | **R12**: hub A thấy nhãn tài khoản riêng của B. Spec FR-045 |
| Keychain token cá nhân (`apps/desktop/src-tauri/src/account.rs:76`) | Khoá theo hub URL | Hai tổ chức cùng hub ghi đè nhau. Spec FR-008 |
| `secrets-policy.json` (spec 031) | Khoá theo hub URL | Chính sách tổ chức này áp nhầm sang tổ chức kia. Spec FR-031 |
| Trạng thái CLI | Một `ConfigDir` cho mỗi tài khoản | Skill, memory, MCP, plugin lẫn giữa tổ chức. Spec FR-041 |

## 3. Rủi ro, xếp hạng

| # | Rủi ro | Mức | Ai lợi dụng được | Hậu quả |
|---|---|---|---|---|
| R1 | Hội thoại Leader và đề xuất chỉ cách ly theo tổ chức | **Cao** | Mọi thành viên tổ chức, kể cả viewer của đội khác | Đọc trao đổi và ngữ cảnh dự án của đội khác; từ chối đề xuất của đội khác |
| R2 | Đăng ký lại cùng tên chiếm máy cá nhân của người khác | **Cao** | Người có `machines.register` hay admin đội | Lấy id máy, lịch sử, và chủ máy đổi sang người tạo mã |
| R3 | Token cá nhân của tổ chức A gọi được route `/v1/orgs/{B}` | Trung bình | Người giữ token, là thành viên B | Ràng buộc tổ chức của token vô hiệu; token lộ ở A dùng được ở B |
| R4 | Router fleet không kiểm thành viên tổ chức | Trung bình | Người đăng nhập ở tổ chức khác đặt header | Hiện các hàm fleet đã kiểm đội nên chưa thấy lộ; một hàm quên kiểm là lộ |
| R5 | `account_set` chéo tổ chức trên máy nhiều đăng ký | **Cao** (khi có 034) | Admin đội tổ chức A | Tắt, đổi giới hạn tài khoản tổ chức B dùng |
| R11 | Socket cục bộ không phân đăng ký | **Cao** (khi có 034) | Agent của run A | Gửi đề xuất, memory, cập nhật task vào hub B |
| R12 | Tóm tắt tài khoản gửi mọi hub | Trung bình (khi có 034) | Admin tổ chức A | Biết máy có tài khoản riêng của tổ chức khác |
| R6 | Chủ máy cá nhân không tự tạm dừng, thu hồi máy mình | Thấp | — | Trái ADR 0017; chủ máy phải nhờ admin |
| R7 | Token run không kiểm lại tư cách thành viên người tạo | Trung bình-thấp | Người vừa bị khoá giữa run | Run tiếp tục tới hết timeout |
| R8 | Vai trò hệ thống khai quyền server không cấp (`machines.read`) | Thấp | — | Giao diện hiện nút bấm xong lỗi |
| R9 | Token cá nhân không có scope | Trung bình-thấp | Ai lấy được token | Toàn bộ quyền người dùng trong tổ chức |
| R10 | `roles.unassign` không kiểm `requireCanGrant`; gán vai trò đội không kiểm phạm vi | Thấp | Người có `roles.write` | Gỡ vai trò mạnh hơn mình; vai trò tổ chức gán vào đội |
| R13 | Quyền khai trong catalog mà không có điểm kiểm | Thấp | — | Admin tưởng đã cấp hay chặn được (`tasks.read/create/delete`, `runs.read/retry/cancel`, `plans.read`, `leader.chat`, `leader.approve`, `docs.*`, `skills.read`, `memory.read`, `proposals.*`, `projects.read/archive`, `merge.force`, `mcp.tokens`, `members.read/role`, `costs.budget`) |
| R14 | `ba` có `leader.terminal` | Thấp | BA | Đúng thiết kế spec 011; ghi lại để chủ dự án xác nhận |

Câu hỏi về viewer và ba: chưa liệt kê hết thao tác ghi chỉ đòi `viewer`. Lỗ cụ thể đã thấy là R1 (viewer từ chối đề
xuất). Việc rà toàn bộ là T090 trong tasks.md.

## 4. Sửa đề xuất

| Ưu tiên | Sửa | Rủi ro | FR | Module | Trạng thái |
|---|---|---|---|---|---|
| 1 | Lọc hội thoại Leader và đề xuất theo đội của dự án; hội thoại không gắn dự án chỉ người tạo và admin tổ chức thấy; từ chối đề xuất cần vai trò `member` của đội | R1 | FR-090, FR-091 | leader | Làm trong nhánh này |
| 2 | Đăng ký lại cùng tên: chỉ khi người tạo mã là chủ máy cũ hoặc admin đội; giữ chủ máy cũ; audit ghi chủ cũ | R2 | FR-093 | fleet | Làm trong nhánh này |
| 3 | Token cá nhân: tổ chức được chọn (đường dẫn hay header) phải trùng tổ chức của token | R3 | FR-094 | tenancy | Làm trong nhánh này |
| 4 | Router fleet kiểm `requireOrgRole(member)` như `inOrg` chung | R4 | FR-091 | fleet | Làm trong nhánh này |
| 5 | `machine_busy` không loại máy khỏi run | (lập lịch) | FR-055 | runs | Làm trong nhánh này |
| 6 | `account_set` chỉ áp tài khoản gán riêng; heartbeat lọc tài khoản; socket mang mã phiên run | R5, R11, R12 | FR-021, FR-044, FR-045 | worker | Chờ 027 (`channel`, `localipc`) |
| 7 | Chủ máy cá nhân tự tạm dừng, tiếp tục, thu hồi máy mình | R6 | FR-098 | fleet | Làm trong nhánh này |
| 8 | `roles.unassign` gọi `requireCanGrant`; gán cho đội từ chối vai trò phạm vi tổ chức | R10 | FR-092 | tenancy | Làm trong nhánh này |
| 9 | Bỏ `machines.read` khỏi vai trò hệ thống `member`/`team-member`, hoặc cho `listMachines` xét quyền hệ thống | R8 | FR-092 | contracts, fleet | Hỏi chủ dự án (Q-R2) |
| 10 | Đánh dấu quyền chưa có điểm kiểm là "chưa áp dụng" trên màn vai trò, hoặc thêm điểm kiểm | R13 | FR-092 | contracts, web | Sau |
| 11 | Token run kiểm lại tư cách thành viên người tạo mỗi lần gọi công cụ ghi | R7 | FR-094 | mcp | Bị chặn (module mcp không được sửa trong nhánh này) |
| 12 | Scope cho token cá nhân (chỉ đọc, chỉ MCP) | R9 | FR-094 | mcp, contracts | Sau |
| 13 | Kiểm thân hàm SECURITY DEFINER 0039, 0077; hạn vé khung artifact; bí mật Telegram | — | — | — | Sau, rà riêng |

## 5. Câu hỏi về phân quyền cho chủ dự án

| # | Câu hỏi | Khuyến nghị |
|---|---|---|
| Q-R1 | Hội thoại Leader không gắn dự án: ai thấy? | Người tạo và owner/admin tổ chức |
| Q-R2 | `member` có được xem danh sách máy của đội không? | Có, nhưng chỉ thông tin chung (tên, trạng thái, tải); tài khoản AI và nhãn vẫn chỉ admin. Cần sửa cả server và catalog |
| Q-R3 | Admin đội đăng ký lại máy cá nhân của thành viên: giữ chủ cũ hay đổi chủ? | Giữ chủ cũ. Muốn đổi chủ thì thu hồi rồi đăng ký mới |
| Q-R4 | `ba` có cần `leader.terminal` không? | Giữ như spec 011, nhưng chỉ mode `propose` |
