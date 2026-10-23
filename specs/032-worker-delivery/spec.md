# Feature Specification: Chạy CI/CD và triển khai trên worker trong mạng nội bộ, hub chỉ giữ cấu hình và lịch sử

**Feature Branch**: `ai/SPEC032` (số feature `032-worker-delivery`)

**Created**: 2026-10-23

**Status**: Draft. Có 3 câu hỏi mở cần chủ dự án (mục "Câu hỏi mở"), mỗi câu có khuyến nghị. Spec đã chọn mặc định theo khuyến nghị.

**Input**: "Chạy CI/CD và triển khai trên worker trong mạng nội bộ, hub chỉ giữ cấu hình và lịch sử".

## Vì sao làm

Module `delivery` của hub (spec 020) hiện tự gọi Jenkins, Argo CD, Kubernetes, SSH, health và GitLab từ tiến trình hub.
SOC của công ty cấm hub mở kết nối vào máy nội bộ. Lần đo T006 ngày 2026-10-19 bị coi là quét SSH
(`apps/hub/src/modules/delivery/clients/outbound.ts`). Vì thế hub production đặt `HIVE_DELIVERY_OUTBOUND=0`
(`apps/hub/src/modules/platform/config.ts:209`, mặc định tắt).

Hậu quả khi công tắc tắt: mọi client của delivery dừng trước khi mở socket. Các trang web "Kết nối CI", "Máy chủ triển
khai", "Jenkins token", "Bảng deploy" mở được nhưng không chạm được máy nào. Tính năng CI/CD không dùng được ở nơi cần
nó nhất.

Chiến lược sản phẩm (spec 027): hub chỉ điều phối, lưu dữ liệu và tiến độ, không chạy agent, không gọi ra ngoài. Client
(app desktop, `hive-worker`) làm việc trên máy người dùng. Worker đã kết nối **ra** hub qua WSS. CI/CD là phần còn lại
của delivery chưa theo mô hình này.

Spec này chuyển mọi đường chạy của delivery sang worker. Hub giữ cấu hình (không có secret), hàng đợi, duyệt, trạng thái
và lịch sử. Thông tin đăng nhập (SSH key, token Jenkins, Argo CD, Kubernetes) nằm trong kho bí mật của hệ điều hành trên
máy worker, dùng lại kho của spec 031.

## Câu hỏi mở

Ba câu cần chủ dự án quyết. Spec đã chọn mặc định theo khuyến nghị để không chặn plan.

| # | Câu hỏi | Khuyến nghị | Ghi ở |
|---|---|---|---|
| Q1 | Khi lần triển khai lỗi, hub có được nhận một đoạn log ngắn (20 dòng cuối, đã che bí mật) để admin xem trên web không? | **Không.** Hub chỉ nhận mã lỗi, tên bước, mã thoát và một câu tóm tắt tối đa 200 ký tự. Log đầy đủ ở lại máy, theo spec 027 Q3 | FR-052 |
| Q2 | Khi `HIVE_DELIVERY_OUTBOUND=1`, giữ đường hub chạy trực tiếp hay bỏ? | **Giữ làm đường cũ ("legacy") 2 bản phát hành, mặc định tắt, ghi cảnh báo mỗi lần dùng, rồi gỡ.** Môi trường đã chuyển sang worker thì hub không chạy hộ nữa | FR-081, FR-082 |
| Q3 | Môi trường `prod` có được chạy trên máy cá nhân của dev không? | **Không mặc định.** Admin đánh dấu máy là "runner triển khai" (nhãn). Môi trường có thể đòi nhãn đó. Máy cá nhân chỉ chạy dev/staging trừ khi admin bỏ đòi hỏi | FR-012 |

## Hiện trạng: dùng lại, mở rộng, làm mới

Đã kiểm trong code ngày 2026-10-23 (nhánh `ai/SPEC032`, dựa trên `main`):

