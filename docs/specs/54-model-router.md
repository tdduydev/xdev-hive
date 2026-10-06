# 54. Chọn model và mức suy nghĩ theo task

Viết ngày 6/10. Người dùng: "thêm một phần thông minh hơn, tuỳ theo tác vụ thì chọn model nào tối ưu task, token nhất… trong codex sẽ có nhiều mode, trong claude cũng vậy".

Người dùng chọn:
- **cân bằng** làm mục tiêu mặc định;
- **luật cộng một bước AI phân loại** task chưa rõ loại;
- **tự học có giới hạn** từ kết quả run.

Task: **R-54a**, **R-54b**, **R-54c**, **R-54d**.

## Hiện trạng (main 1e43a60, 0.134.0)

**Run không bao giờ chọn model hay mức suy nghĩ theo task.**
- Model chỉ có khi nằm trong `args` của gói, hoặc là model đầu tiên trong danh sách cho phép của chính sách agent (`applyPolicy`, `command.ts`).
- `--effort` chỉ có ở chat với leader (`chat_defaults.model/effort`, `chatArgs`).
- Gói được chọn theo chỗ trống, quota còn lại và độ ưu tiên (`pickWithReason`, `schedule.ts`), không theo việc cần làm.

**Dữ liệu thiếu cho việc học:**
- `run_records` không có model, mức suy nghĩ, loại gói, lần thử hay run cha.
- `run_costs` không có vai trò hay kết quả.
- Kết luận review không được lưu; mỗi lần cần thì đọc lại từ tóm tắt.
- Task không có ô loại hay cỡ. "Xong khi" chỉ là chữ trong ghi chú.

**Số đo trên hub ngày 6/10** (200 run gần nhất, máy tự báo):

| Run | Token vào (trung vị) | Đọc từ cache | Token ra (trung vị) |
|---|---|---|---|
| Làm task, Claude | 6,5 triệu | 98% | 41 nghìn |
| Làm task, Codex | 9,4 triệu | 98% | 21 nghìn |
| Review | 0,7–0,8 triệu | — | 3–6 nghìn |

- Chi phí quy đổi run Claude làm task: trung vị 3,8 US$, p90 18,7 US$.
- Task roadmap (R-) trung vị khoảng 10 US$; task nhỏ (skill, spec, phát hành) dưới 1 US$.
- 13/42 run Codex làm task dừng vì hết hạn mức.

## Nghiên cứu

Đọc ngày 6/10/2026. Phần CLI kiểm tại máy: Claude Code 2.1.291 và codex-cli 0.160.1.

### Claude Code

