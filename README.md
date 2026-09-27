# xDev Hive

Tài liệu, memory và task dùng chung cho nhiều coding agent (Claude Code, Codex, Gemini CLI, Cursor…) chạy trên nhiều gói subscription khác nhau.

```
┌─ xDev Hive.app (Electron, menu bar) ─┐        ┌─ Hub web (Express) ─────────────────┐
│ Tài liệu · Đề xuất · Memory · Task   │  HTTP  │ /api/rpc   UI quản trị (token)      │
│ Dự án & cài đặt: sync, cài agents    │ ─────▶ │ /mcp       MCP Streamable HTTP      │
└──────────────┬───────────────────────┘        │ SQLite: docs, proposals, memory,    │
               │ local.db hoặc hub              │ tasks, tokens                       │
      hive-mcp (stdio) ◀── Claude Code · Codex · Gemini (mỗi agent = 1 gói sub)
```

- **Tài liệu**: bản gốc của `AGENTS.md`, quy chuẩn chung (`org/*`), nhật ký quyết định. Có version, lịch sử và diff.
- **Đề xuất**: agent không sửa tài liệu trực tiếp mà gọi `doc_propose`, admin duyệt. Nếu tài liệu đã đổi sau khi agent đọc, đề xuất bị đánh dấu xung đột, không ghi đè.
- **Memory**: `memory_write` / `memory_search`, tìm kiếm FTS5 có dấu hoặc không dấu đều được. Trên hub, memory do agent ghi cần admin duyệt mới hiện cho agent khác.
- **Task**: `task_claim` giữ task theo lease, hai agent không nhận trùng. `task_update` kèm ghi chú bàn giao.
- **Đồng bộ vào repo**: render `AGENTS.md` (khối chung + phần riêng của dự án), `CLAUDE.md` (`@AGENTS.md`), `docs/decisions.md`. Chỉ commit các file này, không push.
- **Chặn sửa tay**: hook `PreToolUse` của Claude Code và `pre-commit` của git (áp dụng cho mọi agent).
- **Board + runner** (desktop): giao task cho agent chạy headless (`claude -p`, `codex exec`, `gemini -p`…). Mỗi task có worktree riêng. Hết quota thì tự chuyển gói sub, xong thì review chéo bằng vendor khác.
- **GitLab MR**: review chéo đạt thì push `ai/<task>` và tạo MR (review yêu cầu sửa thì tạo Draft). Chạy lại thì cập nhật MR cũ.

## Cấu trúc

| Thư mục | Nội dung |
|---|---|
| `packages/core` | Schema zod, phân quyền, `SqliteHive` (node:sqlite + FTS5), `HubBackend`, render sync, config |
| `packages/mcp` | 8 tool MCP, entry stdio `hive-mcp` |
| `packages/ui` | React UI dùng chung cho web và desktop |
| `apps/web` | Hub: REST RPC, MCP qua HTTP, token, phục vụ UI |
| `apps/desktop` | Electron: tray, IPC, sync repo, cài MCP vào Claude/Codex/Gemini, shim `hive-mcp`, runner (`src/main/runner`) |

Không có native module: SQLite dùng `node:sqlite` có sẵn trong Node 24+ và Electron 44.

## Chạy

```bash
nvm use && npm install
npm test            # 92 test: core, mcp, hub (REST + MCP HTTP), desktop (installer, git hook, sync, runner, GitLab MR)
npm run typecheck
```

Hub (dev, có HMR):

```bash
npm run dev:web
```

Lần chạy đầu in **token admin** ra console. Mở http://localhost:7788 và dán token vào. Muốn reset thì xoá `apps/web/data/`.

App desktop:

```bash
npm run dev:desktop                              # dev
npm run smoke -w @xdev-hive/desktop              # app + config tạm + agent giả + GitLab giả: hết quota → xoay gói → review chéo → MR
npm run dist -w @xdev-hive/desktop               # .dmg/.zip (macOS), cần ký để phân phối
```

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
- **Chọn gói**: gói được ghim > bỏ qua gói tắt/đang bận/đang nghỉ/sai vai trò/đã thử ở run này > review ưu tiên vendor khác người làm > ưu tiên thấp chạy trước > cùng ưu tiên thì gói lâu chưa dùng chạy trước.
- **Hết quota**: nhận diện từ cuối output khi CLI thoát lỗi (`usage limit`, `429`, `RESOURCE_EXHAUSTED`…). Đọc giờ reset nếu có (`|<epoch>`, `try again in 2 hours 13 minutes`, `resets 3pm`, ISO), không có thì dùng thời gian nghỉ mặc định. Phần làm dở được commit `wip`, lần sau chạy tiếp trên cùng branch với prompt "tiếp tục từ lần trước".
- **Worktree**: `~/.xdev-hive/worktrees/<dự án>/<task>` trên branch `ai/<task>`, không đụng checkout chính. Runner commit phần agent để lại (hook của repo vẫn chạy), không push. File config agent chưa commit được chép vào worktree nhưng không đưa vào branch.
- **Hive**: runner `task_claim` trước khi chạy với cùng tên agent như `hive-mcp` (`HIVE_AGENT` = id profile). Xong thì chuyển task sang *Chờ review* kèm tóm tắt, trừ khi agent đã tự làm qua MCP. Review chéo được nối vào ghi chú task.
- Lịch sử run và log nằm ở `~/.xdev-hive/runs.db` và `~/.xdev-hive/runs/<id>.log`. Log có prompt và output, **không** ghi biến môi trường.
- App mở từ Finder có `PATH` ngắn, nên runner lấy `PATH` từ login shell (`$SHELL -ilc`) cộng `~/.local/bin`. Dùng nút *Kiểm tra CLI* để xem lệnh có tìm thấy không.

Hai gói của cùng một vendor: tạo 2 profile, profile thứ hai trỏ CLI sang thư mục đăng nhập riêng, rồi đăng nhập một lần trong terminal với biến đó, ví dụ `CLAUDE_CONFIG_DIR=~/.claude-2` (Claude Code) hoặc `CODEX_HOME=~/.codex-2` (Codex). Tên biến và cờ headless mặc định lấy theo tài liệu CLI mình biết; hãy kiểm tra bằng `--help` của bản bạn đang cài.

Cờ mặc định là mức "cho sửa file" (`--permission-mode acceptEdits`, `--full-auto`, `--approval-mode auto_edit`). Muốn agent tự chạy test hay lệnh shell thì mở rộng tham số của profile, và cân nhắc rủi ro vì lệnh chạy trên máy thật (worktree không phải sandbox).

## Merge request trên GitLab

Cấu hình ở *Dự án & cài đặt* → **GitLab merge request**: URL, access token (scope `api`, cộng `write_repository` nếu push qua HTTPS), bật *Tự tạo MR*.

```
implement ─(review chéo)─▶ review ── verdict approve ───────▶ push ai/<task> → MR ready
                                  └─ cần sửa / không rõ ─────▶ MR "Draft:" (hoặc không tạo)
implement (không review, chế độ "ngay khi làm xong") ─────────▶ push → MR ready
```

- **GitLab project** đọc từ remote (`git@gitlab.fis.vn:group/proj.git`, `https://…/group/proj.git`). Không đọc được thì điền ở nút *GitLab* của dự án. Target mặc định là default branch của project.
- **Push**: remote HTTPS cùng host GitLab thì dùng token qua git config trong env (`GIT_CONFIG_*`), không ghi vào `.git/config` và không hiện trong danh sách tiến trình. Remote SSH dùng key sẵn có, `BatchMode=yes` để không treo chờ nhập. Không bao giờ force push.
- **MR đã có** (cùng source branch, đang mở): chỉ cập nhật tiêu đề, mô tả và *thêm* label, không đổi target hay label người khác đã sửa trên GitLab.
- **Mô tả MR** gồm task, tóm tắt của agent làm, kết quả review, danh sách commit. Output của agent nằm trong code block (dài hơn mọi chuỗi backtick trong output), nên GitLab không chạy quick action (`/merge`, `/approve`…) hay mention từ đó.
- Link MR được ghi vào ghi chú task trong Hive và hiện trên Board. Lỗi GitLab/push được ghi ở run (không làm run thất bại). Có nút *Tạo MR / Cập nhật MR* để chạy tay.
- API gọi qua `net.fetch` của Electron, dùng proxy và chứng chỉ của hệ thống.

## Hub cho team

### Docker (khuyên dùng)

```bash
HIVE_HOSTNAME=hive.example.com docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml logs hub     # lần đầu in token admin
```

- [`Dockerfile`](Dockerfile): image chỉ gồm hub (core, mcp, web và UI đã build), không có mã desktop. Chạy bằng user `node`, dữ liệu ở `/data`, có `HEALTHCHECK` gọi `/api/health`.
- [`deploy/compose.yaml`](deploy/compose.yaml): hub + Caddy (HTTPS tự động, cần DNS trỏ về máy và mở cổng 80/443). Không muốn dùng Caddy thì bỏ service `caddy`, publish cổng `7788` và đặt proxy của bạn phía trước, giữ nguyên Host header.
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
| `HIVE_BOOTSTRAP_TOKEN` | – | Token admin cố định (≥ 32 ký tự) cho deploy tự động |
| `HIVE_BACKUP_DIR` | tắt (image: `/data/backups`) | Bật backup: một bản khi khởi động (trước khi migrate schema) và định kỳ |
| `HIVE_BACKUP_HOURS` / `HIVE_BACKUP_KEEP` | `24` / `7` | Chu kỳ backup và số bản giữ lại |

