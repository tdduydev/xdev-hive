# Tối ưu token và quản lý memory trên máy

Bộ tối ưu chạy cục bộ qua `hive-worker` đi kèm app desktop. Bạn không cần đăng nhập hub hay kết nối mạng. Thay đổi được
áp dụng riêng cho gói CLI đã chọn; các phiên mở bằng gói đó, kể cả ngoài app, sẽ dùng cấu hình mới.

## Bật tối ưu

1. Mở màn **Token** và xem danh sách gói CLI cùng trạng thái hiện tại.
2. Chọn gói Claude hoặc Codex muốn tối ưu. Gói mặc định (`~/.claude` hoặc `~/.codex`) chỉ được thay đổi khi bạn chọn
   riêng gói đó.
3. Chọn mức **Cân bằng** hoặc **Mạnh**, rồi bấm **Bật tối ưu**.
4. Xem các mục đã áp dụng và cảnh báo. Khoá do bạn đặt trước đó được giữ nguyên; tuỳ chọn không tương thích với phiên
   bản CLI sẽ được bỏ qua và có lý do.

**Cân bằng** là mức khởi đầu phù hợp. Mức **Mạnh** giới hạn output chặt hơn; với Claude, mức này còn có thể đổi model
subagent. Chỉ chọn khi bạn chấp nhận các thay đổi đó.

Gemini và Antigravity hiện chưa được hỗ trợ. Các tích hợp RTK và CodeGraph là tuỳ chọn, không cần cài để dùng bộ tối ưu.

## Tắt, khôi phục và gỡ sạch

- **Tắt tối ưu** gỡ các mục mà Hive đã thêm. Nếu bạn sửa một giá trị sau khi bật, Hive giữ nguyên giá trị đó và báo
  cảnh báo.
- **Khôi phục** dùng bản sao lưu của lần bật để đưa cấu hình gói về trạng thái đã lưu. Chọn bản sao lưu phù hợp nếu có
  nhiều lần thay đổi.
- Để gỡ sạch, tắt tối ưu trên từng gói đã bật và kiểm tra trạng thái không còn mục của Hive. Nếu app không còn, cấu
  hình hook được thiết kế fail-open: thiếu sidecar thì CLI vẫn tiếp tục chạy. Bạn có thể xoá thủ công dữ liệu cục bộ
  của Hive tại `~/.xdev-hive/optimizer/` sau khi đã tắt cấu hình; thư mục này còn bản sao lưu và báo cáo cục bộ nên
  chỉ xoá nếu không cần khôi phục chúng.

Mỗi lần bật hoặc tắt đều tạo dữ liệu sao lưu để hỗ trợ khôi phục. Không sửa trực tiếp file cấu hình khi CLI đang chạy.

## Đọc bảng trước/sau

Màn Token chia số liệu theo gói và nguồn phiên. **Trước** là khoảng thời gian trước ngày bật, **Sau** là dữ liệu kể từ
ngày bật. Báo cáo chỉ chứa số tổng hợp, không sao chép prompt hay nội dung output.

- **Token quy đổi** ước lượng chi phí tương đối từ input, cache và output; đây không phải hoá đơn. So sánh cùng một
  gói và cùng loại nguồn giữa hai cột.
- **Ngữ cảnh đỉnh trung vị** cho biết kích thước ngữ cảnh cao nhất điển hình trong một phiên. Số phiên vượt 150k hoặc
  400k giúp nhận ra các phiên lớn.
- **Cache hit** là tỉ lệ cache được dùng. Tỉ lệ cao vẫn có thể đi cùng chi phí lớn nếu ngữ cảnh được đọc lại nhiều.
- **Output tool** cho biết các lệnh tạo nhiều nội dung được đưa lại vào ngữ cảnh. Hook cắt output hiển thị số ký tự đã
  cắt; bản đầy đủ được lưu cục bộ để tra cứu.
- **RTK gain** chỉ xuất hiện nếu máy có RTK và báo cáo đọc được số liệu của công cụ này.

Khi chưa đủ phiên để so sánh, màn hình báo chưa đủ dữ liệu. Số đo nghiên cứu trước khi bật là mốc tham khảo trên một
máy dev; mức tiết kiệm thực tế phụ thuộc cách dùng. Hãy dùng bảng sau khi có đủ phiên để đánh giá thay vì coi ước tính
trong nghiên cứu là cam kết.

