# Quickstart: kiểm tay thư viện test case và dashboard

Dành cho người điều phối, sau khi các task của 036 đã merge vào nhánh thử. Bước có GitLab do người dùng tự chạy trên
GitLab của đội. Agent KHÔNG ĐƯỢC dò cổng hay gọi thử máy chủ nội bộ.

Hợp đồng: [hub-api.md](contracts/hub-api.md), [tc-markdown.md](contracts/tc-markdown.md),
[worker-test-report.md](contracts/worker-test-report.md), [mcp-tools.md](contracts/mcp-tools.md),
[csv-export.md](contracts/csv-export.md). Bảng và công thức: [data-model.md](data-model.md).

## 0. Chuẩn bị

1. Chạy database dev, hub và web theo `AGENTS.md`.
2. Tạo tổ chức thử, một đội, một dự án có docs home. Dự án có kết nối GitLab của tổ chức.
3. Tạo bốn người dùng trong đội: `owner-thu` (admin dự án), `lead-thu` (`team-admin`), `tester-a`, `tester-b`
   (`team-tester`).
4. Chạy `hive-worker` trên một máy, đăng nhập vào tổ chức thử. Máy có credential GitLab chỉ đọc, ví dụ `gitlab-thu`.
5. Một repo test thử trên GitLab, ví dụ `group/e2e-tests`, có pipeline xuất JUnit hoặc Playwright JSON. Tên test chứa mã
   TC, ví dụ `[TC-DANGNHAP-001] Đăng nhập bằng email và mật khẩu đúng`.

## 1. Bật thư viện

1. `owner-thu` mở Cài đặt dự án → Kiểm thử, bật thư viện, giữ thư mục `test-cases/`.
   Kỳ vọng: màn báo kết quả thêm `test-cases/` vào danh sách đồng bộ của docs home (`includeResult`).
2. Tắt thư viện. Kỳ vọng: tab Kiểm thử báo "Dự án chưa bật thư viện test case…" (`QA_LIBRARY_DISABLED`). Bật lại.

## 2. Viết TC (US1, SC-001)

1. `tester-a` mở tab Thư viện, bấm "Thêm khu chức năng", nhập `DANGNHAP`, `Đăng nhập`.
   Kỳ vọng: file `test-cases/dang-nhap.md` có mẫu FR-008, mở trong editor.
2. Thêm ba TC theo ví dụ ở [tc-markdown.md](contracts/tc-markdown.md), lưu. Ghi thời gian từ bước 1. Kỳ vọng: dưới
   15 phút; tab Thư viện có 3 TC.
3. Lưu file có lỗi: thiếu `Ưu tiên`, mã `TC-001`, mã khu khác khu của file.
   Kỳ vọng: panel lỗi nêu đúng dòng và thông điệp của bảng lỗi; thư viện giữ bản trước (FR-004).
4. Tạo file thứ hai dùng lại mã `TC-DANGNHAP-001`. Kỳ vọng: "mã … đã có ở khu khác"; file đầu giữ nguyên.
5. Đổi tên một TC và một bước, lưu. Kỳ vọng: `version` tăng 1. Chỉ dời TC xuống cuối file, lưu. Kỳ vọng: `version` giữ
   nguyên.
6. Đổi tên file sang `test-cases/dang-nhap-moi.md` (giữ `# DANGNHAP`). Kỳ vọng: TC giữ mã, lịch sử và kết quả.
7. Xoá một TC khỏi file, lưu. Kỳ vọng: TC chuyển "Ngừng dùng"; thêm lại TC mới cùng mã ở khu khác bị từ chối
   "mã … đã dùng trước đây".

## 3. Quyền Tester (US2, SC-007)

1. `tester-a`: tạo task, chạy run, sửa tài liệu ngoài `test-cases/`, sửa nguồn CI. Kỳ vọng: mỗi thao tác bị từ chối, thông
   điệp nêu quyền còn thiếu.
2. `tester-a` mở dự án của đội khác bằng URL. Kỳ vọng: `404`, như dự án không tồn tại.
3. Chạy test quyền của module `qa` và `rls.db.test.ts`. Kỳ vọng: xanh.

## 4. Nguồn CI và webhook (US3, SC-002, SC-003, SC-008)

1. `owner-thu` mở tab Nguồn CI, thêm nguồn: repo `group/e2e-tests`, nhánh `main`, mode `junit-artifact`, đường dẫn
   artifact của pipeline thử, credential `gitlab-thu`.
   Kỳ vọng: `backfillState` là `listing`, rồi `done`; nguồn có tối đa 20 lần chạy cũ (research D18).
2. Người dùng chạy một pipeline trên `main` của repo thử. Ghi thời điểm pipeline xong.
   Kỳ vọng: lần chạy mới hiện trên dashboard trong dưới 5 phút, với tổng, `unmapped`, `ambiguous`, `unknownCodes`.
3. Repo thử khác repo của dự án: kiểm webhook pipeline của repo thử có tới hub không (research D6 mục 6, [Unverified]).
   Nếu không tới thì ghi lại cách người dùng đã khai webhook và báo người điều phối thêm task.
