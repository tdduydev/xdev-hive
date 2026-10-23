# Feature Specification: Plugin Claude Code trong Hive

**Feature Branch**: `030-claude-plugins`

**Created**: 2026-10-23

**Status**: Draft

**Input**: User description: "Hỗ trợ plugin Claude Code trong Hive (ví dụ đầu tiên: plugin code-modernization từ marketplace
anthropics/claude-plugins-official, Apache-2.0, gồm commands, agents, hooks, scripts, workflows). Quản trị org chọn plugin từ
danh sách marketplace được phép, ghim theo commit; dự án bật/tắt trong phạm vi org cho phép (theo mô hình policy org giới hạn
dự án như skill pack và MCP). Worker cài đúng plugin đã ghim vào môi trường chạy claude của run (không đụng cấu hình người dùng
trên máy), chỉ cho CLI claude. Hub chỉ điều phối, không chạy agent. Cần: nguồn plugin tin cậy (allowlist marketplace), xác minh
nội dung theo commit/hash, hiện giấy phép, ghi audit, hook của plugin phải tuân theo managedHooksOnly của policy, chạy được trên
Windows/macOS/Linux, desktop có thể cài plugin cho phiên tương tác."

## Vì sao làm

Claude Code có plugin: một gói gồm lệnh (`commands`), agent con (`agents`), hook, script và quy trình mà CLI nạp khi chạy.
Marketplace chính thức của Anthropic đã có plugin hữu ích cho việc của Hive, ví dụ `code-modernization` (nâng cấp code cũ,
Apache-2.0). Hiện Hive chưa có đường nào để tổ chức đưa plugin vào run một cách **có kiểm soát**:

- Cài tay trên từng máy thì mỗi máy một phiên bản, không ai biết agent đang chạy mã nào, và mã đó chạy với quyền của run.
- Plugin có hook và script, tức là **mã chạy trên máy của khách**. Tải thẳng từ nhánh đang đổi của một repo là rủi ro chuỗi
  cung ứng; chính sách `managedHooksOnly` của tổ chức có thể bị vòng qua.
- Cài vào cấu hình Claude Code của người dùng sẽ làm đổi cách họ làm việc ngoài Hive.

Tính năng này cho tổ chức một vòng khép kín: **chọn nguồn tin cậy, ghim đúng commit, kiểm nội dung, bật theo dự án trong
trần org cho phép, cài riêng cho từng run, ghi audit**. Mô hình phân quyền dùng lại mô hình org giới hạn dự án đã có của
gói kỹ năng (skill pack) và MCP (spec 003), không phát minh mô hình mới.

## Hiện trạng

Đã kiểm trong code `main` ngày 2026-10-23:

| Phần | Có gì | Spec này |
|---|---|---|
| Gói kỹ năng mặc định | Bật/tắt theo tổ chức và dự án; dự án ghi đè tổ chức (`apps/hub/src/modules/knowledge/skill-pack.ts`) | Dùng mô hình, đổi quy tắc thành "org là trần" |
| Quy tắc MCP ngoài | Allow/deny theo org và dự án, deny thắng, ghi vào managed settings của CLI (spec 003) | Dùng lại cách ghi vào cấu hình run |
| Hook bắt buộc của tổ chức | `hooks` và `managedHooksOnly` trong Chính sách agent, hub gửi kèm `job_offer`, worker bỏ hook và cấu hình trong repo (spec 002, `worker/internal/runner/hooks.go`) | Hook plugin phải tuân theo |
| Cấu hình riêng cho mỗi run | Worker dựng `--settings` cho từng lần chạy `claude` | Dùng chỗ này để nạp plugin |
| Nhật ký audit | `recordAudit()` cho thao tác quản trị | Ghi mọi thao tác plugin |
| Plugin Claude Code | **Chưa có** | Làm mới |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Quản trị org duyệt và ghim plugin (Priority: P1)

Quản trị tổ chức vào trang Chính sách, mục "Plugin Claude Code". Họ thấy danh sách marketplace được phép (mặc định chỉ có
`anthropics/claude-plugins-official`), chọn plugin `code-modernization`, thấy giấy phép Apache-2.0, danh sách thành phần
(bao nhiêu command, agent, hook, script) và chọn bản để ghim. Hive ghim vào một commit cụ thể và ghi hash nội dung. Từ lúc
đó plugin ở trạng thái "được phép" cho cả tổ chức.

**Why this priority**: không có bước duyệt này thì mọi phần sau đều không an toàn; đây là lõi của quản trị.

