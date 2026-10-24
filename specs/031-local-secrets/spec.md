# Feature Specification: Kho bí mật tại máy cho agent AI

**Feature Branch**: `ai/spec-031` (số feature `031-local-secrets`)
**Ngày**: 2026-10-23
**Trạng thái**: Draft (chờ chủ dự án xem các mặc định ở mục Assumptions)
**Input**: Người dùng (2026-10-23): "lưu thông tin bí mật để cho AI không cần hỏi mình nhập mà vào đó lấy thôi".

## Vì sao làm

Agent AI (Claude Code, Codex, Gemini CLI) do worker chạy hoặc mở từ app desktop thường cần một thứ bí mật để làm việc:
mật khẩu database dev, khoá API của dịch vụ thử nghiệm, token registry. Hiện agent chỉ có hai cách: hỏi người dùng gõ
vào khung chat, hoặc người dùng dán thẳng giá trị vào prompt hay file. Cách đầu làm gián đoạn run chạy nền và không
chạy được khi người dùng không ngồi đó. Cách sau để giá trị nằm trong transcript, log và có thể bị gửi tới nhà cung cấp
model hay chép lên hub.

Người dùng muốn nhập mỗi bí mật một lần, ở một nơi an toàn trên máy. Từ đó agent lấy dùng qua tên biến (ví dụ
`$DB_PASSWORD`) mà không bao giờ phải hỏi, và không thấy giá trị trong cuộc trò chuyện.

## Mục tiêu

1. Người dùng lưu một bí mật trong app desktop một lần; giá trị nằm trong kho bí mật của hệ điều hành, không nằm
   trong file thường, không nằm trên hub.
2. Gán bí mật cho một hay nhiều dự án trên máy. Mọi run hoặc phiên agent của dự án đó, chạy trên máy này, có biến
   môi trường tương ứng mà không hỏi người dùng.
3. Agent biết có những tên biến nào để dùng, không biết giá trị.
4. Giá trị không xuất hiện trong log, transcript, artifact, hay bất cứ thứ gì rời máy tới hub.
5. Người dùng biết bí mật nào đã đưa cho run hay phiên nào (chỉ tên, tại máy).

## Không làm (non-goals)

- Hub KHÔNG nhận, KHÔNG lưu, KHÔNG chuyển tiếp giá trị bí mật, kể cả dạng mã hoá. Không đồng bộ bí mật giữa các máy.
- Không có công cụ để agent hỏi bí mật theo yêu cầu (MCP tool kiểu `get_secret`) trong bản này (xem Out of Scope).
- Không quản lý bí mật dùng chung của đội hay tổ chức; không có vai trò "quản trị đội nạp bí mật cho đồng đội".
- Không thay token đăng nhập Git, khoá SSH, khoá API của CLI agent đã có cách quản lý riêng (spec 016, 023); tính
  năng này không đọc hay ghi các thứ đó.
- Không chống được phần mềm độc hại chạy dưới chính tài khoản người dùng, và không chống được chính agent in giá trị
  ra rồi gửi tới nhà cung cấp model (xem Edge Cases và Assumptions A6).
- Không xoay bí mật tự động tại dịch vụ đích (không gọi API của dịch vụ để đổi khoá).

## Điều làm tính năng thất bại (anti-goals)

- Giá trị bí mật nằm trong file thường trên đĩa, log, transcript, artifact, báo lỗi, tham số dòng lệnh, hay thông điệp
  gửi tới hub.
- Agent hỏi người dùng nhập bí mật dù bí mật đã được lưu và gán cho dự án.
- Bí mật của dự án A xuất hiện trong run của dự án B.
- Gỡ máy hay xoá bí mật mà giá trị vẫn còn trong kho của hệ điều hành.
- Run chạy tiếp với biến rỗng hoặc sai mà không báo.

## Hiện trạng: dùng lại, mở rộng, làm mới

| Phần | Hiện có | Việc cần làm |
|---|---|---|
| Kho bí mật của hệ điều hành | App desktop và worker đã dùng thư viện keyring (Credential Manager, Keychain, Secret Service) cho token đăng nhập | Dùng cùng loại kho cho bí mật của người dùng, tách tên mục để không lẫn token Hive |
| Che bí mật trong output | Mẫu bí mật trong `worker/internal/ctxsync/secrets.go` và `worker/internal/runner/checks.go` (`redactSecrets` che chuỗi giống bí mật và giá trị chính xác của env nhạy cảm của run) | Mở rộng: che chính xác mọi giá trị bí mật đã đưa cho run/phiên, ở mọi đường ra |
| Lọc env của lệnh kiểm | `checkEnv` chỉ cho biến máy trong allowlist, bỏ tên có `TOKEN`, `SECRET`… | Bí mật của người dùng không đi qua đường thừa kế env của máy; chỉ vào qua đường gán có chủ đích |
| Dự án trên máy | `projects.json` do worker quản lý, màn "Dự án trên máy" của desktop | Gán bí mật theo dự án trên máy này |
| Ranh giới dữ liệu | Spec 027 US5: code và secret ở lại máy; worker không gửi `log_chunk` hay output PTY | Tính năng tuân thủ và cụ thể hoá ranh giới này |
| Chính sách tổ chức | Spec 002: chính sách agent, ảnh chụp chính sách trong mỗi run (`runs.policy_snapshot`) | Thêm một điều khoản chính sách về đưa bí mật vào agent |
| Credential tại máy | Spec 016 (token Git giữ trong bộ nhớ của lần gọi), spec 023 (không lưu mật khẩu ở đâu) | Giữ tinh thần: không ghi giá trị ra file; nhưng ở đây lưu có chủ đích, chỉ trong kho hệ điều hành |

## Khái niệm

