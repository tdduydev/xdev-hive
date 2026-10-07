# Bốn trang tổng quan · thiết kế tháng 10/2026

Task **RES-dashboard**, nghiên cứu ngày **07/10/2026**, baseline `c6e1d52a` (origin/main). Chỉ là đề xuất, chưa đổi code. Phạm vi: **Hôm nay**, **Agents** (desktop) cùng **Máy & agent › Bản đồ agent / Quota**, **Agent đang chạy** (Runs), **Quản trị › Tổng quan vận hành / Hub / Phiên bản app**. Văn phong và cách dẫn chứng theo [chat-2026-10.md](chat-2026-10.md). Token và component theo [[ban-thiet-ke-2026-09]] (`docs/design/2026-09-redesign/`, `packages/ui/src/tokens/`), có đối chiếu checklist `ui-ux-pro-max` (`.claude/skills/ui-ux-pro-max`).

Người quản trị phàn nàn: *"để kèm thế khó nhìn quá"*. Đọc code và ảnh chụp thì thấy nguyên nhân chung: **mọi thứ cùng một độ đậm**. Thẻ "Ổn" to bằng thẻ "Quá hạn", số liệu tổng nằm trên việc cần làm, cùng một thông tin quota xuất hiện ở năm chỗ, và nút thao tác nằm xa dữ liệu của nó.

## 1. Quyết định thiết kế

1. **Việc cần người đứng đầu, tình trạng xếp sau.** Mỗi trang mở ra ở vùng "cần chú ý": cái hỏng, cái chờ duyệt, cái sắp hết quota. Phần "mọi thứ vẫn ổn" thu thành một dòng tóm tắt.
2. **Một dải tóm tắt, không dùng lưới KPI ngang hàng.** Đầu trang có một `SummaryStrip`: tối đa 4 số, mỗi số là link lọc. Chỉ số nào bất thường mới có màu.
3. **Một nơi cho cảnh báo.** Cảnh báo hub, máy thiếu tool, backup trễ, cooldown chảy vào Hôm nay (inbox đã có kind `alert`, `machine`). Trang khác chỉ hiện một chip "N cảnh báo" dẫn về đó, không vẽ lại.
4. **Thông tin lặp thì giữ một bản gốc.** Quota có một chỗ đầy đủ (tab Quota) cùng một dạng rút gọn dùng chung (thẻ gói của UX-quota-card-design). Chi phí chỉ có ở tab Chi phí.
5. **Mở dần.** Cấu hình hiếm dùng (thêm gói, ưu tiên, worktree, runner nâng cao) chuyển vào `details` hoặc sheet. Trạng thái "ổn" chỉ còn một dòng, bấm vào mới mở chi tiết.
6. **Điện thoại là một cột theo thứ tự ưu tiên**, không dồn lưới. Ẩn những gì chỉ dùng được bằng bàn phím (gợi ý J/K) và cuộn ngang.

## 2. Nghiên cứu có nguồn

Đọc ngày 07/10/2026, chỉ dùng tài liệu chính thức, chưa dùng thử sản phẩm.

