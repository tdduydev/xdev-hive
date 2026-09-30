# xDev Hive

Tài liệu, memory và task dùng chung cho nhiều coding agent (Claude Code, Codex, Gemini CLI, Cursor…) chạy trên nhiều gói subscription khác nhau.

```
┌─ xDev Hive.app (Electron, menu bar) ─┐        ┌─ Hub web (Express) ─────────────────┐
│ Tài liệu · Đề xuất · Memory · Task   │  HTTP  │ /api/rpc   UI + tài khoản, quyền    │
│ Dự án & cài đặt: sync, cài agents    │ ─────▶ │ /mcp       MCP Streamable HTTP      │
└──────────────┬───────────────────────┘        │ SQLite: docs, proposals, memory,    │
               │ local.db hoặc hub              │ tasks, users, tokens                │
      hive-mcp (stdio) ◀── Claude Code · Codex · Gemini (mỗi agent = 1 gói sub)
```

- **Tài liệu**: bản gốc của `AGENTS.md`, quy chuẩn chung (`org/*`), nhật ký quyết định. Có version, lịch sử và diff.
- **Tài liệu theo đường dẫn**: tài liệu có ô *Áp dụng cho* (glob, vd. `apps/web/**`, `**/*.test.ts`) không nằm trong `AGENTS.md` chính, để file này ngắn.
  - Glob có thư mục: ghi vào `AGENTS.md` lồng trong thư mục đó (vd. `apps/web/AGENTS.md`), trong một block có marker. Phần repo tự viết ngoài block vẫn giữ.
    - Codex đọc `AGENTS.md` lồng. Claude Code (từ 2.1.277) đọc nó khi mở file trong thư mục đó.
  - Glob không có thư mục: ghi vào `.claude/rules/xdev-hive/<tên>.md` với frontmatter `paths:` (rule theo đường dẫn của Claude Code).
  - `AGENTS.md` chính chỉ có danh sách: glob nào thì đọc file nào, nên agent khác vẫn tìm được.
  - Đổi hay xoá đường dẫn thì lần đồng bộ sau gỡ block hoặc xoá file cũ.
  - `AGENTS.md` quá 200 dòng thì báo đồng bộ nhắc chuyển bớt.
  - Hook Claude, pre-commit và commit của runner cũng chặn các file này như `AGENTS.md`. `AGENTS.md` lồng mà không có block của Hive là của team, không bị chặn.
  - Tài liệu `agents` và `decisions` của dự án là cho cả repo, không đặt đường dẫn được. Tài liệu `org/*` có đường dẫn chỉ vào repo khi bật *Đưa vào AGENTS.md*.
- **Đề xuất**: agent không sửa tài liệu trực tiếp mà gọi `doc_propose`, admin duyệt. Nếu tài liệu đã đổi sau khi agent đọc, đề xuất bị đánh dấu xung đột, không ghi đè.
- **Skill** (hỏi ngày 29/9: ghi vào repo khi đồng bộ; chung team và riêng dự án; agent đề xuất, admin duyệt; Claude Code nạp file, Codex/Gemini đọc qua MCP):
  - Skill là tài liệu có key `org/skills/<tên>` (cả team) hoặc `project/<dự án>/skills/<tên>`. Nội dung là một `SKILL.md` của Claude Code: front matter có `name` (trùng `<tên>`: chữ thường, số, `-`, tối đa 64) và `description` (việc skill làm và khi nào dùng, tối đa 1024 ký tự), rồi đến các bước. Hub từ chối skill thiếu hoặc sai hai trường đó, và cũng chặn secret như với tài liệu.
  - Skill không bao giờ vào `AGENTS.md` và không giới hạn theo đường dẫn.
  - Agent dùng MCP: `skill_list` (tên và mô tả; skill của dự án thay skill chung cùng tên), `skill_get` (của dự án trước, không có thì của team), `skill_propose` (SKILL.md đầy đủ; `shared: true` cho cả team). Đề xuất đi qua trang *Đề xuất* như tài liệu.
  - MCP cũng có ba tool chỉ đọc, dùng ở chế độ hub:
    - `run_list`: lượt chạy máy đã báo lên hub, gồm task, việc, máy, gói, trạng thái, tóm tắt kết quả và MR.
    - `run_get`: một run kèm phần cuối log, secret đã ẩn.
    - `machine_list`: máy nào online, có nhận run từ hub không, có repo của dự án nào, và trạng thái các gói.
  - Trang *Skill* (web và app, nhóm Làm việc):
    - Danh sách skill theo phạm vi đang chọn ở thanh bên. Khi chọn một dự án, trang hiện đúng bộ skill agent của dự án đó nhận: skill riêng có nhãn *thay skill chung*, skill chung cùng tên bị làm mờ với nhãn *không dùng ở dự án này*.
    - Soạn skill bằng ô tên, ô mô tả (đếm tới 1024 ký tự) và phần hướng dẫn; front matter được ghép tự động, giữ nguyên các khoá khác như `allowed-tools`. Nút *Thay đổi* hiện diff trước khi lưu.
    - Người quản trị (dự án hoặc Chung) lưu thẳng và tạo skill mới. Người đóng góp gửi đề xuất, admin duyệt ở trang *Đề xuất*.
    - Mỗi skill hiện số đề xuất đang chờ duyệt, kể cả đề xuất agent gửi bằng `skill_propose`.
  - Trang *Tài liệu* vẫn tạo và sửa được skill (tên `skills/<tên>`), kèm lịch sử phiên bản.
  - **Trong repo**: *Đồng bộ tài liệu* ghi mỗi skill của dự án (skill chung + skill riêng, riêng thay chung cùng tên) vào `.claude/skills/<tên>/SKILL.md`, nên Claude Code tự nạp skill như skill của nó. Front matter nằm đầu file như Claude Code cần, phần còn lại trong khối quản lý của Hive. Worktree của run lấy skill theo branch như `AGENTS.md`.
  - `AGENTS.md` có mục *Skills* trong khối của Hive: tên và mô tả từng skill, để Codex, Gemini và agent khác gọi `skill_get` khi mô tả khớp việc.
  - Skill bị xoá hay đổi tên trong Hive thì lần đồng bộ sau gỡ file và thư mục của nó. Repo tự có skill cùng tên (không có khối của Hive) thì giữ nguyên, báo *đã bỏ qua*.
  - Hook của Claude, pre-commit và commit của runner chặn sửa skill của Hive như `AGENTS.md`; skill riêng của repo thì agent vẫn sửa và commit được. Repo đã cài từ bản trước cần bấm cài lại *Cấu hình agent* ở *Cài đặt máy* để hook biết skill.
  - Chưa làm: trang Skill riêng (roadmap 14c).
- **Memory**: `memory_write` / `memory_search`, tìm kiếm FTS5 có dấu hoặc không dấu đều được. Trên hub, memory do agent ghi cần admin duyệt mới hiện cho agent khác. Memory *chung* (`memory_write` với `shared: true`) áp dụng cho mọi dự án, và `memory_search` của dự án nào cũng thấy (có `project: null`).
- **Memory còn dùng không**:
  - Hub đếm mỗi lần `memory_search` của agent trả về một mục, và ghi lần cuối. Người xem trên trang Memory không làm tăng số này.
  - Mục không được dùng, ghi hay giữ lại trong 90 ngày (`HIVE_MEMORY_STALE_DAYS`) thành *cũ*: `memory_search` của agent bỏ qua nó. Nó không bị xoá.
  - Trang Memory có lọc *Chỉ mục cũ*, nhãn *Cũ*, và nút *Giữ lại* (quyền quản trị dự án) để mục đó tính lại từ hôm nay.
  - Một mục đã cũ không tự trẻ lại nhờ agent, vì agent không còn tìm thấy nó; phải có người xem và giữ lại.