Mất token admin thì tạo lại trên server (Docker: `docker compose -f deploy/compose.yaml exec hub npm run token -w @xdev-hive/web -- create duy admin`):

```bash
npm run token -w @xdev-hive/web -- create duy admin
```

### Backup, khôi phục, nâng cấp

- Backup dùng `VACUUM INTO`, nên an toàn khi hub đang chạy. Không nên copy thẳng `hub.db`, vì bản copy thiếu phần còn nằm trong file `-wal`. Tên file dạng `hub-2026-09-27T09-00-00-000Z.db`. Khi xoay vòng, hub chỉ xoá file có đúng dạng tên này.
- Backup ngay (ví dụ trước khi làm việc rủi ro): `npm run backup -w @xdev-hive/web -- [thư mục] [số bản giữ]`. Lệnh này chỉ đọc file, không migrate.
- Mặc định, compose để backup trên volume `hive-backups`, cùng đĩa với database. Để backup còn nguyên khi mất đĩa, trỏ `HIVE_BACKUP_PATH=/mnt/backup/hive` sang đĩa khác (thư mục phải cho uid 1000 ghi), hoặc đồng bộ thư mục backup ra ngoài.
- **Khôi phục**: dừng hub, chép bản backup đè lên `hub.db`, xoá `hub.db-wal` và `hub.db-shm` nếu có, rồi khởi động lại.
- **Nâng cấp**: `git pull && docker compose -f deploy/compose.yaml up -d --build`. Hub tự backup trước khi chạy migration mới.

Máy của từng người: app desktop → chế độ **Hub dùng chung** → URL + token (vai trò `agent` hoặc `admin`). Shim `hive-mcp` tự chuyển tiếp lên hub, nên config MCP trong repo giống nhau cho mọi người và không chứa token.

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
- **Trang *Máy & run*** (web và desktop, chỉ hiện ở chế độ hub): danh sách máy (đang hoạt động / mất kết nối sau 2 phút), run đang chạy, số run đang chờ, và quota đang nghỉ. Admin xoá được máy đã mất kết nối. Máy im lặng quá 14 ngày thì hub tự xoá.
- **Phát hiện trùng tên máy**: nếu hai app chạy cùng lúc với cùng tên máy và cùng token, heartbeat của chúng xen kẽ nhau và hub đánh dấu *Trùng tên máy* (trong 5 phút gần nhất). Khởi động lại app chỉ đổi instance một lần nên không bị tính là trùng.
- **Quota dùng chung theo tài khoản**: điền *Tài khoản* cho profile (ví dụ `claude-max-duy`). Khi một máy gặp hết quota, nó báo lên hub (`cooldowns.set`). Máy khác có profile cùng tài khoản sẽ bỏ qua gói đó từ lần heartbeat kế tiếp, và thẻ profile hiện "báo từ …". Bấm *Hết nghỉ* (trên thẻ profile hoặc trên trang *Máy & run*) thì mọi máy thử lại gói đó. Profile không điền tài khoản thì chỉ nghỉ trên máy của nó, như trước. Tên tài khoản dùng chung cho mọi token, nên nên đặt tên kèm người sở hữu.

### Trang Quản trị (admin portal)

Trang này có trên hub web và trên app desktop ở chế độ hub, chỉ hiện với token `admin`:

- **Máy**: mọi máy trong team, cùng kết quả *Cài đặt máy* mà máy gửi kèm heartbeat. App kiểm tra lúc mở, sau mỗi lần cài, và 10 phút một lần. Trang hiện CLI và phiên bản, hive-mcp, cấu hình từng repo, gói sub (không gửi lệnh chạy hay `env`), mục thiếu so với chính sách, và lịch sử yêu cầu cài.
- **Yêu cầu cài từ xa**: nút *Yêu cầu cài* chỉ có ở mục mà chính máy đó báo là app cài được: CLI qua npm, hive-mcp, cấu hình repo, codegraph, superpowers. Hub không bao giờ gửi lệnh shell tuỳ ý. Máy nhận yêu cầu ở heartbeat kế tiếp và hiện thông báo; ở trang *Cài đặt máy* người dùng phải bấm *Đồng ý và cài* thì app mới chạy, rồi kết quả được gửi lại hub. Yêu cầu chưa ai trả lời sẽ hết hạn sau 24 giờ; admin huỷ được yêu cầu đang chờ.
- **Chính sách**: CLI và hive-mcp bắt buộc trên mọi máy, các phần bắt buộc theo dự án (cấu hình agent, codegraph, index, superpowers), và profile mẫu cho team. Profile mẫu không được có `env`, vì thư mục đăng nhập và key là của từng máy. Máy nhận chính sách qua heartbeat: trang *Cài đặt máy* gắn nhãn "bắt buộc", trang *Gói sub & agent* có nút thêm từ mẫu.
- **Nhật ký**: mọi thao tác thay đổi dữ liệu của admin (sửa tài liệu, duyệt/từ chối, memory, task, token, chính sách, yêu cầu cài) và kết quả máy báo về. Không ghi lượt đọc.
- Trang **Token** có thêm cột *Máy*: các máy đang dùng từng token.

