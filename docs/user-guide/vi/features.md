# Danh sách tính năng

Trang này liệt kê những gì xDev Hive đang làm được trên nhánh `main`, nhóm theo khu vực, kèm chỗ tìm trên giao diện. Bản tiếng Anh: [../en/features.md](../en/features.md).

xDev Hive có hai phần:

- **Hub web**: nơi cả team làm việc (task, chat, tài liệu, quản trị). Mở bằng trình duyệt, ví dụ `https://hub.example.com`.
- **App desktop**: chạy trên từng máy có repo. App giữ kết nối với hub, chạy agent (Claude Code, Codex, Gemini…) trên máy đó, và cài công cụ agent cần. App chỉ có việc của máy; mọi trang khác mở trên web.

Menu web chia ba nhóm: **Làm việc** (Hôm nay, Task, Chat, Quy trình, Tính năng, Lượt chạy), **Không gian** (Tài liệu, Memory, Skill, Artifact, Lịch sử, Sơ đồ) và **Vận hành** (Máy & agent, Cài đặt service, Quản trị). Mỗi người chỉ thấy mục mình có quyền.

Từ ngữ: một **service** là một repo (một project key). Một **hệ thống** gom nhiều service của cùng một sản phẩm. Một **gói** (profile) là một tài khoản agent đã đăng nhập trên máy, ví dụ một tài khoản Claude.

## 1. Khung chung của web

| Tính năng | Ở đâu |
|---|---|
| Ô phạm vi: *Tất cả service*, *Chung (cả team)*, một hệ thống hoặc một service. Mọi trang lọc theo phạm vi này. | Đầu thanh bên |
| Nút *+ Mới*: *Hỏi leader*, *Giao việc nhanh*, *Tính năng mới (đầy đủ)*. Phím ⌘N. | Thanh trên |
| Khung *Hỏi leader* mở từ mọi trang, gửi kèm ngữ cảnh trang đang xem. | Thanh trên |
| Tìm nhanh trang, task, tài liệu, lệnh (⌘K). Phím ⌘1–5: Hôm nay, Chat, Task, Lượt chạy, Tài liệu. | Mọi trang |
| Sáng/tối, ngôn ngữ (Tiếng Việt, English), *Token của tôi*, *Đăng xuất*. | Menu tài khoản |
| Giao diện điện thoại: menu dạng ngăn kéo, bảng thành thẻ, một ngăn mỗi lúc. | Mở web trên điện thoại |

## 2. Task và lượt chạy

