# 76. access-first: phân quyền cho phòng ban dùng MCP và duyệt tài liệu, rồi tách app khỏi web

Hỏi 9/10: "nghiên cứu cách code app tối ưu, tách web, app ra hai phần riêng không làm chung vì bị rối, cái nào là web admin cái nào là tính năng của client, và tập trung vào bộ phân quyền trước… mình sẽ bắt đầu cấp account cho các phòng ban dùng MCP, và người dùng sẽ đọc và duyệt tài liệu… đơn giản và quản lý đủ."

**Trạng thái: người dùng đã duyệt ngày 9/10.** Các quyết định:

- **Q1**: một người thuộc được nhiều phòng ban, và quyền lấy theo vai cao nhất.
- **Q2**: token MCP mặc định có hạn 30 ngày, tối đa 90 ngày.
- **Q3**: người dùng chưa trả lời, nên giữ như hiện tại: admin được tự duyệt đề xuất của mình.
- **Q4**: chọn (b). App chạy một hub nhúng và mở giao diện web trong app.
- **Q5**: người dùng chưa trả lời. Roadmap 72 vẫn đang tạm dừng.

Prompt thiết kế lại UI (tách web và app): [docs/design/76-redesign-prompt.md](../design/76-redesign-prompt.md).

## Tóm tắt

- Khung quyền hiện có đã đủ nền: 16 quyền, 5 vai dự án, 4 vai hub (R-72l-users). Không làm lại từ đầu. Đợt này cần:
  - vá 4 lỗ hổng;
  - gom việc kiểm quyền về một chỗ;
  - thêm **Phòng ban**;
  - thêm **token MCP cá nhân** có hạn và phạm vi;
  - làm rõ luồng **duyệt tài liệu**.
- Quy tắc gốc: một lần gọi được làm gì = quyền của tài khoản ∩ phạm vi token ∩ giới hạn của loại token. Token chỉ thu hẹp quyền, không bao giờ mở rộng. Chỉ phiên web của người mới được duyệt và quản trị.
- Tách app khỏi web làm sau khi lô giao diện 72 vào main, theo 3 bước:
  1. tách bộ giao diện chung (ui-kit);
  2. tách hai shell;
  3. quyết chế độ cục bộ của app.

## 1. Hiện trạng quyền (đọc code main ngày 9/10)

### Ai gọi hub, bằng gì

| Loại | Tạo ở đâu | Sống bao lâu | Được làm gì |
|---|---|---|---|
| Phiên web (mật khẩu, SSO) | `/api/login`, SSO (`apps/web/src/app.ts:474`, `:625`) | 14 ngày | Quyền của tài khoản. Admin không bị giới hạn. |
| Token cá nhân / CI | `tokens.create` (`app.ts:703`) | Không hạn | Người không phải admin chỉ tạo được token viewer hoặc agent. Token có chủ thì theo grants của chủ. |
| Token máy | Đăng nhập trên app hoặc device code (`app.ts:538`, `:554`) | Không hạn, đổi khi đăng nhập lại | Toàn quyền của người đăng nhập. |
| Token khởi tạo (bootstrap) | `server.ts:120` | Vĩnh viễn | Admin không thuộc tài khoản nào. |
| Credential MCP (stdio) | Đổi từ token máy (`app.ts:390`) | 60 phút | Chỉ đọc hoặc agent, có thể gói trong một dự án. |
| Credential của run | Runner xin cho từng run (`app.ts:405`) | 5–1440 phút | Agent, chỉ trên task của run đó. |
| Token trả lời chat | Cấp qua heartbeat (`app.ts:922`) | 30 phút | Quyền thấp hơn giữa người gửi và máy. |
| Xác nhận lại (step-up) cho terminal | `app.ts:669` | Một lần, 5 phút | Mở và xem terminal từ xa. |

Ngoài ra hub đã có endpoint MCP qua HTTP: `POST /mcp`, xác thực bằng `Authorization: Bearer` (`app.ts:1107`). Máy không cài app vẫn nối MCP được bằng token.

### Vai và quyền