**Independent Test**: với marketplace trong allowlist, quản trị duyệt một plugin. Danh mục tổ chức có đúng một mục với
commit, hash, giấy phép; nhật ký audit có một dòng "duyệt plugin".

**Acceptance Scenarios**:

1. **Given** marketplace chính thức đã trong allowlist, **When** quản trị mở danh sách plugin, **Then** thấy tên, mô tả, giấy
   phép, nguồn và số lượng từng loại thành phần của mỗi plugin.
2. **Given** quản trị chọn một plugin, **When** duyệt, **Then** plugin được ghim vào một commit đầy đủ (không phải tên nhánh
   hay tag di động) cùng hash nội dung; danh mục tổ chức ghi lại hai giá trị này.
3. **Given** plugin có hook hoặc script, **When** quản trị duyệt, **Then** màn duyệt nêu rõ plugin chứa mã chạy trên máy và
   liệt kê từng hook với sự kiện và lệnh của nó; quản trị phải xác nhận trước khi ghim.
4. **Given** plugin không có thông tin giấy phép hoặc giấy phép nằm ngoài danh sách cho phép của tổ chức, **When** quản trị
   duyệt, **Then** màn duyệt cảnh báo rõ và chặn duyệt cho tới khi quản trị xác nhận có chủ ý.
5. **Given** người không phải quản trị tổ chức, **Then** không thấy hay không gọi được thao tác duyệt, ghim, gỡ.

---

### User Story 2 - Dự án bật plugin trong trần org cho phép (Priority: P1)

Chủ dự án vào cấu hình dự án, thấy các plugin tổ chức đã duyệt, bật `code-modernization` cho dự án. Dự án chỉ chọn được trong
số plugin org đã duyệt; plugin org chưa duyệt hoặc đã gỡ thì không bật được. Run kế tiếp của dự án dùng plugin đó.

**Why this priority**: tạo giá trị thực cho từng dự án và là nơi mô hình "org giới hạn dự án" thể hiện.

**Independent Test**: org duyệt hai plugin, dự án A bật một. Run của A thấy một plugin; run của dự án B (không bật) không
thấy plugin nào.

**Acceptance Scenarios**:

1. **Given** org đã duyệt plugin P, **When** chủ dự án bật P, **Then** P hiện "đang bật" ở dự án và run mới của dự án dùng P.
2. **Given** org chưa duyệt plugin Q, **Then** Q không có trong danh sách bật của dự án.
3. **Given** org gỡ duyệt P khi dự án đang bật, **Then** P tự thôi áp dụng cho run mới của dự án, dự án hiện "org đã gỡ
   duyệt" và không thể bật lại tới khi org duyệt lại.
4. **Given** org đổi ghim P sang commit mới, **Then** dự án dùng commit mới từ run kế tiếp, run đang chạy giữ commit cũ.
5. **Given** dự án chỉ có quyền bật hoặc tắt, **Then** dự án không đổi được commit ghim, nguồn hay hook của plugin.

---

### User Story 3 - Run chạy với đúng plugin đã ghim, không đụng cấu hình máy (Priority: P1)

Một run của dự án có bật `code-modernization` được giao cho máy Windows chạy `claude`. Worker lấy đúng plugin đã ghim, kiểm
hash, nạp vào môi trường riêng của run. Trong run, agent dùng được lệnh và agent con của plugin. Run xong, môi trường riêng
bị dọn; cấu hình Claude Code của người dùng trên máy không đổi một byte.

**Why this priority**: đây là chỗ giá trị đến tay agent, và là chỗ rủi ro an toàn lớn nhất.

**Independent Test**: chạy một run có plugin trên máy có sẵn cấu hình Claude Code cá nhân. Trong run, lệnh của plugin có
mặt; sau run, thư mục cấu hình cá nhân giống hệt trước (so hash), và không còn tệp plugin tạm của run.

**Acceptance Scenarios**:

1. **Given** run có plugin P ghim commit C, **When** worker chuẩn bị run, **Then** worker dùng đúng nội dung của C, kiểm hash
   khớp hash đã ghim, rồi mới nạp.
2. **Given** hash không khớp, **Then** run không nạp plugin đó, run dừng với lý do "plugin sai hash" (không âm thầm chạy
   không có plugin) và sự kiện được ghi.
3. **Given** máy chạy run đã có plugin hay cấu hình Claude Code cá nhân, **When** run chạy xong, **Then** cấu hình cá nhân
   không đổi và plugin của run không rò sang phiên Claude Code khác của người dùng.
