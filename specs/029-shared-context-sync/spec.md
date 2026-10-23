# Feature Specification: Ngữ cảnh dùng chung, đồng bộ dự án và nút "Tối ưu"

**Feature Branch**: `029-shared-context-sync` (nhánh tại máy `ai/SPEC029`)

**Created**: 2026-10-22

**Status**: Đã cài phần lớn. Chủ dự án chốt D1–D6 ngày 2026-10-22 (bảng Quyết định). Có [plan.md](plan.md). Còn lại: T001 và T027 (người làm), công tắc gửi số liệu và nút xoá trên desktop (T024), kind "đề xuất skill" của hàng đợi; xem [tasks.md](tasks.md).

**Input**: Chủ dự án (2026-10-22): nghiên cứu cách tối ưu token, bộ nhớ và ngữ cảnh dùng chung trên một máy; đồng bộ
nhiều máy cho nhiều người trong dự án; có nút tối ưu các phần này.

Bối cảnh (khảo sát code trên `origin/main` tại `9b484526`, ngày 2026-10-22):
- Spec [015](../015-client-token-optimizer/spec.md) đã có bộ tối ưu theo gói CLI (Claude `settings.json`, Codex
  `config.toml`), báo cáo token trước/sau, màn Memory (quét, gộp, nén bằng AI, gửi lên hub).
- Spec [025](../025-token-score/spec.md) đã có điểm tối ưu 0–100 theo gói và theo máy, nút sửa nhanh từng tiêu chí có xem
  trước và hoàn tác, gửi điểm lên hub (người dùng tự bật).
- Chỗ hở:
  - Memory chỉ dùng chung giữa các gói **Claude** của một dự án trên một máy (`memstore/shared.go`). `AGENTS.md` của
    Codex, `GEMINI.md`, rules của Antigravity tách riêng; Antigravity chưa được quét.
  - Đồng bộ với hub chỉ một chiều và làm tay: gửi từng file lên làm memory `pending`. Không có gì kéo từ hub về máy.
  - Thiết lập tối ưu chỉ nằm trên từng máy; quản trị không đặt được chính sách chung cho dự án.
  - Gửi lên hub hỏng khi mất mạng (outbox của spec [027](../027-hub-client-model/plan.md) chưa làm).
  - Không có nút nào chạy cả chuỗi tối ưu. FR-012 của spec 025 cấm nút một chạm sửa CLAUDE.md/AGENTS.md/memory.

## Quyết định của chủ dự án (2026-10-22)

| # | Câu hỏi | Đã chốt | Phương án đã bỏ |
|---|---|---|---|
| D1 | Dùng chung ngữ cảnh giữa các CLI trên một máy thế nào? | **Một nguồn mỗi dự án**, app desktop sinh vào file ngữ cảnh của từng CLI trong một **khối có đánh dấu**, không đụng chữ người dùng tự viết. Thay cho cách chia sẻ chỉ giữa các gói Claude | Mở rộng cách chia sẻ hiện có bằng dòng import; bỏ qua phần này |
| D2 | Đồng bộ nhiều máy, nhiều người tới đâu? | **Đủ bốn phần**: kéo memory đã duyệt về máy; chính sách tối ưu của dự án; hàng đợi ngoại tuyến; báo cáo token chung (chỉ số liệu) | Chọn một phần |
| D3 | Nút "Tối ưu" làm gì? | **Xem trước rồi áp dụng tất cả**: một danh sách thay đổi, xác nhận một lần, hoàn tác một lần cho cả gói | Chỉ phần an toàn; ba nút riêng |
| D4 | Nút có được ghi CLAUDE.md/AGENTS.md/memory? | **Có, nhưng chỉ trong khối do xDev Hive đánh dấu.** Nén bằng AI vẫn duyệt từng file. Đây là thay đổi FR-012 của spec 025 | Giữ nguyên FR-012 |
| D5 | Ghi khối vào file trong repo hay file cục bộ? | **File cục bộ, không theo dõi bằng git** (vd. `CLAUDE.local.md`), để không làm bẩn repo và không đẩy ngữ cảnh máy này cho cả đội. CLI không có file cục bộ thì app thêm file đích vào git exclude của repo | Ghi vào file trong repo; hỏi từng dự án |
| D6 | Gộp chính sách tối ưu dự án với `tokenSaving`? | **Tách riêng.** `tokenSaving` giữ nguyên, chỉ áp cho run hub; chính sách mới chỉ áp cho máy dev | Gộp một chỗ cấu hình |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Một ngữ cảnh cho mọi CLI trên máy (Priority: P1)