- **Vai hub**: trên main, người dùng chỉ là member hoặc admin (cột `admin`). R-72l-users (đã duyệt, **chưa merge**) thêm 4 vai owner, admin, member, viewer, cùng link mời và thùng rác.
- **16 quyền** (`packages/core/src/access.ts:13`): view, taskWork, taskManage, runDispatch, chatUse, chatApprove, docPropose, docEdit, docApprove, contextEdit, memoryWrite, memoryApprove, codeReview, qaVerify, projectSettings, membersManage.
- **5 vai dự án** (`access.ts:52`): Người xem, Thành viên, QA, Reviewer, Quản lý dự án, thêm vai *Tuỳ chỉnh*. Dữ liệu dùng chung ("Chung") là dự án `*`. Hệ thống (system) gộp quyền của các service trong nó. **Chưa có phòng ban hay nhóm.**
- **Tài liệu**:
  - Đọc: cần view.
  - Đề xuất: cần docPropose, kèm `baseVersion`.
  - Duyệt: cần docApprove. Tài liệu agent đọc (AGENTS.md, decisions, skill) thì cần contextEdit.
  - Không ai duyệt đề xuất của chính mình, trừ admin (chính sách `selfApproval: "admins"`).
- **Memory**: trên hub, memory mới phải chờ duyệt (mặc định).

### Lỗi và chỗ rối tìm thấy

**P0, bảo mật:**

1. [Inference: đọc code, chưa thử] Token trả lời chat gọi được toàn bộ `/api/rpc`, vì `app.ts:334` và `:691` chỉ chặn credential của run và MCP. Khi người gửi và máy đều là admin, token này thành admin không giới hạn, và `tokens.create` tạo được token admin không thuộc tài khoản nào (`app.ts:705–710`).
2. [Inference] `#mayApproveTool` (`packages/core/src/sqlite.ts:6803`) chặn agent nhưng không chặn viewer, nên token viewer của chủ máy duyệt được tool và quản lý được worktree. Hub phân biệt người hay agent dựa vào header do client gửi (`source.ts:74`).
3. Token member hoặc agent của một admin không có grants, nên làm được việc ở mọi dự án (`apps/web/src/users.ts:176`).
4. Các RPC riêng của web (tokens, releases, hub, alerts, webhooks, members, users, terminal; `app.ts:694–918`) nằm ngoài bảng quyền `METHOD_ROLES` và không được ghi nhật ký.

**P1, rối và khó quản trị:**

5. Việc kiểm "là admin hub" bị chép ở hơn 15 chỗ. Có ba bảng thứ hạng vai khác nhau (`ROLE_RANK`, `REACH`, `ROLE_CAP`). Quyền của credential run bị viết cứng (`app.ts:300`).
6. Giao diện và hub kiểm quyền lệch nhau ở nút xoá cooldown, trang Chi phí và nút đóng task.
7. Reviewer không duyệt được skill và AGENTS.md, vì cần contextEdit mà chỉ Quản lý dự án có. Tác giả không tự rút được đề xuất của mình. Quản lý dự án thấy mọi tài khoản của hub trong `members.list`.

## 2. Hiện trạng app và web

- Một gói `packages/ui` (~47.600 dòng) chạy cả web lẫn app:
  - app truyền `window.hive` (IPC), web truyền HTTP;
  - giao diện tự đoán đang chạy ở đâu qua `client.desktop` và `me.mode`;
  - 45/224 file rẽ nhánh theo nơi chạy. Nặng nhất là `App.tsx`, `ClientShell.tsx`, `Projects.tsx`, `Agents.tsx`, `Runs.tsx`.
- App bundle luôn cả các trang quản trị của web (chunk đầu 4,2 MB). Vì vậy mọi thay đổi trong `packages/ui` đều buộc phải release app.
- Nhiều trang chỉ dùng chung vì app có chế độ cục bộ. Ở chế độ hub, app chỉ có khoảng 8 trang.
- Bộ giao diện chung (tokens và 26 primitive shadcn) tách ra được gọn: chỉ `dialog` và `sheet` dùng i18n.

## 3. Bên ngoài làm thế nào (đọc ngày 9/10)