4. **Given** run dùng CLI không phải `claude` (codex, gemini, ...), **Then** plugin không được nạp, run vẫn chạy bình
   thường và chi tiết run ghi "plugin chỉ hỗ trợ claude".
5. **Given** máy không tải được nội dung plugin (mạng, kho riêng), **Then** worker dùng bộ nhớ đệm đúng hash nếu có; nếu
   không, run dừng với lý do rõ như tình huống hash sai.
6. **Given** hub, **Then** hub chỉ gửi danh sách plugin, commit, hash cho worker; hub không tải nội dung plugin để chạy và
   không chạy agent.

---

### User Story 4 - Hook của plugin tuân theo managedHooksOnly (Priority: P1)

Tổ chức bật "Chỉ chạy hook của tổ chức". Plugin `code-modernization` có hook. Khi run chạy, hook của plugin **không chạy**;
command, agent, script gọi tay của plugin vẫn dùng được. Chi tiết run nói rõ hook nào của plugin bị chặn vì chính sách. Khi
tổ chức tắt `managedHooksOnly`, hook của plugin đã duyệt chạy.

**Why this priority**: nếu hook plugin vòng qua chính sách thì cả mô hình quản trị mất ý nghĩa.

**Independent Test**: plugin thử có một hook ghi tệp đánh dấu. Bật `managedHooksOnly`: run xong, không có tệp. Tắt: có tệp.
Cả hai lần hook của tổ chức vẫn chạy.

**Acceptance Scenarios**:

1. **Given** `managedHooksOnly` bật, **When** run chạy, **Then** không hook nào của plugin chạy; hook của tổ chức vẫn chạy.
2. **Given** `managedHooksOnly` tắt và plugin đã duyệt, **Then** hook plugin chạy, cùng với hook của tổ chức.
3. **Given** plugin khai báo hook ở nhiều chỗ (tệp hook, trong command, trong agent), **Then** mọi đường khai báo hook đều
   bị chặn như nhau khi `managedHooksOnly` bật.
4. **Given** hook plugin bị chặn, **Then** chi tiết run liệt kê tên plugin, sự kiện hook, và "chặn bởi chính sách".
5. **Given** chính sách đổi trong lúc run đang chạy, **Then** run đang chạy giữ chính sách lúc bắt đầu; run mới theo chính
   sách mới.

---

### User Story 5 - Nguồn tin cậy, giấy phép và audit (Priority: P2)

Quản trị thêm hay gỡ marketplace trong allowlist, thấy giấy phép từng plugin đã duyệt, và mở nhật ký audit để biết ai duyệt
plugin nào, ghim commit nào, ai bật cho dự án nào, lúc nào, và run nào đã chạy với plugin nào.

**Why this priority**: cần cho tuân thủ, nhưng US1 đã chặn nguồn lạ ở mức tối thiểu nên nhìn lại sau.

**Independent Test**: thêm marketplace, duyệt và gỡ một plugin, bật cho một dự án. Nhật ký có đủ dòng theo đúng thứ tự, mỗi
dòng có người làm, đối tượng, commit/hash khi liên quan.

**Acceptance Scenarios**:

1. **Given** marketplace chưa trong allowlist, **Then** không plugin nào từ đó duyệt được; không có đường tải plugin từ
   nguồn ngoài allowlist.
2. **Given** quản trị gỡ marketplace khỏi allowlist, **Then** các plugin đã duyệt từ nguồn đó chuyển "nguồn không còn được
   phép" và không áp dụng cho run mới.
3. **Given** mọi thao tác: thêm/gỡ marketplace, duyệt, đổi ghim, gỡ duyệt, bật/tắt ở dự án, **Then** mỗi thao tác có một dòng
   audit với người làm, thời điểm, plugin, commit, hash.
4. **Given** một run đã dùng plugin, **Then** chi tiết run ghi plugin, commit và hash đã dùng; có thể đối chiếu về audit.
5. **Given** giấy phép plugin, **Then** hiện ở danh sách duyệt, danh mục tổ chức và cấu hình dự án.

---

### User Story 6 - Cài plugin cho phiên tương tác trên desktop (Priority: P2)

Người dùng mở app desktop, mở phiên Claude Code tương tác trong dự án có bật `code-modernization`. App cài đúng plugin đã ghim
cho phiên đó, cùng quy tắc hash và `managedHooksOnly` như run. Đóng phiên thì plugin của phiên không ở lại trong cấu hình
cá nhân của người dùng.

