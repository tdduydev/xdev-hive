# 0027. Extension VS Code

- Status: Withdrawn (2026-10-23: chủ dự án bỏ extension VS Code; `apps/vscode` và spec 017 đã xoá, còn trong lịch sử Git)
- Date: 2026-10-15
- Deciders: product owner (tdduydev), maintainers

## Bối cảnh

Dev cần giao việc, theo dõi run, duyệt tài liệu và review code ngay trong editor, dùng chung hub, worker và dữ liệu
với web, desktop và CLI. [Spec 017](../../specs/017-vscode-extension/spec.md) mô tả tích hợp mức 2; thiết kế ở
[plan.md](../../specs/017-vscode-extension/plan.md), cơ sở lựa chọn ở
[research.md mục 5](../../specs/017-vscode-extension/research.md#5-quyết-định-rút-ra). Yêu cầu được ánh xạ trong
[SRS mục 3.22](../srs.md#322-vs-code-extension-vsc).

Chủ dự án đã chốt Q1–Q9 ngày 2026-10-15. Trạng thái Accepted ghi nhận quyết định kiến trúc, không khẳng định các tính
năng đã triển khai hay các API của editor fork đã được kiểm thật.

## Quyết định

### Các câu hỏi đã chốt

| Câu hỏi | Quyết định |
|---|---|
| Q1 — Phát hành | Công khai trên VS Code Marketplace và Open VSX ngay từ bản đầu; editor tự cập nhật. Không có giai đoạn nội bộ trước hay kênh VSIX do hub phát. T027, T028 được bỏ; T029 phụ trách CI, T036 và T037 chuẩn bị phát hành. |
| Q2 — Danh tính | Publisher/namespace `xdev`, tên hiển thị “xDev Hive”, ID `xdev.xdev-hive`. T036 do chủ dự án kiểm tên còn trống và giữ tài khoản; nếu tên đã bị giữ, chủ dự án chọn tên thay thế trước khi ghi manifest. |
| Q3 — Binary | Tải `hive` và `hive-worker` khi cần, kiểm chữ ký ECDSA và sha256 theo ADR 0011, dùng chung `~/.xdev-hive/bin/` với desktop. Một VSIX chung, không gói binary theo nền tảng. |
| Q4 — Tự chạy worker | Có khi người dùng bật `xdevHive.worker.autoStart`, mặc định tắt. Worker sống theo cửa sổ giữ khoá; máy đã có desktop thì dùng worker đang chạy của desktop. |
| Q5 — Bình luận PR | Đồng bộ hai chiều bình luận theo dòng, trả lời, sửa, xoá, xử lý và mở lại luồng với PR GitHub/MR GitLab. Dùng kết nối Git của dự án và module `scm`, không xin OAuth nhà cung cấp riêng cho từng người. |
| Q6 — Remote | SSH/WSL là máy Hive riêng, đăng ký riêng, worker chạy ở máy có mã nguồn. Dev Container và vscode.dev không chạy worker; vscode.dev nằm ngoài phạm vi bản đầu. |
| Q7 — Engine | VS Code tối thiểu `^1.101.0`, dùng API chính thức, không proposed API. Fork có engine thấp hơn không cài được. |
| Q8 — Telemetry | Không thu telemetry. Chỉ ghi log tại máy đã che bí mật, công bố trong chính sách quyền riêng tư. |
| Q9 — Token | Bản đầu dùng luồng `purpose=cli` sẵn có. Nhãn token riêng `xdev-hive-vscode` để sau ở T030 (P3). |

### Ranh giới triển khai (research.md mục 5)

1. **Extension host và webview tách nhau.** `apps/vscode` dùng TypeScript, esbuild dựng CommonJS cho Node và ESM
   cho webview React. `extensionKind: ["workspace"]` đặt logic gần git, file và worker. Webview dùng lại các package
   UI của repo; chỉ chuyển yêu cầu qua `postMessage`. Extension host kiểm danh sách thủ tục được phép, gọi oRPC theo
   contracts và giữ token. Webview không có token, CSP đặt `connect-src 'none'`, không gọi thẳng hub.
2. **Đăng nhập dùng chung.** Authentication Provider `xdev-hive` đi qua PKCE S256 loopback của `hive login`, dùng
   `env.asExternalUri` trên Remote. `hive auth` (Go) làm cầu nối keychain dùng chung desktop/CLI; thiếu binary thì dùng
   `SecretStorage`. Không thêm module native Node. Luồng `purpose=cli` không cần đổi schema hub chỉ để đăng nhập IDE.
3. **MCP không ghi token vào cấu hình.** VS Code dùng MCP provider chính thức từ engine 1.101; gắn bearer khi resolve.
   Công cụ ngoài dùng proxy stdio `hive mcp` sang streamable HTTP. Chỉ ghi cấu hình khi người dùng đồng ý từng công
   cụ, ghi nguyên tử, sao lưu và theo dõi mục đã thêm để gỡ đúng mục. Cursor/Windsurf phải dò khả năng lúc chạy; API
   MCP riêng và đường dẫn cấu hình còn chờ spike T002. Thiếu Chat/LM thì mở webview chat gọi Leader của hub.
4. **Artifact ở webview riêng.** Lấy tài liệu qua `artifacts.frameDocument`, thư viện từ bộ đệm tại máy, áp CSP cách ly
   của ADR 0023; tắt command URI và form, chỉ nhận thông điệp theo lược đồ artifact. Không nhúng iframe tới hub HTTP:
   nguy cơ mixed content còn chờ kiểm ở T002.
5. **Một worker trên mỗi máy.** Hỏi op `worker.status` qua socket/named pipe đã kiểm danh tính, không suy trạng thái
   bằng pid hay thử khoá. Khoá worker hiện có phân xử nhiều cửa sổ; mã thoát 4 nghĩa là đã có worker khác. Chỉ tự chạy
   khi autoStart bật, máy đã đăng ký và workspace tin cậy; không dừng worker do desktop hay cửa sổ khác chạy.
6. **Phát hành công khai có kiểm soát.** CI đóng gói cùng một VSIX để đăng hai chợ trên tag `vscode-v*`, đính vào GitHub
   Release cho cài tay. PAT chỉ ở secret của environment `vscode-publish`, có người duyệt, hạn tối đa 90 ngày và chỉ
   quyền publish cần thiết. Gói có README, CHANGELOG, icon, LICENSE, PRIVACY và walkthrough; CI kiểm không có test,
   source map, `.env*` hay token. Thiếu secret làm job publish lỗi. Giấy phép proprietary trong FR-052 vẫn là giả định,
   văn bản phải được chủ dự án duyệt ở T037.
7. **Đồng bộ PR dùng hạ tầng hub hiện có.** `scm` mở rộng GitProvider và webhook cho GitHub/GitLab/MemoryProvider;
   provider local báo không hỗ trợ. `codereview` sở hữu bình luận, bảng liên kết và job pg-boss. Bảng tenant mới bật và
   ép RLS; truy vấn qua `withTenant()`, thao tác ghi có audit. Ai xem được review được bình luận; chỉ tác giả sửa/xoá
   bình luận nguồn Hive. Đẩy ra dưới danh tính kết nối Git và ghi tên người Hive trong thân; nhận về giữ login và nhãn
   nhà cung cấp, không tự ghép với người Hive. Đồng bộ này không bao gồm quyết định Approve/Request changes.
8. **Đồng bộ phải chịu được giao lại và mất webhook.** Ánh xạ `{path, line, side, headSha}` tới vị trí nhà cung cấp;
   ngoài diff thì rơi về bình luận chung kèm `path:line@sha`. Bảng liên kết có khoá duy nhất theo kết nối/id bình luận;
   dấu ẩn `<!-- xdev-hive:c=<id> -->` nhận ra webhook về trước API. Chỉ tin dấu khi tác giả là tài khoản kết nối và id
   thuộc bình luận pending của cùng PR. Bình luận nguồn ngoài không đẩy ngược; so hash và thời điểm để bỏ sự kiện lặp.
   Bản sửa muộn hơn thắng, xoá thắng sửa. Job gom theo PR, tôn trọng `retryAfterMs`, retry có backoff và đối chiếu mỗi
   10 phút. Giao diện hiện pending/synced/fallback/failed/disabled và cho tác giả thử lại. Cài đặt dự án
   `features.prCommentSync` mặc định bật khi kết nối đủ quyền; thiếu quyền vẫn lưu bình luận ở hub và hiện lý do.

## Hệ quả

- Dùng chung phiên đăng nhập, dữ liệu review, UI và binary với hệ thống hiện có; phần tại máy chạy được khi chưa có
  hub hay đăng nhập. View hub có trạng thái chưa cấu hình và hướng dẫn nhập URL.
- Không có module native trong VSIX; đổi lại phải quản lý việc tìm, tải và kiểm chữ ký binary ở đúng máy (kể cả Remote).
- Đồng bộ PR cần job, liên kết bền vững, kiểm quyền kết nối và kiểm thử giao lại/race; không thể chỉ thêm UI bình luận.
- Restricted Mode phải chặn chạy worker, terminal, ghi MCP và hành động giao việc. Model chỉ soạn đề xuất; mọi hành
  động ghi trong chat cần người dùng bấm xác nhận. Nội dung gửi model/hub phải che bí mật và bỏ file bị loại trừ.
- Cursor/Windsurf, callback Remote, CSP Shiki/Mermaid và khả năng đọc chéo keychain còn cần T002/T004 kiểm thật.
  Không nâng các nhãn “Chưa kiểm” trong research thành bảo đảm tương thích. Các chi tiết chưa được chủ dự án chốt
  (như hạn mức 30 lời gọi ghi/phút và giấy phép) giữ nhãn giả định theo spec.

## Phương án đã cân nhắc

| Phương án | Lý do không chọn |
|---|---|
| Engine 1.90 | Thiếu MCP provider chính thức, không đáp ứng tích hợp bản đầu. |
| Thêm `purpose=ide` ngay | Cần migration/token riêng khi luồng CLI đáp ứng bản đầu; để T030. |
| Đọc keychain bằng module native Node | Tăng gánh build theo nền tảng; dùng `hive auth` chung với CLI. |
| Header bearer trong file MCP | Lộ token chữ thường; chọn stdio proxy. |
| Webview gọi hub trực tiếp | Đưa token vào webview và phải nới CSP; chọn cầu nối có danh sách cho phép. |
| Iframe tới hub cho artifact | Có nguy cơ mixed content với hub HTTP; chọn tài liệu artifact trong panel riêng. |
| Đọc pid/thử khoá để biết worker | Không biết ai giữ worker hay trạng thái kết nối; chọn op socket. |
| VSIX kèm binary từng nền tảng | Tăng số gói và trùng binary desktop; Q3 chọn tải khi cần có kiểm chữ ký. |
| Phát VSIX nội bộ trước | Q1 đã chốt công khai ngay; editor đảm nhiệm cập nhật từ chợ. |
| Chỉ lưu bình luận ở hub hoặc OAuth Git từng người | Q5 yêu cầu hai chiều, dùng lại kết nối Git dự án. |

## Tham chiếu

- [Spec 017: câu hỏi đã chốt và FR-001…FR-052](../../specs/017-vscode-extension/spec.md).
- [Plan 017](../../specs/017-vscode-extension/plan.md), [research 017](../../specs/017-vscode-extension/research.md),
  [tasks 017](../../specs/017-vscode-extension/tasks.md).
- [ADR 0011: phát hành worker](0011-signed-worker-releases-and-own-updater.md), [ADR 0023: artifact](0023-artifacts.md).