| Phần | Có gì | Spec này |
|---|---|---|
| Công tắc ra ngoài | `clients/outbound.ts` (`setDeliveryOutbound`), `HIVE_DELIVERY_OUTBOUND` mặc định tắt; client `jenkins.ts`, `argocd.ts`, `kube.ts`, `ssh.ts`, `deploys/health.ts` đều kiểm công tắc trước khi mở socket | Đổi: mặc định đi qua worker, công tắc chỉ còn điều khiển đường legacy (FR-080) |
| Client gọi hệ thống ngoài | `delivery/clients/{jenkins,argocd,kube,ssh}.ts` (TypeScript, chạy trong hub) | Viết lại bằng Go trong worker. Fixture `delivery/fixtures/*` dùng làm bộ test chung (FR-024) |
| Cách triển khai | `deploys/method.ts` (giao diện `start/poll/cancel/version/rollback`) và 5 cách: `ssh-script`, `jenkins-job`, `gitlab-manual`, `argocd`, `kubectl` (`deploys/methods.ts`, `run-script.ts`, `ssh-script.ts`) | Giữ **máy trạng thái và khoá đích** ở hub. Phần `start/poll/cancel/version/rollback` chạy ở worker (FR-030…FR-037) |
| Điều phối | `deploys/orchestrator.ts`, queue `delivery-deploy`, `delivery-deploy-watch` (pg-boss, `queues.ts`) | Hub vẫn tạo lần triển khai và giữ hàng đợi. Thay "hub gọi cách triển khai" bằng "hub giao việc cho worker, worker báo sự kiện" (FR-020…FR-026) |
| Duyệt | `deploy_approvals`, chính sách theo môi trường. `approvals.ts` hiện chỉ là chỗ đăng ký job hết hạn duyệt, nghiệp vụ duyệt nằm trong `orchestrator.ts` | **Giữ ở hub**, không đổi. Việc chỉ được giao cho worker sau khi đủ duyệt (FR-040…FR-043) |
| CI feed | `ci/poll.ts`, `ci/feed.ts`, `ci/detail.ts`, `ci/actions.ts`, `ci/logs.ts`, `ci/project-jobs.ts` đọc Jenkins theo lịch bằng token người theo dõi | Worker hỏi Jenkins và đẩy trạng thái lên hub. Hub chỉ lưu `ci_runs_seen` (FR-050…FR-057) |
| GitLab | Webhook về hub (`ci/gitlab-events.ts`, `ci/webhook-refresh.ts`), pipeline/job qua `GitProvider` của hub | Webhook vào hub giữ nguyên. Đọc pipeline, chạy job chờ tay đi qua worker (FR-034) |
| Máy chủ và khoá | `deploy_servers` giữ khoá riêng mã hoá bằng `platform/secrets.ts`; `connections/credentials.ts`, `connections/jenkins.ts`, `connections/infra.ts` giữ token mã hoá trên hub | Hub **bỏ giữ** giá trị. Chỉ giữ tên tham chiếu credential. Giá trị ở kho bí mật của máy worker (FR-060…FR-066) |
| Log triển khai | Bảng `deploy_log_chunks`, `delivery/logs.ts`, SSE `stream-route.ts`, `retention.ts` | Log ở lại máy chạy. Hub dừng ghi `deploy_log_chunks` cho việc chạy ở worker (FR-050…FR-055). Xung đột với SSE hiện tại, phải đổi |
| Worker ↔ hub | WSS do worker gọi ra (`worker/internal/channel`), lease và offer (`channel/jobs.go`), hộp thư đi trên đĩa (`worker/internal/outbox`), hợp đồng `packages/contracts/src/worker-protocol.ts` | Dùng lại. Thêm loại việc "delivery" cạnh loại việc "run" (FR-020) |
| Sự kiện client | Hợp đồng chống trùng và hộp thư đi của spec 027 (`packages/contracts/src/client-events.ts`) | Báo tiến độ delivery đi qua đúng hợp đồng này (FR-026) |
| Kho bí mật | Spec 031 (`specs/031-local-secrets`): kho keyring của hệ điều hành, che output, gán theo dự án | Mở rộng bằng **không gian tên credential delivery**, không đi vào biến môi trường của agent (FR-062) |
| Thư viện Go | `worker/go.mod` có `golang.org/x/crypto` (có `ssh`) và `go-keyring`. Chưa có thư viện Kubernetes | Dùng `x/crypto/ssh`. Kubernetes và Argo CD gọi REST thẳng như hub hôm nay (không cần binary `kubectl`) |
| Chọn máy | `hello` và heartbeat của worker báo nhãn, chế độ runner; có `egress` allowlist (`worker/internal/egress`) | Thêm khả năng "chạy delivery" và danh sách tham chiếu credential đang có (FR-010…FR-013) |

## Khái niệm

| Khái niệm | Nghĩa |
|---|---|
| Máy chạy deploy | Máy có `hive-worker` được chọn để chạy việc delivery của một dự án hoặc một môi trường |
| Runner triển khai | Nhãn do admin gắn cho máy: máy này được phép chạy môi trường đòi nhãn đó (Q3) |
| Việc delivery | Một đơn vị việc giao cho worker: bước CI (hỏi, bấm, huỷ) hoặc một lần triển khai (`start`, `poll`, `cancel`, `version`, `rollback`, `health`) |
| Tham chiếu credential | Tên (ví dụ `jenkins-prod`, `ssh-web01`) lưu ở cấu hình hub. Giá trị chỉ có trong kho bí mật của máy |
| Máy đã chạy | Máy đã nhận và chạy việc delivery. Hub ghi tên máy vào lần triển khai và vào mỗi thao tác CI |
| Đường legacy | Cách chạy hiện nay: hub tự gọi ra (chỉ khi `HIVE_DELIVERY_OUTBOUND=1`) |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Chọn máy chạy deploy cho dự án và môi trường (Priority: P1)

Admin đội mở trang môi trường của dự án `shop`. Ở mục "Máy chạy deploy" chọn hai máy: `runner-hn-01` (chính) và
`runner-hn-02` (dự phòng). Môi trường `prod` đòi nhãn "runner triển khai". Môi trường `dev` cho phép "máy của người bấm".
Khi `runner-hn-01` mất kết nối, việc `prod` chuyển sang `runner-hn-02` nếu máy này đáp ứng.

**Why this priority**: không có máy thì không có nơi chạy. Mọi story sau cần nó.

**Independent Test**: khai hai máy cho một môi trường, tắt máy chính, bấm triển khai. Việc chạy ở máy dự phòng và lịch
sử ghi đúng tên máy.

**Acceptance Scenarios**:

1. **Given** môi trường có danh sách máy theo thứ tự ưu tiên, **When** có lần triển khai, **Then** hub giao cho máy đầu
   tiên đang trực tuyến, đủ khả năng và đủ credential (FR-013).
2. **Given** không máy nào trực tuyến, **When** có lần triển khai, **Then** lần đó ở `chờ` kèm lý do "Chưa có máy chạy
   deploy trực tuyến", và hết hạn sau thời gian chờ (FR-014). Hub không tự chạy hộ.
3. **Given** môi trường đòi nhãn runner, **When** admin thêm máy cá nhân chưa có nhãn, **Then** hub từ chối kèm lý do
   tiếng Việt.
4. **Given** chế độ "máy của người bấm", **When** người bấm không có worker trực tuyến, **Then** nút Triển khai báo
   "Máy của bạn chưa trực tuyến" và hướng dẫn mở app desktop.
5. **Given** dự án không khai máy, **When** đội có máy mặc định, **Then** dùng máy mặc định. Cả hai đều không có thì chặn
   lúc khai đích triển khai, không chờ tới lúc chạy.

---

### User Story 2 - `ssh-script` chạy từ worker (Priority: P1)

Dev bấm triển khai commit `abc123` lên `staging` bằng `ssh-script`. Worker trên `runner-hn-01` mở SSH tới
`web01.internal`, kiểm dấu vân tay, đẩy script, chạy tách khỏi phiên SSH, đọc log, chạy health, rồi báo hub từng bước.
Hub không mở kết nối nào tới `web01`.

**Why this priority**: là cách triển khai chính của đội và là cách phải đưa hub ra khỏi mạng nội bộ đầu tiên.

