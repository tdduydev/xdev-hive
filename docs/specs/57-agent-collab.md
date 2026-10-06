# 57. Làm việc cùng agent: nhắn thêm, duyệt kế hoạch, xem diff, thống kê skill, vai QA

Viết ngày 6/10. Người dùng chọn thêm 4 nhóm tính năng sau phần nghiên cứu 49, để các gói Codex có việc chạy tiếp. Nguồn tham khảo ở [49-research.md](49-research.md), mục "12 mẫu UX nên học".

Task: **R-57a** … **R-57e**.

## 57a. Nhắn thêm cho run đang chạy

GitHub Copilot cho gõ thêm chỉ dẫn vào phiên đang chạy, không cần dừng.

**Hub:**
- Method `runs.steer { machineId, runId, text }`, quyền `runDispatch`.
- Lưu bảng `run_messages(run_id, machine_id, text, by, at, delivered_at)`.
- Heartbeat của máy nhận các tin chưa gửi.

**Runner:**
- **Claude:** cách tốt nhất là chạy `claude -p` với `--input-format stream-json` và giữ stdin mở, rồi ghi thêm một user message vào stdin. Nếu CLI không hỗ trợ, thì sau lượt hiện tại ghi tin vào file `.xdev-hive/steer.md` trong worktree, và thêm vào prompt của run một dòng: "đọc .xdev-hive/steer.md sau mỗi bước". Kiểm cả hai cách, chọn cách chạy được; ghi rõ lý do chọn.
- **Codex:** `codex exec` không nhận thêm tin giữa chừng. Dùng file `steer.md` như trên, cộng `codex exec resume` nếu có.
- **Tin đã giao** hiện trong log run với loại *Người nhắn*.

**Giao diện:**
- Ô "Nhắn agent" ở trang run (*Agent đang chạy*) khi run đang chạy.
- Lịch sử tin nằm trong dòng hoạt động của run.
- Chữ vào `vi.ts` trước rồi `en.ts`.

## 57b. Duyệt kế hoạch trước khi code

Jules và Factory cho agent đưa kế hoạch trước, người duyệt rồi agent mới làm.

**Chế độ theo dự án**, chỉnh ở trang *Quy trình*, nằm cạnh chốt *Giao việc*. Có 3 mức:
- *Không*: mặc định, như hôm nay.
- *Task cỡ m/l*: dùng loại và cỡ task của 54b.
- *Mọi task*.

**Luồng:**
1. Run `implement` chạy pha kế hoạch trước, chỉ đọc. Claude dùng `--permission-mode plan`; Codex dùng `-s read-only` cùng chỉ dẫn "chỉ lập kế hoạch".
2. Kết quả của pha này là `plan.md` ngắn: việc sẽ làm, file sẽ sửa, cách kiểm, rủi ro.
3. Hub tạo mục *Chờ duyệt kế hoạch* ở *Hôm nay*.
4. Bấm **Duyệt** thì chạy pha làm, với kế hoạch nằm trong prompt. Bấm **Sửa kế hoạch** thì gửi ghi chú để agent lập lại. Hết thời gian chờ (tuỳ chọn, ví dụ 2 giờ) thì tự duyệt.

**Lưu kế hoạch** trong run record hoặc artifact (41c). Khung task có tab *Kế hoạch*.

## 57c. Xem diff trong Hive

Devin Review và GitHub cho đọc log phiên trước, diff sau.

**Máy:**
- Khi run xong, máy đã gửi `patch`. Tạo thêm bản tóm tắt diff: các nhóm thay đổi theo ý (file liên quan đặt cạnh nhau), mỗi nhóm một câu giải thích.
- Tóm tắt do một run review nhỏ tạo, dùng model rẻ của 54c (cấp `light`).
- Cờ rủi ro, có mức *cao / vừa / thấp*: migration, quyền, bảo mật, xoá dữ liệu, file lớn.

**Trang run:**
- Tab **Diff** dùng component `Diff` có sẵn, chia theo nhóm, có giải thích và cờ.
- Bấm vào cờ thì nhảy tới hunk.
- Nút *Yêu cầu sửa* gắn với từng hunk. Ghi chú gom lại thành chỉ dẫn cho lượt sửa (34c).

## 57d. Thống kê skill

- **Runner ghi skill nào được nạp trong run.** Claude: đọc trong `stream-json` các lần đọc `SKILL.md` hay gọi `skill_get`. Codex: gọi `skill_get` qua MCP. Lưu `run_records.skills` (JSON danh sách tên).
- **Trang Skill có cột** *Số run dùng 30 ngày* và *Lần dùng cuối*. Lọc được *Skill không ai dùng*.
- **Mỗi skill có biểu đồ nhỏ** số run theo tuần. Dùng skill `dataviz` có sẵn của nhóm nếu áp dụng được; không thì làm biểu đồ thanh đơn giản theo token.

## 57e. Vai QA

**Quyền:**
- Thêm quyền `qaVerify`: đánh dấu tiêu chí đã kiểm ở tab *Kiểm thử* của trang Tính năng (49d), và cho qua một chốt mới *Kiểm thử* trước *Merge*.
- Chốt *Kiểm thử* thêm vào `SDLC_GATES`, mặc định *Tự động*, để không đổi hành vi cũ.
- Vai dự án mới **QA** gồm `view`, `qaVerify`, `codeReview` (chỉ đọc diff).

**Trang Quy trình** hiện chốt mới; bộ cài sẵn *Thận trọng* đặt chốt này thành *Người duyệt*.

**Hôm nay của QA:** nhóm *Cần bạn kiểm thử*.

## 31c, 31d: hoàn thiện

Người dùng chọn làm cả hai.
- **31c map-reduce:** phần hub đã có (`runs.mapReduce`, `#mapStep`, commit 633f138 và 2d345de). Người làm kiểm hiện trạng so với docs/specs/31-agent-map.md, làm nốt giao diện (đợt chạy loại *Chia rồi gộp*, xem phần con, run gộp) và e2e.
- **31d chuỗi vai:** loại đợt chạy `roles` đã có trong `RUN_GROUP_KINDS`. Kiểm hiện trạng, làm nốt cho đủ:
  - chuỗi vai trên cùng task và branch: viết code → viết test → review, mỗi vai một gói, chạy lần lượt;
  - chọn gói cho từng vai, với gợi ý của 54c;
  - vai sau đọc bàn giao của vai trước.

## Chung

- Mỗi mục có test hub/desktop/UI và một bước e2e (desktop, mobile).
- Rà giao diện bằng skill `ui-ux-pro-max`.
- Không tăng version, không đánh dấu roadmap.