| Khái niệm | Nghĩa |
|---|---|
| Bí mật | Một cặp: tên biến (ví dụ `DB_PASSWORD`) và giá trị. Giá trị nằm trong kho bí mật của hệ điều hành. |
| Tên biến | Tên người dùng đặt; là tên biến môi trường agent thấy. Không phải giá trị. |
| Danh mục bí mật | Bản ghi tại máy gồm tên biến, mô tả, ngày tạo, ngày đổi giá trị, các dự án được gán. Không chứa giá trị. |
| Gán | Quan hệ bí mật – dự án trên máy này. Một bí mật gán cho nhiều dự án; một dự án có nhiều bí mật. |
| Phiên có bí mật | Run do worker chạy, hoặc terminal/phiên agent mở từ desktop, cho dự án có bí mật được gán. |
| Nhật ký cấp bí mật | Bản ghi tại máy: phiên nào nhận bí mật tên gì lúc nào. Không chứa giá trị. |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Thêm, sửa, xoá bí mật trong app desktop (Priority: P1)

Người dùng mở màn "Bí mật" trong app, bấm Thêm, nhập tên biến `DB_PASSWORD`, giá trị, mô tả "Postgres dev của dự án
shop", chọn dự án được dùng. Bí mật lưu vào kho hệ điều hành. Ô giá trị không hiện lại giá trị sau khi lưu.

**Why this priority**: Không có bước này thì các bước sau không có gì để đưa cho agent.

**Independent Test**: Thêm một bí mật, đóng và mở lại app, thấy bí mật trong danh sách với giá trị bị che; xem bằng
công cụ của hệ điều hành thấy mục trong kho; không có file thường nào chứa giá trị.

**Acceptance Scenarios**:

1. **Given** người dùng nhập tên và giá trị hợp lệ, **When** bấm Lưu, **Then** giá trị nằm trong kho bí mật của hệ
   điều hành, danh mục ghi tên, mô tả, ngày tạo, và ô giá trị trống ngay sau khi lưu.
2. **Given** bí mật đã có, **When** người dùng mở danh sách, **Then** mỗi dòng hiện tên biến, mô tả, số dự án được
   gán, ngày đổi giá trị gần nhất, và giá trị luôn bị che (••••); app không trả giá trị về giao diện nếu người dùng
   chưa chọn Hiện (US8).
3. **Given** bí mật đã có, **When** người dùng chọn Đổi giá trị và lưu giá trị mới, **Then** kho cập nhật giá trị, danh
   mục cập nhật ngày đổi, tên và các gán giữ nguyên.
4. **Given** bí mật đã có, **When** người dùng sửa tên biến, mô tả hoặc danh sách dự án mà không đụng giá trị, **Then**
   giá trị không bị đọc ra hay ghi lại và các gán mới có hiệu lực cho phiên sau.
5. **Given** người dùng bấm Xoá và xác nhận, **Then** mục trong kho và dòng danh mục bị xoá; các gán biến mất; danh
   sách không còn bí mật đó.
6. **Given** tên biến không hợp lệ (xem FR-003, FR-004), **Then** app báo lỗi tiếng Việt chỉ rõ quy tắc nào bị vi phạm
   và không lưu.
7. **Given** màn Bí mật, **Then** màn mở được khi chưa đăng nhập Hive (tính năng tại máy, như spec 016 và 023).

---

### User Story 2 - Run của worker nhận bí mật qua biến môi trường (Priority: P1)

Người dùng gán `DB_PASSWORD` cho dự án `shop`. Hub giao một run cho dự án `shop` tới worker trên máy này. Agent chạy
`psql "postgres://app:$DB_PASSWORD@localhost/shop"` và chạy được, không hỏi gì.

**Why this priority**: Đây là lý do của tính năng: run nền không có người ngồi trả lời.

**Independent Test**: Gán một bí mật cho dự án, chạy một run mà agent dùng bí mật đó để gọi một dịch vụ thử, thấy lệnh
dùng được giá trị và agent không hỏi người dùng; chạy run của dự án khác thì không thấy biến.

**Acceptance Scenarios**:

1. **Given** dự án `shop` được gán `DB_PASSWORD`, **When** worker bắt đầu một run của `shop`, **Then** tiến trình agent
   và mọi lệnh con của nó thấy biến môi trường `DB_PASSWORD` với đúng giá trị.
2. **Given** `DB_PASSWORD` chỉ gán cho `shop`, **When** worker chạy run của dự án khác, **Then** biến không có mặt.
3. **Given** dự án không có bí mật nào được gán, **When** run bắt đầu, **Then** hành vi giống hiện nay, không có bước
   đọc kho nào.
4. **Given** run bắt đầu, **Then** giá trị chỉ được đọc từ kho ngay trước khi tạo tiến trình agent, không ghi vào file
   tạm, không vào tham số dòng lệnh, không vào `hub.json`.
5. **Given** run đang chạy, **When** người dùng đổi giá trị hay xoá bí mật, **Then** run đang chạy giữ giá trị đã nhận
   tới khi kết thúc; thay đổi áp dụng từ run kế tiếp (xem Edge Cases).
6. **Given** run chuyển giao việc cho agent con (spec 028) trong cùng dự án trên cùng máy, **Then** agent con nhận cùng
   bộ biến của dự án; trên máy khác thì không (bí mật không rời máy).
7. **Given** lệnh kiểm của run (`checks.go`) chạy sau khi agent xong, **Then** lệnh kiểm nhận bí mật gán cho dự án
   như agent, và vẫn không thừa kế biến nhạy cảm khác của máy.
8. **Given** `SENTRY_DSN` bật "Dùng cho mọi dự án", **When** người dùng clone một repo mới rồi worker chạy run đầu tiên
   của nó, **Then** run thấy biến `SENTRY_DSN` mà không cần gán, và nhật ký cấp ghi tên này cho run đó (FR-066).

---

### User Story 3 - Terminal và phiên agent mở từ desktop nhận bí mật (Priority: P1)

