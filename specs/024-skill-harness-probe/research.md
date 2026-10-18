# Research: Thử harness trong sandbox trước khi đề xuất skill

Ngày 2026-10-18. Nguồn đã đọc:
- bài MarkTechPost 2026-10-18 giới thiệu Harness²;
- README của repo [google-research/harness2](https://github.com/google-research/harness2) (Apache-2.0);
- bài báo [arXiv 2610.14224v1](https://arxiv.org/html/2610.14224v1): phần 1–6, phụ lục A, D, E.1, E.2, E.4–E.6, F, G.

**Chưa đọc**:
- phụ lục H, nơi có lời nhắc của từng bước;
- mã nguồn trong thư mục `harness2/` của repo.

Mọi chỗ dưới đây nói "bài báo" là theo bản HTML v1 ở trên.

## 1. Harness² làm gì

**Harness** là mọi thứ quanh model giúp nó làm việc như agent: lời nhắc, công cụ, memory, skill, cách điều phối. Harness²
sửa harness lúc đang chạy việc thật, không sửa trọng số model và **không cần đáp án đúng**. Có hai tầng đệ quy:

1. **Tầng việc (task-level)**: một bước **Propose → Probe → Compose** cho việc hiện tại.
   - **Chạy tham chiếu**: chạy việc với harness hiện tại. Lần chạy này cho thấy harness *hành xử* thế nào, không cho biết
     kết quả đúng hay sai.
   - **Propose**: một editor đề xuất **hai** harness ứng viên, mỗi ứng viên nhắm một phạm vi:
     - *invariant*: lỗi tác tử có thể lặp ở mọi lĩnh vực: lập kế hoạch, dùng công cụ, quản lý ngữ cảnh, giao việc;
     - *domain*: kiến thức, quy trình, ràng buộc của lĩnh vực hay môi trường hiện tại.

     Editor được dùng lại thành phần trong thư viện, nhưng sự kiện riêng của việc phải đối chiếu với bằng chứng của việc
     hiện tại.
   - **Probe**: chạy **cùng việc** với từng ứng viên, giữ nguyên model và môi trường. So quỹ đạo và sản phẩm với lần
     tham chiếu cho ra một **tương phản hành vi**: sửa có chữa được thiếu sót nhắm tới không, không đổi gì, hay làm hỏng
     chỗ khác. Bài báo nói rõ tương phản này dùng để quyết định ghép, **không** để kiểm đúng sai, vì kết quả mỗi lần
     chạy dao động và các model có chung thiên lệch.
   - **Compose**: đọc lần tham chiếu, các ứng viên, diff của chúng so với harness hiện tại và mọi bằng chứng, rồi ghép
     thành harness kế tiếp. Có thể:
     - ghép các sửa có bằng chứng;
     - sửa lại các sửa mâu thuẫn nhau;
     - nhận nguyên một ứng viên;
     - giữ nguyên harness cũ.

     **Mỗi quyết định gắn với một quan sát cụ thể**, không dựa trên điểm dự đoán. Harness ghép xong được chạy thêm một lần
     để có sản phẩm cuối.
2. **Tầng cải tiến (harnessing-level)**: cập nhật một **thư viện cải tiến** sau mỗi việc.
   - Mỗi mục gồm cây harness đã nhận và một `EXPERIENCE.md`: tình huống áp dụng, bài học, bằng chứng.
   - Thư viện có một chỉ mục để phiên sau mở mục liên quan khi cần.
   - Chỉ giữ bài học có tương phản chạy thật đỡ lưng. Thiếu bằng chứng thì không thêm mục.
   - **Việc sau vẫn bắt đầu từ harness gốc**, không thừa kế harness của việc trước. Thư viện chỉ dẫn đường cho Propose
     và Compose.

**Ngân sách k**:
- `k = 1`: một bước Propose–Probe–Compose.
- Song song: k ứng viên mỗi phạm vi và k lần ghép, rồi một bộ chọn so các sản phẩm đã ẩn danh.
- Tuần tự: k bước nối nhau.

### Tám thành phần harness (bảng 5 của bài báo)

Mỗi thành phần là một file, nên mỗi sửa là một diff.

| Thành phần | File | Khi nào vào ngữ cảnh |
|---|---|---|
| System prompt | `systemprompt.md` | Mọi lượt |
| Guardrails | `guardrails.md` | Mọi lượt |
| Memory | `LongTermMEMORY.md` | Mọi lượt |
| Tool guidance | `tool_guidance.md`, `tool_descriptions/` | Mọi lượt |
| Skills | `skills/<n>/SKILL.md`, `skills/<n>/scripts/*` | Khi gọi tool skill |
| Scripts | `scripts/<name>.py` | Chạy qua shell |
| Subagents | `sub_agents/<n>/AGENT.md` | Qua tool task |
| Plugin | `plugin/<name>.ts` | Trong vòng gọi tool, ép hành vi thay vì dặn |

Với Codex, phần luôn bật nằm trong `AGENTS.md`.

### Cách vận hành đáng học (phụ lục D.2)

- **Bằng chứng là file** trong thư mục làm việc của phiên editor, không nhét vào lời nhắc.
- **Có lớp chặn**: không giao cho editor thư mục có kết quả chấm, rubric hay điểm.
- **Có bộ kiểm cây harness**. Ví dụ cây hỏng:
  - skill không có câu kích hoạt;
  - script không biên dịch;
  - helper mà skill gọi nhưng không kèm theo.

  Cây hỏng được làm lại **một lần** kèm thông báo lỗi. Hỏng lần nữa thì giữ cây cũ và ghi lại.
- **Mục thư viện giữ nguyên file chạy được**, không tóm tắt thành văn xuôi.

## 2. Số liệu đáng chú ý

Theo bảng 1–3, 6, 7 và hình 5–8 của bài báo:

**Độ lợi:**
- Một bước (`k = 1`) tăng điểm ở cả 3 benchmark và 4 cấu hình. Ví dụ GLM-5 dưới OpenCode trên WorkBuddy-Bench từ 64,2
  lên 75,7.
- Song song `k = 5` thêm 2,9–3,9 điểm trên WorkBuddy-Bench và 3,0–4,2 điểm trên JobBench.

**Ablation, bảng 3:**

| Bỏ phần | WorkBuddy-Bench | JobBench |
|---|---|---|
| Thư viện | −3,1 | −1,8 |
| Chia hai phạm vi (thay bằng hai editor chung) | −2,9 | −3,7 |
| Bước ghép (lấy ứng viên tốt hơn) | −1,6 | −1,9 |

**Tách thư viện khỏi probe (hình 7):**
- Sửa thẳng harness, không có lần tham chiếu, probe hay thư viện, làm **giảm** điểm. Ví dụ Code từ 73,4 xuống 63,2.
- Thư viện tích luỹ ở `k = 1` đưa điểm về mức gốc.
- Thư viện tích luỹ ở `k = 5` tăng điểm **dù không probe thêm**.
- Thư viện từ JobBench vẫn giúp WorkBuddy-Bench.

**Thành phần (bảng 6, E.2):**
- Bỏ skills từ harness đã cải tiến mất nhiều nhất: −5,3 điểm trung bình. Bỏ scripts mất 3,7, bỏ nhóm lời nhắc mất 1,5.
- Skills và scripts chiếm khoảng nửa số sửa.

**Công cụ (bảng 7):** tỉ lệ gọi tool lỗi giảm 20–37%. Số lần gọi tool không nhất thiết giảm.

**Cùng model làm editor và executor (hình 8):** cả 5 model đều tăng. Không bắt buộc editor mạnh hơn.

**Hỏng (E.6), 9 ca kém hơn tham chiếu:**
- bộ chọn chọn nhầm sản phẩm yếu hơn;
- một giả định sai lan sang mọi ứng viên;
- kết quả dao động.

Bài báo đề xuất chạy lặp để tách hiệu ứng của sửa khỏi dao động.

## 3. Giới hạn bài báo tự nêu (phụ lục F, G)

- **Tốn thêm**: mỗi việc thêm các lần chạy và phiên editor. `k` lớn thì tốn hơn.
- **Tín hiệu không phải đáp án**: tương phản hành vi nhạy với dao động. Sửa được nhận không chắc dùng được ở việc khác.
- **Thư viện lớn dần**: cần gộp, sửa bài học cũ, tìm theo việc. Đây là hướng tương lai, bài báo chưa làm.
- **Chưa tự chọn ngân sách**: k đặt trước, chưa dừng sớm khi probe không cho thêm bằng chứng.

## 4. Khác biệt giữa Harness² và Hive

| Điểm | Harness² | Hive (spec 014) |
|---|---|---|
| Mục tiêu | Sản phẩm của việc **đang làm** tốt hơn | Việc **đã xong**. Muốn việc **sau** đỡ thử lại và tốn ít hơn |
| Đầu ra | Harness kế tiếp, dùng ngay | Đề xuất skill (và memory) chờ người duyệt rồi mới vào kho |
| Đáp án | Không có | Có **tín hiệu một phần**: lệnh kiểm (`checks`) của dự án, kết quả thử lại, người đánh dấu |
| Executor | OpenCode, Codex; Gemini 3.5 Flash, GLM-5 | Claude Code, Codex, Antigravity trên máy của đội |
| Editor | Claude Opus 4.8, effort cao | Spec 014: Sonnet effort medium, chỉ đọc |
| Môi trường chạy | Repo nói mạng của executor **không bị chặn**, Codex tắt sandbox; tự cấu hình chặn mạng trước khi chấm | Probe chạy trong sandbox gVisor, mạng qua proxy (ADR 0007) |
| Ràng buộc chính | Điểm benchmark | **Token**: chạy ít, model rẻ, không lặp cái đội đã có hay đã từ chối (ADR 0025) |

**Hệ quả cho Hive:**
- Vì việc đã xong, sản phẩm của probe chỉ là **bằng chứng**: không đẩy nhánh, không mở PR. Hive không cần bộ chọn sản
  phẩm của `k > 1`.
- Hive có lệnh kiểm của dự án, nên tương phản có thêm một tín hiệu khách quan mà Harness² không có. Tín hiệu này vẫn
  không phải đáp án: lệnh kiểm có thể thiếu.
- Mỗi việc học được tốn ít nhất hai lần chạy code (hai ứng viên), cộng lần tham chiếu nếu chạy lại. Chỉ làm được với
  rất ít việc mỗi ngày.

## 5. Dùng lại mã của Harness² hay viết lại

**Mã của Harness²:**
- Python 3.12 với `uv`, model qua Vertex AI;
- executor là OpenCode hoặc Codex, chạy trên Linux;
- benchmark cần Docker.

**Hive:**
- hub TypeScript;
- worker Go chạy CLI agent (Claude Code, Codex, Antigravity);
- tác vụ dài đi qua run và máy của đội.

[Inference] Nhúng mã Python của Harness² vào hub hoặc worker sẽ thêm một runtime và một đường chạy agent thứ hai bên
cạnh `runs`. Spec chọn **lấy phương pháp, viết lại trên `runs`**. Nếu sau này chép lời nhắc từ repo (phụ lục H hoặc thư
mục `harness2/`), cần giữ ghi chú bản quyền Apache-2.0 (tệp `NOTICE`) ở chỗ chép.
