# Feature Specification: Cây giao việc của agent

**Feature Branch**: `028-agent-delegation-tree`

**Created**: 2026-10-21

**Status**: Chủ dự án duyệt hướng ngày 2026-10-21. Có plan và code (2026-10-21).

**Input**: Chủ dự án (2026-10-21): "có cách nào kiểu hình cây gia phả không? terminal thì giữ terminal hiện tại, nhưng
cách kiểu bị agents làm task theo kiểu giao việc, leader giao việc phía dưới ấy, vẽ cây gia phả kiểu đó", rồi "ok duyệt"
với bản phác thảo cây (Leader → task → run → sub-agent), hiện ở cả web và app desktop.

## Vì sao làm

Leader nhận việc từ người dùng, tạo task, giao run cho agent trên các máy. Agent trong run lại có thể gọi sub-agent
(Claude Code gọi `Task`/`Agent`). Hiện người dùng chỉ thấy từng mảnh rời: chat của Leader, danh sách task, danh sách
run, terminal của một run. Không có chỗ nào cho thấy **ai giao việc gì cho ai, việc nào đang chạy, việc nào kẹt**.

Cây giao việc trả lời câu hỏi đó trên một màn, theo kiểu cây gia phả: gốc là phiên Leader, dưới là việc Leader giao,
dưới nữa là agent đang làm việc đó và sub-agent của nó. Terminal và log giữ nguyên; cây là lối vào chúng.

## Hiện trạng

Đã kiểm trong code `main` ngày 2026-10-21:

| Phần | Có gì | Spec này |
|---|---|---|
| Task do Leader tạo | Task ghi nguồn `kind: "leader"` nhưng **không ghi phiên Leader nào** (`apps/hub/src/modules/leader/actions.ts:80`) | Ghi phiên Leader |
| Run do Leader giao | `run.dispatch` tạo run thường, **không gắn với phiên Leader** (`leader/actions.ts:96`) | Ghi phiên Leader |
| Run con | Run review và plan có `parent_run_id` trỏ về run code (`apps/hub/src/modules/runs/engine.ts:1905`) | Dùng lại |
| Run của task | Run có task, máy, CLI, gói, trạng thái, thời gian, chi phí | Dùng lại |
| Sub-agent trong run | Worker chỉ gửi `tool_call` chung, **không nhận ra lần gọi sub-agent** | Làm mới |
| Cập nhật trực tiếp | Luồng sự kiện run (SSE) cho trang run; desktop poll | Dùng lại |
| Xem terminal/log | Web: trang run. Desktop: màn Terminal, màn Agent trên máy | Giữ nguyên, cây chỉ mở tới |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Xem cây việc Leader đã giao (Priority: P1)

Người dùng nhờ Leader làm tính năng "phân quyền menu". Leader tạo ba task và giao run cho agent trên hai máy. Người dùng
mở cây của phiên Leader đó và thấy ngay: gốc là phiên Leader, ba nhánh task, dưới mỗi task là run đang làm (máy, CLI, gói,
trạng thái, thời gian, chi phí), và run review dưới run code của nó.

**Why this priority**: là giá trị cốt lõi. Chỉ cần dữ liệu hub đã có cộng thêm liên kết với phiên Leader.

**Independent Test**: tạo một phiên Leader, cho Leader tạo hai task và giao run. Mở cây: đúng một gốc, hai nhánh task,
mỗi task có run của nó; run review nằm dưới run code.

**Acceptance Scenarios**:

1. **Given** Leader đã tạo task và giao run trong một phiên, **When** người dùng mở cây của phiên đó, **Then** cây có gốc
   là phiên, nhánh là task, lá là run, đúng quan hệ cha con.
2. **Given** run code có run review và run plan, **Then** hai run đó nằm dưới run code, không nằm ngang hàng.
3. **Given** người dùng tự tạo task (không qua Leader) rồi Leader giao run cho task đó, **Then** task vẫn hiện trong cây
   của phiên Leader, đánh dấu "người dùng tạo, Leader giao".
4. **Given** một nút, **Then** nút hiện: tên (task) hay loại run, máy, CLI, gói, trạng thái, thời gian chạy, chi phí;
   nút có lỗi hiện lý do ngắn.
5. **Given** người dùng không có quyền xem một dự án, **Then** task và run của dự án đó không có trong cây, và cây báo
   "N mục bị ẩn do quyền".

---

### User Story 2 - Cây cập nhật trực tiếp và mở terminal từ cây (Priority: P1)

Người dùng để cây mở trong lúc agent làm việc. Run chuyển từ "chờ máy" sang "đang chạy" rồi "xong" mà không phải tải lại.
Bấm vào run đang chạy thì mở đúng terminal hay log của run đó, ở chỗ đang có (trang run trên web, màn Terminal trên app
máy đã chạy run).