**Why this priority**: mở rộng giá trị sang làm việc tay; run đã đủ cho MVP.

**Independent Test**: mở phiên tương tác trên máy cá nhân có cấu hình Claude Code riêng: phiên có lệnh của plugin; mở
Claude Code ngoài app thì không thấy plugin.

**Acceptance Scenarios**:

1. **Given** dự án bật plugin P, **When** mở phiên tương tác trong app, **Then** phiên có P đúng commit đã ghim, hash đã kiểm.
2. **Given** phiên đóng, **Then** cấu hình Claude Code cá nhân không đổi và phiên ngoài app không thấy P.
3. **Given** `managedHooksOnly` bật, **Then** hook của P không chạy trong phiên tương tác.
4. **Given** hub vắng, **Then** app dùng bộ nhớ đệm đúng hash nếu có; không có thì phiên mở không có plugin và báo rõ lý do.

---

### Edge Cases

- Plugin trên marketplace đổi nội dung sau khi đã ghim (đẩy commit mới, ghi đè tag): bản ghim không đổi; có commit mới thì hiện
  "có bản mới", không tự nâng.
- Commit đã ghim bị xoá khỏi nguồn: run dùng bộ nhớ đệm đúng hash; không có đệm thì dừng với lý do rõ; quản trị thấy cảnh báo.
- Hai plugin trùng tên lệnh hoặc agent: không nạp tự động cả hai; hiện xung đột lúc bật ở dự án và chặn bật plugin thứ hai.
- Plugin cần công cụ trên máy (Node, Python, shell) mà máy không có: run nêu rõ plugin nào thiếu gì; không báo lỗi mơ hồ.
- Script plugin dùng đường dẫn hay lệnh riêng của một hệ điều hành: cảnh báo lúc duyệt khi plugin không khai báo hỗ trợ đủ
  hệ điều hành; máy không phù hợp không nhận run cần plugin đó.
- Đường dẫn dài, có dấu cách hay tiếng Việt trên Windows: nạp plugin vẫn đúng.
- Plugin bị gỡ duyệt khi run đang chờ máy nhận: run chưa bắt đầu không dùng plugin nữa và ghi lý do; run đã bắt đầu giữ nguyên.
- Hai run song song cùng plugin ở hai commit khác nhau trên cùng máy: mỗi run môi trường riêng, không lẫn nhau.
- Nội dung plugin quá lớn hoặc có tệp nhị phân: quá giới hạn thì không duyệt được và nêu giới hạn.
- Plugin yêu cầu MCP server hay quyền riêng: các thứ này vẫn qua quy tắc MCP và chính sách quyền của tổ chức; plugin không
  tự nới quyền.
- Plugin gọi mạng hay đọc secret: nằm ngoài khả năng kiểm của Hive; nêu ở Giả định và cảnh báo ở màn duyệt.
- Tổ chức chưa có plugin nào duyệt: mục hiện trống, run chạy như cũ.

## Requirements *(mandatory)*

### Functional Requirements

**Nguồn tin cậy và duyệt (US1, US5)**

- **FR-001**: Tổ chức MUST có danh sách marketplace được phép (allowlist); mặc định chỉ chứa `anthropics/claude-plugins-official`.
- **FR-002**: Hệ thống MUST chặn duyệt và chặn tải plugin từ nguồn ngoài allowlist, ở mọi đường (web, API, worker, desktop).
- **FR-003**: Chỉ quản trị tổ chức MUST có thể thêm/gỡ marketplace, duyệt, đổi ghim, gỡ duyệt plugin.
- **FR-004**: Khi duyệt, hệ thống MUST ghim plugin vào một commit đầy đủ và lưu hash nội dung của cây tệp tại commit đó; không
  chấp nhận tên nhánh hay tag làm ghim.
- **FR-005**: Màn duyệt MUST hiện giấy phép, nguồn, commit, số lượng command, agent, hook, script; với hook và script MUST
  liệt kê từng mục (hook: sự kiện và lệnh) và yêu cầu xác nhận rõ.
- **FR-006**: Hệ thống MUST cảnh báo khi plugin thiếu giấy phép hoặc giấy phép ngoài danh sách cho phép của tổ chức, và chặn
  duyệt khi chưa có xác nhận có chủ ý.
- **FR-007**: Hệ thống MUST báo có commit mới của plugin đã duyệt nhưng MUST NOT tự nâng ghim.
- **FR-008**: Gỡ duyệt hoặc gỡ marketplace khỏi allowlist MUST làm plugin ngừng áp dụng cho run mới và phiên mới ngay.