**Independent Test**: với `HIVE_DELIVERY_OUTBOUND=0`, chạy một lần `ssh-script` tới máy thử. Bước và health đúng như khi
hub tự chạy (snapshot `run-script.test.ts` dùng lại). Hub không mở kết nối ra máy thử.

**Acceptance Scenarios**:

1. **Given** dấu vân tay host key đã xác nhận, **When** worker kết nối và dấu vân tay khác, **Then** worker dừng trước
   mọi lệnh và báo `hostkey_changed`. Hub gửi thông báo `server.hostkey_changed` như hôm nay.
2. **Given** việc đang chạy, **When** worker khởi động lại hoặc mất mạng tới hub, **Then** script trên máy chủ vẫn chạy.
   Worker trở lại thì đọc tiếp trạng thái từ thư mục lần triển khai trên máy chủ và báo hub.
3. **Given** người dùng bấm Huỷ, **When** hub chuyển yêu cầu huỷ cho máy đã chạy, **Then** worker dừng tiến trình trên máy
   chủ và báo `đã huỷ`.
4. **Given** health khai URL nội bộ, **When** bước health chạy, **Then** worker gọi URL đó, không phải hub (FR-036).
5. **Given** biến của đích đánh dấu bí mật, **When** worker chạy script, **Then** giá trị lấy từ kho bí mật của máy và
   không có trong log hay thông điệp gửi hub.

---

### User Story 3 - Jenkins và GitLab chạy từ worker (Priority: P1)

Dev bấm "Chạy lại" trên một build Jenkins ở tab CI/CD. Hub xếp việc, worker trên máy được chọn gọi Jenkins bằng token lấy
từ kho bí mật, báo kết quả. Danh sách build vẫn cập nhật nhờ worker hỏi Jenkins theo lịch rồi đẩy lên hub.

**Why this priority**: Jenkins là hệ CI chính. Không có nó thì tab CI/CD trống.

**Independent Test**: dựng Jenkins giả (`delivery/fixtures/jenkins`) trong mạng mà hub không tới được. Hub vẫn hiện build,
bấm được build có tham số, dừng build, bấm Proceed ở bước `input`.

**Acceptance Scenarios**:

1. **Given** kết nối Jenkins có người theo dõi, **When** tới chu kỳ hỏi, **Then** máy chạy CI của kết nối hỏi Jenkins và
   đẩy trạng thái build lên hub. Hub không gọi Jenkins (FR-050).
2. **Given** deploy `jenkins-job`, **When** lần triển khai bắt đầu, **Then** worker bấm job với `{{commit}}`, `{{tag}}`,
   `{{env}}` đã điền, theo dõi hàng đợi và build tới khi xong, rồi báo hub (FR-031).
3. **Given** build dừng ở bước `input`, **When** người duyệt bấm Duyệt hoặc Từ chối trên web, **Then** hub chuyển quyết
   định cho worker, worker bấm Proceed hoặc Abort (FR-042).
4. **Given** đích `gitlab-manual`, **When** triển khai, **Then** worker chạy job chờ tay của pipeline tại commit đã chọn
   (FR-034).
5. **Given** tham số kiểu password của Jenkins, **When** ghi audit hay lịch sử, **Then** không ghi giá trị (như hôm nay).

---

### User Story 4 - Argo CD và Kubernetes chạy từ worker (Priority: P1)

Dev triển khai đích `argocd` hoặc `kubectl`. Worker đặt cùng mạng với cluster, gọi API Argo CD hoặc API server Kubernetes
bằng token trong kho bí mật, chờ rollout xong và báo hub.

**Why this priority**: hai cách này cần đúng mạng nội bộ của cluster mà hub không với tới.

**Independent Test**: với fixture `delivery/fixtures/argocd` và `kube`, chạy đủ vòng đồng bộ, chờ rollout, quay về. Kết
quả khớp bộ test hiện tại của hub.

**Acceptance Scenarios**:

1. **Given** đích `argocd` có đồng bộ tới revision, **When** chạy, **Then** worker gọi đồng bộ, theo dõi Synced/Healthy,
   báo thành công hay thất bại (FR-032).
2. **Given** đích `kubectl`, **When** chạy, **Then** worker đổi image của container, chờ `observedGeneration` mới và số
   bản cập nhật bằng số mong muốn, báo hub (FR-033).
3. **Given** đồng bộ Argo CD bị chặn vì autosync, **When** quay về, **Then** lỗi giữ nội dung như hôm nay
   (`error-rollback-autosync`).
4. **Given** CA của cluster khai ở cấu hình, **When** worker kết nối TLS, **Then** dùng đúng CA đó. CA không phải secret
   nên ở lại cấu hình hub.

---

### User Story 5 - Duyệt và khoá môi trường vẫn ở hub (Priority: P1)

Môi trường `prod` đòi 2 người duyệt. Dev bấm triển khai, lần triển khai ở `chờ duyệt` trên hub. Hai người duyệt trên web.
Chỉ lúc đó hub mới giao việc cho worker. Admin khoá môi trường giữa chừng thì việc chưa giao bị chặn.

**Why this priority**: duyệt là kiểm soát của công ty. Không dời nó ra máy cá nhân.

**Independent Test**: lần triển khai `prod` chưa đủ duyệt thì không có việc nào giao cho worker. Đủ duyệt thì giao đúng
một lần.

**Acceptance Scenarios**:

1. **Given** lần triển khai `chờ duyệt`, **When** worker xin nhận việc, **Then** hub không có việc nào để giao cho lần đó.
2. **Given** đủ duyệt, **When** hub chuyển sang `chờ`, **Then** hub tạo đúng một việc delivery, kèm phiên bản cấu hình đã
   khoá, và chỉ giao cho một máy.
3. **Given** môi trường bị khoá, **When** có lần triển khai mới hoặc quay về, **Then** bị chặn ở hub, không tới worker.
4. **Given** lần chờ duyệt hết hạn, **When** hết thời gian, **Then** hub đánh `hết hạn` như hôm nay.
5. **Given** worker báo kết quả cho lần đã bị huỷ hay hết hạn, **When** hub nhận, **Then** hub trả `rejected` kèm lý do
   và không đổi trạng thái (FR-026).

---

### User Story 6 - Trang web vẫn dùng được và hiện máy đã chạy (Priority: P1)

