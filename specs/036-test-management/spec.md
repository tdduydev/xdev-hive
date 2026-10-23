# Feature Specification: Quản lý kiểm thử cấp dự án: vai trò Tester, thư viện test case, kết quả CI và dashboard

**Feature Branch**: `ai/SPEC036` (số feature `036-test-management`)

**Created**: 2026-10-23

**Status**: Draft. Chủ dự án giữ mặc định A cho Q1–Q3 ngày 2026-10-23 (mục "Câu hỏi mở (đã chốt)"). Đã có plan.

**Input**: "Viết spec cho hive: vai trò Tester, module test case, nhận JUnit và dashboard kết quả."

## Vì sao làm

Spec 035 đã làm test case theo **hạng mục** AI SDLC. Tài liệu `test-cases` của một hạng mục sinh TC dạng `TC-001`.
`hive test-summary` đọc Playwright JSON hoặc JUnit XML tại máy và chỉ gửi metadata. Cổng QA chặn verification khi TC bắt
buộc chưa pass. Spec 035 để ngoài phạm vi ba việc: vai trò Tester riêng, nhập kết quả CI ngoài, dashboard xu hướng.

Đội kiểm thử của một dự án HIS đang dùng hive làm việc theo cách khác phạm vi 035:

- Test case viết theo **màn hình**, không theo hạng mục. Mỗi màn một file Excel, ví dụ `<DỰ_ÁN>_TC_<MÀN>_v1.0.xlsx`.
  Một màn có khoảng 7 TC và 135 bước.
- Mỗi màn có bảng truy vết yêu cầu ↔ TC.
- Kết quả ghi tay theo đợt (lần 1, lần 2) với trạng thái: Đạt, Không Đạt, Chưa Test, Không Test, Chuyển Next, Khác.
- Bộ Playwright chạy trên GitLab CI và xuất JUnit XML khi có biến `CI`.

Hôm nay hive không có chỗ cho các việc trên. Tester giữ Excel riêng. Kết quả CI nằm ở GitLab. Quản lý dự án tự gộp số
liệu bằng tay.

Spec này thêm năm phần:

1. Thư viện test case cấp dự án, viết bằng Markdown trong docs home, mã TC nối được với tên test Playwright.
2. Vai trò hệ thống "Tester" của đội.
3. Nhận kết quả test của pipeline GitLab dưới dạng metadata.
4. Đợt test chạy tay, nhiều tester ghi kết quả song song.
5. Dashboard theo khu chức năng, theo yêu cầu, theo đợt và theo thời gian.

Nguyên tắc giữ nguyên từ spec 027, 032 và 035:

- Hub chỉ lưu metadata, cấu hình, quyền và lịch sử. Hub không chạy test và không gọi GitLab trong mạng nội bộ.
- Worker đọc báo cáo test tại máy và chỉ gửi metadata. Tên test, thông báo lỗi, log, ảnh và trace ở lại GitLab hoặc máy.
- Web không có nút chạy bộ test.

## Câu hỏi mở (đã chốt)

Chủ dự án giữ khuyến nghị A cho cả ba câu ngày 2026-10-23.

| # | Câu hỏi | Khuyến nghị | Ghi ở |
|---|---|---|---|
| Q1 | Kết quả test của pipeline GitLab đến hub bằng đường nào? (A) worker đọc báo cáo test của pipeline rồi gửi metadata; (B) job CI tự chạy `hive test-summary` và gửi lên hub bằng token dự án; (C) cả hai | **A.** Đúng mô hình spec 032: GitLab ở mạng nội bộ, worker tới được, hub thì không (032 A5). Webhook GitLab vào hub vẫn dùng để biết pipeline đã xong (032 A6). B cần runner CI gọi được hub và một loại token mới, để làm sau nếu cần | FR-020…FR-029 |
| Q2 | Thư viện test case cấp dự án có thay TC theo hạng mục của spec 035 không? (A) tách riêng trong bản này; (B) TC của hạng mục tham chiếu mã TC thư viện và dùng kết quả thư viện làm bằng chứng cổng QA | **A.** Cổng QA của 035 đã chạy và có test. Gộp hai nguồn bằng chứng đổi luật cổng QA, nên để spec sau. Hai loại mã khác dạng để parser không nhầm (FR-003) | FR-003, Out of Scope |
| Q3 | Hub có lưu dòng lỗi đầu tiên của test fail để xem trên dashboard không? (A) không, dashboard mở job CI ở GitLab; (B) lưu tối đa 200 ký tự sau khi che bí mật | **A.** Giữ luật không nhận chữ tự do của reporter (035 FR-008, 032 Q1). Báo lỗi có thể chứa dữ liệu test, URL nội bộ hoặc bí mật | FR-025, FR-026 |

## Hiện trạng: dùng lại, mở rộng, làm mới

Đã kiểm trong code ngày 2026-10-23 (nhánh `ai/SPEC036`, dựa trên `main`):

