# 77. client-perf: app và web nhẹ hơn, nhanh hơn, cache đúng chỗ

Hỏi 9/10: "nghiên cứu google xem, mấy app client này cần làm gì để tối ưu không, cache đồ nữa, vv…"

**Trạng thái: người dùng đã trả lời ngày 9/10.**

- **Q1**: dùng TanStack Query.
- **Q2**: làm push (SSE) ngay trong đợt này, song song với 77g.
- **Q3**: lưu cache truy vấn vào IndexedDB, xoá khi đăng xuất hoặc khi quyền đổi.
- **Q4**: chưa quyết. Người dùng muốn rà soát lại các task đang mở trước (xem [76-task-triage.md](76-task-triage.md)).

## Tóm tắt

- Lỗi nặng nhất nằm ở **main process của app**, không phải ở giao diện:
  - Mỗi 3–5 giây, app đọc lại toàn bộ log của run, bằng lệnh đọc đồng bộ.
  - Git chạy bằng `execFileSync`.
  - Heartbeat phải chờ quét worktree và dò CLI xong mới gửi.
  - Các lệnh gọi hub không có timeout.

  Bốn điểm này khớp với ba sự cố đã thấy: heartbeat bị trễ khi máy tải cao, app treo khi thoát lúc hub sập (9/10), và máy tắc khi chạy nhiều run.
- **Web** phải tải 678 KB gzip trước khi hiện màn hình đầu tiên, vì cả 45 trang được nạp ngay từ đầu, kể cả trang quản trị và React Flow. Asset không có cache dài hạn và không nén. Tab bị ẩn vẫn tiếp tục poll.
- **Dữ liệu**: hook `useQuery` tự viết không có cache, không gộp các lệnh gọi trùng nhau và không có `staleTime`. Một trang có thể gọi `memory.list` (500 dòng) ba lần cùng lúc.
- Đề xuất chia 3 đợt:
  1. Ổn định app: log, git, heartbeat, timeout, thoát app.
  2. Web tải nhanh, cache đúng: header tĩnh, nén, poll chỉ khi tab đang mở, cache truy vấn dùng chung.
  3. Chia bundle theo trang và dùng push thay polling. Đợt này làm cùng hoặc sau 76h (tách hai shell).

## 1. Đo được gì (đọc code `origin/main` 747b38dd và bản build có sẵn trên máy)

| | Hiện tại |
|---|---|
| Chunk đầu của web | 2,29 MB (678 KB gzip). CSS 156 KB (28 KB gzip). |
| Chunk đầu của renderer app | 2,32 MB (687 KB gzip). `out/main/index.js` 2,81 MB, không minify. `app.asar` 25 MB. |
| Chunk đã nạp khi cần | elk 1,48 MB, RichEditor 712 KB, mermaid 634 KB, cytoscape 443 KB, katex 261 KB, Graph 70 KB. |
| Nạp ngay từ đầu dù không cần | React Flow (Pipeline), react-markdown, remark-gfm, thư viện diff, mọi trang quản trị. |
| Số RPC khi để web admin rảnh ở trang Hôm nay | Khoảng 34/phút [Inference: đếm từ các chu kỳ poll trong code] |
| Số request lên hub mỗi phút của một máy đang rảnh | Khoảng 40–55 [Inference] |
| Theo dõi một run đang chạy | `runs.get` mỗi 3 giây trả log (tới 60 KB) và patch (tới 400 KB): khoảng 150 KB/s cho mỗi người xem [Inference] |

## 2. Phát hiện chính

### App, main process (gây sự cố thật)

1. **Đọc log**: `runner.log()` đọc toàn bộ file bằng lệnh đồng bộ, bắt đầu từ byte 0 (`apps/desktop/src/main/runner/runner.ts:1020–1042`).
   - Trang Runs gọi hàm này mỗi 3 giây.
   - `pushRuns` gọi nó mỗi 5 giây cho tối đa 60 run gần nhất (`:1792`).