4. Người dùng bấm "Retry" webhook ba lần trên GitLab cho cùng pipeline. Kỳ vọng: vẫn một lần chạy (SC-008).
5. Cho pipeline thử có test lỗi với thông báo lỗi riêng, ví dụ `LOI-MAU-123`. Tìm `LOI-MAU-123` và tên test trong database
   hub, log hub và audit. Kỳ vọng: không thấy (SC-003).
6. Tắt worker, chạy pipeline. Kỳ vọng: lần chạy "Chờ máy" với thông điệp `offline`. Bật worker. Kỳ vọng: lần chạy được
   đọc.
7. Bấm "Lấy lại kết quả" hai lần liền. Kỳ vọng: lần hai báo "Đang lấy lại kết quả cho nguồn này…"
   (`QA_REFETCH_RUNNING`).
8. Xoá credential `gitlab-thu` trên máy, chạy pipeline. Kỳ vọng: thông điệp `missing_credential`.

## 5. Đợt test tay (US4, SC-004)

1. `lead-thu` tạo đợt từ khu `DANGNHAP`, giao TC cho `tester-a`. Kỳ vọng: "Việc của tôi" của `tester-a` có các TC đó.
2. `tester-b` ghi kết quả một TC không được giao. Kỳ vọng: `QA_NOT_ASSIGNED`. `lead-thu` bật "cho mọi tester ghi".
   Kỳ vọng: `tester-b` ghi được.
3. `tester-a` và `tester-b` mở cùng TC, cả hai sửa rồi lưu. Kỳ vọng: người lưu sau nhận `409 QA_RESULT_CONFLICT`,
   "Kết quả này vừa được người khác lưu…" kèm bản mới; lịch sử có bản của người lưu trước.
4. Ghi `Không đạt` không có ghi chú. Kỳ vọng: `QA_NOTE_REQUIRED`, "Trạng thái Khác và Không đạt cần ghi chú hoặc
   liên kết lỗi."
5. Sửa TC trong thư viện sau khi giao. Kỳ vọng: dòng TC trong đợt có cờ "TC đã đổi sau khi giao".
6. Đóng đợt, ghi kết quả. Kỳ vọng: `QA_ROUND_CLOSED`. Mở lại với lý do 3 ký tự. Kỳ vọng: từ chối. Mở lại với lý do đủ
   dài. Kỳ vọng: audit có lý do.
7. Tạo đợt tiếp từ đợt cũ. Kỳ vọng: chỉ có TC `failed`, `untested`, `deferred`, `other`; giữ người được giao.
8. Tải SC-004: chạy kịch bản 20 tester × 500 TC (tên file chốt ở tasks.md).
   Kỳ vọng: 0 kết quả mất; mọi xung đột trả `409 QA_RESULT_CONFLICT`.

## 6. Dashboard (US5, SC-005, SC-006, SC-009)

1. Nạp bộ dữ liệu mẫu của US5 (seed của test dashboard). So từng góc nhìn với số tính tay. Kỳ vọng: khớp 100%.
2. TC có kết quả CI `passed` và kết quả tay `failed` mới hơn. Kỳ vọng: trạng thái hiện tại `failed`, nguồn "tay".
3. Góc nhìn theo yêu cầu: chọn một mã yêu cầu, kiểm trạng thái xấu nhất theo thứ tự ở data-model.
4. TC đổi kết quả 3 lần trong 10 lần chạy tham chiếu. Kỳ vọng: có ở danh sách chập chờn.
5. Biểu đồ xu hướng: kiểm có bảng số liệu đi kèm, đọc được bằng bàn phím, đúng ở giao diện sáng và tối, rộng 360 px.
6. Đo SC-005 bằng seed 5.000 TC, 90 ngày, 20 người xem. Kỳ vọng: p95 mỗi góc nhìn dưới 3 giây.

## 7. Agent đọc TC (US6)

1. Tạo run của dự án, gọi `qa_get_case` với `TC-DANGNHAP-001`. Kỳ vọng: có các bước và `current`.
2. Trong run đó gọi `qa_list_cases` với `project` của dự án khác. Kỳ vọng: `PROJECT_NOT_FOUND`.
3. `tools/list` của MCP. Kỳ vọng: hai công cụ có `readOnlyHint: true`, không có công cụ ghi.

## 8. Xuất CSV (US7)

1. Xuất đợt 20 TC. Kỳ vọng: 21 dòng; tên file `dot-test-<slug>-<ngày>.csv`.
2. Mở bằng Excel. Kỳ vọng: chữ tiếng Việt đúng; ghi chú bắt đầu bằng `=1+1` hiện dạng chữ, không thành công thức.
3. Audit có `qa.rounds.export`.

## 9. Giữ dữ liệu

1. Admin tổ chức đặt thời gian giữ 89 ngày. Kỳ vọng: từ chối (90–3.650 ngày). Đặt 90 ngày.
2. Chạy `hive.purge_qa_data()` trên database thử có lần chạy CI và đợt đã đóng cũ hơn 90 ngày. Kỳ vọng: hai loại đó bị xoá;
   TC, lịch sử phiên bản TC và đợt còn mở giữ nguyên.

## Không có trong bản này

Tải ảnh hay file đính kèm, cách ly test chập chờn, ghi kết quả CI bằng tay, lưu thông báo lỗi hay log của test.