| Phần | Có gì | Spec này |
|---|---|---|
| Vai trò | `packages/contracts/src/roles.ts`: vai trò hệ thống `owner`, `admin`, `member`, `team-admin`, `team-member`, `team-viewer`, `team-ba`. `team-ba` liệt kê đủ quyền (specs/011 FR-061). Mọi quyền `.read` không thuộc quản trị tự vào `team-viewer` | Thêm vai trò `team-tester` liệt kê đủ quyền như `team-ba`. Thêm nhóm quyền kiểm thử (FR-010…FR-016) |
| TC theo hạng mục | Spec 035: bảng `sdlc_qa_cases`, parser bảng `test-cases` trong `packages/contracts/src/qa.ts`, mã `^TC-\d{3,5}$` duy nhất trong hạng mục, cổng QA và miễn TC | Giữ nguyên. Thư viện là phần riêng (Q2) |
| Đọc báo cáo test | `worker/internal/testreport/summary.go` (`hive test-summary`): Playwright JSON, JUnit XML, file vượt 32 MiB bị từ chối, quá 5.000 TC thì cắt và bật cờ, gộp failed > flaky > skipped > passed, regex mã `\bTC-[0-9]{3,5}\b`, test chứa nhiều mã làm hỏng cả báo cáo, metadata strict | Mở rộng nhận mã thư viện `TC-<KHU>-<SỐ>` (FR-003). Dùng lại luật gộp, giới hạn và schema strict. Với nguồn CI, test nhiều mã chỉ bị đếm riêng (FR-023) |
| Docs home | `docsync`: nhà tài liệu là repo + nhánh + thư mục, đồng bộ hai chiều, hợp ba bản, chế độ `pr` hoặc `direct` (ADR 0028). `knowledge` giữ nội dung và phiên bản | TC nằm trong thư mục test case của docs home dự án. Mỗi phiên bản mới, từ web hay từ repo, đều được đọc lại thành TC (FR-001, FR-005) |
| GitLab CI | Webhook Pipeline và Job vào hub (`delivery/ci/gitlab-events.ts`), bảng `ci_runs_seen` chỉ giữ trạng thái đỏ/xanh. Spec 032 chuyển việc đọc pipeline và job sang worker (032 FR-034). Ngày 2026-10-23, `specs/032-worker-delivery/tasks.md` có 9 task xong, 11 task chưa xong | Thêm loại việc "đọc kết quả test của pipeline" trên đường worker của 032 (FR-021) |
| Truy vết | `sdlc_trace_links` nối requirement với task, run, PR, commit, test, CI | Không dùng trong bản này. Thư viện tự giữ liên kết TC ↔ yêu cầu (FR-002) |
| Dashboard | Web có trang `sdlc/`, `deploys/`. Chưa có trang kết quả kiểm thử | Làm mới trang "Kiểm thử" của dự án (FR-050…FR-058) |
| Audit | Module `audit` | Dùng lại cho đợt test, cấu hình nguồn CI, sửa kết quả (FR-070) |

## Khái niệm

| Khái niệm | Nghĩa |
|---|---|
| Thư viện test case | Tập TC của một dự án, đọc từ các file Markdown trong thư mục test case của docs home dự án |
| Khu chức năng | Một màn hình hoặc một nhóm chức năng. Mỗi khu một file. Mã khu là phần giữa của mã TC, ví dụ `MPI01` |
| Mã TC thư viện | `TC-<KHU>-<SỐ>`, ví dụ `TC-MPI01-001`. Khác dạng mã TC hạng mục `TC-001` của spec 035 |
| Nguồn kết quả CI | Cấu hình của dự án: repo GitLab, bộ lọc nhánh, bộ lọc tên job, cách đọc báo cáo, nhãn hiển thị (ví dụ "e2e nightly") |
| Lần chạy CI | Một pipeline đã xong của một nguồn. Hub lưu tổng số, trạng thái từng TC và liên kết tới pipeline, job |
| Đợt test tay | Một lượt kiểm thử do người làm, ví dụ "Milestone 3 lần 1". Có danh sách TC, người được giao và kết quả từng TC |
| Nhánh tham chiếu | Nhánh mà dashboard dùng để tính trạng thái tự động của TC. Mặc định là nhánh mặc định của repo nguồn |
| Trạng thái hiện tại | Trạng thái gộp của một TC từ kết quả CI mới nhất trên nhánh tham chiếu và kết quả tay mới nhất (FR-052) |

Bảng trạng thái:

| Nguồn | Trạng thái (chữ trên giao diện) | Nghĩa |
|---|---|---|
| CI | Đạt | Mọi test của TC pass, không retry |
| CI | Chập chờn | Pass sau khi retry |
| CI | Không đạt | Ít nhất một test của TC fail |
| CI | Bỏ qua | Test của TC bị skip |
| Tay | Đạt, Không đạt | Tester kết luận |
| Tay | Chưa test | Chưa có kết quả (mặc định khi tạo đợt) |
| Tay | Không test | Không áp dụng trong đợt này |
| Tay | Chuyển đợt sau | Dời sang đợt tiếp theo |
| Tay | Khác | Trạng thái khác, bắt buộc có ghi chú |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Thư viện test case bằng Markdown trong docs home (Priority: P1)

Tester mở dự án HIS, vào trang "Kiểm thử", chọn "Thêm khu chức năng" và nhập mã khu `MPI01`, tên "Tìm kiếm bệnh nhân".
Hive tạo file `test-cases/MPI01.md` trong docs home theo mẫu. Tester viết 7 TC, mỗi TC có các bước, kết quả mong đợi và
mã yêu cầu. Khi lưu, hive đọc file thành 7 TC và hiện chúng ở thư viện. Một dev sửa file này trong repo docs. Sau lần
đồng bộ kế tiếp, thư viện có nội dung mới.

Ví dụ một TC trong file (định dạng chốt ở plan):

```markdown
### TC-MPI01-001 Tìm bệnh nhân theo mã

- Ưu tiên: P1
- Loại: tự động
- Yêu cầu: FR-001, FR-004, MPI01
- Nhãn: smoke, regression
- Script: tests/mpi/search.spec.ts
- Dữ liệu test: TD-MPI01-01

| # | Thao tác | Kết quả mong đợi |
|---|---|---|
| 1 | Nhập mã bệnh nhân hợp lệ vào ô tìm kiếm | Danh sách hiện đúng 1 bệnh nhân |
| 2 | Bấm vào dòng kết quả | Mở hồ sơ bệnh nhân đúng mã |
```

**Why this priority**: không có TC thì không có gì để chạy, ghi kết quả hay thống kê. Mọi story sau cần nó.

