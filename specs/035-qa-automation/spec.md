# Feature Specification: AI SDLC cho tester (QA Automation)

**Feature Branch**: `ai/SPEC035` (số feature `035-qa-automation`)
**Ngày**: 2026-10-23
**Trạng thái**: Draft (chờ chủ dự án xem các mặc định ở mục Assumptions)
**Input**: Chủ dự án (2026-10-23): đưa luồng AI SDLC tới tester trước, dùng cho test automation. Hub chỉ điều phối và
lưu dữ liệu, tiến độ; worker chạy mọi thứ, kể cả bộ test với môi trường test.

## Vì sao làm

Luồng AI SDLC (spec 011) đã đưa một hạng mục từ ý tưởng tới phát hành qua các pha có cổng duyệt. Luồng đó nhắm tới
người viết code sản phẩm. Tester hiện chưa có chỗ trong luồng: kế hoạch test, test case và script tự động nằm ở bảng
tính hay repo riêng, không nối với yêu cầu; kết quả chạy test chỉ nằm trong log CI; lỗi tìm được phải chép tay sang
tracker.

Chủ dự án muốn tester dùng AI SDLC trước tiên, vì việc test có đầu vào rõ (FR/AC), đầu ra đo được (pass/fail) và ít
rủi ro hơn sửa code sản phẩm. Agent viết test case và script; worker chạy bộ test trên máy có trình duyệt và vào được
môi trường test; hub ghi lại số liệu, nối yêu cầu với test case, kết quả và lỗi.

## Mục tiêu

1. Có chế độ dựng sẵn "QA Automation": từ phạm vi test tới bộ hồi quy chạy theo lịch, mỗi bước quan trọng có tester
   hoặc QA lead duyệt.
2. Test case là bản ghi có cấu trúc, truy được hai chiều: FR/AC → TC → đường dẫn script → kết quả gần nhất.
3. Worker chạy bộ test trên máy chọn theo nhãn (`browser`, `qa-env`) và gửi về hub báo cáo có cấu trúc, chỉ số liệu.
4. Test hỏng thật (không chập chờn) tự mở hoặc cập nhật lỗi, nối với TC và lần chạy. Test chập chờn được nhận ra và
   cách ly.
5. Bộ hồi quy chạy theo lịch: hằng đêm, khi merge vào `main`, trước khi phát hành.
6. Tester có màn xem riêng: lần chạy, xu hướng tỉ lệ pass, danh sách test chập chờn, độ phủ theo yêu cầu.

## Không làm (non-goals)

- Hub KHÔNG chạy agent, KHÔNG chạy test, KHÔNG kết nối vào máy hay môi trường test. Hub chỉ lên lịch, lưu bản ghi và
  số liệu.
- Hub KHÔNG nhận ảnh chụp màn hình, video, trace, log đầy đủ của test. Các thứ đó ở lại máy (spec 027 Q3).
- Không làm công cụ quản lý test thủ công đầy đủ (bước test, dữ liệu test, lần chạy tay từng bước). TC thủ công chỉ là
  bản ghi có cờ `manual` để tính độ phủ.
- Không thay hệ thống CI của khách hàng. Kết quả CI ngoài (delivery, spec 013) không được nhập vào bảng QA trong bản này.
- Không tự sửa code sản phẩm khi test hỏng. Vòng lỗi chỉ tạo hạng mục bugfix; sửa lỗi đi qua luồng bugfix có cổng duyệt.
- Không làm load test, test bảo mật, test hiệu năng.

## Điều làm tính năng thất bại (anti-goals)

- Ảnh, video, trace, log đầy đủ, URL nội bộ, tài khoản test hay bí mật của môi trường test xuất hiện trên hub.
- Một test chập chờn mở lỗi mới mỗi đêm, làm tester bỏ qua mọi lỗi tự tạo.
- Tester duyệt được PR code sản phẩm, hoặc agent của luồng QA sửa code sản phẩm mà không qua cổng.
- Độ phủ báo "đã kiểm" cho yêu cầu chưa có TC tự động nào pass ở lần chạy gần nhất.
- Dữ liệu QA của tổ chức A hiện ra trong tổ chức B, kể cả khi cùng một máy phục vụ cả hai (spec 034).
- Lịch hồi quy âm thầm không chạy (không có máy hợp nhãn) mà không ai biết.