## Điểm tối ưu token

Đầu màn **Token** có thẻ **Điểm tối ưu token** (0–100) cho máy và cho từng gói CLI ([spec 025](../specs/025-token-score/spec.md)).

- **Nhóm A, cấu hình (45 điểm)**: trần ngữ cảnh, trần output tool, file chỉ dẫn, skill và MCP nạp sẵn, chỉ mục code, RTK,
  prompt cache, model và effort mặc định.
- **Nhóm B, số liệu phiên 7 ngày (55 điểm)**: ngữ cảnh đỉnh, phần token ở phiên rất dài, ngữ cảnh lượt đầu, cache trúng,
  token mỗi lượt, output tool, token trước lần sửa đầu. Cần ít nhất 5 phiên của gói.
- **Đo được X/100 điểm** cho biết phần đã đo. Tiêu chí chưa đo không tính vào điểm.
- Mở **Xem chi tiết** để thấy từng tiêu chí, gợi ý và nút sửa nhanh. Sửa nhanh luôn cho xem trước và có **Hoàn tác**.
  Mức **Mạnh** đổi model subagent nên cần xác nhận riêng.
- Tiêu chí "skill và MCP nạp sẵn" cần chạy `/context`. Lệnh này gọi model và tốn token, nên chỉ chạy khi bạn bấm
  **Đo /context**. Kết quả được giữ 7 ngày. Nút **Tính lại** không chạy lệnh này.
- **Lịch sử 30 ngày**: biểu đồ điểm theo ngày, có dấu ở ngày áp dụng hoặc hoàn tác sửa nhanh và có bảng xem dạng
  chữ. Khi công thức điểm đổi, biểu đồ ngắt đoạn để không so hai thang khác nhau.
- Mục **Token** ở menu hiện điểm của máy, đọc từ lần tính gần nhất.
- Mở app khi điểm đã quá 24 giờ thì app tự tính lại ở nền sau 2 phút. Lần tính này không chạy `/context`. Tắt được
  ở thẻ điểm.
- Gói có trần ngữ cảnh tốt mà vẫn có nhiều token ở phiên rất dài sẽ có gợi ý tách việc thành phiên ngắn và `/clear`
  giữa các việc không liên quan. Chi tiết A8 hiện tỉ trọng token theo họ model, chỉ để xem.
- Điểm đo cấu hình và kích thước ngữ cảnh, không đo chất lượng kết quả của agent.

Các tiêu chí (nguồn: `worker/internal/score/criteria.go`). Giá trị nằm giữa mức đủ điểm và mức 0 điểm thì tính tuyến
tính. Tiêu chí có mục con lấy trung bình các mục con.

| Id | Tên | Tối đa | Mức đủ điểm | Nguồn đo |
|---|---|---|---|---|
| A1 | Trần ngữ cảnh (ngưỡng tự nén) | 10 | ≤ 200k token (0 điểm từ 600k) | cấu hình, `/context` |
| A2 | Trần output tool | 8 | Bash, Read, MCP ≤ 15k và có hook output của Hive | cấu hình |
| A3 | File chỉ dẫn | 5 | ≤ 2k token, không bị cắt | phiên, file chỉ dẫn |
| A4 | Skill và MCP nạp sẵn | 7 | ≤ 4k token (0 điểm từ 20k) | `/context` |
| A5 | Chỉ mục code | 5 | có công cụ, có MCP, dự án top đã lập chỉ mục | công cụ, cấu hình |
| A6 | RTK | 3 | đã cài và có hook | công cụ, cấu hình |
| A7 | Prompt cache | 3 | cache bật, CLI đủ phiên bản | cấu hình |
| A8 | Model và effort mặc định | 4 | effort không quá cao, subagent không dùng Opus | cấu hình |
| B1 | Ngữ cảnh đỉnh (trung vị) | 12 | ≤ 120k token (0 điểm từ 300k) | phiên |
| B2 | Token ở phiên rất dài (> 400k) | 10 | ≤ 10% (0 điểm từ 50%) | phiên |
| B3 | Ngữ cảnh lượt đầu (trung vị) | 8 | ≤ 20k token (0 điểm từ 50k) | phiên |
| B4 | Cache trúng | 6 | ≥ 90% (0 điểm dưới 60%) | phiên |
| B5 | Token mỗi lượt | 8 | ≤ 20k (0 điểm từ 60k) | phiên |
| B6 | Output tool mỗi lần gọi | 5 | ≤ 600 token (0 điểm từ 2.500) | phiên |
| B7 | Token trước lần sửa đầu | 6 | ≤ 30% (0 điểm từ 70%) | phiên (chỉ Claude) |

