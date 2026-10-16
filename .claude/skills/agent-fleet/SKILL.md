---
name: agent-fleet
description: Chạy nhiều agent Claude Code / Antigravity song song trên máy dev để code xDev Hive, mỗi agent một worktree, chia model và effort theo độ khó, chia tài khoản theo quota phiên 5 giờ và tuần, tự chuyển tài khoản khi sắp cạn. Dùng khi người dùng bảo "chia nhiều agent", "dùng claude-N để code tiếp", "tăng tốc", hoặc có nhiều việc độc lập cần làm cùng lúc.
---

# Đội agent song song

Phiên chính là **người điều phối**: chia việc, viết đề bài, theo dõi, xem lại code, chạy test, mở PR. Agent chỉ code và
commit tại máy. Không chạy agent bằng tài khoản của chính phiên điều phối, cũng không dùng tài khoản người dùng nói
đang dùng cho việc khác.

## 1. Đo quota trước khi chia

```sh
AGENT_ALL_ACCOUNTS="claude-4 claude-5 claude-7" .claude/skills/agent-fleet/scripts/quota.sh
# tên|phiên 5h đã dùng %|reset phiên|tuần đã dùng %|reset tuần
```

- Mỗi tài khoản là một thư mục `~/.xdev-hive/accounts/<id>` (`CLAUDE_CONFIG_DIR`). `/usage` của Claude Code in "Current
  session" và "Current week (all models)".
- Antigravity: `agy -p /usage --output-format json`. Hạn mức cá nhân có thể đã hết dù bảng còn phần trăm. Câu báo là
  "Individual quota reached … Resets in 46h". Thử một lệnh ngắn trước khi giao việc dài.
- Bỏ qua tài khoản đã dùng từ 95% tuần trở lên.

## 2. Chia model và effort theo việc

| Mức | Ví dụ | Claude Code | Antigravity |
|---|---|---|---|
| Nặng | nhiều module, giao thức worker, engine runs của hub, hiệu năng (phải đo), bảo mật, migration | `--model claude-opus-5-5 --effort high` (`xhigh` cho đồng thời, khoá) | `claude-opus-5-5-high` |
| Vừa | một màn UI có logic, CRUD + Playwright, refactor gọn trong một app | `--model claude-sonnet-5-5 --effort high` | `claude-sonnet-5-5-high` |
| Nhẹ | đổi chữ, tài liệu, đánh dấu task, báo cáo chỉ đọc code | `--model claude-sonnet-5-5 --effort medium` | `claude-sonnet-5-5-medium` |

- Việc tra cứu thuần (tìm file, tóm tắt code) dùng subagent Explore của phiên điều phối, không mở agent riêng.
- Ước tính tốn quota: agent Opus ăn khoảng 11% phiên mỗi giờ, Sonnet khoảng một nửa. Số này còn thô; đo lại bằng `scripts/quota.sh`
  sau 30–60 phút rồi đặt `AGENT_BURN`.

## 3. Chia việc