Người dùng mở dự án `shop` trong app desktop, bấm mở Claude Code trong terminal tích hợp. Trong terminal đó
`$DB_PASSWORD` có sẵn. Người dùng không phải `export` bằng tay.

**Why this priority**: Nửa còn lại của "agent không cần hỏi": phiên tương tác.

**Independent Test**: Trên mỗi hệ điều hành (Windows, macOS, Linux), mở terminal agent cho dự án có gán bí mật, chạy
lệnh in độ dài của biến, thấy đúng độ dài; mở terminal cho dự án khác, thấy biến không tồn tại.

**Acceptance Scenarios**:

1. **Given** dự án có bí mật gán, **When** người dùng mở terminal/phiên agent cho dự án từ desktop, **Then** shell và
   mọi tiến trình con thấy các biến đó, trên Windows (PowerShell, cmd, Git Bash), macOS và Linux.
2. **Given** terminal mở cho dự án không có bí mật, **Then** không có biến nào thêm.
3. **Given** người dùng tự mở terminal ngoài app, **Then** không có bí mật nào được đưa vào (tính năng chỉ áp cho
   phiên do app hoặc worker mở).
4. **Given** phiên đang mở, **When** gán thêm hay đổi bí mật, **Then** phiên đang mở không đổi; app hiện gợi ý "mở phiên
   mới để nhận thay đổi".
5. **Given** giá trị có nhiều dòng (khoá PEM), **Then** biến giữ nguyên các dấu xuống dòng ở cả ba hệ điều hành.
6. **Given** phiên PTY (output không về hub theo spec 027), **Then** tính năng không làm đổi ranh giới đó: không gửi
   thêm gì về hub.

---

### User Story 4 - Agent biết có những tên biến nào (Priority: P1)

Agent bắt đầu run và biết có `DB_PASSWORD` (mô tả: "Postgres dev của dự án shop") để dùng, nên không hỏi người dùng.

**Why this priority**: Có biến mà agent không biết thì agent vẫn hỏi người dùng, mất cả mục đích.

**Independent Test**: Chạy run có bí mật gán, đọc ngữ cảnh đầu vào agent nhận, thấy tên và mô tả của từng biến, không
thấy giá trị.

**Acceptance Scenarios**:

1. **Given** dự án có bí mật gán, **When** run hoặc phiên agent bắt đầu, **Then** ngữ cảnh/hướng dẫn agent nhận có một
   mục liệt kê: tên biến, mô tả ngắn, và lời dặn dùng qua tên biến, không in giá trị, không hỏi người dùng.
2. **Given** không có bí mật gán, **Then** không thêm mục nào.
3. **Given** mô tả do người dùng viết, **Then** mô tả cũng bị quét như giá trị: nếu mô tả chứa chuỗi giống bí mật, app
   cảnh báo lúc lưu (dùng lại mẫu bí mật của worker), vì mô tả đi tới nhà cung cấp model.
4. **Given** danh sách tên đưa vào ngữ cảnh, **Then** chỉ gồm bí mật gán cho đúng dự án của run.
5. **Given** file hướng dẫn của dự án (`AGENTS.md`, `CLAUDE.md`), **Then** tính năng không ghi tên bí mật vào các file
   đó trong repo; tên chỉ đi qua ngữ cảnh của phiên.

---

### User Story 5 - Che giá trị khỏi log, transcript, artifact và hub (Priority: P1)

Agent lỡ chạy `echo $DB_PASSWORD` hay một lệnh lỗi in cả chuỗi kết nối. Log lưu tại máy ghi `[đã che]` thay giá trị.
Không có gì chứa giá trị tới hub.

**Why this priority**: Bí mật rò vào log là lỗi nghiêm trọng nhất của tính năng.

**Independent Test**: Chạy run bắt agent in giá trị dưới nhiều dạng (nguyên văn, base64, trong URL, trong JSON); kiểm
tra log tại máy, transcript, artifact, sự kiện và báo cáo agent gửi hub: không có dạng nào của giá trị.

**Acceptance Scenarios**:

1. **Given** phiên có bí mật, **When** output chứa đúng giá trị, **Then** mọi nơi lưu hay gửi output (log run tại máy,
   transcript, đuôi output của lệnh kiểm, artifact, báo cáo agent) thay giá trị bằng `[đã che]`.
2. **Given** output chứa giá trị ở dạng base64, URL-encoded, hay trong dấu nháy của shell, **Then** các dạng đó cũng bị
   che.
3. **Given** giá trị nhiều dòng, **Then** cả khối và từng dòng đủ dài đều bị che; dòng ngắn trùng chữ thường không bị
   che sai (xem FR-033).
4. **Given** thông điệp worker gửi hub (sự kiện run, báo cáo agent, trạng thái), **Then** thông điệp được quét; nếu còn
   chứa giá trị thì giá trị bị che trước khi gửi, và sự kiện "đã che bí mật" được ghi tại máy.
5. **Given** artifact (file agent tạo ra, diff, tóm tắt) chuẩn bị rời máy, **Then** artifact được quét; nếu chứa giá trị
   thì rời máy bản đã che, hoặc bị giữ lại kèm cảnh báo khi không che được (nhị phân).
6. **Given** một bí mật đã bị xoá, **Then** log cũ đã che vẫn giữ nguyên dấu che; app không cần giá trị cũ để giữ nó.
7. **Given** lỗi hay log của chính app/worker (báo lỗi, nhật ký debug), **Then** không chứa giá trị, kể cả khi lưu hay
   đọc kho thất bại.

---

### User Story 6 - Nhật ký cấp bí mật tại máy (Priority: P2)

Người dùng mở "Nhật ký cấp" của một bí mật và thấy: run `RUN-482` của dự án `shop` lúc 09:12 nhận `DB_PASSWORD`;
phiên terminal 10:03 nhận `DB_PASSWORD`, `STRIPE_TEST_KEY`.