| Nguồn | Điều rút ra | Áp dụng cho Hive |
| --- | --- | --- |
| Grafana · [Dashboard best practices](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/), [blog 2024](https://grafana.com/blog/2024/07/03/getting-started-with-grafana-best-practices-to-design-your-first-dashboard/) | "A dashboard should tell a story or answer a question", "should reduce cognitive load". Đi từ tổng quan xuống chi tiết, dùng row có thể thu gọn. Đọc theo hình Z nên cái quan trọng đặt góc trên trái, số chính to, chi tiết nhỏ hơn ở dưới. | Mỗi trang trả lời đúng một câu hỏi (§3–6). Góc trên trái dành cho "cần chú ý". Phần phụ là row thu gọn được. |
| Linear · [Inbox](https://linear.app/docs/inbox), [Priority inbox 03/09/2026](https://linear.app/changelog/2026-09-03-priority-inbox) | Inbox ưu tiên "separates what needs your attention from what can wait, so … a review blocking a release never gets buried". | Hôm nay giữ inbox nhóm theo vai (đã có `groupInbox`), không để khối số liệu hệ thống đè lên. |
| GitHub Actions · [Monitor self-hosted runners](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/monitor-and-troubleshoot) | Runner chỉ có ba trạng thái: Idle, Active, Offline, hiện trong một danh sách gồm tên, nhãn, trạng thái. | Máy/gói dùng một bộ trạng thái ngắn có chữ, đặt ở hàng đầu. Chi tiết (tool, worktree) để vào trong. |
| Buildkite · [Manage queues](https://buildkite.com/docs/clusters/manage-queues) | Agents được nhóm theo cluster rồi đến queue. Hàng đợi là thực thể riêng. | Hàng đợi chung của hub tách khỏi cột máy, có một số đếm trong dải tóm tắt. |
| Vercel · [Dashboard redesign](https://vercel.com/blog/dashboard-redesign) | Trang tổng quan ưu tiên trạng thái production và deployment mới nhất, link thẳng tới bản đang chạy. | Hub/Phiên bản: hiện bản đang chạy cùng trạng thái rollout trước, đường dẫn DB/backup để sau. |
| Datadog · [Service page](https://docs.datadoghq.com/tracing/services/service_page/) | Gộp nhiều tín hiệu (monitor, incident, Watchdog) thành một huy hiệu sức khoẻ, đưa cảnh báo nặng nhất lên. | Một chip sức khoẻ cho mỗi máy/hub. Nhiều trạng thái thì lấy mức nặng nhất. |
| Carbon · [Status indicator pattern](https://www.carbondesignsystem.com/patterns/status-indicator-pattern) | Trạng thái chia mức chú ý cao/vừa/thấp, có cả hình lẫn màu. Khi gộp nhiều trạng thái thì "use the highest-attention color". | Chip có icon cộng chữ, không chỉ dùng màu. "Ổn" dùng tone neutral/success nhạt, không giành mắt. |
| NN/g · [Progressive disclosure](https://www.nngroup.com/videos/progressive-disclosure/) | Hiện vài lựa chọn phục vụ đa số việc, phần còn lại để ở cấp hai có nhãn rõ. | Thêm gói, mẫu, worktree, runner nâng cao, ưu tiên gói đưa vào cấp hai. |
| Hermes Agent | Đã phân tích trong [chat-2026-10.md §2.2](chat-2026-10.md): hoạt động ngắn luôn hiện, chi tiết thu gọn. | Bản đồ agent hiện một dòng "đang làm gì", log để ở Runs. |
| `ui-ux-pro-max` (`references/quick-reference.md`) | `progressive-disclosure`, `progressive-loading` (skeleton cho thao tác trên 1 giây), `empty-data-state`, `touch-density`, `data-density`, tương phản 4.5:1, target 44px dưới 768px. | Áp dụng cho trạng thái và a11y ở từng trang. |

## 3. Bằng chứng: ảnh chụp và cách chụp lại

Chạy được trên máy này (Electron, hub tạm):

```
npm ci
npm run e2e -w @xdev-hive/web -- --only today-web,agent-map,machine-profiles,quota-outlook,hub-page,runs-review,overview-by-system <out>   # 10/10 qua
npm run e2e:mobile -w @xdev-hive/web -- --no-build --only today-web,agent-map,machine-profiles,quota-outlook,hub-page,runs-review <out>  # 9/9 qua, overflow.json rỗng
```

Ảnh dùng để nhận định (không commit vào repo): `08-today-systems`, `09-today-groups`, `10-agent-map-codex`, `05-quota-outlook`, `06-runs-review-detail`, `07-hub-page` (desktop 1440, scale 2x), cùng `08-today-groups`, `09-agent-map-codex` (390×844). **Trang Agents của app desktop** (`client.desktop` bắt buộc) không chụp được qua e2e web. Cần `npm run build -w @xdev-hive/desktop && npm run smoke -w @xdev-hive/desktop -- <dir>`, nghiên cứu này chưa chạy bước đó nên phần Agents chỉ dựa vào code.

## 4. Hôm nay (`packages/ui/src/pages/Today.tsx`)

**Câu hỏi trang phải trả lời:** *"Việc gì đang chờ tôi, việc nào trước?"*

### 4.1 Hiện trạng

- Bố cục master-detail: cột trái `basis-[360px]` (`Today.tsx:325`), chi tiết bên phải (`:431`).
- Cột trái xếp từ trên xuống: `StartReminder` (chỉ app desktop, `:326`), `DesktopConfigIssues` (`:327`), tab **Cần bạn N / Đã xử lý N** cùng "Xếp theo vai" (`:328-359`), **`SystemOverview compact`** khi scope là Tất cả service (`:361`), rồi mới đến inbox nhóm theo vai (`:362-399`). Đáy cột là gợi ý phím J/K, ↵, E (`:425-429`).
- `SystemOverview` (`components/SystemOverview.tsx:27-41`) vẽ mỗi hệ thống thành một Card, mỗi service ba ô `task mở / Run đang chạy / Chờ duyệt` cỡ `text-lg`.
- Chi tiết gồm Header (chip, scope, thời gian, tiêu đề), thân, Footer có nút chính bên trái và gợi ý phím bên phải (`:453-486`).

### 4.2 Vấn đề

1. **Số liệu hệ thống đẩy inbox xuống dưới màn hình.** Ảnh `08-today-systems`: với 2 hệ thống, cột trái chỉ còn thấy khối "Hệ thống", **không còn mục inbox nào trong khung nhìn** dù header ghi "Cần bạn 9". Trên điện thoại (`08-today-groups`), mục inbox đầu tiên bắt đầu ở khoảng y≈1050/1688. Đây là lỗi thứ bậc nặng nhất: phần tóm tắt nằm trên phần việc phải làm.
2. **Số liệu không giúp quyết định.** Ô "Run đang chạy 0" lặp lại ba lần, mỗi service một lần, cỡ chữ bằng số "Chờ duyệt". Không ô nào là link lọc inbox (nút tên service đổi scope, `SystemOverview.tsx:32-36`). Cùng bộ số này lại có ở trang Tổng quan (`Overview.tsx`), nên trùng thông tin.
3. **Chi tiết rộng nhưng trống, nút xa nội dung.** Ảnh `09-today-groups`: nội dung chiếm khoảng 300px đầu của vùng 1170px, nút Xác nhận dính đáy màn hình (`Footer` ở `:466`), cách nội dung khoảng 750px. Gợi ý phím hiện cả ở footer chi tiết lẫn đáy cột trái, và vẫn hiện trên điện thoại (`:425`), nơi không có bàn phím.
4. Thứ yếu: `Today.tsx` tự viết `Chip`, `Header`, `Footer`, `Kv` (`:32-102`, `:453-486`), trùng `Chip`, `DetailHeader`, `DetailFooter`, `KvRows` ở `components/panes.tsx:17-157`. `StartReminder` và `DesktopConfigIssues` chiếm hai dải riêng trên tab.

### 4.3 Bố cục đề xuất

Thứ tự ưu tiên ở cột trái:

1. **Dải nhắc gộp** (chỉ hiện khi có việc): gộp StartReminder và ConfigIssues thành một dòng `Notice` "Còn 2 bước cài đặt · 1 lỗi cấu hình" kèm link. Không có gì thì không vẽ.
2. **Tab Cần bạn / Đã xử lý** giữ nguyên, kèm dòng "Xếp theo vai".
3. **Inbox nhóm theo vai**, không đổi logic `groupInbox`.
4. **Hệ thống**: chuyển thành một dòng thu gọn ở **cuối** danh sách, hoặc dải tóm tắt trên vùng chi tiết khi chưa chọn mục (xem dưới): "3 hệ thống · 12 task mở · 1 run · 8 chờ duyệt", bấm vào mở Tổng quan. **Bỏ** `SystemOverview` khỏi Hôm nay. Bản đầy đủ đã có ở `#/overview`.

Vùng chi tiết:

- Nội dung giới hạn `--reading-max` (72ch). **Hàng nút đặt ngay dưới nội dung**, sticky đáy chỉ khi nội dung dài hơn khung nhìn. Gợi ý phím chuyển vào tooltip của nút chính và `aria-keyshortcuts`, chỉ hiện từ `md` trở lên.
- Khi chưa chọn mục mà inbox trống: hiện trạng thái "Xong hết" (đã có, `:440-447`) cùng `SummaryStrip` 3 số (run đang chạy, task review, cảnh báo mở), mỗi số dẫn sang trang của nó.

Điện thoại: chỉ hiện danh sách. Dải nhắc gộp → tab → inbox. Thanh gợi ý phím ẩn. Chi tiết toàn màn, nút trong vùng an toàn đáy, `min-h-11` (đã có `max-md:min-h-11`).

```
Desktop                                        Điện thoại
┌──────────────────────┬───────────────────────────┐   ┌──────────────────┐
│! 2 bước cài · 1 lỗi ›│ [Leader đề xuất] payment  │   │! 2 bước cài ›    │
│[Cần bạn 9][Đã xử lý] │ Bật/tắt tool · codegraph  │   │[Cần bạn 9][Xong] │
│ Cần bạn quyết     6  │ Lý do… (≤72ch)            │   │ Cần bạn quyết  6 │
│ • Leader đề xuất …   │ ┌ đề xuất ─────────────┐  │   │ • Leader đề xuất │
│ • Chốt SDLC  …       │ └──────────────────────┘  │   │ • Chốt SDLC      │
│ Agent đang chờ    1  │ [Xác nhận] [Mở chat] Bỏ qua│  │ Agent chờ      1 │
│ …                    │                           │   │ …                │
│ 3 hệ thống · 12 task›│                           │   │ 3 hệ thống ›     │
└──────────────────────┴───────────────────────────┘   └──────────────────┘
```

### 4.4 Thành phần, trạng thái, a11y

- **Dùng lại:** `ListPane`, `ListItem`, `Chip`, `DetailHeader`, `DetailBody`, `DetailFooter`, `PaneEmpty` (`components/panes.tsx`), `Notice`, `MobileBack`, `useMobileDetail`. Bỏ các bản tự viết trong Today. Thêm `SummaryStrip` dùng chung (§8).
- **Loading:** 3 dòng `Skeleton` cao `--row-h` trong danh sách, không để trống. **Rỗng:** "Xong hết" cùng một gợi ý đi đâu tiếp. **Lỗi:** `ErrorNote` trên danh sách, vẫn giữ dữ liệu cũ (inbox polling 30 giây).
- **a11y:** giữ `role=listbox/option` hiện có (memory 899 chỉ cấm đưa listbox trở lại *panes*). Chấm chưa đọc phải có chữ thay thế (đã có `aria-label`). Chip `text-[11px]` trên nền soft cần đạt 4.5:1 ở cả hai theme, kiểm bằng axe trong `a11y-pages`. Target 44px dưới 768px.

## 5. Agents (desktop) và Máy & agent (web)

Hai trang cùng nói về "gói chạy được không" nhưng hiện tách rời:

- **Agents** (`pages/Agents.tsx`, chỉ app desktop): gói của **máy này**, gồm cấu hình và quota chi tiết.
- **Máy & agent** (`pages/Sections.tsx:85-116`): tab **Bản đồ agent** (`Machines.tsx` + `AgentMap.tsx`), **Quota** (`Quota.tsx`), và với admin thêm Đội máy, Hàng đợi, Chi phí.

Thẻ gói (session/tuần, reset, ước tính phiên, credits, chặn, "Dùng tiếp") **thuộc task UX-quota-card-design**. Tài liệu này chỉ định *chỗ đặt* và *mật độ* của thẻ, giả định thẻ có hai dạng: **gọn** (tên, chip trạng thái, 2 thanh phiên/tuần, một dòng reset) và **đầy đủ** (thêm ước tính, credits, nút). Mọi nơi dưới đây dùng lại component đó, không tự vẽ thanh quota riêng.

### 5.1 Hiện trạng

**Agents** (`Agents.tsx:160-280`) xếp dọc trong `max-w-[1100px]`: PageHeader với nút Thêm gói (nút này chỉ cuộn xuống, `:157`) → `ConfigIssues` → `MachineQuota` (một dòng chữ, `:1522`) → `IntakeCard` (số run song song, `:1382`) → `ProfileTable` 6 cột, `min-w-[900px]` (`:399`, `:485`) → `TokenStats` 7 cột (`:508`) → **Quản lý gói** gồm cập nhật quota, mô tả, **8 nút "+ tài khoản"**, **N nút "+ loại agent"**, mẫu của hub, form (`:192-276`) → `WorktreeManager` → `RunnerCard`. `ProfileRow` dài khoảng 410 dòng (`:620-1033`).

**Bản đồ agent** (`Machines.tsx:49-107`): mỗi máy một cột `md:w-[300px]` cuộn ngang (`AgentMap.tsx:78`, `:143`). Trong cột có từng thẻ gói (tên, chip, `id · kind · account`, 2 thanh, dòng reset, run đang chạy, `:219-314`), `AssignedQueue`, hàng đợi, **Tool**, **Worktree**, "Bật/tắt và ưu tiên gói", Gỡ máy (`:182-212`). Cột "Đợt chạy" ở cuối (`:95`). Dưới bản đồ là **Quota đang nghỉ** (bảng cooldown, `:72-96`) và **Chi phí ước tính** gồm 2 bảng cộng bảng RTK (`:98-105`, `:122-263`).

**Quota** (`Quota.tsx:28-58`): 3 bộ lọc, các thẻ tổng viết bằng 4 câu văn mỗi thẻ (`:39-46`), bảng 7 cột.

### 5.2 Vấn đề

1. **Quota xuất hiện ở năm chỗ với năm cách vẽ.** `Meter` của Agents (`Agents.tsx:1472`), `Quota` của AgentMap (`AgentMap.tsx:316`, ngưỡng cảnh báo cố định 80% ở `:320`), bảng Quota (`Quota.tsx:51`, dạng chữ "Phiên: 40%"), `Bar` "Quota cao nhất" ở Tổng quan vận hành (`admin/Ops.tsx:68`, `:269-293`), và thẻ status trong Chat. Ngưỡng và màu không thống nhất, nên người đọc không biết tin chỗ nào.
2. **Bảng Quota gần như toàn chữ "Chưa có số liệu".** Ảnh `05-quota-outlook`: mỗi hàng lặp "Chưa có số liệu" 6–8 lần, cột "Đã dùng" bị bẻ 6 dòng, mỗi hàng cao khoảng 170px. Thẻ tổng là 4 câu văn ngang hàng nhau. Câu quan trọng nhất ("Có thể giao thêm 4 agent ngay") chỉ được in đậm nhẹ.
3. **Cột máy chất đủ thứ, việc quản trị nằm cạnh trạng thái.** Ảnh `10-agent-map-codex`: cột thứ 4 bị cắt, phải cuộn ngang mới thấy. Trong mỗi cột, "Tool", nút "Worktree" rộng hết cột và "Bật/tắt và ưu tiên gói" chiếm độ đậm ngang với gói đang chạy. Tên gói lặp hai lần ("claude-1" rồi "claude-1 · claude"). Máy "overview" không có gói vẫn chiếm một cột đầy đủ. Bên dưới, **Chi phí** (lặp lại tab Chi phí của admin) và **Quota đang nghỉ** (rỗng vẫn chiếm một khối lớn) dồn vào cùng tab.
4. Agents (desktop): khu **Quản lý gói** đặt khoảng 16 nút cùng cỡ ngay trên trang, nút "Thêm gói" ở header chỉ để cuộn xuống. Bảng gói `min-w-[900px]` trên app hẹp phải cuộn ngang. Phần "Cập nhật quota" nằm dưới bảng, tách khỏi các thanh quota mà nó làm mới.

### 5.3 Bố cục đề xuất

**Bản đồ agent (web)**, thứ tự:

1. `SummaryStrip`: **Gói sẵn sàng 3/7 · Đang chạy 2 · Hàng đợi 1 · Cần xử lý 2** (chưa đăng nhập, hết quota, máy offline). Số "Cần xử lý" lọc bản đồ về những gói có vấn đề.
2. **Cần xử lý** (chỉ hiện khi có): danh sách ngắn, mỗi dòng có nút ngay cạnh, ví dụ `codex-1 @ lan-mbp · Chưa đăng nhập · [Mở đăng nhập]`, `codex-2 · 98% phiên · reset 16:00`. Đây là chỗ duy nhất trên trang dùng màu cảnh báo.
3. **Lưới máy** thay cho cột cuộn ngang: `grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))]`, xuống dòng chứ không cuộn. Đầu thẻ máy: chấm trạng thái, tên, phiên bản, "Nhận run". Thân là thẻ gói **dạng gọn**. Tool, Worktree, Ưu tiên gói, Gỡ máy gộp vào **một nút menu "⋯ Quản lý máy"** (mở sheet), chỉ hiện khi `mayManage`. Máy không có gói hiện thành một dòng mỏng "overview · chưa báo gói".
4. **Đợt chạy đang mở** chuyển thành dòng tóm tắt "2 đợt chạy đang mở ›" dẫn tới `#/runs?tab=batches`, không còn là một cột.
5. **Bỏ khỏi tab Bản đồ:** *Chi phí ước tính* (đã có tab Chi phí cho admin; người không phải admin xem ở tab Quota hoặc trang Token) và *Quota đang nghỉ* (cooldown thành dòng "Cần xử lý", bảng đầy đủ chuyển sang tab Quota).

**Quota (web):** dải tóm tắt viết bằng số thay cho câu văn: `Giao thêm ngay 4 · Chỗ trống 4 · Phiên đầy còn ~9 · Hạn mức sớm nhất 04:46`. Bảng gộp còn 5 cột: Gói/tài khoản · Máy · Phiên/Tuần (2 thanh dạng gọn, thay 2 cột chữ) · Reset & ước tính · Trạng thái. Ô không có dữ liệu chỉ hiện **một** "—" có tooltip "Chưa đọc quota lúc …". Một hàng thiếu toàn bộ số liệu thì gộp thành một dòng "Chưa đọc quota · [Đọc ngay]". Bảng cooldown ("Đang nghỉ") đặt ở cuối tab.

**Agents (desktop):** 1) dải tóm tắt của máy này (gói sẵn sàng, đang chạy, tổng quota sớm hết, nút **Đọc quota** đặt ngay trong dải) → 2) Cần xử lý → 3) danh sách gói bằng thẻ dạng gọn, bấm vào mở dạng đầy đủ (thay bảng 900px) → 4) "Gói tắt (N)" thu gọn (đã có) → 5) **Token theo gói** thu gọn mặc định → 6) **Thêm gói**: nút header mở sheet chọn loại tài khoản hoặc agent hoặc mẫu, gom 16 nút vào một menu phân nhóm → 7) Song song, Worktree, Runner nâng cao gộp vào một `details` tên "Cài đặt máy".

