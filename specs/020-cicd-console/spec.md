# Feature Specification: Bảng điều khiển CI/CD và triển khai lên máy chủ

**Feature Branch**: `020-cicd-console`

**Created**: 2026-10-17

**Status**: Draft. Chờ chủ dự án chốt Q1–Q16.

**Input**: Chủ dự án chốt ngày 2026-10-17, hướng **A + C**:
- **A:** Hive là bảng điều khiển trên CI sẵn có (GitLab CI, Jenkins): xem pipeline và job, log, chạy lại, huỷ, bấm job
  chờ tay, duyệt, báo khi đỏ. **Không** thay GitLab CI hay Jenkins.
- **C:** Hive quản lý việc triển khai lên máy chủ:
  - máy chủ và khoá SSH;
  - môi trường;
  - nút "Triển khai": sao lưu trước, kiểm health sau, quay về bản cũ được;
  - lịch sử triển khai.
- Viết spec và kế hoạch trước, chưa code.

Bối cảnh (chi tiết ở [research.md](research.md)):
- acme build và deploy bằng **Jenkins** (Harbor, GitOps, Argo CD, RKE2). GitLab CI chỉ chạy kiểm tra.
- Hub Hive chạy trên một máy **Ubuntu riêng** (`app-host`), triển khai bằng script qua SSH với docker compose.
- Đăng nhập máy chủ bằng mật khẩu sẽ chuyển sang khoá SSH nhờ tính năng desktop đang làm ở phiên riêng.

**Kế hoạch**: [plan.md](plan.md) · **Nghiên cứu**: [research.md](research.md)

## Câu hỏi mở cho chủ dự án

Mỗi câu có khuyến nghị. Chưa chốt thì task làm theo khuyến nghị và ghi **[Giả định]**.