**Why this priority**: Người dùng cần biết bí mật đã đi đâu để quyết định xoay khi nghi ngờ rò.

**Independent Test**: Chạy một run và mở một terminal có bí mật, mở nhật ký thấy hai dòng đúng tên bí mật; mở file
nhật ký thấy không có giá trị.

**Acceptance Scenarios**:

1. **Given** phiên có bí mật bắt đầu, **Then** nhật ký tại máy thêm một dòng: thời điểm, loại (run/terminal), mã run
   hoặc mã phiên, dự án, danh sách tên bí mật. Không có giá trị.
2. **Given** nhật ký, **When** người dùng lọc theo bí mật hay dự án, **Then** danh sách lọc đúng.
3. **Given** nhật ký giữ theo chính sách giữ log của máy, **Then** dòng cũ hơn thời hạn bị xoá (mặc định theo A7).
4. **Given** hub, **Then** hub chỉ nhận số lượng bí mật đã đưa cho run (một số nguyên trong sự kiện run), không nhận tên
   và không nhận giá trị (xem A1).
5. **Given** bí mật bị xoá, **Then** dòng nhật ký cũ giữ nguyên tên để truy vết, kèm nhãn "đã xoá".
6. **Given** nhật ký, **Then** người dùng xoá được toàn bộ nhật ký; việc xoá không ảnh hưởng bí mật.

---

### User Story 7 - Chính sách tổ chức về đưa bí mật vào agent (Priority: P2)

Quản trị tổ chức chịu quy định chặt: không cho agent nhận bí mật, hoặc cho nhưng mỗi lần phải có người duyệt.

**Why this priority**: Doanh nghiệp cần một công tắc; mặc định vẫn dùng được để không cản người dùng cá nhân.

**Independent Test**: Đặt chính sách "cấm", chạy run cho dự án có gán bí mật, thấy run không nhận biến nào kèm lý do;
đặt "cần duyệt", thấy run chờ xác nhận tại máy trước khi nhận biến.

**Acceptance Scenarios**:

1. **Given** chính sách tổ chức có mục `secretInjection` với ba giá trị `allow` (mặc định), `approve`, `deny`, **Then**
   quản trị chỉnh được ở `/admin/policies` và thay đổi được ghi audit (như FR-007 của spec 002).
2. **Given** `deny`, **When** run của dự án thuộc tổ chức bắt đầu, **Then** worker không đọc kho, không đặt biến nào,
   run vẫn chạy (không có bí mật) và ghi sự kiện "chính sách cấm đưa bí mật". Ngữ cảnh agent ghi rõ không có bí mật nào.
3. **Given** `approve`, **When** run cần bí mật, **Then** app desktop hiện hộp thoại liệt kê tên bí mật (không giá trị)
   và dự án; chỉ khi người dùng đồng ý trên máy này thì biến được đưa vào; từ chối hay quá thời hạn chờ thì run chạy
   không có bí mật.
4. **Given** run mang ảnh chụp chính sách (`policy_snapshot`), **Then** quyết định dùng đúng ảnh chụp tại lúc run được
   tạo, không dùng chính sách mới hơn.
5. **Given** phiên terminal mở từ desktop, **Then** cùng chính sách áp dụng theo tổ chức của dự án; dự án chưa liên kết
   hub (không có tổ chức) dùng `allow`.
6. **Given** máy offline và chưa biết chính sách của tổ chức, **Then** dự án đã liên kết hub dùng `deny` (an toàn
   trước, xem A5); chính sách gần nhất đã biết được dùng nếu có.

---

### User Story 8 - Xem lại giá trị, đổi giá trị, gỡ máy (Priority: P3)

Người dùng cần xem lại giá trị để sao chép sang dịch vụ khác, hoặc đổi sau khi nghi ngờ rò, hoặc gỡ máy khỏi tổ chức.

**Why this priority**: Quan trọng cho an toàn, nhưng không chặn việc chính.

**Independent Test**: Bấm Hiện, thấy yêu cầu xác thực của hệ điều hành rồi mới thấy giá trị trong 10 giây; gỡ liên kết
máy rồi kiểm kho theo các lựa chọn.

**Acceptance Scenarios**:

1. **Given** bí mật đã lưu, **When** người dùng bấm Hiện hoặc Sao chép giá trị, **Then** nếu hệ điều hành có xác thực
   lại (Windows Hello, Touch ID, polkit) app yêu cầu nó; không có thì app hỏi xác nhận rõ ràng. Thành công thì hiện hay
   chép giá trị.
2. **Given** giá trị đang hiện, **Then** tự ẩn sau tối đa 10 giây hoặc khi rời màn; bản chép vào clipboard bị xoá sau
   30 giây nếu clipboard chưa đổi.
3. **Given** mỗi lần Hiện hay Sao chép, **Then** nhật ký ghi một dòng "đã xem" (thời điểm, tên, không giá trị).
4. **Given** người dùng đăng xuất Hive hoặc gỡ liên kết máy với hub, **Then** bí mật vẫn nằm trên máy (không phụ thuộc
   đăng nhập); app hỏi có xoá gán bí mật cho các dự án của tổ chức đó không, mặc định là giữ.
5. **Given** người dùng chọn "Xoá mọi dữ liệu app" hay gỡ cài app, **Then** có tuỳ chọn xoá mọi bí mật khỏi kho hệ điều
   hành; không chọn thì kho giữ nguyên và app nói rõ mục nào còn lại để xoá thủ công.
6. **Given** người dùng gỡ một dự án khỏi "Dự án trên máy", **Then** các gán của dự án đó bị xoá; bí mật vẫn còn trong
   kho và danh sách.

---

### User Story 9 - Kho bí mật khoá hoặc không có (Priority: P2)

Máy Linux không có Secret Service, hoặc worker chạy không giao diện (headless), hoặc kho đang khoá chờ mở khoá.

