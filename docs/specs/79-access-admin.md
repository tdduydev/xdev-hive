# 79. access-admin: khoá chặt quyền quản trị, vai trò cho agent, tự duyệt có kiểm soát, nhiều ổ đĩa

Hỏi 10/10: "tiếp tục thiết kế phần quản trị users, quyền, permissions", "thêm phần tự duyệt" (đề xuất tài liệu, memory của agent, task review → merge/done, bản app mới) và "các máy có nhiều disk" (hiện đủ mọi ổ đĩa).

**Trạng thái: người dùng đã duyệt hướng đi ngày 10/10.** Các quyết định:

- **Q1 (MFA):** TOTP, bắt buộc cho tài khoản admin và owner; người khác tự chọn.
- **Q2 (phòng ban):** tạo trong Hive (76c), map từ nhóm SSO làm sau (79e).
- **Q3 (tự duyệt đề xuất của chính mình):** admin được tự duyệt, mọi lần đều ghi audit. Trả lời Q3 còn mở của spec 76.
- **Q4:** viết spec này, chia task, làm P0 trước.

Spec này nối tiếp [76-access-first.md](76-access-first.md) và không làm lại các mục của 76:

| 76 | Nội dung | Ghi chú |
|---|---|---|
| 76b | kiểm quyền một chỗ, test ma trận | 79 dựa vào |
| 76c | phòng ban, trưởng phòng | 79d và 79e mở rộng |
| 76d | token MCP cá nhân có hạn, trang Kết nối MCP | 79c dựa vào |
| 76e | luồng duyệt tài liệu | 79k thêm tự duyệt vào luồng này |
| 76f | khu Quản trị trên web | 79f, 79g, 79i đặt trong khu này |

Quy tắc gốc giữ nguyên: **một lần gọi được làm gì = quyền của tài khoản ∩ phạm vi token ∩ giới hạn của loại token.** Token chỉ thu hẹp quyền, không bao giờ mở rộng. Thêm hai quy tắc:

1. **Chỉ phiên web của người mới được quản trị.** Token máy, token cá nhân và credential của run không bao giờ qua được cổng `hubAdmin`, dù tài khoản sở hữu là admin.
2. **Mọi thứ tự động đều có tên.** Tự duyệt, tự merge và tự phát hành ghi audit với tác nhân `auto:<luật>` và lý do. Không có hành động tự động nào ẩn danh.

## 1. Hiện trạng (đọc code main c7403c3b, 10/10)

- **Mô hình** (`packages/core/src/access.ts`):
  - 16 quyền và 5 vai project (viewer, member, qa, reviewer, lead), cộng quyền tuỳ chỉnh.
  - 4 vai hub: owner, admin, member, viewer.
  - Quyền theo hệ thống chỉ được **tính ra** từ các service, không lưu riêng.
- **Thực thi** (`apps/web/src/app.ts`):
  - `METHOD_ROLES` cho vai tối thiểu, `may()` kiểm quyền trên từng project.
  - `WEB_RPC` có `hubAdmin` nghĩa là `role === "admin" && !access`.
- **Lỗ hổng** (khảo sát 10/10):
  - Token máy của admin được role `admin` và không có `access`, nên qua được cổng `hubAdmin`. Việc phân biệt nó với người thật dựa vào header `source`/`agent` mà client tự gửi.
  - Credential MCP và credential của run bị giới hạn ở vai `agent`: không có `taskManage`, `codeReview`, `runDispatch`, kể cả khi chủ là admin. Trong khi token máy thô của cùng người đó thì không bị giới hạn gì. Hệ quả: người ta phải dùng token máy để tạo hoặc đóng task (QA-5, và chính phiên 10/10).
  - Khoá tài khoản không thu hồi token: mở khoá lại là token cũ chạy lại (`tokens.ts` có `revokeOwned` nhưng không ai gọi).
  - SSO tạo tài khoản cho bất kỳ ai đăng nhập được ở nhà cung cấp. Không có danh sách tên miền, không đọc claim nhóm.
  - Audit chỉ lọc theo agent, user, run: không có khoảng ngày, đối tượng, xuất CSV.
  - Không có MFA, danh sách phiên, hay bước nhập lại mật khẩu trước thao tác quản trị.
  - Trình sửa quyền nhận project gõ tay, không gán được theo hệ thống, không chép từ người khác.
  - Trang Người dùng, Sơ đồ tổ chức và ma trận quyền phải cuộn ngang trên điện thoại.
- **Tự duyệt:**
  - Đề xuất tài liệu: không có.
  - Memory: chỉ một công tắc chung cho cả hub (`HIVE_MEMORY_APPROVAL`).
  - Review → merge → done: đã có qua các cổng SDLC (`review`/`merge`/`release` chạy `auto`) hoặc merge queue. Task không nằm trong flow thì không có.
  - Rollout bản app: chỉ có trong auto-release (cần 5 điều kiện); upload bằng tay hoặc qua CI không đổi bản đích.