## Hiện trạng: dùng lại, mở rộng, làm mới

| Phần | Hiện có | Việc cần làm |
|---|---|---|
| Chế độ dựng sẵn | `packages/contracts/src/sdlc-presets/*.ts`, 12 preset trong `SDLC_PRESET_IDS`; `presets.test.ts` kiểm biến prompt, mục bắt buộc, cổng | Thêm preset `qa-automation` với 7 pha (FR-001) |
| Pha và bước | `SDLC_PHASE_KINDS` (intake … release); `sdlcStepAction` có `size, draft, analyze, converge, release-notes, retro, archive` | Thêm hành động `test-run`; thêm nhãn máy riêng của bước (`labels`) |
| Run của bước | `startProjectRun` (`apps/hub/src/modules/sdlc/steps.ts`) tạo run `sdlc` với `requiredLabels` lấy từ nhãn của dự án | Gộp nhãn của bước vào `requiredLabels` để chọn máy có `browser`, `qa-env` |
| Báo cáo có cấu trúc | MCP tool `sdlc_report` (`mcp-tools.ts`) với các kind size, findings, analysis, summary, lessons, contracts; lưu vào `sdlc_steps.result` | Thêm kind `test-results` chỉ chứa số liệu; hub nạp vào bảng QA |
| Truy vết, độ phủ (US9) | `trace.ts`: `sdlc_trace_links`, `sdlcCoverage {requirements, planned, done, verified}`, `evidence.tests` từ `agent_report` | Thêm tầng TC: FR/AC → TC → script → kết quả; độ phủ QA (đã có TC, đã tự động, đang pass) |
| Nhãn máy | Bảng máy của `fleet` có `labels`, `labelsOnly`; engine chọn máy theo `requiredLabels` | Dùng lại; nhãn `browser`, `qa-env` do người quản trị máy gắn |
| Chọn máy trong mạng nội bộ | Spec 032 (worker-delivery, chưa có trên nhánh này): chọn máy chạy việc trong mạng nội bộ | Tham chiếu theo tên; khi 032 có, lịch hồi quy dùng cùng cách chọn máy |
| Kênh worker | Spec 027: kênh worker, outbox, `worker-protocol.ts` | Việc chạy bộ test tất định không qua agent (job `qa_suite`) phải đợi 027 |
| Bí mật môi trường test | Spec 031: kho bí mật tại máy, gán theo dự án, che giá trị | URL và tài khoản môi trường test lấy từ kho này; hub chỉ biết tên môi trường |
| Nhiều tổ chức trên một máy | Spec 034 (đang viết song song) | Mọi bản ghi QA có `org_id`, bật và ép RLS |
| Lịch | pg-boss `jobs.schedule(queue, cron)` dùng ở nhiều module (audit, artifacts, codereview) | Bảng lịch QA theo dự án; một job quét mỗi phút đến hạn thì tạo lần chạy |
| Vai trò | `orgRole` owner/admin/member; `teamRole` admin/member/viewer/ba; `reviewerRole` của cổng; hồ sơ desktop lead/writer/dev | Định nghĩa vai trò tester và hồ sơ `tester` (FR-030…FR-035); cài đặt đợi 034 |
| Parser kết quả test | Chưa có | Parser thuần cho JUnit XML và Playwright JSON trên worker (`hive test-summary`) |

## Khái niệm

- **Test case (TC)**: một bản ghi `TC-NNN` của một dự án: tiêu đề, độ ưu tiên (P1–P3), cờ `manual`/`automated`, các
  FR/AC nó kiểm, đường dẫn script, khoá test (id test trong báo cáo của runner), trạng thái.