**Independent Test**: tạo một khu có 3 TC hợp lệ. Thư viện hiện 3 TC đủ trường. Sửa một TC trong repo docs, đợi đồng bộ.
Thư viện có nội dung mới và lịch sử phiên bản của TC.

**Acceptance Scenarios**:

1. **Given** file khu hợp lệ, **When** tester lưu, **Then** thư viện có đúng các TC trong file với mã, tên, ưu tiên,
   loại, yêu cầu, nhãn, các bước và script (FR-001, FR-002).
2. **Given** file có mã trùng trong dự án, TC thiếu yêu cầu, hoặc TC tự động thiếu script, **When** lưu, **Then** hive
   báo lỗi tiếng Việt kèm số dòng. Thư viện giữ bộ TC hợp lệ trước đó của file này, không cập nhật một phần (FR-004).
3. **Given** TC `TC-MPI01-003` đã có kết quả, **When** tester xoá TC khỏi file, **Then** TC chuyển "Ngừng dùng", lịch sử
   kết quả còn nguyên, và mã này không được dùng lại (FR-006).
4. **Given** mã có dạng `TC-001`, **When** lưu, **Then** hive từ chối và gợi ý dạng `TC-<KHU>-<SỐ>` (FR-003).

---

### User Story 2 - Vai trò Tester (Priority: P1)

Admin đội gán vai trò "Tester" cho ba người. Ba người này viết TC, tạo đợt test, ghi kết quả và xem dashboard. Họ đọc được
tài liệu dự án và mở được trang CI. Họ không tạo task, không chạy run, không merge, không deploy, không quản trị máy,
không sửa tài liệu ngoài thư mục test case.

**Why this priority**: đội kiểm thử cần vào hive mà không nhận quyền của dev. Thiếu vai trò này, admin phải tự tạo vai
trò riêng cho từng đội.

**Independent Test**: gán `team-tester` cho một người. Kiểm từng quyền ở FR-012 và FR-013: quyền được cho chạy được,
quyền bị cấm trả lỗi 403 kèm thông báo tiếng Việt.

**Acceptance Scenarios**:

1. **Given** người có vai trò Tester của đội, **When** sửa file trong thư mục test case của dự án đội đó, **Then** lưu
   được (FR-011).
2. **Given** người có vai trò Tester, **When** sửa tài liệu spec hoặc tài liệu ngoài thư mục test case, **Then** bị từ
   chối nếu người đó không có thêm `docs.write` (FR-011).
3. **Given** người có vai trò Tester, **When** tạo task, chạy run, xếp merge hoặc bấm triển khai, **Then** bị từ chối
   (FR-013).
4. **Given** người có vai trò Tester của đội A, **When** mở thư viện của dự án đội B, **Then** không thấy dữ liệu (FR-015).

---

### User Story 3 - Nhận kết quả test của pipeline GitLab (Priority: P1)

Admin dự án khai nguồn kết quả CI: repo `<nhóm>/e2e-tests`, job có tên bắt đầu bằng `e2e`, nhánh `main` và nhánh MR, đọc
báo cáo JUnit của pipeline. Pipeline đêm chạy xong lúc 02:10. GitLab gửi webhook về hub. Hub giao việc đọc báo cáo cho
một worker tới được GitLab. Worker đọc báo cáo, tách mã TC từ tên test, gửi metadata. Lúc 02:15 dashboard có lần chạy
mới, 412 test, 9 TC không đạt, mỗi TC có liên kết mở job ở GitLab.

**Why this priority**: kết quả tự động là nguồn số liệu lớn nhất và tốn ít công nhất. Đây là việc người dùng yêu cầu
trực tiếp ("nhận JUnit").

**Independent Test**: khai một nguồn, cho pipeline thử xuất JUnit với 5 test chứa 4 mã TC. Hub có một lần chạy với tổng
số đúng và 4 dòng TC. Database và request vào hub không chứa tên test hay thông báo lỗi.

**Acceptance Scenarios**:

1. **Given** nguồn đã khai và có worker đủ điều kiện, **When** pipeline khớp bộ lọc xong, **Then** hub có một lần chạy
   với tổng theo trạng thái, trạng thái từng TC và liên kết pipeline, job (FR-020…FR-024).
2. **Given** hub nhận webhook hai lần cho cùng pipeline, **When** worker gửi lại metadata, **Then** hub giữ một lần chạy
   duy nhất (FR-027).
3. **Given** báo cáo có test không chứa mã TC, **When** nhận, **Then** test đó vào tổng số và vào số "test chưa gắn mã",
   không gắn vào TC nào (FR-024).
4. **Given** báo cáo có mã TC không có trong thư viện, **When** nhận, **Then** hub giữ lần chạy và liệt kê mã lạ trên
   dashboard, không tạo TC mới (FR-024).
5. **Given** không worker nào đủ điều kiện, **When** pipeline xong, **Then** việc đọc ở trạng thái chờ kèm lý do. Hub
   không tự gọi GitLab (FR-022).
6. **Given** pipeline xong khi hub vắng và webhook bị lỡ, **When** admin bấm "Lấy lại kết quả", **Then** hub đọc lại các
   pipeline đã xong trong 7 ngày gần nhất của nguồn (FR-028).

---

### User Story 4 - Đợt test chạy tay (Priority: P1)

Trưởng nhóm test tạo đợt "Milestone 3 lần 1" cho môi trường "UAT", bản "3.8.0". Người này chọn TC theo khu `MPI01`,
`MPI02` và nhãn `regression`, rồi chia TC cho 4 tester. Mỗi tester thấy danh sách TC của mình, mở từng TC, xem các bước
và ghi kết quả: trạng thái, bước lỗi, ghi chú ngắn, liên kết lỗi ở GitLab. Bốn người ghi cùng lúc. Hết đợt, trưởng nhóm
đóng đợt. Trưởng nhóm tạo "lần 2" chỉ gồm các TC chưa đạt của lần 1.