| Tính năng | Ở đâu |
|---|---|
| *Hôm nay*: mọi thứ đang chờ bạn quyết, nhóm theo việc (*Cần bạn quyết*, *Cần bạn review*, *Cần bạn kiểm thử*, *Agent đang chờ bạn*, *Theo dõi*). Chỉ gồm mục bạn có quyền xử lý. | Làm việc › Hôm nay |
| Task với ba cách xem *Kanban*, *Board*, *Danh sách*; trạng thái *Chưa làm*, *Đang làm*, *Review*, *Xong*, *Bị chặn*; kéo thẻ để đổi trạng thái. | Làm việc › Task |
| Phụ thuộc giữa task (cùng service, hoặc service khác trong cùng hệ thống). Task còn chờ thì nằm *Bị chặn*; dòng *Sẵn sàng tiếp theo* gợi ý task nên làm trước. | Task › cột *Phụ thuộc* › *Sửa* |
| *Agent phụ trách*: gán task vào hàng của một máy/gói; xem *Theo agent*. | Panel task |
| *Chạy trên máy*: chọn máy và tuỳ chọn rồi bấm *Chạy*. | Panel task |
| *Prompt cho agent*: gửi một prompt tự do, Hive tạo task `P-<n>`; gửi được cho nhiều agent cùng lúc để so sánh. | Task |
| *Giao cho agent (n)*: chọn nhiều task, tạo một *đợt chạy* với số chạy song song tối đa. | Task › chọn nhiều task |
| *Chia việc*: một việc lớn tách thành việc con cho nhiều agent, tự viết danh sách hoặc *Nhờ agent chia*. | Task |
| *Chuỗi vai*: chạy các bước nối nhau trên cùng branch (ví dụ viết code → viết test → review). | Panel task |
| *Lịch sử ghi chú*: mỗi lần agent hay người cập nhật ghi chú bàn giao đều giữ một phiên bản. | Panel task |
| Nền tảng của task (Windows, Linux, macOS): hub chỉ giao cho máy đúng nền tảng. | Panel task |
| *Lượt chạy*: run của mọi máy, lọc *Cần theo dõi*, *Đang chạy*, *Chờ máy*, *Chờ người*, *Lỗi*, *Xong*; lọc theo đợt, task, máy. | Làm việc › Lượt chạy |
| Trang một run: *Các bước của run*, bàn giao (*ĐÃ LÀM / CHƯA LÀM / CÁCH KIỂM / RỦI RO*), *Log*, *Thay đổi* (diff), MR/PR và CI. | Lượt chạy › chọn một run |
| Thao tác trên run: *Huỷ run*, *Nhắn agent* (chỉ dẫn thêm cho run đang chạy), *Merge*, *Yêu cầu sửa*, *Giao lại* (đổi máy, gói, làm tiếp trên branch), *Chạy lại*. | Trang run |
| Review chéo: run làm xong được review bằng agent của hãng khác; kết luận *Review: đạt* hay *Review: cần sửa*. | Tự động |
| *Duyệt kế hoạch trước khi code*: agent lập kế hoạch chỉ đọc, chờ *Duyệt* hay *Sửa kế hoạch*; tự duyệt sau thời hạn nếu được bật. | Hôm nay, panel task |
| Review diff theo hunk, *Cờ rủi ro* (migration, quyền, bảo mật, xoá dữ liệu, file lớn), *Xếp lượt sửa*. | Trang run › *Thay đổi* |
| GitLab MR / GitHub PR: tự tạo sau review, theo dõi CI, tự giao agent sửa khi pipeline lỗi, MR merge thì task sang *Xong*. | App: Cài đặt máy › *Merge request / Pull request* |
| *Hàng chờ merge*: máy *Cổng kiểm* gom các nhánh thành lô, chạy kiểm tra, xanh thì đưa vào nhánh đích. | Lượt chạy (chọn một service) |
| *Artifact*: ảnh, báo cáo, tệp agent làm ra trong run, gắn với run và task. | Không gian › Artifact, panel task, trang run |
| *Sơ đồ*: task và phụ thuộc, lớp agent (kéo thả để gán), lớp SDLC và hệ thống. | Không gian › Sơ đồ |
| *Lịch sử*: timeline và tìm nội dung trong run, chat, chốt SDLC, nhật ký quản trị. | Không gian › Lịch sử |

## 3. Quy trình, tính năng và phát hành

| Tính năng | Ở đâu |
|---|---|
| *Tính năng*: mỗi tính năng theo bước (Spec, Plan, Tasks, Đang làm, Review, Xong); tab Spec, Plan, Tasks, *Kiểm thử*, *Lượt chạy*, *Lịch sử chốt*; nút *Cho qua* / *Yêu cầu sửa* tại chốt. | Làm việc › Tính năng |
| Spec Kit: agent viết `spec.md`, `plan.md`, `tasks.md` (*Tính năng mới*, *Lập kế hoạch*, *Chia việc*); *Nhập thành task* giữ phụ thuộc. | Tính năng; *+ Mới* › *Tính năng mới (đầy đủ)* |
| *Quy trình*: tab *Kết quả cần nghiệm thu* và *Quy trình & model*; chốt từng bước (*Người duyệt*, *AI kiểm*, *Tự động*), bộ cài sẵn (*Thận trọng*, *Cân bằng*, *Tự động tối đa*, *Lối nhanh*), số liệu 30 ngày. | Làm việc › Quy trình |
| *Tự giao task*: hub tự giao task sẵn sàng cho gói rảnh. | Quy trình |
| *Model theo loại task*: chọn cấp model theo loại và cỡ task, cho từng bước. | Quy trình › *Quy trình & model* |
| Phát hành: chốt *Phát hành*, *Duyệt phát hành* hay *Từ chối*, hàng chờ phát hành. | Quy trình |