| # | Câu hỏi | Khuyến nghị | Ảnh hưởng nếu đổi |
|---|---|---|---|
| Q1 | Lệnh triển khai qua SSH chạy ở đâu? | Trên **máy runner** của đội: máy chạy `hive-worker`, được gắn nhãn `deploy`, nằm cùng mạng với máy chủ đích. Hub chỉ điều phối, ghi log, duyệt. Đúng kiến trúc hiện có: worker nối ra hub và chạy việc, hub điều phối (ADR 0006) | Hub tự SSH: đơn giản hơn, không đổi giao thức worker, nhưng hub phải giữ khoá SSH riêng của mọi máy chủ và phải vào được mạng của chúng |
| Q2 | Khoá SSH để vào máy chủ nằm ở đâu? | Nằm trên máy runner, không rời máy. Hub chỉ lưu tên máy chủ, user, cổng, **dấu vân tay host key đã xác nhận**, và máy runner nào được dùng. Khoá công khai được cài lên máy chủ bằng tính năng SSH của desktop | Hub giữ khoá riêng (mã hoá như token Git) thì máy runner nào cũng dùng được, nhưng hub thành nơi chứa khoá vào mọi máy chủ |
| Q3 | Hub đăng nhập Jenkins bằng gì? | Một **tài khoản dịch vụ** Jenkins cho mỗi tổ chức (user + API token), lưu mã hoá. Quyền theo vai trò `developer` của Jenkins (`Job/Build`). Thao tác trên Hive ghi audit với người bấm thật | Token từng người: Jenkins ghi đúng người bấm, nhưng mỗi người phải tự dán token, và ai chưa dán thì không bấm được |
| Q4 | Hub biết trạng thái mới bằng cách nào? | **GitLab**: thêm sự kiện Pipeline và Job vào webhook đã có, kèm hỏi lại theo lịch phòng khi webhook không tới. **Jenkins**: hub hỏi API, 15 giây một lần khi có build đang chạy, 5 phút một lần khi rảnh. Chưa biết Jenkins có gọi được hub không, còn hub gọi được Jenkins (đã đo) | Webhook từ Jenkins (plugin Notification) thì nhanh hơn, nhưng phải cài plugin và mở đường từ mạng `198.51.100.x` tới hub |
| Q5 | Môi trường gắn với dự án hay hệ thống? | Gắn với **hệ thống** (vd. acme: `dev`, `staging`, `prod`). Mỗi dự án trong hệ thống có một **đích triển khai** ở mỗi môi trường. Như vậy bảng "phiên bản đang chạy" xem được cả hệ thống | Gắn với dự án: mỗi dự án tự khai báo môi trường, khó nhìn tổng thể và khó quay về cùng lúc nhiều dịch vụ |
| Q6 | Đích triển khai có những cách nào? | Bản đầu có ba cách. **`ssh-script`**: chạy các bước trên máy chủ Ubuntu qua máy runner (như `deploy/remote.sh`). **`jenkins-job`**: bấm một job Jenkins kèm tham số (vd. `build-dev`, `acmePromote`). **`gitlab-manual`**: bấm một job `when: manual` của GitLab | Thêm Argo CD, kubectl, Helm trực tiếp: P3. acme đi qua Jenkins → GitOps → Argo CD rồi |
| Q7 | Môi trường nào cần duyệt, ai duyệt? | Mặc định `dev` không cần duyệt, `staging` tuỳ chọn, `prod` **bắt buộc 1 người duyệt** có quyền `deploy.approve` và không phải người yêu cầu. Bước `input` của Jenkins promote do tài khoản dịch vụ của Hive bấm sau khi Hive đã duyệt | Duyệt ở Jenkins như hiện nay thì không có ghi nhận trên Hive, và `approvers` của Jenkins đang để trống |
| Q8 | "Quay về bản cũ" nghĩa là gì? | Triển khai lại **bản thành công gần nhất trước đó** bằng chính đích triển khai ấy. Với `ssh-script`, chạy lại các bước với phiên bản cũ. Với `jenkins-job`, bấm job với tham số của bản cũ (nếu job nhận). Không hoàn tác dữ liệu | Hoàn tác database: cần bản sao lưu và quy trình riêng, để P3 |
| Q9 | Sao lưu trước khi triển khai: bắt buộc hay tuỳ chọn? | Tuỳ chọn cho từng đích triển khai `ssh-script`, có ô "Bỏ qua sao lưu lần này" (ghi audit). Đích có database thì nên bật | Bắt buộc với mọi đích thì đích không có dữ liệu (web tĩnh) cũng phải khai báo lệnh sao lưu giả |
| Q10 | "Phiên bản" là gì? | Commit SHA (kèm tag Git nếu có). Với Jenkins, Hive ghi thêm số build và tag image Harbor mà job báo lại. Bảng "đang chạy" hiện commit, tag, thời điểm, người triển khai | Lấy theo tag image thì phải đọc Harbor; P3 |
| Q11 | GitHub Actions có trong bản đầu không? | P2: xem, chạy lại, huỷ, duyệt bước "deployment" chờ duyệt. Hive hỗ trợ GitHub, nhưng acme không dùng | Bỏ hẳn thì dự án trên GitHub chỉ thấy trạng thái tổng như hiện nay |
| Q12 | Lưu log ở đâu, bao lâu? | Log CI **không** lưu ở Hive: đọc trực tiếp từ GitLab, Jenkins khi mở. Log triển khai `ssh-script` lưu ở Hive như log run (`bytea`), theo hạn giữ log run của tổ chức (`runLogRetentionDays`, mặc định 365 ngày) | Lưu cả log CI thì database phình nhanh, và bị trùng với GitLab, Jenkins. Hạn giữ riêng cho log triển khai cần thêm cài đặt theo loại run |
| Q13 | Lần triển khai **không** do Hive bấm (vd. Jenkins `build-dev` tự build khi poll thấy commit mới) có hiện trên bảng "đang chạy" và lịch sử không? | **Có**, với đích `jenkins-job`: Hive ghi các build xanh của job đó thành lần triển khai "ngoài Hive" (không có người yêu cầu). Chúng tính vào "đang chạy" và "bản thành công gần nhất" khi quay về. Khoá "một lần đang đi" chỉ áp cho lần Hive bấm | Không: cột `dev` của acme sai ngay từ đầu, vì phần lớn lần lên `dev` đi qua poll của Jenkins |
| Q14 | Máy runner triển khai có được chạy việc của agent không? | **Không.** Agent chạy dưới cùng user hệ điều hành, đọc được `~/.ssh` và dùng được ssh-agent, tức là vào được máy chủ thật. Máy có nhãn `deploy` chỉ nhận run `deploy` (không cài agent CLI, hoặc `labelsOnly`) | Cho chạy chung thì phải tách user hệ điều hành cho bước triển khai: thêm cấu hình và kiểm tra trên máy runner |
| Q15 | Job promote (vd. `acmePromote`: `APP`, `FROM_ENV`, `TO_ENV`, `BUILD`) thì người dùng chọn "phiên bản" gì? | Chọn **"Đẩy từ môi trường"**: lấy bản đang chạy ở môi trường nguồn (số build Jenkins) điền vào `BUILD`. Đích promote **không** có "Quay về" vì `acmePromote` không cho đi lùi; quay về cần một job riêng | Chọn commit: phải tra ra số build tương ứng, dễ sai khi một commit có nhiều build |
| Q16 | Máy nào làm runner? Hệ điều hành gì? | Một máy **Linux** dùng chung của đội trong cùng mạng với máy chủ đích, chạy `hive-worker`, chỉ nhận việc triển khai (Q14). Với `app-host`, có thể đặt runner ngay trên máy đó (SSH tới `localhost`). Bộ chạy bước chỉ hỗ trợ Linux/macOS ở bản đầu | Chỉ có máy Windows cá nhân: SC-002 bị chặn (FR-029 không cho máy cá nhân), và bộ chạy bước phải hỗ trợ OpenSSH của Windows |