Điện thoại: một cột. Dải tóm tắt 2×2 → Cần xử lý → thẻ máy (thẻ gói gọn xếp dọc). Không cuộn ngang. Sheet quản lý máy mở toàn màn.

```
Bản đồ agent · desktop
┌ Gói sẵn sàng 3/7 │ Đang chạy 2 │ Hàng đợi 1 │ ⚠ Cần xử lý 2 ┐
├ Cần xử lý ─────────────────────────────────────────────────┤
│ ⚠ codex-1 @lan-mbp  Chưa đăng nhập          [Mở đăng nhập] │
│ ⚠ codex-2 @lan-mini 98% phiên · reset 16:00   [Xem quota]  │
├────────────────────────────────────────────────────────────┤
│ ● lan-mbp v0.120 ⋯ │ ● lan-mini v0.120 ⋯ │ ● quota-one  ⋯ │
│ claude-1 Sẵn sàng  │ claude-2 Sẵn sàng   │ Quota Codex     │
│ ▬▬▬▬░░ 42% ▬░ 18%  │ codex-2 Gần hết     │ ▬▬▬░ ▬░         │
│ codex-1 Chưa đ.nhập│ ▬▬▬▬▬▬ 98% ▬▬▬▬ 81% │                 │
│ Hàng đợi 1: PAY-49E│                     │                 │
├────────────────────────────────────────────────────────────┤
│ ○ overview · chưa báo gói     2 đợt chạy đang mở ›         │
└────────────────────────────────────────────────────────────┘
```