**Why this priority**: Lỗi im lặng ở đây khiến agent chạy với biến thiếu rồi đoán mò hoặc hỏi người dùng.

**Independent Test**: Giả lập kho không dùng được, chạy run cho dự án có gán bí mật, thấy run dừng với lý do rõ ràng,
không có giá trị rò vào log; sau khi mở khoá chạy lại thì nhận biến.

**Acceptance Scenarios**:

1. **Given** kho không truy cập được (khoá, bị từ chối, không có dịch vụ), **When** run cho dự án có bí mật gán bắt
   đầu, **Then** run dừng trước khi tạo tiến trình agent với trạng thái lỗi "Không đọc được kho bí mật", kèm lý do và
   cách sửa bằng tiếng Việt, và không có agent nào chạy.
2. **Given** kho khoá nhưng mở khoá được bằng hộp thoại hệ điều hành, **When** run bắt đầu, **Then** hộp thoại hiện
   nhiều nhất một lần cho cả run, không phải một lần cho mỗi biến.
3. **Given** worker chạy nền không có phiên người dùng để mở khoá, **Then** worker không hỏi, run dừng như điểm 1, app
   desktop hiện thông báo để người dùng xử lý.
4. **Given** màn Bí mật mở trên máy không có kho, **Then** app báo rõ không lưu được, không lưu giá trị vào chỗ khác
   (không có chế độ lưu file thường dự phòng).
5. **Given** một bí mật được gán nhưng mục trong kho đã bị xoá bên ngoài app, **Then** danh sách hiện nhãn "Thiếu giá
   trị" và run cho dự án đó dừng như điểm 1, chỉ rõ tên bị thiếu.

---

### Edge Cases

- **Xoá hay đổi bí mật khi run đang chạy**: run giữ giá trị đã nhận. App cảnh báo lúc xoá nếu có phiên đang dùng bí mật
  đó, kèm số phiên. Phiên mới không thấy giá trị cũ. Log của run đang chạy tiếp tục che giá trị cũ.
- **Hai dự án cùng tên biến, giá trị khác nhau**: không được, vì tên biến là khoá duy nhất trên máy (A2). Muốn khác giá
  trị thì đặt tên khác (`SHOP_DB_PASSWORD`, `BLOG_DB_PASSWORD`). Thêm tên trùng báo lỗi chỉ ra bí mật hiện có.
- **Tên trùng biến môi trường của máy hay của run**: bí mật được gán ghi đè biến cùng tên thừa kế từ máy (A3). Tên
  thuộc nhóm dành riêng (FR-004) bị từ chối lúc lưu để bí mật không chiếm quyền môi trường của agent hay của CLI.
- **Tên khác hoa thường**: Windows không phân biệt, Linux và macOS có. Tên được chuẩn hoá in hoa; hai tên chỉ khác hoa
  thường bị coi là trùng.
- **Giá trị có dấu xuống dòng, dấu nháy, `$`, ký tự Unicode**: giữ nguyên byte, không qua bước diễn giải của shell khi
  đưa vào. Giá trị có byte NUL bị từ chối (biến môi trường không chứa được).
- **Giá trị rất dài**: giới hạn 8 KiB mỗi giá trị và 64 bí mật mỗi dự án; tổng không vượt giới hạn môi trường của hệ
  điều hành (Windows 32 KiB). Vượt thì báo lỗi lúc lưu hay lúc gán, không cắt âm thầm.
- **Giá trị quá ngắn để che đáng tin** (dưới 8 ký tự): bị từ chối lúc lưu kèm giải thích (A8).
- **Agent in giá trị ra**: log và transcript tại máy đã che (US5). Nhưng nhà cung cấp model đã nhận output đó trước
  khi worker che (agent gửi output công cụ cho model). Tính năng giảm rủi ro bằng lời dặn trong ngữ cảnh và nhắc người
  dùng xoay bí mật khi nghi ngờ; không hứa chặn tuyệt đối (A6). Khi phát hiện giá trị trong output của agent, nhật ký
  cấp ghi dấu "giá trị xuất hiện trong output" (FR-037).
- **Agent ghi giá trị vào file trong repo** (`.env`, code): trước khi commit hay đẩy, nếu nội dung chứa đúng giá trị
  thì thao tác bị chặn và báo người dùng (FR-038), bổ sung cho việc quét mẫu bí mật ở spec 029.
- **Hai run cùng lúc dùng chung một bí mật**: đọc kho độc lập, không khoá lẫn nhau.
- **Dự án đổi tên hay đường dẫn**: gán theo định danh dự án trên máy, không theo đường dẫn; đổi đường dẫn không mất gán.
- **Hai tài khoản hệ điều hành trên cùng máy**: kho theo từng tài khoản; bí mật của người này không thấy được từ người kia.
- **Sao lưu máy**: giá trị nằm trong kho theo quy tắc sao lưu của hệ điều hành; danh mục không chứa giá trị nên sao lưu
  danh mục không lộ giá trị.
- **Nhập hàng loạt từ `.env`**: ngoài bản này (Out of Scope); mỗi bí mật nhập tay.
- **Biến chưa được agent dùng**: vẫn được đưa vào mọi phiên của dự án (không chọn theo từng lần).

## Requirements *(mandatory)*

### Functional Requirements

**Lưu trữ và quản lý**

- **FR-001**: Giá trị bí mật PHẢI chỉ nằm trong kho bí mật của hệ điều hành (Windows Credential Manager, macOS Keychain,
  Linux Secret Service). Không file thường, không cơ sở dữ liệu của app, không hub.
- **FR-002**: Danh mục bí mật tại máy PHẢI chỉ chứa tên biến, mô tả, ngày tạo, ngày đổi giá trị, danh sách dự án
  được gán. Danh mục KHÔNG ĐƯỢC chứa giá trị, băm của giá trị hay độ dài giá trị.
