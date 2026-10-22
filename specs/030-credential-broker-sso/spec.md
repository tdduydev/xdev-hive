# Feature Specification: Kho đăng nhập trên máy dev, lấy token bằng SSO

**Feature Branch**: `030-credential-broker-sso` (nhánh tại máy `ai/SPEC030`)

**Created**: 2026-10-22

**Status**: Draft. Chủ dự án chốt hướng đi ngày 2026-10-22 (bảng Quyết định). Bảng hệ thống cần kiểm lại theo tài liệu
chính thức ở plan (nhiều dòng còn [Unverified]).

**Input**: Chủ dự án (2026-10-22): app client lưu token của nhiều hệ thống để công cụ cần đăng nhập lấy từ đó; có bảo mật
hơn không. Nếu được thì tích hợp đăng nhập SSO của các hệ thống để lấy token dễ hơn, cả Cloudflare và các công cụ cần thiết.

Bối cảnh:
- App desktop đã giữ token hub (PAT) và kết nối Git trong kho khoá của hệ điều hành (Windows Credential Manager, macOS
  Keychain); kết nối Git đã đi qua credential helper và chỉ giữ token trong bộ nhớ của lần gọi.
- Ngoài phần đó, token của các hệ thống khác nằm rải rác ở file chữ thường (`.env`, `~/.npmrc`, `~/.claude.json`,
  `~/.docker/config.json`, biến môi trường). Agent AI chạy trên máy (nhiều khi không hỏi quyền) đọc được các file này.
- Secret của kết nối CI/CD (spec 020) ở trên hub, mã hoá bằng khoá chủ, không xuống máy.

## Quyết định của chủ dự án (2026-10-22)

| # | Câu hỏi | Đã chốt | Phương án đã bỏ |
|---|---|---|---|
| D1 | Kho token kiểu gì? | **Bộ môi giới đăng nhập** (credential broker): token nằm trong kho khoá hệ điều hành, công cụ lấy qua cơ chế helper của chính nó, theo đúng máy chủ nó cần, có kiểm ai gọi. **Không** có lệnh "đưa tôi token thô" cho tiến trình bất kỳ | Kho token đọc tự do |
| D2 | Làm những hệ thống nào? | **Cả bốn nhóm**: Git + cloud (đợt 1), tự host + hạ tầng (đợt 2), công cụ cộng tác (đợt 3), token nhập tay cho hệ thống không có SSO. Thêm **Cloudflare**, **Expo/EAS** và các công cụ dev thường dùng (bảng Hệ thống) | Chỉ đợt 1 |
| D3 | SSO gốc của công ty? | Hỗ trợ **Microsoft Entra ID, Google Workspace, Keycloak**, và trường hợp **chưa có** (đăng nhập riêng từng hệ thống) | Chỉ một IdP |
| D4 | Token lưu ở đâu? | **Trên máy, hub làm môi giới khi cần**: token nằm ở kho khoá từng máy, không gửi lên hub. Hệ thống bắt buộc client secret (Atlassian Cloud, Slack) thì hub giữ secret và làm bước đổi mã; token kết quả vẫn về máy | Đồng bộ token qua hub cho mọi máy |
| D5 | Token gói thuê bao của CLI AI? | **Không lấy, không chuyển tiếp** token đăng nhập gói Claude, Codex, Gemini; mỗi CLI tự đăng nhập. App chỉ giữ API key nếu người dùng nhập | Lấy token gói để dùng chung |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Đăng nhập một lần, git và registry tự dùng (Priority: P1)

Lập trình viên mở màn "Đăng nhập dịch vụ", bấm "Đăng nhập GitHub". Trình duyệt mở trang đăng nhập (dùng SSO công ty nếu
GitHub của tổ chức đã gắn). Xong, `git push`, `docker pull ghcr.io/...`, `npm install` gói của GitHub Packages đều chạy mà
không hỏi mật khẩu và không có token nằm trong file chữ thường.

**Why this priority**: Git và registry là việc hằng ngày của mọi người; đây là chỗ token đang bị chép tay nhiều nhất.