### 5.4 Thành phần, trạng thái, a11y

- **Dùng lại:** thẻ gói của UX-quota-card-design (một component, hai dạng), `Chip`, `PageTabs`, `ResponsiveTable`, `Notice`, `Sheet` (`components/ui/sheet.tsx`), `Empty`. Hàm thuần `machineCards`, `quotaRows`, `quotaTotals`, `machineQuota` giữ nguyên. Ngưỡng màu lấy từ `limit.tone` của core, bỏ ngưỡng 80% cố định trong `AgentMap.tsx:320` và `Ops.tsx:68`.
- **Loading:** skeleton thẻ máy (3 ô). Poll 5 giây không được làm nháy layout. **Rỗng:** "Chưa có máy nào báo về hub" kèm link hướng dẫn cài app (đã có `machines.none`). Có máy nhưng ngoài scope thì giữ `agentMap.noneInScope`. **Lỗi:** `ErrorNote` đầu trang, giữ dữ liệu cũ, ghi "cập nhật lúc …".
- **a11y:** thanh quota giữ `role="meter"` cùng `aria-valuenow` (như `Meter`), có số phần trăm bằng chữ bên cạnh. Chip trạng thái luôn có chữ. Thẻ gói chọn được (`role=checkbox`, `AgentMap.tsx:257`) phải có focus ring và target 44px trên điện thoại. Menu "⋯ Quản lý máy" cần `aria-label` gồm tên máy.