- **Lần chạy test (test run)**: một lần worker chạy một bộ test trên một máy với một môi trường. Hub giữ số liệu tổng và
  kết quả từng test (id, tên, trạng thái, thời gian, số lần thử lại, thông điệp lỗi ngắn đã che).
- **Chập chờn (flaky)**: test pass sau khi thử lại trong cùng lần chạy, hoặc đổi trạng thái pass/fail nhiều lần trong
  các lần chạy gần đây.
- **Cách ly (quarantine)**: test vẫn chạy và vẫn ghi kết quả nhưng không làm hỏng lần chạy và không mở lỗi.
- **Lỗi (defect)**: bản ghi nối một TC hỏng với lần chạy đầu tiên, lần chạy gần nhất và một hạng mục bugfix.
- **Lịch hồi quy**: quy tắc chạy bộ hồi quy của dự án: theo cron, khi merge vào `main`, hoặc trước khi phát hành.
- **Môi trường test**: tên do tổ chức đặt (ví dụ `staging`). URL và tài khoản của nó chỉ nằm ở kho bí mật của máy.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Chế độ "QA Automation" (Priority: P1)

QA lead tạo hạng mục với chế độ "QA Automation" cho một tính năng mới hoặc một đợt hồi quy. Luồng đi qua bảy pha:
phạm vi test, kế hoạch test, test case, chia việc tự động hoá, viết script, chạy và báo cáo, đưa vào bộ hồi quy.

**Why this priority**: Không có chế độ thì tester không vào được luồng; mọi phần khác dựa trên nó.

**Independent Test**: Bật preset cho một dự án, tạo hạng mục, đi hết bảy pha với agent giả; kiểm cổng của từng pha.

**Acceptance Scenarios**:

1. **Given** dự án đã bật AI SDLC, **When** QA lead chọn chế độ "QA Automation" và nhập phạm vi, **Then** pha intake
   ghi `scope.md` gồm loại (tính năng mới hay hồi quy), yêu cầu nguồn và môi trường test.
2. **Given** pha requirements xong bản nháp `test-plan.md`, **When** QA lead chưa duyệt, **Then** hạng mục không sang
   pha design.
3. **Given** pha design có `test-cases.md` dạng bảng, **When** tester duyệt cổng, **Then** hub tạo hoặc cập nhật các
   bản ghi TC theo bảng (US2).
4. **Given** pha decomposition, **When** agent chia việc, **Then** mỗi nhóm TC tự động là một việc, mỗi việc ghi các
   TC nó phủ.
5. **Given** pha implementation, **When** agent viết script, **Then** agent mở PR vào repo test hoặc thư mục test của
   dự án; PR đó chỉ chạm đường dẫn test (FR-034).
6. **Given** pha verification, **When** bước `test-run` chạy, **Then** máy hợp nhãn chạy bộ test và hub nhận báo cáo
   (US3).
7. **Given** pha release, **When** QA lead duyệt, **Then** các TC tự động đã pass được đánh dấu thuộc bộ hồi quy và
   lịch hồi quy của dự án được đề xuất hoặc cập nhật (US6).

---

### User Story 2 - Test case là bản ghi truy vết được (Priority: P1)

Tester xem một yêu cầu FR-012 và thấy ngay những TC nào kiểm nó, TC nào đã tự động, script ở đâu, lần chạy gần nhất
pass hay fail. Ngược lại, từ một TC hỏng biết nó thuộc yêu cầu nào.

**Why this priority**: Truy vết là giá trị chính tester nhận được so với bảng tính.

**Independent Test**: Nạp một `test-cases.md` mẫu, gửi một báo cáo kết quả; kiểm bảng độ phủ đúng từng ô.

**Acceptance Scenarios**:

1. **Given** `test-cases.md` có dòng `TC-001 | Đăng nhập sai mật khẩu | P1 | automated | FR-003, AC-3.2 | tests/login.spec.ts`,
   **When** cổng design được duyệt, **Then** TC-001 có đủ trường và nối với FR-003, AC-3.2.