- **FR-003**: Tên biến PHẢI khớp `[A-Z_][A-Z0-9_]*` (chuẩn hoá in hoa), dài tối đa 64 ký tự, và duy nhất trên máy. App
  PHẢI báo lỗi tiếng Việt cho từng vi phạm.
- **FR-004**: App PHẢI từ chối tên dành riêng: `HIVE_*`, `PATH`, `HOME`, `USER`, `USERNAME`, `USERPROFILE`, `SHELL`,
  `COMSPEC`, `TEMP`, `TMP`, `TMPDIR`, `PATHEXT`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `GIT_*`, `SSH_*`, và các biến kiểm
  soát CLI agent (`ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_*`, `CODEX_*`, `GEMINI_*`). Danh sách xem được trong app.
- **FR-005**: Giá trị PHẢI dài 8 ký tự đến 8 KiB, không chứa byte NUL, và có thể chứa xuống dòng. Mỗi dự án có tối đa
  64 bí mật được gán.
- **FR-006**: App PHẢI cho thêm, sửa tên/mô tả, đổi giá trị, gán/bỏ gán dự án, và xoá bí mật. Xoá PHẢI cần xác nhận và
  xoá cả mục trong kho.
- **FR-007**: Sau khi lưu, giá trị KHÔNG ĐƯỢC trả về giao diện, trừ khi người dùng chủ động chọn Hiện hoặc Sao chép
  (FR-052). Ô nhập giá trị là ô mật khẩu, không tự điền, không lưu nháp, xoá ngay khi gửi.
- **FR-008**: Màn Bí mật PHẢI chạy được khi chưa đăng nhập Hive, và có mục trong menu nhóm Dự án.
- **FR-009**: Lệnh tại máy xử lý bí mật PHẢI nhận giá trị qua stdin hoặc IPC cục bộ, KHÔNG qua tham số dòng lệnh hay biến
  môi trường của tiến trình trung gian, và KHÔNG ghi giá trị vào log.

**Gán và đưa vào phiên**

- **FR-010**: Mỗi bí mật PHẢI gán được cho một hay nhiều dự án trên máy; gán theo định danh dự án trên máy, không theo
  đường dẫn.
- **FR-011**: Khi worker bắt đầu run cho một dự án, worker PHẢI đưa mọi bí mật gán cho dự án đó vào môi trường của tiến
  trình agent và các lệnh con (bao gồm lệnh kiểm), và KHÔNG đưa bí mật không gán cho dự án đó.
- **FR-012**: Khi desktop mở terminal hay phiên agent cho một dự án, desktop PHẢI đưa bí mật gán cho dự án vào môi trường
  tiến trình theo FR-011, trên Windows, macOS và Linux. Terminal mở ngoài app không bị đụng tới.
- **FR-013**: Biến PHẢI giữ nguyên byte của giá trị (kể cả xuống dòng, dấu nháy, `$`, Unicode) trên cả ba hệ điều hành,
  không qua bước diễn giải của shell lúc đưa vào.
- **FR-014**: Biến gán PHẢI ghi đè biến cùng tên thừa kế từ môi trường máy hay môi trường mặc định của run; không bao
  giờ ghi đè biến dành riêng (FR-004).
- **FR-015**: Giá trị PHẢI được đọc từ kho ngay trước khi tạo tiến trình và không được ghi ra đĩa, tham số dòng lệnh,
  hay `hub.json`/`projects.json` trong quá trình đưa vào.
- **FR-016**: Thay đổi bí mật (đổi giá trị, gán, xoá) PHẢI chỉ có hiệu lực cho phiên bắt đầu sau đó. Phiên đang chạy giữ
  giá trị cũ. App PHẢI cảnh báo khi xoá hay đổi bí mật đang được phiên đang chạy dùng.
- **FR-017**: Đường thừa kế env của máy (như `checkEnvAllowed`) PHẢI không đổi: bí mật của người dùng chỉ vào qua gán,
  không qua danh sách cho phép biến máy.
- **FR-018**: Agent con (spec 028) chạy trên cùng máy và cùng dự án PHẢI nhận cùng bộ biến; agent chạy trên máy khác
  KHÔNG ĐƯỢC nhận, vì bí mật không rời máy.
- **FR-066**: Mỗi bí mật PHẢI có cờ "Dùng cho mọi dự án" (`allProjects`). Khi bật, bí mật được đưa vào mọi run và mọi
  phiên terminal/agent của desktop cho mọi dự án trên máy, kể cả dự án thêm sau, như bí mật được gán (FR-011 đến
  FR-018). Bí mật dùng chung tính vào giới hạn 64 bí mật mỗi dự án (FR-005); bật cờ khi một dự án đã đủ 64 thì bị từ
  chối. Bật cờ thì bỏ các gán riêng của bí mật; tắt cờ thì người dùng chọn lại dự án. Chưa có loại trừ từng dự án. Che
  giá trị (FR-030 đến FR-038), nhật ký cấp (FR-040) và chính sách (FR-050 đến FR-053) áp dụng như bí mật được gán. Job
  không thuộc dự án nào không nhận bí mật dùng chung. Màn Bí mật PHẢI hiện nhãn "Mọi dự án" và cảnh báo phạm vi khi bật.

**Cho agent biết tên biến**

- **FR-020**: Ngữ cảnh/hướng dẫn mỗi phiên PHẢI có mục liệt kê, chỉ cho bí mật gán cho dự án của phiên: tên biến và mô
  tả, cùng lời dặn "dùng qua tên biến, không in giá trị, không hỏi người dùng". Giá trị không bao giờ có mặt.
- **FR-021**: Mô tả bí mật PHẢI được quét bằng mẫu bí mật của worker lúc lưu; nếu chứa chuỗi giống bí mật thì app cảnh
  báo và yêu cầu sửa trước khi lưu (mô tả đi tới nhà cung cấp model).
