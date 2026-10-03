# 38. Đưa một hệ thống nhiều repo vào Hive (customer)

Viết ngày 3/10. Người dùng nối dự án khách hàng vào Hive trên máy Windows `win-runner` (app 0.116): 8 repo GitLab nằm lồng trong `D:\src\customer-ai\{his\backend,his\frontend,iam,deploy}\…`, gom vào hệ thống `customer-ai`. Họ phải đi vòng qua 8 chỗ thiếu, mỗi chỗ thành một task R-38a…h. Đường dẫn bên dưới theo `origin/main` 4419f3c.

Chọn ngày 3/10:
- A (38a) và B (38b) làm trước vì chặn việc dùng hằng ngày.
- Tên chung là hệ thống `customer-ai`. Project key `customer` (141 trang SRS, kiến trúc, quy ước nhập từ Forge ngày 27/9) và `customer-ai` (một trang `agents` mồ côi) là cùng một dự án. Sau 38g, các trang chuyển sang `system/customer-ai/…` và hai key này thôi dùng.
- Agent không tăng version, không đánh dấu roadmap: người merge làm.

Thứ tự (hub chặn task chưa xong phụ thuộc):

```
38a ─┬─ 38f ── 38c
     └─ 38h
38b
38d ── 38e
36a ── 38g
```

## R-38a. Runner ghi context Hive vào worktree trước mỗi run

**Hiện trạng.**
- Worktree chỉ chép `AGENT_CONFIG_FILES` (`apps/desktop/src/main/runner/worktree.ts:12`, `129-136`). `AGENTS.md`, `CLAUDE.md`, skill và rules là bản trên nhánh đích. Repo chưa merge context vào `dev` thì agent không đọc được quy ước nào, dù prompt dặn "Read AGENTS.md in the working copy first" (`runner/command.ts:73`, `86`, `106`, `116`).
- `commitAll` (`worktree.ts:156-176`) đã loại `RENDERED_FILES` và `RULES_DIR`. AGENTS.md lồng và skill chỉ bị loại khi `HEAD` đã có khối Hive (`worktree.ts:159-165`), nên file mới render sẽ lọt vào commit.
- `describeBranch` (`worktree.ts:198-205`) liệt kê `git status --short` dưới *chưa commit*.

**Cần.**
- Một hàm dùng chung, ví dụ `renderContext(backend, actor, project, dir)` trong `apps/desktop/src/main/sync.ts`. Nó lấy tài liệu như `syncProject` (`docs.list` + `docs.get`, rồi `planProjectSync` của `packages/core/src/sync.ts:144` và `ensureClaudeImport`) và ghi vào `dir`: AGENTS.md chính và lồng, `CLAUDE.md` kèm `@AGENTS.md`, `.claude/rules/xdev-hive/`, `.claude/skills/<tên>/SKILL.md`. Hàm trả về danh sách file đã ghi và đã bỏ qua.
- Luật không đè: file đã có mà không chứa khối Hive (`MANAGED_START`) thì giữ nguyên, áp cho AGENTS.md chính, AGENTS.md lồng và skill. Khi AGENTS.md chính của repo được giữ, phần Hive ghi vào `.xdev-hive/context/AGENTS.md`, `CLAUDE.md` import thêm file đó, và prompt nhắc đọc nó (Codex không đọc import của `CLAUDE.md`). 38f và 38c dùng lại đúng luật này.
- Runner gọi hàm này sau `ensureWorktree` cho mọi vai: implement, review, sửa CI (`runner/runner.ts:1285`) và giám khảo best-of-n (`runner.ts:1759`). Log run ghi một dòng `# hive context: n file, bỏ qua m`. Hub lỗi hay quá 30 giây thì run vẫn chạy với file của nhánh, và log ghi lý do.
- Không commit: các file hàm đã ghi vào `exclude` của `commitAll` (giống `wt.copied`). `describeBranch` không liệt kê chúng dưới *chưa commit*.
- [Unverified] Run Claude chạy `--setting-sources user` (`command.ts:319`). Phải đo với Claude Code thật xem skill trong `.claude/skills` và rules trong `.claude/rules` của worktree có được nạp không. Nếu không, chọn cách khác để agent đọc được (ví dụ liệt kê đường dẫn skill trong prompt) và ghi kết quả đo vào ghi chú bàn giao.

