# 56. Trang Quy trình: AI SDLC từ đầu tới cuối, chốt chặn và model ở một chỗ

Viết ngày 6/10. Người dùng hỏi ba điều:
- "Tối ưu model chưa thấy nhỉ, trên giao diện hiển thị ở đâu?"
- "Phần cài đặt dự án khó cấu hình."
- "Chỗ nào overview được AI SDLC theo full quy trình, cấu hình điểm chặn?"

Task: **R-56a**, **R-56b**, **R-56c**.

## Hiện trạng

Kiểm trên ảnh e2e của lô 0.137, ngày 6/10.

**Chọn model theo task (54):**
- 54a đã có từ 0.136.0: *Lượt chạy* hiện chip model và mức suy nghĩ của từng run. Nhưng mới là *ghi lại*.
- 54b nằm trong lô 0.137: loại, cỡ, rủi ro của task.
- **Bộ chọn (54c) và giao diện cấu hình chưa làm.** Vì vậy chưa có chỗ nào để xem hay chỉnh.

**Cài đặt dự án (49b):** gom các thẻ cũ thành một trang cuộn rất dài.
- **Chính sách agent:** bảng nhiều cột, cuộn ngang. Mỗi loại gói một ô chữ "model cách nhau bằng dấu phẩy". Ô trống ghi "theo hub". Cột *Hiệu lực* lặp lại giá trị. Có cả khối giải thích về cờ CLI.
- **Chốt chặn theo bước (SDLC):** bảng 7 ô chọn Người duyệt / AI kiểm / Tự động, cuộn ngang. Không thấy luồng đi thế nào. Không thấy mỗi bước đang có gì chờ.
- **Phân chia giữa admin và dự án:** trần của hub và giá trị của dự án nằm chung một bảng. Người quản trị dự án phải đọc "theo hub" để đoán hiệu lực.

**Luồng của một tính năng** chỉ hiện trong khung task (*Spec → Plan → Tasks → Nhập task → Giao cho agent*) và ở trang *Tính năng* (49d). **Không có chỗ xem cả quy trình của dự án.**

## Mẫu giao diện tham khảo

Nguồn là hiểu biết chung về các sản phẩm, chưa kiểm lại nguyên văn tài liệu.
- **Azure DevOps Release pipelines:**
  - mỗi stage là một hộp trên sơ đồ;
  - biểu tượng chốt *trước* / *sau* mỗi stage;
  - bấm vào chốt thì mở khung cấu hình người duyệt và điều kiện.
- **GitHub Environments:** mỗi môi trường có *protection rules* (người duyệt, chờ, nhánh).
- **GitLab pipeline graph:** các cột theo stage, trạng thái màu.
- **Kiro:** chọn *Requirements-First* hay *Quick Spec* (bỏ chốt) theo dự án.
- **Linear:** cài đặt workflow theo từng team, một trang, kéo thả trạng thái.

Mẫu chung của các sản phẩm trên: **sơ đồ các bước làm trung tâm, chốt là biểu tượng gắn vào bước, bấm vào thì mở khung cấu hình hẹp**, thay cho bảng nhiều cột.

## Thiết kế

### Trang *Quy trình* (mục menu mới trong nhóm *Dự án*, đặt trước *Cài đặt dự án*)

**Một sơ đồ ngang** các bước của AI SDLC trong dự án, kéo dài từ ý tưởng tới khi gộp:

```
Ý tưởng → Spec ⟐ → Plan ⟐ → Tasks ⟐ → Giao việc ⟐ → Làm (agent) → Review ⟐ → Sửa ⟐ → Merge ⟐ → Xong
```

**Mỗi bước là một thẻ**, hiện:
- tên bước và vai trò người duyệt (Quản lý dự án, Reviewer…);
- số mục **đang ở bước đó**, có liên kết sang *Tính năng* hay *Agent đang chạy* đã lọc;
- thời gian chờ trung vị 30 ngày;
- tỉ lệ qua ngay (không cần sửa) 30 ngày;
- **model và mức suy nghĩ** bước đó dùng (cấp của 54c, ví dụ "Sonnet · thấp", "Opus · vừa"). Trước khi có 54c thì hiện "mặc định của gói".

**Mỗi chốt ⟐ là một biểu tượng** giữa hai bước, gồm:
- **hình người**: Người duyệt;
- **hình robot**: AI kiểm;
- **mũi tên thẳng**: Tự động;
- **ổ khoá** khi trần của hub không cho nới.

**Bấm vào một bước hay một chốt** thì mở **khung bên** chỉ cho bước đó:
- chế độ chốt (3 nút lớn, có giải thích một dòng; mức vượt trần thì khoá, kèm lý do);
- ai được duyệt;
- số lượt sửa tối đa (với *Sửa*);
- số task chạy song song (với *Giao việc*);
- **model của bước**: cấp *Tiết kiệm / Cân bằng / Mạnh*, hay chọn cụ thể theo loại gói;
- nút *Lưu*.

**Đầu trang có các bộ cài sẵn**, áp một lần cho mọi chốt và model:
- **Thận trọng**: người duyệt ở Spec, Plan, Review, Merge; model Chất lượng;
- **Cân bằng**: AI kiểm ở Plan/Tasks/Review, người duyệt Spec và Merge; model Cân bằng; giống mặc định của 34;
- **Tự động tối đa**: tự động trừ Merge, nhưng vẫn trong trần của hub; model Tiết kiệm;
- **Lối nhanh**: bỏ Spec/Plan/Tasks cho việc nhỏ. Task loại `docs` / `small-fix` / `test` (54b) đi thẳng tới *Giao việc*.

