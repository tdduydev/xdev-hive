# Feature Specification: Bảng điều khiển CI/CD và triển khai lên máy chủ

**Feature Branch**: `020-cicd-console`

**Created**: 2026-10-17

**Status**: Draft. Chủ dự án đã chốt Q1–Q16 ngày 2026-10-17.

**Input**: Chủ dự án chốt ngày 2026-10-17, hướng **A + C**:
- **A:** Hive là bảng điều khiển trên CI sẵn có (GitLab CI, Jenkins): xem pipeline và job, log, chạy lại, huỷ, bấm job
  chờ tay, duyệt, báo khi đỏ. **Không** thay GitLab CI hay Jenkins.
- **C:** Hive quản lý việc triển khai:
  - máy chủ và khoá SSH;
  - môi trường;
  - nút "Triển khai": sao lưu trước, kiểm health sau, quay về bản cũ được;
  - lịch sử triển khai.
  Triển khai đi bằng SSH tới máy chủ Ubuntu, bằng job Jenkins, job GitLab, Argo CD hoặc Kubernetes.
- Viết spec và kế hoạch trước, chưa code.

Bối cảnh (chi tiết ở [research.md](research.md)):
- eHospital build và deploy bằng **Jenkins** (Harbor, GitOps, Argo CD, RKE2). GitLab CI chỉ chạy kiểm tra.
- Hub Hive chạy trên một máy **Ubuntu riêng** (`hc-his-app`), không thuộc hạ tầng eHospital. Hiện triển khai bằng script
  qua SSH với docker compose.

**Kế hoạch**: [plan.md](plan.md) · **Nghiên cứu**: [research.md](research.md)

## Câu hỏi đã chốt

Chủ dự án trả lời ngày 2026-10-17. Cột "Khác khuyến nghị" đánh dấu chỗ chủ dự án chọn khác đề xuất ban đầu.

| # | Câu hỏi | Đã chốt | Khác khuyến nghị |
|---|---|---|---|
| Q1 | Lệnh triển khai qua SSH chạy ở đâu? | **Hub tự SSH** tới máy chủ. Hub phải vào được mạng của máy chủ đích | Có. Khuyến nghị cũ là máy runner của đội |
| Q2 | Khoá SSH nằm ở đâu? | **Hub giữ khoá riêng, mã hoá** bằng `platform/secrets.ts`. Hub sinh khoá cho từng máy chủ; người quản trị cài khoá công khai lên máy chủ | Có. Khuyến nghị cũ là khoá nằm trên máy runner |
| Q3 | Hub đăng nhập Jenkins bằng gì? | **Token từng người**: mỗi người tự thêm user và API token Jenkins của mình. Jenkins ghi đúng người bấm. Ai chưa có token thì chỉ xem | Có. Khuyến nghị cũ là tài khoản dịch vụ |
| Q4 | Hub biết trạng thái mới thế nào? | GitLab: thêm sự kiện Pipeline và Job vào webhook, kèm hỏi lại theo lịch. Jenkins: hub hỏi API (15 giây khi có build chạy, 5 phút khi rảnh) | |
| Q5 | Môi trường gắn với gì? | **Hệ thống**. Mỗi dự án có một đích triển khai ở mỗi môi trường | |
| Q6 | Các cách triển khai của bản đầu | `ssh-script`, `jenkins-job`, `gitlab-manual`, **`argocd`**, **`kubectl`** | Có: thêm Argo CD và Kubernetes ngay bản đầu |
| Q7 | Duyệt | `dev` không cần, `staging` tuỳ chọn, `prod` bắt buộc 1 người duyệt có quyền và khác người yêu cầu | |
| Q8 | Quay về bản cũ | Triển khai lại bản thành công gần nhất trước đó. Không hoàn tác dữ liệu | |
| Q9 | Sao lưu trước khi triển khai | Tuỳ chọn từng đích; "Bỏ qua sao lưu lần này" có ghi audit | |
| Q10 | Phiên bản | Commit SHA kèm tag Git; Jenkins thêm số build và tag image nếu job báo; `kubectl`/`argocd` thêm tag image và revision | |
| Q11 | GitHub Actions | Để đợt sau | |
| Q12 | Log | Log CI đọc trực tiếp từ nguồn, không lưu. Log triển khai lưu ở Hive theo hạn giữ log run của tổ chức (`runLogRetentionDays`, mặc định 365 ngày) | |
| Q13 | Lần Jenkins tự build (không qua Hive) | **Có** hiện trên bảng "đang chạy" và lịch sử, ghi là "ngoài Hive" | |
| Q14 | Máy runner có chạy agent không | Không. **Không áp dụng ở bản đầu** vì Q1 chọn hub tự SSH; giữ làm ràng buộc nếu sau này thêm máy runner | |
| Q15 | Job promote chọn phiên bản thế nào | "Đẩy từ môi trường": lấy số build đang chạy ở môi trường nguồn. Đích promote không có "Quay về" trừ khi có job quay về riêng | |
| Q16 | Máy nào làm runner | Máy Linux dùng chung. **Không áp dụng ở bản đầu** (Q1); giữ cho khi thêm máy runner | |