Lập trình viên dùng cả Claude Code, Codex và Antigravity trên một dự án. Họ soạn ngữ cảnh dự án (quy ước, lệnh test,
kiến trúc tóm tắt) **một lần** trên màn Memory. App ghi nội dung đó vào file ngữ cảnh mà từng CLI tự đọc, trong một khối
có đánh dấu. Phần chữ người dùng tự viết trong các file đó giữ nguyên. Sửa nguồn thì mọi file đích cập nhật theo.

**Why this priority**: Đây là nền cho mọi phần còn lại: memory kéo từ hub và nút "Tối ưu" đều ghi vào khối này. Riêng nó
đã bỏ được việc chép tay cùng một nội dung sang ba bốn file và làm token đọc ngữ cảnh đều nhau giữa các CLI.

**Independent Test**: Trên một máy chưa đăng nhập hub, bật ngữ cảnh dùng chung cho một dự án có sẵn CLAUDE.md tự viết,
sửa nguồn, rồi kiểm từng file đích có đúng khối mới và giữ nguyên phần tự viết.

**Acceptance Scenarios**:

1. **Given** dự án có CLAUDE.md do người dùng viết và chưa có AGENTS.md, **When** người dùng bật ngữ cảnh dùng chung,
   **Then** CLAUDE.md có thêm một khối đánh dấu chứa nội dung nguồn, phần cũ giữ nguyên từng byte; AGENTS.md được tạo
   chỉ có khối đó.
2. **Given** ngữ cảnh dùng chung đã bật, **When** người dùng sửa nguồn và lưu, **Then** khối trong mọi file đích đổi theo
   trong vòng 5 giây, ngoài khối không đổi.
3. **Given** người dùng sửa tay bên trong khối của một file đích, **When** app đồng bộ lần sau, **Then** app không ghi đè
   mà báo xung đột, cho chọn giữ bản file hay bản nguồn.
4. **Given** người dùng tắt ngữ cảnh dùng chung, **When** xác nhận, **Then** khối bị gỡ khỏi mọi file đích; file nào app
   tạo ra mà chỉ có khối thì bị xoá (vào thùng rác của app, khôi phục được).
5. **Given** dự án đang dùng cách chia sẻ memory Claude cũ (spec 015), **When** người dùng bật ngữ cảnh dùng chung,
   **Then** app đề nghị chuyển nội dung memory dùng chung cũ vào nguồn mới và tắt cách cũ, có xem trước.

---

### User Story 2 - Nút "Tối ưu" cả máy (Priority: P1)

Người dùng bấm một nút "Tối ưu" ở màn Token. App liệt kê mọi thay đổi sẽ làm: bật bộ tối ưu cho từng gói CLI còn tắt,
các sửa nhanh an toàn của thang điểm, cập nhật khối ngữ cảnh (nguồn chung và memory kéo từ hub nếu có), rồi tính lại
điểm. Người dùng bỏ chọn được từng dòng, xác nhận một lần. Sau đó thấy điểm trước/sau và một nút hoàn tác cả gói.

**Why this priority**: Đây là thứ người dùng thấy và bấm. Các phần đã có (015, 025) đang rải ở nhiều chỗ; nút này gom lại
thành một việc.

**Independent Test**: Trên máy có hai gói Claude chưa tối ưu và một gói Codex, bấm "Tối ưu", kiểm danh sách xem trước,
áp dụng, kiểm điểm tăng, rồi hoàn tác và kiểm mọi file cấu hình trở về như trước.

**Acceptance Scenarios**:

1. **Given** máy có gói chưa tối ưu, **When** người dùng bấm "Tối ưu", **Then** app hiện danh sách thay đổi theo nhóm
   (cấu hình CLI, công cụ, ngữ cảnh), mỗi dòng ghi file hay mục sẽ đổi; chưa có gì bị ghi.