**Bật theo dự án (US2)**

- **FR-010**: Dự án MUST chỉ bật được plugin đang được org duyệt; org là trần, dự án chỉ bật hoặc tắt trong trần đó.
- **FR-011**: Dự án MUST NOT đổi được commit ghim, nguồn hay hook của plugin.
- **FR-012**: Plugin chưa duyệt, đã gỡ duyệt hoặc nguồn không còn được phép MUST không áp dụng cho dù dự án đã từng bật.
- **FR-013**: Hệ thống MUST phát hiện hai plugin đã duyệt trùng tên command hay agent và chặn bật cặp đó ở cùng dự án.
- **FR-014**: Quyền bật/tắt ở dự án MUST theo quyền quản trị dự án đang có; quyền được kiểm trong hub, không chỉ ở giao diện.

**Cài vào run (US3)**

- **FR-020**: Hub MUST chỉ gửi cho worker danh sách plugin cần dùng (tên, nguồn, commit, hash) trong thông tin giao run; hub
  MUST NOT chạy agent hay mã plugin.
- **FR-021**: Worker MUST lấy đúng nội dung theo commit đã ghim, kiểm hash trước khi nạp, và MUST NOT nạp khi hash không khớp.
- **FR-022**: Worker MUST nạp plugin vào môi trường riêng của run (lệnh `claude` của run) và MUST NOT đổi cấu hình Claude Code
  của người dùng hay plugin cài sẵn trên máy; xong run MUST dọn môi trường riêng đó.
- **FR-023**: Plugin MUST chỉ nạp cho CLI `claude`; với CLI khác MUST bỏ qua và ghi lý do vào chi tiết run.
- **FR-024**: Khi không nạp được plugin bắt buộc của dự án (sai hash, không tải được, thiếu công cụ), run MUST dừng với lý
  do rõ, MUST NOT âm thầm chạy thiếu plugin.
- **FR-025**: Worker SHOULD giữ bộ nhớ đệm nội dung plugin theo hash để chạy khi nguồn tạm không tới được; đệm MUST được kiểm
  hash lại trước khi dùng.
- **FR-026**: Nạp plugin MUST đúng trên Windows, macOS, Linux, gồm đường dẫn có dấu cách và ký tự không phải ASCII; máy không
  đáp ứng yêu cầu của plugin MUST không nhận run cần plugin đó, kèm lý do.
- **FR-027**: Mỗi run MUST có môi trường plugin riêng; các run song song trên một máy MUST NOT dùng chung hay lẫn nhau.
- **FR-028**: Plugin MUST NOT nới quyền: quy tắc MCP, chính sách quyền, sandbox của tổ chức vẫn áp dụng như khi không có plugin.

**Hook và managedHooksOnly (US4)**

- **FR-030**: Khi `managedHooksOnly` bật, mọi hook của plugin MUST không chạy, kể cả hook khai báo trong command hay agent;
  command, agent và script khác của plugin vẫn dùng được; hook của tổ chức vẫn chạy.
- **FR-031**: Khi `managedHooksOnly` tắt, hook của plugin đã duyệt MAY chạy cùng hook của tổ chức.
- **FR-032**: Chi tiết run MUST liệt kê hook plugin bị chặn vì chính sách (plugin, sự kiện).
- **FR-033**: Chính sách MUST được chốt lúc run bắt đầu; đổi chính sách không ảnh hưởng run đang chạy.

**Audit và hiển thị (US5)**

- **FR-040**: Hệ thống MUST ghi audit cho: thêm/gỡ marketplace, duyệt, đổi ghim, gỡ duyệt, bật/tắt ở dự án, kèm người làm,
  thời điểm, plugin, commit, hash.
- **FR-041**: Chi tiết mỗi run MUST ghi plugin, commit, hash đã dùng, hoặc lý do không dùng.
- **FR-042**: Giấy phép MUST hiện ở danh sách duyệt, danh mục tổ chức và cấu hình dự án.
- **FR-043**: Nội dung plugin, log hook và đầu ra script MUST NOT gửi về hub ngoài siêu dữ liệu (tên, commit, hash, trạng
  thái, lý do); phù hợp ranh giới dữ liệu spec 027.

**Desktop (US6)**

- **FR-050**: Phiên Claude Code tương tác trong app desktop MUST có plugin của dự án theo cùng quy tắc ghim, kiểm hash,
  `managedHooksOnly` như run.