## Hiện trạng: dùng lại, mở rộng, làm mới

Khảo sát code ngày 2026-10-17 trên `main` tại `9947aeb1`. Chi tiết ở [research.md](research.md) mục 3.

| Phần | Dùng thế nào |
|---|---|
| `scm`: kết nối, token mã hoá, webhook `/hooks/git/:projectId` | **Mở rộng**: thêm vào `GitProvider` các thao tác pipeline/job (GitLab), workflow run/job (GitHub, P2); đăng ký thêm sự kiện Pipeline và Job cho hook GitLab |
| `fleet`, `runs`: máy, giao job, lease, log, SSE, huỷ | **Mở rộng**: thêm loại run `deploy` chạy các bước script không cần agent CLI, chỉ giao cho máy có nhãn `deploy` |
| `platform/secrets.ts` | **Dùng lại** cho token Jenkins |
| `audit`, `notify` | **Dùng lại**, thêm sự kiện CI và triển khai |
| `catalog`: hệ thống, dự án | **Dùng lại** làm gốc cho môi trường (hệ thống) và đích triển khai (dự án) |
| `contracts/roles.ts` | **Mở rộng**: quyền `ci.view`, `ci.operate`, `deploy.run`, `deploy.approve`, `servers.manage` |
| Web: màn run (`LogCard`, `RunActions`, stream) | **Dùng lại** cho log triển khai |
| Jenkins | **Làm mới**: không có gì trong Hive |
| Môi trường, máy chủ, đích triển khai, lần triển khai | **Làm mới** |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Xem CI của dự án ở một chỗ (Priority: P1)

Dev mở dự án `his-portal` trên Hive, tab **CI/CD**, thấy danh sách pipeline GitLab và build Jenkins của dự án theo thời
gian: nhánh, commit, trạng thái, thời lượng, người kích hoạt. Bấm một dòng thì thấy các job/giai đoạn và log; có link mở
sang GitLab hoặc Jenkins.

**Why this priority**: hôm nay phải mở hai nơi và không có chỗ nào nối build với deploy.

**Independent Test**:
- GitLab giả (provider `memory` của `scm`) có 3 pipeline;
- Jenkins giả (máy chủ HTTP trong test, trả JSON như Jenkins thật) có 2 build;
- dự án gắn 1 job Jenkins.

Kiểm danh sách gộp, chi tiết, log.

**Acceptance Scenarios**:

1. **Given** dự án gắn repo GitLab và job Jenkins `his-portal/build-dev`, **When** mở tab CI/CD, **Then** thấy cả hai
   nguồn trong một danh sách, mới nhất ở trên, lọc được theo nhánh và trạng thái.
2. **Given** một build Jenkins đang chạy, **When** mở chi tiết, **Then** log hiện tiếp theo thời gian thực (độ trễ ≤ 15
   giây theo Q4) và các giai đoạn của pipeline Jenkins hiện trạng thái riêng.
3. **Given** người không có quyền `ci.view` ở dự án, **Then** không thấy tab và không gọi được API.

---

### User Story 2 - Thao tác trên CI (Priority: P1)

Người có quyền `ci.operate` bấm **Chạy lại** (pipeline hoặc job GitLab, build Jenkins), **Huỷ**, **Chạy** job chờ tay của
GitLab, **Build with Parameters** của Jenkins (form sinh từ tham số khai báo của job), **Tiếp tục/Dừng** ở bước `input`
của Jenkins.

**Why this priority**: không thao tác được thì Hive chỉ là màn xem.

**Acceptance Scenarios**:

1. **Given** job Jenkins có tham số `APP`, `FROM_ENV`, `TO_ENV`, `BUILD`, **When** bấm Build with Parameters, **Then** form
   có đúng các tham số đó (kiểu, giá trị mặc định, danh sách chọn) và build được tạo với giá trị đã nhập.