2. **Given** danh sách xem trước, **When** người dùng bỏ chọn một dòng rồi xác nhận, **Then** chỉ các dòng còn chọn được
   áp dụng; kết quả hiện điểm trước, điểm sau và từng dòng thành công hay lỗi.
3. **Given** một bước lỗi giữa chừng, **When** chuỗi chạy tiếp, **Then** các bước khác vẫn chạy; bước lỗi ghi rõ lý do
   bằng tiếng Việt; hoàn tác cả gói chỉ đảo các bước đã thành công.
4. **Given** lần "Tối ưu" vừa xong, **When** người dùng bấm "Hoàn tác", **Then** mọi file cấu hình và khối ngữ cảnh trở
   về đúng nội dung trước đó; công cụ đã cài (rtk, codegraph) được giữ lại và ghi chú là không gỡ.
5. **Given** mức tối ưu `aggressive` có trong danh sách, **When** người dùng xem trước, **Then** dòng đó tắt sẵn và có
   cảnh báo như ở spec 025; muốn bật phải chọn tay.
6. **Given** bất kỳ dòng nào, **Then** nút không tắt MCP, không xoá skill, không ghi ngoài khối đánh dấu trong
   CLAUDE.md/AGENTS.md/GEMINI.md/rules, và không chạy nén bằng AI.

---

### User Story 3 - Kéo memory dự án đã duyệt về máy (Priority: P2)

Thành viên dự án đã duyệt memory trên hub (ghi chú, quy ước, bài học). Mỗi máy của người trong dự án kéo memory đã duyệt
về khối ngữ cảnh của dự án đó, để mọi CLI trên máy đều đọc được mà không cần nối MCP của hub. Người dùng chọn tự động
(định kỳ) hoặc bấm "Đồng bộ".

**Why this priority**: Đây là cách người này học được thứ người kia đã ghi. Cần US1 để có chỗ ghi.

**Independent Test**: Hai máy cùng dự án. Duyệt một memory trên web, đồng bộ ở máy thứ hai, kiểm memory đó có trong khối
ngữ cảnh của mọi CLI trên máy thứ hai.

**Acceptance Scenarios**:

1. **Given** dự án có memory đã duyệt trên hub và máy đã gắn dự án, **When** người dùng bấm "Đồng bộ", **Then** memory
   đã duyệt xuất hiện trong phần "Từ hub" của khối ngữ cảnh, tách khỏi phần nguồn tại máy.
2. **Given** một memory bị thay thế hoặc gỡ trên hub, **When** máy đồng bộ, **Then** bản cũ biến mất khỏi khối.
3. **Given** memory của dự án vượt ngân sách token của khối, **When** đồng bộ, **Then** app lấy theo thứ tự ưu tiên (ghim
   trước, mới trước), ghi rõ đã bỏ bao nhiêu mục, và không vượt ngân sách.
4. **Given** máy mất mạng, **When** tới lịch đồng bộ, **Then** khối giữ bản lần trước và màn Memory ghi thời điểm đồng
   bộ gần nhất.
5. **Given** memory `pending` hoặc memory của dự án mà người dùng không có quyền xem, **Then** chúng không bao giờ được kéo
   về.

---

### User Story 4 - Chính sách tối ưu của dự án (Priority: P2)

Quản trị đội hoặc chủ dự án đặt trên web chính sách tối ưu cho dự án: mức tối ưu, bật RTK, bật codegraph, trần nén ngữ
cảnh, ngân sách token của khối ngữ cảnh, có tự đồng bộ memory không. Máy của thành viên kéo chính sách về; nút "Tối ưu"
dùng chính sách đó làm đích thay cho mặc định.

**Why this priority**: Giúp cả đội cùng một mức tối ưu mà không phải chỉ tay từng người. Cần US2 để có chỗ áp dụng.

**Independent Test**: Đặt chính sách `aggressive` + RTK cho dự án trên web; trên máy thành viên, bấm "Tối ưu" và kiểm
danh sách xem trước dùng đúng chính sách, ghi rõ nguồn "theo chính sách dự án".

