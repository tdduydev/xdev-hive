# Giao diện mới theo tính năng Hive

Yêu cầu 08/10: bỏ mẫu `gia-dien-moi.zip`, tự thiết kế giao diện mới theo danh sách tính năng. File ZIP đã chuyển vào Thùng rác của máy, không dùng làm tham chiếu. `prototype.html` là bản thiết kế minh hoạ. Triển khai web nằm trong WorkspaceHome/WorkspaceAcceptance và khung ClientShell, dùng API và quyền thật.

Mở `prototype.html` bằng trình duyệt. HTML chứa token màu/chữ/khoảng cách hiện hành để mở độc lập; không cần server hoặc mạng. Có 10 trang chính và trang chi tiết công việc, chế độ sáng/tối, điều hướng mobile, bộ lọc công việc, hội thoại minh hoạ và hộp giải thích hành động. Dữ liệu, phiên bản và bằng chứng trong màn hình đều là minh hoạ. Fonts hiện dùng fallback hệ thống khi mở độc lập; triển khai phải dùng font tự host hiện có của app.

## Hướng thiết kế

Hôm nay là nơi biết việc cần quyết định và tiến độ. Công việc là đơn vị ngữ cảnh xuyên suốt: ý tưởng → kế hoạch → thực hiện → nghiệm thu → phát hành. Mỗi màn có một mục tiêu và hành động tiếp theo rõ ràng. Phần vận hành và quản trị nằm dưới phần làm việc; người dùng chỉ thấy mục họ có quyền truy cập.

Khác biệt trọng tâm so với bản shell trước là bố cục nội dung và hành động của từng trang: inbox quyết định, tiến độ theo giai đoạn, chi tiết công việc gom ngữ cảnh, nghiệm thu đặt tiêu chí cạnh bằng chứng, phát hành hiện điều kiện và trạng thái rollout. Giữ design tokens để đồng bộ thương hiệu; thay kiến trúc thông tin và cách trình bày.

## Ánh xạ tính năng vào giao diện

| Màn | Tính năng có lối vào | Hành động chính |
| --- | --- | --- |
| Hôm nay | Việc cần duyệt, bị kẹt, đang chạy, hoạt động mới | Mở quyết định hoặc giao việc |
| Công việc | Tasks, board, queue, dependencies, blocker/retry | Mở chi tiết hoặc tháo gỡ |
| Chi tiết công việc | Mục tiêu, tiêu chí, task/run, máy/model, log/diff, SHA, chi phí, artifact, terminal | Theo dõi và mở nghiệm thu |
| Chat | Trao đổi, đề xuất kế hoạch/spec/task, duyệt/từ chối | Chốt kế hoạch trước thực thi |
| Nghiệm thu & phát hành | Evidence, tiêu chí, preview theo SHA, review, merge queue/batches, release approval/rollout/rollback | Chấp thuận hoặc yêu cầu sửa |
| Dự án & tính năng | Systems/projects, feature catalog, specs, graph/dependencies, repo/tools, onboarding | Tạo dự án đến task đầu tiên |
| Kiến thức | Docs/editor, memory, skills, proposals, phiên bản và diff | Đọc, sửa, đề xuất và duyệt |
| Lịch sử | Timeline, audit, tìm kiếm task/run/chat/gate/artifact | Tìm sự kiện và mở đúng ngữ cảnh |
| Máy & agent | Machines, agents, quota, setup, tool status, terminal, chất lượng model/agent, tokens/cost | Xử lý khả năng nhận việc |
| Automation | Trigger/condition/action, dry-run, pause, dedupe, retry, audit | Tạo và kiểm quy tắc |
| Quản trị | Thành viên/quyền, agent policy/model routing, budgets, SDLC gates, repo/MCP/plugins/webhooks, alerts, backups, versions | Cấu hình theo phạm vi quyền |

Bảng là cam kết vị trí tính năng cho triển khai; prototype hiện mô phỏng các màn chính, các cấu hình chi tiết mở hộp giải thích, chưa phải toàn bộ màn con.

## Desktop và điện thoại

Desktop dùng sidebar cố định, nội dung chính và cột ngữ cảnh. Mobile dùng một cột, thanh 5 mục Hôm nay/Công việc/Chat/Nghiệm thu/Menu; drawer chứa toàn bộ phần còn lại. Công việc trên mobile thành nhóm dọc thay vì board kéo ngang. Input 16px, nút tối thiểu 44px, safe-area và focus hiển thị. Desktop hub giữ giới hạn chỉ việc của máy theo convention hiện hành; prototype hiện tập trung web đầy đủ. Khi triển khai cần bố cục riêng cho desktop hub, local mode và quyền thành viên/admin.

## Kiểm tra

Đã render bằng Electron Chromium 11 trang × 2 kích thước (1440 và 390px) × 2 theme: 44 lượt, không tràn ngang, không lỗi JavaScript. 8 ảnh Hôm nay/Nghiệm thu ở `/tmp/hive-ux71-*.png`; kết quả `/tmp/hive-ux71-check.json`. Đây là kiểm bố cục prototype, không chứng minh chức năng backend, toàn bộ accessibility hay nghiệm thu production. Không sửa runtime nên không chạy suite ứng dụng.

## Triển khai tiếp

Dùng các trang hiện có và API thật; tái cấu trúc từng trang theo bố cục này, không thay backend chỉ vì đổi giao diện. Bổ sung loading/empty/error/permission states, vi/en, font và icon SVG hiện có. Kiểm keyboard/drawer/dialog, dữ liệu thật, preview gắn SHA, approval/retry/release theo quyền; chụp trước/sau từng trang sáng/tối desktop/mobile. Chỉ báo giao diện lên web sau khi đã kiểm bản deploy bằng thao tác và ảnh production.


## Triển khai web

Hôm nay chuyển từ danh sách/chi tiết mặc định thành dashboard quyết định và tiến độ, các thẻ mở inbox/công việc/lượt chạy thật. Inbox cũ giữ đầy đủ hành động ở `#/today?section=inbox`; deep link `item` mở đúng mục. Nghiệm thu gom review/gate/lỗi release và hàng đợi phát hành, quy trình/model giữ ở tab riêng; link pipeline có `project` vẫn vào cấu hình. Menu theo thứ tự công việc, kiến thức, vận hành; bố cục Page/Card/spacing được áp dụng cho web, desktop giữ hành vi cũ.

Đã tích hợp main mới có Lịch sử, trung tâm việc bị kẹt, chất lượng model/agent, bằng chứng nghiệm thu và engine automation. Menu giữ Lịch sử trong nhóm Không gian; các tính năng mới giữ nguyên logic và quyền. Engine automation chưa có trang cấu hình quy tắc riêng trong bản UI này. Các màn nghiệp vụ con giữ logic hiện có; không phải mọi ô minh hoạ của prototype đã được chuyển thành chức năng mới.

Kiểm trên bản production build với hub fixture: typecheck đạt; e2e desktop 6/6 và mobile 6/6, gồm số liệu dashboard so với API, mở inbox/back, tab cấu hình, responsive pages sáng/tối, menu và overlays. Mobile không overflow, không input/target nhỏ hay tên truy cập thiếu trong bộ audit. Ảnh runtime `previews/runtime-home-{desktop,mobile}.png`. Kết quả đầy đủ ở `/tmp/ux71-web-final` và `/tmp/ux71-mobile`. Bộ test toàn repo và kiểm quyền menu được ghi trong bàn giao task sau khi kết thúc.