Người xem mở "Bảng deploy" và tab CI/CD. Mỗi lần triển khai và mỗi build đã thao tác có cột "Máy chạy" (ví dụ
`runner-hn-01`). Mở chi tiết thấy bước, mã thoát, thời lượng. Phần log hiện câu "Log nằm trên máy `runner-hn-01`". Chủ
máy mở app desktop xem log đầy đủ.

**Why this priority**: người dùng chỉ cần trang web tiếp tục chạy. Spec 027 đã chốt log ở lại máy.

**Independent Test**: với hub không có đường ra, mở từng trang CI/CD thấy dữ liệu do worker đẩy lên, mỗi lần chạy có tên
máy.

**Acceptance Scenarios**:

1. **Given** lần triển khai đã chạy ở worker, **When** mở chi tiết trên web, **Then** thấy máy đã chạy, bước, mã thoát,
   health, và "Log nằm trên máy X". Không có khung log (theo Q1).
2. **Given** chủ máy mở app desktop trên máy đã chạy, **When** chọn lần triển khai, **Then** đọc được log đầy đủ từ đĩa
   máy (FR-053).
3. **Given** máy đã chạy bị tắt hay thu hồi, **When** xem lần triển khai cũ, **Then** vẫn thấy siêu dữ liệu. Log không còn
   và giao diện nói rõ lý do.
4. **Given** trang "Kết nối CI" và "Máy chủ triển khai", **When** admin bấm "Kiểm kết nối", **Then** hub giao việc kiểm cho
   máy chạy deploy, kết quả hiện trên trang. Hub không tự kiểm.
5. **Given** lần chạy đang đi, **When** worker báo bước mới, **Then** web cập nhật trong 5 giây qua đường cập nhật trực
   tiếp hiện có (FR-057).

---

### User Story 7 - Credential ở lại máy (Priority: P1)

Admin khai kết nối Jenkins `jenkins-prod` ở hub: URL và tên tham chiếu. Giá trị token **không** nhập vào web. Chủ máy
runner mở app desktop, màn "Bí mật", thêm credential `jenkins-prod` vào kho hệ điều hành (spec 031). Worker dùng khi chạy
việc. Hub không bao giờ thấy giá trị.

**Why this priority**: đây là ranh giới SOC cần: hub không giữ chìa khoá vào máy nội bộ.

**Independent Test**: dump database và mọi request hub nhận trong một lần triển khai đủ 5 cách. Không có SSH key, token
Jenkins, Argo CD, Kubernetes nào.

**Acceptance Scenarios**:

1. **Given** đích tham chiếu credential `ssh-web01`, **When** máy chạy không có credential đó, **Then** hub không giao
   cho máy đó (FR-013). Nếu thiếu lúc chạy, việc thất bại `thiếu credential` (FR-066).
2. **Given** credential có trong kho, **When** việc chạy, **Then** worker đọc ngay trước khi dùng, giữ trong bộ nhớ,
   không ghi đĩa, không in log, không đưa vào tham số dòng lệnh (FR-063).
3. **Given** admin đổi tham chiếu hay xoá kết nối, **When** hub lưu, **Then** hub ghi audit. Giá trị ở máy không bị hub
   xoá hộ, giao diện nhắc chủ máy xoá.
4. **Given** khoá SSH, **When** admin cần khoá mới cho máy chủ, **Then** worker tạo cặp ed25519 trên máy, giữ khoá riêng
   trong kho, chỉ gửi khoá công khai cho hub hiển thị (FR-064).
5. **Given** việc chạy in ra giá trị credential, **When** worker ghi log, **Then** giá trị bị che theo spec 031 FR-030.

---

### User Story 8 - Chuyển từ đường hub chạy sang worker (Priority: P2)

Tổ chức đang có cấu hình CI/CD cũ ở hub với token mã hoá trên hub. Admin mở trang "Chuyển sang worker": thấy từng kết nối
và máy chủ ở trạng thái "Chưa chuyển", "Thiếu credential trên máy X", "Đã chuyển". Bấm chuyển một môi trường: hub bắt đầu
giao cho worker, giữ nguyên lịch sử cũ. Xong thì hub xoá giá trị đã mã hoá.

**Why this priority**: cần cho tổ chức đã dùng bản cũ. Hub production chưa bật đường ra nên với họ phần này chủ yếu là
nhập credential lên máy.

**Independent Test**: có dữ liệu spec 020 với token mã hoá. Chuyển một môi trường. Triển khai kế tiếp chạy ở worker.
Lịch sử cũ vẫn xem được. Token mã hoá của kết nối đó đã bị xoá.

**Acceptance Scenarios**:

1. **Given** môi trường đang chạy đường legacy, **When** admin bấm chuyển, **Then** hub kiểm máy chạy có đủ credential và
   khả năng, nếu đủ thì đổi đường chạy của môi trường và ghi audit.
2. **Given** một lần triển khai legacy đang chạy, **When** admin bấm chuyển, **Then** hub chặn tới khi lần đó kết thúc.
3. **Given** môi trường đã chuyển, **When** `HIVE_DELIVERY_OUTBOUND=1`, **Then** hub vẫn không tự chạy môi trường đó
   (FR-081).
4. **Given** chuyển xong, **When** admin chọn "Xoá secret cũ trên hub", **Then** hub xoá token và khoá riêng mã hoá của
   kết nối và máy chủ liên quan, ghi audit.
5. **Given** admin muốn quay lại, **When** chưa xoá secret cũ và công tắc hub đang bật, **Then** quay lại legacy được.

---

### User Story 9 - Audit đủ người, máy và việc (Priority: P2)

Quản trị hỏi: "Ai đã deploy `shop` lên `prod` hôm qua, từ máy nào, bằng credential nào?". Audit trả lời: người bấm,
người duyệt, máy đã chạy, tên tham chiếu credential đã dùng (không giá trị), phiên bản cấu hình, kết quả.

**Why this priority**: SOC và kiểm toán cần dấu vết. Chạy ở máy cá nhân làm dấu vết rời rạc nếu không gom về hub.

