# 28d. RTK: nén output lệnh Bash bằng hook của danh mục

RTK (rtk-ai/rtk) là CLI đổi lệnh Bash của agent thành bản in gọn. Ví dụ `git status` thành `rtk git status`, và test chỉ in phần lỗi. Mục đích là agent đọc ít token hơn. 28d gồm hai phần:
- cho run Claude dùng **hook của danh mục** (`kind: "hook"`), phần mà 28b để lại;
- thêm RTK làm mục hook đầu tiên, rồi **đo** trước khi bật mặc định.

R-28d làm sau R-28b-1 (đã lên main ở 0.107.0) và R-28b-2.

Ngoài phạm vi:
- Codex: `rtk hook codex` dùng `.codex/hooks.json`. Chưa kiểm `codex exec` headless có chạy hook không, và file trong `.codex/` của worktree đụng sửa lỗi *agent-cli-config*.
- Gemini, run trong container, chat leader, trợ lý tài liệu, đăng nhập: giữ `disableAllHooks` như hôm nay.
- Windows: RTK có bản Windows, nhưng chưa ai thử hook trên Windows.

## Đã kiểm ngày 2/10

### Claude Code 2.1.283

Cách thử: `claude -p` với model haiku trong một repo tạm. Hook PreToolUse trên Bash ghi một file đánh dấu. Repo tạm có `.claude/settings.json` với hook riêng của nó (nguồn *project*).

| # | Thử | Kết quả |
|---|---|---|
| T1 | `--settings` có `disableAllHooks: true` và có hook | Hook của chính `--settings` **không** chạy |
| T2 | `--settings` có hook, `--setting-sources user` | Hook của `--settings` chạy; hook của project không chạy (vì không nạp nguồn project) |
| T3 | `--settings` có hook, `--setting-sources project` | Cả hai hook đều chạy: hook của các nguồn **gộp lại**, không nguồn nào thay nguồn nào |
| T4 | `--setting-sources ''` (rỗng) | Claude Code nhận giá trị rỗng, vẫn đăng nhập được; chỉ hook của `--settings` chạy |
| T5 | Hook trả `hookSpecificOutput.updatedInput` | Lệnh bị thay chạy được ở chế độ `-p` |
| T6 | `allowManagedHooksOnly: true` đặt trong `--settings` | Không có tác dụng: cả hai hook đều chạy. Tài liệu ghi khoá này chỉ dùng trong managed settings |
| T7 | `--allowedTools "Bash(echo:*)"`, hook đổi `echo …` thành `printf …` | `printf` vẫn chạy, có hay không `permissionDecision`: quyền được xét trên lệnh **gốc** |
| T8 | `--setting-sources ''`, `--add-dir` một thư mục có CLAUDE.md, `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` | CLAUDE.md vẫn được nạp, như với `user` |

Từ đó:
- Không thể giữ `disableAllHooks` mà vẫn chạy hook của danh mục (T1).
- Bỏ `disableAllHooks` mà giữ `--setting-sources user` thì hook trong `~/.claude/settings.json` của người dùng máy cũng chạy trong run (T2, T3). Hook trong worktree (agent sửa được) thì không chạy, vì nguồn project không được nạp.
- Cách dùng: `--setting-sources ''` cộng hook đặt trong `--settings` (T4, T8). Run mất những gì nó đang lấy từ cài đặt người dùng, nên app chép lại vài khoá an toàn (mục *Run Claude có hook* bên dưới).
- [Suy ra, chưa kiểm] Với `''`, hook trong cài đặt người dùng không chạy. Máy thử không có hook người dùng nào, và không sửa file của người dùng để thử. Kiểm khi merge bằng tài khoản 24b: thêm hook vào `settings.json` trong `CLAUDE_CONFIG_DIR` của tài khoản đó.
- [Chưa kiểm] Hook của plugin. Superpowers có hook `SessionStart` (`hooks/hooks.json`, v6.4.2), hôm nay bị `disableAllHooks` tắt. Bật hook thì nhiều khả năng hook này chạy trong run có superpowers. Máy thử không cài superpowers.

### Tài liệu Claude Code (đọc 5/10, trang Hooks; chưa chạy thật)