2. **Given** bất kỳ thao tác nào, **Then** có bản ghi audit với người bấm thật trên Hive, dù Jenkins ghi tài khoản dịch
   vụ (Q3).
3. **Given** thao tác thất bại vì thiếu quyền ở Jenkins hay GitLab, **Then** báo lỗi tiếng Việt nói thiếu quyền gì, ở
   đâu.

---

### User Story 3 - Máy chủ và môi trường (Priority: P1)

Quản trị (`servers.manage`) khai báo **máy chủ**:
- tên, địa chỉ, cổng, user;
- máy runner dùng để vào máy chủ;
- nhãn.

Hive nhờ máy runner thử kết nối, hiện **dấu vân tay host key** để quản trị xác nhận, rồi lưu. Quản trị tạo **môi
trường** cho hệ thống (`dev`, `staging`, `prod`), rồi khai báo **đích triển khai** cho từng dự án ở từng môi trường
(Q5, Q6).

**Acceptance Scenarios**:

1. **Given** máy runner có nhãn `deploy` và khoá đã cài trên máy chủ, **When** bấm "Kiểm kết nối", **Then** thấy kết quả
   SSH bằng khoá (không mật khẩu), hệ điều hành, phiên bản Docker, dung lượng đĩa còn trống.
2. **Given** host key khác với dấu vân tay đã lưu, **When** triển khai, **Then** dừng ngay, báo "Host key của máy chủ đã
   đổi", không chạy bước nào.
3. **Given** máy chủ chưa cài khoá, **When** kiểm, **Then** báo cách cài khoá bằng app desktop (tính năng SSH của client).

---

### User Story 4 - Triển khai lên máy chủ Ubuntu (Priority: P1)

Người có quyền `deploy.run` mở môi trường `dev`, chọn dự án, chọn phiên bản (commit hoặc tag; mặc định commit mới nhất của
nhánh đã cấu hình), bấm **Triển khai**. Hive tạo một lần triển khai và giao cho máy runner chạy lần lượt:
1. kiểm host key;
2. sao lưu (nếu bật, Q9);
3. đưa mã hoặc image lên máy chủ;
4. lệnh triển khai;
5. kiểm health (URL, mã mong đợi, chuỗi phiên bản nếu có), thử lại trong thời gian chờ.

Log hiện trực tiếp. Xong thì cập nhật bảng "đang chạy".

**Why this priority**: đây là phần C, đúng các bước đã làm tay cho hub ngày 2026-10-17.

**Independent Test**: máy chủ SSH giả trong container (OpenSSH + Docker giả lập lệnh), máy runner thật chạy `hive-worker`
trong test tích hợp. Kiểm thứ tự bước, dừng khi một bước lỗi, log, trạng thái.

**Acceptance Scenarios**:

1. **Given** đích `ssh-script` cho hub (`/home/deploy/xdev-hive`, project `xdev-hive`, health
   `https://hive.example.com/api/v1/health` chứa phiên bản), **When** triển khai commit `9947aeb1`, **Then** chạy đủ các bước
   trên, health báo đúng phiên bản, lần triển khai `thành công`.
2. **Given** bước sao lưu lỗi, **Then** không chạy bước triển khai; lần triển khai `thất bại`, ghi rõ bước và lỗi.
3. **Given** health không đạt trong thời gian chờ, **Then** lần triển khai `thất bại, cần xem`; Hive gợi ý "Quay về bản
   trước" (US6), không tự quay về.
4. **Given** đang có một lần triển khai ở cùng đích, **When** bấm triển khai lần nữa, **Then** bị chặn: "Đang triển khai
   bởi <người> từ <giờ>".
5. **Given** đích `jenkins-job`, **When** triển khai, **Then** Hive bấm job với tham số đã cấu hình, theo dõi build như US1,
   và ghi phiên bản (commit, số build, tag image nếu job báo) vào bảng "đang chạy".

---

### User Story 5 - Duyệt và khoá môi trường (Priority: P2)

Triển khai lên `prod` cần một người duyệt (Q7). Người duyệt nhận thông báo, xem phiên bản sẽ lên và khác biệt so với bản
đang chạy (danh sách commit), rồi bấm **Duyệt** hoặc **Từ chối** kèm lý do. Quản trị **khoá** được một môi trường (vd.
trước giờ nghiệm thu), khi đó mọi lần triển khai bị chặn.