**Independent Test**: chạy một lần triển khai và một thao tác CI. Audit ở hub có đủ trường nêu trên. Thông điệp worker
không chứa giá trị bí mật.

**Acceptance Scenarios**:

1. **Given** lần triển khai đã xong, **When** xem audit, **Then** thấy dòng cho yêu cầu, duyệt, giao máy, bắt đầu, từng
   bước, kết quả.
2. **Given** worker dùng credential, **When** báo hub, **Then** gửi tên tham chiếu và thời điểm, không gửi giá trị.
3. **Given** việc bị giao lại cho máy dự phòng, **When** xem audit, **Then** thấy cả hai máy và lý do.
4. **Given** worker đọc credential, **When** chủ máy xem nhật ký cấp bí mật (spec 031 US6), **Then** thấy dòng "việc
   delivery" kèm tên credential.

---

### User Story 10 - Worker trên Windows, macOS và Linux (Priority: P2)

Đội có runner Linux cho `prod`, dev dùng macOS và Windows cho `dev`. Cả ba chạy đủ 5 cách. Cùng cấu hình, cùng kết quả.

**Why this priority**: máy dev của đội là Windows và macOS, runner `prod` thường là Linux.

**Independent Test**: bộ test hợp đồng của mỗi cách chạy trên ba hệ điều hành trong CI. Kết quả giống nhau.

**Acceptance Scenarios**:

1. **Given** worker trên Windows, **When** dùng `ssh-script`, **Then** không phụ thuộc `ssh.exe` hay công cụ Unix trên
   máy. SSH do worker tự làm.
2. **Given** đường dẫn khai ở cấu hình, **When** worker chạy, **Then** đường dẫn trên máy **chủ đích** luôn theo máy chủ
   đích, không theo hệ điều hành của worker.
3. **Given** kho bí mật ở mỗi hệ điều hành (Credential Manager, Keychain, Secret Service), **When** đọc credential,
   **Then** hành vi giống nhau. Kho khoá hay không có thì xử theo spec 031 US9.
4. **Given** Linux không có Secret Service, **When** worker chạy ở chế độ runner, **Then** worker báo "không có kho bí
   mật" và không nhận việc delivery. Không rơi về file thường.

---

### Edge Cases

- **Máy chạy mất kết nối giữa chừng.** Hub đợi heartbeat. Quá hạn (mặc định 3 phút) thì lần triển khai chuyển
  `không rõ kết quả`. Với `ssh-script`, máy khác nhận tiếp được vì trạng thái nằm trên máy chủ đích (thư mục, PID, vị
  trí log). Các cách khác không tự giao lại, để khỏi chạy hai lần.
- **Hai máy cùng nhận một việc.** Hub chỉ giao qua lease cho một máy. Lease hết hạn mới giao lại. Báo cáo từ máy đã mất
  lease bị `rejected`.
- **Một đích chỉ một lần đang đi** (spec 020 FR-015). Khoá này giữ ở hub, không đổi.
- **Đồng hồ máy lệch.** Hub dùng thời điểm nhận để sắp thứ tự, như spec 027.
- **Máy dự phòng không đủ credential.** Bỏ qua máy đó, ghi lý do trong "tại sao chưa giao".
- **Hub vắng khi đang chạy.** Việc đang chạy vẫn xong. Sự kiện xếp hàng trong hộp thư đi và gửi khi hub trở lại (spec 027
  FR-010…FR-016). Việc chưa nhận thì không bắt đầu khi hub vắng, vì lease đến từ hub.
- **Hub khôi phục về mốc cũ** (spec 027 FR-042). Worker gửi lại sự kiện, hub loại trùng theo khoá chống trùng.
- **Worker bản cũ không biết việc delivery.** Hub không giao cho worker không báo khả năng `delivery` (FR-011).
- **Kết nối Jenkins dùng token từng người** (spec 020 FR-001). Xem Assumptions A3.
- **Máy chạy không tới được hệ thống đích.** Báo `network` kèm tên đích. Không thử đường khác.
- **Health trỏ vào URL chỉ máy chủ đích tới được.** Health chạy ở worker. Cần chạy ngay trên máy chủ đích thì dùng bước
  lệnh trong `ssh-script`.
- **Spec 031 chưa xong khi spec này bắt đầu.** Delivery đọc kho qua một giao diện nhỏ (Assumptions A2).

## Requirements *(mandatory)*

### Functional Requirements

**Chọn máy chạy deploy (US1)**

- **FR-001**: Môi trường (và đích triển khai nếu muốn ghi đè) PHẢI khai được "máy chạy deploy": danh sách máy theo thứ tự
  ưu tiên, hoặc chế độ "máy của người bấm", hoặc "máy bất kỳ có nhãn X".
- **FR-002**: Đội PHẢI khai được máy mặc định cho các môi trường chưa khai. Chưa có máy nào thì không khai được đích triển
  khai.
- **FR-010**: Worker PHẢI báo hub ở `hello` và heartbeat: khả năng `delivery` và các cách hỗ trợ (`ssh-script`,
  `jenkins-job`, `gitlab-manual`, `argocd`, `kubectl`), hệ điều hành, nhãn, và **tên** các tham chiếu credential delivery
  đang có trong kho. Tên, không phải giá trị.
- **FR-011**: Hub PHẢI không giao việc delivery cho worker không báo khả năng tương ứng.
- **FR-012** (Q3): Admin PHẢI gắn được nhãn "runner triển khai" cho một máy. Môi trường PHẢI khai được "đòi nhãn". Mặc
  định môi trường `prod` đòi nhãn. Hub từ chối thêm máy thiếu nhãn vào môi trường đòi nhãn.
- **FR-013**: Khi giao việc, hub PHẢI chọn máy đầu tiên trong danh sách thoả đủ: trực tuyến, có khả năng cho cách đó, có
  nhãn nếu đòi, có đủ tham chiếu credential của đích. Hub ghi "tại sao chưa giao" khi không có máy nào.
- **FR-014**: Khi không có máy đủ điều kiện, lần triển khai PHẢI ở `chờ` tối đa 15 phút (đổi được theo môi trường) rồi
  chuyển `thất bại` với lý do `không có máy chạy`. Hub KHÔNG ĐƯỢC chạy thay bằng đường legacy.