2. **Given** TC đã có, **When** bảng sửa tiêu đề hoặc yêu cầu, **Then** bản ghi được cập nhật, mã TC giữ nguyên, lịch sử
   kết quả không mất.
3. **Given** một dòng bị xoá khỏi bảng, **When** duyệt lại, **Then** TC chuyển sang `retired`, không bị xoá.
4. **Given** kết quả gần nhất của TC-001 là fail, **When** tester mở độ phủ, **Then** FR-003 hiện "có TC, đã tự động,
   chưa pass".
5. **Given** hai dự án cùng có `TC-001`, **Then** chúng là hai bản ghi riêng (mã duy nhất theo dự án).

---

### User Story 3 - Worker chạy bộ test và gửi báo cáo có cấu trúc (Priority: P1)

Bước `test-run` chạy trên máy có nhãn `browser` và `qa-env`. Agent chạy bộ test với reporter JSON hoặc JUnit XML, tóm
tắt bằng lệnh `hive test-summary`, rồi gửi bản tóm tắt cho hub. Ảnh, video, trace ở lại máy.

**Why this priority**: Không có số liệu thì không có độ phủ, vòng lỗi hay xu hướng.

**Independent Test**: Chạy `hive test-summary` trên file Playwright JSON và JUnit XML mẫu; gửi kết quả qua
`sdlc_report`; kiểm bảng lần chạy và kết quả.

**Acceptance Scenarios**:

1. **Given** bước có `labels: [browser, qa-env]`, **When** bước chạy, **Then** run chỉ giao cho máy có đủ nhãn của dự án
   và của bước.
2. **Given** báo cáo Playwright JSON có 40 test, 2 fail, 1 pass sau thử lại, **When** `hive test-summary` chạy, **Then**
   bản tóm tắt có tổng 40, fail 2, flaky 1, thời gian từng test.
3. **Given** báo cáo JUnit XML của pytest hoặc Maven Surefire, **Then** cùng lệnh cho cùng dạng tóm tắt.
4. **Given** agent gửi `sdlc_report` kind `test-results`, **Then** hub tạo một lần chạy với máy, môi trường, commit,
   số liệu và kết quả từng test; thông điệp lỗi bị che bí mật và cắt ngắn.
5. **Given** báo cáo có đường dẫn ảnh hay trace, **Then** hub không nhận nội dung, chỉ có thể nhận tên file nếu có.
6. **Given** không có máy nào đủ nhãn, **Then** bước báo "chưa có máy hợp nhãn" như mọi run khác (spec 011 US14).

---

### User Story 4 - Vòng lỗi: test hỏng thật mở lỗi (Priority: P1)

Khi một TC tự động hỏng thật, hub mở lỗi nối với TC và lần chạy, kèm một hạng mục bugfix. Lần sau vẫn hỏng thì cập
nhật lỗi cũ, không mở lỗi mới. Khi test pass lại, lỗi hiện "đã pass từ lần chạy X" để tester đóng.

**Why this priority**: Đây là lý do QA muốn tự động hoá: lỗi tự đến đúng người.

**Independent Test**: Gửi ba báo cáo liên tiếp (fail, fail, pass) cho cùng TC; kiểm một lỗi, `fail_count` 2, trạng
thái "đã pass lại".

**Acceptance Scenarios**:

1. **Given** TC-007 fail, không chập chờn, không bị cách ly, **When** hub nạp kết quả, **Then** có một lỗi mở cho TC-007,
   nối lần chạy và một hạng mục bugfix ở dự án sản phẩm (A3).
2. **Given** lỗi TC-007 đang mở, **When** lần chạy sau vẫn fail, **Then** lỗi cũ tăng số lần fail và đổi lần chạy gần
   nhất; không có lỗi mới.
3. **Given** lỗi đang mở, **When** TC-007 pass, **Then** lỗi chuyển "đã pass lại"; chỉ tester đóng được lỗi.
4. **Given** test fail nhưng pass khi thử lại trong cùng lần chạy, **Then** không mở lỗi; test được tính chập chờn.
5. **Given** tester đóng lỗi rồi TC fail lại, **Then** hub mở lại lỗi đó (không tạo bản ghi thứ hai).