**Acceptance Scenarios**:

1. **Given** người yêu cầu cũng có quyền duyệt, **Then** không tự duyệt được.
2. **Given** yêu cầu chờ duyệt quá 24 giờ, **Then** hết hạn, phải tạo lại.
3. **Given** đích `jenkins-job` có bước `input`, **When** Hive đã duyệt, **Then** tài khoản dịch vụ bấm Proceed ở Jenkins;
   từ chối trên Hive thì bấm Abort.

---

### User Story 6 - Quay về bản trước (Priority: P2)

Trên bảng "đang chạy", bấm **Quay về bản trước** ở một đích: Hive tạo lần triển khai mới với bản thành công gần nhất trước
đó (Q8), đi qua đúng quy trình duyệt của môi trường.

**Acceptance Scenarios**:

1. **Given** lịch sử có A (thành công), B (thất bại, cần xem), **When** quay về, **Then** triển khai lại A, lần triển
   khai ghi "quay về từ B".
2. **Given** không có bản thành công trước đó, **Then** nút bị tắt kèm lý do.

---

### User Story 7 - Thông báo (Priority: P2)

Quản trị cấu hình kênh sẵn có của tổ chức (Telegram, email) nhận báo theo loại sự kiện và hệ thống. Người liên quan
(người yêu cầu, người duyệt, người đẩy commit nếu là thành viên) nhận vào hộp thư trong app. Báo cho:
- pipeline/build **đỏ** trên nhánh chính;
- triển khai bắt đầu, thành công, thất bại;
- yêu cầu duyệt mới;
- host key đổi.

**Acceptance Scenarios**:

1. **Given** build Jenkins `build-dev` đỏ, **Then** người đăng ký nhận một tin có tên job, commit, người đẩy, link log.
   Cùng một lỗi đỏ liên tiếp không gửi lặp.

---

### User Story 8 - GitHub Actions (Priority: P3 theo Q11; P2 nếu chủ dự án chọn)

Như US1–US2 cho dự án trên GitHub: workflow run, job, log, chạy lại, huỷ, duyệt deployment chờ duyệt.

### Edge Cases

- Jenkins hoặc GitLab không trả lời: tab CI/CD hiện dữ liệu lần cuối kèm giờ và cảnh báo "Không kết nối được Jenkins
  từ <giờ>"; không chặn phần khác.
- Token Jenkins hết hạn hoặc bị thu hồi: thao tác báo "Kết nối Jenkins không dùng được", quản trị cập nhật ở cài đặt tổ
  chức.
- Job Jenkins bị đổi tên hoặc xoá: liên kết dự án báo "không tìm thấy job".
- Máy runner offline lúc triển khai: lần triển khai `chờ máy` tối đa 10 phút, rồi `thất bại` với lý do.
- Máy runner mất kết nối giữa chừng (lease hết): lần triển khai `không rõ kết quả`. Không tự chạy lại, vì bước triển khai
  có thể đã chạy một nửa. Người dùng kiểm health rồi quyết định.
- Triển khai chính máy chủ chạy hub (hub khởi động lại giữa chừng): máy runner giữ log và gửi lại khi hub lên. Bước
  health chạy trên runner, không phụ thuộc hub.
- Lệnh trong bước có thể in secret (mật khẩu database): worker che bí mật ngay khi đọc output (FR-019).
- Hai người sửa cùng một đích triển khai: khoá lạc quan theo phiên bản cấu hình.
- Đích `ssh-script` khai báo thư mục sai (như suýt gặp với `/opt/xdev-hive`): bước "kiểm trước" so thư mục, compose
  project, file `.env` có sẵn với cấu hình; không khớp thì dừng.

## Requirements *(mandatory)*

### Functional Requirements

**Kết nối CI**

- **FR-001**: Quản trị tổ chức (quyền `ci.connections.manage`) thêm **kết nối Jenkins**: URL, user, API token (mã hoá bằng `platform/secrets.ts`), kiểm
  bằng `GET /api/json` và `GET /me/api/json`. Nhiều kết nối mỗi tổ chức.
- **FR-002**: Dự án gắn được 0..n **job Jenkins** (đường dẫn job, kể cả folder và multibranch) và dùng repo GitLab/GitHub
  sẵn có của dự án.
- **FR-003**: `GitProvider` thêm:
  - liệt kê pipeline (lọc nhánh, trạng thái, phân trang), job của pipeline, log job (theo đoạn, từ vị trí);
  - chạy lại pipeline hoặc job, huỷ, chạy job chờ tay;
  - GitHub: workflow run, job, log, chạy lại, huỷ, duyệt deployment chờ duyệt (P2–P3, Q11).
