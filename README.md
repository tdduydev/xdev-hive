# xDev Hive

Bộ nhận diện **X + HIVE / DEV HUB**: [logo, màu sắc và hướng dẫn sử dụng](output/branding/brand-notes.md).

Tài liệu, memory và task dùng chung cho nhiều coding agent (Claude Code, Codex, Gemini CLI, Cursor…) chạy trên nhiều gói subscription khác nhau.

**Hệ thống** là một sản phẩm gồm một hoặc nhiều **service**. Mỗi service tương ứng một repo (một project key); task, run, máy và quyền vẫn thuộc service. Repo chưa thuộc hệ thống nào hiện như một hệ thống một service cùng tên, chỉ trên giao diện. RPC, DB, MCP và URL giữ tên kỹ thuật `project` để tương thích với máy và agent đang chạy.

## Bắt đầu trên máy mới

Mở app desktop: trang **Bắt đầu** tự mở khi máy còn bước cần làm. Đăng nhập hub qua trình duyệt (địa chỉ hub, mật khẩu và token nằm trong **Nâng cao**), hoặc chọn **Dùng một mình trên máy này**. Tiếp theo, cài công cụ còn thiếu, chọn thư mục service (app nhận ra repo con) hoặc nhập group GitLab, rồi **Cài hết** cấu hình service. Đăng nhập ít nhất một gói agent đang bật; ở chế độ hub, bật **Nhận việc** và chọn số lượt chạy tối đa cùng lúc. Mỗi bước báo trạng thái và có nút **Làm ngay**. **Hôm nay** nhắc số bước còn lại; mở lại hướng dẫn ở đó hoặc tìm **Bắt đầu** bằng ⌘K.

```
┌─ xDev Hive.app (Electron, menu bar) ─┐        ┌─ Hub web (Express) ─────────────────┐
│ Tài liệu · Đề xuất · Memory · Task   │  HTTP  │ /api/rpc   UI + tài khoản, quyền    │
│ Service & công cụ: sync, cài agents    │ ─────▶ │ /mcp       MCP Streamable HTTP      │
└──────────────┬───────────────────────┘        │ SQLite: docs, proposals, memory,    │
               │ local.db hoặc hub              │ tasks, users, tokens                │
      hive-mcp (stdio) ◀── Claude Code · Codex · Gemini (mỗi agent = 1 gói sub)
```

- **Tài liệu**: bản gốc của `AGENTS.md`, quy chuẩn chung (`org/*`), nhật ký quyết định. Có version, lịch sử và diff.
- **Xoá và chuyển trang** (roadmap 38g, cần quyền như khi sửa chính trang đó):
  - *Xoá trang* trên trang *Tài liệu* là xoá mềm: trang và các trang con rời khỏi danh sách, `AGENTS.md` và lần đồng bộ sau (file đã render bị gỡ), nhưng lịch sử phiên bản vẫn còn. Mục *Đã xoá* ở cuối cây trang có nút *Khôi phục*, đưa lại đúng những trang mà lần xoá đó lấy đi. Ghi vào nhật ký. Trang mang dấu `mirror` bị từ chối: xoá ở repo nguồn.
  - Ô *Không gian* chuyển trang sang không gian khác, kể cả `project/<dự án>/x` → `system/<hệ thống>/x`. Lịch sử, tệp đính kèm, đề xuất đang chờ và các trang con đi theo; khoá cũ vẫn trỏ sang khoá mới nên `doc_get` và liên kết `[[...]]` cũ không gãy.
  - Agent gọi `doc_get` vào trang đã xoá nhận `not_found`.
- **Service nghỉ** (roadmap 38g, admin hub, trang *Quản trị · Chính sách & chốt*): cho một project key nghỉ khi việc của nó đã xong. Key biến khỏi ô phạm vi và các danh sách chọn service khi không còn máy nào khai, không còn trang hay task mở; còn thì vẫn hiện kèm số còn lại. Không xoá dữ liệu, có nhật ký, và *Mở lại* đảo ngược.
- **Tài liệu theo đường dẫn**: tài liệu có ô *Áp dụng cho* (glob, vd. `apps/web/**`, `**/*.test.ts`) không nằm trong `AGENTS.md` chính, để file này ngắn.
  - Glob có thư mục: ghi vào `AGENTS.md` lồng trong thư mục đó (vd. `apps/web/AGENTS.md`), trong một block có marker. Phần repo tự viết ngoài block vẫn giữ.
    - Codex đọc `AGENTS.md` lồng. Claude Code (từ 2.1.277) đọc nó khi mở file trong thư mục đó.
  - Glob không có thư mục: ghi vào `.claude/rules/xdev-hive/<tên>.md` với frontmatter `paths:` (rule theo đường dẫn của Claude Code).
  - `AGENTS.md` chính chỉ có danh sách: glob nào thì đọc file nào, nên agent khác vẫn tìm được.
  - Đổi hay xoá đường dẫn thì lần đồng bộ sau gỡ block hoặc xoá file cũ.
  - `AGENTS.md` quá 200 dòng thì báo đồng bộ nhắc chuyển bớt.
  - Hook Claude, pre-commit và commit của runner cũng chặn các file này như `AGENTS.md`. `AGENTS.md` lồng mà không có block của Hive là của team, không bị chặn.
  - Tài liệu `agents` và `decisions` của service là cho cả repo, không đặt đường dẫn được. Tài liệu `org/*` có đường dẫn chỉ vào repo khi bật *Đưa vào AGENTS.md*.
- **Đề xuất**: agent không sửa tài liệu trực tiếp mà gọi `doc_propose`, admin duyệt. Nếu tài liệu đã đổi sau khi agent đọc, đề xuất bị đánh dấu xung đột, không ghi đè.
- **Skill** (hỏi ngày 29/9: ghi vào repo khi đồng bộ; chung team và riêng service; agent đề xuất, admin duyệt; Claude Code nạp file, Codex/Gemini đọc qua MCP):
  - Skill là tài liệu có key `org/skills/<tên>` (cả team) hoặc `project/<dự án>/skills/<tên>`. Nội dung là một `SKILL.md` của Claude Code: front matter có `name` (trùng `<tên>`: chữ thường, số, `-`, tối đa 64) và `description` (việc skill làm và khi nào dùng, tối đa 1024 ký tự), rồi đến các bước. Hub từ chối skill thiếu hoặc sai hai trường đó, và cũng chặn secret như với tài liệu.
  - Skill không bao giờ vào `AGENTS.md` và không giới hạn theo đường dẫn.
  - Agent dùng MCP: `skill_list` (tên và mô tả; skill của service thay skill chung cùng tên), `skill_get` (của service trước, không có thì của team), `skill_propose` (SKILL.md đầy đủ; `shared: true` cho cả team). Đề xuất đi qua trang *Đề xuất* như tài liệu.
  - MCP cũng có các tool chỉ đọc, dùng ở chế độ hub (lọc theo quyền của token; service token không thấy trả `not_found`):
    - `run_list`: lượt chạy máy đã báo lên hub, gồm task, việc, máy, gói, trạng thái, tóm tắt kết quả và MR.
    - `run_get`: một run kèm phần cuối log, secret đã ẩn.
    - `machine_list`: máy nào online, có nhận run từ hub không, có repo của service nào, và trạng thái các gói.
    - `run_requests`: yêu cầu run từ web hay chat (chờ, đã nhận, bị từ chối kèm lý do, huỷ, hết hạn).
    - `setup_missing`: mỗi máy có service còn thiếu gì (`cli:*`, `shim`, `<dự án>:*`), không kèm nút cài hay đường dẫn trên máy (method `machines.setupMissing`, cần quyền xem service).
    - `cost_summary`: chi phí của service 24 giờ / 7 ngày / 30 ngày, và các trần chi tiêu áp cho service cùng phần đã dùng.
    - `policy_get`: chính sách agent có hiệu lực của service, phần cài bắt buộc, agent của service hay cả hub có đang dừng.
    - `alert_list`: cảnh báo đang mở của hub, chỉ với admin hub qua `/mcp`.
  - Trang *Skill* (web và app, nhóm Làm việc):
    - Danh sách skill theo phạm vi đang chọn ở thanh bên. Khi chọn một service, trang hiện đúng bộ skill agent của service đó nhận: skill riêng có nhãn *thay skill chung*, skill chung cùng tên bị làm mờ với nhãn *không dùng ở service này*.
    - Soạn skill bằng ô tên, ô mô tả (đếm tới 1024 ký tự) và phần hướng dẫn; front matter được ghép tự động, giữ nguyên các khoá khác như `allowed-tools`. Nút *Thay đổi* hiện diff trước khi lưu.
    - Người quản trị (service hoặc Chung) lưu thẳng và tạo skill mới. Người đóng góp gửi đề xuất, admin duyệt ở trang *Đề xuất*.
    - Mỗi skill hiện số đề xuất đang chờ duyệt, kể cả đề xuất agent gửi bằng `skill_propose`.
  - Trang *Tài liệu* vẫn tạo và sửa được skill (tên `skills/<tên>`), kèm lịch sử phiên bản.
  - **Trong repo**: *Đồng bộ tài liệu* ghi mỗi skill của service (skill chung + skill riêng, riêng thay chung cùng tên) vào `.claude/skills/<tên>/SKILL.md`, nên Claude Code tự nạp skill như skill của nó. Front matter nằm đầu file như Claude Code cần, phần còn lại trong khối quản lý của Hive. Worktree của run lấy skill theo branch như `AGENTS.md`.
  - `AGENTS.md` có mục *Skills* trong khối của Hive: tên và mô tả từng skill, để Codex, Gemini và agent khác gọi `skill_get` khi mô tả khớp việc.
  - Skill bị xoá hay đổi tên trong Hive thì lần đồng bộ sau gỡ file và thư mục của nó. Repo tự có skill cùng tên (không có khối của Hive) thì giữ nguyên, báo *đã bỏ qua*.
  - Hook của Claude, pre-commit và commit của runner chặn sửa skill của Hive như `AGENTS.md`; skill riêng của repo thì agent vẫn sửa và commit được. Repo đã cài từ bản trước cần bấm cài lại *Cấu hình agent* ở *Cài đặt máy* để hook biết skill.
  - Chưa làm: trang Skill riêng (roadmap 14c).
- **Memory**: `memory_write` / `memory_search`, tìm kiếm FTS5 có dấu hoặc không dấu đều được. Trên hub, memory do agent ghi cần admin duyệt mới hiện cho agent khác. Memory *chung* (`memory_write` với `shared: true`) áp dụng cho mọi service, và `memory_search` của service nào cũng thấy (có `project: null`).
- **Memory còn dùng không**:
  - Hub đếm mỗi lần `memory_search` của agent trả về một mục, và ghi lần cuối. Người xem trên trang Memory không làm tăng số này.
  - Mục không được dùng, ghi hay giữ lại trong 90 ngày (`HIVE_MEMORY_STALE_DAYS`) thành *cũ*: `memory_search` của agent bỏ qua nó. Nó không bị xoá.
  - Trang Memory có lọc *Chỉ mục cũ*, nhãn *Cũ*, và nút *Giữ lại* (quyền quản trị service) để mục đó tính lại từ hôm nay.
  - Một mục đã cũ không tự trẻ lại nhờ agent, vì agent không còn tìm thấy nó; phải có người xem và giữ lại.