**Why this priority**: hiện phần lớn TC của dự án là test tay trong Excel. Không có đợt test tay thì tester vẫn phải dùng
Excel và dashboard thiếu số liệu.

**Independent Test**: tạo đợt 20 TC, giao cho 2 người, hai người ghi song song. Đóng đợt. Tạo lần 2 từ TC chưa đạt. Lần 2
có đúng các TC đó, kết quả lần 1 không đổi.

**Acceptance Scenarios**:

1. **Given** người có quyền quản lý đợt, **When** tạo đợt và chọn TC theo khu, nhãn, ưu tiên, **Then** mọi TC được chọn
   có trạng thái "Chưa test" (FR-030, FR-031).
2. **Given** TC được giao cho tester A, **When** A ghi "Không đạt" kèm bước lỗi 5 và liên kết lỗi, **Then** kết quả lưu
   với người ghi, thời điểm và phiên bản TC đang dùng (FR-033, FR-034).
3. **Given** A và B cùng sửa kết quả một TC, **When** B lưu sau A, **Then** B nhận thông báo xung đột kèm kết quả của A.
   Không kết quả nào bị ghi đè âm thầm (FR-035).
4. **Given** tester chọn "Khác", **When** lưu không có ghi chú, **Then** bị từ chối (FR-033).
5. **Given** đợt đã đóng, **When** tester sửa kết quả, **Then** bị từ chối. Người quản lý đợt mở lại được với lý do, có
   ghi audit (FR-036).
6. **Given** TC thay nội dung sau khi đợt bắt đầu, **When** xem đợt, **Then** TC có dấu "TC đã đổi sau khi giao" (FR-037).

---

### User Story 5 - Dashboard kết quả (Priority: P1)

Quản lý dự án mở trang "Kiểm thử" của dự án. Trang cho biết: thư viện có bao nhiêu TC, bao nhiêu phần trăm đã tự động,
tỉ lệ đạt hiện tại, đợt tay nào đang mở và tiến độ đợt đó. Người này lọc theo khu `MPI01` và thấy trạng thái từng TC từ
CI và từ đợt tay. Người này chuyển sang góc nhìn theo yêu cầu và thấy `FR-004` có 3 TC, 1 TC không đạt. Biểu đồ xu hướng
cho thấy tỉ lệ đạt trên `main` giảm từ 96% xuống 88% sau ngày 20/10.

**Why this priority**: dashboard là lý do quản lý dự án và đội kiểm thử bỏ việc gộp Excel bằng tay.

**Independent Test**: nạp dữ liệu mẫu gồm 3 khu, 30 TC, 10 lần chạy CI và 2 đợt tay. Mỗi góc nhìn ở FR-050…FR-057 cho số
liệu khớp với tính tay trên dữ liệu mẫu.

**Acceptance Scenarios**:

1. **Given** dự án có kết quả CI và kết quả tay, **When** mở dashboard, **Then** thấy tổng TC, tỉ lệ tự động, tỉ lệ đạt
   hiện tại và tiến độ đợt đang mở (FR-050, FR-051).
2. **Given** TC có kết quả CI "Đạt" và kết quả tay mới hơn "Không đạt", **When** xem TC, **Then** trạng thái hiện tại là
   "Không đạt" và hai nguồn hiện riêng (FR-052).
3. **Given** lọc theo yêu cầu, **When** chọn `FR-004`, **Then** thấy các TC liên kết `FR-004` và trạng thái từng TC
   (FR-054).
4. **Given** một TC đổi giữa Đạt và Không đạt ít nhất 3 lần trong 10 lần chạy gần nhất trên nhánh tham chiếu, **When** xem
   danh sách chập chờn, **Then** TC đó có trong danh sách (FR-056).
5. **Given** TC có lần chạy CI không đạt, **When** bấm vào kết quả, **Then** trình duyệt mở job tương ứng ở GitLab
   (FR-057).

---

### User Story 6 - Agent đọc test case theo mã (Priority: P2)

Dev nhờ agent viết test Playwright cho `TC-MPI01-004`. Agent gọi công cụ MCP của hive, lấy đủ các bước, kết quả mong đợi
và yêu cầu của TC. Agent đặt mã TC vào tên test để kết quả CI gắn đúng TC.

**Why this priority**: viết test tự động từ TC là việc lặp lại nhiều. Agent cần TC có cấu trúc thay vì đọc Excel.

**Independent Test**: trong một run của dự án, agent hỏi TC theo mã và theo khu. Kết quả đúng nội dung thư viện. Run của
dự án khác không đọc được.

**Acceptance Scenarios**:

1. **Given** run của dự án có thư viện, **When** agent hỏi `TC-MPI01-004`, **Then** nhận đủ trường của TC (FR-060).
2. **Given** run của dự án khác, **When** agent hỏi cùng mã, **Then** không nhận dữ liệu (FR-060).

---

### User Story 7 - Xuất kết quả đợt (Priority: P3)

Trưởng nhóm test xuất kết quả đợt ra file CSV để gửi báo cáo theo mẫu của khách hàng.

**Why this priority**: báo cáo cho khách hàng vẫn cần file. Việc này không chặn các story khác.

**Independent Test**: xuất đợt 20 TC. File có 20 dòng với mã, tên, khu, người ghi, trạng thái, bước lỗi, ghi chú, liên
kết lỗi, thời điểm.

**Acceptance Scenarios**:

1. **Given** đợt có kết quả, **When** xuất, **Then** file CSV UTF-8 mở được bằng Excel và giữ đúng chữ tiếng Việt (FR-062).

---

### Edge Cases

