# 58. agent-speed: agent làm nhanh hơn, ít token hơn

Hỏi 7/10: "cho làm nhiều task để tăng tốc đi, và nhớ test RTK xem hoạt động chưa". Kiểm RTK (R-28d) thấy nó chạy được, hub ghi số cho 7 run Claude trên Mac mini: 232 lệnh, output 101.883 → 48.964 token. Đó là ước tính của RTK, tức khoảng 52.900 token bớt đi. Các lô 0.139–0.142 cho thấy những chỗ làm chậm sau:

- Run Codex không đi qua RTK. Hook PreToolUse chỉ có cho Claude, mà phần lớn việc code đang chạy trên gói Codex.
- Máy chạy ẩn (.52) không ai bấm *Cho phép* lệnh của tool từ hub, nên RTK, Spec Kit và chỉ mục codegraph ở đó vẫn *chưa cho phép* hoặc *thiếu*.
- Run tích hợp (INT-*) hay hết 60 phút giữa chừng: INT-0140 cần 3 run. Không giao run nào được lâu hơn thời hạn của profile.
- Muốn kiểm một bước e2e thì phải chạy cả bộ (desktop khoảng 10 phút, điện thoại khoảng 12 phút), mỗi lần sửa một bước lại chạy lại từ đầu.
- Codex với sandbox `workspace-write` không mở được cổng 127.0.0.1 (EPERM), nên không chạy được e2e. Người merge phải tự chạy e2e cho mọi nhánh Codex.

## 58a. codex-rtk

Run Codex cũng nén output lệnh bằng RTK như Claude.

- Nếu Codex có hook trước khi chạy lệnh (repo đã có `.codex/hooks.json` [chưa kiểm phiên bản nào hỗ trợ]), runner bật RTK qua hook đó, giống `readyHooks` cho Claude. Nếu không, chạy lệnh qua wrapper `rtk` trên PATH riêng của run, không đụng PATH của máy.
- Mỗi run có history RTK riêng (`RTK_DB_PATH` trong thư mục run). Cuối run ghi `compression` như Claude, kèm dòng `# rtk: … commands · ~… tokens left out` trong log.
- Tool RTK chưa được cho phép trên máy thì run vẫn chạy bình thường, không lỗi, log ghi một dòng lý do.
- Test: run Codex giả qua fake-agent đi qua hook hoặc wrapper và ghi `compression`; máy chưa cho phép thì run vẫn xong.

## 58b. tool-approve-web

Admin hub hoặc chủ máy cho phép lệnh của tool từ hub trên một máy ngay từ web, cho cả máy chạy ẩn.

- *Máy & agent* › một máy › *Tool*: danh sách tool đang ở trạng thái *chưa cho phép*. Mỗi tool có nút *Cho phép trên máy này* và hiện đúng lệnh sẽ chạy (lệnh kiểm và lệnh cài).
- Hub chỉ lưu quyết định. Máy nhận quyết định qua heartbeat và áp vào cài đặt của mình, như khi bấm *Cho phép* trong app. Quyết định có người duyệt và thời điểm, và ghi vào nhật ký hệ thống.
- Chỉ áp cho mục có trong danh mục của hub với đúng phiên bản và lệnh đã ghim. Đổi lệnh hay phiên bản thì phải cho phép lại.
- Ai không có quyền thì không thấy nút. Thành viên chỉ xem được trạng thái.
- Test: hub (quyền, ghim phiên bản, đổi lệnh thì phải cho phép lại), runner (áp quyết định từ heartbeat), e2e bước tool-approve-web trên desktop và điện thoại.

## 58c. run-timeout

Thời hạn của run hợp với việc của run.

- `runs.dispatch` nhận `timeoutMinutes`, không vượt trần của profile hay hub (cài đặt hub *Thời hạn run tối đa*, mặc định 180 phút). Khung giao run trên web có ô *Thời hạn*.
- Thời hạn mặc định theo loại task (bảng trong cài đặt hub): `integration` / `land` (task INT-*, LAND-*) 120 phút, còn lại giữ thời hạn của profile.
- Hết giờ thì runner commit WIP như hiện tại. Note của task có thêm dòng *Tiếp từ đâu*: branch, commit WIP, bước đang làm (dòng hoạt động cuối). Run sau trên cùng task đọc được dòng đó.
- Test: hub (trần, mặc định theo loại), runner (thời hạn của run thay cho của profile, note *Tiếp từ đâu*).

## 58d. e2e-step

Chạy một hoặc vài bước e2e.

- `npm run e2e -w @xdev-hive/web -- --only <bước>[,<bước>…]` (cả `e2e:mobile`): chạy phần seed chung và các bước được chọn, kèm các bước mà chúng phụ thuộc. Mỗi bước khai báo phụ thuộc trong `browser.mjs`. Bước không khai báo thì coi như phụ thuộc mọi bước trước nó.
- Cuối log in thời gian từng bước và tổng, sắp từ chậm nhất.
- `--repeat N` chạy lại các bước được chọn N lần để bắt lỗi chập chờn, và in số lần lỗi của mỗi bước.
- Chạy cả bộ thì không đổi gì so với hiện nay.
- AGENTS.md (qua doc_propose) và README ghi cách dùng.

## 58e. codex-localhost

Profile Codex chạy được e2e.

- Tuỳ chọn của profile *Cho mở cổng nội bộ (e2e)*, mặc định tắt. Khi bật, runner thêm cấu hình sandbox của Codex để mở và nghe được 127.0.0.1 trong `workspace-write` [chưa kiểm khoá nào của Codex làm được việc này, có thể là `sandbox_workspace_write.network_access`]. Khoá đó mà mở cả mạng ngoài thì trang cài đặt nói rõ điều đó.
- Kiểm trên Codex 0.160 macOS và Linux: một run giả mở server trên 127.0.0.1 và gọi tới nó.
- Note của run ghi profile có tuỳ chọn này hay không, để người merge biết e2e đã được chạy hay chưa.

## Không làm

- Không tự cho phép tool khi chưa có người quyết. 58b chỉ chuyển nút bấm lên web.
- Không nới thời gian chờ hay bỏ bước e2e cho qua (58d dùng để bắt lỗi, không dùng để né lỗi).