- **FR-015**: Web PHẢI hiện: máy nào sẽ chạy, máy nào dự phòng, máy nào đang trực tuyến.

**Giao việc và báo tiến độ**

- **FR-020**: Hợp đồng worker PHẢI có loại việc delivery tách khỏi loại việc run. Hub giao qua lease, worker nhận, báo tiến
  độ và kết quả. Việc delivery không tạo `run` hay `task`.
- **FR-021**: Mỗi việc delivery PHẢI mang: id việc, id lần triển khai hoặc thao tác CI, loại, phiên bản cấu hình đã khoá
  (không chứa secret), các tham chiếu credential cần, tham số đã điền, thời hạn.
- **FR-022**: Worker PHẢI chạy tối đa một việc **ghi** cho mỗi đích cùng lúc. Việc đọc (hỏi CI, kiểm kết nối) chạy song
  song, có giới hạn số việc.
- **FR-023**: Hub PHẢI quản lý lease. Hết hạn mà không có heartbeat thì áp edge case "mất kết nối giữa chừng". Mọi báo cáo
  từ máy đã mất lease bị `rejected`.
- **FR-024**: Mỗi cách triển khai ở worker PHẢI qua cùng bộ test hợp đồng với fixture của hub (`delivery/fixtures/*`), để
  hành vi giữ nguyên khi chuyển từ TypeScript sang Go.
- **FR-025**: Huỷ PHẢI đi từ hub xuống máy đã chạy bằng thông điệp trên kênh sẵn có. Không có đường hub gọi vào máy.
- **FR-026**: Mọi báo cáo của worker PHẢI đi qua hợp đồng sự kiện client của spec 027 (khoá chống trùng, nguồn
  `worker-delivery`, máy, thời điểm tạo). Hub là nơi duy nhất chuyển trạng thái lần triển khai. Báo cáo chỉ là đề nghị.

**Chuyển từng cách triển khai (US2, US3, US4)**

- **FR-030**: `ssh-script` ở worker PHẢI giữ nguyên hành vi: host key cố định, sai dấu vân tay dừng trước mọi lệnh, script
  chạy tách khỏi phiên SSH trong thư mục riêng của lần triển khai, đọc log theo vị trí đã lưu, tiếp tục được sau khi
  worker khởi động lại. Trạng thái phía máy chủ (`remote`) vẫn đi về hub như siêu dữ liệu.
- **FR-031**: `jenkins-job` ở worker PHẢI giữ: bấm job có tham số, theo dõi hàng đợi và build, `wfapi/describe`, dừng,
  Proceed hoặc Abort bước `input`, "đẩy từ môi trường" (spec 020 FR-034).
- **FR-032**: `argocd` ở worker PHẢI giữ: đồng bộ tới revision, theo dõi, quay về bằng history, lỗi autosync.
- **FR-033**: `kubectl` ở worker PHẢI gọi API Kubernetes (không dùng binary), đổi image, chờ rollout, quay về bằng đặt lại
  image.
- **FR-034**: `gitlab-manual` và việc đọc pipeline, job, chạy lại, huỷ ở worker PHẢI dùng token GitLab từ kho bí mật.
  Webhook GitLab vào hub giữ nguyên.
- **FR-035**: Build "ngoài Hive" (spec 020 FR-025) PHẢI do worker phát hiện khi hỏi Jenkins và báo hub như lần triển khai
  `external`.
- **FR-036**: Health (spec 020 FR-018) PHẢI chạy ở worker của lần triển khai. Hub không gọi URL health.
- **FR-037**: Hub PHẢI giữ khoá đích, trạng thái, duyệt, quay về và "bảng đang chạy" như hôm nay. Chỉ phần gọi hệ thống
  ngoài đổi chỗ.

**Duyệt và khoá (US5)**

- **FR-040**: Duyệt, từ chối, hết hạn duyệt, "người yêu cầu không tự duyệt" PHẢI chạy hoàn toàn ở hub, không đổi hành vi.
- **FR-041**: Hub PHẢI chỉ tạo việc delivery khi lần triển khai đã đủ duyệt và môi trường không bị khoá. Việc đã giao mà
  môi trường bị khoá sau đó vẫn chạy tới hết, nhưng admin huỷ được (FR-025).
- **FR-042**: Quyết định Proceed hoặc Abort cho bước `input` của Jenkins PHẢI do hub chuyển cho máy đã chạy, ghi người
  quyết định.
- **FR-043**: Worker KHÔNG ĐƯỢC tự quyết duyệt, bỏ qua duyệt, hay chạy việc không có lease của hub.

**Siêu dữ liệu, log, giao diện (US6)**

- **FR-050**: Hub PHẢI chỉ nhận siêu dữ liệu từ việc delivery: trạng thái, bước, thời điểm, mã thoát, kết quả health, phiên
  bản đang chạy, trạng thái CI (nguồn, id, nhánh, commit, thời lượng, người kích hoạt, link gốc), máy đã chạy.
- **FR-051**: Hub PHẢI ngừng ghi `deploy_log_chunks` cho việc chạy ở worker. Dữ liệu cũ xoá theo chính sách giữ log hiện có
  của delivery (`retention.ts`).
- **FR-052** (Q1): Khi lỗi, worker PHẢI gửi mã lỗi từ danh mục có sẵn (`hostkey_changed`, `auth_failed`, `timeout`,
  `step_failed`, `health_failed`, `network`, `missing_credential`…), tên bước, mã thoát, và một câu tóm tắt tối đa 200 ký
  tự đã che bí mật.
- **FR-053**: Log đầy đủ PHẢI ở đĩa của máy đã chạy, giữ theo chính sách giữ log của tổ chức. Desktop trên máy đó đọc được
  log. Web và máy khác chỉ thấy siêu dữ liệu và câu "Log nằm trên máy <tên máy>".
- **FR-054**: Log CI (build Jenkins, job GitLab) PHẢI chuyển từ "hub đọc từ nguồn" (spec 020 FR-008) thành: mở ở nguồn
  qua link gốc, hoặc chủ máy xem trên desktop. Hub không trung chuyển log.