**Hệ quả của Q1, Q2:**
- Hub giữ khoá vào mọi máy chủ đã khai báo, nên `HIVE_MASTER_KEY` và database của hub thành tài sản cần bảo vệ nhất.
- Hub phải vào được cổng SSH của máy chủ đích. Từ `hc-his-app` mới đo HTTP tới Jenkins, Harbor, Gitea, GitLab. Cổng 22
  của các máy `10.205.76.x` **chưa đo** (research mục 2).
- Khi hub triển khai lại chính nó, tiến trình hub bị khởi động lại giữa chừng. Vì vậy các bước phải chạy **tách khỏi phiên
  SSH** trên máy chủ (FR-016).

**Hệ quả của Q3:** việc hỏi Jenkins theo lịch vẫn cần một token. Bản đầu dùng token của một người được chọn làm "người
theo dõi" của kết nối, mặc định là người tạo kết nối (FR-001). Token này chỉ dùng để đọc.

## Hiện trạng: dùng lại, mở rộng, làm mới

Khảo sát code ngày 2026-10-17 trên `main` tại `9947aeb1`. Chi tiết ở [research.md](research.md) mục 3.

| Phần | Dùng thế nào |
|---|---|
| `scm`: kết nối, token mã hoá, webhook `/hooks/git/:projectId`, `archive`, `compare` | **Mở rộng**: thêm vào `GitProvider` các thao tác pipeline/job (GitLab), workflow run/job (GitHub, đợt sau); đăng ký thêm sự kiện Pipeline và Job cho hook GitLab; `compare` trả thêm danh sách commit |
| `platform/secrets.ts` (AES-256-GCM, khoá bọc bởi `HIVE_MASTER_KEY`) | **Dùng lại** cho khoá SSH, token Jenkins từng người, token Argo CD, token Kubernetes |
| `runs/stream.ts` (log `bytea` + `LISTEN/NOTIFY` + SSE) | **Dùng lại cách làm** cho log triển khai (bảng riêng, vì lần triển khai không phải run của máy) |
| `audit`, `notify` | **Dùng lại**, thêm sự kiện CI và triển khai |
| `catalog`: hệ thống, dự án | **Dùng lại** làm gốc cho môi trường (hệ thống) và đích triển khai (dự án) |
| `contracts/roles.ts` | **Mở rộng**: quyền mới (FR-028) |
| Web: `LogCard`, `use-run-stream` | **Dùng lại** cho log triển khai |
| `secret-scan.ts` | Chỉ phát hiện, không che. **Làm mới** hàm che dùng chung bộ mẫu |
| Jenkins, Argo CD, Kubernetes, SSH | **Làm mới**: chưa có gì trong Hive |
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
2. **Given** một build Jenkins đang chạy, **When** mở chi tiết, **Then** log hiện tiếp với độ trễ ≤ 15 giây, các giai đoạn
   của pipeline Jenkins hiện trạng thái riêng.
3. **Given** người không có quyền `ci.view`, **Then** không thấy tab và không gọi được API.
4. **Given** kết nối Jenkins chưa có người theo dõi có token, **Then** phần Jenkins báo "Chưa có token để đọc Jenkins" kèm
   nút thêm token.

---

### User Story 2 - Thao tác trên CI bằng token của chính mình (Priority: P1)

Người có quyền `ci.operate` và **đã thêm token Jenkins của mình** bấm:
- **Chạy lại**: pipeline hoặc job GitLab, build Jenkins;
- **Huỷ**;
- **Chạy** job chờ tay của GitLab;
- **Build with Parameters** của Jenkins, form sinh từ tham số khai báo của job;
- **Tiếp tục/Dừng** ở bước `input` của Jenkins.

**Why this priority**: không thao tác được thì Hive chỉ là màn xem.

**Acceptance Scenarios**:

1. **Given** job Jenkins có tham số `APP`, `FROM_ENV`, `TO_ENV`, `BUILD`, **When** bấm Build with Parameters, **Then** form
   có đúng các tham số đó (kiểu, giá trị mặc định, danh sách chọn), build được tạo bằng token của người bấm, và Jenkins
   ghi người đó là người kích hoạt.