---

### User Story 5 - Phát hiện và cách ly test chập chờn (Priority: P2)

Tester thấy danh sách test chập chờn với tỉ lệ đổi trạng thái. Tester cách ly một test để nó không làm hỏng lần chạy
và không mở lỗi, rồi bỏ cách ly khi đã sửa.

**Why this priority**: Không xử lý chập chờn thì vòng lỗi thành nhiễu (anti-goal).

**Independent Test**: Gửi mười báo cáo đổi trạng thái xen kẽ cho một TC; kiểm nó vào danh sách chập chờn và không mở lỗi.

**Acceptance Scenarios**:

1. **Given** TC đổi pass/fail ít nhất 2 lần trong 10 lần chạy gần nhất, **Then** nó được đánh dấu chập chờn.
2. **Given** TC bị cách ly, **When** nó fail, **Then** lần chạy vẫn tính kết quả nhưng không mở lỗi và không hạ trạng
   thái lần chạy.
3. **Given** tester cách ly hoặc bỏ cách ly, **Then** audit ghi người làm và lý do.

---

### User Story 6 - Lịch hồi quy (Priority: P2)

QA lead đặt bộ hồi quy chạy hằng đêm lúc 2 giờ, khi merge vào `main` và trước khi phát hành. Hub đến giờ thì tạo lần
chạy; worker hợp nhãn chạy.

**Why this priority**: Hồi quy theo lịch là kết quả cuối của luồng QA; cần sau khi có chạy và báo cáo.

**Independent Test**: Tạo lịch cron, tua đồng hồ, kiểm lần chạy được tạo đúng giờ và đúng nhãn.

**Acceptance Scenarios**:

1. **Given** lịch `0 2 * * *` theo múi giờ của tổ chức, **When** tới 2 giờ, **Then** hub tạo đúng một lần chạy hồi quy.
2. **Given** lịch kiểu "khi merge vào main", **When** hub biết có merge vào `main` của dự án, **Then** tạo một lần chạy.
3. **Given** lịch kiểu "trước phát hành", **When** hạng mục sang pha release, **Then** tạo một lần chạy và kết quả hiện ở
   cổng release.
4. **Given** không có máy hợp nhãn trong 30 phút, **Then** lần chạy chuyển "không có máy" và hiện ở màn tester.
5. **Given** lịch bị tắt, **Then** không tạo lần chạy.

---

### User Story 7 - Vai trò tester và hồ sơ desktop `tester` (Priority: P2)

Tổ chức gán vai trò tester cho người làm QA. Tester duyệt kế hoạch và test case, tạo và đóng lỗi, sửa code test,
nhưng không duyệt được PR code sản phẩm. App desktop có hồ sơ `tester` hiện các màn QA trước.

**Why this priority**: Cần để giao việc đúng người; cài đặt đợi spec 034 nên để P2.

**Independent Test**: Người có vai trò tester thử từng quyền trong bảng FR-031; kiểm được/bị chặn đúng.

**Acceptance Scenarios**:

1. **Given** người dùng là tester của đội, **When** cổng design cần tester, **Then** họ duyệt được.
2. **Given** PR code sản phẩm cần duyệt, **When** tester bấm duyệt, **Then** bị chặn với thông báo tiếng Việt.
3. **Given** PR chỉ chạm đường dẫn test của dự án, **Then** tester duyệt được.
4. **Given** hồ sơ desktop `tester`, **Then** màn đầu là "Kiểm thử" (lần chạy, chập chờn, độ phủ).

---

### User Story 8 - Màn tester trên web và desktop (Priority: P2)

Tester mở màn "Kiểm thử" của dự án: lần chạy gần đây, xu hướng tỉ lệ pass 30 ngày, test chập chờn, lỗi đang mở, độ
phủ theo yêu cầu.

**Why this priority**: Là nơi tester làm việc hằng ngày; dữ liệu phải có trước.

**Independent Test**: Seed dữ liệu QA, mở màn, kiểm số và liên kết.