- **Cùng mã TC ở hai file.** File lưu sau bị từ chối với lỗi "Mã đã có ở khu khác". File trước giữ nguyên.
- **Đổi mã khu.** Mã TC là định danh. Đổi mã khu là tạo TC mới và ngừng dùng TC cũ. Hive cảnh báo trước khi lưu.
- **Sửa file cùng lúc trên web và trong repo.** Dùng luật hợp ba bản của docsync. Không hợp được thì chờ người giải quyết.
  Thư viện giữ bộ TC hợp lệ cuối cùng tới khi hết xung đột.
- **Một test chứa hai mã TC.** `hive test-summary` của spec 035 từ chối cả báo cáo. Với nguồn CI, từ chối cả báo cáo làm
  mất cả lần chạy, nên test đó chỉ vào số "test mơ hồ" và không gắn vào TC nào (FR-023). Luật của 035 giữ nguyên.
- **Nhiều test cùng một TC, hoặc chạy trên nhiều trình duyệt.** Gộp theo trạng thái xấu nhất: Không đạt > Chập chờn > Bỏ
  qua > Đạt (035 FR-007).
- **Báo cáo quá 5.000 TC.** Worker giữ các TC có trạng thái xấu trước khi cắt và gửi cờ "đã cắt bớt". Dashboard hiện cờ
  này trên lần chạy.
- **File báo cáo vượt 32 MiB.** Worker không đọc được. Lần chạy ở trạng thái "lỗi đọc" kèm lý do tiếng Việt và không đổi
  trạng thái hiện tại của TC.
- **Pipeline có nhiều job e2e.** Một lần chạy gộp mọi job khớp bộ lọc của cùng pipeline. Mỗi TC giữ liên kết tới job có
  kết quả xấu nhất.
- **Pipeline bị huỷ hoặc job lỗi trước khi có báo cáo.** Hub ghi lần chạy "không có báo cáo" kèm trạng thái pipeline.
  Lần chạy này không đổi trạng thái hiện tại của TC.
- **Pipeline MR.** Kết quả MR hiện ở lịch sử nguồn và ở TC, nhưng không đổi trạng thái tự động của TC trên nhánh tham
  chiếu.
- **Worker mất kết nối khi đang đọc.** Việc đọc hết lease thì được giao lại. Hub loại trùng theo pipeline (FR-027).
- **TC ngừng dùng vẫn có test chạy.** Kết quả vẫn lưu, dashboard đánh dấu "TC ngừng dùng còn test".
- **Tester ghi dữ liệu bệnh nhân thật vào ghi chú.** Hive không phát hiện được nội dung. Ô ghi chú hiện nhắc "Không ghi
  dữ liệu người bệnh thật". Admin xoá được ghi chú, có audit.
- **Vai trò tự tạo nhân bản từ vai trò cũ.** Không tự nhận quyền kiểm thử mới. Admin thêm tay nếu cần.
- **Đợt có TC của khu đã xoá file.** TC chuyển "Ngừng dùng" nhưng vẫn ở trong đợt và ghi kết quả được tới khi đóng đợt.

## Requirements *(mandatory)*

### Functional Requirements

**Thư viện test case (US1)**

- **FR-001**: Mỗi dự án PHẢI có một thư mục test case trong docs home của dự án. Mặc định là `test-cases/`, admin dự án
  đổi được. Mỗi file Markdown trong thư mục là một khu chức năng.
- **FR-002**: Mỗi TC PHẢI có: mã, tên, ưu tiên (P1, P2, P3), loại (tự động, tay, dự kiến tự động), ít nhất một mã yêu
  cầu, ít nhất một bước có thao tác và kết quả mong đợi. Mỗi TC CÓ THỂ có: điều kiện trước, nhãn, dữ liệu test (mã tham
  chiếu), ghi chú. TC loại tự động PHẢI có đường dẫn script tương đối trong repo test.
- **FR-003**: Mã TC thư viện PHẢI có dạng `TC-<KHU>-<SỐ>`. `<KHU>` gồm 2–16 ký tự chữ hoa hoặc số, bắt đầu bằng chữ.
  `<SỐ>` gồm 3–5 chữ số. Mã PHẢI duy nhất trong dự án. Hive KHÔNG ĐƯỢC nhận mã dạng `TC-<SỐ>` của spec 035 vào thư viện.
- **FR-004**: Hive PHẢI đọc lại file mỗi khi file có phiên bản mới. File có lỗi thì hive PHẢI giữ bộ TC hợp lệ trước đó
  của file, KHÔNG ĐƯỢC cập nhật một phần, và PHẢI hiện lỗi tiếng Việt kèm số dòng ở trang tài liệu và trang thư viện.
- **FR-005**: Sửa trên web và sửa trong repo docs PHẢI cho cùng kết quả. Hive dùng đồng bộ của docsync, không thêm đường
  đồng bộ thứ hai.
- **FR-006**: TC bị xoá khỏi file PHẢI chuyển "Ngừng dùng". Lịch sử kết quả PHẢI còn. Mã đã dùng KHÔNG ĐƯỢC cấp lại cho TC
  khác trong cùng dự án.
- **FR-007**: Mỗi TC PHẢI có số phiên bản nội dung. Phiên bản tăng khi một trường của FR-002 đổi.
- **FR-008**: "Thêm khu chức năng" PHẢI tạo file theo mẫu có sẵn một TC ví dụ. Mẫu viết tiếng Việt.
- **FR-009**: Thư viện PHẢI tìm và lọc được theo mã, tên, khu, nhãn, ưu tiên, loại, mã yêu cầu và trạng thái hiện tại.

**Vai trò và quyền (US2)**

- **FR-010**: Hive PHẢI thêm các quyền: `qa.read` (xem thư viện, đợt, kết quả, dashboard), `qa.cases.write` (sửa file
  trong thư mục test case), `qa.record` (ghi kết quả tay của TC được giao hoặc đợt cho phép), `qa.rounds.manage` (tạo,
  giao, đóng, mở lại đợt). Tên quyền cuối cùng chốt ở plan.