- **Một việc, một worktree, một nhánh:** `git worktree add -b ai/<VIỆC> ../xdev-hive-wt/<VIỆC> origin/main`.
- **Không cho hai agent sửa cùng một file.** Ghi rõ trong đề bài file nào agent khác đang sửa (vd. "KHÔNG sửa
  home-page.tsx"). Hai việc chạm cùng một màn thì gộp lại, hoặc cho chạy nối tiếp.
- **Việc dùng chung giao diện** (worker ↔ app, hub ↔ web): viết hợp đồng JSON hoặc API trước, đưa cho cả hai agent.
- **Chặn push ở từng worktree:**
  ```sh
  git config extensions.worktreeConfig true
  git -C <wt> config --worktree remote.origin.pushurl no-push://agent
  ```
  Bỏ chặn (`git config --worktree --unset remote.origin.pushurl`) khi chính người điều phối push.
- **Đề bài** (`$FLEET_DIR/agents/<VIỆC>.md`) gồm: bối cảnh, việc cần làm, file không được sửa, lệnh test, và đường dẫn
  `SUMMARY-<VIỆC>.md` để agent ghi tóm tắt. `scripts/common.md` (quy tắc chung), `scripts/perf-common.md` (đo trước và
  sau) được ghép vào tự động; việc có giao diện thì dẫn agent tới `scripts/ui-rules.md` trong đề bài.

## 4. Cách chạy

Mọi script nằm ở `scripts/` (zsh và python3, chỉ dùng công cụ có sẵn trên macOS cộng `gh`, `claude`, tuỳ chọn `codex`,
`agy`). Biến môi trường, đều có mặc định:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `FLEET_DIR` | `$HOME/.xdev-hive/fleet` | Thư mục chạy, tự tạo. Trạng thái chung (`mq-first.txt`, `mq-skip.txt`, `autopush.hold`, `*.log`) nằm ở đây; việc nằm ở `$FLEET_DIR/agents`: `jobs.json`, `supervisor.log`, `status.txt`, đề bài `<VIỆC>.md`, `log-<VIỆC>-<vòng>.jsonl`, `done-<VIỆC>` |
| `FLEET_REPO` | checkout chính của repo chứa script | Nơi `git fetch` và `git worktree add` |
| `FLEET_WT` | `<FLEET_REPO>/../xdev-hive-wt` | Thư mục chứa worktree từng việc (`$FLEET_WT/<VIỆC>`, nhánh `ai/<VIỆC>`) |
| `FLEET_GH_REPO` | `gh repo view --json nameWithOwner` | `owner/repo` cho `gh` |
| `AGENT_ACCOUNTS` | mọi `claude-N`/`codex-N` trong `~/.xdev-hive/accounts` | Tài khoản nhận việc, cách nhau dấu phẩy hoặc khoảng trắng |
| `AGENT_RETIRED` | rỗng | Tài khoản phải rút agent ra (người dùng cần dùng) |
| `AGENT_MAX` | 6 | Số agent chạy cùng lúc |
| `AGENT_INTERVAL` | 600 | Giây giữa hai chu kỳ của supervisor |
| `AGENT_BURN`, `AGENT_BURN_CODEX` | 11, 12 | % phiên mỗi agent mỗi giờ (ước tính) |

```sh
export FLEET_DIR=$HOME/.xdev-hive/fleet AGENT_ACCOUNTS=claude-4,claude-5,claude-7
F=.claude/skills/agent-fleet/scripts

# 1. Xếp việc: tạo worktree + đề bài, rồi thêm vào jobs.json (tier = heavy|medium|light)
git worktree add -b ai/B $FLEET_WT/B origin/main
git -C $FLEET_WT/B config --worktree remote.origin.pushurl no-push://agent   # sau khi bật extensions.worktreeConfig
$EDITOR $FLEET_DIR/agents/B.md
python3 $F/add-job.py B $FLEET_WT/B claude-sonnet-5-5 medium

# 2. Supervisor: đo quota, giao việc, chuyển tài khoản khi cạn (--once để chạy đúng một chu kỳ)
nohup python3 $F/supervisor.py > $FLEET_DIR/supervisor.out 2>&1 &
cat $FLEET_DIR/agents/status.txt; tail $FLEET_DIR/agents/supervisor.log

# 3. Hàng merge (mỗi lần một PR: cập nhật với main, đợi CI xanh trên đúng bản đó, merge) và tự đẩy việc đã xong
nohup $F/merge-queue.sh > $FLEET_DIR/merge-queue.out 2>&1 &
nohup $F/autopush.sh > $FLEET_DIR/autopush.out 2>&1 &
```

Tệp trạng thái trong `$FLEET_DIR` (mỗi dòng một giá trị, sửa tay được khi daemon đang chạy):
- `mq-first.txt`: số PR ưu tiên merge trước.
- `mq-skip.txt`: số PR hàng merge bỏ qua. Hàng merge tự thêm PR xung đột hoặc CI đỏ; xoá dòng khi đã sửa xong.
- `autopush.hold`: tên việc `autopush.sh` không đẩy (cần người điều phối soát tay trước). `autopush.done` ghi việc và
  commit đã đẩy; `autopush.log` ghi kết quả.
- `seen-fail.txt`, `rerun.txt` (`ci-watch.sh`), `mq-rerun.txt` (hàng merge): ghi PR đã báo lỗi hoặc đã chạy lại, để khỏi xử lý lặp.

Script khác:
- `launch-auto.sh <VIỆC> <worktree> <tài khoản,…> <perf 0|1>`: supervisor gọi; chạy một việc, hết lượt thì sang tài
  khoản kế cùng worktree. Dùng `nice -n 10`, `CARGO_TARGET_DIR` chung, chặn `git push`, `gh`, `rm -rf`, `sudo`
  (Claude bằng `--disallowedTools`, Codex bằng `scripts/shims/`). `launch-claude.sh`, `launch.sh` là bản chạy tay một tài khoản.
- `after-done-job.sh`, `after-merge-job.sh`, `after-merges-job.sh`: xếp việc nối tiếp khi việc trước xong hoặc PR
  trước đã merge.
- `ci-watch.sh`: chạy lại lỗi flaky đã biết (`KNOWN`), in `FAILED: <PR>` với lỗi lạ. `cleanup-merged.sh`: dọn worktree
  và nhánh của PR đã merge. `push-nv.sh <wt> <tiêu đề> <nội dung>`: push không hook và mở PR.

`supervisor.py` chạy 10 phút một lần và làm bốn việc:
- **Đo quota** từng tài khoản. Tính số agent tài khoản chịu được tới lúc reset phiên, chừa 8% an toàn, có tính trọng số
  theo model.
- **Dời agent** khỏi tài khoản quá sức sang tài khoản còn dư. Nếu không còn tài khoản nào rảnh thì để chạy tiếp và ghi log.
  Agent nằm trên tài khoản đã loại (`AGENT_RETIRED`) thì dừng và đưa về hàng chờ.
- **Khởi động việc trong hàng** khi có tài khoản rảnh và đang chạy dưới `AGENT_MAX`.
- **Bật `RESUME=1`** khi worktree đã có commit hoặc file đổi. Khi đó đề bài có thêm lời nhắc đọc `git status`, `git diff`
  để làm tiếp phần dở.

`supervisor.py` tự thoát khi hết việc đang chạy và đang chờ; `merge-queue.sh` và `ci-watch.sh` thoát sau khi in
`FAILED: <PR>`; `autopush.sh` chạy mãi. Chạy lại bằng cùng lệnh, trạng thái nằm trong `$FLEET_DIR`.

### Làm việc từ máy khác qua SSH + tmux

Chạy phiên điều phối và daemon trên Mac dev, nối vào từ máy khác bằng một phiên tmux dùng chung:

```sh
ssh -t <user>@<mac> "/opt/homebrew/bin/tmux new -A -s hive"
```

(`<user>@<mac>` là tài khoản và địa chỉ của Mac dev; `new -A` nối lại phiên `hive` nếu đã có.) Trong phiên đó mở
nhiều cửa sổ: một cho `claude` điều phối, một cho `tail -f` log, daemon chạy nền.

- Mac phải không ngủ khi chạy việc dài: chạy `caffeinate -dimsu &` trong phiên tmux (hoặc đặt trong System Settings
  mục Energy: không cho máy ngủ tự động khi tắt màn hình).
- Muốn daemon sống khi đóng phiên SSH và qua khởi động lại: chạy bằng `nohup` (như trên, thoát khi Mac khởi động lại)
  hoặc đăng ký launchd. Ví dụ `~/Library/LaunchAgents/dev.xdev.fleet-supervisor.plist` với `ProgramArguments` =
  `python3 <repo>/.claude/skills/agent-fleet/scripts/supervisor.py`, `EnvironmentVariables` chứa `FLEET_DIR`,
  `AGENT_ACCOUNTS` và `PATH` có `/opt/homebrew/bin`, `KeepAlive` = `true`; nạp bằng
  `launchctl bootstrap gui/$(id -u) <plist>`. launchd không đọc `~/.zshrc`, nên đặt đủ `PATH`, `HOME`.
- Máy chủ điều phối cần đăng nhập `gh` (`gh auth status`) và có `git` với quyền push. Không đưa token vào plist hay
  vào repo.

## 5. Giới hạn của máy

- Mac mini 8 CPU / 16 GB chịu khoảng **4–6 agent** có build/test cùng lúc. Chạy 10 agent làm load lên 100–160:
  Playwright hết giờ, test giả đỏ, và tất cả chậm hơn chứ không nhanh hơn.
- Mỗi worktree desktop tự biên dịch Tauri nếu không dùng `CARGO_TARGET_DIR` chung.
- Test đỏ khi máy đang tải nặng thì chạy lại riêng file đó (`--workers=1`) trước khi kết luận là lỗi thật.

## 6. Xem lại và mở PR (người điều phối)

1. Đọc `SUMMARY-<VIỆC>.md`, `git log origin/main..HEAD`, `git diff origin/main --stat`.
2. Gộp `origin/main`, sửa xung đột. Ảnh chụp e2e bị xung đột thì chạy lại spec để chụp lại.
3. Chạy lại test liên quan. Không push khi chưa đọc kết quả test.
4. Sửa chỗ agent làm lệch quy ước, ví dụ chữ tiếng Việt dùng font mono hay cỡ chữ `text-[10.5px]`.
5. Bỏ chặn push, push, `gh pr create` (body kết thúc bằng dòng Generated with Claude Code), rồi `gh pr merge --auto --merge`.
6. Hai agent làm trùng nhau: dừng agent sau ngay để khỏi tốn quota, giữ phần không trùng, chạy lại với phạm vi mới.

## Bài học (2026-10-13)

- Log `stream-json` không chứa đề bài. Muốn kiểm agent nhận gì thì xem biến môi trường của tiến trình
  (`ps eww -o command= -p <pid>`).
- Đừng nhận diện "hết quota" bằng grep cả log: agent đọc code về rate limit cũng có chữ đó. Chỉ xét vài dòng kết quả cuối.
- Test Go chạy trên Windows trong CI cần lưu ý: `filepath.Join` cho đường dẫn mong đợi; không kiểm quyền file 0600;
  đường dẫn nhúng vào JSON phải escape bằng `json.Marshal`.