**Acceptance Scenarios**:

1. **Given** người có quyền quản trị dự án hoặc đội, **When** lưu chính sách trên trang cài đặt dự án, **Then** chính
   sách được lưu và ghi nhật ký kiểm toán; người không có quyền không sửa được.
2. **Given** máy có chính sách mới, **When** người dùng mở màn Token, **Then** app báo máy đang lệch chính sách ở những
   mục nào và nút "Tối ưu" đề xuất đưa về đúng.
3. **Given** chính sách yêu cầu mức `aggressive`, **When** xem trước, **Then** dòng đó vẫn cần người dùng xác nhận riêng;
   chính sách không tự áp dụng khi người dùng chưa bấm.
4. **Given** máy dùng chung nhiều dự án có chính sách khác nhau, **Then** chính sách chỉ áp vào phần gắn với dự án (khối
   ngữ cảnh, chỉ mục code của dự án); phần thuộc cả gói CLI (biến môi trường, hook) lấy mức cao nhất trong các dự án đang
   gắn và ghi rõ lý do.

---

### User Story 5 - Gửi lên hub không mất khi mất mạng (Priority: P3)

Gửi memory lên hub, đề xuất skill, gửi điểm token đi qua một hàng đợi trên máy (đề xuất skill chưa có kind trong hàng đợi; xem FR-040). Mất mạng thì việc nằm trong hàng, gửi lại
khi có mạng, không gửi trùng.

**Why this priority**: Không chặn giá trị chính, nhưng thiếu nó thì US3, US6 hỏng lặng lẽ khi máy ngoại tuyến. Làm theo
thiết kế outbox của spec 027, không thiết kế lại.

**Independent Test**: Tắt mạng, gửi một memory lên hub, bật lại mạng, kiểm memory có trên hub đúng một lần.

**Acceptance Scenarios**:

1. **Given** máy mất mạng, **When** người dùng gửi memory lên hub, **Then** app báo "Đã xếp hàng, sẽ gửi khi có mạng" và
   màn Memory hiện số việc đang chờ.
2. **Given** việc đang chờ, **When** có mạng lại, **Then** việc được gửi đúng một lần kể cả khi app khởi động lại giữa
   chừng.
3. **Given** hub từ chối (vd. chính sách memory của tổ chức tắt), **Then** việc rời hàng và hiện lý do; không thử lại mãi.

---

### User Story 6 - Báo cáo token chung của dự án (Priority: P3)

Thành viên dự án xem trên web số liệu token của dự án theo người và theo máy: token quy đổi 7 ngày, điểm tối ưu, máy nào
lệch chính sách. Chỉ số liệu được gửi, không gửi nội dung phiên, lời nhắc hay file.

**Why this priority**: Cho quản trị biết ai cần giúp. Dựa trên đường gửi điểm của spec 025 nên phần mới nhỏ.

**Independent Test**: Hai máy bật gửi số liệu; trên web, trang dự án hiện hai dòng với số liệu đúng; kiểm dữ liệu gửi đi
không có chuỗi nội dung.

**Acceptance Scenarios**:

1. **Given** người dùng bật gửi số liệu (mặc định tắt), **When** máy tính lại điểm, **Then** hub nhận số liệu của các
   phiên thuộc dự án đó, gắn với máy và người.
2. **Given** người xem là thành viên dự án, **Then** họ thấy bảng theo người/máy; người ngoài dự án không thấy.
3. **Given** người dùng tắt gửi, **Then** máy ngừng gửi và có nút xoá số liệu đã gửi của máy mình.

### Edge Cases

- File đích có hai khối đánh dấu, hoặc khối mất dòng đóng (người dùng sửa hỏng): app không ghi, báo lỗi, chỉ chỗ hỏng.
- File đích là symlink, chỉ đọc, hoặc nằm ngoài thư mục dự án: bỏ qua file đó, ghi lý do; các file khác vẫn ghi.
- Dự án là repo git: khối luôn nằm ở file cục bộ không theo dõi (D5). File đích bị git theo dõi (người dùng lỡ commit) thì
  app không ghi, báo người dùng gỡ file khỏi repo.