2. **Given** người chưa thêm token Jenkins, **Then** các nút thao tác Jenkins tắt kèm hướng dẫn "Thêm token Jenkins của
   bạn ở Cài đặt cá nhân".
3. **Given** bất kỳ thao tác nào, **Then** có bản ghi audit trên Hive.
4. **Given** thao tác thất bại vì thiếu quyền ở Jenkins hay GitLab, **Then** báo lỗi tiếng Việt nói thiếu quyền gì, ở
   đâu.

---

### User Story 3 - Máy chủ, khoá SSH, môi trường (Priority: P1)

Quản trị (`servers.manage`) khai báo **máy chủ**: tên, địa chỉ, cổng, user, nhãn. Hub **sinh một cặp khoá ed25519** cho máy
chủ đó, giữ khoá riêng (mã hoá) và hiện **khoá công khai** kèm lệnh cài lên máy chủ. Sau khi cài:
1. bấm "Kiểm kết nối";
2. hub kết nối, hiện **dấu vân tay host key** để quản trị xác nhận;
3. lưu.

Quản trị tạo **môi trường** cho hệ thống (`dev`, `staging`, `prod`), rồi khai báo **đích triển khai** cho từng dự án ở từng
môi trường.

**Acceptance Scenarios**:

1. **Given** khoá công khai đã cài trên máy chủ, **When** bấm "Kiểm kết nối", **Then** thấy kết quả SSH bằng khoá, hệ điều
   hành, phiên bản Docker và Compose, dung lượng đĩa còn trống.
2. **Given** host key khác với dấu vân tay đã lưu, **When** kết nối, **Then** dừng ngay, báo "Host key của máy chủ đã đổi",
   không chạy lệnh nào.
3. **Given** hub không vào được cổng SSH, **Then** báo "Hub không kết nối được <địa chỉ>:<cổng>" kèm gợi ý kiểm tường lửa,
   phân biệt với lỗi xác thực.
4. **Given** quản trị bấm "Đổi khoá", **Then** hub sinh khoá mới, khoá cũ vẫn dùng được tới khi quản trị xác nhận khoá mới
   đã cài và kiểm thành công.

---

### User Story 4 - Triển khai lên máy chủ Ubuntu (Priority: P1)

Người có quyền `deploy.run` mở môi trường `dev`, chọn dự án, chọn phiên bản (commit hoặc tag; mặc định commit mới nhất của
nhánh đã cấu hình), bấm **Triển khai**. Hub kết nối máy chủ và chạy lần lượt:
1. kiểm host key và bước "kiểm trước" (thư mục, compose project, `.env` có sẵn);
2. sao lưu (nếu bật);
3. đưa mã lên (tải mã của commit từ GitLab/GitHub rồi gửi qua SSH);
4. lệnh triển khai;
5. kiểm health từ hub (URL, mã mong đợi, chuỗi phiên bản nếu có), thử lại trong thời gian chờ.

Các bước 2–4 chạy **tách khỏi phiên SSH** trên máy chủ, nên hub khởi động lại cũng không làm dở bước (FR-016). Log hiện
trực tiếp. Xong thì cập nhật bảng "đang chạy".

**Why this priority**: đây là phần C, đúng các bước đã làm tay cho hub ngày 2026-10-17.

**Independent Test**: máy chủ SSH trong container (OpenSSH, lệnh `docker` giả) trong test tích hợp của hub. Kiểm thứ tự bước,
dừng khi một bước lỗi, log, trạng thái, nối lại sau khi tiến trình hub khởi động lại.

**Acceptance Scenarios**:

1. **Given** đích `ssh-script` cho hub (`/home/adminvm/xdev-hive`, project `xdev-hive`, health
   `https://hive.xdev.asia/api/v1/health` chứa phiên bản), **When** triển khai một commit mới, **Then** chạy đủ các bước,
   hub khởi động lại giữa chừng, sau khi lên lại vẫn đọc tiếp log, health báo đúng phiên bản, lần triển khai `thành công`.
2. **Given** bước sao lưu lỗi, **Then** không chạy bước triển khai; lần triển khai `thất bại`, ghi rõ bước và lỗi.
3. **Given** health không đạt trong thời gian chờ, **Then** lần triển khai `thất bại, cần xem`; Hive gợi ý "Quay về bản
   trước" (US6), không tự quay về.
4. **Given** đang có một lần triển khai ở cùng đích, **When** bấm triển khai lần nữa, **Then** bị chặn: "Đang triển khai
   bởi <người> từ <giờ>".

---

