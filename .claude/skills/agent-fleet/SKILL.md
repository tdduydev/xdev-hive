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
AGENT_ALL_ACCOUNTS="claude-4 claude-5 claude-7" .claude/skills/agent-fleet/quota.sh
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
- Ước tính tốn quota: agent Opus ăn khoảng 11% phiên mỗi giờ, Sonnet khoảng một nửa. Số này còn thô; đo lại bằng `quota.sh`
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
- **Đề bài** (`$AGENT_DIR/<VIỆC>.md`) gồm: bối cảnh, việc cần làm, file không được sửa, lệnh test, và đường dẫn
  `SUMMARY-<VIỆC>.md` để agent ghi tóm tắt. `common.md` (quy tắc chung) và `perf-common.md` (đo trước và sau) được
  ghép vào tự động.

## 4. Chạy và điều phối

```sh
export AGENT_DIR=~/.cache/xdev-hive-agents AGENT_ACCOUNTS=claude-4,claude-5,claude-7 AGENT_RETIRED=claude-6
# jobs.json: {"B": {"wt": "...", "perf": 0, "model": "claude-sonnet-5-5", "effort": "high", "account": null, "status": "queued"}}
nohup python3 .claude/skills/agent-fleet/supervisor.py > $AGENT_DIR/supervisor.out 2>&1 &
cat $AGENT_DIR/status.txt; tail $AGENT_DIR/supervisor.log
```

`supervisor.py` chạy 10 phút một lần và làm bốn việc:
- **Đo quota** từng tài khoản. Tính số agent tài khoản chịu được tới lúc reset phiên, chừa 8% an toàn, có tính trọng số
  theo model.
- **Dời agent** khỏi tài khoản quá sức sang tài khoản còn dư. Nếu không còn tài khoản nào rảnh thì để chạy tiếp và ghi log.
  Agent nằm trên tài khoản đã loại (`AGENT_RETIRED`) thì dừng và đưa về hàng chờ.
- **Khởi động việc trong hàng** khi có tài khoản rảnh và đang chạy dưới `AGENT_MAX` (mặc định 6).
- **Bật `RESUME=1`** khi worktree đã có commit hoặc file đổi. Khi đó đề bài có thêm lời nhắc đọc `git status`, `git diff`
  để làm tiếp phần dở.

`launch-auto.sh` chạy một việc theo danh sách tài khoản. Lượt trước dừng vì hết quota thì sang tài khoản kế, cùng
worktree. Nó dùng `nice -n 10`, một `CARGO_TARGET_DIR` chung, và chặn `git push`, `gh`, `rm -rf`, `sudo`.

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
