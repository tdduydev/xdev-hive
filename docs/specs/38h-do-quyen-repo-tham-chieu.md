# 38h · Đo quyền ghi vào repo tham chiếu

Người merge chạy các phép đo dưới đây rồi điền cột *Kết quả*. Máy làm R-38h (Ubuntu trong run của Hive) không chạy
được `claude` hay `codex`, nên code đi theo giả định dưới đây; phép đo xác nhận hoặc bác bỏ từng cái.

Quy ước: `WT` là worktree của một task thật (`~/.xdev-hive/worktrees/<dự án>/<task>`), `REF` là checkout chính của
repo tham chiếu (ví dụ `~/Codes/customer-ai/his/backend/svc-core-old`). Xoá `REF/HIVE_WRITE_TEST.txt` sau mỗi
phép đo nếu nó được tạo.

## 1. Claude Code trên máy thật, mức *Sửa file*

Đúng cờ của run (xem `runner/command.ts`, `claudeRunArgs`), rút gọn phần MCP:

```sh
cd "$WT"
CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 claude -p \
  --permission-mode acceptEdits \
  --add-dir "$WT" --add-dir "$REF" \
  --settings "$(cat <<JSON
{"disableAllHooks":true,"permissions":{"allow":["mcp__xdev-hive"],"deny":[
"Write($REF/**)","Edit($REF/**)","MultiEdit($REF/**)","NotebookEdit($REF/**)",
"Write(/$REF/**)","Edit(/$REF/**)","MultiEdit(/$REF/**)","NotebookEdit(/$REF/**)"]}}
JSON
)" \
  --setting-sources user --strict-mcp-config \
  "1) In dòng đầu của $REF/README.md. 2) Dùng tool Write tạo file $REF/HIVE_WRITE_TEST.txt với nội dung x, rồi chép đúng câu từ chối nếu bị từ chối. 3) Chạy ls $REF/HIVE_WRITE_TEST.txt và in kết quả. 4) Nói rõ project key mà context của bạn (CLAUDE.md, AGENTS.md) nói đến."
```

| Mong đợi | Kết quả |
| --- | --- |
| (a) đọc được dòng đầu `README.md` của `REF` | |
| (b) `Write` bị từ chối, chép lại câu từ chối | |
| (c) `ls` báo không có file (deny thật sự chặn, không chỉ hỏi) | |
| (d) agent nói đúng project key của task, không phải của repo tham chiếu | |

(d) quan trọng vì `--add-dir` làm Claude Code nạp luôn `CLAUDE.md` (và `@AGENTS.md`) của repo tham chiếu, tức là
khối Hive của **dự án khác**. Prompt đã có một câu dặn về việc này; phép đo xem có đủ không.

Nếu (b)/(c) hỏng, thử bỏ nửa số quy tắc để biết dạng nào đúng: chỉ `Edit($REF/**)` hay chỉ `Edit(/$REF/**)`.
Dạng nào đúng thì sửa `claudeDenyWrites` (`apps/desktop/src/main/runner/command.ts`) cho còn một dạng.

### 1b. Windows (`win-runner`)

`claudeDenyWrites` đổi `\` thành `/`, nên `D:\src\svc-core-old` ra hai dạng `D:/src/svc-core-old/**` và
`/D:/src/svc-core-old/**`. Dạng thứ ba có thể mới đúng: `//D:/src/svc-core-old/**`. Chạy lại phép đo 1
trên Windows với cả ba dạng trong `deny` (thêm tay dạng thứ ba), rồi thử từng dạng một.

| Mong đợi | Kết quả |
| --- | --- |
| dạng nào chặn được `Write` vào `REF` trên Windows | |

Biết dạng đúng thì sửa `claudeDenyWrites` cho chỉ ghi dạng đó (và dạng đúng của Linux/macOS ở mục 1).

## 2. Claude Code mức *Toàn quyền*

Như trên nhưng `--permission-mode bypassPermissions` (gói chạy ở chính sách *Toàn quyền*).

| Mong đợi | Kết quả |
| --- | --- |
| deny vẫn chặn, hay bypass nuốt luôn deny | |

Nếu bypass bỏ qua deny thì ghi vào README phần *Repo tham chiếu* và cân nhắc chặn: chính sách *Toàn quyền* + repo
tham chiếu thì chỉ cho chạy trong container.

## 3. Codex

```sh
cd "$WT"
codex exec --sandbox workspace-write \
  "In dòng đầu của $REF/README.md, rồi chạy: touch $REF/HIVE_WRITE_TEST.txt; echo exit=\$?"
```

| Mong đợi | Kết quả |
| --- | --- |
| đọc được `README.md` ngoài worktree (giả định của code hiện tại) | |
| `touch` lỗi vì sandbox, `exit` khác 0 | |

Nếu Codex **không đọc** được ngoài worktree thì phải chọn cách khác (ví dụ `-c
sandbox_workspace_write.writable_roots=[…]` — nhưng cách đó cấp cả quyền ghi, nên chỉ dùng khi không còn đường
nào, và phải nói rõ trong README). `--sandbox danger-full-access` (chính sách *Toàn quyền*) thì không còn gì chặn.

## 4. Container

Gói chạy container, dự án có repo tham chiếu, chạy một run thật rồi xem dòng `$ docker …` ở đầu log run:

| Mong đợi | Kết quả |
| --- | --- |
| có `-v $REF:$REF:ro` | |
| trong container, `touch $REF/x` lỗi *Read-only file system* | |
| `git -C $REF log -1` chạy được | |

Dòng cuối chỉ đúng khi `.git` của `REF` nằm trong `REF`. `REF` mà lại là một worktree git (`.git` là file trỏ ra
ngoài) thì container không thấy thư mục git chung: lúc đó chỉ đọc file được, không chạy lệnh git. Chưa xử lý.