- **FR-004**: Webhook GitLab của dự án đăng ký thêm sự kiện Pipeline và Job. Hub xử lý bằng `onScmEvent` sẵn có. Có hỏi lại
  theo lịch để không lỡ sự kiện (Q4).
- **FR-005**: Client Jenkins:
  - đọc job (tham số khai báo), build (trạng thái, nguyên nhân, commit, thời lượng);
  - đọc giai đoạn của pipeline: `wfapi/describe` khi job có plugin Pipeline Stage View, không có thì bỏ qua;
  - đọc log theo đoạn: `logText/progressiveText`;
  - bấm build có tham số, dừng build, Proceed/Abort bước `input`.
  Hỏi trạng thái theo Q4.

**Xem và thao tác**

- **FR-006**: Tab CI/CD gộp pipeline GitLab/GitHub và build Jenkins của dự án vào một danh sách thống nhất: nguồn, nhánh,
  commit, trạng thái, thời lượng, người kích hoạt, link gốc.
- **FR-007**: Log CI đọc trực tiếp từ nguồn khi mở, không lưu (Q12). Hiện theo đoạn, tự cuộn, tìm trong log.
- **FR-008**: Thao tác ở FR-003, FR-005 cần quyền `ci.operate` trên dự án. Mỗi thao tác ghi `recordAudit` gồm người bấm,
  nguồn, đối tượng, tham số (tham số kiểu password của Jenkins không ghi giá trị).

**Máy chủ, môi trường, đích triển khai**

- **FR-009**: **Máy chủ** thuộc đội:
  - tên, địa chỉ, cổng, user;
  - dấu vân tay host key đã xác nhận;
  - máy runner được phép dùng (một hoặc nhiều máy có nhãn `deploy` của cùng đội);
  - nhãn.
  Hub **không** lưu khoá riêng (Q2).
- **FR-010**: "Kiểm kết nối" là một job ngắn trên máy runner: SSH bằng khoá với `BatchMode`, đọc host key, hệ điều hành,
  phiên bản Docker và Compose, đĩa trống. Lần đầu chưa có dấu vân tay thì người quản trị xác nhận dấu vân tay hiện ra.
- **FR-011**: **Môi trường** thuộc hệ thống: tên, thứ tự (dev → staging → prod), chính sách duyệt (Q7), khoá/mở.
- **FR-012**: **Đích triển khai** = dự án × môi trường, với một trong ba cách (Q6):
  - `ssh-script`: máy chủ; thư mục làm việc; compose project; các bước "kiểm trước", "sao lưu" (tuỳ chọn), "đưa mã lên",
    "triển khai", "health"; thời gian chờ từng bước; biến không bí mật;
  - `jenkins-job`: kết nối, job, tham số cố định và tham số lấy từ lần triển khai (phiên bản, môi trường);
  - `gitlab-manual`: tên job chờ tay trong pipeline của commit được chọn.
- **FR-013**: Cấu hình đích triển khai có phiên bản. Mỗi lần sửa ghi audit kèm khác biệt. Lần triển khai lưu phiên bản cấu
  hình đã dùng.

**Triển khai**

- **FR-014**: Lần triển khai có các trạng thái:
  - đang đi: `chờ duyệt`, `chờ máy`, `đang chạy`;
  - kết thúc: `thành công`, `thất bại`, `thất bại, cần xem`, `không rõ kết quả`, `đã huỷ`, `bị từ chối`, `hết hạn`.

  Mỗi bước có trạng thái, giờ bắt đầu và kết thúc, mã thoát.
- **FR-015**: Một đích triển khai chỉ có một lần triển khai đang đi tại một thời điểm (khoá trong DB).
- **FR-016**: `ssh-script` chạy như một run loại `deploy` trên máy runner (Q1):
  - không cần agent CLI;
  - các bước chạy tuần tự qua SSH với host key cố định (`StrictHostKeyChecking=yes`, file `known_hosts` sinh từ dấu
    vân tay đã lưu);
  - dừng ở bước lỗi đầu tiên;
  - huỷ được giữa hai bước, bước đang chạy thì gửi tín hiệu dừng.
- **FR-017**: "Đưa mã lên" có hai kiểu:
  - `git-archive`: runner lấy commit từ repo của dự án, gửi qua SSH như `deploy/remote.sh`;
  - `none`: bước triển khai tự kéo image hoặc mã.