## 4. Agent, máy và quota

| Tính năng | Ở đâu |
|---|---|
| Nhiều loại agent: Claude Code, Codex (ChatGPT), Gemini CLI, Antigravity, GitHub Copilot CLI, Mistral Vibe, OpenCode, Kilo Code. | App › Gói agent › *Thêm gói* |
| Đăng nhập CLI ngay từ app, mỗi gói một thư mục riêng; *Mở CLI* để làm tay. | App › Gói agent |
| Quota: phiên 5 giờ và tuần, *Ngưỡng dừng*, *Đọc lại quota*, *Dùng tiếp*, chi phí ước tính, token và tỉ lệ đọc cache. | App › Gói agent; web › Máy & agent › Quota |
| Xoay vòng gói: hết quota thì chuyển gói khác, gói reset sớm được dùng trước, phần làm dở được commit và làm tiếp. | Tự động |
| *Nhận việc trên máy này*: bật nhận run từ hub, *Tối đa cùng lúc*. | App › Gói agent |
| Chạy trong container Docker, mạng giới hạn (tuỳ gói). | App › Gói agent › *Sửa* |
| *Bản đồ agent*: máy → gói → run, chọn gói để *Prompt cho agent*. | Vận hành › Máy & agent |
| *Đội máy*, *Hàng đợi*, *Chi phí* (admin hub). | Máy & agent |
| *Dừng mọi agent* / *Cho agent chạy lại* cho một service hoặc cả hub. | Quản trị › Tổng quan vận hành; trang *Tổng quan* (⌘K) |
| Worktree: mỗi task một worktree trên branch `ai/<task>`; tự dọn khi nhánh đã đẩy lên remote. | App › Worktree |

## 5. Chat với leader

| Tính năng | Ở đâu |
|---|---|
| Chat với agent *leader* của một service (leader biết các service cùng hệ thống), hoặc *Toàn hub* (admin hub). Leader đọc task, run, tài liệu và đề xuất việc. | Làm việc › Chat, khung *Hỏi leader* |
| Đề xuất của leader (tạo task, xếp run, merge, đổi chính sách…) chờ *Xác nhận*; *Xác nhận tất cả (n)*, *Bỏ qua tất cả*. | Chat, Hôm nay |
| *Leader tự chạy* và *Lệnh leader được chạy*: chọn loại đề xuất leader được tự làm và lệnh nó được chạy. | Chat › *Hướng dẫn leader*; Cài đặt service › *Leader* |
| Lệnh `/assign`, `/research`, `/status`, `/release`, `/cancel`, `/retry`. | Ô nhập chat, gõ `/` |
| *Kế hoạch* từ chat: spec, task và tiêu chí xong, bấm *Làm*. *Nghiên cứu* chỉ đọc, có báo cáo và *Biến thành Kế hoạch*. | Chat |
| Đính kèm tệp, chọn *Model* và *Mức nỗ lực*, *Hướng dẫn leader*. | Chat |

## 6. Tài liệu, memory và skill