### User Story 5 - Triển khai qua Jenkins, GitLab, Argo CD, Kubernetes (Priority: P1)

Cùng nút **Triển khai** nhưng đích dùng cách khác:
- **`jenkins-job`**: bấm job kèm tham số bằng token của người yêu cầu, theo dõi build, ghi phiên bản (commit, số build, tag
  image nếu job báo). Loại "đẩy từ môi trường" lấy số build đang chạy ở môi trường nguồn (Q15).
- **`gitlab-manual`**: chạy job chờ tay trong pipeline của commit được chọn.
- **`argocd`**: đồng bộ một application (tuỳ chọn tới một revision), theo dõi sync và health.
- **`kubectl`**: đổi image của một Deployment hoặc StatefulSet, theo dõi rollout tới khi đủ bản sẵn sàng.

**Acceptance Scenarios**:

1. **Given** đích `jenkins-job` ở `dev`, **When** triển khai, **Then** build tạo bằng token của người yêu cầu, xanh thì
   lần triển khai `thành công` với số build và commit.
2. **Given** đích `argocd` cho app `his-portal`, **When** triển khai, **Then** Hive gọi sync, chờ trạng thái `Synced` và
   `Healthy` trong thời gian chờ, ghi revision và image đang chạy.
3. **Given** đích `kubectl` cho Deployment `his-portal/his-portal`, **When** triển khai image `dev-123`, **Then** Hive đổi
   image, chờ rollout xong (số bản cập nhật và sẵn sàng bằng số bản mong muốn), ghi image.
4. **Given** người yêu cầu chưa có token Jenkins, **Then** không triển khai được đích `jenkins-job`, có hướng dẫn thêm
   token.

---

### User Story 6 - Duyệt và khoá môi trường (Priority: P2)

Triển khai lên `prod` cần một người duyệt (Q7). Người duyệt nhận thông báo, xem phiên bản sẽ lên và danh sách commit so với
bản đang chạy, rồi bấm **Duyệt** hoặc **Từ chối** kèm lý do. Quản trị **khoá** được một môi trường, khi đó mọi lần triển
khai bị chặn.

**Acceptance Scenarios**:

1. **Given** người yêu cầu cũng có quyền duyệt, **Then** không tự duyệt được.
2. **Given** yêu cầu chờ duyệt quá 24 giờ, **Then** hết hạn, phải tạo lại.
3. **Given** đích `jenkins-job` có bước `input` (vd. `ehosPromote` lên prod), **When** người duyệt bấm Duyệt trên Hive,
   **Then** Hive bấm Proceed bằng **token của người duyệt**; từ chối thì bấm Abort. Người duyệt chưa có token thì không
   duyệt được bước này.

---

### User Story 7 - Quay về bản trước (Priority: P2)

Trên bảng "đang chạy", bấm **Quay về bản trước** ở một đích: Hive tạo lần triển khai mới với bản thành công gần nhất trước
đó (Q8), đi qua đúng quy trình duyệt của môi trường. Với `argocd`, Hive dùng rollback theo lịch sử của application. Với
`kubectl`, Hive đặt lại image của bản trước.

**Acceptance Scenarios**:

1. **Given** lịch sử có A (thành công), B (thất bại, cần xem), **When** quay về, **Then** triển khai lại A, lần triển
   khai ghi "quay về từ B".
2. **Given** không có bản thành công trước đó, hoặc đích là promote không có job quay về, **Then** nút tắt kèm lý do.

---

### User Story 8 - Thông báo (Priority: P2)

Quản trị cấu hình kênh sẵn có của tổ chức (Telegram, email) nhận báo theo loại sự kiện và hệ thống. Người liên quan (người
yêu cầu, người duyệt) nhận vào hộp thư trong app. Báo cho:
- pipeline/build **đỏ** trên nhánh chính, và khi xanh lại;
- triển khai bắt đầu, thành công, thất bại;
- yêu cầu duyệt mới;
- host key đổi.

**Acceptance Scenarios**:

1. **Given** build Jenkins `build-dev` đỏ, **Then** kênh đã cấu hình nhận một tin có tên job, commit, link log. Cùng một
   lỗi đỏ liên tiếp không gửi lặp.

---

### User Story 9 - GitHub Actions (Priority: P3, Q11)

Như US1–US2 cho dự án trên GitHub: workflow run, job, log, chạy lại, huỷ, duyệt deployment chờ duyệt.

### Edge Cases

- Jenkins, GitLab, Argo CD hoặc Kubernetes không trả lời: tab và bảng hiện dữ liệu lần cuối kèm giờ và cảnh báo; không
  chặn phần khác.