Lần kiểm 5/10 không chạy được `claude` hay cài RTK (máy agent cần duyệt từng lệnh). Đây là những gì tài liệu ghi, chưa phải kết quả chạy:
- `timeout` của hook `command`: tính bằng giây, mặc định 600 (30 với `UserPromptSubmit`). Vậy `timeout: 10` là trường có thật. Vẫn cần kiểm khi merge là Claude Code nhận nó trong `--settings`.
- Hook của plugin: "When a plugin is enabled, its hooks merge with your user and project hooks." Vậy run có superpowers mà bỏ `disableAllHooks` thì hook `SessionStart` của nó nhiều khả năng chạy. Kiểm khi merge.
- Ngoài file settings và plugin, hook còn đến từ **frontmatter của skill** (chạy từ lúc skill được gọi đến hết phiên) và **frontmatter của subagent** (khi subagent đó chạy). [Suy ra, chưa kiểm] Với `--setting-sources ''`, skill và subagent trong `~/.claude` và trong worktree không được nạp (memory 369: với `user` đã không nạp skill của worktree). Kiểm khi merge: một skill có hook trong `.claude/skills` của worktree và một trong `CLAUDE_CONFIG_DIR/skills`, hook không được chạy.
- `disableAllHooks` không tắt được hook của managed settings. Máy có managed settings với hook thì hook đó chạy trong mọi run, có hay không 28d.

### RTK v0.50.0 (tag ngày 24/9, commit `1d87b8e`, đọc mã nguồn, chưa cài)

- **Giấy phép, cài đặt**:
  - Apache-2.0.
  - Có `brew install rtk` (homebrew-core, có bottle), tap `rtk-ai/tap/rtk`, và bản dựng sẵn cho macOS, Linux, Windows.
  - Crate `rtk` trên crates.io là dự án **khác**, không cài bằng `cargo install rtk`.
- **Hook cho Claude**: lệnh `rtk hook claude`, không cần file script.
  - `rtk init -g` ghi vào `~/.claude/settings.json` mục `{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook claude"}]}`. Run của Hive không dùng `rtk init`.
  - Hook đọc JSON PreToolUse từ stdin. Khi đổi lệnh, nó trả `updatedInput` giữ các trường khác của `tool_input`.
  - Hook chỉ thêm `permissionDecision: "allow"` khi có luật allow khớp. Luật được đọc từ `.claude/settings.json` và `settings.local.json` của project (tìm từ thư mục hiện tại đi lên) và của home.
- **Lệnh nào bị đổi**:
  - Khoảng 95 lệnh: git, gh, cargo, npm/pnpm/npx, vitest/jest, tsc, pytest, go, ls, grep/rg, docker, make…
  - Lệnh nối bằng `&&` hay `;` được đổi từng phần.
  - Lệnh không biết thì giữ nguyên.
  - Đặt `RTK_DISABLED=1` trước một lệnh thì lệnh đó không bị đổi.
- **Exit code và lỗi**:
  - Mã thoát giữ nguyên, output lỗi vẫn hiện.
  - Một số output vẫn bị cắt: test chỉ in phần lỗi, traceback pytest bị rút gọn.
  - Bản đầy đủ nằm trong `recall.db`, kèm dòng gợi ý `[full output: rtk recall <hash>]`.
- **Số liệu**:
  - `rtk gain --format json` (thêm `--all` để có theo ngày, tuần, tháng) trả `summary{total_commands,total_input,total_output,total_saved,avg_savings_pct,…}`.
  - Dữ liệu ở `RTK_DB_PATH`, mặc định `<data_local_dir>/rtk/history.db`.
  - Đây là số RTK tự ước tính, không phải token tính tiền của API.
- **Mạng**:
  - Telemetry chỉ gửi khi người dùng đồng ý (`rtk init` hỏi khi có terminal). Tắt hẳn bằng `RTK_TELEMETRY_DISABLED=1`.
  - Không thấy kiểm tra bản cập nhật.
- **Cảnh báo**: hook không có trong `~/.claude/settings.json` thì RTK in cảnh báo "No hook installed" ra stderr mỗi ngày một lần. Tắt bằng `RTK_SUPPRESS_HOOK_WARNING=1`.
- Con số "up to 90%" là README tự nhận. Chính README nói đó không phải giảm 90% hoá đơn.

## Mục `rtk` trong danh mục

Admin hub thêm mục này trên trang *Tool*, hoặc migration của 28d chèn sẵn với `enabledByDefault: false`:

```json
{
  "id": "rtk",
  "name": "RTK",
  "description": "Nén output lệnh Bash của agent (git, test, build…) để đọc ít token hơn; chỉ cho run Claude.",
  "kind": "hook",
  "package": { "registry": "brew", "name": "rtk", "version": "0.50.0" },
  "mcp": null,
  "plugin": null,
  "hooks": [{ "event": "PreToolUse", "matcher": "Bash", "command": ["rtk", "hook", "claude"] }],
  "agents": ["claude"],
  "check": ["rtk", "--version"],
  "install": ["brew", "install", "{package}"],
  "prepare": null,
  "env": { "RTK_TELEMETRY_DISABLED": "1", "RTK_SUPPRESS_HOOK_WARNING": "1", "RTK_DB_PATH": "{runDir}/rtk.db" },
  "secretEnv": [],
  "license": "Apache-2.0",
  "homepage": "https://github.com/rtk-ai/rtk",
  "handler": null,
  "enabledByDefault": false
}
```