| Tính năng | Ở đâu |
|---|---|
| Tài liệu theo không gian (Chung, Hệ thống, Service), cây trang, trình soạn có Markdown, bảng, Mermaid, ảnh và tệp đính kèm, *Lịch sử* và so sánh phiên bản. | Không gian › Tài liệu |
| *Áp dụng cho* (đường dẫn trong repo), *Trong AGENTS.md*; đồng bộ ra repo thành `AGENTS.md`, `CLAUDE.md`, rule theo đường dẫn. | Tài liệu, app › *Đồng bộ tài liệu* |
| Tab *Chờ duyệt*: đề xuất sửa của agent hoặc người không có quyền sửa thẳng; duyệt nhiều mục một lần. | Tài liệu › *Chờ duyệt* |
| *Trợ lý viết*: viết nháp, viết tiếp, cập nhật theo code, kiểm tra mâu thuẫn, tóm tắt cho agent. | Tài liệu › *Trợ lý* |
| *Xoá trang* (xoá mềm, *Khôi phục* được), chuyển trang sang không gian khác. | Tài liệu |
| Memory: điều agent học được; lọc *Chờ duyệt*, *Mâu thuẫn*, *Cần xem lại*, *Chỉ mục cũ*; nút *Duyệt*, *Giữ lại*, *Vẫn đúng*. | Không gian › Memory |
| *Dọn memory định kỳ*. | Cài đặt service › *Context agent* |
| Skill: hướng dẫn cho agent, chung cả team hoặc riêng service; số run dùng 30 ngày, lọc *Skill không ai dùng*. | Không gian › Skill |

## 7. Hệ thống, group và repo

| Tính năng | Ở đâu |
|---|---|
| Tạo hệ thống, gom service; tài liệu và memory của hệ thống. | Cài đặt service › *Hệ thống* |
| Lưu trữ, khôi phục, *Xoá hẳn* service (xoá hẳn có backup trước). | Cài đặt service › *Hệ thống* › thẻ *Service* |
| *Liên kết group*: nối hệ thống với một group GitLab hoặc owner GitHub, xem trước service khớp. | App › Công cụ & setup › phần của hệ thống |
| *Init group trên máy này*: clone các repo còn thiếu theo cây của group; *Đồng bộ ngay*. | App › Công cụ & setup |
| *Repo trên máy*: branch, ahead/behind, thay đổi, quyền truy cập; *Fetch tất cả*, *Pull*, *Pull tất cả* (chỉ fast-forward). | App › Công cụ & setup › phần của hệ thống |
| *Mở <CLI> cho hệ thống*: một phiên CLI thấy mọi repo của hệ thống trên máy. | App › Công cụ & setup |
| Kiểm repo truy cập được không (`git ls-remote` mỗi 6 giờ), hiện trên trang Hệ thống. | Cài đặt service › *Hệ thống* |
| *Nhập từ group GitLab* / *Nhập từ GitHub*, *Gom vào hệ thống*. | App › Công cụ & setup (khi đã có token) |
| *Repo tham chiếu*: run đọc được repo khác cùng hệ thống, chỉ đọc. | App › Công cụ & setup › *Service trên máy này* |
| Admin hub thêm/gỡ dự án trên một máy từ web (*Dự án trên từng máy*). | Máy & agent › *Bản đồ agent* |

## 8. Cài đặt trên một máy (app desktop)

| Tính năng | Ở đâu |
|---|---|
| *Bắt đầu*: các bước *Kết nối*, *Công cụ*, *Service*, *Gói agent*, *Nhận việc*, mỗi bước có *Làm ngay*. | Tự mở lần đầu; ⌘K › *Bắt đầu* |
| *Máy này*: kết nối hub, tài nguyên (CPU, bộ nhớ, ổ đĩa), phiên bản app và cập nhật. | App › Máy này |
| *Công cụ & setup*: CLI agent, lệnh `hive-mcp` (*Kết nối agent với Hive*), Spec Kit, codegraph; *Cài hết những gì còn thiếu*; yêu cầu cài từ admin (*Đồng ý và cài* / *Từ chối*); *Tool từ hub* (*Cho phép*). | App › Công cụ & setup |
| *Cài đặt máy*: *Kết nối* (hub), *Nâng cao* (tên máy, chuyển dữ liệu với hub), *Kết nối GitLab/GitHub* (token của máy, không gửi lên hub), *Merge request / Pull request*. | App › Cài đặt máy |
| *Run trên máy*, *Worktree* (dung lượng, xoá, tự dọn). | App |
| Chế độ cục bộ: *Dùng một mình trên máy này*, không cần hub. | App › Bắt đầu / Cài đặt máy |
| Terminal từ xa trên máy agent (khi admin bật trên hub). | ⌘K › *Terminal* |

