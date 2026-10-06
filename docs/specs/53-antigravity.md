# 53. Gói Antigravity (đăng nhập Google / SSO)

Viết ngày 6/10. Người dùng: "login sso antigravity nữa nhé".

Task: **R-53**.

## Nghiên cứu

Nguồn đọc ngày 6/10/2026 qua công cụ tóm tắt. Chỗ ghi [chưa kiểm] là chưa thử trên máy nào: hiện không máy nào trong nhóm có cài `agy`.

**Antigravity CLI (`agy`):**
- CLI chính thức của Google Antigravity, thay Gemini CLI cho tài khoản cá nhân ([thông báo](https://github.com/google-gemini/gemini-cli/discussions/27274), [releases](https://github.com/google-antigravity/antigravity-cli/releases); bản 1.2.17 ngày 5/10/2026).
- Cài bằng script chính thức ([docs](https://antigravity.google/docs/cli/install/)), ra `~/.local/bin/agy`.

**Chạy không tương tác** ([docs](https://antigravity.google/docs/cli/headless/)):
- lệnh `agy -p "<prompt>"`;
- tuỳ chọn `--output-format text|json|stream-json`, `--print-timeout`, `--model`, `--effort`, `--dangerously-skip-permissions`, `--sandbox`;
- lỗi sau khi đã in ra thì mã thoát 3 và dòng `AGY_ERROR: {...}` ở stderr.

**Đăng nhập:**
- Tài khoản cá nhân: Google OAuth trong trình duyệt. Qua SSH thì in URL và dán mã.
- Workspace / doanh nghiệp: "Business account" → Google Cloud project; IdP ngoài (Okta…) qua Workforce Identity Federation ([docs](https://antigravity.google/docs/enterprise/)).
- Có thể dùng ADC (`AGY_ADC_AUTH=true`, `GOOGLE_CLOUD_QUOTA_PROJECT`) hay `GEMINI_API_KEY`.
- Token nằm trong keyring của hệ điều hành; Linux không có D-Bus thì nằm trong file. [chưa kiểm] Tên mục keyring và đường dẫn file.
- **Chưa có biến chọn thư mục cấu hình** ([#155](https://github.com/google-antigravity/antigravity-cli/issues/155)). Trên macOS và Windows thì mỗi người dùng hệ điều hành một tài khoản. [chưa kiểm] Trên Linux không D-Bus, đặt `HOME` riêng cho từng gói có thể tách được tài khoản.

**Hạn mức:**
- Gói Google AI Pro / Ultra: làm mới mỗi 5 giờ, có trần tuần. Gemini dùng một hạn mức chung; Claude và GPT qua Antigravity dùng một hạn mức riêng ([blog](https://antigravity.google/blog/changes-to-antigravity-plans)).
- `agy -p /usage --output-format json` (từ 1.1.11) đọc hạn mức mà không tốn lượt ([release 1.1.11](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.1.11)). Bản ≤ 1.1.10 coi nó là prompt thường và **tốn lượt**.
- [chưa kiểm] Dạng JSON trả về.

**Điều khoản:** nhân viên Google trả lời trên forum ngày 15/9/2026 ([link](https://discuss.ai.google.dev/t/is-external-orchestration-of-antigravity-cli-headless-mode-supported-with-account-based-usage/183051)), không phải văn bản điều khoản chính thức:
- **Được**: gọi binary `agy` chính thức qua stdin/stdout.
- **Không được**: lấy token OAuth ra dùng ở client khác, hay gọi thẳng API phía sau.
- Điều khoản chính thức cấm dùng phần mềm bên thứ ba để truy cập dịch vụ, và Google đã khoá tài khoản vì việc này (2/2026).

**Gemini CLI** từ 18/6/2026 không còn phục vụ tài khoản cá nhân Pro/Ultra. Gói `gemini` hiện có của Hive chỉ còn hợp với Code Assist cho doanh nghiệp, Google Cloud hay API key.

**Quy tắc và skill** `agy` đọc: `AGENTS.md`, `.agents/rules/`, `.agents/skills/` (skill ui-ux-pro-max của 0.132.0 đã có ở đó), MCP ở `.agents/mcp_config.json` (khoá `serverUrl` cho server từ xa).

## Làm gì

**Loại gói mới `antigravity`** (`AGENT_KINDS`, `PREFER_KINDS`, `AGENT_TEMPLATES`):
- `bin: "agy"`;
- `args: ["-p", "{prompt}", "--output-format", "stream-json", "--print-timeout", "{timeoutMinutes}m", "--dangerously-skip-permissions"]`;
- `roles` plan, implement, review;
- `stopAtSession` 95, `stopAtWeek` 90.

Hive chỉ gọi binary `agy`, **không bao giờ đọc, chép hay dùng token** của nó.

**Chạy:**
- Đọc `stream-json` để có hoạt động và log như Claude/Codex. Nếu dạng sự kiện chưa rõ thì ghi log thô và rút kết quả cuối.
- Mã thoát 3 hay dòng `AGY_ERROR` thì run lỗi, kèm thông điệp.
- Nhận diện hết hạn mức để xoay vòng (24a/24c): đọc chữ trong `AGY_ERROR`. Mẫu chữ đặt trong một hằng có comment nguồn, để dễ sửa khi Google đổi.

**Đăng nhập** (nút **+ Tài khoản Google (Antigravity)** ở *Agent và quota*, cạnh Claude và ChatGPT):
- Mở `agy` trong cửa sổ Terminal cho người dùng tự đăng nhập Google, hay chọn "Business account" cho SSO Workspace / doanh nghiệp. Giống cách mở đăng nhập của Claude/Codex hiện có (`openLogin`).
- Kiểm đăng nhập: `agy -p /usage --output-format json` thành công là đã đăng nhập. "authentication required" là chưa.
- **Tuỳ chọn doanh nghiệp** trong form gói: *Google Cloud project* (đặt `AGY_ADC_AUTH=true` và `GOOGLE_CLOUD_QUOTA_PROJECT` vào `env` của gói) cho tổ chức dùng ADC hay tài khoản dịch vụ.

**Nhiều tài khoản:**
- Linux: gói thứ hai trở đi có `HOME` riêng (`~/.xdev-hive/antigravity/<id>`), đánh dấu [thử nghiệm].
- macOS và Windows: form báo "một tài khoản Antigravity mỗi người dùng máy", cho tới khi có biến thư mục cấu hình (#155).
- Ghi kết quả thử tách `HOME` vào ghi chú task.

**Hạn mức:**
- Đọc `agy -p /usage --output-format json`, **chỉ khi `agy --version` ≥ 1.1.11**. Bản cũ hơn thì không đọc, và *Cài đặt máy* báo cần cập nhật.
- Đổ vào `PlanUsage` hai cặp 5 giờ / tuần: pool Gemini, và pool Claude/GPT. Chọn pool hiển thị theo `--model` của gói, mặc định Gemini; pool kia hiện ở dòng phụ.
- Dạng JSON viết bộ đọc khoan dung (thiếu trường thì "chưa biết"), test bằng mẫu ghi lại từ máy thật khi có.

**Cài đặt máy (Setup):**
- Mục `cli:antigravity`: phiên bản, mới nhất từ releases trên GitHub.
- Nút cài chạy script chính thức của Google **chỉ khi người dùng bấm**, và hiện rõ lệnh sẽ chạy.

**MCP:** máy ghi khối Hive vào `.agents/mcp_config.json` của repo (khoá `serverUrl` hoặc stdio shim, theo dạng `agy` đọc), như việc ghi `.mcp.json` / `config.toml` hiện có.

**Hub:**
- `kind: "antigravity"` đi qua heartbeat. Bản đồ agent, chọn loại gói (24c) và *Gói nào cũng được* nhận loại mới.
- Chữ trong `vi.ts` trước rồi `en.ts`.

## Không làm

- Không lấy token OAuth ra.
- Không gọi API của Antigravity trực tiếp.
- Không tự cài `agy` khi người dùng chưa bấm.

## Kiểm

- **Test runner** với `agy` giả (theo cách các test runner dùng agent giả):
  - args đúng;
  - đọc stream-json;
  - mã thoát 3 / `AGY_ERROR` thành lỗi;
  - hết hạn mức thì xoay vòng;
  - bản ≤ 1.1.10 thì không gọi `/usage`;
  - đọc mẫu JSON hạn mức.
- **UI:** nút tài khoản, form gói (Cloud project, cảnh báo một tài khoản trên macOS/Windows).
- **Smoke:** ảnh *Agent và quota* có gói Antigravity mẫu.
- **Thử thật** (người dùng, sau khi gộp):
  - cài `agy`, đăng nhập Google hay SSO;
  - chạy một task nhỏ;
  - xem hạn mức;
  - gửi lại mẫu JSON `/usage` để chỉnh bộ đọc.

## Ràng buộc khi làm

- Không đổi hành vi của các loại gói khác.
- Không tăng version, không đánh dấu roadmap.
- Comment giải thích vì sao.
