# Tài liệu, memory và skill

Ba loại kiến thức mà cả người và agent cùng đọc. Bản tiếng Anh: [../en/knowledge.md](../en/knowledge.md).

| Loại | Dùng cho | Agent đọc bằng |
|---|---|---|
| **Tài liệu** | Quy chuẩn, kiến trúc, API contract, `AGENTS.md`, nhật ký quyết định. Có phiên bản. | `doc_list`, `doc_get`; và các file Hive ghi vào repo |
| **Memory** | Điều agent hay người học được khi làm: quyết định nhỏ, gotcha, quy ước. | `memory_search` |
| **Skill** | Cách làm một loại việc lặp lại (một `SKILL.md`). | Claude Code nạp từ `.claude/skills/`; agent khác dùng `skill_get` |

Mỗi loại có ba tầng: **Chung (cả team)**, **Hệ thống** và **Service**. Chọn tầng bằng ô phạm vi ở thanh bên.

## Tài liệu

### Viết và sửa một trang

1. Mở **Tài liệu** (⌘5). Cây trang chia theo không gian: *Chung (cả team)*, *Hệ thống <tên>*, *Service <tên>*.
2. Bấm *+ Trang* (hoặc *Thêm trang con* trong một trang). Ô *Đặt ở* chọn không gian; với hệ thống, trang mới mặc định ở cấp hệ thống.
3. Chế độ *Sửa*: trình soạn có menu `/`, bảng, liên kết tới trang khác, ảnh. *Markdown* để sửa thẳng Markdown. Khối ` ```mermaid ` vẽ thành sơ đồ.
4. Ghi *Ghi chú thay đổi*, bấm *Lưu vX* (⌘S). Nháp chưa lưu được giữ trên thiết bị (*Nháp lưu trên máy này*).

Không có quyền sửa thẳng? Nút thành *Gửi đề xuất*: viết *Lý do đề xuất*, gửi. Người duyệt thấy ở tab *Chờ duyệt*.

### Thuộc tính trang

- *Nằm trong*: trang cha.
- *Áp dụng cho*: đường dẫn trong repo (ví dụ `apps/web/**`). Trang có đường dẫn không vào `AGENTS.md` chính mà thành `AGENTS.md` lồng hoặc rule theo đường dẫn.
- *Trong AGENTS.md*: đưa trang vào `AGENTS.md` của service (hay của mọi service trong hệ thống).
- *Không gian*: *Chuyển sang <không gian>* để dời trang; lịch sử và trang con đi theo, liên kết cũ không gãy.

### Lịch sử, xoá, khôi phục

- *Lịch sử*: mọi phiên bản; chọn hai bản để so sánh.
- *Xoá trang*, rồi *Xoá thật*: xoá mềm. Mục *Đã xoá* cuối cây có *Khôi phục*.
- *Tệp*: tải ảnh hoặc tệp lên trang, *Chèn*, *Tải về*.
- *Mở trang đọc*: trang đọc có mục lục, *Liên kết tới*, *Được liên kết từ*, *Memory nhắc tới*.

### Trợ lý viết

Bấm *Trợ lý* cạnh trang. Chọn nguồn (trang này, trang liên kết, memory), rồi một việc: *Viết nháp cả trang*, *Viết tiếp phần còn thiếu*, *Cập nhật theo code mới*, *Kiểm tra mâu thuẫn*, *Tóm tắt cho agent*. Một máy có repo của service sẽ viết. Xem *Thay đổi*, bấm *Áp dụng vào nháp* hoặc *Bỏ*, rồi lưu như thường.

### Duyệt đề xuất

1. **Tài liệu** › tab *Chờ duyệt*.
2. Mở một đề xuất, *Xem thay đổi*, rồi duyệt hoặc từ chối. Chọn nhiều mục để duyệt một lần.
3. Đề xuất dựa trên phiên bản cũ (trang đã đổi) sẽ bị đánh dấu xung đột; agent cần đọc lại và gửi lại.

> `AGENTS.md`, `CLAUDE.md`, `docs/decisions.md` trong repo do Hive ghi. Đừng sửa tay trong repo: hook sẽ chặn. Sửa trang trên hub (hoặc gửi đề xuất), rồi *Đồng bộ tài liệu*.

### Đưa tài liệu vào repo

- Trên app: **Công cụ & setup** › *Service trên máy này* › *Đồng bộ tài liệu*. Repo có remote GitLab/GitHub thì app mở MR từ nhánh `chore/xdev-hive-context`; không thì commit tại chỗ.
- Trước mỗi run, runner tự ghi bản mới nhất vào worktree của run.
- `AGENTS.md` repo tự viết (không có khối của Hive) được giữ nguyên; dùng *Đề xuất nhập vào Hive* để gửi nội dung đó lên hub.

## Memory

1. Mở **Memory**. Lọc: *Tất cả*, *Chờ duyệt*, *Mâu thuẫn*, *Cần xem lại*, *Chỉ mục cũ*.
2. Ghi tay: *+ Memory*, chọn *Loại*, *Thuộc* (hệ thống hoặc service), nội dung, *Ghi memory*.
3. Duyệt memory agent ghi: *Duyệt* hoặc *Xoá*.
4. Hai mục *Mâu thuẫn*: chọn *Giữ mục này*, *Giữ #id*, hoặc *Không mâu thuẫn*.
5. *Cần xem lại* (file mà memory nhắc tới đã đổi): bấm *Vẫn đúng* nếu nội dung còn đúng.
6. *Cũ* (lâu không ai dùng, agent không còn thấy): bấm *Giữ lại* nếu vẫn cần.

Dọn định kỳ: **Cài đặt service** › *Context agent* › *Dọn memory định kỳ*.

> Viết memory ngắn, mỗi mục một ý. Không ghi secret, token, mật khẩu.

## Skill

1. Mở **Skill**. Chọn một service để thấy đúng bộ skill agent của service đó nhận: skill riêng có nhãn *thay skill chung*; skill chung bị thay có nhãn *không dùng ở service này*.
2. *Skill mới*: *Tên* (chữ thường, số, `-`), *Mô tả* (việc skill làm và khi nào dùng), *Hướng dẫn*. Chọn *Chung* hay riêng service. Bấm *Tạo skill*.
3. Sửa: *Sửa skill*, xem *Thay đổi*, *Lưu*. Không có quyền thì gửi đề xuất; số đề xuất hiện ở *n chờ duyệt*.
4. Cột *Số run dùng 30 ngày*, *Lần dùng cuối*; lọc *Skill không ai dùng* để dọn.

Skill được ghi vào repo khi *Đồng bộ tài liệu* (`.claude/skills/<tên>/SKILL.md`), và liệt kê trong `AGENTS.md` cho agent khác.