- **FR-011**: `qa.cases.write` PHẢI chỉ cho sửa file trong thư mục test case của dự án. Sửa tài liệu khác vẫn cần
  `docs.write`.
- **FR-012**: Hive PHẢI thêm vai trò hệ thống `team-tester` (tên hiển thị "Tester"), liệt kê đủ quyền: `qa.read`,
  `qa.cases.write`, `qa.record`, `qa.rounds.manage`, `docs.read`, `proposals.create`, `tasks.read`, `runs.read`, `ci.view`.
- **FR-013**: `team-tester` KHÔNG ĐƯỢC có quyền tạo task, chạy hoặc huỷ run, merge, deploy, quản trị máy, mở terminal
  Leader, quản trị thành viên hay ghi đè AI SDLC.
- **FR-014**: Vai trò có sẵn PHẢI nhận quyền kiểm thử như sau: `owner`, `admin`, `team-admin` có cả bốn quyền;
  `member`, `team-member` có `qa.read` và `qa.record`; `team-viewer` có `qa.read`; `team-ba` có `qa.read`.
- **FR-015**: Mọi dữ liệu kiểm thử PHẢI theo phạm vi tổ chức và đội của dự án (D22). Người ngoài đội của dự án KHÔNG ĐƯỢC
  thấy thư viện, đợt hay kết quả.
- **FR-016**: Từ chối quyền PHẢI trả thông báo tiếng Việt nêu quyền còn thiếu.

**Kết quả CI (US3)**

- **FR-020**: Người có `projects.settings` PHẢI khai được nguồn kết quả CI cho dự án: repo GitLab, bộ lọc nhánh, bộ lọc
  tên job, cách đọc báo cáo (báo cáo test của pipeline, file JUnit XML trong artifact, file Playwright JSON trong
  artifact), nhãn hiển thị và nhánh tham chiếu.
- **FR-021**: Khi webhook GitLab báo pipeline của repo nguồn đã xong và khớp bộ lọc, hub PHẢI tạo một việc "đọc kết quả
  test" và giao cho worker theo cách chọn máy của spec 032.
- **FR-022**: Hub KHÔNG ĐƯỢC tự gọi GitLab để đọc báo cáo. Không có worker đủ điều kiện thì việc PHẢI ở trạng thái chờ
  kèm lý do tiếng Việt và hết hạn sau 24 giờ.
- **FR-023**: Worker PHẢI đọc báo cáo tại máy bằng credential GitLab của kho bí mật tại máy (spec 031, 032 FR-034), rồi
  chuyển thành metadata bằng cùng bộ đọc của `hive test-summary` (giới hạn 32 MiB, 5.000 TC, luật gộp của 035 FR-007).
  Khác 035: test chứa nhiều mã TC PHẢI vào số "test mơ hồ" thay vì làm hỏng cả báo cáo.
- **FR-024**: Metadata của một lần chạy PHẢI gồm: nguồn, mã pipeline, mã các job đã đọc, nhánh, SHA commit, loại pipeline
  (nhánh hoặc MR), thời điểm bắt đầu và kết thúc, tổng theo trạng thái, số test chưa gắn mã, số test mơ hồ, danh sách mã
  lạ, cờ đã cắt bớt, và từng dòng TC gồm mã, trạng thái, số lần retry, thời gian chạy, mã job có kết quả xấu nhất.
- **FR-025**: Worker và hub KHÔNG ĐƯỢC chuyển hoặc lưu tên test, tên suite, thông báo lỗi, stdout, stderr, ảnh, video,
  trace, attachment hay biến môi trường (Q3). Schema PHẢI từ chối trường lạ ở mọi cấp.
- **FR-026**: Hub PHẢI dựng được liên kết tới pipeline và job từ địa chỉ repo đã khai và mã pipeline, mã job. Hub không cần
  lưu URL tự do do worker gửi.
- **FR-027**: Hub PHẢI loại trùng theo nguồn và mã pipeline. Gửi lại cho cùng pipeline PHẢI thay metadata cũ, không tạo lần
  chạy thứ hai.
- **FR-028**: Người có `projects.settings` PHẢI yêu cầu được "Lấy lại kết quả" cho một nguồn. Hub giao worker đọc các
  pipeline đã xong trong 7 ngày gần nhất mà hub chưa có kết quả.
- **FR-029**: Khi khai nguồn mới, hub PHẢI đọc tối đa 20 pipeline gần nhất trên nhánh tham chiếu để dashboard có xu
  hướng ban đầu.

**Đợt test tay (US4)**

- **FR-030**: Người có `qa.rounds.manage` PHẢI tạo được đợt với: tên, môi trường (chữ), bản phần mềm (chữ), ngày bắt đầu,
  ngày kết thúc dự kiến, và danh sách TC chọn theo khu, nhãn, ưu tiên, loại hoặc chọn từng TC.
- **FR-031**: Mỗi TC trong đợt PHẢI bắt đầu ở "Chưa test". Người quản lý đợt PHẢI giao được TC cho một hoặc nhiều tester,
  theo từng TC hoặc theo khu.
- **FR-032**: Tester PHẢI thấy danh sách "Việc của tôi" gồm TC được giao trong các đợt đang mở.
- **FR-033**: Kết quả tay PHẢI có: trạng thái theo bảng trạng thái, bước lỗi (số bước, tuỳ chọn), ghi chú tối đa 500 ký tự,
  tối đa 5 liên kết lỗi dạng `http` hoặc `https`. Trạng thái "Khác" và "Không đạt" PHẢI có ghi chú hoặc liên kết lỗi.
- **FR-034**: Mỗi kết quả PHẢI lưu người ghi, thời điểm ghi và phiên bản TC lúc ghi. Lịch sử sửa của kết quả PHẢI còn.
- **FR-035**: Hai người sửa cùng một kết quả thì người lưu sau PHẢI nhận thông báo xung đột kèm bản mới nhất. Hive KHÔNG
  ĐƯỢC ghi đè âm thầm.