**Xong khi.** Có test runner trên repo mà nhánh đích không có AGENTS.md. Sau run:
- worktree có AGENTS.md mới nhất từ hub;
- branch `ai/<task>` không chứa AGENTS.md, skill, rules hay `CLAUDE.md` do Hive render;
- tóm tắt run không ghi các file đó là *chưa commit*.

Có thêm test: repo có AGENTS.md riêng không có khối Hive thì file đó giữ nguyên.

## R-38b. MCP `xdev-hive` chạy được trong Claude Code trên mọi máy

**Hiện trạng.**
- `installShim` chỉ báo `onPath`, không thêm thư mục vào PATH (`apps/desktop/src/main/installer.ts:281-287`).
- Trên `win-runner`, shim `%USERPROFILE%\.xdev-hive\bin\hive-mcp.cmd` gọi qua `cmd /c` thì chạy (hub mode, 23 tool). Nhưng Claude Code báo `xdev-hive` và `codegraph` (npx) là "Connection closed".
- Trên Mac mini ngày 3/10, phiên Claude Desktop (tab Code) cũng báo `Executable not found in $PATH: hive-mcp`, dù `~/.local/bin/hive-mcp` có sẵn và shell login có thư mục đó trong PATH. Ứng dụng GUI không nhận PATH của shell, nên dạng `"command": "hive-mcp"` trong `.mcp.json` hỏng cả trên macOS.

**Cần.**
1. Windows: nút *Thêm vào PATH* ở mục shim của *Cài đặt máy*. Nút ghi `HKCU\Environment\Path` (không cần quyền admin), giữ kiểu `REG_EXPAND_SZ` và các phần `%…%` có sẵn, không thêm trùng, rồi phát `WM_SETTINGCHANGE` ("Environment"). Phần đọc/ghi registry tách sau một interface để test bằng bản giả.
2. Chọn dạng cấu hình chạy được trên macOS, Linux và Windows, kể cả khi Claude Code mở từ GUI. Hướng nghiêng về: bỏ `xdev-hive` khỏi `.mcp.json` dùng chung, ghi vào scope local của Claude Code (cách `claude mcp add --scope local` ghi) với đường dẫn tuyệt đối của shim. Trên Windows dùng `cmd /c <shim>.cmd`. [Unverified] Theo tài liệu Claude Code, trên Windows (không WSL) server MCP chạy bằng `npx` phải bọc trong `cmd /c`. Cấu hình agent đã cài (installer) chuyển sang dạng mới, và lần cài lại gỡ mục `xdev-hive` cũ khỏi `.mcp.json`. Run của runner không đổi, vì nó tự sinh `--mcp-config`.
3. Codegraph (npx): xử lý cùng cách trên Windows.
4. MR có hướng dẫn đo cho chủ máy Windows: các bước, lệnh, và kết quả mong đợi ở `/mcp`.

**Xong khi.**
- Có test cho phần sửa PATH (registry giả: thêm, không trùng, giữ `%…%`) và cho cấu hình sinh ra theo từng hệ điều hành.
- Trên Mac mini, phiên Claude Desktop mở trong repo đã cài lại *Cấu hình agent* có `xdev-hive` ở trạng thái kết nối. Người merge kiểm bước này.
- Trên `win-runner`, chủ máy chạy theo hướng dẫn trong MR thì `/mcp` báo `xdev-hive` đã kết nối.

## R-38c. Đồng bộ tài liệu qua MR thay vì commit vào checkout chính

**Hiện trạng.** `syncProject` commit `docs(xdev-hive): sync shared docs` lên nhánh đang checkout, kể cả nhánh feature đang có file bẩn (`apps/desktop/src/main/sync.ts:160-172`). Run đọc context từ nhánh đích nên commit này không giúp run. Người dùng phải làm tay: worktree từ `origin/dev`, nhánh `chore/xdev-hive-context`, push, MR (svc-core !53, svc-portal !693, admin-portal-v2 !394).