- **FR-055**: Giao diện PHẢI đổi khung log trong chi tiết lần triển khai và tab CI/CD thành thẻ "Log nằm trên máy X" kèm
  link gốc tới Jenkins hoặc GitLab, chữ tiếng Việt.
- **FR-056**: Danh sách và chi tiết PHẢI hiện cột "Máy chạy" cho mọi lần triển khai và thao tác CI do worker làm.
- **FR-057**: Cập nhật trực tiếp trên web PHẢI trong 5 giây kể từ lúc hub nhận báo cáo của worker.

**Credential và bí mật (US7)**

- **FR-060**: Hub PHẢI không nhận, không lưu, không chuyển tiếp giá trị: khoá riêng SSH, token Jenkins, Argo CD,
  Kubernetes, GitLab, kể cả dạng mã hoá. Cột hiện giữ chúng (`deploy_servers`, `ci_jenkins_user_tokens`,
  `deploy_connections`) PHẢI bỏ phần giá trị sau khi chuyển xong (FR-084).
- **FR-061**: Cấu hình hub PHẢI chỉ giữ **tên tham chiếu credential**: `[a-z0-9-]{1,64}`, duy nhất trong tổ chức, không
  chứa giá trị.
- **FR-062**: Worker PHẢI đọc credential từ kho bí mật của spec 031, trong **không gian tên riêng cho delivery**, tách khỏi
  bí mật gán cho dự án. Credential delivery KHÔNG ĐƯỢC vào biến môi trường của agent hay phiên terminal.
- **FR-063**: Worker PHẢI đọc credential ngay trước khi dùng, giữ trong bộ nhớ, không ghi đĩa, không đưa vào tham số dòng
  lệnh, không in log, và che trong mọi output (spec 031 FR-030…FR-036).
- **FR-064**: Khoá SSH cho máy chủ PHẢI sinh ở worker (ed25519). Khoá riêng nằm trong kho. Chỉ khoá công khai gửi hub.
  Không có chức năng xuất khoá riêng. "Đổi khoá" theo luồng spec 020 US3, thực hiện ở worker.
- **FR-065**: Màn "Bí mật" trên desktop PHẢI thêm tab "Credential triển khai": thêm, đổi, xoá theo tên tham chiếu. Không có
  nút "Hiện" mặc định cho loại này.
- **FR-066**: Thiếu credential lúc chạy thì việc thất bại với mã `missing_credential`, không thử đường khác.

**Chuyển đổi và công tắc (US8)**

- **FR-080**: Mặc định mọi việc delivery PHẢI đi qua worker. Hub PHẢI không mở socket ra máy nội bộ cho delivery trong cấu
  hình này.
- **FR-081** (Q2): Khi `HIVE_DELIVERY_OUTBOUND=1`, hub PHẢI chỉ chạy các môi trường vẫn đặt đường "legacy". Môi trường đã
  chuyển sang worker KHÔNG ĐƯỢC chạy bằng hub. Hub ghi cảnh báo và audit mỗi lần dùng đường legacy.
- **FR-082**: Đường legacy PHẢI giữ tối thiểu 2 bản phát hành, đánh dấu "sẽ gỡ" ở giao diện admin và `RELEASE_NOTES.md`,
  rồi gỡ code `delivery/clients/*` chạy trong hub. Bản gỡ cần ADR.
- **FR-083**: Hub PHẢI có trang "Chuyển sang worker" cho admin: mỗi kết nối, máy chủ, môi trường hiện trạng thái (chưa
  chuyển, thiếu credential trên máy X, đã chuyển) và nút chuyển từng môi trường.
- **FR-084**: Sau khi chuyển và admin xác nhận, hub PHẢI xoá giá trị mã hoá cũ và ghi audit. Xoá không hoàn tác.
- **FR-085**: Lịch sử cũ PHẢI giữ nguyên, đánh dấu "chạy bằng hub (cũ)" ở cột "Máy chạy".
- **FR-086**: Thay đổi hợp đồng PHẢI tương thích với worker đã cài (constitution I). Hub mới vẫn chạy với worker cũ cho
  việc `run`; việc delivery chỉ giao cho worker báo khả năng.

**Audit (US9)**

- **FR-090**: Mỗi bước PHẢI có dấu vết ở hub: yêu cầu, duyệt, chọn máy, giao việc, nhận việc, bắt đầu, từng bước, kết quả,
  huỷ, giao lại. Mỗi dòng có người (nếu có), máy, thời điểm hub nhận.
- **FR-091**: Audit PHẢI ghi **tên** tham chiếu credential đã dùng, không giá trị, và phiên bản cấu hình đích.
- **FR-092**: Tham số kiểu bí mật (password của Jenkins, biến đánh dấu bí mật) KHÔNG ĐƯỢC ghi giá trị ở audit hay lịch sử.
- **FR-093**: Worker PHẢI ghi nhật ký cấp bí mật tại máy (spec 031 FR-040) cho mỗi lần đọc credential delivery. Hub chỉ
  nhận tên tham chiếu, không giá trị.

**Hệ điều hành (US10)**

- **FR-100**: Worker PHẢI chạy đủ 5 cách trên Windows, macOS, Linux mà không cần `ssh`, `kubectl`, `curl` hay công cụ Unix
  cài sẵn.
- **FR-101**: Đường dẫn trên máy chủ đích PHẢI theo máy chủ đích. Đường dẫn cục bộ của worker (thư mục lần triển khai,
  log) PHẢI theo quy ước của hệ điều hành và chỉ người dùng đó đọc được (0600/0700, DACL tương đương).
- **FR-102**: Linux không có kho bí mật PHẢI không nhận việc delivery và báo rõ. Không có chế độ lưu credential vào file.
- **FR-103**: Mọi cách triển khai PHẢI có test hợp đồng chạy trên ba hệ điều hành trong CI.

### Một máy, nhiều tổ chức (specs/034)

- **FR-104**: Một máy có thể đăng ký với hai tổ chức cùng lúc, cùng hub hoặc khác hub. Credential, hàng việc, thư mục làm
  việc và log của delivery PHẢI gắn với **đăng ký** (máy + tổ chức + hub) và KHÔNG ĐƯỢC dùng chung giữa các đăng ký, kể cả
  khi hai tổ chức đặt cùng tên credential.