Áp một bộ cài sẵn thì hiện **xem trước những gì đổi** rồi mới lưu.

**Mặc định cho dự án mới** (người dùng chọn 6/10): **Tự động tối đa**, nằm trong trần của hub. Merge vẫn cần người hoặc AI kiểm, tuỳ trần. Dự án đã có thì giữ cài đặt đang dùng.

**Chế độ xem theo tính năng:** chọn một tính năng thì sơ đồ tô sáng bước hiện tại của nó và các chốt đã qua. Dùng lại lớp SDLC của 51c.

**Kỹ thuật:**
- Dùng lại `@xyflow/react` (51a), xếp cố định theo hàng ngang, không cho kéo.
- Dưới 768px thành danh sách dọc các bước, chốt nằm giữa hai bước; bấm vào thì mở khung toàn màn hình.
- Rà bằng skill `ui-ux-pro-max`.

### *Cài đặt dự án* gọn lại

Trang có thanh tab trái (trên điện thoại là danh sách). Mỗi mục là **một tóm tắt bằng chữ** cộng nút *Sửa*, mở khung sửa hẹp:
- **Quy trình**: liên kết sang trang *Quy trình* ở trên. Không lặp lại bảng chốt.
- **Agent:**
  - Tóm tắt dạng câu, ví dụ: "Agent được sửa file và chạy lệnh trong worktree · mạng mở · mọi MCP · model: theo Quy trình".
  - Khung sửa có:
    - mức tự chủ (3 thẻ chọn kèm giải thích);
    - mạng (bật/tắt);
    - MCP (chọn từ danh mục tool, không gõ tên);
    - **model được phép cho mỗi loại gói** dạng **chip chọn từ danh sách đã biết** của bảng cấp 54c, có nút *Thêm model khác*, không còn ô chữ phân cách bằng phẩy.
  - Khối giải thích về cờ CLI chuyển thành dòng "Tìm hiểu thêm" gập lại.
- **Tool**, **Context agent**, **Leader** (lệnh, mức tự chạy, model chat), **Thành viên**, **Hệ thống**: giữ nội dung các thẻ cũ, mỗi cái một tab.
- **Hiệu lực:**
  - Mọi giá trị "theo hub" hiện thẳng giá trị đang có hiệu lực (ví dụ "Toàn quyền (theo hub)").
  - Ô nào bị trần của hub chặn thì có ổ khoá, rê chuột thấy lý do.
- **Trần của hub** (admin hub) chuyển về *Quản trị › Chính sách*, bố cục giống hệt trang của dự án. Trang của dự án không còn hàng "Mặc định của hub".

### Chọn model (54c) đặt ở đâu

- **Trang Quy trình:** model của từng bước (implement, review, spec, sửa…).
- **Tab con *Model theo loại task*** trong trang Quy trình, gồm:
  - bảng loại × cỡ → cấp của 54;
  - bảng học của 54d: số task, tỉ lệ xong, chi phí mỗi task xong, đề xuất, khoá ô.
- ***Agent đang chạy* và khung task:** chip "Sonnet · thấp · cấp light (docs/s)" kèm lý do khi rê chuột.

## Chia việc

| Mục | Nội dung | Phụ thuộc |
|---|---|---|
| **56a. pipeline-page** | Trang *Quy trình*: sơ đồ bước + chốt, số liệu từng bước (đang có, chờ trung vị, tỉ lệ qua), khung bên sửa chốt (dùng `sdlc.setProject` có sẵn), bộ cài sẵn kèm xem trước, lối nhanh theo loại task, xem theo tính năng, mobile | lô 0.137 (49d, 54b) |
| **56b. settings-tidy** | *Cài đặt dự án* thành tab với tóm tắt + khung sửa; chính sách agent bằng chip và thẻ chọn; hiệu lực hiện thẳng; trần hub chuyển về *Quản trị › Chính sách* | 56a |
| **56c. models-in-pipeline** | Model của từng bước, tab *Model theo loại task*, chip model ở run và task. Đây là phần giao diện của 54c và 54d; 54c làm phần hub và runner | 54c |

**Chuyển hướng:** `#/settings?tab=sdlc` cũ trỏ sang *Quy trình*.

## Test

- **UI:**
  - sơ đồ dựng đúng bước và chốt theo chính sách;
  - khoá theo trần;
  - bộ cài sẵn đổi đúng các ô;
  - xem trước hiện đủ thay đổi;
  - lối nhanh chỉ áp cho loại task đã chọn.
- **E2e** (desktop và mobile): bước `pipeline`.
  - Mở *Quy trình*.
  - Thấy đủ bước và số đang chờ ở Spec.
  - Đổi chốt Review sang *AI kiểm* trong khung bên.
  - Áp bộ cài sẵn *Thận trọng*, xem trước rồi lưu.
  - Ảnh chụp mỗi bước.
- **Smoke:** không đổi app desktop.

## Ràng buộc khi làm

- Không đổi luật chốt của 34 hay luật quyền.
- Mọi thay đổi vẫn qua method có sẵn và nhật ký.
- Không tăng version, không đánh dấu roadmap.