## 9. Cập nhật và phát hành app

| Tính năng | Ở đâu |
|---|---|
| Tải app từ GitHub Releases: macOS (`.dmg`), Windows (`.exe`), Linux (`.AppImage`, `.deb`). | https://github.com/tdduydev/xdev-hive/releases |
| App tự tải bản mới từ hub; cài khi người dùng khởi động lại, khi thoát, hoặc khi không có run (*Tự cập nhật khi không có run*). | App › Máy này › *Cập nhật* |
| Rollout: *Đặt làm bản đích*, *Tạm dừng*, *Cài khi nào*, *Bản tối thiểu để nhận run từ hub*, phân bố phiên bản. | Quản trị › *Phiên bản app* |

## 10. Quản trị hub

| Tính năng | Ở đâu |
|---|---|
| *Tổng quan vận hành*: sức khoẻ hub, hàng đợi, chi phí, *Dừng mọi agent*. | Quản trị |
| *Người dùng & quyền*: *Mời người dùng* (*Link mời* hoặc *Tạo tài khoản*), vai trò hub, khoá, thùng rác. | Quản trị |
| *Vai trò & quyền* (ma trận quyền theo service), *Sơ đồ tổ chức*. | Quản trị |
| Vai trò theo service: *Người xem*, *Thành viên*, *QA*, *Reviewer*, *Quản lý service*, *Tuỳ chỉnh*. | Quản trị › Người dùng & quyền; Cài đặt service › *Thành viên* |
| *Chính sách* (chính sách agent, trần chốt SDLC của hub), *Tool* (danh mục tool có phiên bản ghim). | Quản trị |
| *Ngân sách* (trần chi tiêu), *Cảnh báo*, *Nhật ký*, *Thông báo & webhook* (Teams, Slack). | Quản trị |
| *Hub*: phiên bản, database, tệp tài liệu, *Backup ngay*, danh sách *Các bản backup* (*Ghim*, *Tải về*, *Khôi phục project*). | Quản trị › Hub |
| Đăng nhập SSO (OpenID Connect), liên kết tài khoản SSO. | Trang đăng nhập, menu tài khoản |
| Thao tác xoá dữ liệu do agent gọi phải chờ một người duyệt. | Hôm nay; Tài liệu › *Chờ duyệt* |

## 11. Tool MCP cho agent

Agent (Claude Code, Codex, Gemini…) nói chuyện với Hive qua server MCP `xdev-hive`. Quyền của tool theo token; token chỉ đọc chỉ thấy tool đọc.

| Nhóm | Tool |
|---|---|
| Task | `task_list`, `task_get`, `task_next`, `task_claim`, `task_update`, `task_notes`, `task_create`, `task_set_deps`, `task_status`, `task_assign` |
| Tài liệu, skill | `doc_list`, `doc_get`, `doc_asset`, `doc_propose`, `skill_list`, `skill_get`, `skill_propose` |
| Memory | `memory_search`, `memory_write`, `memory_list` |
| Run, máy | `run_list`, `run_get`, `run_count`, `run_requests`, `run_dispatch`, `machine_list`, `setup_missing` |
| Chi phí, chính sách | `cost_summary`, `token_usage`, `policy_get`, `alert_list`, `project_list`, `tool_list`, `tool_status` |
| Artifact | `artifact_put`, `artifact_list`, `artifact_get` |
| Leader (chat) | `plan_create`, `propose_task`, `propose_task_status`, `propose_task_classify`, `propose_task_agent`, `propose_run`, `propose_research`, `propose_plan`, `propose_cancel_run`, `propose_merge`, `propose_profile`, `propose_policy`, `propose_stop_agents`, `propose_resume_agents`, `propose_install`, `propose_tool` |

Một số tool chỉ có ở một vai (ví dụ tool `propose_*` chỉ có trong phiên leader của chat). Agent thấy danh sách tool đúng với token của nó qua lệnh `/mcp` của CLI.