**Why this priority**: cây chỉ có ích khi phản ánh lúc đang chạy; mở terminal từ cây là lý do người dùng xin tính năng.

**Independent Test**: mở cây, cho một run đổi trạng thái. Nút đổi trong 5 giây, không tải lại trang. Bấm nút run: mở
đúng trang run hay tab terminal của run đó.

**Acceptance Scenarios**:

1. **Given** cây đang mở, **When** run đổi trạng thái hay Leader giao thêm việc, **Then** cây đổi theo trong 5 giây.
2. **Given** run đang chạy trên chính máy đang mở app desktop, **When** bấm nút run, **Then** mở màn Terminal/Agent trên
   máy ở đúng phiên của run.
3. **Given** run ở máy khác, **When** bấm nút run, **Then** mở trang run với siêu dữ liệu (theo ranh giới dữ liệu của
   spec 027) và câu "Log nằm trên máy <tên máy>".
4. **Given** cây lớn, **Then** người dùng thu gọn hay mở rộng từng nhánh, và chọn "chỉ hiện việc đang chạy hoặc lỗi".

---

### User Story 3 - Sub-agent bên trong run (Priority: P2)

Agent trong run gọi sub-agent "Explore" để tìm code, rồi "test-runner" để chạy test. Dưới nút run, người dùng thấy hai
nút sub-agent với tên loại, mô tả ngắn, trạng thái, thời gian và token đã dùng.

**Why this priority**: cho thấy agent chia việc thế nào và tốn token ở đâu; cần worker nhận diện sub-agent nên làm sau
US1, US2.

**Independent Test**: chạy run có agent gọi hai sub-agent (một song song, một nối tiếp). Cây có hai nút sub-agent đúng
thứ tự bắt đầu, có token và thời gian khi xong.

**Acceptance Scenarios**:

1. **Given** agent gọi sub-agent, **When** sub-agent bắt đầu và kết thúc, **Then** cây có nút sub-agent với loại, mô tả
   ngắn, trạng thái, thời gian, token.
2. **Given** sub-agent gọi tiếp sub-agent, **Then** nút con nằm dưới nút cha của nó.
3. **Given** CLI không cho biết lần gọi sub-agent (vd. CLI chưa hỗ trợ), **Then** run hiện "Không theo dõi được sub-agent
   của CLI này", không báo lỗi.
4. **Given** mô tả sub-agent chứa secret, **Then** cây hiện bản đã che; hub không nhận chuỗi gốc.

---

### User Story 4 - Cây trên app desktop (Priority: P2)

Chủ máy mở app desktop, vào cây giao việc cạnh màn Terminal, thấy cây của các phiên Leader đang chạy và các run trên máy
mình nổi bật hơn run trên máy khác.

**Why this priority**: người dùng làm việc chủ yếu trên app; web đủ cho US1–US3 nên app làm sau.

**Independent Test**: mở app trên máy đang chạy một run của phiên Leader: cây giống trên web, run của máy này có dấu
"máy này", bấm vào mở tab terminal.

**Acceptance Scenarios**:

1. **Given** app đã nối hub, **When** mở màn cây, **Then** thấy danh sách phiên Leader gần đây và cây của phiên chọn.
2. **Given** hub vắng, **Then** màn báo "Hub đang vắng" và không hiện cây cũ như thể là mới (theo spec 027 FR-013).

---

### Edge Cases

- Phiên Leader có hơn 200 nút: cây thu gọn các nhánh đã xong theo mặc định, vẫn tìm được theo tên task.
- Run được giao lại lần hai (attempt mới): một nút run, hiện số lần thử; lần thử cũ xem trong chi tiết.
- Task bị chuyển sang dự án khác hay bị xoá: nút hiện "Task không còn", giữ vị trí trong cây.
- Leader giao run cho task do phiên Leader khác tạo: task hiện ở cả hai cây, mỗi cây đánh dấu phiên đã tạo.
- Run và task cũ trước khi có tính năng này: không có phiên Leader, không hiện trong cây nào; vẫn xem ở danh sách run.
- Sub-agent không có sự kiện kết thúc (CLI chết giữa chừng): nút sub-agent chuyển "không rõ" khi run kết thúc.
- Đồng hồ máy lệch: thứ tự sub-agent theo thứ tự sự kiện của run, không theo giờ máy.

## Requirements *(mandatory)*

### Functional Requirements

**Liên kết với phiên Leader (US1)**

- **FR-001**: Khi Leader tạo task, hệ thống ghi phiên Leader đã tạo task đó.
- **FR-002**: Khi Leader giao run (cho task Leader tạo hay task người dùng tạo), hệ thống ghi phiên Leader đã giao run.
- **FR-003**: Run con (plan, review, sửa sau review) kế thừa phiên Leader của run cha.
- **FR-004**: Quan hệ cha con của run giữ như hiện nay; cây dùng quan hệ đó để đặt run con dưới run cha.