**Cần.**
- Chế độ đồng bộ `mr`, mặc định cho dự án có `targetBranch` hoặc remote GitLab/GitHub (`forgeOf`, `gitlab/mr.ts:52`). Dự án không có remote vẫn dùng chế độ commit như cũ.
- Các bước:
  1. fetch `origin/<targetBranch>` (không có thì nhánh mặc định của remote);
  2. worktree riêng, ví dụ `<worktreeRoot>/<dự án>/_hive-context`, trên nhánh `chore/xdev-hive-context` đặt lại về `origin/<đích>`;
  3. render bằng hàm của 38a (luật không đè của 38f);
  4. commit;
  5. không có gì khác `origin/<đích>` thì dừng: không push, không MR;
  6. push `--force-with-lease`;
  7. tạo hoặc cập nhật MR/PR bằng code có sẵn: `MergeRequester` (`gitlab/mr.ts:107`), `openMergeRequests` rồi `updateMergeRequest` / `createMergeRequest`, và đường GitHub tương ứng.
- Phần nhập lần đầu (AGENTS.md, `docs/decisions.md` của repo vào Hive) đọc bản trên `origin/<đích>`, không đọc checkout đang sửa dở.
- *Yêu cầu máy đồng bộ* từ hub (`docs.syncRequest`) và nút *Đồng bộ dự án* dùng cùng chế độ. Báo cáo đồng bộ có link MR.
- Chữ giao diện có vi và en. README có đoạn về chế độ này.

**Xong khi.** Có test cho thấy checkout chính giữ nguyên nhánh và file bẩn. Chạy lần hai chỉ cập nhật MR cũ (không MR mới). Không có thay đổi thì không push, không MR.

## R-38d. Thêm dự án: chặn thư mục không phải git, gợi ý tách repo con

**Hiện trạng.** `addProject` chỉ kiểm thư mục tồn tại (`apps/desktop/src/main/index.ts:305-311`). `D:\src\customer-ai` (không phải git, chứa 8 repo) được nhận. Sau đó:
- runner báo `errors.notGitRepo` (`runner/runner.ts:521`, `worktree.ts:98`);
- sync ghi file mà không commit;
- trang Spec trống.

**Cần.**
- Thư mục không phải git thì báo ngay, không thêm.
- Hàm dùng chung `findGitRepos(root, maxDepth = 3)`: bỏ qua `node_modules`, thư mục ẩn, và không đi vào bên trong một repo đã tìm thấy.
- Nếu bên trong có repo git thì đề nghị thêm từng repo:
  - key là tên thư mục repo (hợp lệ theo `PROJECT_NAME`, không trùng);
  - `targetBranch` lấy từ `git symbolic-ref refs/remotes/origin/HEAD`;
  - bỏ chọn được từng repo;
  - rồi gom vào một hệ thống (`systems.save`), tên mặc định là tên thư mục gốc.
- Chữ giao diện có vi và en. Đổi giao diện desktop nên chạy smoke.

**Xong khi.** Có test cho `findGitRepos` (lồng 3 cấp, repo trong repo, `node_modules`) và cho phần thêm nhiều dự án. Smoke chụp bước đề nghị.

## R-38e. Nhập group GitLab: dùng lại clone có sẵn ở cấu trúc lồng

**Hiện trạng.** `apps/desktop/src/main/gitlab/import.ts:26-29` chỉ nhìn `<thư mục gốc>/<tên repo>`. Bố cục `his/backend/svc-core` sẽ bị clone thêm bản thứ hai. Thư mục trùng tên được dùng lại (`state: "folder"`) mà không kiểm remote có đúng project không.

**Cần.**
- Quét thư mục gốc bằng `findGitRepos` của 38d.
- Repo có remote trỏ đúng GitLab project thì dùng lại. So bằng `parseRemoteUrl` theo host và `path_with_namespace`, không phân biệt hoa thường.
- Thư mục trùng tên mà remote khác thì báo xung đột và không dùng: không clone đè, không thêm.
- Chữ giao diện có vi và en.

**Xong khi.** Có test với bố cục lồng 3 cấp: dùng lại đúng repo, không clone lần hai. Thư mục trùng tên khác remote thì thành *xung đột*.

## R-38f. Đồng bộ không ghi đè AGENTS.md riêng của repo

**Hiện trạng.** Lần đồng bộ đầu nhập AGENTS.md của repo chỉ khi hub chưa có `project/<dự án>/agents`. Nếu trang đó đã có, AGENTS.md của repo bị ghi đè cả file, vì chỉ bỏ qua khi `!hasAgentsDoc` (`sync.ts:125`). admin-portal đang đúng tình huống này: AGENTS.md của repo dài 309 dòng và không có khối Hive.

