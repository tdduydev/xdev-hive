# Feature Specification: Quy trình review code tự động (Code review workflows)

**Feature Branch**: `009-code-review-workflows`

**Created**: 2026-10-13

**Status**: Implemented

**Input**: Yêu cầu của product owner (nguyên văn): "trên web phải có phần auto review code theo workflow nữa nhé".

**Requirements added**: CR-01 … CR-09 trong [docs/srs.md](../../docs/srs.md#318-code-review-workflows-cr).
**Decision record**: [ADR 0018](../../docs/adr/0018-code-review-workflows.md).

## Bối cảnh

Hiện có hai mảnh rời nhau:

- **Quy trình duyệt tài liệu** ([specs/004](../004-review-workflows/spec.md)): giai đoạn → checkpoint `ai`, `human`, `rule`,
  `ext`; quorum, SLA, điều kiện; trả lại cho người viết, agent hoặc checkpoint trước. Chỉ áp cho đề xuất sửa tài liệu
  (`review_instances.proposal_id` bắt buộc).
- **Chính sách kết quả của run code** ([ADR 0009](../../docs/adr/0009-configurable-outcome-policy.md)): run code kết
  thúc ở `verifying`, hub chạy `changes`, `agentReport`, `command`, `review`, `ci` (hai cái `command`, `ci` chưa chạy
  thật), mở PR, có thể tạo **một** run review con (một CLI, `minScore`, `when`), rồi vào hàng merge nếu dự án để chế độ
  `auto`. Không có người duyệt trong Hive, không có nhiều bước, không trả lại cho agent theo góp ý, không có hàng
  "Chờ tôi duyệt" cho PR.

Spec này đưa PR do agent mở vào **cùng mô hình quy trình** với tài liệu: cấu hình ở cùng một trang, chạy qua các
checkpoint, người duyệt thấy trong "Chờ tôi duyệt", đạt thì vào hàng merge.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Quản trị cấu hình quy trình review code trên web (Priority: P1)

Quản trị đội (hoặc tổ chức) mở trang **Quy trình duyệt**, bấm "Tạo quy trình", chọn **Áp cho: Code (PR)**, chọn khung
mẫu (Cơ bản, Chặt, Làn nhanh) hoặc tự tạo, khai phạm vi kích hoạt (dự án, nhánh đích, loại task, đường dẫn đổi), sửa
các checkpoint, chạy thử trên một PR có sẵn rồi lưu.

**Why this priority**: Không có cấu hình thì không có gì chạy. Dùng chung trang với tài liệu để quản trị chỉ học một
chỗ (xem quyết định D1 trong [plan.md](plan.md#quyết-định-thiết-kế)).

**Independent Test**: Tạo quy trình "Cơ bản" cho dự án `payment-api`, nhánh `main`; chạy thử trên PR của một run cũ;
thấy danh sách checkpoint sẽ chạy và lý do bỏ qua; lưu; danh sách quy trình hiện nhãn "Code" và bộ lọc "Code" chỉ còn
quy trình này.

**Acceptance Scenarios**:

1. **Given** quản trị đội ở `/knowledge/workflows`, **When** chọn "Áp cho: Code (PR)" và khung "Cơ bản", **Then** form
   điền sẵn ba giai đoạn: Kiểm tự động (quy tắc), Review AI (một CLI, điểm tối thiểu 7), Người duyệt (1 thành viên
   đội, SLA 24 giờ), và ô phạm vi thay cho ô "Tiền tố tài liệu".
2. **Given** quy trình Code, **When** quản trị thêm checkpoint AI với hai reviewer (Claude và Codex), rubric 4 mục,
   điểm 8, chặn khi có phát hiện mức "nghiêm trọng", **Then** form kiểm hợp lệ và lưu được.
3. **Given** quy trình Code, **When** quản trị chọn quy tắc tài liệu (`sections`, `requirements`), **Then** form báo lỗi
   "Quy tắc này chỉ dùng cho tài liệu." và không lưu.
4. **Given** một quy trình đã lưu, **When** quản trị đổi "Áp cho", **Then** không được: loại áp dụng cố định sau khi
   tạo (nhân bản quy trình nếu muốn đổi).
5. **Given** quản trị chỉ có quyền đọc, **When** mở trang, **Then** thấy quy trình nhưng không có nút sửa, xoá, tạo.
6. **Given** dự án đang bật review chéo, **When** quản trị bấm "Tạo từ cấu hình dự án" và chọn dự án, **Then** form
   điền sẵn checkpoint AI (CLI, điểm, điều kiện `when` lấy từ `outcome.review`), checkpoint CI (nếu `merge.requireCi`)
   và checkpoint người duyệt với số người cần bằng `merge.requiredApprovals`; chưa lưu cho tới khi quản trị bấm Lưu.

---

### User Story 2 - Run code xong thì tự chạy các checkpoint tự động (Priority: P1)

Agent làm xong task, run code qua chính sách kết quả và mở PR. Hub tìm quy trình code khớp, mở **phiên review code**
cho PR đó, rồi chạy lần lượt: quy tắc (lệnh test, số file, đường dẫn cấm, cỡ diff, bí mật, báo cáo agent), review AI
(một hay nhiều CLI/model song song), CI trên commit đầu của PR. Checkpoint tự động đạt thì sang checkpoint kế.

**Why this priority**: Đây là phần "auto review" product owner cần: người chỉ xem PR đã qua máy kiểm.

**Independent Test**: Dự án có quy trình "Cơ bản". Giao task, worker giả nộp commit đổi 3 file và `diffStats`. Kiểm:
phiên review code được tạo với `head_sha` của run; checkpoint quy tắc đạt; hai run review (loại `review`, không có chủ)
được tạo; khi cả hai nộp `review_submit` điểm 8 và 9 thì checkpoint AI đạt; checkpoint CI chờ tới khi nhà cung cấp Git
báo `success`; phiên dừng ở checkpoint người duyệt.

**Acceptance Scenarios**:

1. **Given** run code `succeeded` có PR và một quy trình code khớp, **When** hub kết luận run, **Then** hub mở phiên
   review code, ghi kiểm tra `review` của chính sách là "Quy trình X đảm nhận review" (không tạo run review chéo cũ),
   task chuyển `review`, và PR **không** tự vào hàng merge.
2. **Given** run code `needs_review` (kiểm tra mềm không đạt) có PR, **When** hub kết luận run, **Then** vẫn mở phiên
   review code; lý do `needs_review` hiện ở đầu phiên cho người duyệt.
3. **Given** run code `failed` hoặc `no_changes`, **When** hub kết luận run, **Then** không mở phiên.
4. **Given** checkpoint AI có hai reviewer và cách gộp "mọi reviewer đạt", **When** một reviewer chấm 6 (< 8), **Then**
   checkpoint không đạt và phiên đi theo hướng trả lại của checkpoint.
5. **Given** checkpoint AI đặt "chặn khi có phát hiện từ mức lớn", **When** reviewer chấm 9 nhưng có một phát hiện
   `major`, **Then** checkpoint không đạt, ghi phát hiện đó làm lý do.
6. **Given** checkpoint quy tắc có lệnh `pnpm test` và máy chạy run code là worker cũ không báo kết quả lệnh, **When**
   hub xét checkpoint, **Then** checkpoint ở trạng thái chờ với ghi chú "Máy chưa hỗ trợ chạy lệnh kiểm; cần người xem"
   và quản trị dự án được quyết thay.
7. **Given** checkpoint có điều kiện đường dẫn `src/payments/**`, **When** diff không đụng đường dẫn đó, **Then**
   checkpoint bị bỏ qua với lý do ghi rõ.

---

### User Story 3 - Dev/BA thấy PR chờ mình duyệt ở "Chờ tôi duyệt" (web và app) (Priority: P1)

Người được chỉ định ở checkpoint người duyệt mở **Chờ tôi duyệt** trên web (`/knowledge/reviews`) hoặc trong app
desktop, chọn tab **Code (PR)**, thấy danh sách PR chờ mình kèm dự án, task, checkpoint, SLA, điểm AI. Mở một PR để xem
diff theo file, kết quả review AI (điểm từng reviewer, rubric, phát hiện theo file/dòng), kết quả quy tắc và CI, lịch sử
các vòng, rồi **Duyệt** hoặc **Trả lại**.

**Why this priority**: Người duyệt phải thấy đủ bằng chứng ở một chỗ, không phải mở GitHub để biết máy đã kiểm gì.

**Independent Test**: Tạo phiên đang chờ ở checkpoint người duyệt với `users: [bob]`. Đăng nhập bằng bob: tab Code có 1
mục, badge số trên menu tăng 1; mở mục thấy diff 3 file, thẻ AI có 2 reviewer, thẻ quy tắc có kết quả `pnpm test`.
Đăng nhập bằng carol (không được chỉ định): tab Code trống ở phạm vi "Của tôi", thấy mục ở phạm vi "Tất cả" nhưng
không có nút quyết định.

**Acceptance Scenarios**:

1. **Given** bob được chỉ định, **When** mở "Chờ tôi duyệt", **Then** có hai tab "Tài liệu (n)" và "Code (m)", mỗi tab
   phân trang riêng, lọc theo SLA (quá hạn, sắp hạn, đúng hạn) và theo dự án.
2. **Given** bob mở một PR, **When** khung chi tiết tải, **Then** thấy bước của quy trình (stepper), diff theo file
   (thêm xanh, xoá đỏ; file lớn hơn giới hạn hiện "Mở trên GitHub/GitLab"), phát hiện AI gắn vào file/dòng trong diff,
   kết quả lệnh (mã thoát, 200 dòng cuối đã che bí mật), trạng thái CI và link tới run, task, PR.
3. **Given** bob là người giao task cho agent (chủ run code), **When** mở PR đó, **Then** không có nút quyết định, trừ
   khi checkpoint bật "Cho người giao việc duyệt" (xem câu hỏi Q2).
4. **Given** bob đang mở PR, **When** PR có commit mới (vòng mới), **Then** nút quyết định báo "PR đã có commit mới,
   tải lại để xem" và hub từ chối quyết định gửi kèm `headSha` cũ.
5. **Given** app desktop của bob, **When** mở màn "Chờ tôi duyệt", **Then** có cùng hai tab, cùng dữ liệu, chữ theo
   từ điển vi/en của app.

---

### User Story 4 - Trả lại: agent sửa theo góp ý, về người giao việc, hoặc về checkpoint trước (Priority: P1)

Người duyệt (hoặc checkpoint tự động không đạt) trả lại PR với góp ý và hướng: **Agent sửa rồi quay lại đây**, **Người
giao việc sửa**, hoặc **Về checkpoint trước**.

**Why this priority**: Vòng sửa tự động là phần tiết kiệm công nhất; không có nó người duyệt phải tự viết lại chỉ dẫn
cho agent.

**Independent Test**: Trả lại với hướng "Agent sửa", góp ý "Thiếu test cho hoàn tiền". Kiểm: một run code mới cùng task,
cùng nhánh `ai/<key>`, cùng CLI, có sự kiện `steer` chứa góp ý và các phát hiện AI mức nghiêm trọng/lớn; phiên cũ
`changes_requested`; khi run mới xong và đẩy commit, phiên vòng 2 mở, checkpoint tự động chạy lại, rồi dừng ở đúng
checkpoint đã trả lại.

**Acceptance Scenarios**:

1. **Given** hướng "Agent sửa", **When** người duyệt gửi, **Then** hub tạo run code mới với chỉ dẫn (không qua lập kế
   hoạch dù dự án bật plan mode), chủ run giống run code gốc, và đếm một lượt sửa của agent.
2. **Given** phiên đã dùng hết số lượt agent sửa (mặc định 2), **When** checkpoint trả lại theo hướng agent, **Then**
   hub đổi sang hướng "Người giao việc sửa" và báo người giao việc lý do.
3. **Given** hướng "Người giao việc sửa", **When** gửi, **Then** phiên `changes_requested`, task về `todo` kèm góp ý,
   người giao việc nhận thông báo; khi có commit mới trên nhánh PR (push hoặc run mới) thì vòng mới bắt đầu.
4. **Given** hướng "Về checkpoint trước", **When** gửi, **Then** phiên quay về checkpoint người duyệt gần nhất phía
   trước, phê duyệt cũ của checkpoint đó bị xoá, người ở đó được báo.
5. **Given** task đã hết ngân sách, **When** cần tạo run sửa, **Then** hub không tạo, chuyển hướng "Người giao việc sửa"
   với lý do hết ngân sách.

---

### User Story 5 - Đạt thì vào hàng merge (auto hoặc chờ người) (Priority: P2)

Qua checkpoint cuối, phiên `approved`. Theo cấu hình (của quy trình, mặc định theo chế độ merge của dự án): **tự vào
hàng merge**, hoặc **chờ người** bấm "Đưa vào hàng merge". Hàng merge không merge PR có phiên review code chưa duyệt.

**Why this priority**: Khép vòng từ task tới merge; P2 vì hàng merge đã có và người vẫn đưa tay được.

**Independent Test**: Phiên duyệt xong với `merge: auto` và dự án bật merge queue → có mục hàng merge `queued` cho PR.
Đưa tay một PR có phiên đang `in_review` vào hàng → mục ở `waiting` với ghi chú "Chờ quy trình duyệt code".

**Acceptance Scenarios**:

1. **Given** phiên `approved`, chế độ merge `auto` và dự án bật merge queue, **When** checkpoint cuối đạt, **Then** PR
   vào hàng merge trong cùng transaction, audit `codereview.approve` và `merge.enqueue`.
2. **Given** chế độ merge `auto` mà dự án tắt merge queue, **When** phiên đạt, **Then** phiên `approved`, người giao
   việc nhận thông báo "PR đã duyệt, cần merge tay".
3. **Given** chế độ merge chờ người, **When** phiên đạt, **Then** khung chi tiết có nút "Đưa vào hàng merge" cho thành
   viên đội có `merge.enqueue`.
4. **Given** mục hàng merge của PR có phiên `in_review` hoặc `changes_requested`, **When** hàng merge xét mục, **Then**
   mục ở `waiting` với ghi chú "Chờ quy trình duyệt code"; khi phiên `approved` thì hàng merge tiếp tục.
5. **Given** PR được merge hoặc đóng ngoài Hive, **When** webhook tới, **Then** phiên chuyển `merged` hoặc `cancelled`.

---

### User Story 6 - Dự án cũ không đổi hành vi; chuyển đổi từ review chéo khi muốn (Priority: P2)

Dự án chưa có quy trình code nào khớp chạy y như hôm nay: `outcome.review`, `features.crossReview`, `merge.mode`.
Quản trị chủ động tạo quy trình (hoặc "Tạo từ cấu hình dự án") thì quy trình đảm nhận review cho các run khớp.

**Why this priority**: Không làm hỏng dự án đang chạy; cho đường chuyển dần.

**Independent Test**: Chạy lại toàn bộ `hub:runs.db.test.ts`, `hub:review.db.test.ts`, `hub:merge-queue.db.test.ts`
không sửa test nào: đều xanh. Thêm một quy trình code chỉ khớp nhánh `release/*`: run nhắm `main` vẫn đi review chéo
cũ.

**Acceptance Scenarios**:

1. **Given** không có quy trình code khớp, **When** run code kết thúc, **Then** kết quả, run review chéo, bình luận PR,
   hàng merge giống hệt hành vi trước spec này.
2. **Given** có quy trình khớp và dự án bật review chéo, **When** run kết thúc, **Then** chỉ quy trình chạy; trang cài
   đặt dự án hiện ghi chú "Quy trình X đang thay review chéo cho run khớp phạm vi".
3. **Given** quy trình code bị tắt hoặc xoá, **When** run tiếp theo kết thúc, **Then** dự án quay lại chính sách kết quả;
   phiên đang chạy vẫn đi tiếp theo bản chụp quy trình.

---

### User Story 7 - SLA, nhắc hạn, quyết thay checkpoint tự động (Priority: P3)

Checkpoint người duyệt quá SLA thì người được chỉ định và quản trị đội được nhắc một lần mỗi lượt chờ. Checkpoint tự
động treo (không có máy dùng chung có CLI cần, CI chạy quá lâu, worker cũ) thì quản trị dự án được **quyết thay**
(cho đạt hoặc trả lại) kèm lý do bắt buộc.

**Why this priority**: Tránh phiên treo vô hạn; P3 vì nhắc hạn đã có cho tài liệu, chỉ cần dùng lại.

**Independent Test**: Đặt SLA 1 giờ, lùi `due_at`; chạy job nhắc → mỗi người nhận một thông báo `code_review.overdue`,
chạy lại job không gửi thêm. Checkpoint AI không có máy dùng chung → run review có sự kiện `waiting_machine`; quản trị
đội bấm "Quyết thay: cho đạt" với lý do → checkpoint `passed`, audit `codereview.override`.

**Acceptance Scenarios**:

1. **Given** checkpoint người duyệt quá hạn, **When** job nhắc chạy, **Then** gửi `code_review.overdue` một lần.
2. **Given** checkpoint tự động đang chờ hoặc không đạt, **When** người có `reviews.override` quyết thay mà không ghi lý
   do, **Then** bị từ chối "Ghi lý do khi quyết thay checkpoint tự động.".
3. **Given** quyết thay thành công, **When** xem phiên, **Then** checkpoint có nhãn "Quyết thay bởi …" và lý do.

---

### Edge Cases

- **Nhiều quy trình khớp một PR**: chọn quy trình cụ thể nhất (liệt kê dự án > của đội > của tổ chức); cùng mức thì
  quy trình cập nhật gần nhất. Chạy thử hiển thị quy trình được chọn và các quy trình bị lấn.
- **Commit mới trên nhánh PR ngoài Hive** (người push tay): webhook `push` vào nhánh có phiên đang mở → phiên hiện tại
  `superseded`, vòng mới mở với `head_sha` mới; checkpoint tự động chạy lại; kết quả lệnh của run cũ không dùng được nên
  checkpoint lệnh chờ người xem (không có máy chạy lại lệnh khi không có run).
- **Webhook không tới** (repo không có webhook): lúc quyết định, hub so `headSha` gửi lên với đầu PR thật (gọi `getPR`);
  khác thì từ chối và mở vòng mới.
- **Run sửa của agent không có commit** (`no_changes`): phiên giữ `changes_requested`, chuyển hướng người giao việc.
- **Run sửa `failed`**: như trên, kèm lý do run.
- **Hai người duyệt cùng lúc ở checkpoint quorum 1**: khoá hàng phiên khi ghi; người thứ hai nhận "Checkpoint đã được
  quyết." và dữ liệu mới.
- **Người duyệt là người giao việc**: xem Q2.
- **Không có máy dùng chung có CLI của reviewer AI**: run review chờ (`waiting_machine`, ADR 0017); checkpoint hiện lý
  do; quá SLA của checkpoint thì nhắc quản trị đội; quản trị quyết thay được (US7).
- **Model reviewer bị chính sách agent của tổ chức cấm**: lưu quy trình bị từ chối với lỗi chỉ rõ model; nếu chính sách
  đổi sau khi lưu thì run review dùng model mặc định được phép và ghi chú.
- **Diff quá lớn** (quá 300 file hoặc quá 1 MB patch): web hiện danh sách file và số dòng, patch từng file tải khi mở;
  file vượt giới hạn của nhà cung cấp hiện link ra PR. Run review AI vẫn đọc diff đầy đủ trên máy.
- **Task bị huỷ hoặc PR bị đóng**: phiên `cancelled`, run review đang chạy bị huỷ.
- **Quy trình bị sửa khi có phiên đang chạy**: phiên giữ bản chụp lúc mở; vòng mới của cùng PR cũng dùng bản chụp cũ
  để vòng sửa không đổi luật giữa chừng.
- **Dự án đổi nhóm sở hữu hoặc bị lưu trữ**: phiên mở bị `cancelled` với lý do.
- **Hub khởi động lại giữa chừng**: mọi bước chuyển là job pg-boss có hẹn giờ thử lại như `verify` hiện nay; không có
  trạng thái chỉ nằm trong bộ nhớ.

## Requirements *(mandatory)*

### Functional Requirements

Cấu hình (US1)

- **FR-001 (CR-01)**: Trang Quy trình duyệt MUST cho chọn **Áp cho** = Tài liệu hoặc Code (PR) khi tạo quy trình; giá
  trị cố định sau khi tạo; danh sách có nhãn và bộ lọc theo loại.
- **FR-002 (CR-01)**: Quy trình Code MUST có phạm vi kích hoạt: dự án (danh sách key, rỗng là mọi dự án trong phạm vi
  đội/tổ chức sở hữu), nhánh đích (glob, rỗng là nhánh mặc định của dự án), loại task (rỗng là mọi loại), đường dẫn đổi
  (glob, rỗng là mọi thay đổi).
- **FR-003 (CR-02)**: Checkpoint `ai` của quy trình Code MUST cấu hình được: 1–3 reviewer (CLI `claude`/`codex`/`gemini`,
  model tuỳ chọn), rubric 1–20 mục, điểm tối thiểu 0–10, cách gộp (`all`: mọi reviewer đạt; `avg`: điểm trung bình),
  mức phát hiện chặn (`critical`, `major` hoặc không chặn), nơi chạy (`team` mặc định, hoặc `requester`).
- **FR-004 (CR-02)**: Checkpoint `rule` của quy trình Code MUST hỗ trợ: `command` (lệnh, thời hạn), `max-files`,
  `deny-paths`, `max-diff` (số dòng), `no-secrets`, `agent-report`. Quy tắc tài liệu (`sections`, `requirements`)
  không dùng được cho Code và ngược lại.
- **FR-005 (CR-02)**: Checkpoint `ext` của quy trình Code MUST xét CI trên **commit đầu của PR**, với lựa chọn khi repo
  không có CI (cho đạt hoặc không đạt).
- **FR-006 (CR-02)**: Checkpoint `human` MUST giữ cấu hình hiện có (người, vai trò, đội, quorum, SLA) và thêm cờ
  "Cho người giao việc duyệt" (mặc định tắt).
- **FR-007 (CR-02)**: Mỗi checkpoint của quy trình Code MUST có điều kiện: đường dẫn đổi, loại task, số dòng đổi tối
  thiểu; không thoả thì bỏ qua và ghi lý do.
- **FR-008 (CR-01)**: Hub MUST có khung mẫu Code: `code-basic`, `code-strict`, `code-fast`.
- **FR-009 (CR-01)**: Chạy thử MUST nhận quy trình nháp và một run code (hoặc PR của dự án) và trả: quy trình có khớp
  không, quy trình nào lấn, từng checkpoint chạy hay bỏ qua kèm lý do; không tạo run, không ghi dữ liệu.
- **FR-010 (CR-07)**: Hub MUST tạo bản nháp quy trình Code từ cấu hình dự án (`outcome.review`, `merge.requireCi`,
  `merge.requiredApprovals`) mà không lưu.
- **FR-011 (CR-08)**: Lưu quy trình MUST từ chối model hoặc CLI bị chính sách agent của tổ chức cấm.

Chạy phiên (US2)

- **FR-012 (CR-03)**: Khi run code kết thúc `succeeded` hoặc `needs_review` và có PR, hub MUST tìm quy trình Code khớp
  (FR-002, quy tắc chọn ở Edge Cases) và mở phiên review code với bản chụp quy trình, `head_sha`, số liệu diff.
- **FR-013 (CR-03)**: Khi có phiên, hub MUST bỏ kiểm tra `review` của chính sách kết quả cho run đó (ghi
  `skipped` với lý do) và MUST NOT tự đưa PR vào hàng merge ở bước kết luận run.
- **FR-014 (CR-03)**: Hub MUST chạy checkpoint theo thứ tự; checkpoint tự động chạy ngay khi tới lượt; checkpoint AI
  tạo một run loại `review` cho mỗi reviewer và chạy song song.
- **FR-015 (CR-08)**: Run review của checkpoint AI với nơi chạy `team` MUST là run của đội (`owner_user_id` null) và chỉ
  chạy trên máy dùng chung hoặc runner host; với `requester` thì chủ run là chủ run code gốc (run gốc không có chủ thì
  về `team`).
- **FR-016 (CR-02)**: Agent review MUST nộp kết quả qua `review_submit` (điểm, tóm tắt, phát hiện, và tuỳ chọn kết quả
  từng mục rubric); hub gộp theo FR-003 và đăng một bình luận tổng hợp lên PR.
- **FR-017 (CR-02)**: Quy tắc `command` MUST lấy kết quả do worker chạy trong worktree của run code sau khi agent xong
  (mã thoát, thời gian, đuôi output đã che bí mật). Không có kết quả (worker cũ, vòng do push tay) thì checkpoint chờ
  người xem.

Hàng chờ và quyết định (US3)

- **FR-018 (CR-04)**: "Chờ tôi duyệt" trên web và app MUST có tab Tài liệu và Code (PR), số đếm mỗi tab, lọc SLA và dự
  án, phân trang con trỏ.
- **FR-019 (CR-04)**: Chi tiết phiên MUST hiện: stepper, diff theo file từ nhà cung cấp Git, kết quả từng reviewer AI
  (điểm, tóm tắt, rubric, phát hiện gắn file/dòng), kết quả quy tắc, CI, các vòng trước, link run/task/PR.
- **FR-020 (CR-04)**: Chỉ người đủ điều kiện ở checkpoint `human` đang chờ MUST quyết được (người được chỉ định, thành
  viên đội/vai trò được chỉ định, quản trị tổ chức); người giao việc không quyết được trừ khi bật cờ FR-006.
- **FR-021 (CR-04)**: Quyết định MUST kèm `headSha` người duyệt đã xem; khác đầu PR hiện tại thì hub từ chối.
- **FR-022 (CR-09)**: Người có `reviews.override` MUST quyết thay được checkpoint tự động đang chờ hoặc không đạt, với
  lý do bắt buộc.

Trả lại (US4)

- **FR-023 (CR-05)**: Trả lại MUST có ghi chú và hướng `agent`, `author` (người giao việc), `previous`; checkpoint tự
  động không đạt đi theo hướng mặc định của checkpoint.
- **FR-024 (CR-05)**: Hướng `agent` MUST tạo run code mới cùng task, nhánh, CLI, chủ run như run gốc, không lập kế hoạch,
  với chỉ dẫn gồm ghi chú, phát hiện AI mức chặn và đuôi output của quy tắc không đạt (tối đa 16 000 ký tự).
- **FR-025 (CR-05)**: Số lượt agent sửa của một PR MUST bị giới hạn (mặc định 2, cấu hình 0–5); hết lượt, hết ngân sách,
  hoặc run sửa không có commit thì chuyển hướng `author`.
- **FR-026 (CR-05)**: Commit mới trên nhánh PR (run sửa xong, hoặc push) MUST mở vòng mới: checkpoint tự động chạy lại;
  checkpoint người duyệt đã đạt trước checkpoint trả lại giữ phê duyệt, trừ khi quy trình bật "Bỏ phê duyệt cũ khi có
  commit mới".

Merge (US5)

- **FR-027 (CR-06)**: Phiên đạt MUST đưa PR vào hàng merge khi chế độ merge hiệu lực là `auto` và dự án bật merge queue;
  không thì chờ người. Chế độ merge của quy trình: `project` (mặc định, theo `merge.mode`), `auto`, `manual`.
- **FR-028 (CR-06)**: Hàng merge MUST giữ mục ở `waiting` khi PR có phiên review code chưa `approved`.
- **FR-029 (CR-06)**: Webhook merge/đóng PR MUST kết thúc phiên (`merged`/`cancelled`).

Tương thích (US6)

- **FR-030 (CR-07)**: Không có quy trình Code khớp thì hành vi run, review chéo, hàng merge MUST giữ nguyên.
- **FR-031 (CR-07)**: Phiên MUST chạy theo bản chụp quy trình lúc mở, kể cả các vòng sau.

Thông báo, audit, SLA (US7)

- **FR-032 (CR-09)**: Hub MUST gửi `code_review.awaiting` cho người đủ điều kiện khi phiên tới checkpoint người duyệt,
  `code_review.overdue` một lần mỗi lượt chờ quá SLA, `code_review.returned` cho người giao việc khi phiên về họ, và
  `code_review.approved` khi phiên đạt mà chờ merge tay.
- **FR-033 (CR-09)**: Mọi thao tác ghi MUST ghi audit: lưu/xoá quy trình (kèm `subject`), mở phiên, kết quả checkpoint
  tự động, quyết định, quyết thay, tạo run sửa, huỷ/thay phiên, đưa vào hàng merge.
- **FR-034 (NFR-01)**: Bảng mới MUST bật và ép RLS theo `org_id = hive.ctx_org()`.

### Key Entities

- **Quy trình duyệt** (`review_workflows`, có sẵn): thêm `subject` (`doc`/`code`) và `code` (phạm vi kích hoạt, chế độ
  merge, số lượt agent sửa, bỏ phê duyệt cũ).
- **Phiên review code** (`code_reviews`): một vòng review của một PR ở một `head_sha`; trỏ tới dự án, task, run code tạo
  ra head đó, quy trình (bản chụp), checkpoint hiện tại, trạng thái (`in_review`, `changes_requested`, `approved`,
  `merged`, `cancelled`, `superseded`), vòng, người giao việc, số lượt agent sửa.
- **Lượt checkpoint** (`code_review_gate_runs`): kết quả một checkpoint trong một phiên: trạng thái, điểm, checklist,
  chi tiết (từng reviewer AI, từng lệnh), phê duyệt, ghi chú, người quyết/quyết thay, hạn SLA, các run review.
- **Run review** (`runs`, loại `review` có sẵn): một reviewer AI của checkpoint AI.
- **Run sửa** (`runs`, loại `code` có sẵn): run code mới với chỉ dẫn từ góp ý.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Với dự án không có quy trình Code khớp, 100% test hiện có của run, review chéo và hàng merge chạy xanh
  không sửa.
- **SC-002**: Hub chuyển sang checkpoint kế trong ≤ 30 giây (p95) sau khi checkpoint tự động có kết quả (run review cuối
  xong, CI báo xong, kết quả lệnh có sẵn), đo bằng thời điểm `finished_at` của lượt checkpoint so với `started_at` của
  lượt kế trong test DB.
- **SC-003**: Danh sách "Chờ tôi duyệt" tab Code trả trong ≤ 300 ms (p95) với 1 000 phiên mở trong tổ chức (test DB có
  dữ liệu mẫu).
- **SC-004**: 0 PR được hàng merge của Hive merge khi phiên review code của nó chưa `approved` (test hàng merge).
- **SC-005**: 100% quyết định, quyết thay, kết quả checkpoint tự động và run sửa có dòng audit tương ứng (test DB).
- **SC-006**: Quản trị tạo quy trình Code từ khung mẫu và chạy thử trên một run có sẵn trong ≤ 6 thao tác từ trang Quy
  trình duyệt (Playwright đếm thao tác).
- **SC-007**: Chi tiết PR 100 file / 3 000 dòng đổi hiển thị danh sách file và file đầu tiên trong ≤ 2 giây trên web
  (Playwright, hub giả trả diff).
- **SC-008**: Màn "Chờ tôi duyệt" dùng được ở 360 px không cuộn ngang, sáng và tối (NFR-11).

## Out of Scope

- PR do người mở (không do run của Hive) — chờ Q3.
- Đồng bộ phê duyệt từ GitHub/GitLab vào checkpoint người duyệt, và đăng phê duyệt của Hive thành "Approve" trên nhà
  cung cấp — xem Q1.
- Bình luận theo dòng (inline review comments) lên PR; Hive chỉ đăng một bình luận tổng hợp như review chéo hiện nay.
- Chạy lại lệnh kiểm khi không có run (vòng do push tay); cần một loại run "check" riêng, để sau.
- Agent tự quyết ở checkpoint người duyệt qua MCP.
- Quy trình áp cùng lúc cho tài liệu và code; tài liệu nằm trong PR không đi quy trình tài liệu.
- Tự sửa xung đột merge.
- Nhà cung cấp Git khác GitHub, GitLab.

## Assumptions

- PR do run code mở trên nhánh `ai/<task key>`; hub đã lưu `prUrl` trên run (có sẵn).
- Mỗi task có tối đa một run đang chạy (`runs_task_active`), nên mỗi PR có tối đa một run sửa cùng lúc.
- Tổ chức muốn review AI chạy bằng gói đăng ký trên máy dùng chung của đội (ADR 0017); đội không có máy dùng chung thì
  chọn nơi chạy `requester` cho checkpoint AI.
- Lệnh kiểm do quản trị đội cấu hình, cùng mức tin cậy với lệnh test trong `outcome.command`; chạy trong worktree hoặc
  container sandbox của run.
- Thông báo dùng kênh và hộp thư có sẵn (OPS-01, OPS-02); cột `events` của kênh là `text[]` nên thêm loại sự kiện không
  cần migration.

## Clarifications

Product owner chốt ngày 2026-10-13 (đều theo đề xuất):

- **Q1, phê duyệt và bảo vệ nhánh**: Hive đặt commit status `xdev-hive/review` (pending/success/failure) trên đầu PR;
  khi dự án có quy trình Code, trang cài đặt dự án đề xuất đổi bảo vệ nhánh sang "yêu cầu status `xdev-hive/review`" và
  đặt số người approve về 0. Phê duyệt trên GitHub/GitLab không được tính vào checkpoint.
- **Q2, người giao việc tự duyệt**: không (nguyên tắc bốn mắt như tài liệu), trừ khi checkpoint bật "Cho người giao việc
  duyệt". Quản trị tổ chức luôn quyết được.
- **Q3, PR do người mở**: không trong bản này; chỉ PR do run của Hive mở. Mở rộng sau bằng webhook
  `pull_request.opened` và một loại run "check".