**Acceptance Scenarios**:

1. **Given** có 20 lần chạy, **Then** màn hiện danh sách lần chạy (thời điểm, máy, môi trường, pass/fail/flaky, thời gian).
2. **Given** dữ liệu 30 ngày, **Then** biểu đồ tỉ lệ pass theo ngày.
3. **Given** một lần chạy, **When** tester mở, **Then** thấy test hỏng với TC, thông điệp ngắn và tên máy để xem file
   tại máy.
4. **Given** độ phủ, **Then** mỗi yêu cầu có số TC, số tự động, số đang pass.

---

### Edge Cases

- Báo cáo lớn (10.000 test): hub giữ số tổng đủ, nhưng chỉ lưu kết quả từng test tới giới hạn (A6), ưu tiên test hỏng
  và chập chờn.
- Khoá test trong báo cáo không khớp TC nào: kết quả vẫn lưu với `case_id` rỗng và hiện ở mục "test chưa gắn TC".
- Hai TC cùng một khoá test: lúc nạp `test-cases.md` báo lỗi ở cổng design, không ghi.
- Agent gửi `test-results` hai lần trong một bước: lần sau thay lần trước của cùng run, không nhân đôi.
- Thông điệp lỗi chứa URL nội bộ, token hay mật khẩu: worker che trước khi gửi, hub che lần nữa (A1).
- Máy phục vụ nhiều tổ chức (034): lần chạy ghi đúng tổ chức của run; không có truy vấn QA xuyên tổ chức.
- Môi trường test chưa gán bí mật trên máy (031): agent báo câu hỏi mở thay vì đoán URL; bước không pass.
- Dự án chưa có repo test riêng: script nằm trong thư mục test của repo sản phẩm (A4); PR vẫn chỉ chạm thư mục đó.
- Lịch trùng nhau (đêm và merge cùng lúc): mỗi lịch tạo lần chạy riêng; không gộp.
- Hạng mục bugfix đã đóng nhưng TC còn fail: mở lại lỗi, tạo hạng mục bugfix mới.

## Requirements *(mandatory)*

### Functional Requirements

**Chế độ và pha**

- **FR-001**: Hệ thống MUST có preset `qa-automation` với bảy pha intake, requirements, design, decomposition,
  implementation, verification, release, mỗi pha có artifact và mục bắt buộc như US1.
- **FR-002**: Cổng requirements MUST cần QA lead duyệt; cổng design MUST cần tester duyệt. Tới khi có vai trò tester
  (034), QA lead dùng vai trò quản trị đội và tester dùng vai trò thành viên đội.
- **FR-003**: Pha decomposition MUST tạo một việc cho mỗi nhóm TC tự động và ghi mã TC trong việc.
- **FR-004**: Pha implementation MUST hướng agent mở PR vào repo test hoặc thư mục test đã khai cho dự án.

**Test case**

- **FR-010**: Hệ thống MUST lưu TC với: dự án, hạng mục gốc, mã `TC-NNN` duy nhất theo dự án, tiêu đề, ưu tiên,
  `manual`/`automated`, danh sách FR/AC, đường dẫn script, khoá test, trạng thái (`active`, `retired`), thuộc hồi quy,
  cách ly, kết quả và lần chạy gần nhất.
- **FR-011**: Khi cổng design được duyệt, hệ thống MUST đọc bảng trong `test-cases.md` và tạo/cập nhật TC; dòng bị bỏ
  MUST chuyển `retired`.
- **FR-012**: Bảng sai dạng (thiếu cột, mã trùng, khoá trùng) MUST làm cổng báo lỗi rõ dòng, không ghi phần nào.
- **FR-013**: Hệ thống MUST trả độ phủ QA theo yêu cầu: số TC, số tự động, số đang pass, và phần trăm yêu cầu có TC,
  có TC tự động, có TC tự động đang pass.
- **FR-014**: Truy vết hai chiều MUST có: từ yêu cầu tới TC tới script tới kết quả, và từ TC ngược về yêu cầu.