Ngưỡng trong bảng là của Claude. Với Codex, A1 đủ điểm khi ≤ 150k token (0 điểm từ 400k), A4 đếm số máy chủ MCP bật
(≤ 2 đủ điểm, 0 điểm từ 8).

Trên Windows, RTK chưa hỗ trợ nên A6 là "không áp dụng" và không tính vào điểm.

## Ngữ cảnh dùng chung và nút "Tối ưu"

Phần này theo [spec 029](../specs/029-shared-context-sync/spec.md) và [ADR 0037](adr/0037-shared-context-local-files.md).
Mục "Ngữ cảnh dùng chung" trên màn Memory, nút "Tối ưu" ở màn Token, lệnh `hive-worker optimize all` và hàng đợi gửi
lên hub đã có trong app. Chưa ai chạy quickstart của spec 029 trên máy thật và đo mức giảm token (SC-008); đó là việc
của chủ dự án, nên số liệu đích trong spec chưa được kiểm.

### Ngữ cảnh dùng chung

Mỗi dự án có **một nguồn ngữ cảnh** (quy ước, lệnh test, tóm tắt kiến trúc) lưu ngoài repo, trong
`~/.xdev-hive/context/`. Bạn soạn nguồn một lần; app ghi nó vào file ngữ cảnh cục bộ của từng CLI đã cài trên máy:

| CLI | File đích |
|---|---|
| Claude Code | `CLAUDE.local.md` |
| Codex | `AGENTS.override.md` (bản gương của `AGENTS.md` kèm khối) |
| Gemini | `GEMINI.local.md` |
| Antigravity | `.agents/rules/xdev-hive.md` |

- Các file này không được git theo dõi: app thêm chúng vào `.git/info/exclude` và không bao giờ ghi vào file git đang
  theo dõi.
- Nội dung nằm trong một **khối có đánh dấu** `<!-- xdev-hive:context … -->`. App không sửa, xoá hay sắp xếp lại chữ
  ngoài khối.
- Nếu bạn sửa tay bên trong khối, app không ghi đè mà báo xung đột để bạn chọn giữ bản file hay bản nguồn.
- Codex chỉ đọc một file mỗi thư mục, nên bản gương thay `AGENTS.md`. Nếu bạn đã tự viết `AGENTS.override.md`, app bỏ
  qua Codex và ghi lý do.
- Mọi lần ghi có bản sao lưu. Tắt ngữ cảnh dùng chung gỡ khối khỏi mọi file; file app tạo mà chỉ có khối được chuyển
  vào thùng rác.
- Nếu dự án đang dùng **Dùng chung memory** ở mục Memory, app đề nghị chuyển sang nguồn mới, có xem trước. App không
  tự chuyển.
- Khi đã đăng nhập hub, app kéo memory **đã duyệt** của dự án vào phần "Từ hub" của khối. Bấm **Đồng bộ** để kéo ngay;
  công tắc tự đồng bộ kéo định kỳ (mặc định 60 phút). Phần này nằm trong ngân sách token của khối (mặc định 2.000, chính
  sách dự án đổi được): memory được ghim lấy trước, rồi memory mới hơn; số mục bị bỏ được ghi lại. Nội dung trông như
  bí mật không được ghi vào khối và app báo bạn. Mất mạng thì khối giữ bản lần trước và màn hiện thời điểm đồng bộ gần
  nhất.

### Nút "Tối ưu"

Nút ở thẻ **Điểm tối ưu token** chạy một chuỗi cố định cho cả máy:

1. Bật bộ tối ưu cho các gói CLI chưa đạt mức đích.
2. Các sửa nhanh an toàn của thang điểm ở trên.
3. Cập nhật khối ngữ cảnh của các dự án đã bật ngữ cảnh dùng chung.
4. Tính lại điểm.