- **FR-051**: Plugin của phiên MUST NOT ghi vào cấu hình Claude Code cá nhân của người dùng và MUST biến mất khi phiên đóng.
- **FR-052**: Hub vắng thì app MUST dùng đệm đúng hash nếu có; không có thì mở phiên không plugin và báo lý do.

### Key Entities

- **Marketplace được phép**: nguồn plugin tổ chức tin cậy; định danh nguồn, người thêm, lúc thêm.
- **Plugin đã duyệt (danh mục tổ chức)**: plugin, nguồn, commit ghim, hash nội dung, giấy phép, danh sách thành phần
  (command, agent, hook, script), trạng thái (được phép / org đã gỡ / nguồn không còn được phép), người duyệt.
- **Bật theo dự án**: dự án, plugin đã duyệt, bật hay tắt, người đổi, lúc đổi.
- **Plugin dùng trong run**: run, plugin, commit, hash, kết quả nạp (đã nạp / bỏ qua vì CLI / lỗi và lý do), hook bị chặn.
- **Bản ghi audit plugin**: thao tác, người làm, thời điểm, đối tượng, commit, hash.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Quản trị duyệt và ghim `code-modernization` trong dưới 2 phút kể từ lúc mở trang, không cần dùng công cụ ngoài.
- **SC-002**: 100% run có plugin dùng đúng commit và hash đã ghim; trong 100 run thử có hash cố tình sai, 0 run nạp plugin sai.
- **SC-003**: Sau 100 run thử trên Windows, macOS, Linux, cấu hình Claude Code cá nhân trên máy không đổi (so hash) ở cả 100 lần.
- **SC-004**: Với `managedHooksOnly` bật, 0 hook plugin chạy trong 100 run thử; hook của tổ chức chạy ở 100% lần.
- **SC-005**: 100% thao tác plugin (thêm/gỡ marketplace, duyệt, đổi ghim, gỡ, bật/tắt) có đúng một dòng audit đủ trường.
- **SC-006**: Plugin từ nguồn ngoài allowlist: 0 lần duyệt hay nạp thành công qua mọi đường trong bộ kiểm thử.
- **SC-007**: Thêm plugin vào run tốn không quá 15 giây khi đã có đệm, và không quá 60 giây khi tải lần đầu với plugin dưới 10 MB.
- **SC-008**: Từ lúc org gỡ duyệt, 0 run mới bắt đầu dùng plugin đó.
- **SC-009**: Chủ dự án bật plugin và thấy plugin chạy trong run ở lần thử đầu, không cần tài liệu, trong 90% phiên thử.

## Assumptions

- Phạm vi bản đầu: plugin của marketplace trong allowlist; plugin tải thẳng từ URL hay tệp cục bộ ngoài phạm vi.
- Chỉ CLI `claude` nạp plugin; codex và CLI khác ngoài phạm vi.
- Org là trần: dự án chỉ bật hoặc tắt trong số plugin org đã duyệt, khác gói kỹ năng nơi dự án ghi đè tự do. Chọn mặc định
  này vì plugin chứa mã chạy; nếu cần cho phép dự án tự thêm sau thì đó là spec riêng.
- Plugin mới duyệt mặc định **tắt** ở mọi dự án; dự án bật chủ động.
- Khi `managedHooksOnly` bật, hook plugin không chạy kể cả plugin đã duyệt; chưa có cơ chế "hook plugin được org duyệt riêng
  cho chạy". Nếu cần thì mở rộng sau.
- Danh sách giấy phép cho phép của tổ chức cấu hình được; mặc định gồm các giấy phép mã nguồn mở thông dụng (trong đó
  Apache-2.0). Danh sách cụ thể do bước plan chốt.
- Nội dung plugin được đọc từ Git ở marketplace; worker có mạng tới nguồn hoặc có đệm. Hive không tự lưu bản sao plugin trên hub.
- Hive kiểm tính toàn vẹn (commit, hash) và quản lý quyền; Hive không phân tích hành vi mã của plugin. Duyệt là quyết định
  tin cậy của quản trị.
- Phụ thuộc: spec 002 (hook, `managedHooksOnly`), spec 003 (quy tắc MCP), spec 007 (audit), spec 027 (ranh giới dữ liệu),
  gói kỹ năng (mô hình org-dự án).
- Plugin `code-modernization` là ví dụ đầu tiên và là mẫu kiểm thử chính; spec không phụ thuộc nội dung riêng của nó.