- **FR-036**: Đợt PHẢI có hai trạng thái: đang mở, đã đóng. Đợt đã đóng KHÔNG ĐƯỢC nhận kết quả mới. Mở lại đợt PHẢI có lý
  do 10–500 ký tự và ghi audit.
- **FR-037**: TC đổi phiên bản sau khi vào đợt PHẢI có dấu "TC đã đổi sau khi giao" ở màn đợt.
- **FR-038**: Người quản lý đợt PHẢI tạo được đợt tiếp theo từ một đợt cũ, chọn TC theo trạng thái (mặc định: Không đạt,
  Chưa test, Chuyển đợt sau, Khác). Đợt mới giữ liên kết tới đợt cũ.
- **FR-039**: Hive KHÔNG ĐƯỢC nhận ảnh hay file đính kèm cho kết quả tay. Bằng chứng nằm ở hệ thống lỗi qua liên kết.

**Dashboard (US5)**

- **FR-050**: Trang "Kiểm thử" của dự án PHẢI hiện: tổng TC đang dùng, số và tỉ lệ TC theo loại, tỉ lệ đạt hiện tại, số TC
  không đạt, lần chạy CI gần nhất của mỗi nguồn, các đợt đang mở và tiến độ từng đợt.
- **FR-051**: Tỉ lệ đạt hiện tại PHẢI bằng số TC có trạng thái hiện tại "Đạt" chia cho số TC đang dùng đã có ít nhất một
  kết quả. TC chưa có kết quả PHẢI hiện thành số riêng "Chưa có kết quả".
- **FR-052**: Trạng thái hiện tại của TC PHẢI là kết quả mới hơn theo thời gian giữa: kết quả CI mới nhất trên nhánh
  tham chiếu và kết quả tay mới nhất (trừ "Chưa test", "Không test", "Chuyển đợt sau"). Màn chi tiết PHẢI hiện hai nguồn
  riêng.
- **FR-053**: Góc nhìn theo khu PHẢI hiện mỗi khu: số TC, tỉ lệ tự động, tỉ lệ đạt, số TC không đạt, số TC chưa có kết quả.
- **FR-054**: Góc nhìn theo yêu cầu PHẢI liệt kê mọi mã yêu cầu xuất hiện trong thư viện, số TC của mỗi mã và trạng thái
  xấu nhất của các TC đó.
- **FR-055**: Góc nhìn xu hướng PHẢI hiện tỉ lệ đạt và số TC không đạt theo từng lần chạy CI trên nhánh tham chiếu, tối
  đa 90 ngày, lọc được theo nguồn và khu.
- **FR-056**: Danh sách chập chờn PHẢI gồm TC có trạng thái "Chập chờn" hoặc đổi giữa Đạt và Không đạt ít nhất 3 lần trong
  10 lần chạy gần nhất trên nhánh tham chiếu. Danh sách chỉ để xem; hive KHÔNG ĐƯỢC tự bỏ qua hay cách ly TC.
- **FR-057**: Màn chi tiết TC PHẢI hiện nội dung TC, lịch sử kết quả CI và kết quả tay, liên kết tới job GitLab và liên
  kết lỗi. Bấm vào kết quả CI PHẢI mở job ở GitLab.
- **FR-058**: Dashboard PHẢI hiện số "test chưa gắn mã", "test mơ hồ" và danh sách mã lạ của lần chạy gần nhất mỗi nguồn,
  để đội gắn mã còn thiếu.

**Agent và báo cáo (US6, US7)**

- **FR-060**: Agent trong run của dự án PHẢI đọc được TC theo mã và danh sách TC theo khu qua MCP, trong phạm vi quyền
  của run. Agent KHÔNG ĐƯỢC đọc thư viện của dự án khác.
- **FR-061**: Agent KHÔNG ĐƯỢC ghi kết quả tay hay sửa cấu hình nguồn CI.
- **FR-062**: Người có `qa.read` PHẢI xuất được kết quả một đợt ra CSV UTF-8 có BOM, mỗi TC một dòng.

**Bảo mật, audit, dữ liệu**

- **FR-070**: Hive PHẢI ghi audit cho: tạo, đóng, mở lại đợt; đổi người được giao; sửa hoặc xoá kết quả tay; thêm, sửa,
  xoá nguồn kết quả CI; "Lấy lại kết quả"; xoá ghi chú bởi admin.
- **FR-071**: Mọi bảng mới PHẢI có `org_id`, bật và ép RLS, và chỉ truy cập qua `withTenant()` bằng role `hive_app`.
- **FR-072**: Hub PHẢI giữ metadata lần chạy CI và kết quả tay ít nhất 365 ngày. Admin tổ chức đổi được thời gian giữ, tối
  thiểu 90 ngày.
- **FR-073**: Chữ trên giao diện, thông báo lỗi và mẫu file khu PHẢI viết tiếng Việt.

### Một máy, nhiều tổ chức (specs/034)

Spec 034 đang ở nhánh `ai/SPEC034`, chưa vào `main`. Việc "đọc kết quả test" là việc delivery của spec 032. Worker chạy
nhiều đăng ký PHẢI chỉ nhận việc của đúng đăng ký và dùng credential GitLab của đúng đăng ký đó (032 A10). Spec này không
thêm luật cách ly riêng.

### Key Entities

- **Khu chức năng**: dự án, mã khu, tên, đường dẫn file, phiên bản file đã đọc, lỗi đọc gần nhất.
- **Test case thư viện**: dự án, khu, mã, tên, ưu tiên, loại, mã yêu cầu, nhãn, điều kiện trước, các bước, dữ liệu test,
  script, ghi chú, phiên bản nội dung, trạng thái (đang dùng, ngừng dùng).