- Token Jenkins của một người hết hạn: chỉ thao tác của người đó báo lỗi, kèm nút cập nhật token. Token của người theo
  dõi hết hạn: phần Jenkins báo "Không đọc được Jenkins" cho mọi người, quản trị chọn người theo dõi khác.
- Job Jenkins hoặc application Argo CD bị đổi tên hay xoá: liên kết báo "không tìm thấy".
- Hub khởi động lại khi đang triển khai (do triển khai chính nó, hoặc lý do khác): các bước vẫn chạy trên máy chủ. Hub lên
  lại thì đọc tiếp log và trạng thái từ máy chủ (FR-016).
- Hub không đọc được trạng thái trên máy chủ sau 15 phút (máy chủ tắt, mất mạng): lần triển khai `không rõ kết quả`. Không
  tự chạy lại; người dùng kiểm health rồi quyết định.
- Lệnh trong bước có thể in secret: hub che bí mật trước khi lưu và hiện log (FR-019).
- Hai người sửa cùng một đích triển khai: khoá lạc quan theo phiên bản cấu hình.
- Đích `ssh-script` khai báo thư mục sai (như suýt gặp với `/opt/xdev-hive`): bước "kiểm trước" so thư mục, compose
  project, `.env` có sẵn với cấu hình; không khớp thì dừng.
- Argo CD application đang tự sync (`autoSync`, như `dev` của eHospital): rollback của Argo CD tắt autoSync. Hive cảnh báo
  trước khi quay về.

## Requirements *(mandatory)*

### Functional Requirements

**Kết nối CI và hạ tầng**

- **FR-001**: Quản trị tổ chức (`ci.connections.manage`) thêm **kết nối Jenkins**: tên, URL. Mỗi người thêm **token Jenkins
  của mình** (user + API token) cho từng kết nối, mã hoá bằng `platform/secrets.ts`. Kết nối có một **người theo dõi**:
  token của người này dùng để đọc theo lịch (hỏi trạng thái, phát hiện build "ngoài Hive"). Mặc định là người tạo kết
  nối; đổi được. Kiểm token bằng `GET /me/api/json`.
- **FR-002**: Dự án gắn được 0..n **job Jenkins** (đường dẫn job, kể cả folder và multibranch) và dùng repo GitLab/GitHub
  sẵn có của dự án.
- **FR-003**: `GitProvider` thêm:
  - liệt kê pipeline (lọc nhánh, trạng thái, phân trang), job của pipeline, log job (theo đoạn, từ vị trí);
  - chạy lại pipeline hoặc job, huỷ, chạy job chờ tay;
  - `compare` trả thêm danh sách commit;
  - GitHub (đợt sau, Q11): workflow run, job, log, chạy lại, huỷ, duyệt deployment chờ duyệt.
- **FR-004**: Webhook GitLab của dự án đăng ký thêm sự kiện Pipeline và Job; hub xử lý bằng `onScmEvent`. Có hỏi lại theo
  lịch để không lỡ sự kiện (Q4).
- **FR-005**: Client Jenkins:
  - đọc job (tham số khai báo), build (trạng thái, nguyên nhân, commit, thời lượng);
  - giai đoạn qua `wfapi/describe` khi có plugin Pipeline Stage View;
  - log theo đoạn qua `logText/progressiveText`;
  - bấm build có tham số, dừng build, Proceed/Abort bước `input`.
  Mọi thao tác ghi dùng token của người bấm (Q3); đọc theo lịch dùng token của người theo dõi.
- **FR-006**: Quản trị tổ chức thêm **kết nối Argo CD** (URL, token) và **kết nối Kubernetes** (URL API server, CA, token
  ServiceAccount), mã hoá. Kiểm bằng một lệnh đọc (`/api/v1/applications?limit=1`, `/version`).

**Xem và thao tác CI**

- **FR-007**: Tab CI/CD gộp pipeline GitLab/GitHub và build Jenkins của dự án vào một danh sách: nguồn, nhánh, commit,
  trạng thái, thời lượng, người kích hoạt, link gốc.
- **FR-008**: Log CI đọc trực tiếp từ nguồn khi mở, không lưu (Q12). Hiện theo đoạn, tự cuộn, tìm trong log.
- **FR-009**: Thao tác ở FR-003, FR-005 cần quyền `ci.operate`. Mỗi thao tác ghi `recordAudit` gồm người bấm, nguồn, đối
  tượng, tham số (tham số kiểu password của Jenkins không ghi giá trị).

**Máy chủ, môi trường, đích triển khai**