## 6. Agent đang chạy (`packages/ui/src/pages/Runs.tsx`)

**Câu hỏi:** *"Run nào đang chạy hoặc kẹt, run này đã làm gì?"*

### 6.1 Hiện trạng

Master-detail. Phần đầu `ListPane` (`Runs.tsx:199-229`) gồm: `ServiceFilter`, **Hàng chờ merge** (`MergeQueue`, cao tối đa `40dvh`, `:203`), 6 chip lọc (Cần theo dõi, Tất cả, Đang chạy, Chờ người, Lỗi, Xong), **3 select** (đợt chạy, task, máy, `:205-209`), chip lọc gói. Danh sách chia nhóm Máy này / Máy khác / Gần đây (`:230-232`). Chi tiết có `Head` (chip, tiêu đề, id, nút, `:317-351`), Artifact, tab Tóm tắt/Thay đổi, Log, Thay đổi/MR.

### 6.2 Vấn đề

1. **Phần đầu danh sách cao hơn danh sách.** Ảnh `06-runs-review-detail`: Hàng chờ merge (kể cả khi đóng), 6 chip trên 2 dòng và 3 select chiếm khoảng 470px của cột trái. Run đầu tiên bắt đầu ở y≈500. Trên điện thoại, các select cao `h-11` xếp chồng nên danh sách còn bị đẩy xuống thấp hơn.
2. **Bộ lọc ít dùng ngang hàng bộ lọc chính.** "Mọi đợt chạy / Mọi task / Mọi máy" luôn hiện dù đa số lần chỉ cần "Cần theo dõi". MergeQueue là một việc khác (merge) nhưng nằm trong cột lọc run.
3. **Chi tiết chưa ưu tiên trạng thái.** "Artifact (0) · Không có tệp phù hợp" đứng trên Tóm tắt. Log và Thay đổi/MR vẽ thêm lần nữa dưới tab Tóm tắt (`:630-640`), nên nội dung trùng và trang dài.

### 6.3 Bố cục đề xuất

Cột trái: 1) `ServiceFilter` → 2) chip lọc (giữ 6 chip, có số; trên điện thoại cuộn ngang *trong* hàng chip) → 3) nút **"Lọc thêm (N)"** mở popover/sheet chứa 3 select và chip gói, N là số bộ lọc đang bật → 4) danh sách. **Hàng chờ merge** chuyển thành một dòng có số ("Hàng chờ merge · 2 ›") ở đầu danh sách. Bấm vào mở sheet, hoặc chuyển hẳn sang Quy trình nếu hợp hơn (quyết khi build).