**Independent Test**: Trên máy mới chưa có token, đăng nhập GitHub trong app, rồi clone repo riêng, kéo một image GHCR riêng,
cài một gói GitHub Packages riêng; kiểm không file cấu hình nào chứa token.

**Acceptance Scenarios**:

1. **Given** máy chưa đăng nhập GitHub, **When** bấm "Đăng nhập GitHub" và hoàn tất trên trình duyệt, **Then** màn hiện
   tài khoản, phạm vi quyền, hạn token; git, docker, npm dùng được với máy chủ của GitHub.
2. **Given** đã đăng nhập, **When** mở `~/.docker/config.json`, `~/.npmrc`, `~/.gitconfig`, **Then** chỉ thấy tên helper
   của app, không thấy token.
3. **Given** token sắp hết hạn, **When** công cụ cần token, **Then** app tự làm mới mà người dùng không phải làm gì; làm
   mới không được thì báo trên app và trong lỗi của công cụ có câu tiếng Việt chỉ cách đăng nhập lại.
4. **Given** người dùng bấm "Đăng xuất GitHub", **Then** token bị xoá khỏi kho khoá và thu hồi ở GitHub nếu GitHub cho
   phép; lần gọi sau của git báo cần đăng nhập.

---

### User Story 2 - Chặn tiến trình lạ lấy token (Priority: P1)

Agent AI chạy không hỏi quyền đọc được một đoạn prompt injection bảo nó lấy token. Bộ môi giới chỉ trả token cho đúng
công cụ được phép (git cho máy chủ git, docker cho registry, …) và chỉ cho máy chủ mà công cụ đó đang kết nối. Token nhạy
cảm (cloud, hạ tầng) cần người dùng bấm cho phép trên máy mỗi lần hay mỗi phiên.

**Why this priority**: Không có phần này thì kho token tập trung còn nguy hiểm hơn file rải rác (D1).

**Independent Test**: Từ một script không nằm trong danh sách cho phép, gọi helper của app xin token GitHub; kiểm bị từ
chối và có dòng nhật ký.

**Acceptance Scenarios**:

1. **Given** một tiến trình không thuộc danh sách cho phép, **When** gọi bộ môi giới xin token, **Then** bị từ chối, nhật ký
   ghi tên chương trình, thời điểm, hệ thống bị xin.
2. **Given** git xin token cho máy chủ không phải GitHub, **Then** bộ môi giới không trả token GitHub.
3. **Given** token đánh dấu "cần xác nhận" (vd. AWS, Kubernetes, Cloudflare), **When** công cụ xin, **Then** app hiện hộp
   "Cho phép <chương trình> dùng tài khoản <x> trong <n> phút?"; từ chối hoặc không trả lời trong 60 giây thì công cụ nhận lỗi.
4. **Given** người dùng xem màn "Nhật ký dùng token", **Then** thấy từng lần dùng (chương trình, hệ thống, kết quả) 30 ngày
   gần nhất; không bao giờ thấy token.
5. **Given** biến môi trường của tiến trình agent AI chạy không hỏi quyền, **Then** không chứa token thô do app đặt vào.

---

### User Story 3 - Cloud và Cloudflare (Priority: P1)

Lập trình viên đăng nhập AWS (IAM Identity Center), Azure, Google Cloud, Cloudflare từ app. Các CLI (`aws`, `az`, `gcloud`,
`wrangler`, `cloudflared`) và SDK dùng được. App dùng cơ chế đăng nhập chính thức của từng CLI khi có, không viết lại.

**Why this priority**: Token cloud là loại nguy hiểm nhất khi lộ và đang hay nằm trong `.env`.

**Independent Test**: Đăng nhập Cloudflare trong app, chạy `wrangler whoami` và `wrangler deploy` thử ở một dự án mẫu; đăng
nhập AWS SSO, chạy `aws sts get-caller-identity`.

**Acceptance Scenarios**:

1. **Given** máy có CLI của hệ thống, **When** đăng nhập trong app, **Then** CLI đó dùng được ngay, app hiện tài khoản và hạn.
2. **Given** máy chưa có CLI, **Then** app chỉ dẫn cài (qua màn Môi trường như spec 025) trước khi đăng nhập.
3. **Given** Cloudflare Access bảo vệ một ứng dụng nội bộ, **When** đăng nhập "Cloudflare Access" cho ứng dụng đó, **Then**
   `cloudflared access` dùng được với ứng dụng đó.

---

### User Story 4 - Hệ thống tự host và hạ tầng (Priority: P2)

Đội dùng GitLab tự host, GitHub Enterprise, Argo CD, Kubernetes, Vault, Docker Hub, Bitbucket Cloud. Quản trị đăng ký ứng
dụng OAuth một lần trên hub (trình hướng dẫn từng bước cho từng loại); máy thành viên thấy sẵn nút đăng nhập cho các hệ
thống đó. Kubernetes và Argo CD dùng token ngắn hạn qua cơ chế plugin của chúng.

**Why this priority**: Phần lớn đội dùng GitLab tự host; nhưng cần quản trị làm trước nên để sau đợt 1.

**Independent Test**: Quản trị đăng ký GitLab tự host trên hub; máy thành viên đăng nhập, clone, `kubectl get pods` qua
cụm cấu hình OIDC.

**Acceptance Scenarios**:

1. **Given** quản trị tổ chức, **When** thêm "GitLab tự host" với địa chỉ máy chủ, **Then** trình hướng dẫn chỉ đúng chỗ
   tạo ứng dụng trên GitLab, kiểm ứng dụng hợp lệ trước khi lưu, và ghi kiểm toán.
2. **Given** máy thành viên, **Then** danh sách hệ thống có các hệ thống tổ chức đã đăng ký, không cần nhập địa chỉ.
3. **Given** kubeconfig do app quản lý, **When** `kubectl` cần token, **Then** app trả token ngắn hạn qua cơ chế exec
   credential, làm mới khi hết hạn.

---

### User Story 5 - Công cụ cộng tác (Priority: P3)

Đăng nhập Microsoft Teams/Graph, Google Workspace, Jira/Confluence Cloud, Slack để MCP server và công cụ dùng. Hệ thống
bắt buộc client secret thì hub làm bước đổi mã (D4); token kết quả về máy, hub không giữ.

**Why this priority**: Giá trị chủ yếu cho MCP và tích hợp; cần quản trị tenant duyệt quyền.

**Independent Test**: Đăng nhập Jira Cloud từ app; một MCP server Jira trên máy dùng được; kiểm hub không lưu token.

**Acceptance Scenarios**:

1. **Given** hệ thống cần hub đổi mã, **When** đăng nhập, **Then** hub chỉ giữ token trong bộ nhớ trong lúc đổi, trả về máy,
   không ghi xuống đĩa hay nhật ký.
2. **Given** tenant cần quản trị duyệt quyền, **Then** app báo rõ "Cần quản trị Microsoft 365 duyệt", kèm liên kết duyệt.
3. **Given** MCP server cấu hình bởi app, **Then** token được đưa vào tiến trình MCP lúc khởi động, không ghi vào file cấu
   hình MCP.

---

### User Story 6 - Token nhập tay cho hệ thống không có SSO (Priority: P2)

Jenkins, SonarQube, PyPI, Nexus, Harbor, Bitbucket/Jira Data Center, bot Telegram, API key của Claude/OpenAI/Gemini: người
dùng dán token một lần vào app; app giữ trong kho khoá và đưa cho công cụ qua cùng bộ môi giới, cùng luật ở US2.

**Why this priority**: Không có SSO nhưng vẫn cần bỏ token khỏi file chữ thường.

**Independent Test**: Dán token SonarQube, chạy `sonar-scanner` qua app; kiểm `SONAR_TOKEN` không nằm trong file nào.

**Acceptance Scenarios**:

1. **Given** dán token, **When** lưu, **Then** app kiểm token với hệ thống (gọi API "tôi là ai" nếu có) trước khi lưu.
2. **Given** token có hạn, **Then** app nhắc trước 7 ngày.
3. **Given** API key của CLI AI, **Then** app chỉ đưa vào biến môi trường của đúng CLI đó khi CLI chạy từ app; không đọc
   hay chép token đăng nhập gói thuê bao (D5).

---

### User Story 7 - Dọn token cũ đang nằm trong file (Priority: P2)

App quét các chỗ hay chứa token (`.env` trong dự án đã gắn, `~/.npmrc`, `~/.docker/config.json`, `~/.aws/credentials`,
`~/.claude.json` mục MCP, biến môi trường hệ thống), báo token nào nằm ở đâu, và đề nghị chuyển vào bộ môi giới (có xem
trước, có sao lưu, hoàn tác được).

**Why this priority**: Bộ môi giới chỉ an toàn khi token cũ không còn nằm ngoài.

**Independent Test**: Đặt token giả vào `~/.npmrc` và `.env`; quét; chuyển; kiểm file chỉ còn tham chiếu helper và npm vẫn
chạy.

**Acceptance Scenarios**:

1. **Given** máy có token trong file, **When** quét, **Then** app liệt kê file, dòng, hệ thống đoán được; không hiện token
   đầy đủ (chỉ 4 ký tự cuối).
2. **Given** người dùng chọn chuyển, **Then** file được sửa để trỏ tới helper, bản cũ sao lưu; hoàn tác trả lại y nguyên.

### Edge Cases

- Kho khoá hệ điều hành bị khoá (máy vừa mở, Linux không có keyring): app báo, không lưu token ra file thay thế.
- Hai tài khoản cùng hệ thống (GitHub cá nhân và công ty): chọn theo máy chủ hoặc theo tổ chức/đường dẫn repo; không đoán
  được thì hỏi.
- Mất mạng khi cần làm mới: dùng token còn hạn; hết hạn thì công cụ nhận lỗi tiếng Việt.
- Đổi máy, cài lại hệ điều hành: token không theo (D4), phải đăng nhập lại; app liệt kê hệ thống đã từng đăng nhập (chỉ
  tên, không token) để làm lại nhanh.
- Công cụ đã có helper riêng (Git Credential Manager, `docker-credential-desktop`): app báo xung đột, cho chọn giữ hay thay.
- Hệ thống thu hồi token phía máy chủ: lần gọi sau thất bại, app đánh dấu "cần đăng nhập lại".
- Quản trị gỡ đăng ký hệ thống tự host trên hub: máy thôi hiện nút, token đã có vẫn dùng tới khi hết hạn.

## Requirements *(mandatory)*

### Functional Requirements

**Bộ môi giới (US1, US2)**

- **FR-001**: Token chỉ lưu trong kho khoá của hệ điều hành; không có đường lưu ra file chữ thường.
- **FR-002**: Công cụ lấy token qua cơ chế chính thức của nó (helper của git, docker, exec credential của kubectl, cấu
  hình trỏ helper của npm/pip, chương trình đăng nhập của CLI cloud), theo đúng máy chủ đang kết nối.
- **FR-003**: Bộ môi giới chỉ trả token cho chương trình trong danh sách cho phép của hệ thống đó; nhận diện chương trình
  bằng đường dẫn thật và chữ ký (nếu hệ điều hành cho kiểm), không bằng tên tiến trình tự khai.
- **FR-004**: Mỗi hệ thống có mức "tự động" hoặc "cần xác nhận"; mặc định "cần xác nhận" cho cloud, hạ tầng (Kubernetes,
  Vault, Argo CD), Cloudflare; xác nhận có hạn (mặc định 15 phút, người dùng đổi được).
- **FR-005**: Không đặt token thô vào biến môi trường của tiến trình agent AI. Agent cần gọi hệ thống thì đi qua công cụ
  dùng helper hoặc qua MCP server do app khởi động.
