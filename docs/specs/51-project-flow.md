# 51. Sơ đồ dự án (React Flow)

Viết ngày 6/10. Người dùng hỏi: "có thể overview theo từng dự án bằng React Flow để overview được". Họ chọn vẽ cả bốn lớp:
1. **Task và phụ thuộc**;
2. **Agent đang làm gì**;
3. **Luồng SDLC của tính năng**;
4. **Hệ thống nhiều service**.

Task:
- **R-51a**: khung và lớp Task;
- **R-51b**: lớp Agent, kéo task vào agent để gán (cần 50a);
- **R-51c**: lớp SDLC và Hệ thống.

## Thư viện

- **[`@xyflow/react`](https://reactflow.dev/)** (React Flow 12, giấy phép MIT):
  - nút tuỳ biến là component React;
  - kéo, phóng to, thu nhỏ, chạm trên điện thoại;
  - `onlyRenderVisibleElements` cho sơ đồ lớn.
- **[`@dagrejs/dagre`](https://github.com/dagrejs/dagre)** (MIT) để tự xếp nút theo hướng trái → phải. Không dùng elkjs: nặng hơn, giấy phép EPL.
- Chỉ thêm vào `packages/ui`. Tải lười (`React.lazy`) để trang khác không nặng thêm.
- Lấy CSS gốc của React Flow (`@xyflow/react/dist/base.css`), còn màu và chữ đi theo token trong `packages/ui/src/tokens/`, cả chế độ tối. Không dùng theme mặc định của thư viện.

## Trang

- **Mục menu *Sơ đồ*** (`#/graph`):
  - theo menu mới của 49b, nằm trong nhóm *Làm việc*, trước *Tính năng*;
  - trước khi có 49b thì đặt sau *Hôm nay*;
  - quyền `view`.
- **Phạm vi** theo ô phạm vi đang chọn:
  - một dự án;
  - một hệ thống: thêm lớp *Hệ thống*, các lớp khác gộp mọi service của hệ thống;
  - *Tất cả dự án*: chỉ hiện lớp *Hệ thống* và mỗi dự án một nút tóm tắt, bấm vào thì vào phạm vi dự án đó.
- **Thanh trên**:
  - chip chọn lớp: Task / Agent / SDLC / Hệ thống;
  - bộ lọc: ẩn task xong cũ hơn 7 ngày (mặc định bật), chỉ task của tôi, theo agent;
  - nút *Vừa màn hình*;
  - nút *Danh sách* về trang Task.
- **Bấm một nút** mở khung có sẵn: khung task, trang run, thẻ luồng, trang dự án. Không làm khung mới.
- **Cập nhật trực tiếp** theo sự kiện SSE mà các trang khác đã nghe (xem cách Board và Bản đồ agent làm mới trong `packages/ui`), không tải lại cả sơ đồ. Vị trí nút giữ nguyên khi dữ liệu đổi; chỉ nút mới được xếp.
- **Vị trí nút người đã kéo** lưu trong `localStorage` theo dự án và lớp (bọc try/catch). Nút *Xếp lại* bỏ vị trí đã lưu.

## Các lớp

### Task (R-51a)

- **Nút là task**:
  - mã, tiêu đề (cắt 2 dòng), chip trạng thái;
  - chip agent đã gán (50);
  - chấm *đang chạy* nếu có run mở.
- **Màu viền theo trạng thái**, dùng token màu trạng thái có sẵn; không thêm màu mới.
- **Cạnh**:
  - task phụ thuộc → task cần nó;
  - phụ thuộc chưa xong thì nét liền, đã xong thì nét mờ;
  - phụ thuộc sang dự án khác (19d) thì nút mờ có tên dự án.
- **Nhóm**: task thuộc luồng SDLC nằm trong khung nhóm mang tên tính năng (`specs/<dir>`). Task lẻ nằm ngoài.
- **Đếm**: hơn 300 task thì gộp task *Xong* thành một nút "+N đã xong" mỗi nhóm.

### Agent (R-51b)

- **Nút** máy → gói → task (đang chạy, rồi hàng đã gán của 50, 3 task đầu).
- **Gói** hiện:
  - trạng thái: rảnh, bận, hết quota, nghỉ, đăng xuất;
  - % 5 giờ và tuần;
  - số chỗ trống.
- **Cạnh** gói → task đang chạy có hiệu ứng chạy (tắt khi người dùng bật `prefers-reduced-motion`).
- **Kéo một nút task** (từ lớp này hay một danh sách *Chưa gán* ở cạnh) **thả vào nút gói**: gọi `tasks.assign`.
  - Cần `runDispatch`.
  - Trên điện thoại không kéo được: bấm task rồi chọn agent.

### SDLC (R-51c)

- **Mỗi luồng** (`sdlc_flows`) là một hàng nút bước: Spec → Plan → Tasks → Giao việc → Review → Merge.
- **Nút bước** hiện trạng thái: xong, đang chạy, chờ chốt (có tên người hay vai cần duyệt), bị yêu cầu sửa.
- **Nút chờ chốt mà người xem có quyền chốt** có nút *Cho qua* / *Yêu cầu sửa* ngay trên nút, dùng method có sẵn của 34.

### Hệ thống (R-51c)

- **Nút là dự án** (service) trong hệ thống. Mỗi nút hiện:
  - task mở / tổng;
  - run đang chạy;
  - agent đang làm.
- **Cạnh** là phụ thuộc chéo giữa task của hai service (19d), nhãn là số phụ thuộc chưa xong.
- **Bấm nút** thì vào lớp Task của dự án đó.

## Dữ liệu

**Lấy từ method có sẵn**, không thêm method hub cho 51a:
- `tasks.list` có `dependsOn` / `waitingOn` / `depProjects`;
- `machines.list`;
- `sdlc.flows`, hay tên tương đương có sẵn;
- `systems.list`.

**Đo trước khi tối ưu:** nếu tải một dự án hơn 500 task chậm hơn 1 giây trên hub thật thì 51c thêm `projects.graph { project | system }`, trả nút và cạnh đã gọn.

## Mobile

- **Dưới 768px:**
  - sơ đồ chiếm toàn màn hình;
  - nút điều khiển (*Vừa màn hình*, phóng to, thu nhỏ) ở góc dưới, vùng chạm ≥ 44px;
  - ẩn bản đồ nhỏ (minimap);
  - chip lớp cuộn ngang.
- **Bấm nút** mở khung toàn màn hình như 42b.
- **Mặc định** `fitView` và chỉ lớp Task, lọc task chưa xong.
- **Kiểm bằng skill `ui-ux-pro-max`**: vùng chạm, tương phản chữ trên nút, `prefers-reduced-motion`, nhãn cho trình đọc màn hình. Nút có `aria-label` gồm mã task, tiêu đề, trạng thái. Có danh sách thay thế qua nút *Danh sách*.

## Test

- **UI:**
  - dựng nút và cạnh từ dữ liệu mẫu, đủ trạng thái;
  - gộp "+N đã xong";
  - phụ thuộc chéo dự án;
  - xếp dagre không chồng nút;
  - giữ vị trí khi dữ liệu đổi.
- **E2e web** (desktop và `e2e:mobile`):
  - mở *Sơ đồ*, thấy nút của task mẫu và cạnh phụ thuộc;
  - bấm nút mở khung task;
  - đổi lớp;
  - ảnh chụp mỗi lớp.
- **51b**: kéo task thả vào gói thì gọi `tasks.assign` (e2e trên desktop).

## Ràng buộc khi làm

- Không đổi trang Task, Board, Bản đồ agent hiện có.
- App desktop không có mục này (35a/44: app chỉ việc của máy).
- Không tăng version, không đánh dấu roadmap.
- Comment giải thích vì sao.
