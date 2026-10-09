# Rà soát task theo kiến trúc mới (76 + 77), ngày 9/10

Người dùng hỏi: "rà soát task lại ý, xem cái nào merge, cái nào bỏ được, và nó phù hợp với kiến trúc mới không."

**Trạng thái: nháp, chờ người dùng duyệt.** Chưa đổi task nào, chưa xoá nhánh nào. Dự án xdev-hive vẫn đang tạm dừng.

Kiến trúc mới dùng để so ([76](76-access-first.md), [77](77-client-perf.md)):

- **Web**: gồm khu Không gian làm việc và khu Quản trị. Các trang chuyển về `apps/web/client` ở bước 76h.
- **App**: chỉ là bảng điều khiển việc của chính máy đó. Chế độ cục bộ chạy hub nhúng (76i).
- **Làm trước**: phân quyền (76a–f). Tối ưu (77) làm song song: TanStack Query, SSE, cache IndexedDB.

Số liệu trên hub: 392 task, trong đó 22 todo, 16 review, 4 blocked, còn lại đã xong.

## 1. Merge: hợp kiến trúc mới

Các trang của roadmap 72 nằm trong `packages/ui` và sau này sẽ thành trang web. Đổi giao diện ngay bây giờ không lãng phí: ở bước 76h, các trang này chỉ chuyển thư mục, không phải viết lại.

**Lô 1, nhánh `review/0149`** (R-71a, R-72a, R-72b, R-72c, R-72g, R-72h):

| Task | Trạng thái | Việc còn lại |
|---|---|---|
| INT-0149 | review | Gộp INT-0148 và sửa 3 bước e2e (đã giao trước khi dừng). Sau đó chạy đủ cổng kiểm, merge, deploy hub. |
| R-71a cli-leader-tools | review | Merge cùng lô. Danh sách quyền MCP riêng mà R-71a thêm phải được đưa vào 76b. |
| R-72a tokens, R-72b shell, R-72c today, R-72g machines, R-72h chat | review | Merge cùng lô. R-72a sẽ trở thành ui-kit ở 76g. R-72b là shell của web. |

**Lô 2** (đã duyệt, hoặc còn sửa nhỏ):

| Task | Trạng thái | Việc còn lại |
|---|---|---|
| R-72i, R-72k, R-72l, R-72l-users, R-72l-org-policy, R-72g-accept, R-72j-artifacts | done, nhưng **chưa merge** | Merge vào lô 2. R-72l-users phải có trước R-76c (phòng ban). |
| R-72f docs, R-72l-tables-settings | review | Review ảnh rồi merge. |
| R-72d tasks, R-72j knowledge, R-72i-prompt | review, đã gửi danh sách sửa | Sửa theo danh sách đã gửi. R-72j phải hoàn lại 2 màu tối về đúng thiết kế. |
| R-72d-progress | blocked do hàng ghép tự động | Mở lại, cho vào lô 2 cùng R-72d. |
| R-72e runs, R-72m terminal-start, R-72c-actions | todo, đang làm dở | Chạy tiếp từ nhánh. R-72m chỉ làm phần web (Terminal và Bắt đầu); màn đăng nhập lần đầu của app làm lại ở 76h. |
| R-72g-system | todo | Chạy tiếp. Phải thu CPU/RAM/ổ đĩa trên timer riêng, không chặn heartbeat (cùng hướng với 77b). |
| R-72n e2e-screens | todo | Chạy sau khi lô 2 xong. Đây là cổng đóng roadmap 72. |

**Roadmap 73**: cả ba nhánh hợp hướng "máy chỉ để chạy". Danh sách sửa đã gửi; chúng nằm trên Mac nhưng đang dừng.

| Task | Việc còn lại |
|---|---|
| R-73b platform-routing | Sửa theo danh sách. Phần ẩn `task_create` theo quyền khớp với 76b. |
| R-73c ephemeral-worktree | Sửa theo danh sách. |
| R-73f release-split | Thu gọn: giữ luật đường dẫn, không tính riêng lần bump version, giữ đường chỉ deploy hub. Bỏ phần phân loại `packages/ui`/`core` thật chính xác, vì sau 76h app không còn bundle trang web nên việc phân loại tự đơn giản. |
| R-71b, R-71c | Giữ; làm sau khi R-71a merge. |

Ngoài ra **BUG-runner-52-git-ro-deps** (review, nhánh nằm trên .52) vẫn hợp kiến trúc mới. Cần review trước khi merge.