- **FR-018**: Health:
  - URL kiểm từ máy runner;
  - mã HTTP mong đợi, có thể thêm biểu thức JSON phải khớp (vd. `version == <commit 8 ký tự>`);
  - thử lại theo chu kỳ trong thời gian chờ (mặc định 3 phút).
- **FR-019**: Log từng bước lưu như log run (`run_logs`), xem trực tiếp bằng SSE sẵn có, giữ theo Q12. Worker che bí
  mật ngay khi đọc output, bằng bộ che sẵn có (`worker/internal/terminal/redact.go`, như `runner/checks.go`), cộng
  thêm giá trị của các biến được đánh dấu bí mật trong cấu hình đích.
- **FR-020**: Bảng **đang chạy** của hệ thống: dòng là dự án, cột là môi trường, ô là phiên bản thành công gần nhất (commit,
  tag, số build Jenkins và tag image nếu có), giờ, người triển khai, kết quả health lần cuối.
- **FR-021**: `jenkins-job`: Hive bấm job, theo dõi build như FR-005; build xanh thì triển khai `thành công`, đỏ thì
  `thất bại`. Hive đọc phiên bản từ tham số, commit của build, và từ chuỗi khai báo trong log (vd. `HIVE_DEPLOYED_IMAGE=…`)
  nếu có.
- **FR-022**: `gitlab-manual`: Hive bấm job chờ tay của pipeline ở commit được chọn, theo dõi như FR-003.

**Duyệt, khoá, quay về (P2)**

- **FR-023**: Chính sách duyệt theo môi trường (Q7):
  - số người duyệt;
  - vai trò được duyệt;
  - người yêu cầu không tự duyệt;
  - hạn chờ (mặc định 24 giờ).
  Màn duyệt hiện danh sách commit giữa bản đang chạy và bản sẽ lên. `scm.compare` hiện chỉ trả file đổi; plan mở rộng
  để trả cả commit.
- **FR-024**: Khoá môi trường: quản trị bật hoặc tắt kèm lý do. Khi khoá, mọi lần triển khai mới bị chặn, kể cả quay về.
- **FR-025**: Quay về bản trước theo Q8, đi qua duyệt như lần triển khai thường.
- **FR-026**: Với `jenkins-job` có bước `input`: Hive duyệt xong thì tài khoản dịch vụ bấm Proceed; Hive từ chối thì bấm
  Abort (Q7).

**Thông báo, quyền, an toàn**

- **FR-027**: Thêm sự kiện vào `notify`:
  - `ci.failed` (nhánh chính), `ci.recovered`;
  - `deploy.started`, `deploy.succeeded`, `deploy.failed`;
  - `deploy.approval_requested`;
  - `server.hostkey_changed`.
  Không gửi lặp cùng một lỗi đỏ liên tiếp.
- **FR-028**: Quyền mới trong `contracts/roles.ts`, cấp theo vai trò tổ chức và đội như các quyền hiện có (Hive chưa có
  thành viên theo dự án hay môi trường): `ci.view`, `ci.operate`, `deploy.run`, `deploy.approve`, `servers.manage`
  (đội), `ci.connections.manage` (tổ chức). Gán mặc định:
  - quản trị đội: tất cả quyền của đội;
  - thành viên đội: `ci.view`, `ci.operate`, `deploy.run`.
  Môi trường giới hạn thêm bằng chính sách của nó: danh sách vai trò được triển khai và được duyệt (vd. `prod`: chỉ quản
  trị đội triển khai và duyệt).
- **FR-029**: Máy runner chỉ nhận run `deploy` khi đủ ba điều kiện:
  - quản trị đội gắn nhãn `deploy` trên hub (cơ chế nhãn sẵn có);
  - worker báo năng lực `deploy` (bản worker mới);
  - máy là máy dùng chung của đội. Máy cá nhân không nhận việc triển khai của người khác (ADR 0017).
  Máy có nhãn `deploy` không nhận run của agent (Q14).
- **FR-030**: Lệnh trong các bước do người có `servers.manage` viết. Người `deploy.run` chỉ chọn phiên bản và chạy, không
  sửa lệnh.
- **FR-031**: Mọi bảng mới có `org_id`, bật và ép RLS, truy cập qua `withTenant()`. Chữ giao diện và lỗi tiếng Việt.
- **FR-032**: Build xanh của job Jenkins gắn với một đích `jenkins-job` mà không do Hive bấm được ghi thành lần triển khai
  "ngoài Hive" (Q13): không có người yêu cầu, có người kích hoạt theo Jenkins. Tính vào "đang chạy" và quay về; không
  tính vào khoá "một lần đang đi".