- **Memory trích dẫn file**: `memory_write` nhận `files` (tối đa 10 đường dẫn tính từ gốc repo; không có `/` đầu, `\`, hay `..`).
  - App desktop so các file đó với nhánh của service mỗi 30 phút (nhánh đích MR nếu có, không thì `HEAD`; nhánh local, không có thì `origin/…`). Nó dùng `git cat-file` nên chỉ đọc bản đã commit, không đọc thay đổi chưa commit.
  - Lần đầu thấy một file thì lấy bản đó làm mốc. File chưa có trên nhánh (vừa tạo trong task) thì chờ, không bị báo mất.
  - Về sau file khác mốc thì mục bị đánh dấu *Cần xem lại* (file đã đổi / không còn); file quay về như mốc thì hết đánh dấu. Không tìm thấy nhánh thì không kiểm gì, để khỏi báo mọi file đều mất.
  - Agent vẫn thấy mục cần xem lại, kèm trường `review`. Trang Memory hiện các file và nút *Vẫn đúng*: lấy file hiện tại làm mốc mới.
- **Webhook Teams / Slack**: tab *Webhook* trong trang *Quản trị* (chỉ admin của hub) để thêm webhook gửi tin vào kênh.
  - Teams dùng luồng Workflows "Post to a channel when a webhook request is received", tin dạng Adaptive Card. Slack dùng Incoming Webhook.
  - Sự kiện chọn được: đề xuất chờ duyệt, memory chờ duyệt, yêu cầu cài trên máy và kết quả của nó, run lỗi, MR mới.
  - Run lỗi và MR mới do app desktop ở chế độ hub báo lên (`runs.report`).
    - Chỉ báo run lỗi hẳn: một lần hết quota rồi chuyển gói khác thì chưa tính. Chỉ báo MR tạo mới, không báo MR được cập nhật.
    - Lỗi gửi đi là dòng cuối, bỏ ký tự ẩn; nếu trông giống secret thì bị thay bằng `(hidden: …)`.
    - Tin MR mới có nút mở thẳng MR trên GitLab.
  - Mỗi webhook chọn sự kiện, lọc theo service (để trống là tất cả, kể cả dữ liệu chung và yêu cầu cài) và ngôn ngữ tin. Tin có nút mở đúng trang trên hub.
  - URL webhook là bí mật: chỉ nhận `https`, lưu trên hub, trang chỉ hiện dạng che (`https://hooks.slack.com/…x9Qa`). Sửa mà để trống URL thì giữ URL cũ. Lỗi gửi chỉ ghi `HTTP 500`, `timeout` hay `network error`, không ghi URL.
  - Nút *Gửi thử* gửi một tin thử. Lần gửi cuối và lỗi (nếu có) hiện trên thẻ webhook.
- **Thay thế và mâu thuẫn** thay vì xoá:
  - Thay thế: `memory_write` với `supersedes: <id>` ghi mục mới thay cho mục cũ cùng service (hoặc cùng là memory chung). Khi mục mới được duyệt, `memory_search` của agent bỏ mục cũ, nên cả chuỗi chỉ còn mục mới nhất. Muốn thay thì thay mục mới nhất; xoá mục thay thì mục trước nó hiện lại.
  - Mâu thuẫn: `contradicts: <id>` đánh dấu hai mục nói khác nhau. Agent thấy cả hai, kèm `conflictsWith`, cho tới khi người quản trị service chọn trên trang Memory: *Giữ mục này*, *Giữ #…* (mục kia bị thay), hoặc *Không mâu thuẫn* (`memory.resolve`).
  - Trang Memory hiện số `#id` của từng mục, *Thay cho #…* và *Đã được thay bằng #…*; mục đã thay bị gạch.
- **Chung và riêng từng service**: tài liệu `org/*` và memory chung dùng cho cả team; tài liệu `project/<dự án>/*`, memory riêng và task thuộc về một service. Ở đầu sidebar có ô chọn phạm vi: *Tất cả service*, *Chung (cả team)*, hoặc một service. Mọi trang lọc theo phạm vi đó (ở một service thì thấy dữ liệu riêng của service cộng với dữ liệu chung, có nhãn "Chung"), và mục tạo mới mặc định thuộc phạm vi đang chọn. Trang *Tổng quan* tóm tắt từng service và phần dữ liệu chung.
- **Hệ thống** (microservice): gom các service (mỗi service một repo) thành một hệ thống ở trang *Hệ thống* (nhóm *Quản trị*, web và app). Hệ thống lưu trên hub, dùng chung cho cả team; một service có thể thuộc nhiều hệ thống.
  - Chọn hệ thống ở ô phạm vi đầu sidebar thì *Tổng quan*, *Task*, *Lượt chạy* (có MR), *Chat*, *Memory*, *Tài liệu*, *Skill*, *Đề xuất* hiện dữ liệu của mọi service trong hệ thống, cộng dữ liệu chung. *Board* của app chỉ cho chọn service của hệ thống. Task, chat và memory mới chọn một service của hệ thống.
  - Ô phạm vi **lấy hệ thống làm gốc** (roadmap 40a): dưới *Tất cả service* và *Chung* là danh sách hệ thống. Repo không thuộc hệ thống nào hiện như một hệ thống một service cùng tên (không lưu thành hệ thống; chọn nó là phạm vi của service đó). Service của một hệ thống hiện khi bấm số service bên phải (hoặc phím →, ← thu lại) hay khi gõ tìm khớp tên service; tìm theo tên hệ thống thì hiện mọi service của nó. Ô phạm vi và tiêu đề trang ghi tên hệ thống; phạm vi là một service thì ghi `hệ thống › service`.
  - Tạo và sửa hệ thống cần quyền *quản lý* trên mọi service có trong nó và được thêm vào hay bỏ ra (token agent không sửa được). Người xem chỉ thấy các service mình được cấp; hệ thống không có service nào mình thấy thì bị ẩn.
  - **Tài liệu và memory của hệ thống** (roadmap 19c): API contract, sự kiện, cách các service gọi nhau, dùng chung cho mọi service và tách khỏi phần *Chung*. Trang có khoá `system/<hệ thống>/<trang>`, memory ghi với `system: <hệ thống>` (MCP `memory_write` cũng có).
    - Tài liệu và memory **mặc định ở cấp hệ thống** (roadmap 40c). Phạm vi là hệ thống hay một service của hệ thống thì *Tài liệu* có không gian *Hệ thống <tên>*: trang của hệ thống trước, rồi một nhóm cho mỗi service (phạm vi service: chỉ nhóm của service đó). *Trang mới* đặt ở `system/<tên>/…`; ô *Đặt ở* đổi sang một service khi chỉ repo đó cần (ví dụ AGENTS.md riêng). Form *Ghi memory* cũng mặc định chọn hệ thống, không có quyền ghi ở hệ thống thì về service. Phạm vi *Tất cả* giữ từng không gian riêng như cũ. Thẻ ở trang *Hệ thống* có nút *Tài liệu* và *Memory*.
    - Agent viết tài liệu chung của hệ thống ở `system/<tên>/<trang>` (`doc_write` / `doc_propose` không đổi, chỉ đổi khoá), memory chung ghi với `system: <tên>`; chỉ dùng `project/<service>/…` khi chỉ repo đó cần.
    - Agent của một service nhận chúng như phần *Chung*: `doc_list` có tài liệu của các hệ thống chứa service đó, `memory_search` có memory của chúng. Trang có *Đưa vào AGENTS.md của mọi service* thì vào AGENTS.md (sau tài liệu *Chung*); thêm *Áp dụng cho* thì thành file theo đường dẫn (`.claude/rules/sys-<hệ thống>-<trang>.md` khi không có thư mục riêng).
    - Quyền suy ra từ quyền ở các service: có ở *một* service thì xem, đề xuất sửa, ghi memory (chờ duyệt); sửa thẳng, duyệt đề xuất và memory thì phải có quyền đó ở *mọi* service. Người không ở service nào không thấy.
    - Xoá hệ thống còn tài liệu hay memory thì hub từ chối; chuyển hoặc xoá chúng trước. Skill theo hệ thống chưa có.
  - **Task chéo service** (roadmap 19d): task của một service phụ thuộc được task của service khác trong cùng hệ thống (service B chờ A xong API), ở ô *Phụ thuộc* của trang *Task* hay khi tạo task. Board và trang *Task* ghi `dự án/mã task` cho phụ thuộc ở service khác; task chờ chúng thì nằm cột *Bị chặn*, agent không nhận được và *Sẵn sàng tiếp theo* bỏ qua cho tới khi chúng xong. Phụ thuộc ở service người xem không có quyền chỉ hiện số lượng (`+1`) và được giữ nguyên khi người đó sửa ô *Phụ thuộc*. Hai service không cùng hệ thống thì không phụ thuộc nhau được.
  - **Leader ở mức hệ thống**: chat của một service mà nằm trong hệ thống thì leader được báo hệ thống và các service của nó. Một tính năng chạm nhiều service, leader đề xuất mỗi service một task (`propose_task` có `project`) nối bằng `dependsOn`, và xếp run cho task của service khác trên máy có repo đó. Người xác nhận vẫn phải có quyền ở từng service.
  - Lúc nhập group GitLab, ô *Gom vào hệ thống* (mặc định tên group) đưa luôn các repo đã nhập và repo đã là service vào một hệ thống.
- **Task**: `task_claim` giữ task theo lease, hai agent không nhận trùng. `task_update` kèm ghi chú bàn giao.
  - **Lịch sử ghi chú** (roadmap 41a): mỗi lần `task_update` kèm ghi chú, Hive giữ thêm một phiên bản (ai ghi, trạng thái lúc đó, nguồn, lúc nào) nên bàn giao cũ không bị ghi đè; ghi chú của task vẫn là bản mới nhất. Agent đọc vài bản gần nhất bằng `task_notes` (`tasks.notes`), panel task trên web có mục *Lịch sử ghi chú* xem được thay đổi giữa hai bản liền nhau. Chuyển trạng thái mà không kèm ghi chú thì không tạo bản mới.
  - **Phụ thuộc**: task có thể phụ thuộc task khác cùng service. Đặt khi tạo, hoặc bấm *Sửa* ở cột *Phụ thuộc* trang Task (`tasks.setDeps`). Hive từ chối task tự phụ thuộc chính nó, task của service khác và vòng lặp.
    - Còn task phụ thuộc chưa *Xong* thì không `task_claim` được và app không chạy agent cho nó. Board để nó ở cột *Bị chặn* với nhãn *Chờ T-1*.
    - Các task đó xong thì task tự mở khoá, không cần ai chuyển trạng thái.
  - **Task sẵn sàng tiếp theo** (`task_next` / `tasks.next`): task *Chưa làm*, không chờ task nào, không ai giữ. Task mở khoá được nhiều task khác nhất xếp đầu.
    - Trang Task hiện 3 task đầu, Board gắn nhãn *Tiếp theo*.
- **Đồng bộ vào repo**: render `AGENTS.md` (khối chung + phần riêng của service), `CLAUDE.md` (`@AGENTS.md`), `docs/decisions.md`. Chỉ đụng các file này.
  - **Qua MR** (mặc định khi repo có remote GitLab/GitHub app mở được MR trên đó): app fetch nhánh đích (`targetBranch` của service, không có thì nhánh mặc định của remote), dựng lại nhánh `chore/xdev-hive-context` trên nhánh đích đó trong worktree riêng `<thư mục worktree>/<dự án>/_hive-context`, render, commit, push `--force-with-lease` rồi tạo MR — hoặc cập nhật MR cũ nếu còn mở. Checkout chính giữ nguyên nhánh và file đang làm dở: app không ghi, không commit gì vào đó. Phần nhập lần đầu (`AGENTS.md`, `docs/decisions.md` của repo lên Hive) cũng đọc bản trên nhánh đích. Không khác nhánh đích thì dừng: không push, không MR. Báo cáo đồng bộ (và thẻ *Đồng bộ trên các máy* ở hub) có link MR.
  - **Commit thẳng** như trước: repo không có remote nào app mở MR được, hoặc tắt *Tự commit khi đồng bộ tài liệu*. Khi đó file được ghi vào checkout đang mở và commit tại chỗ, không push.
  - **Không đè `AGENTS.md` repo tự viết**: file không có khối của Hive mà nội dung khác trang `agents` trên hub là của repo, giữ nguyên; báo đồng bộ ghi *bỏ qua* kèm lý do. Phần của Hive ghi vào `.xdev-hive/context/AGENTS.md`, `CLAUDE.md` import thêm file đó — đúng như worktree của run. Nút *Đề xuất nhập vào Hive* ở báo cáo đồng bộ gửi nội dung file thành đề xuất sửa trang `agents` (`baseVersion` của trang lúc gửi) cho người có quyền Context agent duyệt. Trang khớp lại với file thì lần đồng bộ sau ghi thẳng `AGENTS.md` và gỡ bản bên cạnh.
- **Chặn sửa tay**: hook `PreToolUse` của Claude Code và `pre-commit` của git (áp dụng cho mọi agent), kể cả `.xdev-hive/context/`. Run của runner không chạy hook nào; runner tự để các file này ngoài commit.
- **Board + runner** (desktop): giao task cho agent chạy headless (`claude -p`, `codex exec`, `gemini -p`…). Mỗi task có worktree riêng. Hết quota thì tự chuyển gói sub, xong thì review chéo bằng vendor khác. Task khó thì chạy 2–4 bản trên các gói khác nhau, một giám khảo vendor khác giữ bản tốt nhất.
- **GitLab MR / GitHub PR**: review chéo đạt thì push `ai/<task>` và tạo MR (review yêu cầu sửa thì tạo Draft). Chạy lại thì cập nhật MR cũ. Service trên GitHub thì tạo pull request theo cùng luật.

## Cấu trúc

| Thư mục | Nội dung |
|---|---|
| `packages/core` | Schema zod, phân quyền, `SqliteHive` (node:sqlite + FTS5), `HubBackend`, render sync, config |
| `packages/mcp` | 8 tool MCP, entry stdio `hive-mcp` |
| `packages/ui` | React UI dùng chung cho web và desktop: shadcn/ui + Tailwind v4 (`src/components/ui/`, design system xDev Hive ở `src/tokens/` + `src/globals.css` (bản thiết kế: `docs/design/2026-09-redesign`), sáng / tối / theo hệ thống) |
| `apps/web` | Hub: REST RPC, MCP qua HTTP, token, phục vụ UI |
| `apps/desktop` | Electron: tray, IPC, sync repo, cài MCP vào Claude/Codex/Gemini, shim `hive-mcp`, runner (`src/main/runner`) |

Không có native module: SQLite dùng `node:sqlite` có sẵn trong Node 24+ và Electron 44.

**Import trong repo**: file nằm cùng thư mục import bằng `./tên.ts`; file ở thư mục khác trong cùng package dùng alias của package thay cho `../`:

| Alias | Trỏ tới |
|---|---|
| `#ui/*` | `packages/ui/src/*` (vd. `#ui/hooks.ts`, `#ui/components/DocMarkdown.tsx`) |
| `#core/*` | `packages/core/src/*` |
| `#mcp/*` | `packages/mcp/src/*` |
| `#web/*` | `apps/web/src/*` |
| `#desktop/*` | `apps/desktop/src/*` (vd. `#desktop/main/git.ts`) |

Alias khai báo ở `imports` của `package.json` mỗi package (subpath imports của Node), nên Node (`node --test` chạy thẳng file `.ts`), Vite, electron-vite và `tsc` đều tự hiểu, không cần `paths` trong tsconfig hay loader riêng. Package khác import theo tên package (`@xdev-hive/core`, `@xdev-hive/ui/components/ui/button`).

## Chạy

```bash
nvm use && npm install
npm test            # 396 test: core, mcp, hub (REST + MCP HTTP), desktop (installer, git hook, sync, runner, GitLab MR, GitHub PR)
npm run typecheck
```

Ghép lô task vào worktree review riêng: `node scripts/review-batch.mjs --name <lô> ai/<task>…`.
Thêm `--gate` để chạy cổng kiểm tuần tự; xem [cách dùng, nguồn từ máy khác và log](scripts/review-batch.md).

Hub (dev, có HMR):

```bash
npm run dev:web
```

Lần chạy đầu tạo tài khoản `admin` và in **mật khẩu tạm** ra console (chỉ một lần). Mở http://localhost:7788, đăng nhập, rồi đặt mật khẩu mới. Muốn reset thì xoá `apps/web/data/`.

Kiểm giao diện web từ đầu tới cuối (chạy khi đổi trang web):

```bash
npm run e2e -w @xdev-hive/web -- <thư mục ảnh>     # thêm --no-build để dùng bản build có sẵn
npm run e2e -w @xdev-hive/web -- --only a,b --repeat 3   # chỉ bước a, b (kèm bước chúng cần; NEEDS trong browser.mjs); lặp 3 lần, mỗi lần hub mới, in số lần lỗi từng bước
```

Linux không có màn hình (cần `xvfb-run`; Electron dùng hub và DB tạm):

```bash
ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a -s "-screen 0 1440x900x24" npm run e2e -w @xdev-hive/web -- <thư mục ảnh> --repeat 2
ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a -s "-screen 0 1440x900x24" npm run e2e:mobile -w @xdev-hive/web -- <thư mục ảnh điện thoại> --repeat 2
```

Có thể thêm `--only <bước>[,<bước>…]` để kiểm nhanh. Helper dùng Control trên Linux/Windows và Meta trên macOS cho phím tắt. Trên Linux, cửa sổ Electron được hiển thị trong màn hình ảo Xvfb và đưa lên trước khi thao tác để compositor chạy frame cho editor trả focus và các khung chuyển động; các tab nền cũng không bị throttle.

Lệnh này làm các bước sau:

- build client;
- chạy một hub tạm (DB tạm, cổng trống);
- seed người dùng, trang và việc chờ duyệt;
- dùng Electron làm trình duyệt ẩn, đi qua các luồng:
  - đăng nhập bằng token và bằng mật khẩu;
  - reviewer duyệt tài liệu thường nhưng không duyệt được context agent;
  - Thành viên của lead và hộp Phân quyền;
  - trình soạn Tiptap (menu `/`, liên kết trang, bảng) và Markdown;
  - Mermaid vẽ và báo lỗi;
  - duyệt hàng loạt đề xuất và memory;
  - yêu cầu máy đồng bộ, với một máy giả gửi heartbeat;
  - chính sách agent của một service, và heartbeat mang chính sách đó;
  - nhật ký: lọc theo run việc một agent ghi thay một người;
  - dừng mọi agent của cả hub, rồi cho chạy lại;
  - trần chi tiêu: chi phí của một run làm đầy trần của service, hub giữ run tiếp theo;
  - trang Hub.

Mỗi bước kiểm lại dữ liệu trên hub qua RPC và chụp một ảnh. Có bước hỏng thì ảnh mang đuôi `-FAIL` và lệnh thoát khác 0. Giao diện được kiểm bằng tiếng Việt.

App desktop:

```bash
npm run dev:desktop                              # dev
npm run smoke -w @xdev-hive/desktop              # app + config tạm + agent giả + GitLab giả: hết quota → xoay gói → review chéo → MR → CI lỗi → run sửa → 2 bản + giám khảo (HIVE_SMOKE_LOCALE=en: chụp giao diện tiếng Anh)
npm run dist -w @xdev-hive/desktop               # bản cài cho máy đang dùng
npm run release -w @xdev-hive/desktop            # build mọi nền tảng + đăng GitHub Release v<version>
```

**Phát hành** (không có CI, chạy trên Mac): tăng `version` trong `apps/desktop/package.json` ở PR, merge, rồi trên checkout sạch của `origin/main` chạy `npm run release -w @xdev-hive/desktop`. Script build macOS (arm64, x64: `.dmg` + `.zip`), Windows (x64, arm64: bộ cài NSIS) và Linux (x64, arm64: AppImage), tạo `SHA256SUMS.txt`, rồi tạo release `v<version>` kèm ghi chú thay đổi. `-- --dry` chỉ build, không đăng. Mac Apple Silicon cần Rosetta 2 (`softwareupdate --install-rosetta --agree-to-license`), vì công cụ đóng gói NSIS và AppImage chỉ có bản Intel. Chưa có chứng chỉ Developer ID: bản macOS ký ad-hoc, người dùng mở lần đầu qua *Privacy & Security → Open Anyway*.

Icon: `npm run icons -w @xdev-hive/desktop` (chỉ chạy trên macOS, vì dùng `swift` và `iconutil`) sinh toàn bộ icon từ cùng một hình học với `HiveLogo`. Kết quả gồm `build/icon.icns` / `icon.ico` / `icon.png` cho electron-builder, `resources/icon.png` (icon cửa sổ Windows/Linux và Dock khi chạy dev), `favicon.svg` và `apple-touch-icon.png` cho hub. Các file này được commit sẵn. Muốn đổi hình hay màu thì sửa `scripts/icons.mjs` rồi chạy lại.

## Nối một repo với Hive (trên app desktop)

**App và web làm việc khác nhau** (roadmap 35a). App desktop nối với hub chỉ có việc của máy, năm mục: *Hôm nay* (CI của run trên máy, cài đặt máy, yêu cầu cài từ admin), *Lượt chạy* (run trên máy này), *Agent và quota*, *Service & công cụ* (repo trên máy và những gì runner cần), *Cài đặt* (kết nối hub, GitLab, GitHub). Task, tài liệu, spec, memory, đợt chạy, chat, máy của team, thành viên, chính sách nằm trên web của hub. Nút *Mở web* ở góc trên và mọi đường dẫn tới các trang đó mở trình duyệt ở hub. App ở chế độ cục bộ (không nối hub) là cả hệ thống, nên vẫn có đủ trang.

**Web của hub: một khung cho mọi người** (roadmap 35b). Trước đây admin hub có khung riêng (Web Admin) với 25 mục, nhiều mục trùng với trang của thành viên. Giờ mọi người dùng chung một khung, và menu hiện theo quyền:
- *Hôm nay*, *Chat*.
- *Công việc*: Task, Spec, Đợt chạy, Lượt chạy.
- *Kiến thức*: Tài liệu, Skill, Memory, Đề xuất.
- *Vận hành*: Tổng quan (có chọn 24 giờ / 7 ngày / 30 ngày), Bản đồ agent, Đội máy, Hàng đợi, Chi phí, Cảnh báo. Chỉ admin hub thấy, trừ *Bản đồ agent*.
- *Quản trị*: Hệ thống, Thành viên, Người dùng & quyền, Chính sách & chốt, Tool, Context agent, Token, Thông báo & webhook, Nhật ký, Phiên bản app, Hub. Mỗi mục hiện khi người đó có quyền.

Trang trùng đã bỏ: *Lượt chạy* chỉ còn một trang, *Quota & gói* nằm trong *Bản đồ agent*, trang *Quản trị* cũ (tab máy, chính sách, nhật ký, webhook) tách thành các mục trên. Mở web thì vào *Hôm nay*. Địa chỉ cũ `#/admin/<trang>` (trong link đã gửi qua webhook, thông báo app) tự chuyển sang trang mới, ví dụ `#/admin/review` → `#/proposals`, `#/admin/quota` → `#/machines`, `#/admin` → `#/ops`.

**Hôm nay trên web: việc chờ chính bạn** (roadmap 35c). Một danh sách gom mọi thứ đang chờ người đó quyết, và chỉ gồm những mục người đó có quyền xử lý:
- *Chốt SDLC*: luồng Spec Kit hoặc task của luồng đang dừng ở một chốt chờ người, hoặc AI kiểm chưa cho qua. Có kết luận của AI (nếu có), ô ghi chú, nút cho qua / yêu cầu sửa như trên thẻ luồng. Chốt review và merge cần quyền Review code, các chốt khác cần quyền xếp run.
- *Leader đề xuất*: thao tác leader đề xuất trong Chat (tạo task, xếp run, bật tool…) mà chưa ai xác nhận. Nút *Xác nhận* / *Bỏ qua* và *Mở chat*. Cần quyền xác nhận việc của leader.
- *Đề xuất* tài liệu (quyền duyệt tài liệu, hoặc Context agent với tài liệu agent đọc), *Memory* chờ duyệt và *Mâu thuẫn* (quyền duyệt memory), task *Chờ review* (quyền Review code), *Cảnh báo* của hub (admin hub).

Mục chỉ xem được mà không làm gì được thì không còn trong danh sách. Số chờ duyệt chỉ hiện một chỗ, trên *Hôm nay* (menu web bỏ số riêng của *Đề xuất* và *Memory*), và ô *Chờ duyệt* ở *Vận hành* → *Tổng quan* mở *Hôm nay*. Hub thêm `chat.pending`: thao tác của leader chưa ai quyết, mới nhất trước, theo service người gọi xem được.

1. **Service & công cụ** → *Service trên máy này*: thêm repo (project key, ví dụ `xdev-ai-studio`).
   - Thư mục phải là git repo. Không phải thì app báo ngay và không thêm, vì service như vậy chạy run không được (worktree lỗi), đồng bộ tài liệu ghi file mà không commit, và trang *Spec* trống.
   - **Thư mục chứa nhiều repo** (roadmap 38d, ví dụ `D:\src\customer-ai` với 8 repo): app quét tối đa 3 cấp (bỏ qua `node_modules`, thư mục ẩn, và không đi vào bên trong một repo đã thấy) rồi đề nghị thêm từng repo. Mỗi repo có project key (tên thư mục; trùng thì thêm thư mục cha, vẫn trùng thì thêm số; sửa được) và *Nhánh đích* lấy từ `origin/HEAD` của repo đó. Bỏ chọn repo không cần; repo đã là service chỉ hiện để biết. *Gom vào hệ thống* (bật sẵn, tên mặc định là tên thư mục gốc) đưa các repo vừa thêm và các repo đã là service vào cùng một hệ thống.
2. Cũng trang đó kiểm tra những gì runner cần: trang tự kiểm tra khi mở app, và sidebar hiện số mục chưa sẵn sàng. Mục nào còn thiếu thì có nút cài riêng:
   - **CLI của agent** (Claude Code, Codex, Gemini): tìm theo `PATH` của login shell và hiện phiên bản. Nút *Cài bằng npm* chạy `npm install -g @anthropic-ai/claude-code` / `@openai/codex` / `@google/gemini-cli`, nên máy cần có Node.js. Profile nào chưa có CLI thì hiện "Chưa có lệnh …", và runner bỏ qua gói đó thay vì chạy thử rồi lỗi.
     - **Phiên bản và nâng cấp** (roadmap 33): app so phiên bản đang dùng với bản mới nhất. Bản mới nhất lấy bằng `npm view <gói> version` (theo registry và proxy của máy); máy không có npm thì hỏi registry.npmjs.org. Kết quả được nhớ 6 giờ, lỗi thì nhớ 30 phút. CLI cũ vẫn là *Đã cài* (không bị tính là thiếu mục bắt buộc) và có nhãn *Có bản x.y.z*.
     - Nút *Nâng cấp lên x.y.z* nâng cấp CLI theo đúng cách đã cài, để không có bản thứ hai trên `PATH`. Cài bằng npm: `npm install -g <gói>@latest`. Claude Code cài bằng bộ cài riêng (`~/.local/share/claude`): `claude update`. Homebrew: `brew upgrade <tên>` (cask thì thêm `--cask`). Không biết cài bằng gì thì không có nút, mà ghi là cần nâng cấp tay.
     - Đang có run dùng CLI đó thì app từ chối nâng cấp. Trong lúc nâng cấp, runner không bắt đầu run mới trên các gói của CLI đó.
     - Thẻ gói ở *Agent và quota* hiện phiên bản CLI và nút nâng cấp, khi gói dùng lệnh mặc định (`claude`, `codex`, `gemini`) trên `PATH`.
   - **Lệnh hive-mcp**: `~/.local/bin/hive-mcp` (Windows: `%USERPROFILE%\.xdev-hive\bin\hive-mcp.cmd`) chạy MCP bằng chính binary của app. App báo *Cần cập nhật* nếu lệnh đang trỏ tới bản app khác (ví dụ bản dev), và báo *Cần sửa tay* nếu thư mục đó chưa nằm trong `PATH` hoặc đã có file trùng tên không do Hive tạo.
     - **Windows — nút *Thêm vào PATH*** (roadmap 38b): ghi thư mục shim vào `Path` ở `HKCU\Environment`, không cần quyền admin. Giữ nguyên kiểu `REG_EXPAND_SZ` và các mục `%…%` đang có, không thêm trùng (so sánh không phân biệt hoa thường, bỏ qua dấu `\` cuối và `%USERPROFILE%` đã khai triển), rồi phát `WM_SETTINGCHANGE` cho chương trình đang mở. Dùng `reg.exe` chứ không dùng `setx`: `setx` đổi giá trị thành `REG_SZ` (mất `%USERPROFILE%`) và cắt ở 1024 ký tự. Chương trình đang mở vẫn giữ `PATH` cũ, nên mở lại terminal và app sau khi bấm.
     - Cấu hình MCP không phụ thuộc `PATH` nữa (xem bước 3), nhưng run của runner vẫn gọi `hive-mcp` theo tên, nên thư mục shim vẫn nên nằm trong `PATH`.
     - Các bước kiểm từng hệ điều hành (lệnh và kết quả mong đợi ở `/mcp`): [docs/mcp-check.md](docs/mcp-check.md).
   - **Spec Kit CLI (`specify`)**: nút *Cài bằng uv* chạy `uv tool install specify-cli --from git+https://github.com/github/spec-kit.git`, nên máy cần có [uv](https://docs.astral.sh/uv/getting-started/installation/). App tìm `specify` cả trong thư mục `uv tool dir --bin` (macOS: `~/.local/bin`) khi thư mục đó chưa nằm trong `PATH`.
   - **Theo từng repo**: cấu hình agent của Hive (bước 3), codegraph trong `.mcp.json`, index codegraph (`.codegraph/`, lệnh này tắt telemetry trước khi tạo index), superpowers trong `.claude/settings.json`, và Spec Kit.
   - **[Spec Kit](https://github.com/github/spec-kit)** cho agent viết `spec.md` → `plan.md` → `tasks.md` của từng tính năng trong `specs/<NNN-tên>/`. Nút *Cài Spec Kit* chạy `specify init --here --force --non-interactive --integration claude --script sh --ignore-agent-tools` (Windows: `--script ps`) rồi `specify integration install codex`, nên repo có lệnh `speckit-*` cho cả Claude Code (`.claude/skills/`) và Codex (`.agents/skills/`). Repo đã có `.specify/` thì app không `init` lại (để giữ constitution đã sửa), chỉ thêm integration còn thiếu. Cài xong nhớ commit `.specify/`, `.claude/skills/speckit-*`, `.agents/skills/speckit-*`: worktree của run lấy từ branch, file chưa commit thì agent không thấy. Chính sách nhóm có thể bắt buộc Spec Kit theo service.
   - **Trang *Spec*** (nhóm *Kiến thức*, web và app) liệt kê các tính năng trong `specs/` của service: bước đang ở (*Viết spec* → *Lập kế hoạch* → *Chia việc* → *Đang làm* → *Xong*, tính từ file nào đã có và bao nhiêu dòng `- [x]` trong `tasks.md`), tiến độ, và đọc `spec.md`, `plan.md`, `tasks.md`. App trên máy có repo đọc git, không đọc checkout: `specs/` của branch đích (fetch từ remote), và của các branch làm dở tên `ai/…` (run của Hive) hay `NNN-…` (branch Spec Kit tạo) khi khác branch đích, bỏ branch không có commit 30 ngày. Máy đẩy lên hub 10 phút một lần (lần đầu 90 giây sau khi mở app), chỉ khi có gì đổi; hub giữ bản mới nhất, tính năng máy không còn gửi (đã merge, đã xoá) thì bỏ. Dòng có vẻ là secret được ẩn như log của run.
   - **Nhập `tasks.md` thành task** (roadmap 20c): tab *Tasks* của một tính năng có *Nhập thành task* (người có quyền *Tạo/sửa task*). Mỗi dòng `- [ ] T001 …` thành task `<tiền tố>-T001` (mặc định `S` + số thư mục, vd. `S001-T001`), ghi chú nói nó từ `specs/<thư mục>/tasks.md` và pha nào. Phụ thuộc theo template của Spec Kit: trong một pha các bước nối nhau (một dãy việc `[P]` liền nhau là một bước), *Setup* → *Foundational* → các *User Story* song song → *Polish* sau mọi story, cộng `depends on T0xx` nêu trong dòng. Dòng đã `[x]` không nhập; task đã có giữ nguyên. Có bản xem trước (mã, việc, chờ gì) trước khi nhập.
   - **Run cho từng bước** (roadmap 20d): *Tính năng mới* (phạm vi một service) nhận mô tả, tạo task `SPEC-<n>` và xếp run cho agent làm `/speckit-specify` trên máy chọn. Tính năng ở bước spec có *Lập kế hoạch*, ở bước plan có *Chia việc*: run tiếp theo của cùng task (tính năng ở branch `ai/<task>`, nên run thấy file của bước trước), hoặc task `S001-PLAN` / `S001-TASKS` cho tính năng ở branch đích. Agent được dặn đọc skill `speckit-<bước>` của repo, đặt `SPECIFY_FEATURE_DIRECTORY`, chỉ viết file spec và commit. Kết quả duyệt như mọi run (review, MR, *Merge*). Leader chat đề xuất được các run này bằng `propose_run` với cùng lời dặn.
3. **Cấu hình agent** ghi các file sau (merge, không ghi đè cấu hình sẵn có; nếu dữ liệu giống nhau thì giữ nguyên định dạng file):
   - `~/.claude.json` (Claude Code, scope *local* của repo: `projects["<đường dẫn repo>"].mcpServers`), `.gemini/settings.json` (Gemini: `contextFileName: ["AGENTS.md"]`), `~/.codex/config.toml` (block có marker)
   - `.claude/settings.json` + `.xdev-hive/guard-docs.sh` (hook chặn sửa tài liệu)
   - `.githooks/pre-commit` + `git config core.hooksPath .githooks`
   - **Vì sao không còn ghi `xdev-hive` vào `.mcp.json`** (roadmap 38b): `.mcp.json` đi theo git nên phải giống nhau ở mọi máy, mà mục này gọi shim theo đường dẫn riêng của từng máy. Trước đây mục ghi `"command": "hive-mcp"`, chỉ chạy khi thư mục shim nằm trong `PATH` — chương trình mở từ Finder, Explorer hay Dock không có `PATH` của shell, nên Claude Code báo *Connection closed* (Windows) hoặc *Executable not found in $PATH: hive-mcp* (macOS, 3/10, dù `~/.local/bin/hive-mcp` có sẵn). Nay mục nằm ở scope local với đường dẫn đầy đủ của shim; Windows bọc `cmd /c` vì client MCP chạy server không qua shell, mà shim và `npx` đều là `.cmd`. Cài lại sẽ gỡ mục `xdev-hive` cũ khỏi `.mcp.json` (mục `xdev-hive` do bạn tự thêm, lệnh khác `hive-mcp`, thì giữ nguyên). Windows có bật codegraph thì scope local thêm `codegraph` bọc `cmd /c` đè lên mục trong `.mcp.json`, còn `.mcp.json` vẫn giữ dạng `npx` cho các máy khác.
4. **Đồng bộ tài liệu**: lần đầu nhập `AGENTS.md` / `docs/decisions.md` sẵn có vào Hive, sau đó render lại và commit. Hub đã có trang `agents` khác nội dung thì `AGENTS.md` của repo được giữ nguyên; dùng *Đề xuất nhập vào Hive* trong báo cáo đồng bộ để gửi nội dung đó lên.

Đồng bộ từ hub: trên web, *Quản trị* → *Context agent* → *Yêu cầu máy đồng bộ*. Cần quyền Context agent của service.
- Mỗi máy online có repo của service nhận yêu cầu ở heartbeat kế tiếp, rồi làm như nút *Đồng bộ*: ghi context vào repo và đưa tài liệu của repo lên Hive.
- Thẻ *Đồng bộ trên các máy* hiện lần cuối của từng máy: số file đổi, commit, số trang từ repo, hoặc lỗi.
- Yêu cầu không được nhận hay làm xong trong 15 phút thì hết hạn. App cũ hơn 0.89.0 không nhận yêu cầu này.

`core.hooksPath` là cấu hình local của git: mỗi người clone repo cần bấm cài *Cấu hình agent* một lần trong *Cài đặt máy*, hoặc chạy `git config core.hooksPath .githooks`.

## Board: chạy agent và xoay vòng quota

```
queued ─chọn gói─▶ running ─exit 0──────▶ succeeded ─(review chéo)─▶ run review, vendor khác
                     ├─ báo hết quota ──▶ rate_limited ─▶ gói nghỉ đến giờ reset, lần sau chạy gói khác
                     ├─ không có CLI ───▶ failed ───────▶ gói nghỉ 10 phút, lần sau chạy gói khác
                     └─ lỗi / huỷ / quá giờ ─▶ failed / cancelled, task về "Chưa làm"
```

- **Profile = một gói sub** (trang *Gói sub & agent*): lệnh, tham số, biến môi trường, vai trò (lập kế hoạch / làm task / review), ưu tiên, số chạy song song, thời gian nghỉ mặc định, giới hạn mỗi run.
- **Chọn gói**: gói được ghim > bỏ qua gói tắt/đang bận/đang nghỉ/sai vai trò/đã thử ở run này > review dùng vendor khác người làm > *Ưu tiên loại gói* nếu có > gói có kỳ quota reset sớm hơn > gói còn nhiều quota hơn > ưu tiên thấp chạy trước > cùng ưu tiên thì gói lâu chưa dùng chạy trước. Log run có dòng `# Chọn gói <id>: <lý do>`.
  - **OpenCode** (63d): thêm tài khoản ở *Agent và quota*, terminal chạy `opencode auth login` để chọn provider và OAuth/API key; không nhập key vào Hive. Mỗi profile có bốn thư mục XDG riêng dưới `~/.xdev-hive/accounts/<id>/{config,data,cache,state}` (có thể đổi trong env). Template OpenCode ban đầu tắt: cấu hình model rồi bật profile. Chọn `provider/model` và model phụ trong profile; `opencode models` cung cấp catalog của profile cho bộ chọn. Bảng model hub có cột OpenCode cho light/standard/strong/max, mặc định trống vì backend và quyền dùng khác nhau. Model phụ để trống dùng model chính, không tự fallback sang backend/model khác khi bị từ chối.
    - Runner dùng `opencode run --format json`, parser native theo mã nguồn 1.18.35: text, tool_use, step_finish (token/cache/cost), sessionID và error. Session tiếp tục bằng `--session <id>`/`--continue` của CLI; steering trong run dùng file `.xdev-hive/steer.md`. Token/cost được cộng theo step, không suy ra quota còn lại; quota hiện chưa biết vì `stats` chỉ đo đã dùng.
    - Hive MCP và các MCP catalog được truyền qua config của run, cùng danh tính profile/task/run; container dùng HTTP MCP của hub. Policy thu hẹp model (kể cả model phụ), tool và MCP; cấu hình repo bị tắt. Quyền edit cho sửa file, chặn shell tùy ý; full (`--auto`) cho shell, chặn external_directory/subagent. Đây là quyền tool, không phải sandbox hệ điều hành; cần Docker image có OpenCode và thêm host backend vào allowlist để cách ly.
    - Cài `npm install -g opencode-ai` ở danh mục tool; nếu launcher npm không tương thích OS/glibc/musl, dùng [installer chính thức](https://opencode.ai/docs/) và kiểm lại `opencode --version`. [CLI](https://opencode.ai/docs/cli/), [quyền](https://opencode.ai/docs/permissions/), [providers](https://opencode.ai/docs/providers/), [Zen](https://opencode.ai/docs/zen/). Free pool luân phiên, quyền free/thẻ/retention theo endpoint và OAuth/refresh thực tế chưa kiểm chứng; không bảo đảm miễn phí hay đăng nhập hợp lệ chỉ từ credential.
  - **Ưu tiên loại gói** (roadmap 24c): form giao run (Board, *Chạy trên máy* ở trang Task, *Prompt cho agent*, *Giao cho agent*; API `runs.dispatch`, `runs.prompt`, `runs.dispatchMany` với `preferKind`: `claude` | `codex` | `gemini`) chọn được một loại khi không ghim gói. Còn gói loại đó dùng được (bật, có CLI, đã đăng nhập, chưa chạm ngưỡng, không đang nghỉ) thì run **chờ** nó, kể cả khi nó đang bận (Board ghi *Đang chờ gói codex rảnh*). Mọi gói loại đó không dùng được thì run chạy trên loại khác. Run ghim gói không đổi. Run thử lại và review sau đó giữ lựa chọn này; review chéo vẫn phải dùng vendor khác người làm.
  - **Reset sớm dùng trước** (roadmap 24c): giữa các gói còn quota, gói có kỳ giới hạn reset sớm hơn chạy trước, để quota sắp reset không bị bỏ phí. Kỳ được tính là kỳ chặn gói trước (phiên hay tuần, kỳ nào còn ít điểm hơn trước ngưỡng dừng). Giờ reset đọc từ chữ `/usage` in ra, có múi giờ: `Oct 8 at 5:59pm (Asia/Saigon)`, `6:20pm (Asia/Saigon)` (hôm nay, đã qua thì ngày mai), `Oct 8, 6pm (Asia/Ho_Chi_Minh)`. Không đọc được (Codex, Gemini, chữ lạ) thì coi như không biết và xếp sau gói biết giờ reset.
  - Review chéo **chờ** gói của vendor khác khi gói đó chỉ đang bận (Board ghi lý do). Chỉ khi mọi gói vendor khác đều tắt, đang nghỉ vì quota hay chạm ngưỡng thì mới review bằng cùng vendor, để không bị kẹt hàng giờ.
  - Agent review được dặn không gọi `task_claim` / `task_update`: task vẫn thuộc run làm task.
- **Hết quota**: nhận diện từ cuối output khi CLI thoát lỗi (`usage limit`, `429`, `RESOURCE_EXHAUSTED`…). Đọc giờ reset nếu có (`|<epoch>`, `try again in 2 hours 13 minutes`, `resets 3pm`, ISO), không có thì dùng thời gian nghỉ mặc định. Phần làm dở được commit `wip`, lần sau chạy tiếp trên cùng branch với prompt "tiếp tục từ lần trước".
- **Kilo Code CLI** (63e): loại profile `kilo`, CLI `@kilocode/cli` 7.8.3 (catalog pin; image có `KILO_CLI=7.8.3`), lệnh native `kilo run --format json --pure --model kilo/kilo-auto/free -- <prompt>`. Mặc định cho đọc/sửa file, shell cần duyệt bị từ chối trong headless; thêm `--auto` cho quyền tool full (vẫn deny thư mục ngoài worktree), không phải sandbox OS. Container là ranh giới máy chủ. Parser riêng giữ summary/session, cộng tokens/cost `step_finish`, giữ lỗi JSON dù exit 0; không retry bằng model mặc định có thể trả phí. MCP Hive nhận đúng profile/task/run và read-only, catalog MCP theo policy. `--session <id>`/`--continue` là native resume; steering dùng file `.xdev-hive/steer.md`.
  - *Thêm tài khoản Kilo* hoặc *Đăng nhập* mở `kilo auth login` chính thức trong terminal; người dùng chọn Kilo account hoặc provider key ở đó. Profile thứ hai tách cả bốn thư mục XDG, credential ở `XDG_DATA_HOME/kilo/auth.json`. Credential có mặt không chứng minh token còn hiệu lực; hai account thật/refresh chưa kiểm. Run có config riêng, không nạp custom provider endpoint từ config người dùng.
  - Bộ chọn 54c dùng `kilo/kilo-auto/free` cho light/standard/strong/max và model phụ, không hứa các tier có chất lượng khác nhau. Catalog `kilo models kilo` chỉ phản ánh model có mặt, không chứng minh quyền dùng miễn phí của account. Quota account còn lại chưa có API xác minh; tokens/cost đã dùng không là quota, 200 request/giờ/IP chỉ là gateway anonymous. Free pool luân phiên, card/signup và điều khoản headless chưa kiểm bằng account; endpoint có thể ghi prompt hoặc hạn chế dữ liệu nhạy cảm: [free/data guide](https://kilo.ai/docs/getting-started/using-kilo-for-free), [gateway auth](https://kilo.ai/docs/gateway/authentication), [terms](https://kilo.ai/terms). Không login/inference thật trong test; dùng fake-agent.

- **Worktree**: `~/.xdev-hive/worktrees/<dự án>/<task>` trên branch `ai/<task>`, không đụng checkout chính. Branch mới của task bắt đầu từ branch đích lấy mới từ remote (`targetBranch` của service, không có thì nhánh mặc định của remote), để task chạy ngay sau khi task nó phụ thuộc được merge trên GitHub/GitLab có code đó. Runner chỉ `git fetch`, không checkout hay reset checkout của bạn. Repo không có remote hoặc fetch lỗi thì bắt đầu từ HEAD của repo như trước, và log run ghi lại lý do. Branch đã có (run tiếp, review, bản được giữ của best-of-n) đi tiếp từ lịch sử của nó. Runner commit phần agent để lại và không push. Lúc commit, runner không chạy git hook nào, vì agent có thể đã ghi hook vào `.githooks` của worktree. `AGENTS.md`, `CLAUDE.md`, `docs/decisions.md`, `.claude/rules/xdev-hive/`, `.xdev-hive/context/`, `.xdev-hive/artifacts/` và các `AGENTS.md` lồng / skill có khối của Hive không được đưa vào commit này, không hiện ở mục chưa commit trong tóm tắt run, và không nằm trong diff *Xem thay đổi*. File config agent chưa commit được chép vào worktree nhưng không đưa vào branch. Thư mục `.codex/` và `.agents/` mà CLI agent tự ghi vào worktree cũng không vào commit, trừ khi branch đã có file trong thư mục đó (service cố ý giữ). Codex 0.157 chép thiết lập Claude Code của repo sang đó khi bật `external-agent-import-sync-enabled` trong `~/.codex/config.toml`; khoá này không tắt được cho từng run (`-c` bị bỏ qua).
- **Quản trị worktree (63f)**: trên web, mở *Máy & agent* → máy → *Worktree* (chủ máy hoặc admin hub); trên desktop, mở *Agent* → *Worktree*. Danh sách theo service có trạng thái task, branch, dung lượng ổ đĩa, lần sửa cuối, thay đổi chưa commit và trạng thái đã vào nhánh đích. Xoá một hoặc nhiều worktree cần xác nhận; worktree có run queued/running hoặc đang hoàn tất không xoá được. Lệnh web ghim trạng thái đã xem, máy kiểm tra lại và báo kết quả qua heartbeat; lệnh hết hạn sau 24 giờ. Branch luôn giữ lại để runner tạo lại worktree từ branch khi mở lại task.
  - Tự dọn mặc định bật: task `done`, không có run, không còn thay đổi chưa commit và branch đã vào nhánh đích, hoặc task done quá **30 ngày**. Có thể đổi thời gian giữ và ngưỡng ổ trống (mặc định **10 GiB**); ổ thiếu chỗ thì dọn worktree đủ điều kiện từ cũ nhất. Giữ 500 dòng nhật ký ở `runs.db`, gửi 50 dòng mới nhất cho hub. Dọn sau MR/PR merge cũng giữ branch và tuân theo bật/tắt tự dọn của máy.
  - Đo mỗi phút, không đi theo symlink; chỉ quản trị worktree đã đăng ký với Git có branch `ai/<task>` trong thư mục worktree của runner. Branch đã vào main dựa trên ancestry sau fetch nhánh đích; fetch lỗi thì chưa rõ, merge squash có thể chờ thời gian giữ. Dung lượng là số byte ổ đĩa `du` đo, không gồm checkout được liên kết qua symlink. `node_modules` vẫn riêng theo worktree: chia sẻ bằng symlink với npm workspaces chưa được kiểm chứng an toàn.

- **Context của Hive trong worktree**: trước mỗi run (làm task, review, sửa CI, giám khảo), runner ghi vào worktree bản mới nhất từ hub: `AGENTS.md` chính và lồng, `CLAUDE.md` (`@AGENTS.md`), `docs/decisions.md`, `.claude/rules/xdev-hive/` và `.claude/skills/<tên>/SKILL.md`. Nhờ vậy repo chưa merge MR context vẫn có quy ước cho agent. Log run ghi một dòng `# hive context: <n> file (<m> ghi mới), bỏ qua <k>`; hub lỗi hay quá 30 giây thì run chạy tiếp với file của nhánh và log ghi lý do.
  - **Không đè file của repo**: `AGENTS.md` chính, `AGENTS.md` lồng và skill đã có sẵn mà không chứa khối của Hive là của repo, giữ nguyên. Khi `AGENTS.md` chính được giữ, phần của Hive ghi vào `.xdev-hive/context/AGENTS.md`, `CLAUDE.md` import thêm file đó, và prompt nhắc agent đọc nó (Codex và Gemini không đọc import của `CLAUDE.md`).
- **Repo tham chiếu (chỉ đọc)**: nút *Repo tham chiếu* ở mỗi service trong *Service & công cụ* chọn các service cùng hệ thống mà máy này có repo, ví dụ task của `svc-core` cần đọc `svc-core-old` (SQLMaps, ViewModel). Trước mỗi run, runner đọc nhánh và commit hiện tại của từng checkout chính đó và ghi vào log một dòng `# references (read-only): <dự án> <đường dẫn> (<nhánh> <commit>)`; service đã bị bỏ hay thư mục không còn là repo git thì bỏ qua và log ghi lý do, run vẫn chạy. Prompt liệt kê đường dẫn, nhánh, commit của từng repo, dặn không sửa gì trong đó, và nhắc `AGENTS.md` / `CLAUDE.md` của các repo đó là của service khác nên vẫn giữ project key của task.
  - Claude Code: thêm `--add-dir <checkout>` cho từng repo (worktree vẫn đứng đầu), và `permissions.deny` trong `--settings` chặn `Write`, `Edit`, `MultiEdit`, `NotebookEdit` vào đường dẫn đó. Ghi cả hai dạng `<đường dẫn>/**` và `/<đường dẫn>/**` vì [Chưa kiểm] cú pháp đường dẫn tuyệt đối của quy tắc. Quy tắc theo đường dẫn không chặn được `Bash`.
  - Codex: không thêm tham số nào. `--sandbox workspace-write` đã giới hạn ghi trong worktree, còn khai báo `sandbox_workspace_write.writable_roots` thì lại *cấp* quyền ghi nên không dùng; Codex chỉ biết các repo này qua prompt. [Chưa kiểm] sandbox cho đọc ngoài worktree đến đâu.
  - Container: mỗi repo tham chiếu được gắn `-v <đường dẫn>:<đường dẫn>:ro`, nên ở đó cả lệnh shell cũng không ghi được. Chạy thẳng trên máy thì chỉ prompt và quy tắc deny giữ: profile chạy `--permission-mode bypassPermissions` hay `--sandbox danger-full-access` vẫn ghi được vào repo tham chiếu.
- **File agent làm ra** (roadmap 41c, chỉ chế độ hub): prompt dặn agent ghi ảnh chụp, báo cáo, kết quả đo hay bản plan vào `.xdev-hive/artifacts/` của worktree. Thư mục đó không vào commit, không vào diff và không tính là chưa commit; khi run xong runner đẩy file lên hub, gắn với run và task, nên branch bị xoá hay máy đổi vẫn còn.
  - Giới hạn: tối đa 20 file mỗi run, mỗi file 5 MB; chỉ `png`, `jpg`, `webp`, `pdf`, hoặc chữ `md`, `txt`, `json`, `log`. File vượt giới hạn hay sai loại ở lại trên máy, log run ghi một dòng cho từng file.
  - Hub che dòng trông như secret trong file chữ (`redactLines`) và từ chối file chữ có ký tự ẩn. Bytes nằm trên SeaweedFS theo SHA-256 như tệp của tài liệu, không có store thì nằm trong database.
  - Xem ở web: mục *Artifact* trong panel task và trong chi tiết run (xem ảnh, tải file). Agent đọc lại bằng `artifact_list` / `artifact_get` của MCP. Artifact không tự xoá; quản trị service xoá được và việc xoá vào nhật ký.
- **Không chạy cấu hình trong repo** (profile loại Claude Code): runner thêm `--settings '{"disableAllHooks":true}' --setting-sources user --strict-mcp-config --mcp-config <…>` vào cuối tham số. Agent sửa được hook, `.mcp.json` và `.claude/settings.json` trong worktree, và run sau sẽ chạy những thứ đó, nên run không đọc chúng.
  - Server MCP do app liệt kê: `xdev-hive` (`HIVE_AGENT` = id profile); thêm codegraph bản ghim nếu `.mcp.json` ở checkout chính có codegraph.
  - Các tool của những server đó được cho phép sẵn (`permissions.allow` trong `--settings`): chạy headless, Claude Code từ chối mọi tool chưa được cho phép, và agent sẽ không claim task hay ghi memory được.
  - Superpowers được bật nếu `.claude/settings.json` ở checkout chính bật, nhưng hook của plugin vẫn tắt.
  - Cài đặt của bạn trong `~/.claude/settings.json` vẫn được dùng, trừ hook.
  - `--setting-sources user` cũng làm Claude Code bỏ qua CLAUDE.md của service. Runner nạp lại nó bằng `--add-dir <worktree>` và `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`; các file CLAUDE.md import (như `@AGENTS.md`) cũng được nạp. Đã kiểm với Claude Code 2.1.283.
  - [Chưa kiểm] Với `--setting-sources user`, chưa rõ Claude Code có nạp skill ở `.claude/skills/` và rules ở `.claude/rules/` của worktree không. Mục *Skills* trong `AGENTS.md` liệt kê tên và mô tả từng skill, nên agent vẫn gọi được `skill_get` qua MCP nếu không.
  - Cần hook của repo thì tạo profile loại *Tuỳ chỉnh*: runner để nguyên tham số của loại này.
  - Codex giữ sandbox `workspace-write` (`--sandbox workspace-write`). Codex 0.15x bỏ cờ `--full-auto`: profile cũ còn cờ đó được đổi sang `--sandbox workspace-write` lúc chạy (bản Codex cũ cũng nhận cờ này).
  - Codex 0.15x hỏi trước mỗi lần gọi tool MCP có ghi (`task_claim`, `memory_write`…), mà run headless không có ai trả lời nên bị từ chối. Run `codex exec …` của Hive thêm `-c mcp_servers.xdev-hive.default_tools_approval_mode="approve"` (container: server `hive`), và block Hive trong `~/.codex/config.toml` cũng có dòng đó; chỉ tool của Hive được cho qua.
  - Run Codex cũng đặt `-c mcp_servers.xdev-hive.env={HIVE_AGENT="<id profile>",HIVE_PROJECT=…,HIVE_TASK=…,HIVE_RUN=…}` như Claude Code: `~/.codex/config.toml` chỉ ghi `codex`, nên agent claim task dưới tên khác runner và giữ lease 2 giờ, chặn run sau của task.
- **Hive**: runner `task_claim` trước khi chạy với cùng tên agent như `hive-mcp` (`HIVE_AGENT` = id profile). Xong thì chuyển task sang *Chờ review* kèm tóm tắt, trừ khi agent đã tự làm qua MCP. Review chéo được nối vào ghi chú task.
- Lịch sử run và log nằm ở `~/.xdev-hive/runs.db` và `~/.xdev-hive/runs/<id>.log`. Log có prompt và output, **không** ghi biến môi trường.
- App mở từ Finder có `PATH` ngắn, nên runner lấy `PATH` từ login shell (`$SHELL -ilc`) cộng thư mục shim (`~/.local/bin`, Windows `%USERPROFILE%\.xdev-hive\bin`). Dùng nút *Kiểm tra CLI* để xem lệnh có tìm thấy không.
- **Đăng nhập CLI**: app tự hỏi CLI của từng profile đã đăng nhập chưa.
  - Lệnh dùng: `claude auth status --json` và `codex login status`, chạy với env của profile (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), nên gói thứ hai được kiểm riêng.
  - Khi nào kiểm: lúc mở app, mỗi 10 phút, khi sửa profile và khi bấm *Kiểm tra CLI*.
  - Gói chưa đăng nhập bị runner bỏ qua. Thẻ profile hiện lệnh đăng nhập kèm thư mục đăng nhập, không kèm env khác. Run đang chờ vì mọi gói đều chưa đăng nhập thì Board ghi rõ lý do.
  - Nút *Đăng nhập* (Claude Code, Codex) mở một cửa sổ terminal chạy sẵn lệnh đó: Terminal trên macOS, `cmd` trên Windows, hoặc terminal đầu tiên tìm thấy trên Linux (`x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `xterm`).
  - Lệnh nằm trong một script ở `~/.xdev-hive/login/<profile>/`, quyền `0700`. Script chỉ chứa biến thư mục đăng nhập (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), không chứa key hay token.
  - Quay lại cửa sổ app thì app kiểm lại các gói chưa đăng nhập.
  - Gemini mở đăng nhập Google / API key bằng CLI chính thức trong terminal; tài khoản bổ sung dùng `GEMINI_CLI_HOME` (thư mục gốc, CLI thêm `.gemini`). Hive kiểm cache OAuth / cấu hình key cục bộ: có cấu hình vẫn là "chưa rõ", không gọi model để xác thực. CLI tuỳ chỉnh để "chưa rõ".
  - Copilot CLI chưa có lệnh xem trạng thái được app xác minh; nút *Đăng nhập* dùng `copilot login --web-flow` hoặc `--device-code`.
- **Tự code bằng một gói** (roadmap 32a): nút *Mở Claude Code* / *Mở Codex* trên thẻ gói (*Agent và quota*, chọn service) và ở hàng service (*Service & công cụ*, chọn gói) mở terminal chạy CLI của gói đó trong repo service.
  - Đây là phiên của bạn, không phải run: không `-p`, không cờ của run, không theo chính sách agent và không tính vào trần chi tiêu. MCP, hook và cài đặt của bạn và của repo vẫn dùng như khi tự gõ `claude`.
  - Hive biết phiên là của gói nào: Claude Code nhận `--mcp-config` với server `xdev-hive` có `HIVE_AGENT` = id gói. Server này thay server cùng tên trong `.mcp.json` của repo (đã kiểm trên Claude Code 2.1.283). Codex nhận `-c mcp_servers.xdev-hive.command/env`.
  - Script ở `~/.xdev-hive/cli/<gói>/`: chỉ có thư mục đăng nhập, `PATH` của runner (trừ Windows) và `HIVE_AGENT` / `HIVE_PROJECT`, không có key hay token. Repo không còn thì script dừng thay vì chạy ở thư mục khác.
  - Gói biết là chưa đăng nhập thì app báo lỗi; bấm *Đăng nhập* trước.
- **Log trực tiếp** (Claude Code): runner thêm `--output-format stream-json --verbose`, trừ khi profile đã tự chọn định dạng (`json`: chỉ có kết quả lúc xong).
  - Log run ghi từng bước ngay khi agent làm: lời agent nói, `▶` lệnh hay tool nó gọi (`Bash: mvn -B verify`, `Edit src/…`, `memory_search …`), `✓` / `✗` và dòng đầu của kết quả. Không ghi sự kiện JSON thô.
  - Board hiện việc agent đang làm dưới trạng thái run (bảng Lượt chạy, chi tiết run, tooltip trên thẻ task): tóm tắt của Claude Code, không có thì tool nó vừa gọi. Codex và Gemini dùng sự kiện tool và message native; CLI tuỳ chỉnh dùng dòng cuối nó in ra.
  - Khung log trong chi tiết run mở ở cuối (các bước và kết quả), tự theo khi run đang chạy, có nút *Mở rộng* cho khung cao hơn.
- **Chi phí run** (Claude Code): lấy từ sự kiện kết quả của stream: câu trả lời cuối làm tóm tắt run, `total_cost_usd`, token vào (tính cả cache) và token ra.
  - Log run có thêm mục `## Result` và dòng `# cost`.
  - Board hiện chi phí từng run; thẻ Gói sub hiện tổng theo gói.
  - Đây là ước tính theo giá API: gói sub (Pro/Max) không bị tính khoản này, nhưng nó cho biết run nào tốn nhiều.
  - Gemini có token usage từng run; quota còn lại của tài khoản chưa rõ. Codex đọc quota từ session cục bộ.
  - **Trên hub**: ở chế độ hub, mỗi heartbeat gửi chi phí các run đã xong mà hub chưa nhận (tối đa 100 run mỗi lần). Máy chỉ đánh dấu đã gửi khi hub trả lời, nên máy offline lâu vẫn gửi bù được. Hub giữ bản báo đầu tiên của mỗi run và xoá run cũ hơn 90 ngày.
  - Trang *Bản đồ agent* có mục *Chi phí ước tính*: tổng 24 giờ, 7 ngày, 30 ngày, và bảng theo service, theo gói (máy · tài khoản). Người xem chỉ thấy các service mình có quyền.
  - **Token theo loại** (roadmap 28c): run lưu riêng input đọc mới, input ghi vào prompt cache, input đọc từ cache, và output. Claude Code lấy từ kết quả cuối; Codex chạy thêm `--json` (log vẫn là các bước dễ đọc), cộng `turn.completed` của mọi lượt, phần `cached_input_tokens` được tách khỏi input. Log run có dòng `# cost … · tokens in … cache write … cache read … out … · N% from cache`; *Lượt chạy* (máy này và hub) hiện các số đó, *Chi phí* có cột *Đọc cache* theo service và gói, và tỉ lệ chung. Run từ app cũ hơn 0.103 chỉ có một số input, cột hiện "—".
  - Run Codex (không có giá) giờ cũng được báo lên hub với giá 0, nên trần chi tiêu theo *số run* tính cả chúng.
  - **Trần output** (roadmap 28c): ở *Chính sách agent*, mặc định của hub và từng service đặt được trần token cho mỗi lần gọi MCP và trần ký tự cho output mỗi lệnh Bash; runner đưa vào run Claude Code dưới dạng `MAX_MCP_OUTPUT_TOKENS` và `BASH_MAX_OUTPUT_LENGTH` (số nhỏ hơn giữa chính sách và profile). Service chỉ hạ được trần của hub. Codex và Gemini không có cài đặt này.
- **Mức dùng của gói sub** (Claude Code): cùng lúc với lượt kiểm đăng nhập, app chạy `claude -p /usage` cho từng profile đã đăng nhập.
  - Cách chạy: env của profile, không hook, không server MCP, chỉ cài đặt của user. Lệnh trả lời tại máy, không gọi model và không tốn quota.
  - Hiển thị: % đã dùng của phiên (khoảng 5 giờ) và của tuần, kèm giờ reset. Thẻ Gói sub, dải gói trên Board và trang *Bản đồ agent* đều có; từ 80% thì tô màu cảnh báo.
  - Ngưỡng dừng: mỗi profile có *Dừng khi phiên đạt* (mặc định 95%) và *Dừng khi tuần đạt* (mặc định 90%). Tới một trong hai ngưỡng thì runner không bắt đầu run mới trên gói đó mà chuyển sang gói khác; run đang chạy vẫn chạy xong. Đặt 100 nếu chỉ muốn dừng khi CLI tự báo hết quota.
  - Gemini có token usage từng run; quota còn lại của tài khoản chưa rõ. Codex đọc quota từ session cục bộ. Mọi CLI vẫn có cách cũ: run gặp lỗi hết quota thì gói nghỉ đến giờ reset.
- **Trên hub**: heartbeat báo trạng thái đăng nhập, cài CLI và giờ nghỉ của từng gói. Trang *Bản đồ agent* (mọi người) và *Đội máy* (admin) hiện gói nào tắt, chưa có CLI, chưa đăng nhập, đang nghỉ đến giờ nào, hoặc sẵn sàng.

Hai gói của cùng một vendor: tạo 2 profile, profile thứ hai trỏ CLI sang thư mục đăng nhập riêng, rồi đăng nhập một lần trong terminal với biến đó, ví dụ `CLAUDE_CONFIG_DIR=~/.claude-2` (Claude Code) hoặc `CODEX_HOME=~/.codex-2` (Codex). Tên biến và cờ headless mặc định lấy theo tài liệu CLI mình biết; hãy kiểm tra bằng `--help` của bản bạn đang cài.

**GitHub Copilot CLI** (`copilot`, gói cài `@github/copilot`): profile mẫu chạy `-p`, `--no-ask-user`, `--output-format json` (JSONL), cho đọc/sửa file và từ chối shell tự động. Runner cấu hình MCP xdev-hive cho từng run; model router dùng `auto` cho mọi cấp để tài khoản Free/Student không bị chọn model ngoài quyền. Có thể ghim `--model` trong profile paid sau khi tự kiểm tra quyền. Parser lấy câu trả lời, lỗi và token nếu CLI phát các event tương ứng; quota tài khoản và giá USD chưa có nguồn CLI được app kiểm chứng, nên hiện *chưa rõ*. Một người dùng máy chỉ có một tài khoản Copilot do app quản lý: `COPILOT_HOME` tách config/session, nhưng OAuth còn có thể nằm trong OS keychain chung. App chưa kiểm chứng account isolation, sandbox tương đương `workspace-write` hay giới hạn AI credits thực nhận. Xem [billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing), [đăng nhập](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli), [headless](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference), [sandbox](https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/configuring-local-sandbox-settings).

Cờ mặc định là mức "cho sửa file" (`--permission-mode acceptEdits`, `--sandbox workspace-write`, `--approval-mode auto_edit`). Muốn agent tự chạy test hay lệnh shell thì mở rộng tham số của profile, và cân nhắc rủi ro vì lệnh chạy trên máy thật (worktree không phải sandbox), hoặc cho profile chạy trong container.

### Chạy nhiều bản, giữ bản tốt nhất (best-of-n)

Ô *Số bản* khi chạy agent với việc *Làm* và *Tự xoay vòng theo quota* (hỏi ngày 28/9: giám khảo là agent so sánh các bản; mỗi bản một gói sub khác nhau).

```
bản c1 (gói A) ─┐
bản c2 (gói B) ─┼─ xong hết ─▶ giám khảo (vendor khác) ─"Winner: c2"─▶ ai/<task> = bản c2 ─▶ review chéo / MR như thường
bản c3 (gói C) ─┘
```

- **Mỗi bản** chạy trong worktree `…/<dự án>/<task>+c<n>` trên branch `ai/<task>+c<n>`, bắt đầu từ `ai/<task>` (hoặc `HEAD` nếu task chưa có branch). Nhóm mới luôn bắt đầu lại từ đó, không nối tiếp bản của nhóm cũ.
- **Chọn gói**: mỗi bản ưu tiên gói chưa bản nào dùng, rồi vendor chưa bản nào dùng. Thiếu gói thì dùng lại gói của bản khác, chạy lần lượt theo số chạy song song của gói. Bản nào hết quota thì xoay sang gói khác như run thường, trên cùng branch của bản đó.
- **Task trên Hive**: runner giữ lease cho cả nhóm. Prompt dặn từng bản không gọi `task_update`. Task chỉ được cập nhật một lần, khi nhóm đã chọn xong.
- **Giám khảo**: một run review chạy trong worktree `ai/<task>`, ưu tiên vendor khác các bản. Prompt liệt kê branch, lệnh `git diff` và báo cáo của từng bản (bọc lại như dữ liệu), dặn không sửa file, và bắt kết thúc bằng hai dòng `Winner: c<n>` và `Reason: …`. Runner không commit gì của giám khảo.
- **Khi chọn xong**: `ai/<task>` chuyển sang commit của bản được giữ (thứ giám khảo để lại trong worktree bị bỏ). Worktree của các bản bị xoá, branch `ai/<task>+c<n>` vẫn giữ để xem lại (nút *Xem thay đổi* trên Board). Task chuyển sang *Chờ review* với tóm tắt của bản được giữ và lý do chọn, rồi đi tiếp như sau một run làm task: review chéo tránh vendor của bản được giữ, hoặc tạo MR.
- **Chỉ một bản xong** thì giữ luôn bản đó, không cần giám khảo. **Không bản nào xong** thì task về *Chưa làm*, ghi chú nêu lỗi của từng bản.
- **Giám khảo không chọn được** (lỗi, bị huỷ, không có dòng `Winner`, hoặc chọn bản chưa xong): task chuyển sang *Chờ review* với ghi chú, các bản giữ nguyên worktree, và mỗi bản đã xong có nút *Giữ bản này* trên Board. Nút bị từ chối nếu task đã có run mới sau nhóm, để không ghi đè việc đó.
- Board ghi `bản n/N` hoặc `giám khảo` cạnh run, và `được giữ` / `không giữ` sau khi chọn. Thông báo của app chỉ báo lúc giám khảo bắt đầu, lúc giữ một bản, hoặc lúc cần chọn tay, không báo từng bản.

### Chạy trong container (Docker)

Profile có ô *Chạy trong container (Docker)* (hỏi ngày 28/9: bật theo từng profile, mặc định tắt). Khi bật, runner gọi `docker run` thay vì chạy CLI thẳng trên máy.

1. Build image một lần trên máy (có sẵn Claude Code, Codex, Gemini CLI, git):

   ```bash
   docker build -t xdev-hive-agent https://github.com/tdduydev/xdev-hive.git#main:docker/agent
   ```

2. Bật ô trong profile. Image mặc định `xdev-hive-agent`, đổi được.

- **Container thấy gì**:
  - worktree của task và `.git` của repo, gắn đúng đường dẫn như trên máy (nên đường dẫn trong prompt và liên kết worktree của git vẫn đúng);
  - thư mục đăng nhập của CLI: `~/.claude` và `~/.claude.json`, `~/.codex` (hoặc `CODEX_HOME`), `~/.gemini`;
  - `~/.gitconfig` (chỉ đọc).
  Phần còn lại của home là tmpfs rỗng.
- Container chạy bằng uid:gid của bạn, nên file tạo ra vẫn thuộc về bạn. `--rm`, `--init`, tên `hive-<run>`. Huỷ run hay hết giờ thì runner gọi thêm `docker kill`.
- **Biến môi trường**: chỉ `HIVE_*`, `env` của profile và biến cần cho lệnh; biến khác của máy không vào container. Docker nhận **tên** biến (`-e NAME`), giá trị lấy từ môi trường của chính docker, nên không hiện trong danh sách tiến trình.
- **Công cụ Hive (MCP)** ở chế độ hub: agent trong container nói chuyện với MCP HTTP của hub bằng token của máy. Header `x-hive-project`/`x-hive-readonly` chỉ thu hẹp quyền của token.
  - Claude Code: `--mcp-config` trỏ tới một file quyền 0600, gắn chỉ đọc, xoá khi run xong.
  - Codex: `-c` tắt server `xdev-hive` (shim của máy, container không có) và thêm server HTTP `hive`. Token đọc từ biến `HIVE_HUB_TOKEN`.
  - Gemini CLI: image có sẵn `/etc/gemini-cli/settings.json`, thay cho server `xdev-hive` trong `.gemini/settings.json` của repo. File này lấy giá trị từ `HIVE_HUB_URL`, `HIVE_HUB_TOKEN`… (tắt folder trust vì container chỉ thấy worktree). Image cũ cần build lại.
  - Chế độ cục bộ: container chưa có công cụ Hive, nhưng runner vẫn nhận và cập nhật task như thường.
- **Claude Code trên macOS**: đăng nhập nằm trong Keychain, container không đọc được.
  - Tạo token dài hạn một lần: nút *Tạo token trong terminal* trên thẻ profile chạy `claude setup-token` (cần gói Pro/Max/Team). Dán token vào ô *Token container* rồi bấm *Lưu token*.
  - App lưu token trong config (quyền 0600), không gửi lại giao diện, và chỉ run trong container nhận nó qua `CLAUDE_CODE_OAUTH_TOKEN`. Đổi id profile thì token đi theo; xoá profile thì token bị xoá.
  - Trên Linux, đăng nhập nằm trong `~/.claude` nên không cần token.
- Máy không có `docker` thì run coi như gói không chạy được và chuyển sang gói khác.
- **Mạng giới hạn** (mặc định, hỏi ngày 28/9): mỗi run có một Docker network riêng `--internal`, không có đường ra ngoài, và một container proxy (cùng image, `docker/agent/egress.mjs`).
  - Proxy nằm cả trên network đó lẫn bridge của Docker. Nó chỉ cho qua các host được phép: HTTPS qua `CONNECT` (proxy không đọc được bên trong), HTTP thì chuyển tiếp.
  - Agent nhận `HTTPS_PROXY`/`HTTP_PROXY` (kèm `NODE_USE_ENV_PROXY=1` cho `fetch` của Node). Chương trình nào bỏ qua proxy thì không ra được mạng.
  - Luôn được phép: hub, GitLab của team, API và đăng nhập của Anthropic, OpenAI, Google, npm, PyPI, GitHub.
  - Thêm host trong profile (*Cho phép thêm*): `host`, `.domain` (gồm cả subdomain), `host:port` cho cổng khác 80/443.
  - Host bị chặn được ghi ở phần `## Network` của log run. Run lỗi thì lỗi nêu tên các host đó.
  - Network và proxy bị xoá khi run xong, kể cả khi run lỗi giữa chừng.
  - Chọn *Mở* nếu profile cần mạng thường của Docker.
  - Image cũ cần build lại để có proxy.

## Merge request trên GitLab

Cấu hình ở *Service & công cụ* → **GitLab merge request**: URL, access token (scope `api`, cộng `write_repository` nếu push qua HTTPS), bật *Tự tạo MR*.

```
implement ─(review chéo)─▶ review ── verdict approve ───────▶ push ai/<task> → MR ready
                                  └─ cần sửa / không rõ ─────▶ MR "Draft:" (hoặc không tạo)
implement (không review, chế độ "ngay khi làm xong") ─────────▶ push → MR ready
```

- **GitLab project** đọc từ remote (`git@gitlab.example.com:group/proj.git`, `https://…/group/proj.git`). Không đọc được thì điền ở nút *GitLab* của service. Target mặc định là default branch của project.
- **Push**: remote HTTPS cùng host GitLab thì dùng token qua git config trong env (`GIT_CONFIG_*`), không ghi vào `.git/config` và không hiện trong danh sách tiến trình. Remote SSH dùng key sẵn có, `BatchMode=yes` để không treo chờ nhập. Không bao giờ force push.
- **MR đã có** (cùng source branch, đang mở): chỉ cập nhật tiêu đề, mô tả và *thêm* label, không đổi target hay label người khác đã sửa trên GitLab.
- **Mô tả MR** gồm task, tóm tắt của agent làm, kết quả review, danh sách commit. Output của agent nằm trong code block (dài hơn mọi chuỗi backtick trong output), nên GitLab không chạy quick action (`/merge`, `/approve`…) hay mention từ đó.
- Link MR được ghi vào ghi chú task trong Hive và hiện trên Board. Lỗi GitLab/push được ghi ở run (không làm run thất bại). Có nút *Tạo MR / Cập nhật MR* để chạy tay.
- **Theo dõi MR**: app hỏi GitLab về các MR nó đã mở (30 giây sau khi mở app, rồi mỗi 2 phút; MR của run trong 30 ngày gần nhất). Chu kỳ chỉnh được 1–60 phút ở ô *Hỏi GitLab/GitHub về MR mỗi* (mặc định 2). Lưu là có hiệu lực ngay, không cần mở lại app: lần hỏi sau tính từ lần hỏi trước, nên rút ngắn chu kỳ mà đã quá hạn thì app hỏi luôn.
  - Board hiện trạng thái pipeline (*CI lỗi*, *CI qua*…, bấm để mở pipeline) và MR đã merge hay đóng.
  - MR merge thì task chuyển sang *Xong*, ghi chú task thêm dòng `MR !<iid> merged.`. Tắt được bằng ô *MR merge thì chuyển task sang Xong*.
  - MR bị đóng mà không merge thì task sang trạng thái chọn ở ô *MR đóng mà không merge*: *Bị chặn* (mặc định), *Chưa làm*, hoặc giữ nguyên. Ghi chú task thêm dòng `MR !<iid> closed without merging.` trong cả ba trường hợp. Task đã *Xong* thì không đổi gì. Chọn giữ nguyên mà task đang *Đang làm* thì cũng không đổi gì, vì ghi lại *Đang làm* sẽ lấy lease của người đang giữ task.
  - MR merge và task đã `done` thì app xoá worktree của task (`~/.xdev-hive/worktrees/<dự án>/<task>`), giữ branch `ai/<task>` để mở lại task. Chỉ dọn khi đầu branch và worktree đúng là commit đã merge (head của MR), không còn thay đổi chưa commit, và task không có run chạy, chờ hay đang hoàn tất. File config agent app chép vào và tài liệu Hive render ra không tính là thay đổi. Kết quả và lý do giữ lại được ghi vào ghi chú MR của run trên Board và ở thông báo. Tắt được bằng ô *MR merge và task done thì xoá worktree ở máy* hoặc cài đặt tự dọn của máy. PR GitHub cũng vậy, theo commit đầu của PR.
  - Có thông báo khi MR merge, bị đóng không merge, hoặc pipeline lỗi.
  - MR đã merge hay đóng thì thôi hỏi. Chỉ hỏi MR trên đúng GitLab đã cấu hình, nên token không đi nơi khác.
- **Merge từ web** (roadmap 18c, hỏi 2/10): ở chế độ hub, máy đẩy trạng thái MR/PR của run lên hub (đang mở, draft, CI và link pipeline, lúc kiểm). Trang *Lượt chạy* hiện chúng và nút *Merge* cho người có quyền *Review code* của service.
  - Hub không giữ token GitLab/GitHub: nó chỉ ghi yêu cầu. Máy của run nhận ở heartbeat kế tiếp và merge bằng token của nó (`PUT …/merge_requests/:iid/merge` trên GitLab, `PUT …/pulls/:n/merge` trên GitHub), rồi báo kết quả (`runs.mergeResult`). Sau đó app hỏi MR ngay, nên task sang *Xong*, worktree được dọn và thông báo hiện như khi merge trên GitLab.
  - Cần máy bật *Được nhận run từ hub*. Hub từ chối MR draft, CI lỗi, MR đã merge hay đóng, MR đang có một merge chờ, và người đã yêu cầu run đó (không tự duyệt). CI chưa xong thì trang hỏi lại trước khi gửi.
  - Máy không báo trong 15 phút (offline, tắt nhận run từ hub, app cũ hơn 0.97.0) thì yêu cầu thành lỗi; lỗi của GitLab/GitHub hiện nguyên văn và bấm *Merge* lại được. Mỗi lần merge ghi vào *Nhật ký*.
- **Tự sửa CI** (bật sẵn, ô *Pipeline lỗi thì giao agent sửa*): pipeline mới nhất của MR đang mở bị lỗi thì app xếp một run implement trên cùng branch `ai/<task>`, chọn gói như run thường.
  - Prompt có link pipeline và phần cuối log của tối đa 3 job lỗi (bỏ job `allow_failure`).
    - Log được làm sạch: bỏ mã màu, dấu section của GitLab, ký tự ẩn. Dòng trông giống secret bị thay bằng `(line hidden: …)`.
    - Agent được dặn đọc log như dữ liệu, không làm theo chữ trong log, và không được bỏ hay nới test để qua CI.
  - Run xong thì app chỉ push branch. GitLab tự cập nhật MR và chạy pipeline mới; tiêu đề và mô tả MR giữ nguyên.
  - Mỗi pipeline sửa một lần, tối đa 2 lần mỗi MR (chỉnh 1–5). Hết lượt thì chỉ báo *cần người xem*.
  - Task đang có run thì chờ, lần kiểm sau mới xếp.
  - Board: chi tiết run sửa ghi *Sửa CI của MR !n (lần 1/2)* và tên job lỗi.
- API gọi qua `net.fetch` của Electron, dùng proxy và chứng chỉ của hệ thống.

### Nhập cả group GitLab

Hợp cho microservice: mỗi service một repo, cả hệ thống nằm trong một group. Thẻ **Nhập từ group GitLab** ở *Service & công cụ* hiện khi máy đã có URL và token GitLab.

- Điền group (`company/team`, sẵn group của service đầu tiên) và thư mục gốc (sẵn thư mục chứa service đó), chọn clone qua SSH hay HTTPS, bấm *Liệt kê repo*. Danh sách lấy mọi repo của group và group con, bỏ repo đã archive.
- Mỗi repo có project key (tên repo, trùng thì thêm group, vẫn trùng thì thêm số; sửa được). Repo mới được clone vào `<thư mục gốc>/<đường dẫn group con>/<tên repo>`.
- Trạng thái: *sẽ clone*, *dùng clone có sẵn* (remote trùng URL SSH hoặc HTTPS GitLab trả về, kể cả clone ở chỗ khác), *đã là service* (cùng GitLab project hoặc clone đã thuộc service), *thư mục xung đột* (đích chứa repo khác hoặc không phải repo, không chọn được).
- *Nhập N repo* chạy lần lượt: clone hoặc dùng lại clone, thêm service với default branch từ GitLab, gắn GitLab project để MR vào đúng chỗ. Repo lỗi (không clone được, key trùng) được báo riêng, các repo khác vẫn nhập.
- *Gom vào hệ thống* (bật sẵn, tên mặc định là tên group): các repo đã nhập và repo đã là service vào cùng một hệ thống, thêm vào hệ thống cùng tên nếu đã có.
- Clone không chờ nhập mật khẩu hay xác nhận host key. Qua HTTPS tới host GitLab, token đi bằng header trong env như lúc push, không ghi vào `.git/config`. Địa chỉ clone lấy lại từ GitLab lúc nhập, không lấy từ trang.

### Pull request trên GitHub

Cấu hình ở *Service & công cụ* → **GitHub pull request** (hỏi ngày 28/9: team dùng GitHub, giống GitLab; đăng nhập bằng fine-grained personal access token): URL (mặc định `https://github.com`, hoặc URL GitHub Enterprise Server) và token. Token cần quyền *Contents* và *Pull requests* (đọc và ghi) trên các repo của team, cộng *Checks*, *Commit statuses* và *Actions* (đọc) để theo dõi và tự sửa CI. Nút *Kiểm tra kết nối* cho biết token thuộc tài khoản nào.

- **Service nào là GitHub**: remote push (`origin` hoặc remote trong tuỳ chọn MR) nằm trên host GitHub đã cấu hình, hoặc service có ô *GitHub: owner/repo* (nút *GitLab / GitHub* của service). Các service khác vẫn tạo MR trên GitLab, nên một máy dùng được cả hai.
- **Luật tạo** giống MR, lấy từ thẻ GitLab: *Tự tạo MR*, *Khi nào*, *Review yêu cầu sửa* (Draft hoặc không tạo), label, remote. Base mặc định là default branch của repo, hoặc *target branch* của service.
- **Draft**: review yêu cầu sửa hoặc không rõ thì PR là draft. Chạy lại khi review đã đạt thì PR được chuyển sang *Ready for review* (qua GraphQL, vì REST không đổi được). Repo không có PR draft (repo riêng trên GitHub Free) thì tạo PR thường với tiêu đề bắt đầu bằng `Draft:`, và run ghi chú điều đó.
- **Push qua HTTPS** tới host GitHub dùng token như GitLab: header trong `GIT_CONFIG_*` của env (user `x-access-token`), không ghi vào `.git/config`. Remote SSH dùng key sẵn có.
- **PR đã có** (cùng branch, đang mở): chỉ cập nhật tiêu đề và mô tả rồi thêm label, không đổi base. Mô tả giống MR, output của agent nằm trong code block.
- Link `PR #n` được ghi vào ghi chú task và hiện trên Board. Lỗi GitHub (`GitHub 401: Bad credentials`…) được ghi ở run, không làm run thất bại.
- **Theo dõi PR**: cùng lượt với MR GitLab (30 giây sau khi mở app, rồi theo cùng chu kỳ, mặc định 2 phút; PR của run trong 30 ngày gần nhất), app hỏi GitHub trạng thái PR và check của commit mới nhất.
  - Các check (GitHub Actions và app khác, cả commit status kiểu cũ) được gộp thành một trạng thái CI trên Board: *đang chạy* khi còn check chưa xong, rồi *lỗi* nếu có check lỗi, hết giờ hay cần xử lý. Bấm để mở trang checks của commit đó.
  - PR merge thì task sang *Xong*, ghi chú thêm `PR #n merged.` (cùng ô *MR merge thì chuyển task sang Xong*). PR bị đóng mà không merge thì theo ô *MR đóng mà không merge*, ghi chú thêm `PR #n closed without merging.`. Có thông báo khi PR merge, bị đóng, hoặc CI lỗi, kể cả khi lần push sau lại lỗi.
  - PR đã merge hay đóng thì thôi hỏi. Chỉ hỏi PR trên đúng GitHub đã cấu hình, nên token không đi nơi khác.
- **Tự sửa CI** (cùng ô *Pipeline lỗi thì giao agent sửa* và *Số lần tự sửa mỗi MR*): check của commit mới nhất trên PR đang mở bị lỗi thì app xếp một run implement trên branch `ai/<task>`, như với GitLab.
  - Prompt có link trang checks và phần cuối log của tối đa 3 check lỗi: job GitHub Actions lấy log qua API (bỏ mốc giờ và dòng `##[group]`, giữ tên bước và `##[error]`), check của app khác lấy tiêu đề và tóm tắt nó báo, commit status lấy mô tả. Log được làm sạch như GitLab (mã màu, ký tự ẩn, dòng giống secret).
  - Mỗi lần lỗi sửa một lần (theo id nhỏ nhất của các check lỗi: commit mới hay chạy lại đều là lần mới), tối đa theo *Số lần tự sửa mỗi MR*. Run xong thì app chỉ push branch; tiêu đề và mô tả PR giữ nguyên.
  - Token thiếu quyền đọc check vẫn theo dõi được trạng thái PR, chỉ không có trạng thái CI.
- Token fine-grained (`github_pat_…`) cũng bị chặn khi ghi vào memory hay tài liệu, như các loại token khác.

## Hub cho team

### Docker (khuyên dùng)

```bash
HIVE_HOSTNAME=hive.example.com docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml logs hub     # lần đầu in mật khẩu tạm của tài khoản admin
```

- [`Dockerfile`](Dockerfile): image chỉ gồm hub (core, mcp, web và UI đã build), không có mã desktop. Chạy bằng user `node`, dữ liệu ở `/data`, có `HEALTHCHECK` gọi `/api/health`.
- [`deploy/compose.yaml`](deploy/compose.yaml): hub + Caddy (HTTPS tự động, cần DNS trỏ về máy và mở cổng 80/443). Không muốn dùng Caddy thì bỏ service `caddy`, publish cổng `7788` và đặt proxy của bạn phía trước, giữ nguyên Host header.
- [`deploy/compose.tunnel.yaml`](deploy/compose.tunnel.yaml): máy đã có `cloudflared` (Cloudflare Tunnel) thì bỏ Caddy, hub chỉ nghe `127.0.0.1:7788`: `HIVE_HOSTNAME=hive.example.com docker compose -p xdev-hive -f deploy/compose.yaml -f deploy/compose.tunnel.yaml up -d --build hub`, rồi thêm Public Hostname trỏ về `http://localhost:7788` trên dashboard Cloudflare.
- [`deploy/compose.lan.yaml`](deploy/compose.lan.yaml): thêm một cổng cho máy trong mạng nội bộ, đi thẳng không qua Internet (xem *Cổng LAN* dưới).
- **Chỉ chạy 1 container cho mỗi database.** SQLite không chia sẻ file giữa nhiều replica. Muốn chịu tải lớn hơn thì chuyển sang Postgres (xem *Việc tiếp theo*).

Không dùng Docker:

```bash
npm ci && npm run build -w @xdev-hive/web
HIVE_HOST=0.0.0.0 HIVE_ALLOWED_HOSTS=hive.example.com HIVE_DB=/data/hub.db HIVE_BACKUP_DIR=/data/backups npm run start -w @xdev-hive/web
```

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `HIVE_PORT` / `HIVE_HOST` | `7788` / `127.0.0.1` | Cổng và địa chỉ bind (image: `0.0.0.0`) |
| `HIVE_ALLOWED_HOSTS` | localhost | Danh sách Host header hợp lệ (chống DNS rebinding). Bắt buộc khi có hostname công khai hoặc đặt sau reverse proxy. `localhost`/`127.0.0.1` luôn được chấp nhận (health check). Chỉ ghi tên hoặc IP, cổng (nếu có) được bỏ qua khi so |
| `HIVE_LAN_HOSTS` | – | Tên và IP trong LAN hub cũng nhận, thêm vào sau `HIVE_ALLOWED_HOSTS` (xem *Cổng LAN*) |
| `HIVE_DB` | `apps/web/data/hub.db` | File SQLite (image: `/data/hub.db`) |
| `HIVE_MEMORY_APPROVAL` | bật | `off`: memory của agent hiện ngay, không cần duyệt |
| `HIVE_MEMORY_STALE_DAYS` | `90` | Memory không agent nào dùng (và không ai ghi hay giữ lại) trong ngần này ngày bị coi là cũ: `memory_search` của agent bỏ qua, trang Memory vẫn hiện để xem lại. `0`: không bao giờ cũ |
| `HIVE_RUN_LOG_DAYS` | `30` | Run không cập nhật trong ngần này ngày thì hub dọn log và diff (phần nặng); tóm tắt, lỗi, branch, MR, merge, chi phí, người yêu cầu giữ mãi. `0`: giữ cả log |
| `HIVE_PUBLIC_URL` | `https://` + host đầu tiên của `HIVE_ALLOWED_HOSTS` | Địa chỉ hub dùng cho link trong tin webhook |
| `HIVE_ADMIN_USER` | `admin` | Tên tài khoản admin đầu tiên (tạo khi hub chưa có tài khoản nào) |
| `HIVE_TRUST_PROXY` | tắt (compose: `1`) | Hub đứng sau proxy TLS: cookie phiên có `Secure`, giới hạn đăng nhập sai theo IP thật từ `X-Forwarded-For`. Chỉ bật khi mọi request đi qua proxy |
| `HIVE_BOOTSTRAP_TOKEN` | – | Token admin cố định (≥ 32 ký tự) cho deploy tự động |
| `HIVE_BACKUP_DIR` | tắt (image: `/data/backups`) | Bật backup: một bản khi khởi động (trước khi migrate schema) và định kỳ |
| `HIVE_LOG_REPEAT_THRESHOLD` | `10` | Sau mỗi lần khởi động, gom lỗi/cảnh báo `[xdev-hive]` đã che secret, giữ tối đa 24 giờ (50.000 dòng). Cùng lỗi lặp quá ngưỡng trong 1 giờ mở cảnh báo; xem Quản trị › Vận hành. Dữ liệu log được đặt lại khi hub khởi động lại |
| `HIVE_BACKUP_HOURS` / `HIVE_BACKUP_KEEP` | `24` / `7` | Chu kỳ backup và số bản giữ lại |
| `HIVE_EMBED_URL` | tắt | Endpoint `/embeddings` kiểu OpenAI để `memory_search` tìm cả theo nghĩa, vd. `http://ollama:11434/v1` (xem dưới) |
| `HIVE_EMBED_MODEL` / `HIVE_EMBED_KEY` | `bge-m3` / – | Model embedding; key Bearer khi dùng API ngoài (Ollama không cần) |
| `HIVE_EMBED_MIN_SCORE` | `0.5` | Độ giống (cosine) tối thiểu để một mục tính là tìm thấy theo nghĩa |
| `HIVE_OIDC_ISSUER` / `HIVE_OIDC_CLIENT_ID` / `HIVE_OIDC_CLIENT_SECRET` | tắt | Đăng nhập qua nhà cung cấp OpenID Connect (xem *Đăng nhập SSO*). Cần đủ cả ba |
| `HIVE_OIDC_NAME` / `HIVE_OIDC_SCOPES` | `SSO` / `openid profile email` | Tên trên nút đăng nhập; scope xin nhà cung cấp |
| `HIVE_SEAWEEDFS_URL` | tắt (compose: `http://seaweedfs:8888`) | Filer SeaweedFS để lưu ảnh và tệp của tài liệu thay vì trong database (xem *Ảnh và tệp của tài liệu*) |
| `HIVE_SEAWEEDFS_PREFIX` | `/xdev-hive/doc-files` | Thư mục trong filer |

### Cổng LAN (HTTP, tuỳ chọn)

Máy trong cùng mạng nội bộ vào thẳng hub bằng IP hoặc tên máy, không vòng ra Internet. Vẫn là một hub, một database với địa chỉ công khai; chỉ thêm một Caddy nữa ([`deploy/Caddyfile.lan`](deploy/Caddyfile.lan)) đứng trước nó.

Thêm vào `deploy/.env` rồi chạy `HIVE_LAN=1 bash deploy/update.sh`:

```bash
HIVE_LAN_HOSTS=192.0.2.52,linux-runner   # tên và IP mà máy trong LAN sẽ gõ (không kèm cổng)
# HIVE_LAN_PORT=7780      # cổng trên máy chủ (mặc định 7780)
# HIVE_LAN_BIND=0.0.0.0   # chỉ mở trên một card mạng: HIVE_LAN_BIND=192.0.2.52
```

Dùng được cùng Cloudflare Tunnel (`HIVE_TUNNEL=1 HIVE_LAN=1 bash deploy/update.sh`), cùng Caddy công khai, hoặc chỉ LAN. Chỉ LAN thì không cần tên miền: bỏ `HIVE_HOSTNAME`, service `caddy` (80/443) không chạy và không xin chứng chỉ nào — nhớ đặt `HIVE_PUBLIC_URL=http://192.0.2.52:7780` để link trong tin webhook trỏ đúng chỗ.

- Máy trong LAN: app desktop → *Hub dùng chung* → URL `http://192.0.2.52:7780`; trình duyệt mở cùng địa chỉ. Đăng nhập web chạy như thường, cookie phiên không đặt `Secure` khi vào bằng `http`.
- `HIVE_RELEASE_HUB=http://192.0.2.52:7780` đưa bản phát hành lên qua LAN, không qua tunnel.
- SSO (OIDC) vẫn quay về `HIVE_PUBLIC_URL` công khai, nên máy đăng nhập SSO phải ra được địa chỉ đó. Đăng nhập bằng mật khẩu thì không cần.
- Caddy của cổng LAN bỏ `X-Forwarded-For` / `-Proto` khách gửi và đặt lại theo kết nối thật, nên một máy trong LAN không khai man địa chỉ để lách giới hạn đăng nhập sai của địa chỉ nó.

⚠️ **Cổng LAN không mã hoá**: token, mật khẩu và mọi thứ khác đi dạng rõ trong mạng nội bộ, ai bắt được gói tin cũng đọc được. Chỉ bật trong mạng tin được, và thu hẹp lại:

- `HIVE_LAN_BIND=192.0.2.52` để cổng chỉ nằm trên card mạng LAN, không mở ra mọi địa chỉ của máy.
- Giới hạn theo dải máy. Docker publish cổng bằng iptables trước ufw, nên `ufw deny 7780` thường không chặn được cổng đã publish; luật đặt vào chain `DOCKER-USER` thì có:

  ```bash
  sudo iptables -I DOCKER-USER '!' -s 192.0.2.0/24 -p tcp --dport 7780 -j DROP
  ```

  Cổng trong luật này là cổng **bên trong container** (luôn `7780`, luật chạy sau DNAT), không phải `HIVE_LAN_PORT`. Luật iptables mất khi khởi động lại máy nếu không lưu (`iptables-persistent`).

### Tìm memory theo nghĩa (tuỳ chọn)

Mặc định `memory_search` tìm theo từ (FTS5, có dấu hay không dấu đều được). Có model embedding thì tìm cả theo nghĩa: hỏi "triển khai thế nào" vẫn ra mục "Deploy with update.sh".

- Chạy Ollama cạnh hub, không gửi dữ liệu ra ngoài. Thêm vào `deploy/.env`:

  ```
  COMPOSE_PROFILES=embed
  HIVE_EMBED_URL=http://ollama:11434/v1
  HIVE_EMBED_MODEL=bge-m3
  ```

  Sau đó chạy `deploy/update.sh`: script bật service `ollama` (không publish cổng nào), kéo model (bge-m3 khoảng 1,2 GB, đa ngôn ngữ, có tiếng Việt), rồi cập nhật hub. Kéo model lỗi thì hub vẫn cập nhật, chỉ tìm theo từ.
- Hub tạo vector cho memory đã duyệt: ngay khi khởi động, rồi mỗi 20 giây. Mục đang chờ duyệt thì chưa tạo. Đổi model thì hub tạo lại vector cho mọi mục.
- Kết quả là hợp của hai cách tìm, xếp bằng *reciprocal rank fusion*. Mục chỉ khớp theo nghĩa phải có độ giống từ `HIVE_EMBED_MIN_SCORE` trở lên.
- Không lấy được vector cho câu hỏi trong 5 giây, hoặc endpoint lỗi, thì chỉ tìm theo từ. Trang Memory ghi lỗi (chỉ `HTTP 500`, `timeout`…, không chép chữ của endpoint).
- Trang Memory hiện chế độ tìm và số mục đã có vector (`memory.searchInfo`).
- Endpoint khác cũng được (API ngoài): `HIVE_EMBED_URL` + `HIVE_EMBED_MODEL` + `HIVE_EMBED_KEY`, không cần profile `embed`. Khi đó nội dung memory được gửi tới nhà cung cấp đó.
- Chế độ cục bộ của app desktop vẫn chỉ tìm theo từ.

Không ai đăng nhập được (quên mật khẩu admin…) thì làm trên server (Docker: thêm `docker compose -f deploy/compose.yaml exec hub` phía trước):

```bash
npm run user -w @xdev-hive/web -- reset admin          # mật khẩu tạm mới, đăng xuất mọi nơi
npm run user -w @xdev-hive/web -- create duy admin     # thêm một admin
npm run user -w @xdev-hive/web -- list
npm run token -w @xdev-hive/web -- create ci-gitlab agent   # token không thuộc tài khoản nào
```

### Tài khoản và quyền theo service

- **Người** đăng nhập hub bằng tên đăng nhập + mật khẩu. Admin tạo tài khoản ở *Quản trị → Người dùng & quyền*; hub sinh mật khẩu tạm, chỉ hiện một lần. Lần đăng nhập đầu phải đổi mật khẩu (≥ 10 ký tự, không chứa tên đăng nhập) mới dùng được hub. Quên mật khẩu: admin bấm *Đặt lại mật khẩu*.
- **Quyền theo service** (roadmap 25): mỗi người có một vai trò ở từng service, hoặc *Tuỳ chỉnh* (chọn từng quyền ở *Quyền chi tiết*). Service không được cấp thì người đó không thấy gì của service đó: không trong danh sách, không qua agent, không qua MCP (hub trả *không tìm thấy*, nên cũng không lộ tên tài liệu).

  | Vai trò | Được làm |
  |---|---|
  | Người xem | xem task, run, tài liệu, memory, skill, chat, Context agent |
  | Thành viên | + làm task (nhận, cập nhật, gửi kết quả run), đề xuất sửa tài liệu và skill, ghi memory |
  | Reviewer | + duyệt đề xuất tài liệu và skill, duyệt memory, duyệt hành động của leader chat, Review code (chuyển task sang Xong) |
  | Quản lý service | mọi quyền: thêm sửa tài liệu, Context agent, tạo task, giao và dừng run, chat với leader, cài đặt service, quản lý thành viên |

  15 quyền: Xem · Làm task · Tạo, sửa task · Giao, dừng run · Review code · Đề xuất tài liệu, skill · Sửa tài liệu · Duyệt đề xuất tài liệu, skill · **Context agent** · Ghi memory · Duyệt memory · Chat với leader · Duyệt hành động leader · Cài đặt service · Quản lý thành viên.
  - **Context agent** là những gì agent đọc: AGENTS.md và quyết định của service, skill, tài liệu theo đường dẫn, tài liệu đưa vào AGENTS.md. Sửa hoặc duyệt đề xuất cho chúng cần quyền này; đổi một tài liệu thường thành tài liệu theo đường dẫn cũng vậy. Reviewer duyệt được tài liệu thường nhưng không duyệt AGENTS.md.
  - **Review code**: chuyển task sang *Xong* (cả khi MR đã merge, MR watcher của máy cũng cần quyền này ở tài khoản của máy). Agent chỉ đưa task sang *Review*.
  - **Quản lý thành viên**: trang *Thành viên* (nhóm Quản trị): người có quyền này đặt vai trò cho tài khoản có sẵn trong service, không trao quyền mình không có, không đổi quyền của mình hay của admin. Tạo tài khoản vẫn do admin hub làm.
  - Quyền cấp trước bản 0.87 vẫn giữ nguyên: *Xem* đọc thành Người xem, *Đóng góp* thành Thành viên, *Quản trị* thành Quản lý service. Khác duy nhất: Thành viên không còn tự chuyển task sang Xong, việc đó cần Review code.

- **Dữ liệu Chung** (tài liệu `org/*`, memory, skill chung) có vai trò riêng như một service (dòng *Chung* trong hộp phân quyền, hoặc trang *Thành viên* chọn *Chung*). Để *Theo service* (mặc định): ai đăng nhập cũng xem được, người làm được ở ít nhất một service thì đề xuất tài liệu Chung và ghi memory Chung, chờ người có quyền duyệt.
- **Admin** thấy và quản trị mọi service, quản lý tài khoản, trang Quản trị và mọi token.
- **Máy và agent** dùng token *thuộc tài khoản* của người đó, nên chỉ thấy đúng các service người đó được cấp. App desktop: *Cài đặt → Kết nối → Cách khác → Đăng nhập bằng mật khẩu hub*, nhập tên đăng nhập + mật khẩu một lần. Hub cấp cho máy một token (mật khẩu không lưu trên máy); đăng nhập lại từ cùng máy thì token cũ bị thay. Token vai trò `agent` (CI, script) mỗi người tự tạo ở trang *Token*, tối đa là Xem, Làm task, Đề xuất và Ghi memory dù người đó là Quản lý service: agent không bao giờ duyệt, sửa Context agent hay giao run. Leader chat dùng quyền chung của người gửi và máy chạy nó.
- Khoá tài khoản thì phiên đăng nhập và mọi token của người đó ngừng hoạt động ngay. Bỏ hay đổi quyền có hiệu lực từ request kế tiếp.
- Token tạo trước khi có tài khoản (không thuộc ai) vẫn chạy như cũ theo vai trò của nó.

### Đăng nhập SSO (OpenID Connect)

Hub nhận mọi nhà cung cấp OpenID Connect: GitLab, Microsoft Entra, Google… Trang đăng nhập có thêm nút *Đăng nhập bằng …*, mật khẩu vẫn dùng được.

1. Tạo ứng dụng OAuth ở nhà cung cấp, với redirect URI `https://<hub>/api/auth/oidc/callback` (hub in URI này khi khởi động).
   - GitLab: *Admin → Applications* hoặc *User settings → Applications*. Chọn *Confidential*, scope `openid profile email`.
2. Thêm vào `deploy/.env` (issuer là địa chỉ gốc của nhà cung cấp, vd. `https://gitlab.example.com`; Entra: `https://login.microsoftonline.com/<tenant>/v2.0`; Google: `https://accounts.google.com`), rồi chạy `deploy/update.sh`:

   ```
   HIVE_OIDC_ISSUER=https://gitlab.example.com
   HIVE_OIDC_CLIENT_ID=…
   HIVE_OIDC_CLIENT_SECRET=…
   HIVE_OIDC_NAME=GitLab
   ```

- **Người đăng nhập SSO lần đầu** được tạo tài khoản mới (hỏi ngày 28/9): không phải admin, chưa được cấp service nào nên chỉ thấy dữ liệu Chung. Admin cấp quyền sau ở *Người dùng & quyền*, nơi tài khoản có nhãn *SSO*.
  - Tên đăng nhập lấy từ username bên nhà cung cấp (hoặc phần trước `@` của email, bỏ dấu). Trùng tên thì thêm `-2`, `-3`…
  - Hub **không bao giờ** gộp vào tài khoản có sẵn theo tên hay email, để không ai chiếm được tài khoản người khác.
- **Đã có tài khoản mật khẩu**: đăng nhập như cũ, rồi chọn *Liên kết …* ở menu tài khoản. Từ đó đăng nhập cách nào cũng vào cùng tài khoản. Một tài khoản bên nhà cung cấp chỉ gắn được với một tài khoản hub.
- **Luồng đăng nhập**: authorization code + PKCE (S256), `state` gắn với trình duyệt qua cookie `hive_oidc` (SameSite=Lax, 10 phút, dùng một lần), `nonce`.
  - `id_token` lấy thẳng từ token endpoint qua TLS. Hub kiểm issuer (phải khớp issuer đã cấu hình và tài liệu discovery), audience, `azp`, hạn dùng, `nonce`.
  - Issuer phải là `https://`.
- Tài khoản bị khoá thì không đăng nhập SSO được. Mỗi lần đăng nhập, tạo tài khoản và liên kết đều ghi vào nhật ký.
- **App desktop**: nút *Đăng nhập qua trình duyệt* ở *Cài đặt → Kết nối*. Dùng được cho tài khoản chỉ có SSO; tài khoản có mật khẩu cũng dùng được.
  1. App mở một cổng trên `127.0.0.1` rồi mở trang hub `#/device` trên trình duyệt.
  2. Người dùng đăng nhập ở đó (SSO hay mật khẩu). Trang hỏi *App trên máy … muốn dùng tài khoản @… của bạn*, bấm *Cho phép*.
  3. Hub gửi mã dùng một lần (2 phút) về đúng địa chỉ `127.0.0.1` đó. App đổi mã kèm PKCE verifier lấy token của máy, giống đăng nhập bằng mật khẩu.
  - Đây là cách loopback của RFC 8252. Chỉ app đã bắt đầu mới có verifier, và mã chỉ đi tới `127.0.0.1`, nên chuyển link này cho người khác cũng không lấy được token.
  - App chờ tối đa 5 phút, có nút *Huỷ*. Bấm *Không* thì app báo bị từ chối.
  - Đăng nhập SSO từ trang này xong thì quay lại đúng trang đó.

### Ảnh và tệp của tài liệu (SeaweedFS)

- Compose chạy SeaweedFS 4.48 cạnh hub (service `seaweedfs`, volume `seaweedfs-data`). Chỉ hub gọi được nó trong mạng của compose, không cổng nào mở ra ngoài. Hub dùng HTTP API của filer (`HIVE_SEAWEEDFS_URL`).
- Database giữ thông tin tệp (tên, loại, cỡ, người tải, SHA-256). SeaweedFS giữ nội dung, đặt tên theo SHA-256: cùng một nội dung chỉ lưu một lần, và ghi lại nhiều lần cũng không sao. Tệp không còn trang nào dùng thì bị xoá khỏi SeaweedFS.
- Artifact của run (roadmap 41c) dùng chung kho này. Một nội dung vừa là tệp của trang vừa là artifact chỉ nằm một bản, và chỉ bị xoá khi không còn bên nào trỏ tới.
- Hub vừa có SeaweedFS thì tự chuyển các tệp đang nằm trong database sang: ngay khi khởi động, rồi mỗi phút cho tới khi hết. Trang *Hub* (web, *Quản trị*) có thẻ *Tệp tài liệu*: số tệp, dung lượng, số tệp còn trong database, lỗi gần nhất.
- SeaweedFS không trả lời thì tải tệp lên bị từ chối (không lưu nửa vời), còn đọc tệp thì báo lỗi rõ ràng. Hub vẫn chạy bình thường.
- Không dùng SeaweedFS: đặt `HIVE_SEAWEEDFS_URL=` (rỗng) trong `deploy/.env`, tệp nằm trong database như trước. App desktop không có hub luôn lưu tệp trong database của máy. Tệp đã chuyển sang SeaweedFS thì hub không có `HIVE_SEAWEEDFS_URL` sẽ báo *tệp nằm trong kho seaweedfs*.
- Server bị Docker Hub từ chối (429): `deploy/update.sh` lấy image từ `mirror.gcr.io` rồi tag lại đúng tên. Muốn dùng image khác thì đặt `HIVE_SEAWEEDFS_IMAGE`.

### Backup, khôi phục, nâng cấp

- Backup dùng `VACUUM INTO`, nên an toàn khi hub đang chạy. Không nên copy thẳng `hub.db`, vì bản copy thiếu phần còn nằm trong file `-wal`. Tên file dạng `hub-2026-09-27T09-00-00-000Z.db`. Khi xoay vòng, hub chỉ xoá file có đúng dạng tên này.
- Backup ngay (ví dụ trước khi làm việc rủi ro): `npm run backup -w @xdev-hive/web -- [thư mục] [số bản giữ]`. Lệnh này chỉ đọc file, không migrate.
- Mặc định, compose để backup trên volume `hive-backups`, cùng đĩa với database. Để backup còn nguyên khi mất đĩa, trỏ `HIVE_BACKUP_PATH=/mnt/backup/hive` sang đĩa khác (thư mục phải cho uid 1000 ghi), hoặc đồng bộ thư mục backup ra ngoài.
- Backup gồm database và mọi tệp đã chuyển sang SeaweedFS mà các bảng `doc_assets` (ảnh/tệp của tài liệu) và `artifacts` (tệp của run) tham chiếu. Chúng được chép theo SHA-256 vào `<thư mục backup>/files/<sha256>` sau mỗi lần backup (cả *Backup ngay*): nội dung trùng chỉ có một bản, chỉ chép tệp mới, và chỉ xoá tệp mà database lẫn các snapshot còn giữ đều không dùng. Tệp còn nằm trực tiếp trong database đã được chứa trong snapshot. Tệp đính kèm chat và ảnh bàn giao chỉ được backup nếu được ghi vào một trong hai bảng trên; hiện kho dùng hai bảng đó.
- **Khôi phục**: dừng hub, chép bản backup đè lên `hub.db`, xoá `hub.db-wal` và `hub.db-shm` nếu có, rồi khởi động lại. Mất cả dữ liệu SeaweedFS thì đưa tệp từ backup vào lại: `HIVE_SEAWEEDFS_URL=http://seaweedfs:8888 npm run files -w @xdev-hive/web -- restore [thư mục backup]` (trong container hub: `docker compose -p xdev-hive -f deploy/compose.yaml exec hub npm run files -w @xdev-hive/web -- restore`).
- **Diễn tập khôi phục**: `bash deploy/restore-drill.sh` trên server, sau `deploy/update.sh`. Script làm từ đầu tới cuối mà không đụng vào hub đang chạy:
  - lấy bản backup mới nhất và `backups/files`;
  - đưa tệp vào một SeaweedFS mới bằng `files restore`;
  - mở một hub riêng trên database đó;
  - đọc lại từng tệp tài liệu và artifact của run mà database tham chiếu, so với SHA-256 và in số lượng theo loại.

  Container, network và thư mục của buổi diễn tập bị xoá khi xong, không dùng prune. Lần chạy ngày 1/10 trên hub thật mất 6 giây: 169 tài liệu và 3 tệp, cả 3 tệp đọc lại đúng. Volume backup khác `xdev-hive_hive-backups` (ví dụ đặt `HIVE_BACKUP_PATH` là một thư mục) thì truyền `HIVE_BACKUPS_VOLUME=<volume hoặc thư mục>`.
- **Nâng cấp**: trên server chạy `bash deploy/update.sh` (sau Cloudflare Tunnel: `HIVE_TUNNEL=1 bash deploy/update.sh`; có cổng LAN thì thêm `HIVE_LAN=1`): lấy `origin/main`, build lại, chờ hub healthy. Hub tự backup trước khi chạy migration mới. Cờ nào bật khi deploy thì lần sau cũng phải bật lại, vì nó quyết định file compose nào được tính đến.

Máy của từng người: app desktop → chế độ **Hub dùng chung** → URL + đăng nhập bằng tài khoản (hoặc dán token). Shim `hive-mcp` tự chuyển tiếp lên hub, nên config MCP không chứa token; từ 38b config này nằm ở scope local của từng máy (`~/.claude.json`), không nằm trong repo.

### Chuyển dữ liệu giữa máy và hub

Ở chế độ hub, app và agent đọc, ghi thẳng lên hub nên không cần đồng bộ. Dữ liệu đã có trong `~/.xdev-hive/local.db` (từ lúc dùng chế độ cục bộ) thì chuyển bằng hai nút ở *Cài đặt* → **Nâng cao** → **Dữ liệu dùng chung với hub**. Hai nút này cần URL và token hub đã lưu, dù app đang ở chế độ nào:

| | Đẩy dữ liệu máy lên hub | Tải dữ liệu hub về máy |
|---|---|---|
| Tài liệu chưa có ở đích | thêm (token `agent`: thành đề xuất) | thêm |
| Tài liệu khác nhau | **đề xuất** chờ admin duyệt, không ghi đè | ghi thành **version mới**, bản cũ vẫn trong lịch sử |
| Memory | chỉ memory đã duyệt; trùng project + loại + nội dung thì bỏ qua | như bên trái |
| Task | chỉ id chưa có (cần token `admin`); task đang làm thành *Chưa làm*, không kèm lease | như bên trái |

Không chuyển: lịch sử version, đề xuất, memory chưa duyệt, và tài liệu mặc định (`org/*` lúc tạo database) chưa ai sửa. Chạy lại nhiều lần cũng không tạo bản trùng. Mỗi lần chạy có báo cáo cho từng mục.

Trên hub, agent giữ task với tên `<gói>.<máy>@<token>`, ví dụ `claude-1.duy-mbp@duy`. Nhờ vậy hai máy dùng chung một token không nhận trùng task. Tên máy (`machine` trong `config.json`) lấy theo hostname, và app desktop ghi cố định vào file ở lần mở đầu tiên. Nếu hai máy trùng hostname thì phải sửa tay để chúng khác nhau.

### Nhiều máy trên một hub

- **Heartbeat**: mỗi 30 giây, runner báo lên hub các run đang chạy và đang chờ (`machines.heartbeat`). Hub lưu theo tên `runner.<máy>@<token>`, cùng khoá với lease task của máy đó.
- **Run lên hub** (hỏi ngày 29/9: log dạng đọc được, đã lọc secret; ai xem được service thì xem được): mỗi 5 giây runner gửi các run vừa đổi (`runs.push`): run đang chạy hay chờ, và run đã xong trong 24 giờ.
  - Mỗi run có trạng thái, gói, việc agent đang làm, tóm tắt, lỗi, branch, số commit, MR/PR, chi phí, và khoảng 200 dòng cuối của log dạng đọc được (`▶` lệnh, `✓ ✗` kết quả). Run xong thì gửi ngay, không chờ lượt 5 giây.
  - Trước khi gửi, máy bỏ mã màu và ký tự ẩn, thay dòng giống secret bằng `(line hidden: …)`. Hub kiểm lại lần nữa trước khi lưu. Log đầy đủ vẫn chỉ nằm trên máy chạy.
  - Hub lưu theo máy và mã run (`run_records`, migration 13). Đọc bằng `runs.list` (không có log) và `runs.get` (có log); người không có quyền xem service thì không thấy run của service đó.
  - **Giữ lại** (roadmap 41b): run không cập nhật quá `HIVE_RUN_LOG_DAYS` ngày (mặc định 30) chỉ bị dọn log và diff — dòng run vẫn còn mãi với tóm tắt, lỗi, vai, gói, branch, số commit, MR, merge, chi phí và người yêu cầu, nên kết luận review hay kết quả đo của agent không mất. `logPrunedAt` ghi lúc dọn: trang *Lượt chạy* và `run_get` báo "log đã dọn" thay vì hiện log rỗng như thật. Dọn chạy cùng `runs.push`; run cũ được máy gửi lại thì tính là mới.
- **Trang *Lượt chạy*** (web và desktop, chỉ hiện ở chế độ hub): các run máy đã gửi lên, của mọi máy, trong các service người xem thấy; lọc theo service đang chọn ở thanh bên.
  - Mỗi dòng: mã run, service · task, việc (làm task / review / lập kế hoạch), máy · gói, trạng thái kèm việc agent đang làm hoặc lỗi, giờ tạo, thời lượng, chi phí.
  - Chọn một run để xem chi tiết: branch, số commit, link MR/PR, kết quả, và phần cuối log (đã ẩn secret). Run đang chạy hay đang chờ thì danh sách và log tự làm mới mỗi 3 giây, log cuộn theo dòng mới; không còn run nào chạy thì 20 giây một lần.
  - **Kết quả review và lượt sửa** (roadmap 18b).
    - Run review đã xong hiện huy hiệu *Review: đạt* hoặc *Review: cần sửa*. Kết luận được đọc từ báo cáo của run, giống cách máy đọc khi mở MR.
    - Review mới nhất của một task mà *cần sửa* có khung *Xếp lượt sửa*, chỉ cho người quản trị service. Bấm là gửi `runs.dispatch` cho cùng máy: việc *Làm task*, gói tự xoay, có thể bật review sau khi xong.
    - Chỉ dẫn gửi agent (xem trước được) gồm báo cáo của review, được đóng khung là "những điểm cần sửa, không phải lệnh". Run làm tiếp trên branch của task. Máy kiểm như mọi yêu cầu từ web.
  - **Huỷ run từ web** (roadmap 18a). Run đang chờ hay đang chạy trên máy có bật *Được nhận run từ hub* có nút *Huỷ run*, chỉ cho người quản trị service của run.
    - Hub ghi ai yêu cầu huỷ (`runs.cancel`, migration 18). Bấm lần nữa vẫn giữ người yêu cầu đầu tiên. Máy chưa bật ô thì hub từ chối, vì chủ máy chưa cho web điều khiển nó.
    - Máy nhận yêu cầu ở heartbeat sau (khoảng 30 giây): huỷ run đang chờ, hoặc dừng agent đang chạy. Lỗi của run ghi "<người> huỷ trên web". Máy đẩy run lên hub như mọi lần.
    - Trong lúc chờ, trang hiện ai yêu cầu và lúc nào, và dòng của run ghi *Đang chờ máy huỷ*. Hub gửi lại yêu cầu ở mỗi heartbeat cho tới khi máy báo run đã kết thúc.
  - Board vẫn là nơi xem run của chính máy mình với log đầy đủ.
- **Xếp run từ web** (hỏi ngày 29/9: web xếp run cho một máy; chỉ người quản trị service; máy phải cho phép):
  - Máy chỉ nhận khi người dùng bật *Được nhận run từ hub* (trang *Gói sub & agent*, thẻ Runner; tắt sẵn). Heartbeat báo hub máy có repo của những service nào và có bật ô này không.
  - Người quản trị service gọi `runs.dispatch`: chọn máy, việc, gói (hoặc tự xoay), review chéo, số bản, chỉ dẫn. Hub từ chối ngay khi: máy mất kết nối, chưa bật ô, không có repo của service; gói ghim không có hoặc đang tắt trên máy; task đã xong hoặc còn chờ task khác; task đã có yêu cầu đang chờ, hoặc đang chạy trên một máy.
  - Máy nhận yêu cầu trong trả lời của heartbeat kế tiếp và xếp run như khi bấm *Chạy agent* trên Board, với cùng các kiểm tra. Sau đó máy báo *đã nhận* kèm mã run, hoặc *từ chối* kèm lý do (`runs.requestResult`), và hiện thông báo trên máy. Nếu hub không nhận được câu trả lời, lần sau máy chỉ báo lại, không xếp run lần hai.
  - Yêu cầu không máy nào nhận sau 15 phút thì hết hạn. Tắt ô thì các yêu cầu đang chờ bị từ chối ngay. `runs.requests` liệt kê yêu cầu theo quyền xem service, `runs.cancelRequest` huỷ yêu cầu còn chờ. Hub giữ yêu cầu đã trả lời 30 ngày; nhật ký quản trị ghi ai xếp, ai huỷ.
  - Trên trang *Task* (web, hoặc app ở chế độ hub), bấm một task để mở panel chi tiết. Mục *Chạy trên máy* chỉ hiện với người quản trị service, và chỉ liệt kê máy đang online, đã bật ô và có repo của service. Chọn máy, việc (mặc định *Review* nếu task đang chờ review), gói hoặc tự xoay, số bản, review chéo, chỉ dẫn, rồi bấm *Gửi cho máy*.
  - Panel hiện các yêu cầu của task: chờ máy nhận (huỷ được), máy đã nhận (mã run, xem ở *Lượt chạy*), máy từ chối (lý do theo ngôn ngữ người xem), đã huỷ, hết hạn. Khi còn yêu cầu đang chờ, trang tự làm mới mỗi 3 giây, và hàng của task trong bảng ghi máy đang được chờ.
  - Trang *Bản đồ agent* ghi máy nào nhận run từ hub và có repo của service nào.
  - **Prompt cho agent** (roadmap 32b): nút trên trang *Task* cho ai vừa tạo được task vừa xếp được run của service. Viết prompt (tối đa 4000 ký tự), chọn máy, gói hoặc tự xoay, tiêu đề (để trống thì lấy dòng đầu), review chéo, rồi *Gửi prompt*.
    - `runs.prompt` tạo task `P-<số>` và yêu cầu chạy trong một lần, kiểm như `runs.dispatch`; một bước kiểm không qua thì không tạo gì. Số đếm chung cả hub vì id task là của cả hub.
    - Prompt là ghi chú của task, và runner đưa ghi chú vào prompt của agent, nên chỉ dẫn của yêu cầu để trống. Prompt dài hơn 2000 ký tự (ghi chú bị cắt) thì chỉ dẫn mang cả prompt.
    - Gửi xong, panel của task mới mở ra với yêu cầu đang chờ máy nhận. Nhật ký quản trị ghi `runs.prompt`.
  - **Đợt chạy** (roadmap 31a): giao nhiều task cho agent trong một lần.
    - Trên trang *Task* (chế độ hub), tick các task chưa xong của một service rồi bấm *Giao cho agent (N)*. Mỗi task chọn máy (hoặc *Máy rảnh*), gói (hoặc tự xoay) và việc. Chọn chung: tên đợt, *Chạy song song tối đa* (để trống thì gửi hết ngay), review chéo, chỉ dẫn.
    - `runs.dispatchMany` kiểm ngay những gì không đổi theo thời gian: task thuộc service và chưa xong, không lặp, không nằm trong đợt khác chưa xong; máy ghim có repo; gói ghim có trên máy; trần chi tiêu; chỉ dẫn không có ký tự ẩn hay secret. Một lỗi thì không tạo gì.
    - Hub giữ task chưa tới lượt (`run_group_items`) và chỉ tạo yêu cầu chạy khi thả, nên task chờ lâu không hết hạn. Hub thả ở mỗi heartbeat, khi máy trả lời yêu cầu và khi có người mở trang. Một chỗ được tính là đang dùng khi yêu cầu còn chờ máy nhận, hoặc run (máy đẩy lên hub) còn chờ hay đang chạy. Task chờ task khác thì để sau.
    - *Máy rảnh*: lúc tới lượt, hub chọn máy online, nhận run từ hub, có repo, còn nhiều chỗ nhất. Chỗ = tổng *Song song tối đa* của các gói dùng được ngay (bật, đã cài, không chưa đăng nhập, chưa chạm ngưỡng, không nghỉ), trừ run đang có trên các gói đó và yêu cầu máy chưa trả lời. App từ 0.110.0 báo *Song song tối đa* ở heartbeat; app cũ được tính 1.
    - Lỗi có thể hết (máy offline, chạm trần, service đang dừng) thì task chờ tiếp. Lỗi không hết (task đã xong, máy không có repo, gói không còn) thì task ghi *Không gửi được*.
    - Trang **Đợt chạy** (nhóm *Công việc*) hiện từng đợt: ai gửi, *đang chạy n/tối đa*, đếm chờ thả / xong / lỗi, và từng task: máy · gói, trạng thái (chờ tới lượt, chờ máy nhận, run và kết quả, lỗi). *Huỷ đợt* bỏ task chưa thả và yêu cầu máy chưa nhận; run đang chạy vẫn chạy.
  - **Một prompt cho nhiều agent** (roadmap 31e): trong *Prompt cho agent*, *Thêm agent* (tối đa 8), mỗi dòng một máy (hoặc *Máy rảnh*) và gói.
    - `runs.fanout` tạo task `P-<số>` giữ prompt và một task riêng cho mỗi agent (`P-<số>-a`, `-b`…), rồi một đợt chạy không giới hạn song song. Tiêu đề task con ghi máy/gói (`*` là để hub hoặc máy chọn). Task `P-<số>` chờ các task con nên không ai chạy nó.
    - Mọi agent xong thì thẻ đợt trên trang *Đợt chạy* có *Chọn bản này* ở các bản chạy thành công. `runs.pickWinner` giữ bản được chọn (đi tiếp review, MR như thường), đóng các bản còn lại và task `P-<số>` với ghi chú bản nào được chọn. Branch của bản không chọn vẫn giữ. Chưa xong hết thì hub từ chối, vì run còn chạy sẽ tự mở lại task khi kết thúc.
  - **Chia việc cho nhiều agent** (map-reduce, roadmap 31c): nút *Chia việc* trên trang *Task* (người vừa tạo được task vừa xếp được run của dự án, chế độ hub). Viết việc lớn rồi chọn một trong hai cách:
    - *Tôi viết danh sách việc con*: mỗi dòng một việc (2–12, mỗi việc tối đa 300 ký tự, dấu `-` hay `1.` đầu dòng được bỏ). Chọn máy (hoặc *Máy rảnh*: máy còn nhiều chỗ nhất lúc gửi), các gói mà việc con lần lượt lấy (không chọn thì máy tự chọn), *Chạy song song tối đa*, review chéo bản đã gộp. `runs.mapReduce` tạo task `P-<số>` cho việc lớn, `P-<số>-1…k` cho việc con (task cha chờ các con) và một đợt `mapreduce`.
    - *Nhờ agent chia*: `runs.mapSplit` tạo task `P-<số>` và một run *Lập kế hoạch* trên nó; agent ghi danh sách việc con vào ghi chú, không viết code. Xong thì trang *Task* báo *agent đã chia thành n việc con*: *Kiểm và chạy* mở lại hộp với danh sách để sửa, rồi chạy (`runs.mapReduce` với `groupId`). Trang *Đợt chạy* cũng có link *Sửa danh sách và chạy*.
    - Mọi việc con và run gộp chạy trên cùng một máy, mỗi việc con một branch `ai/P-<số>-<i>`, không review riêng. Xong hết thì hub đóng các việc con và xếp một run *Làm task* trên `P-<số>` gộp các branch vào `ai/P-<số>`, sửa xung đột, chạy test; rồi review chéo: một MR.
    - Thẻ đợt *Map-reduce* trên trang *Đợt chạy*: giai đoạn (*agent đang chia*, *chờ kiểm danh sách*, *đang chạy việc con*, *đang gộp*, *đã gộp*, *đã dừng*), task cha, máy, các việc con, run chia việc hoặc run gộp. Một việc con, run chia hay run gộp không thành công (hoặc *Huỷ đợt*) thì đợt dừng và ghi lý do; *Chạy lại* (`runs.resumeGroup`) chạy lại việc con chưa xong, hoặc run gộp, hoặc run chia.
  - **Chuỗi vai trên một task** (multi-role, roadmap 31d): chọn đúng một task ở chế độ danh sách rồi bấm *Chuỗi vai* (hoặc *Chạy theo chuỗi vai* trong bảng chi tiết task), cần quyền xếp run của dự án. Mỗi bước một vai (*Viết code*, *Viết test*, *Viết tài liệu*, *Review*), một gói và chỉ dẫn riêng (viết test / viết tài liệu có sẵn chỉ dẫn mẫu); 2–6 bước, mặc định viết code → viết test → review.
    - `runs.roles` tạo một đợt `roles` chạy lần lượt trên branch `ai/<task>` của một máy (đã chọn, hoặc máy còn nhiều chỗ nhất lúc gửi): bước sau chỉ được gửi khi run bước trước thành công. Viết code/test/tài liệu là run *Làm task*, review là run *Review*; hub thêm vào chỉ dẫn của mỗi bước chuỗi gồm những bước nào và bước này làm gì. Không review chéo riêng: review là một bước.
    - Một bước không thành công (hoặc *Huỷ đợt*) thì chuỗi dừng, các bước sau bị huỷ. Thẻ *Nhiều vai* trên trang *Đợt chạy* ghi bước đang chạy, lý do dừng và *Chạy lại* (chạy lại từ bước chưa xong, khi không còn run nào đang chạy). Trong lúc chuỗi chạy, task không giao tay được.
- **Chat với leader của service** (hỏi ngày 29/9: làm trong Hive; người quản trị service chat được; leader chạy trên gói Claude của một máy bật *Được nhận run từ hub*). Roadmap 17a-1 (hub), 17a-2 (máy trả lời), 17b (trang *Chat*).
  - **Trang *Chat*** (web, và app ở chế độ hub; nhóm *Làm việc*): các thread của service đang chọn ở thanh bên (*Tất cả service* thì mọi service bạn xem được), mới nhất trước. Thread đang có câu trả lời có chấm xanh.
    - *Chat mới* (người quản trị service): chọn service, máy, gói Claude hoặc để máy tự chọn, rồi viết tin đầu. Chỉ hiện máy đang online, bật nhận run từ hub, có repo của service và có gói Claude đã đăng nhập.
    - Câu trả lời hiện dần khi máy viết (trang hỏi hub mỗi 2 giây), kèm việc agent đang làm và các bước (`▶` công cụ). *Dừng* huỷ câu trả lời và giữ phần đã viết. Thread đang chờ câu trả lời thì chưa gửi được tin tiếp.
    - Câu trả lời hiện bằng Markdown (kiểu GitHub: tiêu đề, danh sách, danh sách việc, bảng, trích dẫn, khối code, link) (roadmap 17d).
      - Trang không chạy HTML trong câu trả lời, và không tải ảnh mà chữ trỏ tới. Link ra ngoài mở ở tab mới.
      - Câu trả lời và từng khối code có nút *Copy*.
      - Câu trả lời cuối bị lỗi, hết hạn hay bị dừng có nút *Gửi lại*: gửi lại đúng tin nó trả lời.
      - Enter để gửi, Shift+Enter để xuống dòng.
    - **Đính kèm** (roadmap 17g-1): ảnh (PNG, JPEG, WebP, GIF), PDF và file văn bản (txt, log, md, csv, json), tối đa 4 file mỗi tin, mỗi file 5 MB.
      - Người gửi bấm kẹp giấy, dán ảnh chụp vào ô tin nhắn, hoặc kéo thả file vào. Mỗi file tải lên hub ngay (`POST /api/chat/files`), rồi `chat.send` gắn file vào tin bằng mã của nó.
      - Hub đọc loại file từ các byte đầu, không tin tên file hay header. Văn bản phải là UTF-8 và không chứa dòng giống secret. HTML, SVG và file chạy được đều bị từ chối. Tên file được làm sạch (không có thư mục, ký tự ẩn hay chữ đảo chiều).
      - Ai xem được chat của service thì đọc được file (`GET /api/chat/files/<id>`). File chưa gửi thì chỉ người tải lên thấy; sau 1 ngày chưa gửi thì bị xoá. Xoá thread thì xoá cả file.
      - Ảnh hiện thu nhỏ trong tin (bấm để xem cỡ thật); file khác là link tải về. Hub trả văn bản dưới dạng `text/plain` có sandbox, nên file không bao giờ chạy như một trang của hub.
      - Leader đọc được file đính kèm (roadmap 17g-2). Yêu cầu trả lời mang theo danh sách file của tin. Máy tải từng file bằng token của câu trả lời (không dùng token của máy) vào một thư mục riêng của câu trả lời, ngoài repo.
      - Máy làm sạch tên file thêm một lần và đặt tên khác cho file trùng tên. Claude được đọc thư mục đó qua `--add-dir`, và tin gửi leader kèm đường dẫn từng file để nó đọc bằng Read (đọc được cả ảnh và PDF).
      - File không tải được thì được ghi chú trong tin, câu trả lời vẫn tiếp tục. Thư mục bị xoá khi câu trả lời xong.
    - **Hướng dẫn leader** (roadmap 17i-1): người quản trị service bấm *Hướng dẫn leader* trên trang *Chat* để sửa hướng dẫn cho leader của service.
      - Khung sửa mở bản đang dùng: bản riêng của service nếu có, không thì bản chung của nhóm (skill `hive-leader`).
      - Lưu thì tạo hoặc cập nhật skill `project/<dự án>/skills/hive-leader`, có lịch sử phiên bản như mọi skill. Leader đọc bản riêng này trước (`skill_get`); các service khác vẫn dùng bản chung.
    - **Lệnh leader được chạy** (roadmap 17i-2), cũng nằm trong khung *Hướng dẫn leader*. Mặc định là `git status`, `git log`, `git diff`, `git show`.
      - Người quản trị service sửa danh sách (`chat.setCommands`, migration 21): mỗi dòng một lệnh, tối đa 20, mỗi lệnh chỉ gồm tối đa bốn từ chữ thường, nên không có dấu `;`, `&&`, `$(`… Để trống thì leader không chạy lệnh nào.
      - Máy đổi mỗi lệnh thành quy tắc `Bash(<lệnh>:*)` của Claude Code: leader chạy được lệnh đó với mọi tham số. Lệnh khác, kể cả lệnh ghép như `git status && touch x`, vẫn bị chặn (đã thử với Claude Code 2.1.283).
      - Chỉ nên thêm lệnh chỉ đọc. Một lệnh như `npm test` chạy code của repo trên máy của người khác.
    - **Model, mức nỗ lực và mặc định của service** (roadmap 17h).
      - *Chat mới* có ô chọn model (bí danh của Claude Code: fable, opus, sonnet, haiku; hoặc để model của gói) và mức nỗ lực (low đến max, hoặc để mặc định). Máy chạy `claude` với `--model` và `--effort` tương ứng.
      - Người quản trị service bấm *Lưu làm mặc định*: chat mới của service sẽ bắt đầu với máy, gói, model và mức nỗ lực đó (`chat.setDefaults`, migration 20). Form tự điền theo mặc định. Qua API, chat mới không nêu máy hay gói cũng dùng mặc định.
      - Nút bánh răng ở đầu cuộc chat đổi model và mức nỗ lực của thread (`chat.configure`) cho các câu trả lời sau. Tên model chỉ gồm chữ thường, số, `.` và `-`, nên không thể thành một option của CLI.
    - Ô tìm trên danh sách thread: tìm theo tiêu đề và nội dung mọi tin, không phân biệt hoa thường (kể cả chữ có dấu như Đ/đ). `%` và `_` được hiểu đúng là ký tự (roadmap 17f).
    - Người quản trị service đổi tên thread (`chat.rename`) và xoá thread cùng tin nhắn và đề xuất của nó (`chat.delete`). Thread đang chờ câu trả lời thì phải dừng câu trả lời trước khi xoá.
    - Trong câu trả lời, mã task của service và mã run (`R-…`) là link: sang *Task* (mở panel của task) hoặc *Lượt chạy* (mở run đó). Trang hiện `code`, **đậm**, *nghiêng*, khối ``` và link web; phần còn lại giữ nguyên chữ.
    - `#/chat?thread=<số>` mở thẳng một thread; quay lại trang thì thread vẫn mở. Người chỉ có quyền xem đọc được nhưng không gửi được. Link *run …* ở yêu cầu chạy của trang *Task* cũng mở thẳng run đó.
    - Leader làm việc với quyền của token câu trả lời. Máy dùng token role *agent* thì leader chỉ tới mức đóng góp, nên nó không tự tạo task hay xếp run. Nó đề xuất các việc đó (dưới đây).
  - **Leader đề xuất, người quản trị xác nhận** (hỏi ngày 29/9; roadmap 17c-1).
    - Qua MCP của hub, leader có `propose_task` (tạo task, có thể kèm phụ thuộc), `propose_task_status` (chuyển trạng thái kèm ghi chú) và `propose_run` (chạy task trên máy của chat hoặc máy khác, với vai trò, gói, số bản, review sau, chỉ dẫn). Mỗi đề xuất kèm một dòng lý do.
    - Leader không có `task_claim` và `task_update`: nó không tự nhận hay chuyển task. Chỉ token của câu trả lời đang viết mới đề xuất được, tối đa 20 việc mỗi câu trả lời.
    - Hub kiểm ngay khi leader đề xuất: task phải thuộc service của chat (với tạo mới thì chưa có), máy phải có trên hub, chữ không có ký tự ẩn hay secret.
    - Trên trang *Chat*, đề xuất hiện dưới câu trả lời. Người quản trị service bấm *Xác nhận* thì việc chạy như chính họ gọi (`chat.decide`): hub kiểm quyền của họ và ghi tên họ. Bấm *Bỏ qua* thì không có gì chạy.
    - Mỗi đề xuất chỉ được quyết định một lần. Lỗi khi chạy được giữ lại kèm lý do. Kết quả có link: task vừa tạo, hoặc yêu cầu chạy (mở panel của task). Đề xuất vẫn chờ quyết định sau khi câu trả lời đã xong.
    - Câu trả lời có từ hai đề xuất đang chờ thì có *Xác nhận tất cả* và *Bỏ qua tất cả* (`chat.decideAll`, roadmap 17e).
      - Hub chạy lần lượt: tạo task trước, rồi chuyển trạng thái, rồi xếp run; mỗi nhóm theo thứ tự leader đề xuất. Nhờ vậy leader đề xuất được run hay đổi trạng thái cho task mà chính câu trả lời đó tạo.
      - Việc nào lỗi thì dừng ở đó; các việc sau vẫn chờ để người quản trị xem. Việc người khác đã quyết định trong lúc đó thì giữ nguyên.
  - **Leader tự chạy** (roadmap 29c, hỏi 2/10: theo cài đặt từng service, mặc định chờ duyệt hết). Nút *Hướng dẫn leader* → *Leader tự chạy*: người có quyền *Cài đặt service* chọn loại đề xuất leader làm luôn (`chat.setAutonomy`).
    - Leader đề xuất một loại được chọn thì hub chạy ngay bằng quyền của người gửi tin, không hơn. Người đó phải có quyền *Duyệt hành động leader*; thiếu quyền của chính việc đó (vd. không được tạo task) thì đề xuất nằm chờ người có quyền, không thành lỗi. Run hay đổi trạng thái cho task mà câu trả lời mới chỉ đề xuất tạo thì cũng chờ.
    - Thẻ đề xuất có nhãn *tự chạy · thay <người>*; *Nhật ký agent* ghi leader làm thay ai. Kết quả `propose_*` trả *done* / *failed* thay cho *proposed*, nên leader nói được việc nào đã chạy.
    - *Đổi chính sách agent* và *Cho agent chạy lại* luôn chờ người duyệt (`CHAT_ACTION_ALWAYS_CONFIRM`): leader không tự nới giới hạn của chính nó.
  - **Hướng dẫn cho leader** (roadmap 17c-2).
    - Hub có sẵn skill chung `hive-leader`. Skill này nói leader cần: tìm hiểu bằng task, lượt chạy (kể cả kết quả review) và máy; đề xuất thay vì tự làm; không merge; hỏi lại kèm vài lựa chọn khi cần quyết định; ghi đúng mã task và mã run để trang *Chat* làm link.
    - Nhóm sửa skill này trên trang *Skill* như mọi skill khác, hoặc tạo skill riêng cùng tên cho một service. Hub đang chạy nhận skill này một lần khi cập nhật; xoá đi thì hub không tạo lại. Cơ sở dữ liệu local của máy không có skill này.
    - Máy dặn leader đọc `skill_get hive-leader` trước khi trả lời, và nhắc lại: chỉ đề xuất, không merge, hỏi khi cần quyết định.
  - Hub lưu các cuộc trò chuyện (thread) theo service cùng tin nhắn của chúng (migration 15).
  - Gửi tin nhắn bằng `chat.send`. Thread mới cần chọn máy, có thể ghim một gói Claude; tin tiếp theo đi đúng máy và phiên của thread đó.
  - Hub kiểm máy như khi xếp run: đang online, đã bật ô nhận run từ hub, có repo của service, có gói Claude đang bật và đã đăng nhập. Thread đang chờ câu trả lời thì chưa nhận tin mới.
  - Máy nhận câu trả lời cần viết trong trả lời heartbeat. Trong lúc viết, máy báo `chat.progress` (chữ đến đâu, các bước, việc đang làm); câu trả lời của lượt báo cho máy biết người dùng đã huỷ chưa. Xong thì máy báo `chat.finish`, kèm mã phiên Claude Code để lần sau `--resume`. Chữ máy gửi lên được bỏ ký tự ẩn và dòng giống secret.
  - Câu trả lời không máy nào nhận sau 15 phút thì hết hạn; đang viết mà máy im 15 phút thì thành lỗi. Máy tắt ô nhận run thì câu trả lời đang chờ báo lỗi ngay. Thread không ai viết trong 90 ngày bị xoá.
  - Đọc bằng `chat.threads` và `chat.get` theo quyền xem service (`after` để chỉ lấy tin mới). Người quản trị service huỷ câu trả lời bằng `chat.cancel`; phần máy đã viết được giữ lại.
  - **Quyền của leader:** mỗi câu trả lời kèm một token ngắn hạn cho MCP của leader. Quyền của token là phần giao giữa quyền người gửi lúc viết tin và quyền token của máy: role thấp hơn, và với từng service thì mức thấp hơn (service chỉ một bên có thì bỏ). Token hết hiệu lực khi câu trả lời xong, bị huỷ hay hết hạn, và chậm nhất sau 30 phút. Việc leader làm được ghi dưới tên `<gói>.<máy>@chat-<người gửi>`.
  - **Máy viết câu trả lời:** máy đã bật *Được nhận run từ hub* hỏi hub mỗi 3 giây (`chat.poll`; hub cũ thì chờ heartbeat) và viết tối đa 2 câu trả lời cùng lúc.
    - Mỗi câu trả lời dùng một gói Claude đang bật, đã đăng nhập, không nghỉ, chưa chạm ngưỡng (gói ghim của thread nếu có, không thì gói ưu tiên cao nhất).
    - Máy chạy `claude -p` trong repo của service, tin nhắn đi qua stdin. MCP chỉ có server `xdev-hive` của hub, dùng token của câu trả lời (`--strict-mcp-config`), không dùng token của máy.
    - Leader đọc được repo nhưng bị cấm Edit, Write, MultiEdit, NotebookEdit. Nó chỉ chạy được các lệnh của service (mặc định là git chỉ đọc; xem *Lệnh leader được chạy* bên dưới). Không có lệnh nào thì Bash bị cấm hẳn. Tin tiếp theo của thread chạy `--resume` đúng phiên Claude Code của thread.
    - Máy báo lên hub mỗi 2 giây chữ đã viết, các bước (`▶` công cụ, `✓ ✗` kết quả) và việc đang làm. Hub báo đã huỷ thì máy dừng ngay; quá 20 phút thì cũng dừng.
    - Xong thì máy báo câu trả lời, chi phí và mã phiên. Lỗi (hết quota, không có CLI, thoát lỗi, quá giờ) hiện kèm lý do. File chứa token bị xoá khi câu trả lời xong.
- **Trang *Bản đồ agent*** (roadmap 31b; web, nhóm *Vận hành*, `#/machines`; trước là *Máy & run*): mỗi máy một cột, online trước, lọc theo service đang chọn (máy có repo của service). Đầu cột: tên, phiên bản app, online hay lần cuối thấy (mất kết nối sau 2 phút), có nhận run từ hub không.
  - Mỗi gói một thẻ: nhãn, id, loại, tài khoản; trạng thái *Sẵn sàng*, *Đang chạy n/max*, *Nghỉ tới HH:mm* (giờ nghỉ của gói hoặc của tài khoản trên hub), *Chạm ngưỡng*, *Chưa đăng nhập*, *Chưa cài*, *Tắt*, *Máy offline*; % phiên và tuần. Dưới thẻ là run của gói: task, tên, đã chạy bao lâu, việc agent đang làm (`activity` máy đẩy lên cùng run), bấm mở *Lượt chạy*.
  - Cuối cột: *Hàng đợi* (run chưa có gói, yêu cầu run chờ máy nhận), *Bật/tắt và ưu tiên gói* (admin hub và chủ máy), *Xoá* máy đã mất kết nối (admin). Cột phải: *Đợt chạy đang mở* với số đang chạy, chờ thả, task chờ máy rảnh.
  - Người có quyền xếp run chọn thẻ gói (máy online, nhận run, gói bật, có CLI và đăng nhập): *Prompt cho agent* / *Prompt cho N agent* mở hộp prompt (31e) điền sẵn các gói, service là service mọi máy đã chọn đều có; *Giao task cho N agent* mở trang *Task* (`#/tasks?agents=…`): chọn task rồi *Giao*, task thứ nhất cho agent thứ nhất, lần lượt.
  - Trang tự làm mới mỗi 5 giây khi đang hiện. Bên dưới vẫn có *Quota đang nghỉ* và *Chi phí ước tính*. Máy im lặng quá 14 ngày thì hub tự xoá.
- **Phát hiện trùng tên máy**: nếu hai app chạy cùng lúc với cùng tên máy và cùng token, heartbeat của chúng xen kẽ nhau và hub đánh dấu *Trùng tên máy* (trong 5 phút gần nhất). Khởi động lại app chỉ đổi instance một lần nên không bị tính là trùng.
- **Đổi gói từ web** (roadmap 18d): trên *Bản đồ agent* (*Bật/tắt và ưu tiên gói* cuối cột máy), admin hub và chủ máy (tài khoản sở hữu token của máy) có công tắc bật/tắt và ô *Ưu tiên* cho từng gói. Hub giữ thay đổi và gửi xuống ở heartbeat kế tiếp; app lưu vào `config.json` như khi sửa trên trang *Gói sub & agent*, không cần mở lại, và báo bằng thông báo hệ điều hành ai đã đổi. Trang hiện "chờ máy áp dụng" cho tới khi máy báo gói đã như yêu cầu. Thay đổi máy chưa nhận sau 24 giờ thì hub bỏ. Quản trị service và agent (kể cả agent chạy bằng token của chủ máy) không đổi được. Cần app 0.95.0 trở lên trên máy; máy cũ hơn hiện gói nhưng không có công tắc.
- **Quota dùng chung theo tài khoản**: điền *Tài khoản* cho profile (ví dụ `claude-max-duy`). Khi một máy gặp hết quota, nó báo lên hub (`cooldowns.set`). Máy khác có profile cùng tài khoản sẽ bỏ qua gói đó từ lần heartbeat kế tiếp, và thẻ profile hiện "báo từ …". Bấm *Hết nghỉ* (trên thẻ profile hoặc trên trang *Bản đồ agent*) thì mọi máy thử lại gói đó. Profile không điền tài khoản thì chỉ nghỉ trên máy của nó, như trước. Tên tài khoản dùng chung cho mọi token, nên nên đặt tên kèm người sở hữu.

### Trang Quản trị (admin portal)

Trang này có trên hub web và trên app desktop ở chế độ hub, chỉ hiện với admin (tài khoản admin, hoặc token `admin` không thuộc tài khoản nào):

- **Máy**: mọi máy trong team, cùng kết quả *Cài đặt máy* mà máy gửi kèm heartbeat. App kiểm tra lúc mở, sau mỗi lần cài, và 10 phút một lần. Trang hiện CLI và phiên bản, hive-mcp, cấu hình từng repo, gói sub (không gửi lệnh chạy hay `env`), mục thiếu so với chính sách, và lịch sử yêu cầu cài.
- **Yêu cầu cài từ xa**: nút *Yêu cầu cài* (*Yêu cầu nâng cấp* với CLI đã cài nhưng có bản mới, roadmap 33) chỉ có ở mục mà chính máy đó báo là app cài được: CLI qua npm, Spec Kit CLI qua uv, hive-mcp, cấu hình repo, codegraph, superpowers, Spec Kit. Hub không bao giờ gửi lệnh shell tuỳ ý. Máy nhận yêu cầu ở heartbeat kế tiếp và hiện thông báo; ở trang *Cài đặt máy* người dùng phải bấm *Đồng ý và cài* thì app mới chạy, rồi kết quả được gửi lại hub. Yêu cầu chưa ai trả lời sẽ hết hạn sau 24 giờ; admin huỷ được yêu cầu đang chờ.
- **Chính sách**: CLI và hive-mcp bắt buộc trên mọi máy, các phần bắt buộc theo service (cấu hình agent, codegraph, index, superpowers, Spec Kit), và profile mẫu cho team. Profile mẫu không được có `env`, vì thư mục đăng nhập và key là của từng máy. Máy nhận chính sách qua heartbeat: trang *Cài đặt máy* gắn nhãn "bắt buộc", trang *Gói sub & agent* có nút thêm từ mẫu.
- **Chính sách agent** (roadmap 27a, thẻ *Agent* trên trang *Chính sách*): hub có một mặc định, mỗi service có thể có thêm phần riêng. Chính sách gồm:
  - model được dùng theo loại agent;
  - mức tự chủ: chỉ đọc, đề xuất, sửa hoặc toàn quyền;
  - mạng: tắt, danh sách host, hoặc mở;
  - các MCP server được bật.

  Phần riêng của service chỉ siết thêm mặc định, không nới được. Cột *Hiệu lực* cho thấy kết quả sau khi gộp. Admin hub sửa mặc định. Người có quyền Cài đặt service sửa dòng của service mình, ở đây hoặc ở trang *Hệ thống*. Máy nhận phần của các service mình có qua heartbeat. Runner ép chính sách khi dựng lệnh cho mỗi run (chế độ local không có chính sách, giữ như cũ):
  - **gói bị chặn** được bỏ qua như gói hết quota, lý do ghi vào log run: gói đặt model ngoài danh sách, hoặc mạng không phải *mở* mà gói không chạy trong container, hoặc gói CLI tự đặt khi chính sách hạn chế mức tự chủ hay MCP. Không còn gói nào nhận được thì run lỗi ngay, kèm lý do của từng gói;
  - **model**: gói không đặt `--model` thì nhận model đầu tiên của danh sách;
  - **mức tự chủ**: lấy mức thấp hơn giữa chính sách và cờ của gói, rồi thay cờ quyền (`--permission-mode` của Claude, `--sandbox` của Codex, `--approval-mode` của Gemini). Mức *chỉ đọc* còn khoá Hive chỉ đọc cho run. Chính sách chỉ hạ, không bao giờ nới cờ của gói: gói Claude chạy `--permission-mode acceptEdits` chỉ tự sửa file dù chính sách là *Toàn quyền*. Muốn agent chạy lệnh (git, swift, xcodebuild…) thì sửa args của gói trên máy, vd `--allowedTools "Bash(git:*)"` hoặc `--permission-mode bypassPermissions`. Thẻ mỗi gói ở *Agent và quota* hiện mức của gói, chính sách máy nhận được và mức hiệu lực;
  - **mạng**: container `open` bị ép thành `restricted`; *tắt* bỏ hết host thêm của gói, *danh sách host* chỉ giữ host thêm có trong danh sách;
  - **MCP**: Claude chỉ nhận xdev-hive và các server được phép trong `--mcp-config`, Gemini nhận `--allowed-mcp-server-names`, Codex tắt các server còn lại trong `~/.codex/config.toml` bằng `-c mcp_servers.<tên>.enabled=false`.

  Log của run có một dòng `# policy …` ghi chính sách đang dùng.
- **Chốt chặn theo bước (SDLC)** (roadmap 34, trang *Chính sách*; quản trị service thấy phần service mình ở trang *Service*): bảy chốt `spec`, `plan`, `tasks` (sau từng bước Spec Kit), `dispatch` (trước khi task của luồng chạy), `review` (kết luận review có đủ để đi tiếp), `fix` (review cần sửa thì xếp lượt sửa), `merge` (MR xanh thì merge).
  - Mỗi chốt một chế độ: *Người duyệt*, *AI kiểm* (agent vendor khác đọc kết quả; đạt thì cho qua, không chắc thì chuyển cho người) hoặc *Tự động*.
  - Admin hub đặt trần cho từng chốt (mặc định không giới hạn). Quản trị service chọn trong trần; chế độ trên trần không chọn được, và hạ trần thì service bị kéo xuống ngay (lựa chọn của service vẫn giữ để dùng lại khi trần lên). Service chưa đặt gì thì mọi chốt là *Người duyệt*, tức như trước.
  - Mỗi service còn có *Lượt sửa* tối đa (mặc định 2) và số task của luồng chạy cùng lúc.
  - `sdlc.get`, `sdlc.setCeiling` (admin hub), `sdlc.setProject` (quyền *Cài đặt service*); mỗi lần đổi vào nhật ký quản trị.
  - **Luồng Spec Kit** (34b): bấm một bước trên trang *Spec* là mở một luồng (`specs.runStep`: hub tạo task nếu cần, xếp run bước, ghi luồng). Máy đẩy run xong thì hub áp chốt của bước đó:
    - *Người duyệt*: luồng dừng; thẻ *Luồng* trên trang *Spec* và panel task có *Duyệt, sang bước sau* và *Yêu cầu sửa* (agent làm lại bước đó với ghi chú làm chỉ dẫn).
    - *AI kiểm*: hub xếp một run review trên gói vendor khác của cùng máy, đọc spec/plan/tasks rồi kết luận; `Verdict: approve` thì đi tiếp, còn lại chuyển cho người kèm báo cáo.
    - *Tự động*: xếp bước kế luôn.
  - Bước kế chạy trên cùng máy và cùng branch `ai/<task>`. Hub cần biết thư mục `specs/<…>` mà bước specify tạo, và `tasks.md` mới nhất cho bước nhập task, nên app (từ 0.116.0) đẩy spec ngay sau khi báo run xong. Qua chốt `tasks` thì hub nhập `tasks.md` vào board (như *Nhập thành task*).
  - Run lỗi hay yêu cầu bị từ chối thì luồng dừng, có nút *Chạy lại bước*. Task đang trong luồng chạy thì không xếp run tay được (`errors.taskInFlow`). Mỗi lần qua chốt ghi vào `sdlc_gates` (ai quyết: người, run review, hay tự động).
  - **Task của luồng** (34c, 34d): nhập xong `tasks.md` là tới chốt `dispatch`; qua chốt thì hub đưa các task vào một đợt chạy (máy rảnh, *Song song* của service, review chéo trừ khi chốt `review` là *Tự động*). Mỗi task đi tiếp:
    - `review`: *AI kiểm* lấy kết luận của review chéo (*đạt* → merge, *cần sửa* → chốt `fix`, không đọc được → người); *Người duyệt* chờ người bấm *Đạt, sang merge* hoặc *Yêu cầu sửa*; *Tự động* bỏ review.
    - `fix`: xếp lượt sửa trên đúng máy có branch, chỉ dẫn là báo cáo review (như *Xếp lượt sửa*), tối đa *Lượt sửa* của service; hết lượt thì chuyển người. *Người duyệt*: *Xếp lượt sửa* hoặc *Dừng, tôi tự xử lý*.
    - `merge`: chờ MR mở, không nháp, pipeline *success*; rồi hub nhờ máy merge (như nút *Merge*, người yêu cầu ghi `sdlc`), AI kiểm lần cuối, hoặc chờ người. Chưa có MR, MR vẫn nháp, hay không có CI sau 15 phút thì chuyển người.
    - Duyệt review và merge cần quyền *Review code* và không được là người đã mở luồng (luật 27c, như merge từ web). Panel task hiện giai đoạn, số lượt sửa và nút của chốt đang chờ.
- **Trần chi tiêu** (roadmap 27b, thẻ trên trang *Chi phí*): admin hub đặt trần cho một service, một người yêu cầu run, hoặc cả hub, theo ngày hoặc theo tháng (giờ của hub). Trần tính bằng USD (giá API ước tính, như trang *Chi phí*), bằng số run, hoặc cả hai.
  - Run được tính cho người yêu cầu nó trên web; run chạy từ Board được tính cho tài khoản sở hữu token của máy.
  - Hết trần thì hub không nhận *Giao run* mới (`errors.budgetExceeded`). Máy nghe qua heartbeat và giữ run mới trong *Hàng đợi* kèm lý do, kể cả run từ Board. Run đang chạy vẫn chạy tiếp.
  - Luật cảnh báo *Gần trần chi tiêu* mở ở 70% và 90%, *Hết trần chi tiêu* mở khi chạm 100%; cả hai gửi qua webhook như các luật khác. Sang ngày hoặc tháng mới thì trần tự mở lại.
- **Nhật ký**: mọi thao tác thay đổi dữ liệu của admin (sửa tài liệu, duyệt/từ chối, memory, task, token, chính sách, yêu cầu cài), đăng nhập, tạo/sửa/khoá tài khoản, đổi quyền, đặt lại mật khẩu, và kết quả máy báo về. Không ghi lượt đọc.
- **Nhật ký agent** (roadmap 27c): mọi lần agent ghi (nhận và cập nhật task, đề xuất, memory, chat) cũng vào *Nhật ký*, kèm ba cột: agent (nhãn `x-hive-agent`, vd. `claude-1.<máy>`), người mà agent chạy thay (chủ token), và id run (`hive-mcp` gửi `x-hive-run` từ `HIVE_RUN` của runner). Trang *Nhật ký* (web, *Quản trị*) lọc theo agent, người và run (`claude-1` tìm được `claude-1` trên mọi máy); bấm id run để mở run đó ở *Lượt chạy*.
- **Không tự duyệt** (roadmap 27c, thẻ *Tự duyệt* trên trang *Chính sách*): không ai duyệt đề xuất hay memory của chính mình, hay chuyển sang *Xong* task mà run làm nó do chính mình yêu cầu (từ web, hoặc chạy từ Board của máy dùng token của mình). Agent chạy bằng token của ai thì tính là người đó. Hub trả lỗi `errors.selfApprove`. Mặc định *Admin hub được tự duyệt*, cho hub chỉ có một người; chọn *Không ai được tự duyệt* khi team có người duyệt chéo. MR watcher vẫn chuyển task sang *Xong* khi MR merge, vì merge trên GitLab hay GitHub đã là một lần người khác duyệt.
- **Cảnh báo** (roadmap 22m): hub kiểm các luật mỗi phút và mở sự cố, gửi tới webhook có bật sự kiện *Cảnh báo*. App desktop ở chế độ hub, khi token là của admin hub, hỏi hub mỗi phút và bật thông báo hệ điều hành cho sự cố mới chưa ai bấm *Đã biết*; bấm thông báo thì mở trang *Cảnh báo* trên trình duyệt. Lúc mở app, sự cố mở hơn 10 phút trước không được báo lại; hơn 3 sự cố mới cùng lúc thì gộp một thông báo.
- **Người dùng & quyền**: tạo tài khoản, cấp quyền theo service, cấp/bỏ admin, đặt lại mật khẩu, khoá.
- Trang **Token** có thêm cột *Tài khoản* và *Máy*: token thuộc ai, các máy đang dùng từng token.

**Dừng mọi agent** (`agents.stop`, roadmap 27d): nút trên *Vận hành* → *Tổng quan* của web dừng cả hub (chỉ admin hub). Nút cùng tên trên trang service dừng một service (cần quyền xếp run của service đó).
- Hub huỷ các yêu cầu run và câu trả lời chat đang chờ, rồi báo máy dừng run đang chạy. Hộp xác nhận ghi trước số yêu cầu sẽ huỷ và số run sẽ dừng.
- Trong lúc tạm ngưng, hub từ chối xếp run và chat leader. Mọi máy, kể cả máy không nhận run từ hub, dừng run đang chạy của phạm vi đó và không bắt đầu run mới, kể cả run bấm trên Board. Run trong hàng đợi nằm lại đó, kèm lý do. Board hiện dải báo ai tạm ngưng, lúc nào.
- Bấm *Cho agent chạy lại* (`agents.resume`) thì gỡ tạm ngưng. Tạm ngưng cả hub và tạm ngưng một service gỡ riêng. Cả hai thao tác đều ghi vào *Nhật ký* và gửi webhook (sự kiện *Dừng mọi agent*, *Cho agent chạy lại*).

Agent không có app desktop (CI, cloud) gọi thẳng MCP qua HTTP: `POST https://<hub>/mcp`, header `Authorization: Bearer <token agent>`, tuỳ chọn `x-hive-agent: <tên>`.

**Agent chỉ đọc**: tạo token vai trò `viewer` cho agent chỉ cần tra cứu, ví dụ bot review hoặc CI đọc quy chuẩn. Với token này, MCP chỉ có các tool đọc: `memory_search`, `doc_list`, `doc_get`, `skill_list`, `skill_get`, `task_list`, `task_notes`, `task_next`, `run_list`, `run_get`, `run_requests`, `machine_list`, `setup_missing`, `cost_summary`, `policy_get`. Tool ghi không có trong danh sách, và hub cũng từ chối lệnh ghi.

Trên app desktop, profile có tuỳ chọn *Chỉ đọc Hive*:
- Runner đặt `HIVE_READONLY=1` cho run của profile đó; `hive-mcp` thấy biến này thì chỉ mở tool đọc.
- Prompt bỏ các bước ghi memory, đề xuất và cập nhật task; agent ghi ghi chú bàn giao vào câu trả lời cuối, runner chuyển task và lưu tóm tắt như thường.
- Claude Code luôn nhận biến này qua cấu hình MCP do app sinh. Codex và Gemini chỉ nhận nếu CLI chuyển biến môi trường cho server MCP.
- Đây là rào chắn chống ghi nhầm hoặc ghi do prompt injection, không phải ranh giới bảo mật: agent chạy cùng user hệ điều hành vẫn đọc được token của máy.

## Bảo mật

- Mật khẩu băm bằng scrypt (salt riêng); so sánh thời gian cố định, kể cả khi tên đăng nhập không tồn tại. Sai 5 lần thì cặp IP + tên đăng nhập bị khoá 15 phút.
- Phiên web: cookie `HttpOnly`, `SameSite=Strict` (thêm `Secure` sau proxy TLS), hết hạn sau 14 ngày; hub chỉ lưu SHA-256 của phiên. Request ghi bằng cookie phải có header `x-hive-csrf` và Origin trùng host. Đổi hoặc đặt lại mật khẩu thì các phiên khác bị đăng xuất.
- Token chỉ lưu SHA-256, plaintext hiện một lần. Không thu hồi được token admin cuối cùng không thuộc tài khoản nào (đường vào khi mất hết mật khẩu). MCP qua HTTP chỉ nhận token, không nhận cookie.
- Memory và tài liệu bị từ chối nếu chứa chuỗi giống secret (AWS, GitHub, GitLab, Slack, `sk-…`, JWT, private key, token Hive).
- Tài liệu (nội dung, tiêu đề, ghi chú), đề xuất (nội dung, lý do) và memory bị từ chối nếu có ký tự ẩn. Những ký tự này làm chữ người xem thấy khác chữ agent đọc:
  - ký tự điều khiển hướng chữ (U+202A–202E, U+2066–2069, U+200E/200F, U+061C);
  - ký tự tag (U+E0000–E007F), dùng để giấu lệnh cho model;
  - bộ chọn biến thể bổ sung (U+E0100–E01EF);
  - ký tự độ rộng 0 (U+200B–200D, U+2060–2064, U+FEFF, U+180E).

  Emoji vẫn dùng được, kể cả emoji ghép bằng ZWJ và cờ vùng dùng ký tự tag. Lỗi báo mã ký tự, dòng và cột. Trang Tài liệu và Memory cảnh báo trước khi lưu và có nút *Xoá ký tự ẩn*.
- **Nguồn ghi**: mỗi phiên bản tài liệu, đề xuất và memory lưu thêm nguồn.
  - Lưu gì: kênh ghi (`web`, `desktop`, `mcp`, `api`); với agent thì thêm máy, run và task.
  - Hiện ở đâu: cạnh tên người ghi trong lịch sử tài liệu, trang Đề xuất và Memory, ví dụ `qua MCP · duy-mbp · run R-1fa9e2 · task T-7`.
  - Ai quyết định kênh: hub, không phải client. Cookie là `web`, `/mcp` là `mcp`. Token không tự xưng `web` được, thiếu hoặc sai thì ghi `api`.
  - Máy, run, task: client tự báo qua header `x-hive-source` (hoặc `HIVE_RUN`/`HIVE_TASK` của `hive-mcp`). Hub chỉ kiểm định dạng.
  - Run của Claude Code luôn có run và task, vì app đưa chúng vào cấu hình MCP. Với CLI khác thì tuỳ CLI có chuyển biến môi trường cho server MCP hay không.
  - Phiên bản tạo khi duyệt đề xuất giữ nguồn của đề xuất; người duyệt nằm trong nhật ký. Memory không ghi `taskId` thì lấy task của run.
- Desktop: `contextIsolation`, `sandbox`, preload chỉ lộ đúng các hàm cần. IPC kiểm tra nguồn gọi. CSP trong bản build.
- `~/.xdev-hive/config.json` có quyền `0600` vì có thể chứa token hub.
- Web chỉ lưu token trong `localStorage` khi đăng nhập bằng token (tuỳ chọn cho CI, khôi phục); đăng nhập bằng tài khoản thì dùng cookie phiên.

## Làm việc trên repo này với Claude Code

Hive có danh mục tool theo dự án; browser là seed tắt mặc định. Repo còn có sẵn cấu hình cho codegraph, superpowers và shadcn: mỗi công cụ cần mỗi người **đồng ý một lần trên máy của mình** khi Claude Code hỏi lúc mở repo.

- **[Playwright MCP](https://github.com/microsoft/playwright-mcp)** (`browser`, seed trong danh mục tool): duyệt/test web cho Claude và Codex, bản ghim `0.0.83`, headless, tắt mặc định. Bật theo dự án; policy MCP cần cho phép `browser`. Profile và output nằm trong `{runDir}`, ảnh tự đặt tên được gửi thành artifact của run. Tài khoản test khai báo **tên** biến trong `secretEnv` và đặt giá trị ở env profile/máy; agent điền form bằng tên `TEST_USER`/`TEST_PASSWORD`, không đọc hay đưa giá trị vào prompt. Sửa secretEnv cần máy tin cậy lại hash. Container cần image có Chrome/Node/npm và egress cho `registry.npmjs.org`, host trang/API/CDN/IdP được test. Xem [cấu hình và kiểm tra browser](docs/specs/65-browser.md).
- **[codegraph](https://github.com/colbymchenry/codegraph)** (MCP, khai báo trong `.mcp.json`): đồ thị symbol của code, lưu trong SQLite ngay trên máy, không cần API key. Tool chính là `codegraph_explore`, trả về mã nguồn liên quan kèm đường gọi hàm trong một lần gọi. Chạy qua `npx` với phiên bản ghim `1.6.0`. Lần đầu, npm tải gói cho đúng nền tảng (bản macOS arm64 khoảng 290 MB sau khi giải nén, vì có kèm runtime Node riêng).
  - Tạo index một lần trên mỗi máy: `npm run codegraph:init`. Index nằm ở `.codegraph/` (đã gitignore). Sau đó MCP server (có một daemon nền cho mỗi project) tự cập nhật khi file đổi. Chưa có index thì tool chỉ trả về hướng dẫn, không báo lỗi.
  - Codegraph mặc định gửi thống kê sử dụng ẩn danh ([TELEMETRY.md](https://github.com/colbymchenry/codegraph/blob/main/TELEMETRY.md)). Vì vậy `codegraph:init` chạy `codegraph telemetry off` trên máy trước (bật lại bằng `telemetry on`), và `.mcp.json` đặt `CODEGRAPH_TELEMETRY=0` cùng `CODEGRAPH_NO_UPDATE_CHECK=1`. Phiên bản đã ghim nên không cần kiểm tra bản mới.
- **[superpowers](https://github.com/obra/superpowers)** (plugin, khai báo trong `.claude/settings.json` → `enabledPlugins`): bộ skill cho TDD, debug, lập kế hoạch… cùng hook lúc bắt đầu phiên. Plugin lấy từ marketplace chính thức `claude-plugins-official`. Nếu Claude Code báo plugin đã bật nhưng chưa cài, chạy `/plugin install superpowers@claude-plugins-official`.
- **[shadcn](https://ui.shadcn.com/docs/mcp)** (MCP, trong `.mcp.json`): tìm, xem ví dụ và lấy lệnh thêm component shadcn/ui từ registry. Chạy `npx shadcn@4.21.0 mcp --cwd packages/ui`, vì `components.json` nằm ở `packages/ui`. Thêm component bằng tay: `cd packages/ui && npx shadcn@4.21.0 add <tên>`; component được đặt vào `src/components/ui/`.

Các cấu hình trong `.mcp.json` và `.claude/settings.json` nói trên áp dụng cho Claude Code. Browser của danh mục tool được runner cấu hình cho cả Claude và Codex. Codex và Gemini dùng được codegraph qua `codegraph install` (lệnh này ghi vào cấu hình toàn cục của từng agent trên máy).

## Ngôn ngữ giao diện

Web hub và app desktop có tiếng Việt (mặc định) và tiếng Anh. Chọn ở trang đăng nhập hoặc menu tài khoản → *Ngôn ngữ*; lựa chọn lưu trên trình duyệt/máy đó. Trên app desktop, menu tray, thông báo và hộp thoại theo cùng ngôn ngữ (ghi vào `locale` trong `~/.xdev-hive/config.json`).

Chuỗi giao diện nằm ở [`packages/ui/src/i18n`](packages/ui/src/i18n): `locales/vi.ts` là nguồn (mọi key), các ngôn ngữ khác phải dịch đủ key (TypeScript báo thiếu, `npm test` kiểm thêm placeholder). Thêm một ngôn ngữ:

1. Chép `locales/en.ts` thành `locales/<mã>.ts` và dịch.
2. Thêm một dòng vào `LOCALES` trong `translate.ts` (tên hiển thị, mã `Intl`, file dịch).

Lỗi từ hub và core mang `key` (vd `errors.taskHeld`) cùng `vars`: giao diện dịch theo catalog, còn agent qua MCP vẫn nhận message gốc. Thêm lỗi mới cho người dùng thì truyền `{ key: "errors.…" }` vào `HiveError` và thêm chuỗi vào catalog (`npm test` báo key thiếu).

Chuỗi số nhiều viết `{ one: "…", other: "…" }` (thêm `zero`/`two`/`few`/`many` nếu ngôn ngữ cần). Trong component: `const t = useT(); t("nav.docs")`, `t("password.tooShort", { min: 10 })`. Các trang còn lại đang được chuyển dần (xem [docs/roadmap.md](docs/roadmap.md)).

## Việc tiếp theo

Danh sách chi tiết và tiến độ: [docs/roadmap.md](docs/roadmap.md).

- Postgres (+ pgvector) khi team lớn.
- Đọc quota còn lại chủ động (nếu CLI có lệnh báo usage) thay vì chỉ phản ứng khi đã hết.
- Ký và notarize bản macOS (cần chứng chỉ Developer ID).

### Gemini CLI (63a)

- Cài và kiểm phiên bản trong Setup (`@google/gemini-cli`). Adapter được đối chiếu với **0.63.0**; chưa kiểm CLI thật đã đăng nhập hay macOS/Windows thật. Template giữ quyền `auto_edit`, tương đương tự duyệt sửa file; shell cần cho phép riêng, không tự chuyển thành `yolo`. Profile chỉ đọc và bước chờ duyệt kế hoạch dùng `--approval-mode plan`.
- Headless nhận prompt qua stdin, dùng `--output-format stream-json` mặc định; profile chọn `json` hoặc `text` vẫn giữ lựa chọn. Parser đọc init/session, assistant deltas, tool calls/results, errors và result; lỗi native vẫn làm run thất bại dù exit code 0. Token input mới đã trừ cache; không quy đổi token thành quota hay đoán giá USD.
- Chỉ dẫn giữa lượt nằm ở `.xdev-hive/steer.md`; nếu CLI native hỗ trợ `--resume`, runner tiếp tục đúng session ID khi lượt kết thúc, giữ cờ policy và cộng usage các lượt. Không dùng session `latest`.
- Model router 54c dùng alias `flash` cho light, `auto` cho standard, `pro` cho strong/max. Alias chỉ được công bố sau probe phiên bản ≥ 0.63, không phải chứng nhận quyền truy cập model. Không truyền `--effort` cho Gemini. Model pin của profile và whitelist policy vẫn ưu tiên.
- MCP của run ở `.gemini/settings.json` trong worktree, có profile/project/task/run/read-only đúng lượt; file sinh ra không vào commit. Container mount `<GEMINI_CLI_HOME>/.gemini` nếu dùng tài khoản riêng.
- Đăng nhập Google / nhập API key bằng terminal CLI chính thức. API key cũng có thể đặt ở `GEMINI_API_KEY` trong env của profile. Lệnh/script đăng nhập không giữ key. Không tạo request chỉ để kiểm login hay quota. Hai tài khoản thật, refresh OAuth, giới hạn miễn phí thực tế và điều khoản tự động hoá **chưa kiểm chứng**; UI nói rõ và dẫn nguồn: [authentication](https://geminicli.com/docs/get-started/authentication/), [quota/pricing](https://geminicli.com/docs/resources/quota-and-pricing/), [model](https://geminicli.com/docs/cli/model/), [terms/privacy](https://geminicli.com/docs/resources/tos-privacy/).
- Kiểm tra adapter bằng fake-agent: `env -u RTK_DB_PATH node --test apps/desktop/test/gemini.test.ts` và nhóm `Gemini native runner` trong `runner.test.ts`; không cần key hoặc account thật.

### Mistral Vibe (provider 63c)

Chọn loại `vibe` trong *Agent và quota*. *Cài đặt* cài bản đã kiểm hợp đồng **2.26.0** bằng `uv tool install --python 3.12 mistral-vibe==2.26.0`; cần [uv](https://docs.astral.sh/uv/getting-started/installation/). Bản cài bằng cách khác phải cập nhật bằng bộ cài gốc. *Thêm tài khoản / Đăng nhập* mở `vibe --setup` trong terminal; key không đi vào argv hay script. Tài khoản bổ sung dùng `VIBE_HOME` riêng; runner bỏ key Mistral kế thừa từ shell khi profile có thư mục riêng, trừ key mà người dùng đặt rõ trong env của profile. Login và quota giữ **chưa rõ**, vì Vibe chưa có lệnh cục bộ để kiểm chúng mà không gọi model.

Lệnh run: `vibe --prompt "…" --output streaming --agent accept-edits --trust`. `accept-edits` tự duyệt sửa file; quyền cần hỏi trong programmatic được CLI từ chối, không có người chờ duyệt. Chỉ chọn `auto-approve` khi cho phép toàn bộ tool; đây không phải sandbox hệ điều hành. Policy chỉ đọc dùng `plan` cùng danh sách tool đọc và Hive read-only; policy giới hạn MCP bị từ chối vì việc lọc server từ cấu hình người dùng/dự án chưa xác minh. MCP Hive được cấp qua env, mang profile/project/task/run. Parser nhận history entries NDJSON (và JSON cuối), assistant/tool/error; token lấy từ metadata phiên của **riêng run**, không suy quota hay chi phí hóa đơn. Khi có chỉ dẫn mới, runner resume đúng ID phiên trên cùng profile, không dùng `--continue` toàn máy.

Bộ chọn 54c chọn alias bằng `VIBE_ACTIVE_MODEL`, không dùng `--model`/`--effort`. Đọc alias `[[models]]` đơn giản trong `$VIBE_HOME/config.toml` hoặc `VIBE_MODELS`; cấu hình phức tạp chưa đọc được thì báo chưa rõ. Light/standard/strong mặc định cùng alias first-party của 2.26.0 (`mistral-medium-3.5`), không tự chuyển sang backend/model trả phí khác; quản trị có thể chọn alias đã cấu hình. Catalog cấu hình không chứng minh quyền dùng miễn phí. `local` đòi hỏi backend local do người dùng cấu hình.

[Pricing Mistral](https://mistral.ai/pricing/) quảng cáo Free coding giới hạn và credits; cấp credits thực tế, session/ngày, yêu cầu thẻ, quyền dùng từng model và [điều khoản headless](https://legal.mistral.ai/terms/) **chưa kiểm chứng bằng tài khoản**. Xem [thiết lập/key/profile](https://docs.mistral.ai/vibe/code/cli/api-keys-profiles) và dashboard Mistral để kiểm entitlement/usage. Chỉ kiểm bằng fake-agent; chưa đăng nhập hay gọi inference. UNIX là mục tiêu hỗ trợ chính thức; Windows/container chưa thử thật.

Vibe có thể ghi đè tên agent có sẵn bằng `.vibe/agents/<tên>.toml`. Runner từ chối agent `ask`/`plan`/`accept-edits` bị ghi đè, hoặc khai báo thêm đường tìm agent chưa xác minh; read/propose chỉ bật read_file, grep và Hive read-only. MCP trong danh mục được đăng ký theo cấu hình native; ngoài Hive, quyền gọi headless vẫn theo `tools.<server>_<tool>.permission` trong config.toml của Vibe (ASK bị từ chối), không bật auto-approve toàn cục. Container Vibe cần hub để dùng MCP HTTP; Docker và Windows chưa kiểm chứng thực tế.