## 2. Bỏ: đã có mục mới thay thế

| Task | Lý do | Thay bằng |
|---|---|---|
| R-73d app-runner-console | Gộp vào việc tách hai shell | R-76h |
| R-73e admin-area | Gộp vào nhóm Quản trị mới. Nhánh có 13 file (`4ba8d963`); R-76f đọc lại nhánh này nếu có phần dùng được. | R-76f |
| BUG-heartbeat-stall | Đúng phạm vi của 77b (heartbeat chạy timer riêng). Nhánh có WIP 2 file (`48bd7c02`) làm đầu vào. | R-77b |
| BUG-cli-approve-local | Lỗi chỉ xảy ra ở chế độ cục bộ không có web. Khi app chạy hub nhúng thì duyệt ngay trong giao diện web của hub đó. | R-76i |
| INT-main-e2e | Sửa e2e cho giao diện cũ (58/188 bước lỗi ở 08a7669b). Lô 72 viết lại phần lớn các bước này. | Sau khi lô 2 merge, chạy đủ e2e một lần và tạo INT mới cho những bước còn đỏ |
| INT-0148 | Đã gộp vào INT-0149 | INT-0149 |

"Bỏ" nghĩa là chuyển task sang done kèm ghi chú "thay bằng …". Nhánh của task được giữ lại.

## 3. Giữ, không đổi

| Task | Lý do |
|---|---|
| QA-7, QA-9 (kiểm trên máy Windows và Linux thật) | Hợp với 73b. Máy Windows hc-duytd20 đã online, nên QA-9 làm được ngay khi bật lại. |
| R-69i1, R-69i2 (operator adapter) | Nghiên cứu, không vướng kiến trúc mới. Giữ blocked, ưu tiên thấp. |
| R-76a–i | Mới tạo, đúng kiến trúc mới. |
| R-77a–i | Tạo sau khi duyệt bản này. |

## 4. Dọn nhánh cũ

Có 53 nhánh `ai/*` từ ngày 5 đến 8/10 (INT-01xx, LAND-01xx, R-31c…R-65b, A11Y-*, BUG-*, DEPS-update). Task của chúng đều đã done.

- [Inference: dựa trên ghi chú của các task LAND/INT và mục roadmap đã đánh dấu, chưa so từng dòng] Nội dung đã vào main bằng diff hoặc cherry-pick, nên lịch sử khác với main và `git merge-tree` báo xung đột.
- Riêng `ai/R-69f` đã nằm sẵn trong main.

Đề xuất **lưu trữ chứ không xoá**: chuyển các nhánh này sang `refs/archive/ai/*` trên Mac. Cần lấy lại thì chạy một lệnh `git update-ref` là xong. Việc này làm danh sách nhánh gọn lại, và hàng ghép tự động hay autopilot không nhặt nhầm nhánh cũ.

## 5. Thứ tự khi bật lại (đề xuất)

1. **Ra giao diện mới**: INT-0149 → cổng kiểm → merge lô 1 → deploy hub. Sau đó lô 2, rồi R-72n. Khi đó R-72l-users đã có trong main, mở đường cho 76c.
2. **Song song, vì khác file**: 76a (vá quyền P0) và 77a, 77c, 77d (main process của app: log, timeout, dò CLI). Riêng 77b (heartbeat) phải chờ R-72g-system merge, vì hai việc cùng sửa heartbeat.
3. Sau lô 2: 76b → 76c, 76d, 76e → 76f. Cùng lúc làm 77e, 77f, rồi 77g và 77i.
4. Sau R-72n: 76g → 76h (cùng 77h) → 76i.

Giới hạn máy:
- Mac mini chạy tối đa 3 run cùng lúc.
- .52 không chạy cổng kiểm. Hôm 9/10 nó hết RAM khi chạy build.
- Tắt hàng ghép tự động trong lúc làm roadmap 72, để nó không tự tạo LAND cho task con (câu hỏi Q3).

## 6. Cần bạn duyệt

- **Q1.** Đồng ý bỏ 6 task ở mục 2 không?
- **Q2.** Đồng ý lưu trữ 53 nhánh cũ sang `refs/archive/` không?
- **Q3.** Tắt hàng ghép tự động (merge queue) cho tới khi roadmap 72 xong không?
- **Q4.** Bật lại theo thứ tự ở mục 5 không?