- **Ổ đĩa:** heartbeat (`runner/system.ts`) và trang Máy này (`machine-stats.ts`) mỗi nơi chỉ đo **một** ổ.

## 2. P0: vá quyền quản trị

### 79a. admin-is-a-person

- Cổng `hubAdmin` thêm điều kiện: actor là **phiên web của người** (`humanSession`), không phải token. Token máy chỉ giữ quyền runner: heartbeat, nhận và báo run, upload artifact, những việc `METHOD_ROLES` cho vai `agent`/`runner`.
- Việc nhận diện dựa vào **loại credential** mà server cấp (phiên, token hub, credential MCP, credential run), không dựa vào header client gửi.
- Bỏ đường token admin không có chủ: token tạo bằng CLI phải có chủ; token cũ không có chủ bị hạ xuống `member` và hiện cảnh báo trên trang Token.
- Test: ma trận actor × method của 76b, thêm các hàng token máy admin, token cá nhân admin, credential MCP của admin. Cả ba đều phải bị từ chối ở mọi RPC `hubAdmin`.

### 79b. agent-roles

- Mỗi project có **"Agent được làm gì"**: một tập quyền cho các agent chạy trên project đó, mặc định như hiện nay (view, taskWork, docPropose, memoryWrite). Lead có thể thêm `taskManage`, `codeReview`, `runDispatch`, `chatUse`.
- Quyền thật của agent = tập này ∩ quyền của chủ agent (người sở hữu máy hoặc token). Không bao giờ vượt quá chủ.
- Áp cho credential MCP, credential run và token máy khi gọi các method của project. `ROLE_CAP.agent` thành giá trị mặc định, không còn là giới hạn cứng.
- Giao diện: trang Thành viên của project có thêm một hàng "Agent".
- Kết quả: agent của admin tạo task, review và đóng task bằng **danh tính của chính nó**, không cần token máy.

### 79c. disable-revokes

- Khoá tài khoản thì xoá mọi phiên, thu hồi token hub, token cá nhân (76d) và credential MCP của người đó. Mở khoá lại không làm token cũ sống lại.
- Đưa vào thùng rác cũng vậy. Ghi audit `user.disable` kèm số token đã thu hồi.
- Đổi mật khẩu thì đăng xuất mọi phiên khác.

## 3. P1: quản lý quy mô lớn

### 79d. system-grants

- Gán quyền theo **hệ thống**: một lần cho cả hệ thống, áp cho mọi service, kể cả service thêm vào sau. Bảng `hub_grants` thêm cột `scope` (`project` | `system`).
- Quyền thật trên một service = quyền cao nhất trong ba nguồn: gán trực tiếp, gán theo hệ thống, và theo phòng ban (76c).
- Trình sửa quyền:
  - chọn project hoặc hệ thống từ danh sách, có ô tìm;
  - "Chép quyền từ người khác";
  - xem trước quyền thật sau khi lưu.

### 79e. sso-policy

- `HIVE_OIDC_ALLOWED_DOMAINS` (danh sách tên miền email): ngoài danh sách thì không tạo tài khoản. Hiện trên trang thiết lập hub.
- Map claim nhóm (`groups`, cấu hình được tên claim) vào phòng ban của 76c lúc đăng nhập. Chỉ thêm người vào phòng ban có trong bảng map, không tự tạo phòng ban.
- Tài khoản SSO mới mặc định không có quyền gì, như hiện nay, cho tới khi có phòng ban hoặc được gán.

### 79i. custom-roles

- Trang Vai trò & quyền cho tạo **vai trò tuỳ chỉnh có tên** (một tập quyền project), dùng như 5 vai có sẵn.
- Không sửa được 5 vai có sẵn. Xoá một vai đang được dùng thì phải chọn vai thay thế.

## 4. P2: kiểm soát và vận hành

### 79f. audit-plus

- Server: lọc theo khoảng ngày, đối tượng (project, task, doc, user), nhóm hành động (quyền, tài liệu, task, run, phát hành, tự động).
- Xuất CSV theo bộ lọc. Tab "Hoạt động" trên trang của từng người dùng.
- Hành động tự động hiện tác nhân `auto:<luật>` và có bộ lọc riêng.

### 79g. sessions

- Mỗi người xem được các phiên đang mở của mình (thiết bị, IP, lần dùng cuối) và đăng xuất từng phiên. Admin xem và thu hồi được phiên của người khác.
- **Xác nhận lại trước thao tác quản trị:** đổi vai hub, đổi quyền, khoá người, thu hồi token, đổi luật tự duyệt đều cần nhập lại mật khẩu (hoặc mã TOTP) trong vòng 10 phút gần nhất.