- **FR-010**: **Máy chủ** thuộc đội:
  - tên, địa chỉ, cổng, user, nhãn;
  - dấu vân tay host key đã xác nhận;
  - cặp khoá ed25519 do hub sinh: khoá riêng mã hoá, khoá công khai hiện được (Q2).
  Không nhập mật khẩu máy chủ vào Hive. Không có chức năng xuất khoá riêng ra ngoài.
- **FR-011**: "Kiểm kết nối" chạy từ hub: SSH bằng khoá, đọc host key, hệ điều hành, phiên bản Docker và Compose, đĩa trống.
  Lần đầu, quản trị xác nhận dấu vân tay hiện ra. "Đổi khoá" theo US3 bước 4.
- **FR-012**: **Môi trường** thuộc hệ thống: tên, thứ tự (dev → staging → prod), chính sách duyệt (Q7), danh sách vai trò
  được triển khai và được duyệt, khoá/mở.
- **FR-013**: **Đích triển khai** = dự án × môi trường, với một trong năm cách (Q6):
  - `ssh-script`: máy chủ; thư mục làm việc; compose project; các bước "kiểm trước", "sao lưu" (tuỳ chọn), "đưa mã lên",
    "triển khai"; health; thời gian chờ từng bước; biến (đánh dấu được là bí mật);
  - `jenkins-job`: kết nối, job, tham số cố định và tham số lấy từ lần triển khai (`{{commit}}`, `{{tag}}`, `{{env}}`);
    loại "đẩy từ môi trường" (FR-034);
  - `gitlab-manual`: tên job chờ tay trong pipeline của commit được chọn;
  - `argocd`: kết nối, tên application, có đồng bộ tới revision của lần triển khai hay không;
  - `kubectl`: kết nối, namespace, loại và tên workload, tên container, mẫu image (vd.
    `harbor.ehospital-v3.azladin.com/his/his-portal:{{tag}}`).
- **FR-014**: Cấu hình đích có phiên bản. Mỗi lần sửa ghi audit kèm khác biệt. Lần triển khai lưu phiên bản cấu hình đã
  dùng. Chỉ người có `servers.manage` sửa lệnh và cấu hình (FR-030).

**Triển khai**

- **FR-015**: Lần triển khai có các trạng thái:
  - đang đi: `chờ duyệt`, `chờ`, `đang chạy`;
  - kết thúc: `thành công`, `thất bại`, `thất bại, cần xem`, `không rõ kết quả`, `đã huỷ`, `bị từ chối`, `hết hạn`.

  Mỗi bước có trạng thái, giờ bắt đầu và kết thúc, mã thoát. Một đích chỉ có một lần triển khai **do Hive tạo** đang đi tại
  một thời điểm.
- **FR-016**: `ssh-script` chạy từ hub (Q1):
  - kết nối với host key cố định; sai dấu vân tay thì dừng trước mọi lệnh;
  - hub gửi một script chạy bước lên máy chủ (thư mục riêng của lần triển khai), khởi động **tách khỏi phiên SSH**;
    script ghi log và trạng thái từng bước ra file;
  - hub đọc log và trạng thái bằng các phiên SSH ngắn, lưu vị trí đã đọc. Hub khởi động lại thì đọc tiếp từ vị trí đó;
  - dừng ở bước lỗi đầu tiên; huỷ thì gửi tín hiệu dừng tới script trên máy chủ;
  - dọn thư mục của lần triển khai trên máy chủ sau 14 ngày.
- **FR-017**: "Đưa mã lên":
  - `git-archive`: hub lấy tarball của commit qua `scm.archive`, gửi qua SSH và giải nén vào thư mục đã cấu hình;
  - `none`: bước triển khai tự kéo image hoặc mã.
- **FR-018**: Health:
  - hub gọi URL;
  - mã HTTP mong đợi, có thể thêm biểu thức JSON phải khớp (vd. `version == <commit 8 ký tự>`);
  - thử lại theo chu kỳ trong thời gian chờ (mặc định 3 phút).
- **FR-019**: Log của lần triển khai (mọi cách) lưu trong bảng log riêng (`bytea` theo đoạn), xem trực tiếp bằng SSE như log
  run, giữ theo Q12. Trước khi lưu, hub che bí mật: giá trị của biến đánh dấu bí mật, cộng các mẫu của `secret-scan.ts`.
- **FR-020**: Bảng **đang chạy** của hệ thống: dòng là dự án, cột là môi trường, ô là phiên bản thành công gần nhất (commit,
  tag, số build, image, revision), giờ, người hoặc "ngoài Hive", kết quả health lần cuối.