- CLI chưa cài hoặc chưa có gói nào: không tạo file cho CLI đó.
- Hai cửa sổ app cùng chạy "Tối ưu": lần sau chờ hoặc báo đang chạy, không ghi chồng.
- Memory trên hub chứa thứ trông như bí mật (token, mật khẩu): không ghi vào khối, báo cho người dùng.
- Đổi tên hoặc chuyển thư mục dự án: nguồn gắn theo dự án hub (nếu có), không theo đường dẫn.
- Ngân sách token của khối nhỏ hơn riêng phần nguồn tại máy: báo người dùng rút gọn nguồn, không cắt chữ người dùng viết.

## Requirements *(mandatory)*

### Functional Requirements

**Ngữ cảnh dùng chung trên máy (US1)**

- **FR-001**: Mỗi dự án trên máy có **một nguồn ngữ cảnh** do app quản lý, lưu ngoài repo dự án.
- **FR-002**: App ghi nguồn vào file ngữ cảnh mà từng CLI tự đọc ở thư mục dự án: Claude Code, Codex, Gemini, Antigravity.
  Chỉ ghi cho CLI có cài trên máy.
- **FR-002a**: File đích là file cục bộ không theo dõi bằng git: dùng file cục bộ của CLI nếu CLI có (vd. `CLAUDE.local.md`),
  không thì thêm file đích vào git exclude của repo trước khi ghi. App không bao giờ ghi vào file mà git đang theo dõi.
- **FR-003**: Nội dung app ghi nằm trong **một khối có dòng mở và dòng đóng đánh dấu** của xDev Hive. App không bao giờ
  sửa, xoá hay sắp xếp lại chữ ngoài khối.
- **FR-004**: Khối gồm hai phần tách bạch: "Tại máy" (nguồn do người dùng soạn) và "Từ hub" (memory đã duyệt, US3).
- **FR-005**: Trước khi ghi, app kiểm khối hiện tại khớp bản app ghi lần trước. Không khớp (người sửa tay) thì không ghi
  đè, báo xung đột và cho chọn.
- **FR-006**: Mọi lần ghi có bản sao lưu; tắt tính năng gỡ khối khỏi mọi file và xoá file app tự tạo vào thùng rác.
- **FR-007**: App đề nghị chuyển từ cách chia sẻ memory Claude cũ (spec 015) sang nguồn mới, có xem trước; không tự chuyển.
- **FR-008**: Màn Memory hiện mỗi dự án: nguồn, các file đích, trạng thái từng file (đúng, lệch, xung đột, bỏ qua và lý
  do), ước lượng token của khối.

**Nút "Tối ưu" (US2)**

- **FR-010**: Màn Token có nút "Tối ưu" chạy một chuỗi cố định: bật bộ tối ưu cho mọi gói CLI hỗ trợ; các sửa nhanh an toàn
  của thang điểm spec 025; cập nhật khối ngữ cảnh của các dự án đã bật; tính lại điểm.
- **FR-011**: Trước khi áp dụng, app hiện danh sách xem trước đủ mọi thay đổi (nhóm, file hay mục, giá trị cũ → mới).
  Người dùng bỏ chọn được từng dòng. Chưa xác nhận thì không ghi gì.
- **FR-012**: Áp dụng xong, app hiện điểm máy trước và sau, kết quả từng dòng; bước lỗi không dừng các bước khác.
- **FR-013**: Một lần "Tối ưu" có **một** hoàn tác, đảo mọi bước đã thành công theo thứ tự ngược. Công cụ đã cài không gỡ.
- **FR-014**: Thay FR-012 của spec 025: nút một chạm **được** ghi CLAUDE.md, AGENTS.md, GEMINI.md, rules và memory **chỉ
  trong khối đánh dấu của xDev Hive**. Vẫn cấm: tắt MCP, xoá skill, ghi ngoài khối, chạy nén bằng AI (nén vẫn duyệt
  từng file trên màn Memory).
- **FR-015**: Dòng đổi mô hình hay mức `aggressive` mặc định không chọn và có cảnh báo; chính sách dự án không bỏ được
  bước xác nhận này.
