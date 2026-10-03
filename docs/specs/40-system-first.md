# 40. system-first: hệ thống là cấp chính, dự án là service bên trong

Viết ngày 3/10. Người dùng hỏi: "nên hệ thống → dự án chứ nhỉ? hiện tại dự án nhìn vô nhiều thứ quá; hệ thống có thể nhiều service dạng microservices". Người dùng chọn hướng gọn dưới đây.

## Hiện trạng

- Hub đã có hệ thống (roadmap 19b): tên + danh sách project key, tài liệu `system/<tên>/…`, memory của hệ thống, quyền suy ra từ dự án con.
- Giao diện vẫn xếp phẳng. Ô phạm vi, Tổng quan, Hôm nay, Task, Tài liệu… lấy dự án làm đơn vị chính, hệ thống chỉ là một lựa chọn phụ.
- 36a (đã merge) làm ô chọn tìm được và nhóm theo hệ thống. 36c (review) liệt kê dự án chưa thuộc hệ thống nào. 36b (todo) cho các trang theo phạm vi.
- Hệ quả: danh sách dài, và tài liệu nằm nhầm cấp. Ví dụ dự án `ehospital` không có repo giữ 141 trang SRS mà 8 repo của hệ thống `ehospital-ai` không đọc được.

## Mô hình

- **Hệ thống** là cấp người dùng thấy đầu tiên. Đây là một sản phẩm, gồm một hay nhiều service.
- **Service** là một repo, tức một project key. Gọi là "service" trên giao diện, giữ `project` trong RPC, DB, MCP và URL để không phá máy và agent đang chạy.
- **Repo lẻ** (không thuộc hệ thống nào) hiện như một hệ thống một service, cùng tên. Hệ thống này **ảo**: không ghi vào bảng `systems`. Bấm *Tạo hệ thống* thì thành thật.
- **Task, run, máy, quyền** giữ ở cấp service như hiện nay, vì agent luôn làm trong một repo. Trang liệt kê thì gộp được theo hệ thống.
- **Tài liệu và memory** mặc định ghi ở cấp hệ thống. Chỉ ghi ở cấp service khi chỉ repo đó cần, ví dụ AGENTS.md riêng.

## Tách

### R-40a. scope-system-first

Phụ thuộc R-36c.

- Ô phạm vi (ProjectPicker của 36a) ở chế độ scope:
  - danh sách gốc là hệ thống, kể cả hệ thống ảo của repo lẻ;
  - service chỉ hiện khi mở rộng một hệ thống, hoặc khi tìm khớp;
  - *Tất cả* và *Chung* giữ ở đầu.
- Chọn hệ thống là phạm vi `system`. Chọn hệ thống ảo là phạm vi `project` của repo đó: không cần kiểu phạm vi mới.
- Menu và tiêu đề trang ghi tên hệ thống. Khi phạm vi là một service, ghi `hệ thống › service`.
- Không đổi RPC.
- Test:
  - unit cho hàm dựng cây hệ thống (thật + ảo), cho cách tìm, cho cách chọn;
  - e2e: seed một hệ thống 2 service và một repo lẻ; ô phạm vi hiện 2 mục gốc; chọn hệ thống thì Task chỉ còn task của 2 service.

### R-40b. service-naming

Phụ thuộc R-40a.

- Chữ giao diện vi/en: chỗ nào "dự án" nghĩa là một repo thì đổi thành "service". Ví dụ: *Dự án & công cụ* → *Service & công cụ*, cột *Dự án* trong bảng task/run → *Service*, ô chọn dự án của form → *Service*.
- "Hệ thống" giữ nguyên.
- Không đổi key i18n nếu không cần; đổi chữ thì đổi cả vi và en.
- README: một đoạn giải thích hệ thống / service; thay chữ ở các mục mô tả giao diện.
- Không đổi tên trong RPC, DB, MCP, URL.

### R-40c. docs-system-default

Không phụ thuộc.

- Trang *Tài liệu*:
  - phạm vi là hệ thống hoặc một service thuộc hệ thống: cây hiện tài liệu hệ thống trước, rồi một nhóm cho mỗi service;
  - *Trang mới* mặc định đặt ở `system/<tên>/…`, có ô đổi sang service.
- MCP `doc_write` / `doc_propose` của agent không đổi. Skill / AGENTS.md của hệ thống ghi rõ: tài liệu chung viết ở `system/<tên>/…`.
- Memory: form *Ghi memory* trên web mặc định cấp hệ thống khi service thuộc hệ thống.
- Test:
  - unit cho chọn chỗ mặc định;
  - e2e: phạm vi là hệ thống, tạo trang mới thì nó vào `system/<tên>/`.

### R-40d. overview-by-system

Phụ thuộc R-40a.

- *Tổng quan* và *Hôm nay* ở phạm vi *Tất cả*: mỗi hệ thống một thẻ, gồm số task mở, run đang chạy, việc chờ duyệt, và các service bên trong.
- Bảng *Task* / *Lượt chạy* ở phạm vi hệ thống có cột *Service*, lọc theo service.
- Test: e2e hai hệ thống, mỗi thẻ đúng số liệu.

## Chưa làm trong mục 40

- Đổi `project` thành `service` trong RPC, DB, MCP: phải chuyển dữ liệu, các máy cũ cũng phải đổi theo.
- Gộp hay tách hệ thống bằng kéo thả.
- Dọn các key cũ (`ehospital`, `ehospital-ai`, `csdlqg`, `xdev-auth`, `his-service-old`): việc này ở R-38g và phần dọn sau đó (hub memory #380, #382).