- **Model:** `--model` nhận alias hay id đầy đủ.
  - Alias: `default`, `best`, `fable`, `opus`, `sonnet`, `haiku`, `opusplan` (Opus khi lập kế hoạch, Sonnet khi làm), và bản `[1m]` ([model-config](https://code.claude.com/docs/en/model-config)).
- **Mức suy nghĩ:**
  - `--effort low|medium|high|xhigh|max`;
  - mặc định `medium` với Opus 5.5 và Sonnet 5.5;
  - biến `CLAUDE_CODE_EFFORT_LEVEL` thắng cờ.
- **Không bao giờ dùng tự động:**
  - **fast mode** luôn tính vào credit trả thêm, không vào hạn mức gói ([fast-mode](https://code.claude.com/docs/en/fast-mode));
  - `max`.
- **Hạn mức theo model:**
  - Opus tốn hạn mức gấp nhiều lần Sonnet mỗi lượt, Sonnet hơn Haiku. Không có hệ số công bố. Tài liệu nói Sonnet hợp với "đa số việc code" ([costs](https://code.claude.com/docs/en/costs), [hỗ trợ](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code)).
  - Hạn mức 5 giờ / tuần chung cho mọi model, nhưng có thêm hạn mức riêng theo họ model.
  - Fable trên Max dùng tới 50% hạn mức tuần, trên Pro thì tính vào credit.
- **Subagent:**
  - frontmatter `model:` / `effort:`, `CLAUDE_CODE_SUBAGENT_MODEL`;
  - subagent Explore chạy Opus trên gói thuê bao, nên đặt Sonnet hay Haiku sẽ tiết kiệm.

### Codex CLI

- **Model:** `-m <slug>`.
- **Mức suy nghĩ:** `-c model_reasoning_effort=low|medium|high|xhigh|…`; mức nào dùng được tuỳ model. Thêm `model_verbosity`, `-p/--profile` ([config](https://learn.chatgpt.com/docs/config-file/config-reference)).
- **Model** trong cache của máy ngày 6/10:
  - `gpt-6.1-sol` (chủ lực);
  - `gpt-6-astra` (mạnh nhất);
  - `gpt-6-luna` (nhanh, rẻ, cho việc dễ).
- **Hạn mức trên Plus**, tin nhắn mỗi 5 giờ ([pricing](https://learn.chatgpt.com/docs/pricing)):
  - Astra 5–45;
  - Sol 15–160;
  - Luna 350–3.000.
  - Credit của Luna khoảng 1/20 của Sol.
- Codex không có chọn model tự động.
- "Mode" trong Codex là chế độ sandbox / duyệt quyền, không phải model.

### Antigravity

- `agy --model <slug>`; mức suy nghĩ nằm luôn trong slug, ví dụ `gemini-3.8-flash-high`. Có thêm `--effort low|medium|high` ([headless](https://antigravity.google/docs/cli/headless/)).
- Hạn mức tách hai nhóm: Gemini, và Claude/GPT (xem 53).

### Cách các sản phẩm khác chọn model

- **Cursor Router:** bộ phân loại theo câu hỏi, ngữ cảnh, độ phức tạp, lĩnh vực ([guide](https://cursor.com/guides/model-routing)).
  - Tự nhận "khoảng 60% chi phí thấp hơn".
  - Chi phí mỗi commit 4,63 US$ khi tự chọn, so với 7,34 US$ khi dùng toàn Opus.
- **Copilot auto:** theo nhu cầu suy luận, độ phức tạp, độ khó của lỗi, và model nào đang rảnh ([changelog](https://github.blog/changelog/2026-05-20-auto-model-selection-now-routes-based-on-your-task-in-vs-code/)).
- **RouteLLM:** chi phí giảm 35–85% mà giữ khoảng 95% chất lượng trên các bộ đo ([LMSYS](https://lmsys.org/blog/2024-07-01-routellm/)).
- **Aider architect/editor:** model mạnh lập kế hoạch, model rẻ sửa file. Điểm tăng so với một model làm cả hai ([aider](https://aider.chat/2024/09/26/architect.html)).
- **Chú ý:** model mạnh ở mức suy nghĩ thấp có thể tốn **ít** token ra hơn model rẻ ở mức cao. Anthropic báo Opus 4.5 ở mức medium bằng điểm SWE-bench của Sonnet 4.5 với ít hơn 76% token ra. Nên tính **chi phí mỗi task xong**, gồm cả lần chạy lại, không tính chi phí mỗi run.

## Mô hình

### Loại và cỡ của task

**Loại** (`task_kind`):

| Loại | Ví dụ |
|---|---|
| `docs` | tài liệu, chuỗi giao diện, changelog |
| `test` | viết hay sửa test |
| `small-fix` | sửa nhỏ, rõ chỗ |
| `feature` | tính năng thường |
| `ui` | giao diện |
| `refactor` | đổi cấu trúc nhiều file |
| `debug` | lỗi chưa rõ nguyên nhân |
| `spec` | spec, plan, tasks (bước Spec Kit) |
| `review` | review, chốt AI kiểm |
| `merge` | gộp, giải xung đột |
| `ops` | phát hành, cài đặt |

**Cỡ** (`task_size`): `s`, `m` hoặc `l`.

**Rủi ro** (`task_risk`): `normal` hoặc `high`. `high` khi đụng migration, bảo mật, quyền, hay nhiều package lõi.

**Cột mới của `tasks`** (migration mới): `kind`, `size`, `risk`, `classified_by` (`rule` / `ai` / `<người>`), `classified_at`.
- Người và leader sửa được. Leader dùng đề xuất `task.classify` hay khi tạo task.
- Ô *Loại* và *Cỡ* hiện trong khung task.

**Phân loại tự động** (hub):
1. **Luật** trước:
   - vai trò `review` → `review`;
   - bước Spec Kit → `spec`;
   - tiêu đề hay ghi chú có từ khoá (tài liệu, docs, i18n, test, merge, gộp, release, phát hành…) → loại tương ứng;
   - không đoán được thì để trống.
2. **AI phân loại** (người dùng chọn) cho task còn trống loại khi sắp giao:
   - một run rất nhỏ, vai trò `classify`, model rẻ nhất có sẵn (Haiku, hay `gpt-6-luna` mức low), chỉ đọc tiêu đề, ghi chú và danh sách file nhắc tới;
   - trả JSON `{kind, size, risk, reason}`;
   - trần 20k token vào, không công cụ;
   - lỗi hay quá trần thì dùng mặc định `feature` / `m` / `normal`.
3. Bật tắt theo dự án ở *Cài đặt dự án*; mặc định bật.

### Bảng chọn (mặc định "Cân bằng")

**Cấp** là bộ ba **loại gói → model + mức suy nghĩ**:

| Cấp | Claude | Codex | Antigravity |
|---|---|---|---|
| `light` | `sonnet` low | `gpt-6-luna` medium | Gemini flash |
| `standard` | `sonnet` medium | `gpt-6.1-sol` low | Gemini pro |
| `strong` | `opus` medium | `gpt-6.1-sol` high | Claude/GPT pool |
| `max` | `opus` high (Fable chỉ khi admin bật) | `gpt-6-astra` medium | — |

- Tên model đặt trong **bảng cấp** của hub (admin sửa được), không viết cứng trong code. Model mới ra thì chỉ sửa bảng.

**Loại × cỡ → cấp bắt đầu** (bảng của dự án; mặc định của hub):

| Loại | s | m | l |
|---|---|---|---|
| `docs`, `test`, `ops` | light | light | standard |
| `small-fix`, `ui` | light | standard | standard |
| `feature` | standard | standard | strong |
| `refactor`, `merge` | standard | strong | strong |
| `debug`, `spec` | strong | strong | strong |
| `review` | standard | standard | strong |

- `risk: high` nâng một cấp.

**Ba hồ sơ** người chọn theo dự án:
- *Tiết kiệm*: hạ một cấp, tối thiểu `light`;
- *Cân bằng*: mặc định;
- *Chất lượng*: nâng một cấp, trừ `docs` / `test`.

**Lập kế hoạch rồi làm** (cho `feature` / `refactor` cỡ l, Claude): dùng `opusplan` thay cho `strong`.

### Nâng cấp khi lỗi

Các trường hợp tính là lỗi:
- run lỗi (không phải hết hạn mức);
- review "cần sửa";
- CI đỏ sau run;
- lượt sửa của chốt `fix`.

Cách nâng:
- Lần sau tăng **mức suy nghĩ** trước, rồi mới lên **một cấp**. Tối đa 2 lần nâng mỗi task.
- Chỉ dẫn của lần sau có tóm tắt lần trước (đã có ở lượt sửa 34c).
- Hết hạn mức thì xoay vòng như 24a/24c, giữ cấp.
- Nếu loại gói khác không có cấp đó thì lấy cấp gần nhất.

### Tự học có giới hạn

**Mỗi run ghi** (cột mới của `run_records`, gửi từ máy trong `runs.push`):
- `kind` (loại gói), `model`, `effort`, `tier`;
- `attempt`, `parent_run`;
- `task_kind`, `task_size`;
- `verdict` (kết luận review lưu thật, `approve` / `changes` / …).

**Thống kê 30 ngày** theo (loại task × cỡ × cấp × loại gói):
- số task xong;
- tỉ lệ xong không cần nâng;
- token và chi phí trung vị **mỗi task xong** (gồm mọi lần thử).

**Hằng đêm hub tính đề xuất:**
- Với mỗi ô, chọn cấp rẻ nhất có tỉ lệ xong ≥ 80% trên ít nhất 10 task.
- Khoảng 10% task của ô đó thử cấp **thấp hơn một bậc** để tiếp tục học. Không thử với `risk: high`.

**Admin hub và quản trị dự án xem bảng học** ở *Cài đặt dự án* → *Chọn model*, với các nút:
- *Áp dụng đề xuất*;
- *Khoá ô* (giữ tay);
- *Tắt tự học*.

Mặc định:
- đề xuất được **tự áp dụng** cho ô chưa khoá;
- mỗi lần đổi ghi nhật ký.

**Áp lực hạn mức:**
- Gói đã dùng trên 70% cửa sổ 5 giờ thì task `light` / `standard` ưu tiên loại gói khác còn nhiều (cùng cấp).
- `strong` / `max` không đổi loại chỉ vì hạn mức, trừ khi hết hẳn.

### Runner

- `runs.dispatch` và mọi đường giao (đợt chạy, luồng SDLC, task đã gán 50, chat `run.dispatch`) mang theo **lựa chọn của hub**: `{tier, models: {claude?: {model, effort}, codex?: …, antigravity?: …}, reason}`.
- Máy chọn gói như hôm nay, rồi thêm cờ theo loại gói:
  - Claude: `--model`, `--effort`;
  - Codex: `-m`, `-c model_reasoning_effort=`;
  - agy: `--model`, `--effort`.
- **Không đè lên `args` của gói** khi gói đã ghi model: người dùng đã cố định thì tôn trọng, và log ghi lý do.
- **Chính sách agent (27a) vẫn thắng:** model không được phép thì lấy model được phép gần nhất cùng cấp, hay model đầu danh sách.
- **Log run** có dòng `# model: sonnet · effort low · cấp light (docs/s, luật) · lý do`. *Lượt chạy* hiện chip cấp và model.
- **Subagent Claude:** đặt `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` cho run cấp `light` / `standard`, vì Explore mặc định chạy Opus.

## Chia việc

| Mục | Nội dung | Phụ thuộc |
|---|---|---|
| **54a. run-data** | Ghi model, mức suy nghĩ, loại gói, lần thử, run cha, kết luận review vào `run_records` (máy gửi, hub lưu, migration); *Lượt chạy* hiện model và mức | — |
| **54b. task-kind** | Cột loại, cỡ, rủi ro của task; luật phân loại; run `classify` bằng model rẻ; ô trong khung task; đề xuất leader `task.classify` | — |
| **54c. router** | Bảng cấp và bảng loại × cỡ của hub và dự án, ba hồ sơ, `opusplan`; hub gửi lựa chọn trong mọi đường giao; runner thêm cờ model và mức suy nghĩ, tôn trọng `args` và chính sách; nâng cấp khi lỗi; áp lực hạn mức; giao diện *Chọn model* ở *Cài đặt dự án* | 54a, 54b |
| **54d. learning** | Thống kê theo ô, đề xuất hằng đêm, thử cấp thấp hơn 10%, khoá ô, tắt tự học, nhật ký; bảng so trong *Chi phí* | 54c |

## Ngoài phạm vi

- Fast mode, mức `max` / `ultra`, Fable tự động. Chỉ admin bật tay trong bảng cấp.
- Chọn model cho chat leader: giữ cài đặt 17h / 29 hiện có.
- Học bằng mô hình máy học. Chỉ dùng thống kê đơn giản như trên.

## Ràng buộc khi làm

- Không đổi hành vi khi dự án tắt *Chọn model*: đúng như hôm nay.
- Không tăng version, không đánh dấu roadmap.
- Comment giải thích vì sao.