- **FR-016**: Không chạy hai chuỗi "Tối ưu" cùng lúc trên một máy.

**Kéo memory đã duyệt (US3)**

- **FR-020**: Máy đã đăng nhập và gắn dự án kéo memory **đã duyệt** của dự án (và của đội, tổ chức nếu áp cho dự án) mà
  người dùng có quyền xem; ghi vào phần "Từ hub" của khối.
- **FR-021**: Đồng bộ chạy khi bấm "Đồng bộ", khi chạy "Tối ưu", và định kỳ nếu người dùng hay chính sách dự án bật tự
  động. Mặc định khoảng cách định kỳ 60 phút.
- **FR-022**: Phần "Từ hub" không vượt ngân sách token của khối (mặc định 2.000 token, chính sách dự án đổi được); chọn
  theo ghim trước, mới trước; ghi số mục đã bỏ.
- **FR-023**: Memory bị thay thế hay gỡ trên hub biến khỏi khối ở lần đồng bộ sau.
- **FR-024**: Nội dung trông như bí mật không được ghi vào khối; app báo người dùng.
- **FR-025**: Mất mạng thì giữ bản lần trước và hiện thời điểm đồng bộ gần nhất.

**Chính sách tối ưu của dự án (US4)**

- **FR-030**: Người có quyền quản trị dự án hoặc đội đặt được chính sách tối ưu của dự án trên web: mức tối ưu, RTK,
  codegraph, trần nén ngữ cảnh, ngân sách token của khối, tự đồng bộ memory và khoảng cách. Thay đổi được ghi kiểm toán.