Chi tiết: Head (giữ) → **Kết quả/đang làm gì** (Tóm tắt) → Các bước → tab Log | Thay đổi. Artifact rỗng thì **không vẽ**, có tệp thì hiện thành một hàng chip trong Tóm tắt. Bỏ phần Log/Thay đổi lặp dưới tab.

Điện thoại: danh sách → chi tiết toàn màn (đã có). Nút trong `Head` wrap xuống dưới tiêu đề.

```
┌ [Tất cả service ▾]            ┐┌ Xong · Chờ người  [Mở MR !49][Chuỗi vai] ┐
│ Cần theo dõi 1 │ Tất cả 1 │ … ││ Việc đầu tiên của payment                │
│ [Lọc thêm (0)]                ││ R-e2ereview · payment · PAY-1 · lan-mbp  │
│ Hàng chờ merge · 2          › ││ Kết quả: Đã làm / Chưa làm / Kiểm / Rủi ro│
│ Gần đây                       ││ ✓Đọc ─ ✓Code ─ ✓Test ─ ✓MR               │
│ ✓ Việc đầu tiên… Chờ người    ││ [Log] [Thay đổi · 1]                     │
└───────────────────────────────┘└──────────────────────────────────────────┘
```

### 6.4 Thành phần, trạng thái, a11y

- **Dùng lại:** `ListPane`, `FilterChips`, `NativeSelect` (trong popover `components/ui/popover.tsx`, điện thoại dùng `Sheet`), `Chip`, `DetailHeader`. `TabBar` đã có roving focus (`:353-388`).
- **Loading:** skeleton 5 dòng. **Rỗng:** giữ `runs.none` / `runs.noneFilter`, thêm nút "Bỏ lọc" khi đang lọc. **Lỗi:** `ErrorNote` trên danh sách.
- **a11y:** nút "Lọc thêm" có `aria-expanded` và số bộ lọc trong nhãn. `data-run-state role=status` giữ nguyên (đã có, `:330`).

## 7. Quản trị hub (`admin/Ops.tsx`, `admin/HubOps.tsx`, `admin/Versions.tsx`)

**Câu hỏi:** *"Hub có khoẻ không, có gì tôi phải làm?"*

### 7.1 Hiện trạng

- **10 tab** cùng một hàng (`Sections.tsx:119-143`, ảnh `07-hub-page`): Tổng quan vận hành, Người dùng & quyền, Chính sách, Tool, Ngân sách, Cảnh báo, Nhật ký, Thông báo & webhook, Phiên bản app, Hub.
- **Tổng quan vận hành** (`Ops.tsx:114-326`): StopAgentsBar → **6 KPI ngang hàng** (`:169-187`) → thẻ **Deploy log** (lỗi, cảnh báo, backup, SeaweedFS, search, top lỗi; `:188-205`) → lưới 6 thẻ: Run theo giờ, Cảnh báo mở, Đang chạy, Sự kiện, Quota cao nhất, Đội máy (`:206-324`).
- **Hub** (`HubOps.tsx:61-185`): **7 `HubCard` cùng kích thước**: Phiên bản, Database, Tệp, Backup (có nút Backup ngay), Tìm theo nghĩa, SSO, Host.
- **Phiên bản app** (`Versions.tsx:49-190`): thẻ rollout, phân bố phiên bản, lưới các bản phát hành.

### 7.2 Vấn đề

1. **Thẻ "Ổn" và thẻ "Quá hạn" cùng cỡ, cùng chỗ.** Ảnh `07-hub-page`: Backup "Quá hạn · chưa có bản nào" nằm ở hàng 2, to bằng "Phiên bản · Ổn" và "Database · Ổn" (hai thẻ này luôn `tone="ok"`, `HubOps.tsx:92-107`). Đường dẫn tuyệt đối dài (`/var/folders/...`) chiếm phần lớn diện tích thẻ. Mắt không biết nhìn đâu trước.
2. **Thông tin hub bị vẽ hai lần.** Deploy log ở Tổng quan lặp lại trạng thái backup, SeaweedFS, search của tab Hub (`Ops.tsx:190-194` so với `HubOps.tsx:109-155`). "Quota cao nhất" lặp tab Quota. "Đang chạy" lặp Runs. Bảng chi phí ở `Machines.tsx:98` lặp tab Chi phí. Phiên bản hub ở tab Hub tách khỏi Phiên bản app.
3. **Mười tab ngang hàng, việc phải làm nằm rải rác.** Cảnh báo mở, backup trễ, rollout tạm dừng, máy thiếu tool mỗi thứ ở một tab. 6 KPI cùng cỡ (`grid auto-fit minmax(170px)`), chỉ "Chờ duyệt" có `warn`. Trên điện thoại hàng tab phải cuộn ngang, nên tab Hub và Phiên bản nằm ngoài màn hình.

### 7.3 Bố cục đề xuất

**Tổng quan vận hành** (giữ là tab mặc định):

1. Hàng đầu: bộ chọn 24h/7d/30d cùng StopAgentsBar (giữ).
2. **Cần chú ý** (chỉ hiện khi có): một danh sách gộp từ cảnh báo mở, backup trễ hoặc tắt, files/search lỗi, deploy log có lỗi, máy offline hoặc thiếu tool, rollout tạm dừng. Mỗi dòng gồm mức (Carbon: chọn mức nặng nhất), một câu, **nút ngay trên dòng** (Backup ngay, Mở cảnh báo, Xem máy). Không có gì thì hiện một dòng "Hub ổn · kiểm lúc 23:46".
3. `SummaryStrip` **4 số**: Đang chạy · Hàng đợi · Tỉ lệ thành công (khoảng) · Máy online. Chi phí và Chờ duyệt bỏ khỏi dải: chi phí có ở tab Chi phí, chờ duyệt đã đếm ở Hôm nay.
4. **Run theo giờ** (thẻ rộng) cùng **Sự kiện** (cột hẹp).
5. Thu gọn mặc định: Đang chạy (link Runs), Quota cao nhất (link tab Quota), Đội máy.

