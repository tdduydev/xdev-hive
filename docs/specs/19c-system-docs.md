# 19c. Tài liệu và memory của hệ thống

Một hệ thống (19b) gom nhiều service, mỗi service một dự án Hive. 19c cho hệ thống có tài liệu và memory riêng: API contract, sự kiện, cách các service gọi nhau. Chúng dùng chung cho mọi service của hệ thống và tách khỏi phần *Chung* của cả team.

## Chủ sở hữu `sys:<tên>`

Dữ liệu của hệ thống thuộc về một chủ sở hữu nội bộ `sys:<tên hệ thống>` (`systemOwner(name)` trong `packages/core/src/access.ts`). Dấu `:` không có trong tên dự án (`PROJECT_NAME`), nên không trùng với dự án nào. Mọi chỗ đang dùng "dự án sở hữu" (cột `project` của docs, memory, proposals; `#need`, `sees`, `may`) dùng luôn chủ sở hữu này.

- Khoá tài liệu: `system/<tên>/<trang>`. `parseDocKey` trả `{ scope: "system", project: "sys:<tên>", slug, skill: false }`. Skill trong hệ thống chưa có (khoá `system/<tên>/skills/…` bị từ chối).
- Memory: `memory.write` nhận thêm `system: <tên>`; hàng memory có `project = "sys:<tên>"`.
- `DocScope` thêm `"system"`.

## Quyền

Không ai được cấp quyền trực tiếp trên hệ thống. Quyền suy ra từ quyền ở các service của nó (`withSystemGrants(access, systems)`, hàm thuần trong access.ts, web và hub dùng chung):

- `view`, `docPropose`, `memoryWrite`, `chatUse`: có ở **ít nhất một** service của hệ thống. Người làm service nào cũng đọc được hợp đồng chung và đề xuất sửa.
- Các quyền khác (`docEdit`, `docApprove`, `contextEdit`, `memoryApprove`…): phải có ở **mọi** service của hệ thống, như `systems.save` cần quyền quản lý mọi dự án liên quan. Sửa hợp đồng chung ảnh hưởng mọi service.
- Tài khoản không giới hạn (admin hub, token không thuộc tài khoản) như cũ.

Hub gắn quyền suy ra vào `actor.access` ở đầu mỗi lời gọi (đọc bảng `systems`). Trang web làm cùng phép tính từ `me.access` và `systems.list`.

## Agent nhận gì

- `docs.list { project: A }` trả thêm tài liệu của các hệ thống có A. `doc_list` của MCP và lượt đồng bộ của máy có luôn.
- AGENTS.md của A (`renderAgentsMd`): sau phần *Chung*, các tài liệu hệ thống có *Đưa vào AGENTS.md* (giống tài liệu *Chung*), mỗi cái có dòng `<!-- system/<tên>/<trang> vN -->`. Tài liệu hệ thống có *Áp dụng cho* (paths) và *Đưa vào AGENTS.md* thành file theo đường dẫn như tài liệu *Chung*, tên `sys-<tên>-<trang>.md`. *Context agent* có khối `system`.
- `memory.search { project: A }` tìm cả memory của các hệ thống có A (cùng mức với memory của A). Phạm vi hệ thống trên web (`projects` = các service) cũng thấy memory của chính hệ thống.
- MCP `memory_write` có tham số `system`.

## Giao diện

- *Tài liệu*: không gian mới cho từng hệ thống người đó thấy (sau *Chung*, trước các dự án). Tạo trang trong không gian hệ thống ra khoá `system/<tên>/<trang>`.
- *Memory*: lọc theo hệ thống; ghi memory chọn được hệ thống. Memory của hệ thống hiện nhãn hệ thống thay cho `sys:<tên>`.
- *Hệ thống*: mỗi hệ thống có liên kết tới không gian tài liệu của nó và số tài liệu, memory.
- Danh sách dự án của thanh bên bỏ chủ sở hữu `sys:*`.

## Giữ dữ liệu

`systems.remove` từ chối khi hệ thống còn tài liệu hoặc memory (`errors.systemHasData`): chuyển hoặc xoá chúng trước. Đổi tên hệ thống chưa có (tên là khoá).

## Test

- `packages/core/test/system-docs.test.ts`: khoá `system/…`; quyền suy ra (một service: đọc, đề xuất, ghi memory; mọi service: sửa, duyệt); người không ở service nào không thấy; `docs.list { project }` có tài liệu hệ thống của đúng hệ thống; `memory.search` có memory hệ thống; `systems.remove` từ chối khi còn dữ liệu.
- `packages/core/test/sync.test.ts` (hoặc file sync sẵn có): AGENTS.md có khối tài liệu hệ thống, file theo đường dẫn tên `sys-…`.
- e2e web: tạo trang trong không gian hệ thống và thấy nó ở *Tài liệu* của một service.