- **Memory trích dẫn file**: `memory_write` nhận `files` (tối đa 10 đường dẫn tính từ gốc repo; không có `/` đầu, `\`, hay `..`).
  - App desktop so các file đó với nhánh của dự án mỗi 30 phút (nhánh đích MR nếu có, không thì `HEAD`; nhánh local, không có thì `origin/…`). Nó dùng `git cat-file` nên chỉ đọc bản đã commit, không đọc thay đổi chưa commit.
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
  - Mỗi webhook chọn sự kiện, lọc theo dự án (để trống là tất cả, kể cả dữ liệu chung và yêu cầu cài) và ngôn ngữ tin. Tin có nút mở đúng trang trên hub.
  - URL webhook là bí mật: chỉ nhận `https`, lưu trên hub, trang chỉ hiện dạng che (`https://hooks.slack.com/…x9Qa`). Sửa mà để trống URL thì giữ URL cũ. Lỗi gửi chỉ ghi `HTTP 500`, `timeout` hay `network error`, không ghi URL.
  - Nút *Gửi thử* gửi một tin thử. Lần gửi cuối và lỗi (nếu có) hiện trên thẻ webhook.
- **Thay thế và mâu thuẫn** thay vì xoá:
  - Thay thế: `memory_write` với `supersedes: <id>` ghi mục mới thay cho mục cũ cùng dự án (hoặc cùng là memory chung). Khi mục mới được duyệt, `memory_search` của agent bỏ mục cũ, nên cả chuỗi chỉ còn mục mới nhất. Muốn thay thì thay mục mới nhất; xoá mục thay thì mục trước nó hiện lại.
  - Mâu thuẫn: `contradicts: <id>` đánh dấu hai mục nói khác nhau. Agent thấy cả hai, kèm `conflictsWith`, cho tới khi người quản trị dự án chọn trên trang Memory: *Giữ mục này*, *Giữ #…* (mục kia bị thay), hoặc *Không mâu thuẫn* (`memory.resolve`).
  - Trang Memory hiện số `#id` của từng mục, *Thay cho #…* và *Đã được thay bằng #…*; mục đã thay bị gạch.
- **Chung và riêng từng dự án**: tài liệu `org/*` và memory chung dùng cho cả team; tài liệu `project/<dự án>/*`, memory riêng và task thuộc về một dự án. Ở đầu sidebar có ô chọn phạm vi: *Tất cả dự án*, *Chung (cả team)*, hoặc một dự án. Mọi trang lọc theo phạm vi đó (ở một dự án thì thấy dữ liệu riêng của dự án cộng với dữ liệu chung, có nhãn "Chung"), và mục tạo mới mặc định thuộc phạm vi đang chọn. Trang *Tổng quan* tóm tắt từng dự án và phần dữ liệu chung.
- **Task**: `task_claim` giữ task theo lease, hai agent không nhận trùng. `task_update` kèm ghi chú bàn giao.
  - **Phụ thuộc**: task có thể phụ thuộc task khác cùng dự án. Đặt khi tạo, hoặc bấm *Sửa* ở cột *Phụ thuộc* trang Task (`tasks.setDeps`). Hive từ chối task tự phụ thuộc chính nó, task của dự án khác và vòng lặp.
    - Còn task phụ thuộc chưa *Xong* thì không `task_claim` được và app không chạy agent cho nó. Board để nó ở cột *Bị chặn* với nhãn *Chờ T-1*.
    - Các task đó xong thì task tự mở khoá, không cần ai chuyển trạng thái.
  - **Task sẵn sàng tiếp theo** (`task_next` / `tasks.next`): task *Chưa làm*, không chờ task nào, không ai giữ. Task mở khoá được nhiều task khác nhất xếp đầu.
    - Trang Task hiện 3 task đầu, Board gắn nhãn *Tiếp theo*.
- **Đồng bộ vào repo**: render `AGENTS.md` (khối chung + phần riêng của dự án), `CLAUDE.md` (`@AGENTS.md`), `docs/decisions.md`. Chỉ commit các file này, không push.
- **Chặn sửa tay**: hook `PreToolUse` của Claude Code và `pre-commit` của git (áp dụng cho mọi agent). Run của runner không chạy hook nào; runner tự để các file này ngoài commit.
- **Board + runner** (desktop): giao task cho agent chạy headless (`claude -p`, `codex exec`, `gemini -p`…). Mỗi task có worktree riêng. Hết quota thì tự chuyển gói sub, xong thì review chéo bằng vendor khác. Task khó thì chạy 2–4 bản trên các gói khác nhau, một giám khảo vendor khác giữ bản tốt nhất.
- **GitLab MR / GitHub PR**: review chéo đạt thì push `ai/<task>` và tạo MR (review yêu cầu sửa thì tạo Draft). Chạy lại thì cập nhật MR cũ. Dự án trên GitHub thì tạo pull request theo cùng luật.

## Cấu trúc

| Thư mục | Nội dung |
|---|---|
| `packages/core` | Schema zod, phân quyền, `SqliteHive` (node:sqlite + FTS5), `HubBackend`, render sync, config |
| `packages/mcp` | 8 tool MCP, entry stdio `hive-mcp` |
| `packages/ui` | React UI dùng chung cho web và desktop: shadcn/ui + Tailwind v4 (`src/components/ui/`, theme ở `src/globals.css`: nền neutral của shadcn, màu chính amber, dark mode theo hệ thống) |
| `apps/web` | Hub: REST RPC, MCP qua HTTP, token, phục vụ UI |
| `apps/desktop` | Electron: tray, IPC, sync repo, cài MCP vào Claude/Codex/Gemini, shim `hive-mcp`, runner (`src/main/runner`) |

Không có native module: SQLite dùng `node:sqlite` có sẵn trong Node 24+ và Electron 44.

## Chạy

```bash
nvm use && npm install
npm test            # 310 test: core, mcp, hub (REST + MCP HTTP), desktop (installer, git hook, sync, runner, GitLab MR, GitHub PR)
npm run typecheck
```

Hub (dev, có HMR):

```bash
npm run dev:web
```

Lần chạy đầu tạo tài khoản `admin` và in **mật khẩu tạm** ra console (chỉ một lần). Mở http://localhost:7788, đăng nhập, rồi đặt mật khẩu mới. Muốn reset thì xoá `apps/web/data/`.

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

1. **Dự án & cài đặt** → thêm repo (project key, ví dụ `xdev-ai-studio`).
2. **Cài đặt máy**: trang này tự kiểm tra khi mở app, và sidebar hiện số mục chưa sẵn sàng. Mục nào còn thiếu thì có nút cài riêng:
   - **CLI của agent** (Claude Code, Codex, Gemini): tìm theo `PATH` của login shell và hiện phiên bản. Nút *Cài bằng npm* chạy `npm install -g @anthropic-ai/claude-code` / `@openai/codex` / `@google/gemini-cli`, nên máy cần có Node.js. Profile nào chưa có CLI thì hiện "Chưa có lệnh …", và runner bỏ qua gói đó thay vì chạy thử rồi lỗi.
   - **Lệnh hive-mcp**: `~/.local/bin/hive-mcp` chạy MCP bằng chính binary của app. App báo *Cần cập nhật* nếu lệnh đang trỏ tới bản app khác (ví dụ bản dev), và báo *Cần sửa tay* nếu `~/.local/bin` chưa nằm trong `PATH` hoặc đã có file trùng tên không do Hive tạo.
   - **Theo từng repo**: cấu hình agent của Hive (bước 3), codegraph trong `.mcp.json`, index codegraph (`.codegraph/`, lệnh này tắt telemetry trước khi tạo index), và superpowers trong `.claude/settings.json`.
3. **Cấu hình agent** ghi các file sau (merge, không ghi đè cấu hình sẵn có; nếu dữ liệu giống nhau thì giữ nguyên định dạng file):
   - `.mcp.json` (Claude Code), `.gemini/settings.json` (Gemini: `contextFileName: ["AGENTS.md"]`), `~/.codex/config.toml` (block có marker)
   - `.claude/settings.json` + `.xdev-hive/guard-docs.sh` (hook chặn sửa tài liệu)
   - `.githooks/pre-commit` + `git config core.hooksPath .githooks`
4. **Đồng bộ tài liệu**: lần đầu nhập `AGENTS.md` / `docs/decisions.md` sẵn có vào Hive, sau đó render lại và commit.

`core.hooksPath` là cấu hình local của git: mỗi người clone repo cần bấm cài *Cấu hình agent* một lần trong *Cài đặt máy*, hoặc chạy `git config core.hooksPath .githooks`.

## Board: chạy agent và xoay vòng quota

```
queued ─chọn gói─▶ running ─exit 0──────▶ succeeded ─(review chéo)─▶ run review, vendor khác
                     ├─ báo hết quota ──▶ rate_limited ─▶ gói nghỉ đến giờ reset, lần sau chạy gói khác
                     ├─ không có CLI ───▶ failed ───────▶ gói nghỉ 10 phút, lần sau chạy gói khác
                     └─ lỗi / huỷ / quá giờ ─▶ failed / cancelled, task về "Chưa làm"
```

- **Profile = một gói sub** (trang *Gói sub & agent*): lệnh, tham số, biến môi trường, vai trò (lập kế hoạch / làm task / review), ưu tiên, số chạy song song, thời gian nghỉ mặc định, giới hạn mỗi run.
- **Chọn gói**: gói được ghim > bỏ qua gói tắt/đang bận/đang nghỉ/sai vai trò/đã thử ở run này > review dùng vendor khác người làm > ưu tiên thấp chạy trước > cùng ưu tiên thì gói lâu chưa dùng chạy trước.
  - Review chéo **chờ** gói của vendor khác khi gói đó chỉ đang bận (Board ghi lý do). Chỉ khi mọi gói vendor khác đều tắt, đang nghỉ vì quota hay chạm ngưỡng thì mới review bằng cùng vendor, để không bị kẹt hàng giờ.
  - Agent review được dặn không gọi `task_claim` / `task_update`: task vẫn thuộc run làm task.
- **Hết quota**: nhận diện từ cuối output khi CLI thoát lỗi (`usage limit`, `429`, `RESOURCE_EXHAUSTED`…). Đọc giờ reset nếu có (`|<epoch>`, `try again in 2 hours 13 minutes`, `resets 3pm`, ISO), không có thì dùng thời gian nghỉ mặc định. Phần làm dở được commit `wip`, lần sau chạy tiếp trên cùng branch với prompt "tiếp tục từ lần trước".
- **Worktree**: `~/.xdev-hive/worktrees/<dự án>/<task>` trên branch `ai/<task>`, không đụng checkout chính. Branch mới của task bắt đầu từ branch đích lấy mới từ remote (`targetBranch` của dự án, không có thì nhánh mặc định của remote), để task chạy ngay sau khi task nó phụ thuộc được merge trên GitHub/GitLab có code đó. Runner chỉ `git fetch`, không checkout hay reset checkout của bạn. Repo không có remote hoặc fetch lỗi thì bắt đầu từ HEAD của repo như trước, và log run ghi lại lý do. Branch đã có (run tiếp, review, bản được giữ của best-of-n) đi tiếp từ lịch sử của nó. Runner commit phần agent để lại và không push. Lúc commit, runner không chạy git hook nào, vì agent có thể đã ghi hook vào `.githooks` của worktree. `AGENTS.md`, `CLAUDE.md`, `docs/decisions.md` không được đưa vào commit này và hiện ở mục chưa commit trong tóm tắt run. File config agent chưa commit được chép vào worktree nhưng không đưa vào branch. Thư mục `.codex/` và `.agents/` mà CLI agent tự ghi vào worktree cũng không vào commit, trừ khi branch đã có file trong thư mục đó (dự án cố ý giữ). Codex 0.157 chép thiết lập Claude Code của repo sang đó khi bật `external-agent-import-sync-enabled` trong `~/.codex/config.toml`; khoá này không tắt được cho từng run (`-c` bị bỏ qua).
- **Không chạy cấu hình trong repo** (profile loại Claude Code): runner thêm `--settings '{"disableAllHooks":true}' --setting-sources user --strict-mcp-config --mcp-config <…>` vào cuối tham số. Agent sửa được hook, `.mcp.json` và `.claude/settings.json` trong worktree, và run sau sẽ chạy những thứ đó, nên run không đọc chúng.
  - Server MCP do app liệt kê: `xdev-hive` (`HIVE_AGENT` = id profile); thêm codegraph bản ghim nếu `.mcp.json` ở checkout chính có codegraph.
  - Các tool của những server đó được cho phép sẵn (`permissions.allow` trong `--settings`): chạy headless, Claude Code từ chối mọi tool chưa được cho phép, và agent sẽ không claim task hay ghi memory được.
  - Superpowers được bật nếu `.claude/settings.json` ở checkout chính bật, nhưng hook của plugin vẫn tắt.
  - Cài đặt của bạn trong `~/.claude/settings.json` vẫn được dùng, trừ hook.
  - `--setting-sources user` cũng làm Claude Code bỏ qua CLAUDE.md của dự án. Runner nạp lại nó bằng `--add-dir <worktree>` và `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`; các file CLAUDE.md import (như `@AGENTS.md`) cũng được nạp. Đã kiểm với Claude Code 2.1.283.
  - Cần hook của repo thì tạo profile loại *Tuỳ chỉnh*: runner để nguyên tham số của loại này.
  - Codex giữ sandbox `workspace-write` (`--sandbox workspace-write`). Codex 0.15x bỏ cờ `--full-auto`: profile cũ còn cờ đó được đổi sang `--sandbox workspace-write` lúc chạy (bản Codex cũ cũng nhận cờ này).
  - Codex 0.15x hỏi trước mỗi lần gọi tool MCP có ghi (`task_claim`, `memory_write`…), mà run headless không có ai trả lời nên bị từ chối. Run `codex exec …` của Hive thêm `-c mcp_servers.xdev-hive.default_tools_approval_mode="approve"` (container: server `hive`), và block Hive trong `~/.codex/config.toml` cũng có dòng đó; chỉ tool của Hive được cho qua.
  - Run Codex cũng đặt `-c mcp_servers.xdev-hive.env={HIVE_AGENT="<id profile>",HIVE_PROJECT=…,HIVE_TASK=…,HIVE_RUN=…}` như Claude Code: `~/.codex/config.toml` chỉ ghi `codex`, nên agent claim task dưới tên khác runner và giữ lease 2 giờ, chặn run sau của task.
- **Hive**: runner `task_claim` trước khi chạy với cùng tên agent như `hive-mcp` (`HIVE_AGENT` = id profile). Xong thì chuyển task sang *Chờ review* kèm tóm tắt, trừ khi agent đã tự làm qua MCP. Review chéo được nối vào ghi chú task.
- Lịch sử run và log nằm ở `~/.xdev-hive/runs.db` và `~/.xdev-hive/runs/<id>.log`. Log có prompt và output, **không** ghi biến môi trường.
- App mở từ Finder có `PATH` ngắn, nên runner lấy `PATH` từ login shell (`$SHELL -ilc`) cộng `~/.local/bin`. Dùng nút *Kiểm tra CLI* để xem lệnh có tìm thấy không.
- **Đăng nhập CLI**: app tự hỏi CLI của từng profile đã đăng nhập chưa.
  - Lệnh dùng: `claude auth status --json` và `codex login status`, chạy với env của profile (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), nên gói thứ hai được kiểm riêng.
  - Khi nào kiểm: lúc mở app, mỗi 10 phút, khi sửa profile và khi bấm *Kiểm tra CLI*.
  - Gói chưa đăng nhập bị runner bỏ qua. Thẻ profile hiện lệnh đăng nhập kèm thư mục đăng nhập, không kèm env khác. Run đang chờ vì mọi gói đều chưa đăng nhập thì Board ghi rõ lý do.
  - Nút *Đăng nhập* (Claude Code, Codex) mở một cửa sổ terminal chạy sẵn lệnh đó: Terminal trên macOS, `cmd` trên Windows, hoặc terminal đầu tiên tìm thấy trên Linux (`x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `xterm`).
  - Lệnh nằm trong một script ở `~/.xdev-hive/login/<profile>/`, quyền `0700`. Script chỉ chứa biến thư mục đăng nhập (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), không chứa key hay token.
  - Quay lại cửa sổ app thì app kiểm lại các gói chưa đăng nhập.
  - Gemini và CLI tuỳ chỉnh không có lệnh xem trạng thái, nên để "chưa rõ" và runner vẫn dùng.
- **Log trực tiếp** (Claude Code): runner thêm `--output-format stream-json --verbose`, trừ khi profile đã tự chọn định dạng (`json`: chỉ có kết quả lúc xong).
  - Log run ghi từng bước ngay khi agent làm: lời agent nói, `▶` lệnh hay tool nó gọi (`Bash: mvn -B verify`, `Edit src/…`, `memory_search …`), `✓` / `✗` và dòng đầu của kết quả. Không ghi sự kiện JSON thô.
  - Board hiện việc agent đang làm dưới trạng thái run (bảng Lượt chạy, chi tiết run, tooltip trên thẻ task): tóm tắt của Claude Code, không có thì tool nó vừa gọi. CLI khác (Codex, Gemini) thì là dòng cuối nó in ra.
  - Khung log trong chi tiết run mở ở cuối (các bước và kết quả), tự theo khi run đang chạy, có nút *Mở rộng* cho khung cao hơn.
- **Chi phí run** (Claude Code): lấy từ sự kiện kết quả của stream: câu trả lời cuối làm tóm tắt run, `total_cost_usd`, token vào (tính cả cache) và token ra.
  - Log run có thêm mục `## Result` và dòng `# cost`.
  - Board hiện chi phí từng run; thẻ Gói sub hiện tổng theo gói.
  - Đây là ước tính theo giá API: gói sub (Pro/Max) không bị tính khoản này, nhưng nó cho biết run nào tốn nhiều.
  - Codex và Gemini chưa có số liệu.
  - **Trên hub**: ở chế độ hub, mỗi heartbeat gửi chi phí các run đã xong mà hub chưa nhận (tối đa 100 run mỗi lần). Máy chỉ đánh dấu đã gửi khi hub trả lời, nên máy offline lâu vẫn gửi bù được. Hub giữ bản báo đầu tiên của mỗi run và xoá run cũ hơn 90 ngày.
  - Trang *Máy & run* có mục *Chi phí ước tính*: tổng 24 giờ, 7 ngày, 30 ngày, và bảng theo dự án, theo gói (máy · tài khoản). Người xem chỉ thấy các dự án mình có quyền.
- **Mức dùng của gói sub** (Claude Code): cùng lúc với lượt kiểm đăng nhập, app chạy `claude -p /usage` cho từng profile đã đăng nhập.
  - Cách chạy: env của profile, không hook, không server MCP, chỉ cài đặt của user. Lệnh trả lời tại máy, không gọi model và không tốn quota.
  - Hiển thị: % đã dùng của phiên (khoảng 5 giờ) và của tuần, kèm giờ reset. Thẻ Gói sub, dải gói trên Board và trang *Máy & run* đều có; từ 80% thì tô màu cảnh báo.
  - Ngưỡng dừng: mỗi profile có *Dừng khi phiên đạt* (mặc định 95%) và *Dừng khi tuần đạt* (mặc định 90%). Tới một trong hai ngưỡng thì runner không bắt đầu run mới trên gói đó mà chuyển sang gói khác; run đang chạy vẫn chạy xong. Đặt 100 nếu chỉ muốn dừng khi CLI tự báo hết quota.
  - Codex và Gemini chưa có số liệu. Mọi CLI vẫn có cách cũ: run gặp lỗi hết quota thì gói nghỉ đến giờ reset.
- **Trên hub**: heartbeat báo trạng thái đăng nhập, cài CLI và giờ nghỉ của từng gói. Trang *Máy & run* (mọi người) và *Quản trị* (admin) hiện gói nào tắt, chưa có CLI, chưa đăng nhập, đang nghỉ đến giờ nào, hoặc sẵn sàng.

Hai gói của cùng một vendor: tạo 2 profile, profile thứ hai trỏ CLI sang thư mục đăng nhập riêng, rồi đăng nhập một lần trong terminal với biến đó, ví dụ `CLAUDE_CONFIG_DIR=~/.claude-2` (Claude Code) hoặc `CODEX_HOME=~/.codex-2` (Codex). Tên biến và cờ headless mặc định lấy theo tài liệu CLI mình biết; hãy kiểm tra bằng `--help` của bản bạn đang cài.

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

Cấu hình ở *Dự án & cài đặt* → **GitLab merge request**: URL, access token (scope `api`, cộng `write_repository` nếu push qua HTTPS), bật *Tự tạo MR*.

```
implement ─(review chéo)─▶ review ── verdict approve ───────▶ push ai/<task> → MR ready
                                  └─ cần sửa / không rõ ─────▶ MR "Draft:" (hoặc không tạo)
implement (không review, chế độ "ngay khi làm xong") ─────────▶ push → MR ready
```

- **GitLab project** đọc từ remote (`git@gitlab.example.com:group/proj.git`, `https://…/group/proj.git`). Không đọc được thì điền ở nút *GitLab* của dự án. Target mặc định là default branch của project.
- **Push**: remote HTTPS cùng host GitLab thì dùng token qua git config trong env (`GIT_CONFIG_*`), không ghi vào `.git/config` và không hiện trong danh sách tiến trình. Remote SSH dùng key sẵn có, `BatchMode=yes` để không treo chờ nhập. Không bao giờ force push.
- **MR đã có** (cùng source branch, đang mở): chỉ cập nhật tiêu đề, mô tả và *thêm* label, không đổi target hay label người khác đã sửa trên GitLab.
- **Mô tả MR** gồm task, tóm tắt của agent làm, kết quả review, danh sách commit. Output của agent nằm trong code block (dài hơn mọi chuỗi backtick trong output), nên GitLab không chạy quick action (`/merge`, `/approve`…) hay mention từ đó.
- Link MR được ghi vào ghi chú task trong Hive và hiện trên Board. Lỗi GitLab/push được ghi ở run (không làm run thất bại). Có nút *Tạo MR / Cập nhật MR* để chạy tay.
- **Theo dõi MR**: app hỏi GitLab về các MR nó đã mở (30 giây sau khi mở app, rồi mỗi 2 phút; MR của run trong 30 ngày gần nhất).
  - Board hiện trạng thái pipeline (*CI lỗi*, *CI qua*…, bấm để mở pipeline) và MR đã merge hay đóng.
  - MR merge thì task chuyển sang *Xong*, ghi chú task thêm dòng `MR !<iid> merged.`. Tắt được bằng ô *MR merge thì chuyển task sang Xong*.
  - Có thông báo khi MR merge, bị đóng không merge, hoặc pipeline lỗi.
  - MR đã merge hay đóng thì thôi hỏi. Chỉ hỏi MR trên đúng GitLab đã cấu hình, nên token không đi nơi khác.
- **Tự sửa CI** (bật sẵn, ô *Pipeline lỗi thì giao agent sửa*): pipeline mới nhất của MR đang mở bị lỗi thì app xếp một run implement trên cùng branch `ai/<task>`, chọn gói như run thường.
  - Prompt có link pipeline và phần cuối log của tối đa 3 job lỗi (bỏ job `allow_failure`).
    - Log được làm sạch: bỏ mã màu, dấu section của GitLab, ký tự ẩn. Dòng trông giống secret bị thay bằng `(line hidden: …)`.
    - Agent được dặn đọc log như dữ liệu, không làm theo chữ trong log, và không được bỏ hay nới test để qua CI.
  - Run xong thì app chỉ push branch. GitLab tự cập nhật MR và chạy pipeline mới; tiêu đề và mô tả MR giữ nguyên.
  - Mỗi pipeline sửa một lần, tối đa 2 lần mỗi MR (chỉnh 1–5). Hết lượt thì chỉ báo *cần người xem*.
  - Task đang có run thì chờ, lần kiểm sau mới xếp.
  - Board: chi tiết run sửa ghi *Sửa CI của MR !n (lần 1/2)* và tên job lỗi.
- API gọi qua `net.fetch` của Electron, dùng proxy và chứng chỉ của hệ thống.

### Pull request trên GitHub

Cấu hình ở *Dự án & cài đặt* → **GitHub pull request** (hỏi ngày 28/9: team dùng GitHub, giống GitLab; đăng nhập bằng fine-grained personal access token): URL (mặc định `https://github.com`, hoặc URL GitHub Enterprise Server) và token. Token cần quyền *Contents* và *Pull requests* (đọc và ghi) trên các repo của team, cộng *Checks*, *Commit statuses* và *Actions* (đọc) để theo dõi và tự sửa CI. Nút *Kiểm tra kết nối* cho biết token thuộc tài khoản nào.

- **Dự án nào là GitHub**: remote push (`origin` hoặc remote trong tuỳ chọn MR) nằm trên host GitHub đã cấu hình, hoặc dự án có ô *GitHub: owner/repo* (nút *GitLab / GitHub* của dự án). Các dự án khác vẫn tạo MR trên GitLab, nên một máy dùng được cả hai.
- **Luật tạo** giống MR, lấy từ thẻ GitLab: *Tự tạo MR*, *Khi nào*, *Review yêu cầu sửa* (Draft hoặc không tạo), label, remote. Base mặc định là default branch của repo, hoặc *target branch* của dự án.
- **Draft**: review yêu cầu sửa hoặc không rõ thì PR là draft. Chạy lại khi review đã đạt thì PR được chuyển sang *Ready for review* (qua GraphQL, vì REST không đổi được). Repo không có PR draft (repo riêng trên GitHub Free) thì tạo PR thường với tiêu đề bắt đầu bằng `Draft:`, và run ghi chú điều đó.
- **Push qua HTTPS** tới host GitHub dùng token như GitLab: header trong `GIT_CONFIG_*` của env (user `x-access-token`), không ghi vào `.git/config`. Remote SSH dùng key sẵn có.
- **PR đã có** (cùng branch, đang mở): chỉ cập nhật tiêu đề và mô tả rồi thêm label, không đổi base. Mô tả giống MR, output của agent nằm trong code block.
- Link `PR #n` được ghi vào ghi chú task và hiện trên Board. Lỗi GitHub (`GitHub 401: Bad credentials`…) được ghi ở run, không làm run thất bại.
- **Theo dõi PR**: cùng lượt với MR GitLab (30 giây sau khi mở app, rồi mỗi 2 phút; PR của run trong 30 ngày gần nhất), app hỏi GitHub trạng thái PR và check của commit mới nhất.
  - Các check (GitHub Actions và app khác, cả commit status kiểu cũ) được gộp thành một trạng thái CI trên Board: *đang chạy* khi còn check chưa xong, rồi *lỗi* nếu có check lỗi, hết giờ hay cần xử lý. Bấm để mở trang checks của commit đó.
  - PR merge thì task sang *Xong*, ghi chú thêm `PR #n merged.` (cùng ô *MR merge thì chuyển task sang Xong*). Có thông báo khi PR merge, bị đóng, hoặc CI lỗi, kể cả khi lần push sau lại lỗi.
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
- **Chỉ chạy 1 container cho mỗi database.** SQLite không chia sẻ file giữa nhiều replica. Muốn chịu tải lớn hơn thì chuyển sang Postgres (xem *Việc tiếp theo*).

Không dùng Docker:

```bash
npm ci && npm run build -w @xdev-hive/web
HIVE_HOST=0.0.0.0 HIVE_ALLOWED_HOSTS=hive.example.com HIVE_DB=/data/hub.db HIVE_BACKUP_DIR=/data/backups npm run start -w @xdev-hive/web
```

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `HIVE_PORT` / `HIVE_HOST` | `7788` / `127.0.0.1` | Cổng và địa chỉ bind (image: `0.0.0.0`) |
| `HIVE_ALLOWED_HOSTS` | localhost | Danh sách Host header hợp lệ (chống DNS rebinding). Bắt buộc khi có hostname công khai hoặc đặt sau reverse proxy. `localhost`/`127.0.0.1` luôn được chấp nhận (health check) |
| `HIVE_DB` | `apps/web/data/hub.db` | File SQLite (image: `/data/hub.db`) |
| `HIVE_MEMORY_APPROVAL` | bật | `off`: memory của agent hiện ngay, không cần duyệt |
| `HIVE_MEMORY_STALE_DAYS` | `90` | Memory không agent nào dùng (và không ai ghi hay giữ lại) trong ngần này ngày bị coi là cũ: `memory_search` của agent bỏ qua, trang Memory vẫn hiện để xem lại. `0`: không bao giờ cũ |
| `HIVE_PUBLIC_URL` | `https://` + host đầu tiên của `HIVE_ALLOWED_HOSTS` | Địa chỉ hub dùng cho link trong tin webhook |
| `HIVE_ADMIN_USER` | `admin` | Tên tài khoản admin đầu tiên (tạo khi hub chưa có tài khoản nào) |
| `HIVE_TRUST_PROXY` | tắt (compose: `1`) | Hub đứng sau proxy TLS: cookie phiên có `Secure`, giới hạn đăng nhập sai theo IP thật từ `X-Forwarded-For`. Chỉ bật khi mọi request đi qua proxy |
| `HIVE_BOOTSTRAP_TOKEN` | – | Token admin cố định (≥ 32 ký tự) cho deploy tự động |
| `HIVE_BACKUP_DIR` | tắt (image: `/data/backups`) | Bật backup: một bản khi khởi động (trước khi migrate schema) và định kỳ |
| `HIVE_BACKUP_HOURS` / `HIVE_BACKUP_KEEP` | `24` / `7` | Chu kỳ backup và số bản giữ lại |
| `HIVE_EMBED_URL` | tắt | Endpoint `/embeddings` kiểu OpenAI để `memory_search` tìm cả theo nghĩa, vd. `http://ollama:11434/v1` (xem dưới) |
| `HIVE_EMBED_MODEL` / `HIVE_EMBED_KEY` | `bge-m3` / – | Model embedding; key Bearer khi dùng API ngoài (Ollama không cần) |
| `HIVE_EMBED_MIN_SCORE` | `0.5` | Độ giống (cosine) tối thiểu để một mục tính là tìm thấy theo nghĩa |
| `HIVE_OIDC_ISSUER` / `HIVE_OIDC_CLIENT_ID` / `HIVE_OIDC_CLIENT_SECRET` | tắt | Đăng nhập qua nhà cung cấp OpenID Connect (xem *Đăng nhập SSO*). Cần đủ cả ba |
| `HIVE_OIDC_NAME` / `HIVE_OIDC_SCOPES` | `SSO` / `openid profile email` | Tên trên nút đăng nhập; scope xin nhà cung cấp |

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

### Tài khoản và quyền theo dự án

- **Người** đăng nhập hub bằng tên đăng nhập + mật khẩu. Admin tạo tài khoản ở *Quản trị → Người dùng & quyền*; hub sinh mật khẩu tạm, chỉ hiện một lần. Lần đăng nhập đầu phải đổi mật khẩu (≥ 10 ký tự, không chứa tên đăng nhập) mới dùng được hub. Quên mật khẩu: admin bấm *Đặt lại mật khẩu*.
- **Quyền theo dự án**: admin cấp cho mỗi người từng dự án ở một mức. Dự án không được cấp thì người đó không thấy gì của dự án đó: không trong danh sách, không qua agent, không qua MCP (hub trả *không tìm thấy*, nên cũng không lộ tên tài liệu).

  | Mức | Được làm |
  |---|---|
  | Xem | đọc tài liệu, memory, task, đề xuất của dự án |
  | Đóng góp | + đề xuất sửa tài liệu, ghi memory, nhận và cập nhật task |
  | Quản trị | + sửa và duyệt tài liệu, duyệt/xoá memory, tạo task |

- **Dữ liệu Chung** (tài liệu `org/*`, memory chung): ai đăng nhập cũng xem được. Người có mức Đóng góp ở ít nhất một dự án được đề xuất tài liệu Chung và ghi memory Chung (chờ admin duyệt). Sửa và duyệt dữ liệu Chung là việc của admin.
- **Admin** thấy và quản trị mọi dự án, quản lý tài khoản, trang Quản trị và mọi token.
- **Máy và agent** dùng token *thuộc tài khoản* của người đó, nên chỉ thấy đúng các dự án người đó được cấp. App desktop: *Dự án & cài đặt → Nguồn dữ liệu → Hub dùng chung → Tài khoản*, nhập tên đăng nhập + mật khẩu một lần. Hub cấp cho máy một token (mật khẩu không lưu trên máy); đăng nhập lại từ cùng máy thì token cũ bị thay. Token vai trò `agent` (CI, script) mỗi người tự tạo ở trang *Token*, tối đa mức Đóng góp dù người đó có quyền Quản trị.
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

- **Người đăng nhập SSO lần đầu** được tạo tài khoản mới (hỏi ngày 28/9): không phải admin, chưa được cấp dự án nào nên chỉ thấy dữ liệu Chung. Admin cấp quyền sau ở *Người dùng & quyền*, nơi tài khoản có nhãn *SSO*.
  - Tên đăng nhập lấy từ username bên nhà cung cấp (hoặc phần trước `@` của email, bỏ dấu). Trùng tên thì thêm `-2`, `-3`…
  - Hub **không bao giờ** gộp vào tài khoản có sẵn theo tên hay email, để không ai chiếm được tài khoản người khác.
- **Đã có tài khoản mật khẩu**: đăng nhập như cũ, rồi chọn *Liên kết …* ở menu tài khoản. Từ đó đăng nhập cách nào cũng vào cùng tài khoản. Một tài khoản bên nhà cung cấp chỉ gắn được với một tài khoản hub.
- **Luồng đăng nhập**: authorization code + PKCE (S256), `state` gắn với trình duyệt qua cookie `hive_oidc` (SameSite=Lax, 10 phút, dùng một lần), `nonce`.
  - `id_token` lấy thẳng từ token endpoint qua TLS. Hub kiểm issuer (phải khớp issuer đã cấu hình và tài liệu discovery), audience, `azp`, hạn dùng, `nonce`.
  - Issuer phải là `https://`.
- Tài khoản bị khoá thì không đăng nhập SSO được. Mỗi lần đăng nhập, tạo tài khoản và liên kết đều ghi vào nhật ký.
- **App desktop**: nút *Đăng nhập qua trình duyệt* ở *Dự án & cài đặt → Nguồn dữ liệu → Tài khoản*. Dùng được cho tài khoản chỉ có SSO; tài khoản có mật khẩu cũng dùng được.
  1. App mở một cổng trên `127.0.0.1` rồi mở trang hub `#/device` trên trình duyệt.
  2. Người dùng đăng nhập ở đó (SSO hay mật khẩu). Trang hỏi *App trên máy … muốn dùng tài khoản @… của bạn*, bấm *Cho phép*.
  3. Hub gửi mã dùng một lần (2 phút) về đúng địa chỉ `127.0.0.1` đó. App đổi mã kèm PKCE verifier lấy token của máy, giống đăng nhập bằng mật khẩu.
  - Đây là cách loopback của RFC 8252. Chỉ app đã bắt đầu mới có verifier, và mã chỉ đi tới `127.0.0.1`, nên chuyển link này cho người khác cũng không lấy được token.
  - App chờ tối đa 5 phút, có nút *Huỷ*. Bấm *Không* thì app báo bị từ chối.
  - Đăng nhập SSO từ trang này xong thì quay lại đúng trang đó.

### Backup, khôi phục, nâng cấp

- Backup dùng `VACUUM INTO`, nên an toàn khi hub đang chạy. Không nên copy thẳng `hub.db`, vì bản copy thiếu phần còn nằm trong file `-wal`. Tên file dạng `hub-2026-09-27T09-00-00-000Z.db`. Khi xoay vòng, hub chỉ xoá file có đúng dạng tên này.
- Backup ngay (ví dụ trước khi làm việc rủi ro): `npm run backup -w @xdev-hive/web -- [thư mục] [số bản giữ]`. Lệnh này chỉ đọc file, không migrate.
- Mặc định, compose để backup trên volume `hive-backups`, cùng đĩa với database. Để backup còn nguyên khi mất đĩa, trỏ `HIVE_BACKUP_PATH=/mnt/backup/hive` sang đĩa khác (thư mục phải cho uid 1000 ghi), hoặc đồng bộ thư mục backup ra ngoài.
- **Khôi phục**: dừng hub, chép bản backup đè lên `hub.db`, xoá `hub.db-wal` và `hub.db-shm` nếu có, rồi khởi động lại.
- **Nâng cấp**: trên server chạy `bash deploy/update.sh` (sau Cloudflare Tunnel: `HIVE_TUNNEL=1 bash deploy/update.sh`): lấy `origin/main`, build lại, chờ hub healthy. Hub tự backup trước khi chạy migration mới.

Máy của từng người: app desktop → chế độ **Hub dùng chung** → URL + đăng nhập bằng tài khoản (hoặc dán token). Shim `hive-mcp` tự chuyển tiếp lên hub, nên config MCP trong repo giống nhau cho mọi người và không chứa token.

### Chuyển dữ liệu giữa máy và hub

Ở chế độ hub, app và agent đọc, ghi thẳng lên hub nên không cần đồng bộ. Dữ liệu đã có trong `~/.xdev-hive/local.db` (từ lúc dùng chế độ cục bộ) thì chuyển bằng hai nút ở *Dự án & cài đặt* → **Dữ liệu dùng chung với hub**. Hai nút này cần URL và token hub đã lưu, dù app đang ở chế độ nào:

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
- **Run lên hub** (hỏi ngày 29/9: log dạng đọc được, đã lọc secret; hub giữ 30 ngày; ai xem được dự án thì xem được): mỗi 5 giây runner gửi các run vừa đổi (`runs.push`): run đang chạy hay chờ, và run đã xong trong 24 giờ.
  - Mỗi run có trạng thái, gói, việc agent đang làm, tóm tắt, lỗi, branch, số commit, MR/PR, chi phí, và khoảng 200 dòng cuối của log dạng đọc được (`▶` lệnh, `✓ ✗` kết quả). Run xong thì gửi ngay, không chờ lượt 5 giây.
  - Trước khi gửi, máy bỏ mã màu và ký tự ẩn, thay dòng giống secret bằng `(line hidden: …)`. Hub kiểm lại lần nữa trước khi lưu. Log đầy đủ vẫn chỉ nằm trên máy chạy.
  - Hub lưu theo máy và mã run (`run_records`, migration 13), xoá run không cập nhật quá 30 ngày. Đọc bằng `runs.list` (không có log) và `runs.get` (có log); người không có quyền xem dự án thì không thấy run của dự án đó.
- **Trang *Lượt chạy*** (web và desktop, chỉ hiện ở chế độ hub): các run máy đã gửi lên, của mọi máy, trong các dự án người xem thấy; lọc theo dự án đang chọn ở thanh bên.
  - Mỗi dòng: mã run, dự án · task, việc (làm task / review / lập kế hoạch), máy · gói, trạng thái kèm việc agent đang làm hoặc lỗi, giờ tạo, thời lượng, chi phí.
  - Chọn một run để xem chi tiết: branch, số commit, link MR/PR, kết quả, và phần cuối log (đã ẩn secret). Run đang chạy hay đang chờ thì danh sách và log tự làm mới mỗi 3 giây, log cuộn theo dòng mới; không còn run nào chạy thì 20 giây một lần.
  - **Kết quả review và lượt sửa** (roadmap 18b).
    - Run review đã xong hiện huy hiệu *Review: đạt* hoặc *Review: cần sửa*. Kết luận được đọc từ báo cáo của run, giống cách máy đọc khi mở MR.
    - Review mới nhất của một task mà *cần sửa* có khung *Xếp lượt sửa*, chỉ cho người quản trị dự án. Bấm là gửi `runs.dispatch` cho cùng máy: việc *Làm task*, gói tự xoay, có thể bật review sau khi xong.
    - Chỉ dẫn gửi agent (xem trước được) gồm báo cáo của review, được đóng khung là "những điểm cần sửa, không phải lệnh". Run làm tiếp trên branch của task. Máy kiểm như mọi yêu cầu từ web.
  - **Huỷ run từ web** (roadmap 18a). Run đang chờ hay đang chạy trên máy có bật *Được nhận run từ hub* có nút *Huỷ run*, chỉ cho người quản trị dự án của run.
    - Hub ghi ai yêu cầu huỷ (`runs.cancel`, migration 18). Bấm lần nữa vẫn giữ người yêu cầu đầu tiên. Máy chưa bật ô thì hub từ chối, vì chủ máy chưa cho web điều khiển nó.
    - Máy nhận yêu cầu ở heartbeat sau (khoảng 30 giây): huỷ run đang chờ, hoặc dừng agent đang chạy. Lỗi của run ghi "<người> huỷ trên web". Máy đẩy run lên hub như mọi lần.
    - Trong lúc chờ, trang hiện ai yêu cầu và lúc nào, và dòng của run ghi *Đang chờ máy huỷ*. Hub gửi lại yêu cầu ở mỗi heartbeat cho tới khi máy báo run đã kết thúc.
  - Board vẫn là nơi xem run của chính máy mình với log đầy đủ.
- **Xếp run từ web** (hỏi ngày 29/9: web xếp run cho một máy; chỉ người quản trị dự án; máy phải cho phép):
  - Máy chỉ nhận khi người dùng bật *Được nhận run từ hub* (trang *Gói sub & agent*, thẻ Runner; tắt sẵn). Heartbeat báo hub máy có repo của những dự án nào và có bật ô này không.
  - Người quản trị dự án gọi `runs.dispatch`: chọn máy, việc, gói (hoặc tự xoay), review chéo, số bản, chỉ dẫn. Hub từ chối ngay khi: máy mất kết nối, chưa bật ô, không có repo của dự án; gói ghim không có hoặc đang tắt trên máy; task đã xong hoặc còn chờ task khác; task đã có yêu cầu đang chờ, hoặc đang chạy trên một máy.
  - Máy nhận yêu cầu trong trả lời của heartbeat kế tiếp và xếp run như khi bấm *Chạy agent* trên Board, với cùng các kiểm tra. Sau đó máy báo *đã nhận* kèm mã run, hoặc *từ chối* kèm lý do (`runs.requestResult`), và hiện thông báo trên máy. Nếu hub không nhận được câu trả lời, lần sau máy chỉ báo lại, không xếp run lần hai.
  - Yêu cầu không máy nào nhận sau 15 phút thì hết hạn. Tắt ô thì các yêu cầu đang chờ bị từ chối ngay. `runs.requests` liệt kê yêu cầu theo quyền xem dự án, `runs.cancelRequest` huỷ yêu cầu còn chờ. Hub giữ yêu cầu đã trả lời 30 ngày; nhật ký quản trị ghi ai xếp, ai huỷ.
  - Trên trang *Task* (web, hoặc app ở chế độ hub), bấm một task để mở panel chi tiết. Mục *Chạy trên máy* chỉ hiện với người quản trị dự án, và chỉ liệt kê máy đang online, đã bật ô và có repo của dự án. Chọn máy, việc (mặc định *Review* nếu task đang chờ review), gói hoặc tự xoay, số bản, review chéo, chỉ dẫn, rồi bấm *Gửi cho máy*.
  - Panel hiện các yêu cầu của task: chờ máy nhận (huỷ được), máy đã nhận (mã run, xem ở *Lượt chạy*), máy từ chối (lý do theo ngôn ngữ người xem), đã huỷ, hết hạn. Khi còn yêu cầu đang chờ, trang tự làm mới mỗi 3 giây, và hàng của task trong bảng ghi máy đang được chờ.
  - Trang *Máy & run* ghi máy nào nhận run từ hub và có repo của dự án nào.
- **Chat với leader của dự án** (hỏi ngày 29/9: làm trong Hive; người quản trị dự án chat được; leader chạy trên gói Claude của một máy bật *Được nhận run từ hub*). Roadmap 17a-1 (hub), 17a-2 (máy trả lời), 17b (trang *Chat*).
  - **Trang *Chat*** (web, và app ở chế độ hub; nhóm *Làm việc*): các thread của dự án đang chọn ở thanh bên (*Tất cả dự án* thì mọi dự án bạn xem được), mới nhất trước. Thread đang có câu trả lời có chấm xanh.
    - *Chat mới* (người quản trị dự án): chọn dự án, máy, gói Claude hoặc để máy tự chọn, rồi viết tin đầu. Chỉ hiện máy đang online, bật nhận run từ hub, có repo của dự án và có gói Claude đã đăng nhập.
    - Câu trả lời hiện dần khi máy viết (trang hỏi hub mỗi 2 giây), kèm việc agent đang làm và các bước (`▶` công cụ). *Dừng* huỷ câu trả lời và giữ phần đã viết. Thread đang chờ câu trả lời thì chưa gửi được tin tiếp.
    - Câu trả lời hiện bằng Markdown (kiểu GitHub: tiêu đề, danh sách, danh sách việc, bảng, trích dẫn, khối code, link) (roadmap 17d).
      - Trang không chạy HTML trong câu trả lời, và không tải ảnh mà chữ trỏ tới. Link ra ngoài mở ở tab mới.
      - Câu trả lời và từng khối code có nút *Copy*.
      - Câu trả lời cuối bị lỗi, hết hạn hay bị dừng có nút *Gửi lại*: gửi lại đúng tin nó trả lời.
      - Enter để gửi, Shift+Enter để xuống dòng.
    - **Đính kèm** (roadmap 17g-1): ảnh (PNG, JPEG, WebP, GIF), PDF và file văn bản (txt, log, md, csv, json), tối đa 4 file mỗi tin, mỗi file 5 MB.
      - Người gửi bấm kẹp giấy, dán ảnh chụp vào ô tin nhắn, hoặc kéo thả file vào. Mỗi file tải lên hub ngay (`POST /api/chat/files`), rồi `chat.send` gắn file vào tin bằng mã của nó.
      - Hub đọc loại file từ các byte đầu, không tin tên file hay header. Văn bản phải là UTF-8 và không chứa dòng giống secret. HTML, SVG và file chạy được đều bị từ chối. Tên file được làm sạch (không có thư mục, ký tự ẩn hay chữ đảo chiều).
      - Ai xem được chat của dự án thì đọc được file (`GET /api/chat/files/<id>`). File chưa gửi thì chỉ người tải lên thấy; sau 1 ngày chưa gửi thì bị xoá. Xoá thread thì xoá cả file.
      - Ảnh hiện thu nhỏ trong tin (bấm để xem cỡ thật); file khác là link tải về. Hub trả văn bản dưới dạng `text/plain` có sandbox, nên file không bao giờ chạy như một trang của hub.
      - Leader đọc được file đính kèm (roadmap 17g-2). Yêu cầu trả lời mang theo danh sách file của tin. Máy tải từng file bằng token của câu trả lời (không dùng token của máy) vào một thư mục riêng của câu trả lời, ngoài repo.
      - Máy làm sạch tên file thêm một lần và đặt tên khác cho file trùng tên. Claude được đọc thư mục đó qua `--add-dir`, và tin gửi leader kèm đường dẫn từng file để nó đọc bằng Read (đọc được cả ảnh và PDF).
      - File không tải được thì được ghi chú trong tin, câu trả lời vẫn tiếp tục. Thư mục bị xoá khi câu trả lời xong.
    - **Hướng dẫn leader** (roadmap 17i-1): người quản trị dự án bấm *Hướng dẫn leader* trên trang *Chat* để sửa hướng dẫn cho leader của dự án.
      - Khung sửa mở bản đang dùng: bản riêng của dự án nếu có, không thì bản chung của nhóm (skill `hive-leader`).
      - Lưu thì tạo hoặc cập nhật skill `project/<dự án>/skills/hive-leader`, có lịch sử phiên bản như mọi skill. Leader đọc bản riêng này trước (`skill_get`); các dự án khác vẫn dùng bản chung.
    - **Lệnh leader được chạy** (roadmap 17i-2), cũng nằm trong khung *Hướng dẫn leader*. Mặc định là `git status`, `git log`, `git diff`, `git show`.
      - Người quản trị dự án sửa danh sách (`chat.setCommands`, migration 21): mỗi dòng một lệnh, tối đa 20, mỗi lệnh chỉ gồm tối đa bốn từ chữ thường, nên không có dấu `;`, `&&`, `$(`… Để trống thì leader không chạy lệnh nào.
      - Máy đổi mỗi lệnh thành quy tắc `Bash(<lệnh>:*)` của Claude Code: leader chạy được lệnh đó với mọi tham số. Lệnh khác, kể cả lệnh ghép như `git status && touch x`, vẫn bị chặn (đã thử với Claude Code 2.1.283).
      - Chỉ nên thêm lệnh chỉ đọc. Một lệnh như `npm test` chạy code của repo trên máy của người khác.
    - **Model, mức nỗ lực và mặc định của dự án** (roadmap 17h).
      - *Chat mới* có ô chọn model (bí danh của Claude Code: fable, opus, sonnet, haiku; hoặc để model của gói) và mức nỗ lực (low đến max, hoặc để mặc định). Máy chạy `claude` với `--model` và `--effort` tương ứng.
      - Người quản trị dự án bấm *Lưu làm mặc định*: chat mới của dự án sẽ bắt đầu với máy, gói, model và mức nỗ lực đó (`chat.setDefaults`, migration 20). Form tự điền theo mặc định. Qua API, chat mới không nêu máy hay gói cũng dùng mặc định.
      - Nút bánh răng ở đầu cuộc chat đổi model và mức nỗ lực của thread (`chat.configure`) cho các câu trả lời sau. Tên model chỉ gồm chữ thường, số, `.` và `-`, nên không thể thành một option của CLI.
    - Ô tìm trên danh sách thread: tìm theo tiêu đề và nội dung mọi tin, không phân biệt hoa thường (kể cả chữ có dấu như Đ/đ). `%` và `_` được hiểu đúng là ký tự (roadmap 17f).
    - Người quản trị dự án đổi tên thread (`chat.rename`) và xoá thread cùng tin nhắn và đề xuất của nó (`chat.delete`). Thread đang chờ câu trả lời thì phải dừng câu trả lời trước khi xoá.
    - Trong câu trả lời, mã task của dự án và mã run (`R-…`) là link: sang *Task* (mở panel của task) hoặc *Lượt chạy* (mở run đó). Trang hiện `code`, **đậm**, *nghiêng*, khối ``` và link web; phần còn lại giữ nguyên chữ.
    - `#/chat?thread=<số>` mở thẳng một thread; quay lại trang thì thread vẫn mở. Người chỉ có quyền xem đọc được nhưng không gửi được. Link *run …* ở yêu cầu chạy của trang *Task* cũng mở thẳng run đó.
    - Leader làm việc với quyền của token câu trả lời. Máy dùng token role *agent* thì leader chỉ tới mức đóng góp, nên nó không tự tạo task hay xếp run. Nó đề xuất các việc đó (dưới đây).
  - **Leader đề xuất, người quản trị xác nhận** (hỏi ngày 29/9; roadmap 17c-1).
    - Qua MCP của hub, leader có `propose_task` (tạo task, có thể kèm phụ thuộc), `propose_task_status` (chuyển trạng thái kèm ghi chú) và `propose_run` (chạy task trên máy của chat hoặc máy khác, với vai trò, gói, số bản, review sau, chỉ dẫn). Mỗi đề xuất kèm một dòng lý do.
    - Leader không có `task_claim` và `task_update`: nó không tự nhận hay chuyển task. Chỉ token của câu trả lời đang viết mới đề xuất được, tối đa 20 việc mỗi câu trả lời.
    - Hub kiểm ngay khi leader đề xuất: task phải thuộc dự án của chat (với tạo mới thì chưa có), máy phải có trên hub, chữ không có ký tự ẩn hay secret.
    - Trên trang *Chat*, đề xuất hiện dưới câu trả lời. Người quản trị dự án bấm *Xác nhận* thì việc chạy như chính họ gọi (`chat.decide`): hub kiểm quyền của họ và ghi tên họ. Bấm *Bỏ qua* thì không có gì chạy.
    - Mỗi đề xuất chỉ được quyết định một lần. Lỗi khi chạy được giữ lại kèm lý do. Kết quả có link: task vừa tạo, hoặc yêu cầu chạy (mở panel của task). Đề xuất vẫn chờ quyết định sau khi câu trả lời đã xong.
    - Câu trả lời có từ hai đề xuất đang chờ thì có *Xác nhận tất cả* và *Bỏ qua tất cả* (`chat.decideAll`, roadmap 17e).
      - Hub chạy lần lượt: tạo task trước, rồi chuyển trạng thái, rồi xếp run; mỗi nhóm theo thứ tự leader đề xuất. Nhờ vậy leader đề xuất được run hay đổi trạng thái cho task mà chính câu trả lời đó tạo.
      - Việc nào lỗi thì dừng ở đó; các việc sau vẫn chờ để người quản trị xem. Việc người khác đã quyết định trong lúc đó thì giữ nguyên.
  - **Hướng dẫn cho leader** (roadmap 17c-2).
    - Hub có sẵn skill chung `hive-leader`. Skill này nói leader cần: tìm hiểu bằng task, lượt chạy (kể cả kết quả review) và máy; đề xuất thay vì tự làm; không merge; hỏi lại kèm vài lựa chọn khi cần quyết định; ghi đúng mã task và mã run để trang *Chat* làm link.
    - Nhóm sửa skill này trên trang *Skill* như mọi skill khác, hoặc tạo skill riêng cùng tên cho một dự án. Hub đang chạy nhận skill này một lần khi cập nhật; xoá đi thì hub không tạo lại. Cơ sở dữ liệu local của máy không có skill này.
    - Máy dặn leader đọc `skill_get hive-leader` trước khi trả lời, và nhắc lại: chỉ đề xuất, không merge, hỏi khi cần quyết định.
  - Hub lưu các cuộc trò chuyện (thread) theo dự án cùng tin nhắn của chúng (migration 15).
  - Gửi tin nhắn bằng `chat.send`. Thread mới cần chọn máy, có thể ghim một gói Claude; tin tiếp theo đi đúng máy và phiên của thread đó.
  - Hub kiểm máy như khi xếp run: đang online, đã bật ô nhận run từ hub, có repo của dự án, có gói Claude đang bật và đã đăng nhập. Thread đang chờ câu trả lời thì chưa nhận tin mới.
  - Máy nhận câu trả lời cần viết trong trả lời heartbeat. Trong lúc viết, máy báo `chat.progress` (chữ đến đâu, các bước, việc đang làm); câu trả lời của lượt báo cho máy biết người dùng đã huỷ chưa. Xong thì máy báo `chat.finish`, kèm mã phiên Claude Code để lần sau `--resume`. Chữ máy gửi lên được bỏ ký tự ẩn và dòng giống secret.
  - Câu trả lời không máy nào nhận sau 15 phút thì hết hạn; đang viết mà máy im 15 phút thì thành lỗi. Máy tắt ô nhận run thì câu trả lời đang chờ báo lỗi ngay. Thread không ai viết trong 90 ngày bị xoá.
  - Đọc bằng `chat.threads` và `chat.get` theo quyền xem dự án (`after` để chỉ lấy tin mới). Người quản trị dự án huỷ câu trả lời bằng `chat.cancel`; phần máy đã viết được giữ lại.
  - **Quyền của leader:** mỗi câu trả lời kèm một token ngắn hạn cho MCP của leader. Quyền của token là phần giao giữa quyền người gửi lúc viết tin và quyền token của máy: role thấp hơn, và với từng dự án thì mức thấp hơn (dự án chỉ một bên có thì bỏ). Token hết hiệu lực khi câu trả lời xong, bị huỷ hay hết hạn, và chậm nhất sau 30 phút. Việc leader làm được ghi dưới tên `<gói>.<máy>@chat-<người gửi>`.
  - **Máy viết câu trả lời:** máy đã bật *Được nhận run từ hub* hỏi hub mỗi 3 giây (`chat.poll`; hub cũ thì chờ heartbeat) và viết tối đa 2 câu trả lời cùng lúc.
    - Mỗi câu trả lời dùng một gói Claude đang bật, đã đăng nhập, không nghỉ, chưa chạm ngưỡng (gói ghim của thread nếu có, không thì gói ưu tiên cao nhất).
    - Máy chạy `claude -p` trong repo của dự án, tin nhắn đi qua stdin. MCP chỉ có server `xdev-hive` của hub, dùng token của câu trả lời (`--strict-mcp-config`), không dùng token của máy.
    - Leader đọc được repo nhưng bị cấm Edit, Write, MultiEdit, NotebookEdit. Nó chỉ chạy được các lệnh của dự án (mặc định là git chỉ đọc; xem *Lệnh leader được chạy* bên dưới). Không có lệnh nào thì Bash bị cấm hẳn. Tin tiếp theo của thread chạy `--resume` đúng phiên Claude Code của thread.
    - Máy báo lên hub mỗi 2 giây chữ đã viết, các bước (`▶` công cụ, `✓ ✗` kết quả) và việc đang làm. Hub báo đã huỷ thì máy dừng ngay; quá 20 phút thì cũng dừng.
    - Xong thì máy báo câu trả lời, chi phí và mã phiên. Lỗi (hết quota, không có CLI, thoát lỗi, quá giờ) hiện kèm lý do. File chứa token bị xoá khi câu trả lời xong.
- **Trang *Máy & run*** (web và desktop, chỉ hiện ở chế độ hub): danh sách máy (đang hoạt động / mất kết nối sau 2 phút), run đang chạy, số run đang chờ, và quota đang nghỉ. Admin xoá được máy đã mất kết nối. Máy im lặng quá 14 ngày thì hub tự xoá.
- **Phát hiện trùng tên máy**: nếu hai app chạy cùng lúc với cùng tên máy và cùng token, heartbeat của chúng xen kẽ nhau và hub đánh dấu *Trùng tên máy* (trong 5 phút gần nhất). Khởi động lại app chỉ đổi instance một lần nên không bị tính là trùng.
- **Quota dùng chung theo tài khoản**: điền *Tài khoản* cho profile (ví dụ `claude-max-duy`). Khi một máy gặp hết quota, nó báo lên hub (`cooldowns.set`). Máy khác có profile cùng tài khoản sẽ bỏ qua gói đó từ lần heartbeat kế tiếp, và thẻ profile hiện "báo từ …". Bấm *Hết nghỉ* (trên thẻ profile hoặc trên trang *Máy & run*) thì mọi máy thử lại gói đó. Profile không điền tài khoản thì chỉ nghỉ trên máy của nó, như trước. Tên tài khoản dùng chung cho mọi token, nên nên đặt tên kèm người sở hữu.

### Trang Quản trị (admin portal)

Trang này có trên hub web và trên app desktop ở chế độ hub, chỉ hiện với admin (tài khoản admin, hoặc token `admin` không thuộc tài khoản nào):

- **Máy**: mọi máy trong team, cùng kết quả *Cài đặt máy* mà máy gửi kèm heartbeat. App kiểm tra lúc mở, sau mỗi lần cài, và 10 phút một lần. Trang hiện CLI và phiên bản, hive-mcp, cấu hình từng repo, gói sub (không gửi lệnh chạy hay `env`), mục thiếu so với chính sách, và lịch sử yêu cầu cài.
- **Yêu cầu cài từ xa**: nút *Yêu cầu cài* chỉ có ở mục mà chính máy đó báo là app cài được: CLI qua npm, hive-mcp, cấu hình repo, codegraph, superpowers. Hub không bao giờ gửi lệnh shell tuỳ ý. Máy nhận yêu cầu ở heartbeat kế tiếp và hiện thông báo; ở trang *Cài đặt máy* người dùng phải bấm *Đồng ý và cài* thì app mới chạy, rồi kết quả được gửi lại hub. Yêu cầu chưa ai trả lời sẽ hết hạn sau 24 giờ; admin huỷ được yêu cầu đang chờ.
- **Chính sách**: CLI và hive-mcp bắt buộc trên mọi máy, các phần bắt buộc theo dự án (cấu hình agent, codegraph, index, superpowers), và profile mẫu cho team. Profile mẫu không được có `env`, vì thư mục đăng nhập và key là của từng máy. Máy nhận chính sách qua heartbeat: trang *Cài đặt máy* gắn nhãn "bắt buộc", trang *Gói sub & agent* có nút thêm từ mẫu.
- **Nhật ký**: mọi thao tác thay đổi dữ liệu của admin (sửa tài liệu, duyệt/từ chối, memory, task, token, chính sách, yêu cầu cài), đăng nhập, tạo/sửa/khoá tài khoản, đổi quyền, đặt lại mật khẩu, và kết quả máy báo về. Không ghi lượt đọc.
- **Người dùng & quyền**: tạo tài khoản, cấp quyền theo dự án, cấp/bỏ admin, đặt lại mật khẩu, khoá.
- Trang **Token** có thêm cột *Tài khoản* và *Máy*: token thuộc ai, các máy đang dùng từng token.

Agent không có app desktop (CI, cloud) gọi thẳng MCP qua HTTP: `POST https://<hub>/mcp`, header `Authorization: Bearer <token agent>`, tuỳ chọn `x-hive-agent: <tên>`.

**Agent chỉ đọc**: tạo token vai trò `viewer` cho agent chỉ cần tra cứu, ví dụ bot review hoặc CI đọc quy chuẩn. Với token này, MCP chỉ có các tool đọc: `memory_search`, `doc_list`, `doc_get`, `skill_list`, `skill_get`, `task_list`, `task_next`, `run_list`, `run_get`, `machine_list`. Tool ghi không có trong danh sách, và hub cũng từ chối lệnh ghi.

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

Repo có sẵn cấu hình cho ba công cụ. Mỗi công cụ cần mỗi người **đồng ý một lần trên máy của mình** khi Claude Code hỏi lúc mở repo.

- **[codegraph](https://github.com/colbymchenry/codegraph)** (MCP, khai báo trong `.mcp.json`): đồ thị symbol của code, lưu trong SQLite ngay trên máy, không cần API key. Tool chính là `codegraph_explore`, trả về mã nguồn liên quan kèm đường gọi hàm trong một lần gọi. Chạy qua `npx` với phiên bản ghim `1.6.0`. Lần đầu, npm tải gói cho đúng nền tảng (bản macOS arm64 khoảng 290 MB sau khi giải nén, vì có kèm runtime Node riêng).
  - Tạo index một lần trên mỗi máy: `npm run codegraph:init`. Index nằm ở `.codegraph/` (đã gitignore). Sau đó MCP server (có một daemon nền cho mỗi project) tự cập nhật khi file đổi. Chưa có index thì tool chỉ trả về hướng dẫn, không báo lỗi.
  - Codegraph mặc định gửi thống kê sử dụng ẩn danh ([TELEMETRY.md](https://github.com/colbymchenry/codegraph/blob/main/TELEMETRY.md)). Vì vậy `codegraph:init` chạy `codegraph telemetry off` trên máy trước (bật lại bằng `telemetry on`), và `.mcp.json` đặt `CODEGRAPH_TELEMETRY=0` cùng `CODEGRAPH_NO_UPDATE_CHECK=1`. Phiên bản đã ghim nên không cần kiểm tra bản mới.
- **[superpowers](https://github.com/obra/superpowers)** (plugin, khai báo trong `.claude/settings.json` → `enabledPlugins`): bộ skill cho TDD, debug, lập kế hoạch… cùng hook lúc bắt đầu phiên. Plugin lấy từ marketplace chính thức `claude-plugins-official`. Nếu Claude Code báo plugin đã bật nhưng chưa cài, chạy `/plugin install superpowers@claude-plugins-official`.
- **[shadcn](https://ui.shadcn.com/docs/mcp)** (MCP, trong `.mcp.json`): tìm, xem ví dụ và lấy lệnh thêm component shadcn/ui từ registry. Chạy `npx shadcn@4.21.0 mcp --cwd packages/ui`, vì `components.json` nằm ở `packages/ui`. Thêm component bằng tay: `cd packages/ui && npx shadcn@4.21.0 add <tên>`; component được đặt vào `src/components/ui/`.

Cấu hình này chỉ áp dụng cho Claude Code. Codex và Gemini dùng được codegraph qua `codegraph install` (lệnh này ghi vào cấu hình toàn cục của từng agent trên máy).

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