**Hub** (đổi tên thành "Hub & phiên bản", gộp tab Phiên bản app):

1. **Đầu trang:** `hub 0.145.2 · e2e · chạy 3 ngày` cùng trạng thái rollout app ("Đang phát 0.120.0 · 60% máy · [Tạm dừng]"), theo kiểu Vercel đặt production lên trước.
2. **Danh sách sức khoẻ** một dòng mỗi mục (Database, Tệp, Backup, Tìm theo nghĩa, SSO, Host): chip trạng thái · giá trị ngắn · nút nếu có. Mục lỗi hoặc trễ **lên đầu danh sách**. Đường dẫn, biến môi trường, gợi ý cấu hình chỉ hiện khi bấm mở dòng (`details`).
3. **Phiên bản app:** phân bố cùng danh sách bản phát hành (lưới hiện có), đặt dưới.

**Tab:** nhóm 10 tab thành 4 nhóm trong `PageTabs`: *Vận hành* (Tổng quan, Cảnh báo, Nhật ký), *Người & quyền* (Người dùng, Chính sách, Tool), *Chi tiêu* (Ngân sách, Webhook), *Hệ thống* (Hub & phiên bản). Trên điện thoại hiện thành một `select` hoặc danh sách nhóm. Giữ URL `?tab=` cũ (`pickTab`) để link không gãy.

```
Hub & phiên bản · desktop                         Điện thoại
┌ hub 0.145.2 · e2e · chạy 3 ngày               ┐ ┌──────────────────┐
│ App: đang phát 0.120.0 · 60% máy  [Tạm dừng]  │ │ hub 0.145.2      │
├ Sức khoẻ ─────────────────────────────────────┤ │ App 0.120.0 60%  │
│ ⚠ Backup   Quá hạn · chưa có bản  [Backup ngay]│ │ ⚠ Backup Quá hạn │
│ ○ Tìm theo nghĩa  Chỉ theo từ               › │ │   [Backup ngay]  │
│ ○ SSO      Chỉ mật khẩu                     › │ │ ✓ Database 3 MB ›│
│ ✓ Database hub.db · 3.0 MB                  › │ │ ○ SSO tắt      › │
│ ✓ Tệp      SQLite · 0 tệp                   › │ │ …                │
│ ○ Host     localhost, 127.0.0.1             › │ │ Bản phát hành ›  │
├ Bản phát hành ────────────────────────────────┤ └──────────────────┘
│ 0.120.0 [Phát] · 0.119.2 · …                  │
└───────────────────────────────────────────────┘
```

### 7.4 Thành phần, trạng thái, a11y

- **Dùng lại:** `Kpi`, `Card`, `Bar` của `Ops.tsx` (chuyển `Kpi` thành `SummaryStrip` dùng chung), `OpenAlerts`, `EventFeed` (`admin/Alerts.tsx:65`, `:112`), `PageTabs`, `KvRows` cho phần mở rộng của dòng sức khoẻ, `Button`. Logic `backupLate` và tone (`HubOps.tsx:73`) chuyển thành hàm thuần dùng chung cho Tổng quan và Hub, có unit test.
- **Loading:** skeleton dòng. `hub.info` chậm thì vẫn giữ giá trị cuối kèm "cập nhật lúc". **Rỗng:** "Hub ổn". **Lỗi:** dòng "Không đọc được tình trạng hub" ở mức cảnh báo, không đổi thành "Ổn" hay 0.
- **a11y:** dòng sức khoẻ là `button aria-expanded`. Chip mức có icon cộng chữ. Hàng tab nhóm phải dùng được bằng bàn phím (`PageTabs` đã có). Target 44px trên điện thoại.

## 8. Phần dùng chung giữa các trang

1. **`SummaryStrip`** (mới, `packages/ui/src/components/SummaryStrip.tsx`): 2–4 ô gồm nhãn, số, dòng phụ; mỗi ô là link lọc. Thuộc tính `tone` chỉ dùng cho ô bất thường. Desktop xếp một hàng, điện thoại 2×2. Gốc là `Kpi` (`Ops.tsx:50`). Dùng ở Hôm nay (khi trống), Bản đồ agent, Quota, Agents, Tổng quan vận hành.
2. **`AttentionList`** (mới): danh sách "Cần xử lý / Cần chú ý", mỗi dòng gồm mức, câu, nút. Dùng ở Bản đồ agent, Agents, Tổng quan vận hành, Hub. Nguồn cảnh báo vẫn là inbox, alerts, `hub.info`. Component chỉ vẽ.
3. **Một nơi cho cảnh báo:** Hôm nay là hộp nhận cuối cùng (inbox đã gom `alert`, `machine`, `releaseFailure`). Trang khác dùng `AttentionList` cho việc *trong phạm vi trang đó*, kèm link "Tất cả ở Hôm nay". Không thêm banner toàn cục mới.
4. **Header trang:** giữ `PageHeader` (tiêu đề cộng một câu phụ). Đoạn mô tả dài ("Mỗi máy một cột…", `machines.subtitle`) rút còn một câu hoặc chuyển vào nút "?".
5. **Mật độ:** desktop dùng `--row-h` 40px. Bảng dài (Quota, Đội máy) cho phép `data-density="compact"` (token có sẵn ở `spacing.css:12`). Điện thoại không dùng compact.
6. **Thứ tự cố định trên mọi trang:** Cần chú ý → Tóm tắt → Nội dung chính → Thu gọn (cấu hình, lịch sử, chi phí).

