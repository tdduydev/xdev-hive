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

## Commit, PR và phát hành

- Commit message, tiêu đề PR và release notes viết **tiếng Anh**. Chữ trên giao diện vẫn tiếng Việt.
- Phát hành bằng nhánh `release`: merge `main` vào `release` (qua PR) là workflow tự build và công bố bản mới.
  - Phiên bản: tự tăng patch; muốn tăng minor/major thì sửa file `VERSION`.
  - Release notes: viết tay trong `RELEASE_NOTES.md` (mục `## v<x.y.z>`), không có thì tự sinh từ tiêu đề PR.
- Mỗi PR vào `main` lần lượt: cập nhật với `main` mới nhất, CI xanh trên đúng bản đó rồi mới merge, để các PR song song
  không làm `main` đỏ.
