# 59. flow-speed: từ lúc giao tới lúc phát hành nhanh hơn

Hỏi ngày 7/10: "giao nhiều việc, nhiều task á". Các lô 0.139–0.142 cho thấy thời gian không nằm ở việc viết code. Nó mất ở mấy chỗ sau:

- e2e trên Linux (.52, xvfb) lỗi 10 bước gõ phím và lưu form mà macOS chạy qua. Unit test trên Linux lỗi 7 test phụ thuộc môi trường. Vì vậy chỉ Mac mini làm cổng kiểm được, và mọi lô phải xếp hàng trên một máy.
- Phần lớn lỗi e2e khi ghép lô là cú bấm chuột rơi vào chỗ khác: khung đang đóng che mất, toast che nút, danh sách xô lệch sau khi cuộn. Mỗi chỗ đang được vá riêng một kiểu.
- `--only` của 58d chưa nhanh, vì đa số bước chưa khai báo phụ thuộc nên vẫn kéo theo mọi bước đứng trước.
- Giao lại một run lỗi hay hết giờ sang máy hoặc gói khác (giữ nguyên chỉ dẫn, làm tiếp trên branch) đang phải dùng script ngoài.
- Máy chạy ẩn (.52) và Mac mini tụt bản vì app chỉ cài bản mới khi người dùng thoát app.
- Ghép một lô (tạo branch review, merge từng nhánh, báo xung đột, chạy cổng kiểm) đang làm bằng tay.

## 59a. e2e-linux

e2e (desktop và điện thoại) xanh trên Linux dưới `xvfb-run` như trên macOS.

- Tìm vì sao các bước gõ phím và lưu form lỗi trên Linux (danh sách lỗi ở note task): bàn phím của Electron dưới xvfb, phím tắt Meta và Control, font, kích thước cửa sổ, hay tốc độ máy.
- Bước nào cần phím tắt thì dùng Control trên Linux, Meta trên macOS (helper chung).
- Chạy được bằng `ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a -s "-screen 0 1440x900x24" npm run e2e…`. README ghi lệnh này.
- Xong khi e2e và e2e:mobile xanh 2 lần liên tiếp trên .52.

## 59b. tests-linux

`npm test` xanh trên Linux.

- Các test đang lỗi trên .52: chạy trong container, đăng nhập CLI trong container, trợ lý viết Docs, Setup máy này, phiên bản CLI. Tách phần phụ thuộc máy (docker thật, Keychain, đường dẫn macOS) ra sau một lớp giả lập, hoặc bỏ qua có lý do khi máy thiếu công cụ, kèm thông báo rõ ràng. Không bỏ qua một test chỉ để cho xanh.
- Xong khi `npm test` xanh trên .52 và trên Mac mini.

## 59c. e2e-needs

Khai báo `NEEDS` cho mọi bước e2e, để `--only <bước>` chỉ chạy những gì bước đó thật sự cần.

- Mỗi bước ghi rõ cần bước nào (tab đã đăng nhập, dữ liệu seed, task hay run do bước khác tạo). Bước dùng chung dữ liệu với bước khác thì tự tạo dữ liệu riêng nếu làm được.
- Một script kiểm: với mỗi bước, `--only <bước>` chạy xanh một mình. In danh sách bước chưa chạy riêng được.
- Xong khi mọi bước chạy riêng được, hoặc có lý do ghi ngay cạnh bước.

## 59d. e2e-click

Một cách bấm chung cho e2e, thay cho các bản vá rời.

- `tab.click` chờ phần tử đứng yên (vị trí không đổi qua 2 khung hình), chờ không còn overlay hay khung Sheet đang mở hoặc đóng che lên nó, rồi kiểm phần tử nằm ở điểm bấm là chính nó hoặc con của nó (`elementFromPoint`). Sai thì cuộn lại và đo lại; quá thời gian thì báo lỗi kèm tên phần tử đang che.
- Bỏ các bản vá focus + Enter và các chỗ chờ khung đóng viết riêng, nếu helper mới làm thay được. Riêng React Flow giữ cách hiện có.
- Làm sau 59c (cùng file).

## 59e. run-redispatch

*Giao lại* một run từ trang run và từ khung task.

- Run lỗi, hết giờ, bị huỷ hay vướng quota có nút *Giao lại*. Khung giao điền sẵn chỉ dẫn cũ, cho đổi máy, gói và thời hạn (58c), và có tuỳ chọn *Làm tiếp trên branch hiện có* (chỉ dẫn thêm dòng `git diff <base> <branch>` và commit WIP).
- Hub ghi `parentRun` để nối các lần giao. Trang task hiện chuỗi run của task.
- Test hub và UI, kèm bước e2e.

## 59f. auto-update-idle

App tự cài bản mới khi máy rảnh.

- Cài đặt *Tự cập nhật khi không có run* (mặc định bật với máy *Được nhận run từ hub*). Bản mới tải xong thì runner ngừng nhận run mới, chờ run đang chạy xong (tối đa theo thời hạn run), rồi thoát, cài và mở lại. Quá giờ thì giữ bản cũ và thử lại sau.
- Linux chạy từ AppImage đã giải nén (thư mục `app-<ver>` và symlink `current`, như .52): tải AppImage, giải nén thành `app-<ver>`, trỏ lại `current`, rồi khởi động lại qua systemd nếu có. Không làm được thì báo rõ ở trang *Phiên bản app*.
- Nhật ký ghi mỗi lần cập nhật. Không cập nhật khi app đang ở bản phát triển.
- Test logic (chờ run, quá giờ, giải nén vào thư mục tạm) với thư mục tạm.

## 59g. batch-tool

`scripts/review-batch.mjs` để người merge ghép một lô.

- Đầu vào: base (main), danh sách `ai/<task>`, hoặc branch lấy từ máy khác (`host:path#branch`).
- Script làm theo thứ tự: tạo worktree `review/<tên>`, merge từng nhánh. Nhánh nào xung đột thì in file và các đoạn xung đột, rồi bỏ qua. Typecheck sau mỗi merge. Cuối cùng in bảng: nhánh nào vào, nhánh nào bị bỏ qua và vì sao, mỗi nhánh tụt sau base bao nhiêu commit.
- `--gate` chạy cổng kiểm theo thứ tự (`&&`), log từng bước. `--only` truyền xuống e2e (58d).
- Script không push và không phát hành.
- Test với repo git tạm.