- **FR-022**: Tính năng KHÔNG ĐƯỢC ghi tên bí mật vào file của repo (`AGENTS.md`, `CLAUDE.md`, `.mcp.json`).

**Che giá trị**

- **FR-030**: Mọi đường ra của output phiên (log run tại máy, transcript, đuôi output lệnh kiểm, artifact, báo cáo agent,
  thông điệp gửi hub) PHẢI che giá trị chính xác của mọi bí mật đã đưa vào phiên đó bằng `[đã che]`.
- **FR-031**: Việc che PHẢI bao gồm các dạng mã hoá thông dụng của giá trị: base64, base64url, URL-encoding, dạng trong
  dấu nháy của shell, và dạng nằm trong JSON (escape).
- **FR-032**: Việc che PHẢI hoạt động trên luồng, kể cả khi giá trị bị chia làm hai khối output liên tiếp.
- **FR-033**: Với giá trị nhiều dòng, việc che PHẢI che cả khối và từng dòng dài từ 8 ký tự trở lên; dòng ngắn hơn không
  bị che riêng để tránh che nhầm.
- **FR-034**: Artifact rời máy PHẢI bị quét; khi chứa giá trị thì rời máy bản đã che, hoặc bị giữ lại kèm cảnh báo khi
  không che được.
- **FR-035**: Thông điệp worker gửi hub PHẢI không bao giờ chứa giá trị bí mật. Khi quét thấy giá trị, worker che nó,
  ghi sự kiện "đã che bí mật" tại máy, và không dừng run chỉ vì việc đó.
- **FR-036**: Log và báo lỗi của chính app, sidecar và worker PHẢI không chứa giá trị, kể cả khi đọc/ghi kho thất bại.
- **FR-037**: Khi giá trị xuất hiện trong output của agent, nhật ký cấp PHẢI ghi dấu "giá trị xuất hiện trong output"
  cho bí mật đó để người dùng biết nên xoay.
- **FR-038**: Trước khi commit hay đẩy trong run, nếu nội dung thay đổi chứa đúng giá trị của một bí mật đã đưa vào
  phiên, thao tác PHẢI bị chặn và báo người dùng.

**Nhật ký cấp tại máy**

- **FR-040**: Mỗi lần đưa bí mật vào phiên, máy PHẢI ghi một dòng nhật ký tại máy: thời điểm, loại phiên, mã run hoặc
  phiên, dự án, danh sách tên bí mật. KHÔNG ghi giá trị.
- **FR-041**: Mỗi lần Hiện hay Sao chép giá trị PHẢI ghi một dòng "đã xem" (thời điểm, tên).
- **FR-042**: Nhật ký PHẢI lọc được theo bí mật và theo dự án, xoá được toàn bộ bởi người dùng, và tự xoá dòng cũ hơn
  thời hạn giữ (A7).
- **FR-043**: Hub CHỈ được nhận số lượng bí mật đưa vào mỗi run, không nhận tên hay giá trị (A1).
- **FR-044**: Khi bí mật bị xoá, dòng nhật ký cũ PHẢI giữ nguyên tên kèm nhãn "đã xoá".

**Chính sách**

- **FR-050**: Chính sách tổ chức PHẢI có điều khoản `secretInjection` với ba giá trị `allow` (mặc định), `approve`,
  `deny`; chỉnh được ở `/admin/policies`, ghi audit, và nằm trong ảnh chụp chính sách của run.
- **FR-051**: Với `deny`, worker PHẢI không đọc kho và không đặt biến nào; run vẫn chạy, ghi sự kiện chính sách, và ngữ
  cảnh agent ghi rõ không có bí mật. Với `approve`, desktop PHẢI hỏi người dùng tại máy, liệt kê tên (không giá trị) và
  dự án, rồi mới đưa; từ chối hay hết thời hạn chờ thì chạy không có bí mật. Với `allow`, không hỏi.
- **FR-052**: Hiện và Sao chép giá trị PHẢI yêu cầu xác thực lại của hệ điều hành nếu có, nếu không thì xác nhận rõ ràng
  trong app. Giá trị hiện tự ẩn sau tối đa 10 giây; clipboard bị xoá sau 30 giây nếu chưa đổi.
- **FR-053**: Dự án đã liên kết hub mà chưa biết chính sách thì áp `deny`; dự án chưa liên kết áp `allow` (A5).

**Khi kho không dùng được và vòng đời**

- **FR-060**: Khi kho không đọc được (khoá, từ chối, không có dịch vụ, mục thiếu) và dự án có bí mật gán, run PHẢI dừng
  trước khi tạo tiến trình agent với lý do và cách sửa bằng tiếng Việt, chỉ tên bí mật thiếu, không giá trị.
- **FR-061**: Hộp thoại mở khoá của hệ điều hành PHẢI hiện nhiều nhất một lần mỗi phiên. Worker chạy nền KHÔNG ĐƯỢC tự
  hiện hộp thoại tương tác nếu không có phiên người dùng; run dừng theo FR-060 và desktop thông báo.
- **FR-062**: Khi kho không có sẵn, màn Bí mật PHẢI báo rõ và KHÔNG ĐƯỢC lưu giá trị vào chỗ khác.
- **FR-063**: Gỡ một dự án khỏi "Dự án trên máy" PHẢI xoá các gán của nó. Đăng xuất Hive hay gỡ liên kết máy KHÔNG xoá
  bí mật, nhưng hỏi người dùng có xoá gán cho các dự án của tổ chức đó không (mặc định giữ).
- **FR-064**: Khi xoá dữ liệu app hay gỡ cài app, app PHẢI đề nghị xoá mọi bí mật khỏi kho; không chọn thì phải nói rõ
  mục nào còn lại để người dùng xoá thủ công.
- **FR-065**: Mọi chữ trên giao diện có bản tiếng Việt và tiếng Anh theo `src/lib/i18n.ts`; thông báo lỗi tiếng Việt.

### Key Entities