2. **Git đồng bộ**: `git()` dùng `execFileSync` (`git.ts:5–12`). Một lần lấy patch gọi tới 30 lệnh git liền nhau (`worktree.ts:317–340`), và mỗi trang tài liệu được mirror cũng gọi một lệnh.
3. **Heartbeat** chạy bằng `setInterval` 30 giây và không chặn được hai nhịp chồng nhau (`runner.ts:628`).
   - Trước khi gửi, nó chờ dò model (3 giây) và quét worktree. Quét worktree chạy `tasks.list`, `git fetch` (10 giây) và `du` cho từng dự án.
   - Có N dự án thì một nhịp có thể mất tới N×10 giây. Đây là nguyên nhân của BUG-heartbeat-stall.
4. **Gọi hub không có timeout**: `HubBackend` gọi `fetch` không có `AbortSignal` (`core/hub-client.ts:71–86`). Lúc thoát, app chờ `runner.stop()` mà không có hạn chót (`index.ts:1788–1822`).
   - Hậu quả: khi hub sập, app treo khi thoát (đã thấy 9/10).
   - BUG-quit-hang đã sửa một nguyên nhân khác; trường hợp hub không liên lạc được thì vẫn còn.
5. **Dò CLI**: `setup.status` chạy một login shell và khoảng 9 lệnh `--version` (mỗi lệnh 15 giây).
   - Hàm này chạy 3 lần lúc khởi động renderer, và chạy lại mỗi 15 giây khi đang mở trang Bắt đầu hoặc Onboarding. Không có gì gộp các lần gọi trùng.
   - [Inference] Kết quả là hơn 30 tiến trình được tạo lúc khởi động.
6. **Các timer khác**:
   - `chat.poll` (3 giây) và tray (20 giây) không có cơ chế chặn chồng nhịp.
   - Tray tải cả `proposals.list` chỉ để đếm số đề xuất.
   - `desktop.runs` đọc `SELECT *`, kéo cả `diff_patch`, rồi mới bỏ đi.
7. **Khởi động**: trước khi có cửa sổ, app đọc config đồng bộ, mở DB và chạy migrate. `agentPath()` có thể chạy login shell đồng bộ tới 8 giây (`shell-path.ts:12–52`).

### Web: tải trang và cache

8. **Bundle**: không cấu hình `manualChunks`, chỉ Graph là `React.lazy` (`packages/ui/src/App.tsx:1–69`). Khi tách hai shell (76h), app sẽ không còn bundle trang web, nhưng web vẫn cần chia theo trang.
9. **Header tĩnh**:
   - `express.static` để `maxAge` 1 giờ cho mọi file, kể cả asset đã có hash (`apps/web/src/app.ts:1152–1154`).
   - Không có nén: không có middleware, Caddy cũng không có `encode`. Người dùng qua LAN tải 2,3 MB chưa nén.
   - Nếu không tìm thấy một `/assets/*.js`, hub trả về `index.html`, và không có gì bắt `vite:preloadError`. [Inference] Vì vậy trang nạp khi cần có thể hỏng ngay sau mỗi lần deploy.
10. **Tab bị ẩn vẫn poll**: `visibleInterval` chỉ dừng khi chạy trong app (`visible-interval.ts:3–10`). `useRefresh` của trang Runs và các `setInterval` của trang quản trị không bao giờ dừng.

### Dữ liệu

11. **Chưa có cache truy vấn dùng chung** (`hooks.ts:92–193`):
    - Các lệnh gọi giống nhau chạy song song.
    - Mỗi lần poll đặt lại `loading`, nên mỗi lần poll vẽ lại trang hai lần.
    - Hộp việc tải mọi task và run (500 dòng mỗi trang); `tasks.list` không có giới hạn.
12. **Không có push**: chỉ terminal dùng WebSocket. Run, log và chat đều poll; chat ít ra có con trỏ `after`. RPC không gộp, không có ETag, và UI không có timeout hay retry.
13. **Danh sách dài**: không có virtualization. LogView vẽ mọi dòng và parse lại sau mỗi lần poll.