Agent không có app desktop (CI, cloud) gọi thẳng MCP qua HTTP: `POST https://<hub>/mcp`, header `Authorization: Bearer <token agent>`, tuỳ chọn `x-hive-agent: <tên>`.

## Bảo mật

- Token chỉ lưu SHA-256, plaintext hiện một lần. Không thu hồi được token admin cuối cùng.
- Memory và tài liệu bị từ chối nếu chứa chuỗi giống secret (AWS, GitHub, GitLab, Slack, `sk-…`, JWT, private key, token Hive).
- Desktop: `contextIsolation`, `sandbox`, preload chỉ lộ đúng các hàm cần. IPC kiểm tra nguồn gọi. CSP trong bản build.
- `~/.xdev-hive/config.json` có quyền `0600` vì có thể chứa token hub.
- Web lưu token trong `localStorage`. Khi đưa ra ngoài mạng nội bộ nên thay bằng đăng nhập GitLab OAuth.

## Làm việc trên repo này với Claude Code

Repo có sẵn cấu hình cho hai công cụ. Cả hai đều cần mỗi người **đồng ý một lần trên máy của mình** khi Claude Code hỏi lúc mở repo.

- **[codegraph](https://github.com/colbymchenry/codegraph)** (MCP, khai báo trong `.mcp.json`): đồ thị symbol của code, lưu trong SQLite ngay trên máy, không cần API key. Tool chính là `codegraph_explore`, trả về mã nguồn liên quan kèm đường gọi hàm trong một lần gọi. Chạy qua `npx` với phiên bản ghim `1.6.0`. Lần đầu, npm tải gói cho đúng nền tảng (bản macOS arm64 khoảng 290 MB sau khi giải nén, vì có kèm runtime Node riêng).
  - Tạo index một lần trên mỗi máy: `npm run codegraph:init`. Index nằm ở `.codegraph/` (đã gitignore). Sau đó MCP server (có một daemon nền cho mỗi project) tự cập nhật khi file đổi. Chưa có index thì tool chỉ trả về hướng dẫn, không báo lỗi.
  - Codegraph mặc định gửi thống kê sử dụng ẩn danh ([TELEMETRY.md](https://github.com/colbymchenry/codegraph/blob/main/TELEMETRY.md)). Vì vậy `codegraph:init` chạy `codegraph telemetry off` trên máy trước (bật lại bằng `telemetry on`), và `.mcp.json` đặt `CODEGRAPH_TELEMETRY=0` cùng `CODEGRAPH_NO_UPDATE_CHECK=1`. Phiên bản đã ghim nên không cần kiểm tra bản mới.
- **[superpowers](https://github.com/obra/superpowers)** (plugin, khai báo trong `.claude/settings.json` → `enabledPlugins`): bộ skill cho TDD, debug, lập kế hoạch… cùng hook lúc bắt đầu phiên. Plugin lấy từ marketplace chính thức `claude-plugins-official`. Nếu Claude Code báo plugin đã bật nhưng chưa cài, chạy `/plugin install superpowers@claude-plugins-official`.

Cấu hình này chỉ áp dụng cho Claude Code. Codex và Gemini dùng được codegraph qua `codegraph install` (lệnh này ghi vào cấu hình toàn cục của từng agent trên máy).

## Việc tiếp theo

- Đăng nhập GitLab OAuth cho hub, thay cho token dán tay.
- Postgres (+ pgvector) khi team lớn hoặc cần tìm kiếm theo ngữ nghĩa.
- Đọc quota còn lại chủ động (nếu CLI có lệnh báo usage) thay vì chỉ phản ứng khi đã hết.
- Theo dõi trạng thái MR (pipeline, merged) để tự chuyển task sang *Xong*.
- Ký và notarize bản macOS (cần chứng chỉ Developer ID).