**Chạy và báo cáo**

- **FR-020**: Bước của chế độ MUST cho khai nhãn máy riêng; run của bước MUST cần cả nhãn của dự án và của bước.
- **FR-021**: Hệ thống MUST có hành động bước `test-run`: agent chạy bộ test trên máy, tóm tắt và gửi báo cáo; bước chỉ
  pass khi hub đã nhận báo cáo hợp lệ.
- **FR-022**: Worker MUST có lệnh tóm tắt báo cáo test (Playwright JSON trước, JUnit XML cho pytest, JUnit, các runner
  khác) ra dạng chung: tổng, pass, fail, bỏ qua, chập chờn, thời gian, và từng test (khoá, tên, file, trạng thái, số lần
  thử lại, thời gian, thông điệp ngắn).
- **FR-023**: Báo cáo gửi hub MUST chỉ có số liệu và văn bản ngắn; MUST NOT có ảnh, video, trace, log đầy đủ hay nội
  dung file đính kèm.
- **FR-024**: Hệ thống MUST lưu mỗi lần chạy: dự án, hạng mục, bước, run, lịch (nếu có), nguồn kích hoạt, runner, bộ,
  tên môi trường, máy, trạng thái, số liệu, thời gian, commit.
- **FR-025**: Thông điệp lỗi MUST được che bí mật và cắt tối đa 500 ký tự trước khi lưu.
- **FR-026**: Việc chạy bộ test tất định (không qua agent) theo lịch MUST dùng kênh worker của spec 027 khi có; tới lúc
  đó lịch tạo run agent với bước `test-run`.
- **FR-027**: URL và tài khoản môi trường test MUST lấy từ kho bí mật tại máy (spec 031) theo dự án; hub chỉ giữ tên
  môi trường.

**Vòng lỗi và chập chờn**

- **FR-040**: Kết quả fail của TC không chập chờn trong lần chạy, không bị cách ly, không chập chờn theo lịch sử MUST mở
  hoặc cập nhật một lỗi duy nhất cho TC đó.
- **FR-041**: Lỗi mới MUST nối với một hạng mục bugfix (theo A3) và với lần chạy đầu, lần chạy gần nhất.
- **FR-042**: TC pass lại MUST đánh dấu lỗi "đã pass lại"; chỉ tester (hoặc quản trị đội) đóng lỗi.
- **FR-043**: Test pass sau thử lại trong một lần chạy MUST tính chập chờn và không mở lỗi.
- **FR-044**: TC đổi trạng thái ít nhất 2 lần trong 10 lần chạy gần nhất MUST hiện là chập chờn.
- **FR-045**: Tester MUST cách ly và bỏ cách ly được TC, có lý do; audit ghi lại.

**Lịch hồi quy**

- **FR-050**: Hệ thống MUST lưu lịch hồi quy theo dự án: kiểu (`cron`, `merge`, `release`), biểu thức cron, múi giờ,
  nhãn máy, tên môi trường, bộ test, bật/tắt, lần chạy kế.
- **FR-051**: Hub MUST tính lần chạy kế và tạo đúng một lần chạy cho mỗi lần đến hạn, kể cả khi hub có nhiều bản.
- **FR-052**: Lần chạy không có máy hợp nhãn trong 30 phút MUST chuyển "không có máy" và hiện cho tester.

**Vai trò và quyền** (định nghĩa ở đây; cài đặt đợi spec 034)

- **FR-030**: Hệ thống MUST có vai trò đội `tester`.
- **FR-031**: Bảng quyền:

  | Việc | Tester | Thành viên | Quản trị đội |
  |---|---|---|---|
  | Duyệt kế hoạch test, test case | Có | Không (sau khi có tester) | Có |
  | Tạo, đóng, mở lại lỗi | Có | Tạo được, không đóng | Có |
  | Cách ly test | Có | Không | Có |
  | Sửa và duyệt PR chỉ chạm đường dẫn test | Có | Có | Có |
  | Duyệt PR code sản phẩm | Không | Theo quy tắc hiện có | Theo quy tắc hiện có |
  | Sửa lịch hồi quy | Có | Không | Có |