**Cây (US1, US2)**

- **FR-010**: Có màn "Cây giao việc" cho mỗi phiên Leader: gốc là phiên, cấp 2 là task, cấp 3 là run, cấp 4 trở xuống
  là run con và sub-agent.
- **FR-011**: Mỗi nút hiện: loại nút, tên hay mô tả ngắn, trạng thái, máy, CLI, gói (chỉ nhãn gói, không có thông tin
  tài khoản), thời gian chạy, chi phí, token (với sub-agent), lý do lỗi ngắn.
- **FR-012**: Cây cập nhật trong 5 giây khi trạng thái đổi, không cần tải lại.
- **FR-013**: Thu gọn, mở rộng từng nhánh; lọc "chỉ đang chạy hoặc lỗi"; tìm theo tên task.
- **FR-014**: Bấm nút run mở trang run (web) hay tab terminal của run (desktop, khi run chạy trên máy này). Terminal và
  trang run không đổi.
- **FR-015**: Quyền xem cây theo quyền xem task và run hiện có; mục không có quyền bị ẩn và được đếm.
- **FR-016**: Từ chat của Leader có lối mở cây của phiên đó; từ trang task và trang run có lối mở cây chứa chúng.

**Sub-agent (US3)**

- **FR-020**: Worker nhận ra lúc agent trong run gọi sub-agent và lúc sub-agent xong, với Claude Code. Codex và CLI khác
  thêm khi CLI đó cho biết được; CLI chưa hỗ trợ thì cây ghi rõ.
- **FR-021**: Mỗi sub-agent gửi lên hub chỉ siêu dữ liệu: loại sub-agent, mô tả ngắn (tối đa 120 ký tự, đã che secret
  trên máy và trên hub), thời điểm bắt đầu và kết thúc theo thứ tự sự kiện của run, trạng thái, token. Không gửi prompt,
  kết quả hay output của sub-agent (ranh giới dữ liệu spec 027 FR-050, FR-051).
- **FR-022**: Sub-agent lồng nhau giữ đúng cha con.
- **FR-023**: Run kết thúc mà sub-agent chưa có sự kiện kết thúc thì sub-agent chuyển "không rõ".

**Desktop (US4)**

- **FR-030**: App desktop có màn cây cạnh màn Terminal, cùng nội dung với web, đánh dấu run chạy trên máy này.
- **FR-031**: Hub vắng thì màn báo rõ, không hiện dữ liệu cũ như thể là mới.

### Key Entities

- **Phiên Leader**: cuộc trò chuyện với Leader; là gốc của cây.
- **Liên kết giao việc**: task hay run, phiên Leader đã tạo hay giao, thời điểm.
- **Nút cây**: phiên, task, run, sub-agent; quan hệ cha con; trạng thái và số liệu hiển thị.
- **Sub-agent**: thuộc một run (và có thể một sub-agent cha), loại, mô tả ngắn đã che, thứ tự bắt đầu và kết thúc,
  trạng thái, token.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Với phiên Leader có 3 task và 6 run, người dùng chỉ ra việc nào đang kẹt và ở máy nào trong 10 giây khi
  mở cây, không phải mở trang khác.
- **SC-002**: Trạng thái trên cây khớp trạng thái run thật trong 5 giây ở 95% lần đổi.
- **SC-003**: Cây 200 nút mở xong trong 2 giây và thao tác thu gọn, mở rộng không giật.
- **SC-004**: Với run Claude Code gọi sub-agent, 100% sub-agent có trong cây, đúng cha con.
- **SC-005**: Trong 100 run thử có sub-agent nhận prompt chứa secret của dự án, hub nhận 0 giá trị secret và 0 byte
  prompt hay output của sub-agent.
- **SC-006**: Từ nút run tới terminal hay trang run của run đó: một lần bấm.

## Assumptions

- Nơi hiện (web và desktop) và độ sâu (tới sub-agent) theo bản phác thảo chủ dự án duyệt ngày 2026-10-21.
- Run và task tạo trước tính năng này không được gắn ngược với phiên Leader.
- Claude Code cho biết lần gọi sub-agent trong output có cấu trúc của run; Codex làm khi có cách nhận diện tương đương.
- Token của sub-agent lấy từ số CLI báo; không có số thì nút hiện "chưa có số token".
- Cây là màn xem; không thêm thao tác điều khiển mới (giao, huỷ vẫn qua chat Leader và trang run hiện có).
- Phụ thuộc spec 027 về ranh giới dữ liệu và che secret; nếu 027 chưa xong phần che hai lần thì sub-agent chỉ gửi loại,
  thời gian, trạng thái, token, không gửi mô tả.