- **FR-021**: `jenkins-job`: bấm job bằng token của người yêu cầu, theo dõi build như FR-005. Xanh thì `thành công`, đỏ thì
  `thất bại`. Phiên bản lấy từ tham số, commit của build, và dòng `HIVE_DEPLOYED_IMAGE=…` trong log nếu có.
- **FR-022**: `gitlab-manual`: chạy job chờ tay của pipeline ở commit được chọn bằng token kết nối GitLab của dự án, theo
  dõi như FR-003.
- **FR-023**: `argocd`:
  - triển khai = `sync` (tuỳ chọn tới revision);
  - chờ `Synced` và `Healthy` trong thời gian chờ;
  - ghi revision và danh sách image từ trạng thái application;
  - quay về dùng `rollback` theo id lịch sử của application, kèm cảnh báo tắt autoSync.
- **FR-024**: `kubectl` (gọi API Kubernetes, không dùng binary `kubectl`):
  - triển khai = đổi image của container trong workload;
  - chờ rollout xong: `observedGeneration` mới, số bản cập nhật và sẵn sàng bằng số mong muốn;
  - quay về = đặt lại image của lần thành công trước.
- **FR-025**: Build xanh của job Jenkins gắn với một đích `jenkins-job` mà không do Hive bấm được ghi thành lần triển khai
  "ngoài Hive" (Q13). Không có người yêu cầu, có người kích hoạt theo Jenkins. Tính vào "đang chạy" và quay về; không tính
  vào khoá "một lần đang đi".

**Duyệt, khoá, quay về (P2)**

- **FR-026**: Chính sách duyệt theo môi trường (Q7):
  - số người duyệt;
  - vai trò được duyệt;
  - người yêu cầu không tự duyệt;
  - hạn chờ (mặc định 24 giờ).
  Màn duyệt hiện danh sách commit giữa bản đang chạy và bản sẽ lên (FR-003).
- **FR-027**: Khoá môi trường: quản trị bật hoặc tắt kèm lý do. Khi khoá, mọi lần triển khai mới bị chặn, kể cả quay về.
- **FR-028**: Quay về bản trước theo Q8 và US7, đi qua duyệt như lần triển khai thường.
- **FR-029**: `jenkins-job` có bước `input`: người duyệt bấm Duyệt trên Hive thì Hive bấm Proceed bằng token của người
  duyệt; Từ chối thì Abort (Q3, Q7).

**Thông báo, quyền, an toàn**

- **FR-030**: Quyền mới trong `contracts/roles.ts`, cấp theo vai trò tổ chức và đội như hiện nay:
  - `ci.view`, `ci.operate`, `deploy.run`, `deploy.approve`, `servers.manage` (đội);
  - `ci.connections.manage` (tổ chức).

  Gán mặc định: quản trị đội có tất cả quyền của đội; thành viên đội có `ci.view`, `ci.operate`, `deploy.run`. Môi trường
  giới hạn thêm bằng danh sách vai trò của nó (vd. `prod`: chỉ quản trị đội triển khai và duyệt). Lệnh và cấu hình đích
  chỉ người có `servers.manage` sửa; người `deploy.run` chỉ chọn phiên bản và chạy.
- **FR-031**: Thêm sự kiện vào `notify`:
  - `ci.failed` (nhánh chính), `ci.recovered`;
  - `deploy.started`, `deploy.succeeded`, `deploy.failed`;
  - `deploy.approval_requested`;
  - `server.hostkey_changed`.

  Không gửi lặp cùng một lỗi đỏ liên tiếp.
- **FR-032**: Khoá SSH riêng, token Jenkins, token Argo CD, token Kubernetes chỉ được giải mã trong bộ nhớ lúc dùng, không ghi
  log, không trả về qua API. Đọc, dùng, đổi khoá đều có audit.
- **FR-033**: Mọi bảng mới có `org_id`, bật và ép RLS, truy cập qua `withTenant()`. Chữ giao diện và lỗi tiếng Việt.
- **FR-034**: `jenkins-job` loại "đẩy từ môi trường" (Q15): chọn môi trường nguồn; Hive điền tham số build (vd. `BUILD`)
  bằng số build của bản đang chạy ở nguồn. Không có "Quay về" trừ khi cấu hình một job quay về riêng.
- **FR-035**: Thao tác GitLab đi bằng token kết nối GitLab của dự án, theo quyền Hive. Hive không ánh xạ người dùng Hive sang
  người dùng GitLab ở bản đầu; audit ghi người bấm thật.

### Key Entities