- **FR-031**: Máy kéo chính sách của các dự án đã gắn; màn Token hiện máy lệch chính sách ở mục nào.
- **FR-032**: Nút "Tối ưu" lấy chính sách dự án làm đích và ghi nguồn của từng dòng ("theo chính sách dự án" hay "mặc
  định"). Chính sách không tự áp dụng khi người dùng chưa bấm.
- **FR-033**: Thiết lập thuộc cả gói CLI mà các dự án đòi khác nhau thì lấy mức tối ưu cao nhất trong các dự án đang gắn,
  trừ bước cần xác nhận riêng (FR-015).

**Hàng đợi ngoại tuyến (US5)**

- **FR-040**: Gửi memory, đề xuất skill, gửi số liệu token đi qua hàng đợi bền trên máy; mỗi việc có khoá để hub nhận
  đúng một lần. Hàng đợi hiện có ba kind: `memory.propose`, `project.token_usage`, `machine.token_score`. Kind cho đề xuất
  skill chưa có, và không task nào của spec này dựng nó; thêm khi có luồng đề xuất skill lên hub.
- **FR-041**: Việc chờ được gửi lại khi có mạng, kể cả sau khi app khởi động lại. Hub từ chối hẳn thì việc rời hàng và
  hiện lý do.
- **FR-042**: Màn Memory hiện số việc đang chờ và việc bị từ chối.
- **FR-043**: Hàng đợi theo thiết kế outbox của spec 027; spec này không thiết kế lại.

**Báo cáo token chung (US6)**

- **FR-050**: Người dùng tự bật gửi số liệu theo dự án (mặc định tắt). Chỉ gửi số: token quy đổi theo khoảng ngày, điểm,
  điểm từng tiêu chí, mục lệch chính sách. Không gửi nội dung phiên, lời nhắc, tên file hay đường dẫn.
- **FR-051**: Trang dự án trên web hiện bảng theo người và theo máy cho thành viên dự án; người ngoài dự án không xem
  được.
- **FR-052**: Người dùng tắt gửi và xoá được số liệu đã gửi của máy mình.

**Chung**

- **FR-060**: Mọi chữ trên giao diện và thông báo lỗi bằng tiếng Việt (app desktop giữ từ điển vi/en như các màn sẵn có).
- **FR-061**: Mọi dữ liệu mới trên hub cách ly theo tổ chức và kiểm quyền đội/dự án ở module.
- **FR-062**: Dùng lại phần đã có của spec 015 và 025 (bộ tối ưu, sửa nhanh, điểm, quét memory, gửi điểm), không viết
  lại.

### Key Entities

- **Nguồn ngữ cảnh dự án**: nội dung người dùng soạn cho một dự án trên một máy; gắn với dự án hub nếu có, không thì với
  thư mục.
- **Khối ngữ cảnh**: phần app ghi trong một file đích của một CLI; có bản ghi lần trước để phát hiện sửa tay.
- **File đích**: file ngữ cảnh một CLI tự đọc trong dự án; trạng thái đúng, lệch, xung đột, bỏ qua.
- **Lần tối ưu**: một lần bấm "Tối ưu": danh sách dòng đã chọn, kết quả từng dòng, điểm trước/sau, dữ liệu hoàn tác.
- **Chính sách tối ưu dự án**: thiết lập do quản trị đặt cho một dự án (hoặc đội), có người sửa và thời điểm.
- **Việc chờ gửi**: một việc gửi lên hub nằm trong hàng đợi, có khoá chống trùng, số lần thử, lý do từ chối.
- **Số liệu token dự án**: số liệu theo máy, người, dự án và khoảng ngày; không có nội dung.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Với một dự án dùng ba CLI, người dùng cập nhật ngữ cảnh ở **một** chỗ thay vì ba; sửa nguồn thì mọi file
  đích đúng trong vòng 5 giây.
- **SC-002**: Trong bộ test gồm file đích có sẵn chữ tự viết, **0** byte ngoài khối bị đổi sau bật, sửa, tắt.
- **SC-003**: Trên máy dev chưa tối ưu, một lần "Tối ưu" đưa điểm máy (spec 025) lên ít nhất **75/100**, mất dưới 2 phút
  kể cả xem trước.
- **SC-004**: Hoàn tác đưa mọi file cấu hình và khối ngữ cảnh về đúng bản trước, kiểm bằng so byte trong test.
- **SC-005**: Memory duyệt trên hub có mặt trên máy thành viên khác trong vòng **60 phút** khi bật tự đồng bộ, hoặc ngay
  khi bấm "Đồng bộ".
- **SC-006**: Việc gửi lúc mất mạng tới hub **đúng một lần** sau khi có mạng, trong 100% lần thử của bộ test.
- **SC-007**: Dữ liệu số liệu token gửi lên hub không chứa chuỗi nội dung nào (kiểm bằng test trên payload).
- **SC-008**: Token ngữ cảnh trung bình mỗi phiên trên máy dev giảm ít nhất 15% sau 7 ngày bật, so với 7 ngày trước
  (đo bằng báo cáo token của spec 015).

## Assumptions

- Mỗi CLI đọc file ngữ cảnh của nó ở thư mục dự án: Claude Code `CLAUDE.md`, Codex `AGENTS.md`, Gemini `GEMINI.md`,
  Antigravity thư mục rules của dự án. Tên và vị trí chính xác chốt ở plan sau khi kiểm từng CLI.
- Khối đánh dấu dùng chú thích ẩn của Markdown; CLI vẫn đọc phần giữa hai dòng đánh dấu như chữ thường.
- "Sửa nhanh an toàn" là danh sách cho phép đang có trong spec 025, không mở rộng ở spec này ngoài phần khối ngữ cảnh.
- Gắn máy với dự án dùng cơ chế gắn dự án sẵn có của app desktop (`projects.json`).
- Chính sách tối ưu của dự án là phần mới trên hub, tách khỏi `tokenSaving` của dự án (D6): `tokenSaving` chỉ áp cho run
  hub, chính sách mới chỉ áp cho máy dev.
- Hàng đợi ngoại tuyến làm theo plan spec 027; nếu 027 đổi thiết kế thì phần US5 theo 027.
- Ngân sách mặc định 2.000 token cho phần "Từ hub" và chu kỳ 60 phút là giá trị khởi đầu, xem lại sau khi đo.
- Ngoài phạm vi: đồng bộ memory riêng của từng người giữa các máy của chính họ (chỉ memory dự án đã duyệt); đồng bộ
  skill và MCP (đã có màn Skills, MCP); nén bằng AI trong nút "Tối ưu".