- **FR-006**: Nhật ký mỗi lần dùng (chương trình, hệ thống, tài khoản, kết quả, thời điểm), giữ 30 ngày trên máy; không ghi
  token. Nhật ký không gửi lên hub ở spec này.
- **FR-007**: Đăng xuất xoá token và thu hồi phía hệ thống khi hệ thống có API thu hồi.
- **FR-008**: Làm mới token tự động trước khi hết hạn khi hệ thống hỗ trợ.

**Đăng nhập (US1, US3, US4, US5, US6)**

- **FR-010**: Đăng nhập qua trình duyệt mặc định bằng luồng dành cho ứng dụng cài trên máy (mã thiết bị hoặc chuyển hướng
  về cổng cục bộ, có PKCE) khi hệ thống hỗ trợ; không nhúng trang đăng nhập trong app.
- **FR-011**: Hệ thống có CLI chính thức tự đăng nhập (AWS, Azure, Google Cloud, Cloudflare `wrangler`, Argo CD, Vault, …)
  thì app gọi CLI đó và theo dõi trạng thái, không tự làm lại luồng.
- **FR-012**: Hệ thống tự host cần đăng ký ứng dụng: quản trị tổ chức đăng ký trên hub một lần (trình hướng dẫn, kiểm hợp
  lệ, kiểm toán); hub chỉ lưu id ứng dụng và địa chỉ, secret (nếu có) mã hoá bằng khoá chủ như spec 020.
- **FR-013**: Hệ thống bắt buộc client secret: hub làm bước đổi mã và làm mới; token kết quả trả về máy, hub không lưu
  (chỉ giữ trong bộ nhớ của lần gọi).
- **FR-014**: Hệ thống không có SSO: nhập tay, kiểm với API "tôi là ai" nếu có, nhắc hết hạn trước 7 ngày.
- **FR-015**: Hỗ trợ đăng nhập qua IdP của công ty khi hệ thống đích tin IdP đó: Microsoft Entra ID, Google Workspace,
  Keycloak (OIDC chuẩn); và trường hợp không có IdP chung.
- **FR-016**: Không lấy, không đọc, không chuyển tiếp token đăng nhập gói thuê bao của Claude Code, Codex, Gemini/Antigravity (D5).

**Dọn token cũ (US7)**

- **FR-020**: Quét các vị trí hay chứa token ở bảng của plan; chỉ hiện 4 ký tự cuối.
- **FR-021**: Chuyển token vào bộ môi giới có xem trước, sao lưu, hoàn tác; không sửa file git đang theo dõi (báo người
  dùng gỡ token khỏi repo và xoay token).

**Chung**

- **FR-030**: Màn "Đăng nhập dịch vụ" trên app desktop: danh sách hệ thống theo nhóm, trạng thái từng tài khoản (đã đăng
  nhập, sắp hết hạn, cần đăng nhập lại), nút đăng nhập/đăng xuất, mức xác nhận, nhật ký.
- **FR-031**: Mọi chữ giao diện và lỗi tiếng Việt (từ điển vi/en của app). Lỗi trả cho công cụ dòng lệnh cũng tiếng Việt.
- **FR-032**: Dữ liệu hub mới (đăng ký hệ thống tự host) cách ly theo tổ chức, quyền quản trị kiểm ở module, có kiểm toán.

### Hệ thống (phạm vi, chốt lại ở plan sau khi kiểm tài liệu chính thức)