- **FR-105**: Việc chọn "máy chạy deploy" (FR-001, FR-013) PHẢI theo từng tổ chức: máy trực tuyến, khả năng và nhãn được
  xét trong phạm vi đăng ký của tổ chức đó.
- **FR-106**: Gói delivery PHẢI nhận ngữ cảnh đăng ký từ nơi gọi, không tự đọc cấu hình một đăng ký của worker, để nối
  nhiều đăng ký sau này mà không đổi gói.

### Key Entities

- **Máy chạy của môi trường**: môi trường (hoặc đích), máy, thứ tự ưu tiên, chế độ (cố định, máy của người bấm, theo
  nhãn), đòi nhãn runner.
- **Nhãn runner triển khai**: máy, người gắn, thời điểm gắn.
- **Việc delivery**: id, lần triển khai hoặc thao tác CI, loại, máy đã giao, lease, trạng thái, phiên bản cấu hình, thời
  hạn, lý do chưa giao.
- **Tham chiếu credential**: tổ chức, tên, loại (`ssh`, `jenkins`, `argocd`, `kubernetes`, `gitlab`), mô tả. Không giá trị.
- **Khả năng worker**: máy, danh sách cách hỗ trợ, nhãn, tên tham chiếu đang có, thời điểm báo gần nhất.
- **Lần triển khai** (mở rộng `deploys`): thêm máy đã chạy, đường chạy (`worker` hoặc `legacy`), mã lỗi, tóm tắt lỗi.
- **Sự kiện delivery**: sự kiện client của spec 027 với loại delivery.
- **Trạng thái chuyển đổi**: môi trường, đường chạy, thời điểm chuyển, người chuyển, đã xoá secret cũ hay chưa.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Với `HIVE_DELIVERY_OUTBOUND=0`, 100% lần triển khai trong bộ test của 5 cách chạy xong thành công qua worker,
  và hub mở 0 kết nối ra máy trong mạng test.
- **SC-002**: Trong 100 lần triển khai thử, database và mọi request hub nhận chứa 0 giá trị credential và 0 byte log của
  lần chạy.
- **SC-003**: Admin chuyển một môi trường từ legacy sang worker, gồm nhập credential vào máy, trong dưới 10 phút.
- **SC-004**: Khi máy chính tắt, lần triển khai kế tiếp sang máy dự phòng trong dưới 1 phút. Không có máy nào thì người
  dùng thấy lý do trong dưới 5 giây sau khi bấm.
- **SC-005**: Người xem thấy tên máy đã chạy trên 100% lần triển khai và thao tác CI mới.
- **SC-006**: Worker khởi động lại giữa lúc `ssh-script` đang chạy: 100% lần chạy hoàn tất, không chạy hai lần, không mất
  bước nào trong lịch sử.
- **SC-007**: Trạng thái bước hiện trên web trong 5 giây kể từ lúc worker báo, khi hub và worker cùng mạng.
- **SC-008**: Lần triển khai `prod` chưa đủ duyệt: 0 việc được giao cho worker.
- **SC-009**: SOC trả lời được "hub có chạm vào máy nội bộ không, giữ credential nào?" từ một trang tài liệu, không cần
  hỏi thêm đội.
- **SC-010**: 5 cách triển khai qua cùng bộ test hợp đồng trên Windows, macOS và Linux với kết quả như nhau.

## Assumptions

- **A1**: Mỗi tổ chức có ít nhất một máy đủ điều kiện làm runner triển khai, cùng mạng với hệ thống đích. Việc dựng máy đó
  nằm ngoài spec.
- **A2**: Spec 031 cung cấp kho bí mật tại máy. Nếu 031 chưa xong, delivery dùng giao diện đọc kho đủ nhỏ (đọc theo tên,
  không ghi đĩa) để 031 gắn vào sau, không tạo kho thứ hai.
- **A3**: Token Jenkins theo **từng người** của spec 020 không giữ nguyên. Việc chạy dùng credential của **máy** (tài khoản
  dịch vụ), tên người bấm đi vào tham số hoặc ghi chú của build và vào audit. Chế độ "máy của người bấm" cho phép dùng
  credential cá nhân của chính máy đó. Mặc định này chưa thử với Jenkins thật của công ty.
- **A4**: Thời gian chờ máy 15 phút, mất liên lạc 3 phút. Chưa đo, đổi được ở plan.
- **A5**: GitLab và Jenkins của công ty nằm trong mạng nội bộ mà worker tới được còn hub thì không.
- **A6**: Webhook GitLab về hub vẫn hoạt động vì chiều gọi vào hub là chiều hub cho phép.
- **A7**: Worker tự làm SSH, gọi REST Argo CD và Kubernetes, không cần binary ngoài. Chọn thư viện thuộc plan.
- **A8**: Hộp thư đi, chống trùng và hợp đồng sự kiện đến từ spec 027 và có trước khi spec này code xong.
- **A10**: Khái niệm "đăng ký" và việc chạy nhiều đăng ký thuộc spec 034; 032 chỉ bảo đảm cách ly dữ liệu theo đăng ký (FR-104..106).
- **A9**: Egress allowlist của worker (`worker/internal/egress`) không chặn đường delivery vì delivery là việc của máy, không
  phải việc của agent. Cần kiểm ở plan.

## Out of Scope

- Chọn máy, mạng, tên miền cho hub; mở cổng; đo mạng nội bộ (spec 027 FR-060).
- Dựng, cài và vá máy runner triển khai.
- Đồng bộ credential giữa các máy hay cho đội dùng chung. Mỗi máy tự giữ (như spec 031).
- Hub nhận log đầy đủ của CI/CD, kể cả bản nén sau khi xong (theo Q1 và spec 027 Q3).
- GitHub Actions (spec 020 US9, P3).
- Thêm cách triển khai mới. Spec này chỉ chuyển 5 cách có sẵn.
- Đổi chính sách duyệt, quyền (`ci.view`, `deploy.run`…) hay thông báo (`notify`).
- Chạy agent AI trong việc delivery.