- **Phiên bản**: `brew install` cài bản mà homebrew-core đang có, không chọn được phiên bản. Vì vậy với mục `kind: "hook"` có `package`, máy so phiên bản:
  - `check` in ra một phiên bản (`rtk 0.50.0`) khác `package.version` (bỏ chữ `v` đầu) thì mục `tool:rtk` ở trạng thái `outdated`, và run không dùng hook;
  - hook đổi lệnh của agent, nên chỉ chạy đúng bản đã được duyệt;
  - homebrew lên bản mới thì admin xem rồi nâng `version` trong danh mục; `toolHash` đổi, người dùng máy cho phép lại (28b-1).
- **Chỗ giữ chỗ mới `{runDir}`**: thư mục riêng của run, máy thay. Chỉ dùng được trong giá trị `env`, và chỉ với mục `kind: "hook"`. `toolProblem` từ chối ở chỗ khác. Mục đích: số liệu của RTK tách theo từng run.

## Run Claude có hook

`claudeRunArgs` (`apps/desktop/src/main/runner/command.ts`) lấy các mục `kind: "hook"` trong danh sách tool của run (`runTools`, 28b-1) mà `agents` có `claude`.

### Khi nào hook được bật
- Không có mục hook nào: giữ **đúng** như hôm nay (`disableAllHooks: true`, `--setting-sources user`). Test cũ phải qua nguyên vẹn.
- Chỉ bật cho run có autonomy `full` (`--permission-mode bypassPermissions`). Run khác thì bỏ hook và ghi log `# tool rtk: chỉ chạy với autonomy full`. Lý do:
  - RTK trả `permissionDecision: "allow"` khi luật allow trong `.claude/settings.json` của worktree khớp. Agent sửa được file đó, nên ở chế độ `plan` hay `acceptEdits`, hook có thể duyệt thay lệnh mà run vốn phải hỏi.
  - Với `full` thì không còn gì để duyệt.
- Phải qua đủ điều kiện của 28b-1: người dùng máy đã cho phép đúng `toolHash`, và mục `tool:rtk` đã cài, đúng phiên bản.

### Cờ dòng lệnh
1. `--setting-sources ''` thay cho `user`. Đã kiểm T4 và T8: vẫn đăng nhập được, CLAUDE.md qua `--add-dir` vẫn được nạp.
2. `--settings`:
   - không có `disableAllHooks`;
   - `hooks: { <event>: [{ matcher, hooks: [{ type: "command", command, timeout: 10 }] }] }`.
     - `command` là argv của mục, nối thành một chuỗi shell có quote đúng.
     - Phần tử đầu thay bằng đường dẫn tuyệt đối mà máy tìm được (như `resolveBin`), để PATH của shell chạy hook không quyết định chạy file nào.
     - Trường `timeout` (giây): có trong tài liệu, mặc định 600 (xem *Tài liệu Claude Code*). [Chưa kiểm] Claude Code có nhận nó trong `--settings` không. Kiểm khi merge; không nhận thì bỏ.
3. **Chép từ cài đặt người dùng** những gì run đang lấy từ đó, vì nguồn `user` không còn được nạp. Chỉ chép khoá có trong danh sách sau, đọc từ `$CLAUDE_CONFIG_DIR/settings.json` (tài khoản 24b) hoặc `~/.claude/settings.json`:
   - `permissions`: `allow` gộp với allow của run (`mcp__xdev-hive`, `mcp__<tool>`); giữ nguyên `deny` và `ask`;
   - `env`, `apiKeyHelper`, `model`.

   Không bao giờ chép `hooks`, `disableAllHooks`, `enabledPlugins` (danh mục quyết), `statusLine`, hay khoá nào khác.
   - Đọc lỗi (file hỏng) thì run vẫn chạy, không chép gì, và ghi log một dòng.
   - Đừng đổi `CLAUDE_CONFIG_DIR`: tài khoản Claude thứ hai trở đi đăng nhập bằng thư mục riêng.
4. **Env của tiến trình `claude`**: thêm `env` của mục hook, `{runDir}` đã thay. Hook và các lệnh Bash của agent đều thừa hưởng env này.

### Chỉ dẫn cho agent
Prompt của run có RTK thêm một dòng:

> Lệnh Bash chạy qua RTK in gọn. Cần output đầy đủ thì chạy lại với `RTK_DISABLED=1 <lệnh>`, hoặc `rtk recall <hash>` khi output có gợi ý đó.