## 9. Backlog build

Mọi task: `kind: ui`. Chữ mới thêm vào `vi.ts` trước rồi `en.ts`. Chạy `npm run typecheck`, `npm test`. Xong mỗi mục thì tăng version theo AGENTS.md. "Ảnh" nghĩa là ảnh desktop 1440 cộng điện thoại 390×844, sáng và tối, đính vào note.

| ID | Việc | dependsOn | size | risk | Tiêu chí xong |
| --- | --- | --- | --- | --- | --- |
| UX-dash-shared | `SummaryStrip`, `AttentionList` trong `packages/ui/src/components`, có test render. Gộp `Chip`/`Header`/`Footer`/`Kv` của Today về `panes.tsx` | UX-quota-card-design (chỉ phần token tone quota) | s | thấp: component mới, chưa trang nào dùng | Unit test vitest. `a11y-components` không có lỗi mới |
| UX-dash-today | §4: bỏ `SystemOverview` khỏi Hôm nay, gộp dải nhắc, nút ngay dưới nội dung, ẩn gợi ý phím trên điện thoại, SummaryStrip khi trống | UX-dash-shared | s | vừa: step `overview-by-system` kiểm `[data-system-card]` trên cả `overview` lẫn `today` (`apps/web/e2e/browser.mjs:3075`), phải bỏ `today` khỏi vòng lặp; `today-web` chụp nhóm inbox | `today-web` cộng `overview-by-system` qua cả `e2e` lẫn `e2e:mobile`. Ảnh: inbox đầu tiên nằm trong khung nhìn đầu tiên ở 390×844 với 2 hệ thống |
| UX-dash-agents | §5 web: Bản đồ agent thành lưới, AttentionList, menu "⋯ Quản lý máy", bỏ Chi phí và Cooldown khỏi tab Bản đồ. Tab Quota: dải số, bảng 5 cột, gộp "Chưa có số liệu" | UX-quota-card-design, UX-dash-shared | m | vừa: selector `data-map-*`, `data-quota-*` dùng trong `agent-map`, `quota-outlook`, `machine-profiles`; cooldown clear chuyển chỗ | `agent-map`, `machine-profiles`, `quota-outlook` qua cả desktop lẫn mobile. Ảnh: không cuộn ngang ở 1440 với 4 máy, mỗi hàng Quota thấp hơn hoặc bằng 72px khi thiếu số liệu |
| UX-dash-agents-desktop | §5 desktop: Agents dùng thẻ gói thay bảng 900px, sheet Thêm gói, "Cài đặt máy" thu gọn, nút Đọc quota trong dải | UX-dash-agents | m | vừa: `ProfileRow` khoảng 410 dòng, nhiều selector `data-add-account`, `data-read-usage-all` trong smoke | `npm run build -w @xdev-hive/desktop` và `npm run smoke -w @xdev-hive/desktop -- <dir>` có ảnh trang Agents, rộng 1100 và 800 |
| UX-dash-machines | §6: Runs gom "Lọc thêm", Hàng chờ merge thành một dòng, bỏ Artifact rỗng, bỏ Log/Thay đổi lặp | UX-dash-shared | s | thấp-vừa: `merge-queue`, `runs-review`, `run-steer`, `a11y-run-status` click vào select và khối merge | `runs-review`, `merge-queue`, `a11y-run-status` qua desktop và mobile. Ảnh: run đầu tiên ở y nhỏ hơn hoặc bằng 260px (desktop) |
| UX-dash-hub | §7: Tổng quan vận hành có "Cần chú ý" và dải 4 số; tab Hub & phiên bản gồm danh sách sức khoẻ cộng rollout; nhóm tab admin, giữ `?tab=` cũ | UX-dash-shared | m | vừa: `hub-page`, `budget`, `audit-agent`, `stop-all` mở tab theo tên; link `admin?tab=versions` phải tự chuyển | `hub-page`, `stop-all`, `budget` qua desktop và mobile. Ảnh: backup trễ nằm ở dòng đầu "Cần chú ý", tab Hub tới được trên 390px mà không cuộn ngang |
| UX-dash-alerts | §8.3: rà nguồn cảnh báo, mọi thứ hiện ở AttentionList cũng có mục tương ứng trong inbox Hôm nay (backup trễ, rollout dừng nếu chưa có) | UX-dash-hub, UX-dash-today | s | vừa: thêm kind inbox cần sửa `lib/inbox.ts` và test | Unit test `inbox` mới. Step e2e: backup trễ hiện ở Hôm nay của admin |

Thứ tự gợi ý: shared → today và machines (song song) → hub → agents (sau khi UX-quota-card-design xong) → agents-desktop → alerts.

## 10. Rủi ro và chưa kiểm

- Chưa chụp trang Agents của app desktop (cần smoke desktop). Nhận định ở §5.2 mục 4 chỉ dựa vào code.
- UX-quota-card-design đang `blocked` (lỗi gán máy R-203966). Nếu thẻ gói thay đổi API, UX-dash-agents phải chờ.
- Bỏ `SystemOverview` khỏi Hôm nay làm người dùng mất lối nhanh sang số liệu hệ thống. Có link "3 hệ thống ›" thay thế, cần người quản trị xác nhận.
- Gộp tab admin đổi vị trí quen thuộc. Phải giữ redirect `?tab=`.
- Số đo vị trí (y≈…) lấy từ ảnh e2e với dữ liệu seed, dữ liệu thật có thể dài hơn.