**Cần.**
- Dùng luật của 38a cho `syncProject`. File không có khối Hive mà nội dung khác trang trên hub thì không ghi đè. Báo cáo ghi *bỏ qua* kèm lý do.
- Có nút hoặc thao tác *Đề xuất nhập vào Hive*: gửi nội dung AGENTS.md của repo thành đề xuất (`docs.propose`, `baseVersion` của trang hiện tại) cho người có quyền Context agent duyệt.
- Chữ giao diện có vi và en.

**Xong khi.** Có test: repo có AGENTS.md riêng, hub đã có trang `agents` khác nội dung, thì sau đồng bộ file giữ nguyên và báo cáo có *bỏ qua*. Đề xuất nhập tạo đúng một đề xuất.

## R-38g. Xoá và chuyển tài liệu, cho một project key nghỉ

**Hiện trạng.**
- Chưa có `docs.remove` trong `packages/core/src/methods.ts`, chỉ có `docs.assetRemove`.
- `docs.move` chỉ đổi trang cha trong cùng một space (`methods.ts:236`).
- Hub có 141 trang `project/customer/*` mà 8 repo của hệ thống `customer-ai` không đọc được. Trang `project/customer-ai/agents` thì mồ côi.

**Cần.**
- `docs.remove({ key, note? })`:
  - xoá mềm (migration), quyền như khi sửa trang đó (Context agent với tài liệu agent đọc), ghi nhật ký;
  - trang biến mất khỏi danh sách, AGENTS.md và các lần đồng bộ sau (file đã render bị gỡ như khi trang đổi đường dẫn);
  - vẫn xem được trong lịch sử, khôi phục được;
  - trang mang dấu `mirror` thì từ chối và nhắc xoá ở repo.
- Chuyển trang sang space khác: `docs.move` nhận khoá mới, ví dụ `project/customer/x` → `system/customer-ai/x`. Lịch sử và trang con đi theo, khoá cũ trỏ sang khoá mới để link cũ không gãy, và có một thao tác chuyển cả cây.
- Cho một project key nghỉ (admin hub, ghi nhật ký, đảo lại được): key không còn máy nào khai, không còn trang hay task mở thì ẩn khỏi ô phạm vi (`ProjectPicker` của 36a) và các danh sách chọn dự án.
- Giao diện ở trang Tài liệu và Quản trị. Chữ có vi và en.

**Xong khi.** Có test core cho xoá mềm, khôi phục, chuyển space giữ lịch sử, và key nghỉ biến khỏi danh sách. e2e web có bước xoá và chuyển một trang.

**Sau khi merge và deploy**, người merge làm phần dữ liệu:
1. chuyển cây `project/customer/*` (141 trang) sang `system/customer-ai/*`;
2. so trang `project/customer-ai/agents` với AGENTS.md của các repo, chuyển phần còn dùng được, rồi xoá trang;
3. cho key `customer` và `customer-ai` nghỉ.

## R-38h. Repo tham chiếu cho run

**Hiện trạng.** Task của svc-core và admin-portal-v2 cần đọc `svc-core-old` (SQLMaps, ViewModel). Run Claude chỉ có `--add-dir <worktree>` (`runner/command.ts:314`).

**Cần.**
- Ô *Repo tham chiếu* trong cài đặt dự án: chọn dự án cùng hệ thống mà máy này có repo.
- Claude: thêm `--add-dir <checkout chính của dự án đó>` cho mỗi repo, và chặn ghi vào đó bằng quy tắc deny trong `--settings` của run. [Unverified] Cú pháp quy tắc phải thử với Claude Code thật.
- Codex: [Unverified] sandbox `workspace-write` có thể đã cho đọc ngoài worktree. Đo, rồi chọn cách không cấp quyền ghi.
- Run trong container: gắn chỉ đọc (`:ro`).
- Prompt ghi đường dẫn, nhánh và commit của từng repo tham chiếu, kèm câu nhắc đó là repo chỉ đọc.
- Chữ giao diện có vi và en.

**Xong khi.** Có test cho args của Claude, Codex và container, và cho prompt. Ghi chú bàn giao có kết quả đo quyền ghi.