| Nhóm | Hệ thống | Cách lấy token (dự kiến) |
|---|---|---|
| Đợt 1 — Git, registry, cloud | GitHub.com, GitLab.com, Azure DevOps; GHCR, GitLab registry; npm (GitHub Packages, npmjs); AWS IAM Identity Center, Azure, Google Cloud; **Cloudflare** (`wrangler`, API token, Cloudflare Access `cloudflared`); Vercel, Netlify, Supabase, Firebase | OAuth mã thiết bị/PKCE hoặc CLI chính thức |
| Đợt 1 — mobile | **Expo / EAS** (`eas login`, có SSO cho tổ chức; `EXPO_TOKEN` cho máy build), App Store Connect (khoá API `.p8`), Google Play (khoá tài khoản dịch vụ JSON) | CLI chính thức; khoá App Store, Google Play nhập tay như token và chỉ đưa cho `eas`/`fastlane` khi build |
| Đợt 2 — tự host, hạ tầng | GitLab tự host, GitHub Enterprise Server, Bitbucket Cloud; Argo CD; Kubernetes (OIDC, EKS/AKS/GKE); HashiCorp Vault; Docker Hub; Terraform Cloud/HCP; Sentry; DigitalOcean | OAuth có đăng ký theo máy chủ, OIDC, CLI chính thức |
| Đợt 3 — cộng tác | Microsoft Teams/Graph, Google Workspace, Jira/Confluence Cloud, Slack | OAuth; hub đổi mã khi cần secret |
| Nhập tay | Jenkins, SonarQube, PyPI, Nexus/Artifactory, Harbor, Bitbucket/Jira/Confluence Data Center, bot Telegram, API key Claude/OpenAI/Gemini | Dán token, kiểm, nhắc hạn |
| IdP gốc | Microsoft Entra ID, Google Workspace, Keycloak | OIDC chuẩn |

### Key Entities

- **Hệ thống**: một dịch vụ ngoài (loại, địa chỉ máy chủ, cách đăng nhập, mức xác nhận mặc định, công cụ được phép).
- **Đăng ký hệ thống tự host** (hub): tổ chức, loại, địa chỉ, id ứng dụng OAuth, secret mã hoá (nếu có), người đăng ký.
- **Tài khoản trên máy**: một lần đăng nhập vào một hệ thống (tên tài khoản, phạm vi, hạn, trạng thái); token nằm trong kho khoá.
- **Quy tắc cho phép**: hệ thống × chương trình được phép × mức xác nhận × thời hạn xác nhận.
- **Nhật ký dùng**: chương trình, hệ thống, tài khoản, kết quả, thời điểm.
- **Phát hiện token cũ**: file, dòng, hệ thống đoán được, 4 ký tự cuối, trạng thái chuyển.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Máy mới đăng nhập GitHub trong app và clone repo riêng trong dưới **2 phút**, không chép token tay.
- **SC-002**: Sau khi dùng app, **0** token của hệ thống đã đăng nhập nằm ở dạng chữ thường trong các vị trí quét được
  (kiểm bằng chính bộ quét US7).
- **SC-003**: **100%** lần xin token từ chương trình ngoài danh sách cho phép bị từ chối trong bộ test.
- **SC-004**: Công cụ không phải đăng nhập lại trong **30 ngày** dùng liên tục với hệ thống có làm mới token.
- **SC-005**: Hub không có token người dùng nào trong cơ sở dữ liệu và nhật ký sau toàn bộ bộ test đợt 3 (kiểm bằng quét).
- **SC-006**: Đợt 1 phủ ít nhất **14** hệ thống ở bảng Hệ thống (kể cả Cloudflare và Expo).

## Assumptions

- Máy có kho khoá hệ điều hành dùng được; Linux không có Secret Service thì tính năng tắt kèm hướng dẫn.
- Mỗi CLI/SDK có cơ chế helper hoặc đăng nhập chính thức như bảng Hệ thống; dòng nào sai khi kiểm thì chuyển sang nhập tay.
- Quản trị tổ chức tự đăng ký ứng dụng OAuth trên hệ thống tự host; app chỉ hướng dẫn.
- Ứng dụng OAuth dùng chung cho hệ thống đám mây (GitHub.com, GitLab.com, Atlassian, Slack…) do xDev Hive đăng ký; bản tự
  host của hub cho phép tổ chức thay bằng ứng dụng của mình.
- Ngoài phạm vi: đồng bộ token giữa các máy (D4), gửi nhật ký dùng token lên hub, đăng nhập hub bằng SSO công ty (spec
  riêng nếu cần), quản lý khoá SSH (spec 023 đã có).