### 79h. mfa-totp

- TOTP (RFC 6238) kèm 10 mã dự phòng dùng một lần. Bắt buộc cho owner và admin: đăng nhập lần tới chưa có TOTP thì phải cài trước khi vào khu Quản trị.
- Người dùng SSO thì dựa vào MFA của nhà cung cấp; không bắt buộc TOTP thêm (cấu hình được).
- Owner reset được TOTP của admin khác, có ghi audit. Owner duy nhất mất TOTP thì khôi phục bằng CLI trên máy chủ.

### 79j. access-mobile

- Dưới 768px: Người dùng, Sơ đồ tổ chức và ma trận quyền hiện dạng thẻ hoặc danh sách, không cuộn ngang. Các thao tác hàng loạt chuyển vào thanh dưới.

## 5. Tự duyệt (mặc định tắt, bật theo từng project, hub đặt mức trần)

Chế độ chung: `human` (người duyệt, như hiện nay) · `ai` (một agent review, approve thì thực hiện) · `auto` (thực hiện ngay khi điều kiện đủ). Đặt trong cài đặt SDLC của project. Hub có mức trần cho từng loại: project không bật cao hơn trần được. Chỉ người có `projectSettings` mới đổi được, và cần xác nhận lại theo 79g. Mọi lần tự duyệt ghi audit `auto:<luật>`.

### 79k. auto-doc-proposals

- `docProposals: human | ai | auto`. `ai` chạy một review run (như stage `check` của flow); verdict approve thì ghi tài liệu.
- **Luôn cần người**: tài liệu mà agent đọc (AGENTS.md, CLAUDE.md, `docs/decisions.md`, các doc cần `contextEdit`) và các đề xuất hành động CLI.
- Đề xuất bị xung đột `baseVersion` thì không bao giờ tự ghi.

### 79l. auto-memory

- `memoryApproval: human | auto`, kèm danh sách agent tin cậy (tuỳ chọn). Biến `HIVE_MEMORY_APPROVAL` của hub là mức trần.
- Memory có cờ `conflictsWith` hoặc thay thế (`supersedes`) một mục do người viết thì luôn cần người.

### 79m. auto-merge-on-approve

- Cho task **không nằm trong flow**: `autoMergeOnApprove`. Khi review approve và pipeline của MR thành công thì bắt đầu merge, theo đúng đường `#startMerge` hiện có. MR merge xong thì task chuyển done (`doneOnMerge` đã có).
- Task trong flow giữ các cổng `review`/`merge`/`release` như hiện nay.
- Quy tắc của merge queue không đổi.

### 79n. auto-rollout

- Trang Phiên bản app thêm **"Tự đặt bản mới làm bản đích"**: phần trăm, cài lúc nào (`idle`), phiên bản tối thiểu.
- Bật thì mỗi lần một bản được nhận đủ file (upload qua `release.mjs`, import, hoặc auto-release) sẽ đặt rollout. Ghi audit `auto:rollout`.
- Bản đang tạm dừng (`paused`) thì không tự đổi.

## 6. 79o. all-disks

- `MachineSystem.disks?: Array<{ mount, label?, totalBytes, freeBytes, percent }>` (tối đa 16), giữ `disk` cũ cho app đời trước. `disk` vẫn là ổ chứa worktree, dùng cho việc dọn khi đầy (`runner.ts`).
- Đo:
  - Windows: `Get-CimInstance Win32_LogicalDisk -Filter DriveType=3` (ổ cố định).
  - Linux, macOS: `df -kP`, bỏ tmpfs, overlay, squashfs, devtmpfs và ổ ảnh của snap.
  - Làm mới cùng nhịp mẫu hệ thống hiện có.
- Hiện mỗi ổ một dòng trên trang Máy này (app) và trang Máy của hub. Ổ trên 90% hiện cảnh báo; ổ worktree có nhãn riêng.

## 7. Thứ tự và tiêu chí xong

1. **P0:** 79a → 79b → 79c. Mỗi mục có test ma trận actor × method (hàng mới trong test của 76b) và e2e cho phần giao diện.
2. **Tự duyệt và ổ đĩa:** 79o, 79l, 79m, 79n, 79k (79k sau 76e).
3. **P1:** 79d (sau 76c), 79e, 79i.
4. **P2:** 79f, 79g → 79h, 79j.

Mỗi mục xong khi:
- typecheck và `npm test` xanh;
- e2e web và mobile cho bước liên quan xanh;
- có chữ vi và en;
- ghi audit đúng tác nhân;
- spec này và roadmap được cập nhật.

## 8. Ngoài phạm vi

- OAuth cho MCP.
- Tài khoản dịch vụ.
- Hạn và xoay vòng token máy (76 đã để ngoài).
- WebAuthn/passkey: có thể làm sau 79h.
