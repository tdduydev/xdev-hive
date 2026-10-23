# Đặc tả 035: Tự động hoá QA

**Nhánh**: `ai/SPEC035` · **Phạm vi chốt**: 23/10/2026.

## Mục tiêu và giới hạn

1. Test case có cấu trúc, mã TC-xxx, gắn FR và AC.
2. Bộ test chạy tại worker hoặc desktop. Hub nhận metadata kết quả, không nhận log, code, ảnh, trace hay reporter gốc.
3. Verification trong chế độ QA chỉ qua khi mọi TC bắt buộc pass hoặc từng TC được người có quyền miễn.

Hub và web chỉ làm kho metadata, cấu hình, cổng duyệt và quản trị. Không có nút chạy bộ test ở web.
Luồng thực thi dùng bước `test-run` của AI SDLC sẵn có, thực thi trên worker và dùng được từ desktop.
Không thêm kiểu run, hàng đợi thực thi, trigger hay kênh worker mới.

- Cách ly test chập chờn: ngoài phạm vi.
- Lịch chạy hồi quy: ngoài phạm vi.
- Vòng tự tạo lỗi, dashboard xu hướng và nhập CI ngoài: ngoài phạm vi.
- Vai trò Tester riêng: việc làm sau; bản này dùng vai trò và quyền của đội đang có.

## US1 — Test case truy vết được

Tài liệu `test-cases` qua cổng duyệt sinh TC có mã, tiêu đề, ưu tiên P1–P3, loại manual/automated,
danh sách FR/AC, đường dẫn script, khoá test tham khảo và cờ bắt buộc (mặc định true).
Mã duy nhất trong hạng mục, nên hai hạng mục cùng dự án có thể có TC-001 riêng.
Tên test tại máy chứa mã TC để parser ánh xạ; khoá test chỉ là metadata tham khảo.

**FR-001**: Đồng bộ TC trong cùng transaction baseline; bảng sai phải chặn và rollback, không cập nhật một phần.
**FR-002**: Sửa giữ mã TC và id; bỏ dòng đánh dấu ngừng dùng; không xoá lịch sử metadata trong các bước.
**FR-003**: Mỗi TC phải liên kết ít nhất một FR hoặc AC; TC automated cần đường dẫn script tương đối trong repo.
**FR-004**: Thay nội dung hoặc khôi phục TC phải xoá quyết định miễn cũ. Duyệt lại nội dung không đổi giữ quyết định.

**AC-1.1**: Bảng hợp lệ tạo đúng TC, FR/AC và đường dẫn script.
**AC-1.2**: Mã trùng, thiếu FR/AC, script thoát repo hay bảng không đọc được đều bị từ chối.
**AC-1.3**: Thêm/sửa/bỏ TC làm bằng chứng chạy trước không còn phù hợp; TC ngừng dùng không chặn.

## US2 — Chạy tại máy, báo metadata

**FR-005**: `test-run` chạy trên worker theo hợp nhãn dự án và nhãn bước (ví dụ browser, qa-env).
**FR-006**: CLI `hive test-summary` đọc Playwright JSON hoặc JUnit XML tại máy. Kết quả chỉ có runner,
SHA commit tuỳ chọn, tổng theo trạng thái, thời gian, các dòng mã TC/trạng thái/retries/thời gian và cờ cắt bớt.
**FR-007**: Nhiều test/browser cùng TC được gộp theo trạng thái xấu nhất: failed > flaky > skipped > passed.
Không có mã TC vẫn tính tổng runner, nhưng không tạo bằng chứng cho TC bắt buộc.
**FR-008**: Không chuyển trường tên test, lỗi, stdout, code, attachment, URL hay môi trường lên hub.
Schema strict từ chối trường lạ ở mọi cấp. File tối đa 32 MiB, metadata tối đa 5.000 TC.
**FR-009**: Agent gửi JSON qua `sdlc_report` loại `test-results`; chỉ run của bước `test-run` đang hoạt động được gửi.
Gửi lại ghi đè metadata của cùng bước. Mã TC lạ hoặc TC đã đổi từ lúc giao chạy bị từ chối.
**FR-010**: Run lỗi, huỷ hoặc không báo metadata không cung cấp bằng chứng pass. Test fail vẫn được báo metadata.

**AC-2.1**: Báo cáo pytest/Surefire hoặc Playwright cho metadata cùng dạng, không chứa trường tự do của reporter.
**AC-2.2**: Báo cáo sai, thời gian âm, SHA sai, lỗi ngoài test, TC mơ hồ đều bị từ chối.
**AC-2.3**: Log/code/reporter gốc ở lại máy; web không cung cấp API thực thi test.

## US3 — Cổng QA và miễn có quyền

**FR-011**: Luật `qa-cases` kiểm bảng TC; luật `qa-tests` dùng checklist TC trong cơ chế duyệt tài liệu hiện có.
**FR-012**: Điều kiện chuyển pha verification cũng kiểm QA, kể cả không có tài liệu bắt buộc hoặc đã duyệt tài liệu.
Chế độ dùng `test-run` hay luật `qa-tests` trong verification bật điều kiện này; chế độ khác không đổi.
**FR-013**: Chỉ lần `test-run` mới nhất thành công, khớp fingerprint của bộ TC hiện tại mới làm bằng chứng.
Thiếu kết quả, failed, skipped, flaky và TC bị cắt khỏi báo cáo đều chặn. Không có TC bắt buộc cũng chặn.
**FR-014**: Người có `sdlc.override` ở đội dự án chính được miễn/thu hồi từng TC với lý do 10–500 ký tự.
Lưu người quyết định, lý do, thời gian; ghi audit cả miễn lẫn thu hồi. Không dùng ngoại lệ chặn run code để miễn QA.
**FR-015**: Web/desktop xem metadata, FR/AC, trạng thái và quyết định miễn trong màn duyệt AI SDLC.
Không được bỏ qua pha QA bằng chức năng bỏ qua pha tuỳ chọn.

**AC-3.1**: TC-001 pass, TC-002 fail: không chuyển verification. Miễn TC-002 bằng quyền đúng thì đủ điều kiện QA.
**AC-3.2**: Thành viên thường/viewer không miễn được; tổ chức/đội khác không thấy hay thay dữ liệu.
**AC-3.3**: Lần mới lỗi/đang chạy thay bằng chứng cũ; sửa TC làm mất hiệu lực báo cáo cũ và miễn của TC đó.
**AC-3.4**: Miễn đủ điều kiện QA vẫn phải qua các cổng tài liệu/người duyệt còn lại.

## Rủi ro và việc làm sau

- Metadata do worker/agent cung cấp, chưa có chữ ký chứng thực runner; không thay chính sách CI của repo.
- SHA chỉ là metadata tuỳ chọn, chưa đối chiếu HEAD với SCM. Bằng chứng được gắn phiên bản TC và run do hub giao.
- Chỉ kết quả `passed` thuần mới mở cổng; flaky vẫn báo để người duyệt thấy nhưng không có cách ly.
- Bản này không sửa tenancy, governance, delivery, mcp, channel hoặc layers.