Cách dùng: bấm **Tối ưu**, xem danh sách thay đổi theo nhóm (cấu hình CLI, công cụ, ngữ cảnh), bỏ chọn dòng không muốn,
xác nhận một lần. Chưa xác nhận thì không có gì bị ghi. Sau khi chạy, app hiện điểm trước và sau, kết quả từng dòng;
một bước lỗi không dừng các bước khác. **Hoàn tác** đảo cả lần chạy về đúng nội dung trước đó. Công cụ đã cài (RTK,
CodeGraph) được giữ lại.

Giới hạn: nút chỉ ghi CLAUDE.md, AGENTS.md, GEMINI.md, rules và memory **trong khối đánh dấu của xDev Hive**. Nút không
tắt MCP, không xoá skill, không chạy nén bằng AI (nén vẫn duyệt từng file ở màn Memory). Mức **Mạnh** và việc đổi model
luôn tắt sẵn, cần chọn tay. Hai lần "Tối ưu" không chạy cùng lúc trên một máy.

### Chính sách tối ưu của dự án

Người quản trị dự án hoặc đội đặt chính sách trên web, ở mục **Tối ưu máy dev** trong cài đặt dự án: mức tối ưu, RTK,
CodeGraph, trần nén ngữ cảnh, ngân sách token của khối, tự đồng bộ memory và khoảng cách. Mọi thay đổi được ghi kiểm
toán. Người có quyền duyệt memory cũng ghim được memory ở danh sách memory; memory ghim lên đầu phần "Từ hub".

Máy kéo chính sách của các dự án đã gắn. Thẻ **Điểm tối ưu token** liệt kê mục nào máy còn lệch chính sách, và nút
"Tối ưu" lấy chính sách làm đích, ghi nguồn của từng dòng ("theo chính sách dự án" hay mặc định). Chính sách không tự áp
dụng: chỉ khi bạn bấm nút. Khi nhiều dự án đòi mức khác nhau cho cùng một gói CLI, app lấy mức cao nhất, trừ bước cần
xác nhận riêng (Mạnh, đổi model).

### Gửi lên hub và hàng đợi

Nút **Gửi lên hub** ở mục memory đi qua hàng đợi của `hive-worker` (`outbox`, spec 027), không gọi hub trực tiếp. Mất mạng
thì việc được xếp hàng và màn báo "Đã xếp hàng, sẽ gửi khi có mạng"; worker gửi lại, kể cả sau khi tắt và mở app. Hub luôn
đặt đề xuất ở trạng thái chờ duyệt. Màn Memory có thẻ **Đang chờ gửi** (số việc) và thẻ **Hub không nhận** (lý do hub
nêu, nút **Bỏ** để đóng). App thử gửi phần còn đọng khi mở và sau mỗi lần gửi.

### Số liệu token của dự án

Worker gom token theo dự án (gán phiên vào dự án theo thư mục làm việc) và, khi bạn bật cho từng dự án, gửi **chỉ số**: token
quy đổi theo khoảng ngày, điểm, điểm từng tiêu chí, mục lệch chính sách. Không gửi nội dung phiên, lời nhắc, tên file hay
đường dẫn. Mặc định tắt. Trang dự án trên web hiện bảng theo người và theo máy cho thành viên dự án.

Còn thiếu: công tắc bật gửi và nút **Xoá số liệu đã gửi** trên app desktop chưa có, vì lệnh worker đặt cờ theo dự án chưa
được nối vào CLI (xem [plan.md mục 5](../specs/029-shared-context-sync/plan.md)). Hub đã có thủ tục xoá số liệu của máy
mình.

## Memory

Màn **Memory** quét các file memory và hướng dẫn của Claude, Codex và Gemini trên máy, ước tính token, ngày sửa và
các vấn đề như trùng lặp, liên kết hỏng hoặc file chưa được đưa vào chỉ mục. Bạn có thể sửa, xoá, khôi phục hoặc gộp
file; thao tác ghi tạo bản sao lưu và thao tác xoá chuyển file vào thùng rác.

Bật **Dùng chung memory** để gom memory Claude của một dự án giữa các gói. Nếu có file trùng tên nhưng nội dung khác,
chọn bản cần giữ trước khi áp dụng. Khi tắt, mỗi gói nhận lại một bản sao riêng.

Các thao tác này chỉ thay đổi dữ liệu cục bộ. Đồng bộ memory với hub là tính năng riêng và cần đăng nhập.