- **MCP** ([spec 2026-07-28](https://modelcontextprotocol.io/specification/latest/basic/authorization)): server MCP là OAuth 2.1 resource server, chỉ nhận token có audience đúng là chính nó, và không được chuyển token sang dịch vụ khác.
  - [Claude Code](https://code.claude.com/docs/en/mcp) nhận token Bearer qua header, `${VAR}`, hoặc OAuth.
  - [Codex CLI](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) nhận token qua `bearer_token_env_var`, header, hoặc OAuth.
- **Token có phạm vi**: [GitHub fine-grained PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) và [GitLab PAT](https://docs.gitlab.com/user/profile/personal_access_tokens/) đều có hạn, chọn được repo, không vượt quyền người tạo, và hết tác dụng khi người tạo mất quyền.
- **Vai**:
  - [GitLab](https://docs.gitlab.com/user/permissions/): vai kế thừa từ group xuống project, project chỉ được nâng vai chứ không hạ.
  - [GitLab service account](https://docs.gitlab.com/user/profile/service_accounts/): máy có danh tính riêng.
  - GitHub: owner/member ở cấp org, cộng vai riêng theo repo.
- **Duyệt**:
  - Tác giả không tự duyệt ([GitHub](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews), [GitLab](https://docs.gitlab.com/user/project/merge_requests/approvals/settings/)).
  - Có người duyệt theo đường dẫn ([CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)).
  - Lần duyệt gắn với một phiên bản: nội dung đổi thì phải duyệt lại.

## 4. Thiết kế quyền

### Nguyên tắc

1. Một lần gọi được làm gì = quyền của tài khoản trong dự án ∩ phạm vi token ∩ giới hạn của loại token. Không có đường nào để token rộng hơn người tạo ra nó.
2. Hub kiểm quyền ở một chỗ, cho mọi method, kể cả RPC riêng của web. Giao diện dùng đúng bảng đó để ẩn hoặc khoá nút.
3. Chỉ phiên web của người được:
   - duyệt: tài liệu, memory, skill, đề xuất của leader;
   - quản trị: người dùng, phòng ban, token, chính sách.
4. Agent và máy có danh tính riêng. Danh tính đó sống ngắn hoặc thu hồi được, và luôn gắn với một tài khoản chịu trách nhiệm.
5. Ít vai. Mỗi vai được giải thích bằng những việc làm được, không bằng tên quyền.

### Vai cấp hub (giữ 4 vai của R-72l-users)

| Vai | Làm gì |
|---|---|
| Chủ hub | Như Quản trị, cộng việc cấp và thu hồi vai Chủ hub. Nên có 1–2 người. |
| Quản trị | Quản lý người dùng, phòng ban, token, chính sách, phiên bản app, vận hành hub. Thấy mọi dự án. |
| Thành viên | Làm việc theo vai của mình trong từng dự án và phòng ban. |
| Người xem | Chỉ đọc, kể cả khi grant cho phép nhiều hơn. |

### Phòng ban (mới)

- Một phòng ban gồm một nhóm tài khoản và vai của nhóm đó trên một số dự án hoặc hệ thống. Ví dụ "Phòng eHospital": Reviewer trên `ehospital-ai`, Người xem trên Chung.
- Quản trị tạo phòng ban, chọn trưởng phòng và gán dự án cho phòng.
- Trưởng phòng được:
  - thêm và bớt thành viên của phòng;
  - tạo link mời vào phòng;
  - đặt vai cho từng thành viên, **không cao hơn vai của phòng**.

  Trưởng phòng không đụng được phòng khác.
- Quyền thật trong một dự án = vai cao nhất giữa vai riêng của tài khoản và vai từ mọi phòng nó thuộc. Một người thuộc được nhiều phòng ban (Q1, đã duyệt).

### Vai dự án (giữ 5 vai và Tuỳ chỉnh, sửa 3 chỗ)

| Việc làm được | Người xem | Thành viên | QA | Reviewer | Quản lý dự án |
|---|---|---|---|---|---|
| Đọc task, tài liệu, memory, run | ✓ | ✓ | ✓ | ✓ | ✓ |
| Nhận và cập nhật task | | ✓ | | ✓ | ✓ |
| Chat với leader **(đổi: thêm cho Thành viên và Reviewer)** | | ✓ | | ✓ | ✓ |
| Đề xuất tài liệu, ghi memory | | ✓ | | ✓ | ✓ |
| Duyệt tài liệu, memory, skill của người khác **(đổi: thêm skill và AGENTS.md cho Reviewer)** | | | | ✓ | ✓ |
| Nghiệm thu code (từ review sang xong) | | | ✓ | ✓ | ✓ |
| Kiểm thử QA | | | ✓ | | ✓ |
| Tạo task, giao run cho máy, duyệt đề xuất của leader | | | | (duyệt đề xuất) | ✓ |
| Sửa thẳng tài liệu agent đọc, cài đặt dự án, thành viên | | | | | ✓ |

Đổi thứ ba: tác giả **rút** được đề xuất của chính mình.

Bên trong vẫn là 16 quyền cũ. Không cần migration dữ liệu grants, chỉ đổi bảng vai → quyền.

### Token và đăng nhập

| Loại | Ai tạo | Hạn | Phạm vi |
|---|---|---|---|
| Phiên web | Người, khi đăng nhập | 14 ngày | Đủ quyền của tài khoản. Là loại **duy nhất** được duyệt và quản trị. |
| **Token MCP cá nhân** (mới, thay token cá nhân hiện tại) | Người tự tạo ở trang *Kết nối MCP* | Mặc định 30 ngày, tối đa 90 (Q2, đã duyệt) | Chọn dự án (hoặc mọi dự án mình có). Chọn *Chỉ đọc* hoặc *Đọc và đề xuất*. Không bao giờ duyệt hay quản trị. |
| Token máy | Khi đăng nhập trên app | Đổi khi đăng nhập lại | Gắn với máy và tài khoản. Chỉ nhận run và gửi heartbeat. |
| Credential MCP stdio, credential của run | Hub cấp tự động | 60 phút, hoặc theo run | Giữ như hiện tại. |
| Token trả lời chat | Hub cấp qua heartbeat | 30 phút | **Chỉ** gọi tool của leader (đề xuất). Đây là bản vá P0-1. |

Token MCP cá nhân:
- chỉ hiện một lần lúc tạo, hub lưu hash;
- người tạo và admin thấy lần dùng cuối;
- tự hết tác dụng khi tài khoản bị khoá hoặc mất quyền;
- admin xem và thu hồi được mọi token.

Trang *Kết nối MCP* có lệnh mẫu. [Unverified: cú pháp lấy từ tài liệu của hai CLI, chưa chạy thử]
- Claude Code: `claude mcp add --transport http xdev-hive https://hive.xdev.asia/mcp --header "Authorization: Bearer ${HIVE_TOKEN}"`
- Codex: mục `[mcp_servers.xdev-hive]` trong `config.toml`, với `url = "https://hive.xdev.asia/mcp"` và `bearer_token_env_var = "HIVE_TOKEN"`.

Đăng nhập MCP bằng OAuth 2.1 (mở trình duyệt, không phải dán token) để sang đợt sau.

### Duyệt tài liệu

- **Hộp *Chờ bạn duyệt*** ở trang Hôm nay và trang Tài liệu: gom đề xuất tài liệu, skill và memory trong các dự án mà bạn có quyền duyệt.
- Mỗi đề xuất hiện diff, tác giả (người, hoặc agent thay mặt ai) và phiên bản gốc.
  - Người duyệt có các nút **Duyệt**, **Yêu cầu sửa** (kèm ghi chú) và **Từ chối**.
  - Tác giả có nút **Rút**.
- Quy tắc:
  - Không duyệt đề xuất của chính mình. Đề xuất do agent viết được tính là của tài khoản đứng sau agent.
  - Chỉ duyệt được từ phiên web.
  - Lần duyệt gắn với phiên bản. Nếu tài liệu đã đổi thì đề xuất chuyển sang *xung đột* (đã có sẵn).
  - **Người duyệt theo đường dẫn** (tuỳ chọn, giống CODEOWNERS). Ví dụ: `docs/decisions.md` phải do Quản lý dự án duyệt.
- Admin tự duyệt đề xuất của mình: giữ như hiện tại, tức là được phép (Q3 chưa có trả lời). Chủ hub đổi được trong chính sách.
- Mọi lần duyệt hay từ chối đều ghi nhật ký: ai, phiên bản nào, lúc nào. Thông báo đi qua chuông và webhook (đã có sẵn).

### Kiểm quyền một chỗ

- Core có một hàm `authorize(actor, method, target)` dùng cho mọi method. Các RPC riêng của web được đưa vào bảng quyền và vào nhật ký.
- Bỏ các bản chép của việc kiểm admin hub. Gộp 3 bảng thứ hạng vai thành một.
- Test ma trận sinh từ bảng quyền: mỗi loại actor × mỗi method → được hay không. Giao diện dùng `may()` trên cùng bảng đó, có test kiểm nút ẩn đúng chỗ.

### Trang quản trị (web, nhóm Quản trị; thay mục 73e)

- Người dùng: có link mời và thùng rác (từ R-72l-users).
- Phòng ban (mới).
- Token và kết nối MCP: mọi token (loại, chủ, phạm vi, hạn, lần dùng cuối), có nút thu hồi.
- Vai và quyền: bảng chỉ đọc, giải thích mỗi vai làm được gì.
- Nhật ký: cấp quyền, token, duyệt.
- Giữ nguyên: chính sách agent, ngân sách, cảnh báo, webhook, phiên bản app, vận hành hub.

Người dùng thường có thêm:
- *Tài khoản của tôi › Kết nối MCP*: token của chính mình.
- *Phòng ban của tôi*: trưởng phòng quản lý phòng ở đây.

## 5. Tách app và web

Đề xuất làm theo 3 bước (ước lượng công sức là [Inference]):

1. **ui-kit** (nhỏ): tách gói `packages/ui-kit`, gồm tokens, 26 primitive, i18n runtime và vài component chung (DataTable, PageTabs, ErrorBoundary). Web và app chỉ dùng chung gói này và core.
2. **Hai shell** (vừa đến lớn): tách `WebApp` (web: phần người dùng và phần Quản trị) và `DesktopApp` (app: việc của máy). Mỗi bên có menu riêng, và các trang không còn rẽ nhánh theo `me.mode`.
   - Trang của máy (Agents, Projects, Setup, Board của máy…) chuyển về `apps/desktop/src/renderer`.
   - Trang web chuyển về `apps/web/client`.
3. **Chế độ cục bộ của app** (Q4: đã chọn b). App chạy một hub nhúng trên máy và mở giao diện web trong cửa sổ app, thay vì tự chứa mọi trang.
   - App chỉ còn khoảng 8 trang của máy.
   - Đổi giao diện web chỉ cần deploy hub, không phải release app.

Ranh giới app / web / quản trị giữ đúng bảng ở spec 73.

Thời điểm: làm sau khi lô giao diện 72 vào main. Roadmap 72 đang dựa trên shell chung, tách giữa chừng sẽ gây xung đột.

## 6. Chia việc (đề xuất, chưa tạo task)

| Mục | Nội dung | Phụ thuộc |
|---|---|---|
| **76a. access-fixes** | Vá 4 lỗi P0, mỗi lỗi có test | Không (làm ngay được) |
| **76b. one-authorize** | Kiểm quyền một chỗ, đưa RPC của web vào bảng quyền, test ma trận, giao diện khớp hub | 76a |
| **76c. teams** | Phòng ban, trưởng phòng, gộp quyền, link mời theo phòng | R-72l-users vào main, 76b |
| **76d. mcp-tokens** | Token MCP cá nhân (dự án, chỉ đọc hoặc đề xuất, có hạn), trang *Kết nối MCP* có lệnh mẫu, admin thu hồi được | 76b |
| **76e. doc-review** | Hộp *Chờ bạn duyệt*, nút Yêu cầu sửa và Rút, Reviewer duyệt được skill và AGENTS.md, người duyệt theo đường dẫn, nhật ký | 76b |
| **76f. admin-area** | Nhóm Quản trị (thay 73e) | 76c, 76d |
| **76g. ui-kit** | Bước 1 của tách app/web | Lô 72 vào main |
| **76h. two-shells** | Bước 2 (thay 73d) | 76g |
| **76i. local-hub** | Bước 3: hub nhúng trong app (Q4 đã chọn b) | 76h |

## 7. Câu hỏi đã gửi (câu trả lời ở đầu trang)

- **Q1.** Một người được thuộc nhiều phòng ban không? Đề xuất: có, và quyền lấy theo vai cao nhất.
- **Q2.** Hạn của token MCP: mặc định 30 ngày và tối đa 90 ngày (đề xuất), hay không hạn như token hiện nay?
- **Q3.** Admin có được tự duyệt đề xuất của chính mình không? Hiện nay là được, hợp với team nhỏ.
- **Q4.** Chế độ cục bộ của app (khi không có hub) nên thế nào?
  - (a) Giữ đủ trang như spec 73.
  - (b) Chạy hub nhúng và mở giao diện web trong app (đề xuất).
  - (c) Bỏ hẳn: app luôn cần hub.
- **Q5.** Thứ tự làm. 76a làm ngay được vì không phụ thuộc 72. 76c–f cần R-72l-users vào main, tức phải bật lại roadmap 72 để merge lô giao diện. Bạn có đồng ý bật lại 72 song song không?

## Ngoài phạm vi đợt này

- OAuth 2.1 cho MCP.
- Map nhóm SSO sang phòng ban.
- Tài khoản dịch vụ cho CI và bot.
- Hạn dùng và xoay vòng token máy.