- **Nguồn kết quả CI**: dự án, repo, bộ lọc nhánh, bộ lọc job, cách đọc báo cáo, nhãn, nhánh tham chiếu, người tạo.
- **Lần chạy CI**: nguồn, mã pipeline, mã job, nhánh, SHA, loại pipeline, thời điểm, tổng theo trạng thái, các số đếm của
  FR-024, cờ đã cắt bớt, trạng thái đọc (chờ, đang đọc, xong, không có báo cáo, lỗi).
- **Kết quả TC của lần chạy CI**: lần chạy, mã TC, trạng thái, số lần retry, thời gian chạy, mã job.
- **Việc đọc kết quả test**: lần chạy, máy được giao, lease, trạng thái, lý do chưa giao. Dùng mô hình việc delivery của
  spec 032.
- **Đợt test tay**: dự án, tên, môi trường, bản phần mềm, ngày, trạng thái, đợt trước, người tạo.
- **TC trong đợt**: đợt, TC, phiên bản TC lúc thêm, người được giao.
- **Kết quả tay**: TC trong đợt, trạng thái, bước lỗi, ghi chú, liên kết lỗi, người ghi, thời điểm, phiên bản TC, số
  phiên bản bản ghi (để phát hiện xung đột).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Tester chưa dùng hive viết và lưu được một khu có 3 TC hợp lệ từ mẫu trong dưới 15 phút.
- **SC-002**: Khi có worker trực tuyến đủ điều kiện, kết quả của pipeline hiện trên dashboard trong dưới 5 phút sau khi
  pipeline xong, ở 95% lần chạy.
- **SC-003**: Trong 100 báo cáo thử có tên test và thông báo lỗi, database và mọi request vào hub chứa 0 tên test, 0 thông
  báo lỗi và 0 byte log.
- **SC-004**: 20 tester ghi kết quả song song trên cùng một đợt 500 TC trong 30 phút: 0 kết quả bị mất hoặc bị ghi đè âm
  thầm.
- **SC-005**: Với dự án 5.000 TC, 90 ngày lịch sử và 20 người xem cùng lúc, mỗi góc nhìn của dashboard mở trong dưới
  3 giây ở 95% lần mở.
- **SC-006**: Quản lý dự án trả lời được "khu X đạt bao nhiêu phần trăm" và "yêu cầu Y đã có TC đạt chưa" trong dưới
  1 phút, không mở file Excel.
- **SC-007**: Trong bộ test quyền, 100% thao tác bị cấm ở FR-013 trả lỗi cho người chỉ có `team-tester`.
- **SC-008**: Cùng một pipeline được báo 3 lần: hub có đúng 1 lần chạy.
- **SC-009**: Số liệu của mọi góc nhìn dashboard khớp 100% với số tính tay trên bộ dữ liệu mẫu của US5.

## Assumptions

- **A1**: Repo test tự động (ví dụ bộ Playwright) đặt mã TC thư viện vào tên test, ví dụ
  `[TC-MPI01-001] Tìm bệnh nhân theo mã`. Tag `@TC-…` chỉ dùng được nếu báo cáo JUnit hoặc JSON chứa tag; plan kiểm điều
  này với phiên bản Playwright đang dùng.
- **A2**: Một test gắn tối đa một mã TC (luật của spec 035). Một TC có thể có nhiều test.
- **A3**: Đường worker đọc GitLab của spec 032 (032 FR-034, chọn máy, kho credential) có trước khi US3 code xong. Nếu chưa,
  US1, US2, US4, US5 vẫn làm được với kết quả tay; US3 chờ 032.
- **A4**: Webhook Pipeline của GitLab vào hub vẫn hoạt động (032 A6).
- **A5**: Chuyển file Excel cũ sang Markdown làm bằng script ngoài hive, ví dụ map `TC_MPI01.01` thành `TC-MPI01-001`.
  Hive không nhập Excel trong bản này.
- **A6**: Mã yêu cầu theo dạng dự án đang dùng: mã spec `FR-…`, `AC-…`, `NFR-…`, hoặc mã SRS của BA, ví dụ `OPD02`. Dự án
  có nhiều spec CÓ THỂ thêm tiền tố số spec vào mã spec, ví dụ `001/FR-003`. Plan chốt regex (research D10).
- **A7**: Các ngưỡng 24 giờ chờ, 7 ngày lấy lại, 20 pipeline ban đầu, 365 ngày giữ, 3 lần đổi trong 10 lần chạy là mặc định
  chưa đo. Plan có thể đổi.
- **A8**: Quy mô ước tính cho một dự án: tối đa 20.000 TC, 200 khu, 50 tester, 50 lần chạy CI mỗi ngày.
- **A9**: Docs home của dự án đã được khai (spec 022, ADR 0028). Dự án chưa có docs home thì trang "Kiểm thử" hướng dẫn
  khai trước.

## Out of Scope

- Chạy bộ test từ web, lên lịch chạy hồi quy, chọn máy chạy test (035 giữ nguyên ranh giới này).
- Dùng kết quả thư viện làm bằng chứng cho cổng QA của spec 035 (Q2). TC theo hạng mục giữ nguyên.
- Nhận kết quả từ Jenkins, GitHub Actions hoặc job CI tự gửi lên hub (Q1 phương án B).
- Gửi kết quả từ máy cá nhân của tester bằng CLI hoặc app desktop.
- Nhập file Excel vào hive.
- Tự tạo issue lỗi khi TC không đạt.
- Cách ly test chập chờn, tự bỏ qua TC.
- Lưu thông báo lỗi, log, ảnh, video, trace hay file đính kèm (Q3).
- Danh sách yêu cầu chưa có TC. Cần nguồn danh sách yêu cầu đầy đủ, để spec sau.
- Thông báo qua `notify` khi tỉ lệ đạt giảm.
- Đổi cổng QA, luật miễn TC hay quyền `sdlc.override` của spec 035.