- **LocalSecret**: `name` (tên biến, duy nhất), `description`, `createdAt`, `valueChangedAt`, `projectIds`,
  `allProjects` (cờ dùng cho mọi dự án, FR-066). Giá trị KHÔNG nằm trong thực thể này.
- **SecretAssignment**: `secretName`, `projectId` (định danh dự án trên máy).
- **SecretGrantLog**: `at`, `kind` (`run` | `terminal` | `reveal`), `sessionId`, `projectId`, `secretNames[]`,
  `leakedInOutput` (cờ), `deleted` (nhãn cho tên đã xoá). Không có giá trị.
- **SecretPolicy**: giá trị `allow` | `approve` | `deny` trong chính sách tổ chức và ảnh chụp chính sách của run.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Người dùng thêm một bí mật và gán cho một dự án trong dưới 1 phút ở lần dùng đầu, không cần đọc tài liệu.
- **SC-002**: Trong bộ kiểm thử có bí mật gán, 100% run và phiên desktop của dự án đó thấy biến đúng giá trị trên cả ba
  hệ điều hành; 0 run của dự án khác thấy biến.
- **SC-003**: Trong thử nghiệm cho agent in giá trị dưới 5 dạng (nguyên văn, base64, URL-encoded, trong JSON, nhiều
  dòng), 0 lần giá trị xuất hiện trong log tại máy, transcript, artifact hay thông điệp gửi hub.
- **SC-004**: 0 byte giá trị bí mật nằm trong file thường nào trên máy và 0 byte trên hub, kiểm bằng quét toàn bộ thư mục
  dữ liệu app và dữ liệu hub sau một chuỗi thao tác đủ US1 đến US9.
- **SC-005**: Trong các run có bí mật gán và kho dùng được, agent không hỏi người dùng nhập bí mật nào đã được gán;
  tính trên bộ kịch bản thử có chủ đích.
- **SC-006**: Khi kho không dùng được, 100% run cho dự án có bí mật gán dừng trước khi tạo agent, với lý do hiện trong
  dưới 5 giây.
- **SC-007**: Người dùng trả lời được "bí mật X đã đưa cho run nào" trong dưới 30 giây từ nhật ký cấp.
- **SC-008**: Đọc kho thêm không quá 500 ms vào thời gian khởi động run có tới 10 bí mật, không tính lúc hộp thoại mở
  khoá chờ người dùng.

## Assumptions

- **A1 (mặc định)**: Hub KHÔNG biết tên hay mô tả bí mật; chỉ nhận số lượng bí mật đã đưa vào mỗi run để quản trị thấy
  "run này có dùng bí mật". Lý do: tên như `PROD_DB_PASSWORD` cũng lộ thông tin về hạ tầng, và hub không cần tên để
  làm gì ở bản này. Nếu cần báo cáo theo tên, đổi sang gửi tên và ghi rõ trong spec.
- **A2 (mặc định)**: Tên biến là khoá duy nhất trên máy; một bí mật một giá trị. Cùng tên mà khác giá trị theo dự án
  thì đặt tên khác.
- **A3 (mặc định)**: Bí mật gán đè biến môi trường cùng tên của máy, nhưng không đè tên dành riêng (FR-004).
- **A4 (mặc định)**: Kho không dùng được thì run dừng (đóng cửa an toàn), không chạy tiếp với biến thiếu. Công tắc "tiếp
  tục không có bí mật" theo từng dự án có thể thêm sau (Out of Scope).
- **A5 (mặc định)**: Dự án đã liên kết hub mà chưa biết chính sách thì `deny`; dự án chưa liên kết thì `allow`.
- **A6**: Agent gửi output công cụ tới nhà cung cấp model trước khi worker che output. Tính năng không thể thu hồi giá
  trị đã in ra; biện pháp là lời dặn trong ngữ cảnh, dấu "giá trị xuất hiện trong output", và nhắc xoay bí mật. Đây là
  rủi ro dư; nên gán bí mật có quyền hạn thấp cho agent.
- **A7 (mặc định)**: Nhật ký cấp giữ theo chính sách giữ log của máy; nếu chưa có, giữ 90 ngày.
- **A8 (mặc định)**: Giá trị dưới 8 ký tự bị từ chối vì không che đáng tin được mà không phá log.
- **A9**: Dùng tên mục kho riêng có tiền tố của tính năng để không lẫn với token đăng nhập Hive và token Git.
- **A10**: Giới hạn 8 KiB mỗi giá trị, 64 bí mật mỗi dự án, 10 giây hiện giá trị, 30 giây xoá clipboard là mặc định,
  có thể chỉnh ở plan nếu thử nghiệm cho thấy cần.
- **A11**: Tính năng chạy trên Windows, macOS và Linux như app desktop hiện nay; Linux không có Secret Service là cấu hình
  không hỗ trợ lưu (US9).
- **A12**: Lưu và đọc bí mật chạy hoàn toàn trên máy (app desktop và worker), không cần hub. Chính sách (US7) là phần
  duy nhất cần hub.

## Out of Scope (có thể làm sau)

- Công cụ MCP cho agent lấy bí mật theo yêu cầu, có hỏi người dùng duyệt từng lần hoặc theo phiên.
- Bí mật dùng chung của đội, đồng bộ giữa các máy của cùng một người, hay nạp bí mật từ kho bên ngoài (1Password, Vault).
- Nhập hàng loạt từ `.env`, xuất bí mật.
- Chọn bí mật theo từng run thay vì theo dự án; phạm vi theo nhánh hay theo CLI.
- Nhắc xoay định kỳ, tự xoay tại dịch vụ đích.
- Công tắc theo dự án "tiếp tục không có bí mật khi kho lỗi" (A4).
- Báo cáo tên bí mật lên hub cho quản trị (A1).
- Loại trừ từng dự án khỏi bí mật dùng cho mọi dự án (FR-066).