- **FR-032**: Cổng có `reviewers.roles` MUST nhận vai trò `team-tester` khi vai trò có.
- **FR-033**: App desktop MUST có hồ sơ `tester` mở màn "Kiểm thử" trước.
- **FR-034**: PR do luồng QA mở MUST chỉ chạm đường dẫn test đã khai; chạm ngoài thì cổng báo lỗi.
- **FR-035**: Mọi bản ghi QA MUST thuộc một tổ chức và chịu RLS ép buộc.

**Màn tester**

- **FR-060**: Web và desktop MUST có màn "Kiểm thử" theo dự án: lần chạy, xu hướng tỉ lệ pass, chập chờn, lỗi, độ phủ.
- **FR-061**: Chi tiết lần chạy MUST hiện tên máy để tester mở file ảnh, trace tại máy đó.

### Key Entities

- **QA test case**: TC của dự án, nối yêu cầu, script, kết quả gần nhất.
- **QA test run**: một lần chạy bộ test; số liệu và nơi chạy.
- **QA test result**: kết quả một test trong một lần chạy.
- **QA defect**: lỗi của một TC, nối lần chạy và hạng mục bugfix.
- **QA schedule**: lịch hồi quy của dự án.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Một QA lead đi từ phạm vi tới bộ hồi quy theo lịch cho một tính năng trong một ngày làm việc, không chép
  tay giữa công cụ.
- **SC-002**: 100% TC tự động trong bộ hồi quy có kết quả gần nhất không cũ hơn 24 giờ khi lịch hằng đêm bật.
- **SC-003**: Không có byte ảnh, video, trace hay log đầy đủ nào trên hub (kiểm bằng kích thước bản ghi và test).
- **SC-004**: Dưới 5% lỗi tự mở bị tester đóng là "không phải lỗi" sau 4 tuần.
- **SC-005**: Một TC hỏng lặp lại 10 đêm chỉ có đúng một lỗi.
- **SC-006**: Tester trả lời "FR này đã được kiểm tự động và đang pass chưa" trong dưới 10 giây từ màn độ phủ.

## Assumptions

- **A1**: Hub nhận thông điệp lỗi ngắn (tối đa 500 ký tự) đã che bí mật. Lý do: không có nó tester phải ra máy cho mọi
  lỗi. Chủ dự án có thể chọn "không gửi thông điệp".
- **A2**: Cách ly là thủ công. Hệ thống chỉ gợi ý cách ly khi chập chờn theo lịch sử; không tự cách ly.
- **A3**: Hạng mục bugfix được tạo tự động ở dự án sản phẩm (dự án của hạng mục gốc của TC), chế độ `bugfix`, chủ là
  người tạo lịch hoặc QA lead; nếu dự án không cho chế độ `bugfix` thì chỉ mở lỗi.
- **A4**: Script test nằm trong thư mục test của repo sản phẩm (mặc định `tests/e2e`) hoặc một repo test riêng khai như
  một dự án tham gia của hạng mục.
- **A5**: Một lần chạy do một agent thực hiện trên một máy; chưa chia bộ test ra nhiều máy.
- **A6**: Lưu tối đa 2.000 kết quả từng test mỗi lần chạy; số tổng luôn đủ.
- **A7**: Giữ kết quả từng test 90 ngày, số tổng lần chạy 1 năm.
- **A8**: Lịch "khi merge vào main" dùng sự kiện merge hub đã biết (codereview/delivery); chưa có nguồn thì lịch này chờ.
- **A9**: Múi giờ lịch mặc định là của tổ chức.

## Out of Scope (có thể làm sau)

- Chia bộ test chạy song song trên nhiều máy.
- Nhập kết quả test từ CI ngoài (Jenkins, GitLab) vào bảng QA.
- Quản lý test thủ công từng bước và lần chạy tay.
- Tự sửa test hỏng bằng agent.
- Đẩy ảnh/trace lên kho riêng của khách hàng (không phải hub).