## 3. Bên ngoài làm thế nào (đọc ngày 9/10)

- **Electron** ([performance checklist](https://www.electronjs.org/docs/latest/tutorial/performance)):
  - Không chặn main process: không IPC đồng bộ, không `fs` hay `child_process` đồng bộ.
  - `require` khi cần mới nạp.
  - Đưa việc nặng sang [`utilityProcess`](https://www.electronjs.org/docs/latest/api/utility-process).
  - Truyền log qua [MessagePort](https://www.electronjs.org/docs/latest/tutorial/message-ports).
  - Mọi lệnh gọi mạng có timeout. Retry theo backoff có jitter ([AWS](https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter)).
- **React và Vite**:
  - [`lazy()`](https://react.dev/reference/react/lazy) theo trang, đặt giới hạn kích thước chunk ([Vite](https://vite.dev/config/build-options)).
  - [React Compiler 1.0](https://react.dev/blog/2025/10/07/react-compiler-1) tự memo.
  - Ảo hoá log và danh sách dài ([TanStack Virtual](https://tanstack.com/virtual/latest/docs/api/virtualizer)).
  - Parse diff và markdown trong worker.
- **Dữ liệu** ([TanStack Query](https://tanstack.com/query/v5/docs/framework/react/guides/important-defaults)):
  - Đặt `staleTime` cho từng loại truy vấn và gộp các lệnh gọi trùng.
  - Chỉ poll khi tab đang mở; dừng poll khi run đã kết thúc.
  - Lưu cache vào IndexedDB, đổi khoá theo phiên bản app.
  - Dùng push (SSE) rồi `invalidateQueries` ([TkDodo](https://tkdodo.eu/blog/using-web-sockets-with-react-query)).
  - Với LAN chạy HTTP/1.1, mỗi tab chỉ nên mở một luồng SSE ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)).
- **HTTP**:
  - Asset có hash: `public, max-age=31536000, immutable`. `index.html`: `no-cache` ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control)).
  - Nén brotli hoặc gzip ([compression 1.8](https://app.unpkg.com/compression@1.8.0/files/README.md)).
  - Cloudflare không cache `POST /api/rpc`; thêm luật Bypass cho `/api/*` để rõ ràng ([Cloudflare](https://developers.cloudflare.com/cache/concepts/default-cache-behavior)).
  - Service worker (PWA) không cần cho một công cụ tự host, vì dễ phục vụ bản cũ.

## 4. Mục tiêu (đo trên Mac mini và trên web qua tunnel)

Các con số dưới đây là mục tiêu đề xuất [Inference]. Chúng chưa được đo sau khi sửa.

| Chỉ số | Hiện tại | Mục tiêu |
|---|---|---|
| Heartbeat gửi chậm nhất | Có thể hơn 30 giây | Dưới 5 giây, kể cả khi đang quét worktree |
| Thoát app khi hub sập | Treo vài phút | Dưới 15 giây, commit WIP vẫn xong |
| Đọc log trên main process | Toàn file, đồng bộ, 3–5 giây một lần | Chỉ đọc phần đuôi, bất đồng bộ, bỏ qua khi file không đổi |
| Chunk đầu của web | 678 KB gzip | ≤ 250 KB gzip; vượt thì build fail |
| Tải lại web lần hai | Tải lại asset sau 1 giờ | 0 byte asset: chỉ còn `index.html` và RPC |
| RPC/phút khi tab bị ẩn | ~34 | 0 (chỉ còn heartbeat của máy) |
| Request/phút của một máy rảnh | ~40–55 | ≤ 10 |

## 5. Chia việc (đề xuất, chưa tạo task)

| Mục | Nội dung | Phụ thuộc |
|---|---|---|
| **77a. desktop-io** | Log chỉ đọc phần đuôi, bất đồng bộ, cache theo size/mtime. `git()` chuyển sang bất đồng bộ trên các đường hay chạy (patch, mirror, worktree). `desktop.runs` chọn đúng cột cần. | Không |
| **77b. heartbeat-own-timer** | Heartbeat có timer riêng (`setTimeout` nối tiếp, có jitter) và chặn nhịp chồng. Gửi kết quả quét worktree và dò model gần nhất, còn việc quét và dò chạy trên timer riêng. Gộp BUG-heartbeat-stall vào đây. | Không |
| **77c. hub-timeouts-quit** | Mọi lệnh gọi hub có `AbortSignal.timeout` (~15 giây) cả ở main lẫn UI. `chat.poll` và tray có chặn chồng nhịp. Thoát app có hạn chót: lệnh gọi hub dừng sau 10 giây, commit WIP cục bộ vẫn chạy xong, rồi `app.exit()`. Retry dùng backoff có jitter. | Không |
| **77d. probe-dedup** | `setup.status` và dò login: mỗi lúc chỉ một lần chạy, cache 30–60 giây, không mở login shell mỗi lần. Gộp 3 lần gọi lúc khởi động. Tray dùng lệnh đếm thay vì tải cả danh sách đề xuất. | Không |
| **77e. static-cache** | `/assets/*` có `immutable` một năm; `index.html` để `no-cache`; asset thiếu trả 404; bắt `vite:preloadError` để tải lại; bật nén (Express hoặc Caddy `encode`); luật Bypass `/api/*` cho Cloudflare (ghi vào tài liệu deploy). | Không |
| **77f. visible-polling** | Chỉ poll khi tab đang mở, ở cả web lẫn app. `useRefresh` và timer trang quản trị dùng chung cơ chế này. Dừng poll khi run đã kết thúc. | Không |
| **77g. query-cache** | Dùng TanStack Query (Q1): `staleTime` theo loại, gộp lệnh gọi trùng, không bật `loading` khi poll nền. Hộp việc và `tasks.list` có phân trang. `runs.get`/`runLog` có offset log và chỉ trả patch khi đã đổi. | 77f |
| **77h. lazy-pages** | Mỗi trang dùng `React.lazy`, preload khi rê chuột, `manualChunks` cho vendor, giới hạn 250 KB gzip trong build. Ảo hoá LogView, Tasks, Memory. Parse diff và markdown trong worker. | 76h (tránh làm hai lần) |
| **77i. push-events** | Một luồng SSE mỗi tab cho run, chat và log, đi qua tunnel (có heartbeat comment 20 giây), cùng `invalidateQueries`. Giữ poll chậm làm dự phòng. Q2: làm ngay đợt này, song song với 77g. | 77f |

Thứ tự đề xuất:
- 77a–d (ổn định app) và 77e–f (web) chạy song song với 76a, vì khác file và không đụng lô giao diện 72.
- 77g (đổi hook ở mọi trang) và 77i làm sau khi lô 72 vào main, để không xung đột với các trang đang làm lại.
- 77h đi cùng 76h.

## 6. Câu hỏi đã gửi (câu trả lời ở đầu trang)

- **Q1.** Dùng thư viện TanStack Query (chuẩn, có sẵn gộp lệnh gọi, cache, lưu vào IndexedDB), hay sửa tiếp hook tự viết? Đề xuất: **TanStack Query**.
- **Q2.** Có làm push (SSE) ở đợt này không, hay chờ sau khi poll đã gọn? Đề xuất: **sau**, là mục cuối (77i).
- **Q3.** Lưu cache truy vấn vào IndexedDB để mở web là có dữ liệu ngay (đổi khoá theo phiên bản app)? Cache có thể giữ dữ liệu của dự án mà người dùng vừa mất quyền, cho tới khi tải lại. Đề xuất: **có**, nhưng xoá cache khi đăng xuất hoặc khi quyền đổi.
- **Q4.** Thứ tự so với 76: làm 77a–f song song với 76a (đề xuất), hay xong 76 rồi mới làm 77?

## Ngoài phạm vi

- Service worker / PWA offline.
- SQLite cache dữ liệu hub trong app.
- Đổi sang HTTP/2 tại origin.
- Thu nhỏ `app.asar`.