- **Kết nối Jenkins** (`ci_jenkins_connections`): tổ chức, tên, URL, người theo dõi.
- **Token Jenkins của người dùng** (`ci_jenkins_user_tokens`): kết nối, người dùng, user Jenkins, token mã hoá, lần kiểm cuối.
- **Kết nối Argo CD, Kubernetes** (`deploy_connections`): tổ chức, loại, tên, URL, CA (Kubernetes), token mã hoá.
- **Liên kết job** (`ci_project_jobs`): dự án, kết nối, đường dẫn job.
- **Trạng thái CI đã thấy** (`ci_runs_seen`): nguồn, id, trạng thái cuối, giờ, trạng thái đã báo. Không chứa log.
- **Máy chủ** (`deploy_servers`): đội, tên, địa chỉ, cổng, user, nhãn, dấu vân tay, khoá riêng mã hoá, khoá công khai, khoá
  đang chờ đổi.
- **Môi trường** (`deploy_environments`): hệ thống, tên, thứ tự, chính sách duyệt, vai trò được triển khai và duyệt, khoá.
- **Đích triển khai** (`deploy_targets`): dự án, môi trường, cách, cấu hình (JSON có phiên bản), máy chủ hoặc kết nối.
- **Lần triển khai** (`deploys`): đích, phiên bản, nguồn gốc (`hive` | `external`), người yêu cầu, trạng thái, các bước,
  vị trí log đã đọc trên máy chủ, build/job/application ngoài, phiên bản cấu hình, `rollback_of`.
- **Log triển khai** (`deploy_log_chunks`): lần triển khai, thứ tự, dữ liệu (`bytea`, đã che bí mật).
- **Duyệt** (`deploy_approvals`): lần triển khai, người, quyết định, lý do, giờ.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Với ≥ 20 job Jenkins và 5 dự án GitLab, tab CI/CD mở trong ≤ 2 giây (dữ liệu đã đệm). Trạng thái mới hiện
  trong ≤ 30 giây với Jenkins và ≤ 10 giây với GitLab khi webhook tới được.
- **SC-002**: Triển khai lại hub `hive.xdev.asia` bằng Hive (đích `ssh-script`) đi đủ các bước như lần làm tay ngày
  2026-10-17, không cần mở terminal, thời gian ≤ lần làm tay + 1 phút.
- **SC-003**: 100% thao tác CI và triển khai có bản ghi audit với người bấm thật. Thao tác Jenkins hiện đúng người bấm trên
  Jenkins (Q3).
- **SC-004**: Host key đổi thì không lệnh nào chạy (test có kiểm).
- **SC-005**: Không có secret nào xuất hiện trong log đã lưu, với bộ mẫu chứa mật khẩu và token giả.
- **SC-006**: Lên `prod` không thể không có người duyệt khác người yêu cầu (test quyền).
- **SC-007**: Tiến trình hub bị dừng giữa lúc triển khai (kể cả triển khai chính nó) thì lần triển khai vẫn có kết quả
  đúng sau khi hub lên lại. Có test tích hợp dừng tiến trình hub giữa bước.
- **SC-008**: Khoá SSH riêng không xuất hiện trong log, phản hồi API, hay bản sao lưu ở dạng chưa mã hoá (test và rà
  soát).

## Assumptions

- Hub vào được cổng SSH của máy chủ đích, và vào được Jenkins, GitLab, Argo CD, API Kubernetes. Mới đo được HTTP tới
  Jenkins, Harbor, Gitea, GitLab từ `hc-his-app` (research mục 2). Cổng 22 và API Kubernetes của mạng `10.205.76.x`, cùng
  địa chỉ Argo CD, chưa đo.
- Người quản trị tự cài khoá công khai do hub sinh lên máy chủ (bằng tay, hoặc bằng tính năng SSH của desktop nếu nó hỗ trợ
  cài một khoá công khai cho trước). Spec này không nhập mật khẩu máy chủ.
- PostgreSQL vẫn là kho duy nhất (ADR 0003). Không thêm dịch vụ.
- Jenkins Keycloak OIDC của eHospital cho phép người dùng tạo API token. [Unverified] Kiểm khi làm task.

## Out of Scope

- Tự chạy pipeline thay GitLab CI hay Jenkins (hướng B đã loại).
- Máy runner cho triển khai (Q14, Q16): để sau, khi hub không vào được mạng của máy chủ.
- Helm; ghi trực tiếp vào repo GitOps; đọc tag image từ Harbor.
- Hoàn tác database khi quay về (Q8).
- Quản lý secret của ứng dụng trên máy chủ (`.env` vẫn nằm trên máy chủ).
- Lịch triển khai tự động theo giờ.
- Tạo job Jenkins hay file `.gitlab-ci.yml` từ Hive.
