# CI

Workflow: `.github/workflows/ci.yml` (PR, push `main` và `release`), `desktop.yml` (đóng gói app), `release.yml` (phát hành).
Không bỏ test nào: chỉ bỏ job khi thay đổi không thể chạm tới nó, và chia nhỏ để chạy song song.

## Job nào chạy khi nào

`scripts/ci/changes.sh` đọc file PR đổi (commit merge của PR so với đầu nhánh đích) rồi bật hoặc tắt từng job.
Push vào `main` hoặc `release`, PR vào `release`, hay không đọc được diff: **luôn chạy đủ**. Đường dẫn lạ không nằm
trong danh sách bỏ qua thì job vẫn chạy. Test của chính script: `scripts/ci/test-changes.sh` (chạy trong job Worker Go
trên Linux).

| Job | Bị bỏ khi PR chỉ đổi |
|---|---|
| TypeScript (lint, typecheck, test, build) | không bao giờ bỏ |
| Web E2E (Playwright) | tài liệu, `worker/`, `apps/desktop/`, script phát hành và cài, `deploy/`, `packages/skill-pack`, `VERSION` |
| Docker image | tài liệu, `worker/`, `apps/desktop/`, script phát hành và cài |
| E2E smoke, E2E sandbox | tài liệu, `apps/desktop/`, script phát hành và cài |
| Desktop Tauri | mọi thứ ngoài `apps/desktop/`, `worker/`, `packages/`, `docs/design-system/`, khoá phụ thuộc, workflow CI |
| Worker Go (ubuntu) | mọi thứ ngoài `worker/`, `scripts/install.*`, `scripts/release/`, `scripts/ci/`, workflow CI |
| Worker Go (macos, windows) | mọi thứ ngoài `worker/`, `scripts/install.*`, workflow CI |

Tài liệu = `*.md`, `specs/**`, `docs/**` trừ `docs/design-system/**` (web và desktop đọc token màu và logo ở đó).

Job bị bỏ báo **Skipped**, GitHub tính là đạt. Hai chỗ cần để ý khi sửa workflow:

- Tên check bắt buộc của `main` không đổi: `Web E2E (Playwright)` là job tổng luôn chạy, đạt khi cả 4 shard
  (`Web E2E shard i/4`) đạt hoặc khi PR không chạm web. Job `Worker Go` tách ba job tên tĩnh thay cho matrix, vì job
  matrix bị bỏ báo bằng tên chưa thay biến và check bắt buộc cùng tên sẽ treo mãi.
- Job `changes` hỏng thì các job còn lại chạy hết (điều kiện `!= 'false'`), không bao giờ bỏ nhầm.

## Playwright

4 shard (`--shard=i/4`), mỗi shard một runner. Khi hỏng, mỗi shard đẩy báo cáo blob, job `Web E2E (báo cáo gộp)` gộp
bằng `playwright merge-reports` thành một artifact `playwright-report` (HTML kèm trace, giữ 7 ngày). Muốn xem lại:
tải artifact rồi `pnpm exec playwright show-report <thư mục>`.

## Cache (repo public, tối đa 10 GB, mục không dùng 7 ngày bị xoá)

Chỉ `main` lưu cache; PR và `release` chỉ đọc (restore từ `main`) nên PR không làm đầy hạn mức.

| Cache | Khoá | Ở đâu |
|---|---|---|
| Kho pnpm | OS + hash `pnpm-lock.yaml` | `.github/actions/setup-js` |
| Go (module + build) | OS + loại việc + hash `worker/go.mod`, `go.sum` | `.github/actions/setup-go` |
| Chromium của Playwright | OS + phiên bản `@playwright/test`; chỉ cài thư viện hệ thống khi trúng cache | job `web-e2e-shard` |
| Turbo (`.turbo/cache`) | OS + sha, `restore-keys` lấy bản mới nhất của `main` | job `typescript` |
| Rust (`Swatinem/rust-cache`) | `shared-key` theo job, `save-if` chỉ `main` | `ci.yml` desktop, `desktop.yml` |
| Lớp Docker | `type=gha,mode=max,scope=image`, chỉ `main` ghi | job `image` |

Turbo: push vào `main` đặt `TURBO_FORCE=true` nên mọi task chạy lại thật rồi ghi cache mới; PR dùng lại kết quả của
`main` cho gói không đổi. `tsc` (TypeScript 7) và vitest không bật cache tăng dần vì chạy đã nhanh so với phần còn lại.

Cache đầy 10 GB thì mục cũ nhất bị xoá, lượt chạy đầu sau đó chậm hơn nhưng vẫn đúng. Xem dung lượng:
`gh cache list --repo tdduydev/xdev-hive`.

## Runner

Repo public: phút runner chuẩn không tính tiền, nhưng giới hạn khoảng 20 job đồng thời (macOS khoảng 5). Vì vậy PR chỉ
chạy macOS và Windows khi `worker/` hay script cài đổi; `desktop.yml` đóng gói ba hệ điều hành chỉ khi push `main` đổi
app, worker, token màu hay workflow, hoặc khi phát hành. PR mới huỷ lượt cũ của PR đó (`cancel-in-progress`); `main` và
`release` không bị huỷ giữa chừng.