[Chưa kiểm] `recall.db` có theo `RTK_DB_PATH` không.
- Không theo, mà nằm chung trên máy, thì đặt thêm `RTK_RECALL=0`. Output đầy đủ của mọi repo không nên dồn vào một chỗ.
- Khi đó agent dùng `RTK_DISABLED=1` để xem bản đầy đủ.

## Đo

- **Sau run**:
  - run đã bật RTK (kể cả run lỗi) thì chạy `rtk gain --format json` với `RTK_DB_PATH` của run;
  - lấy `summary` thành `compression: { tool: "rtk", commands, input, output, saved }` trong `runs.push`;
  - lỗi hay quá 10 giây thì để `null`.
- **Hub**:
  - `RunRecord.compression`, một cột JSON mới của `run_records` (migration lấy số kế tiếp trên main lúc merge);
  - trang *Lượt chạy* hiện một dòng "RTK: 42 lệnh, ~12k token đã bỏ (RTK ước tính)".
- **So sánh**:
  - trang *Chi phí* có bảng 30 ngày theo dự án và vai trò (implement, review), hai cột *Có RTK* / *Không RTK*;
  - mỗi cột gồm số run, token vào trung bình (mới + ghi cache + đọc cache), token ra trung bình, tỉ lệ đọc cache (28c), và chi phí trung bình.
- **Bật mặc định**: `enabledByDefault` giữ `false`. Chỉ đổi khi mỗi cột của cùng một dự án và vai trò có ít nhất 20 run, và token vào giảm rõ mà tỉ lệ run lỗi không tăng. Người quản trị quyết; ghi số liệu vào ghi chú của R-28d.
- Superpowers bật hay tắt phải giữ như nhau giữa hai cột. Hook `SessionStart` của nó cũng đổi context của run (xem *Đã kiểm*).

## Ảnh hưởng khác

- Các bước của run (22l): regex `TEST` trong `packages/ui/src/lib/runlog.ts` cho phép phần trước tên lệnh (`^Bash: .*\b(test|…)`). Vì vậy `rtk npm test` vẫn được nhận là bước *Kiểm tra*. [Chưa kiểm] log stream-json ghi lệnh gốc hay lệnh đã đổi.
- **Quyền** (T7): hook đổi được một lệnh được phép thành một lệnh bất kỳ. Vì vậy hook chỉ đến từ danh mục mà admin hub duyệt và người dùng máy cho phép (28b-1). Không có đường nào khác để đưa hook vào run.

## Test

- `packages/core/test/tools.test.ts`:
  - mục `rtk` hợp lệ;
  - `{runDir}` chỉ nhận trong `env` của mục `hook`;
  - so phiên bản (`rtk 0.50.0` khớp `0.50.0` và `v0.50.0`, `rtk 0.51.0` thì không).
- `apps/desktop/test/runner.test.ts`:
  - không có mục hook: cờ y như cũ;
  - có RTK và autonomy full:
    - `--setting-sources ''`, không có `disableAllHooks`;
    - `hooks.PreToolUse` có đường dẫn tuyệt đối và quote đúng;
    - env có `RTK_DB_PATH` trong thư mục của run;
  - chép cài đặt người dùng: chỉ các khoá trong danh sách; gộp `allow`; giữ `deny`; lấy theo `CLAUDE_CONFIG_DIR`; file hỏng thì bỏ qua;
  - autonomy khác `full`, chưa cho phép, sai phiên bản: không có hook, có dòng log;
  - `rtk gain` giả (fake bin) thì `compression` được gửi lên; lỗi thì `null`.
- Hub: `runs.push` lưu `compression`; bảng so sánh trên *Chi phí* tính đúng hai cột.
- **Kiểm thật khi merge** (ghi vào ghi chú task):
  - một run trên repo thử, máy cài RTK 0.50.0: log có lệnh `rtk …`, `compression` lên hub;
  - một hook trong `settings.json` của tài khoản 24b **không** chạy;
  - `timeout` của hook được nhận;
  - superpowers bật thì hook `SessionStart` của nó có chạy không;
  - hook trong frontmatter của một skill ở worktree và ở `CLAUDE_CONFIG_DIR/skills` **không** chạy;
  - `recall.db` nằm ở đâu.

## Ràng buộc khi làm

- Máy chạy agent (claude-1) không chạy được `npm` hay `node`: người merge chạy typecheck, test, e2e, build, smoke và phần kiểm thật ở trên.
- Không tăng `version`, không đánh dấu [x] trong `docs/roadmap.md`.
- Import khác thư mục dùng alias. Chuỗi giao diện và key lỗi trong `vi.ts` (gốc) và `en.ts`.
- Không ghi giá trị biến môi trường của người dùng (khoá `env` chép từ cài đặt) vào log, run record hay hub.