- **FR-033**: Đích `jenkins-job` loại "đẩy từ môi trường" (Q15): người dùng chọn môi trường nguồn; Hive điền tham số
  build (vd. `BUILD`) bằng số build của bản đang chạy ở nguồn. Đích này không có "Quay về" trừ khi cấu hình một job
  quay về riêng.
- **FR-034**: Thao tác trên GitLab và Jenkins đi bằng token của kết nối, theo quyền Hive (`ci.operate`, `deploy.run`).
  Hive không ánh xạ người dùng Hive sang người dùng GitLab ở bản đầu: người không có quyền trên GitLab vẫn bấm được qua
  Hive nếu có quyền Hive. Audit ghi người bấm thật.

### Key Entities

- **Kết nối Jenkins** (`ci_jenkins_connections`): tổ chức, tên, URL, user, token mã hoá, trạng thái kiểm.
- **Liên kết job** (`ci_project_jobs`): dự án, kết nối, đường dẫn job, tên hiển thị.
- **Trạng thái CI đã thấy** (`ci_runs_seen`): nguồn, id, trạng thái cuối, giờ. Dùng để phát hiện chuyển đỏ/xanh và
  chống gửi lặp. Không chứa log.
- **Máy chủ** (`deploy_servers`): đội, tên, địa chỉ, cổng, user, dấu vân tay, nhãn.
- **Máy chủ ↔ runner** (`deploy_server_runners`): máy chủ, máy runner.
- **Môi trường** (`deploy_environments`): hệ thống, tên, thứ tự, chính sách duyệt, khoá.
- **Đích triển khai** (`deploy_targets`): dự án, môi trường, cách, cấu hình (JSON có phiên bản), máy chủ (nếu có).
- **Lần triển khai** (`deploys`): đích, phiên bản (commit, tag, build, image), người yêu cầu, trạng thái, `run_id`
  (`ssh-script`) hoặc build/job ngoài, phiên bản cấu hình, `rollback_of`.
- **Duyệt** (`deploy_approvals`): lần triển khai, người, quyết định, lý do, giờ.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Với ≥ 20 job Jenkins và 5 dự án GitLab, tab CI/CD mở trong ≤ 2 giây (dữ liệu đã đệm). Trạng thái mới hiện
  trong ≤ 30 giây với Jenkins và ≤ 10 giây với GitLab khi webhook tới được.
- **SC-002**: Triển khai lại hub `hive.example.com` bằng Hive (đích `ssh-script`) đi đủ các bước như lần làm tay ngày
  2026-10-17, không cần mở terminal, thời gian ≤ lần làm tay + 1 phút.
- **SC-003**: 100% thao tác CI và triển khai có bản ghi audit với người bấm thật.
- **SC-004**: Host key đổi thì 0 bước nào chạy (test có kiểm).
- **SC-005**: Không có secret nào xuất hiện trong log đã lưu với bộ mẫu chứa mật khẩu và token giả.
- **SC-006**: Lên `prod` không thể không có người duyệt khác người yêu cầu (test quyền).
- **SC-007**: Hub khởi động lại giữa lúc triển khai chính nó thì lần triển khai vẫn có kết quả đúng sau khi hub lên lại.

## Assumptions

- Máy runner có mạng tới máy chủ đích, và hub có mạng tới Jenkins, GitLab. Đã đo từ `app-host`: Jenkins qua
  `jenkins.example.com`, Harbor, Gitea, GitLab đều được (research mục 2).
- Khoá SSH được cài lên máy chủ bằng tính năng SSH của desktop (phiên riêng) hoặc bằng tay. Spec này không nhập mật khẩu
  máy chủ.
- PostgreSQL vẫn là kho duy nhất (ADR 0003). Không thêm dịch vụ.
- Jenkins vẫn là nơi build của acme. Hive không đọc hay sửa repo GitOps, Argo CD ở bản đầu.

## Out of Scope

- Tự chạy pipeline thay GitLab CI hay Jenkins (hướng B đã loại).
- Argo CD, kubectl, Helm trực tiếp; đọc tag image từ Harbor (P3, Q6, Q10).
- Hoàn tác database khi quay về (Q8).
- Quản lý secret của ứng dụng trên máy chủ (`.env` vẫn nằm trên máy chủ).
- Lịch triển khai tự động theo giờ.
- Tạo job Jenkins hay file `.gitlab-ci.yml` từ Hive.
