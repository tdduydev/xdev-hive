@AGENTS.md

## Chạy nhiều agent song song

Khi chia việc cho nhiều agent (Claude Code, Antigravity) trên máy dev, làm theo skill `.claude/skills/agent-fleet`:

- Đo quota phiên 5 giờ và tuần của từng tài khoản trước khi giao việc (`quota.sh`). Không giao việc dài cho tài khoản sẽ
  cạn trước khi việc xong.
- Không dùng tài khoản của phiên điều phối, không dùng tài khoản người dùng đang dùng cho việc khác.
- Chọn model và effort theo việc:
  - nặng (nhiều module, giao thức, hiệu năng, bảo mật): Opus 5.5 `--effort high`;
  - vừa (một màn UI, CRUD + e2e): Sonnet 5.5 `--effort high`;
  - nhẹ (chữ, tài liệu, báo cáo): Sonnet 5.5 `--effort medium`.
- Mỗi việc một worktree, chặn push ở worktree. Hai agent không sửa cùng một file.
- Trên Mac mini dev, tối đa khoảng 6 agent có build/test cùng lúc.
- Agent chỉ commit tại máy. Người điều phối xem lại, chạy test rồi mới push và mở PR.
