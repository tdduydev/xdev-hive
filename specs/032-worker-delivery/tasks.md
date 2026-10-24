---
description: "Task list: chạy CI/CD và triển khai trên worker trong mạng nội bộ"
---

# Tasks: Chạy CI/CD và triển khai trên worker trong mạng nội bộ

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md)

## Quy ước

**Định dạng**: `- [ ] T### [P?] [USn?] <Luồng> — mô tả (file)`.

- **Luồng**:

  | Luồng | Phạm vi |
  |---|---|
  | **W** | worker Go mới: `worker/internal/delivery/**` |
  | **C** | contracts: `packages/contracts/src/delivery-worker.ts`, `openapi.json` |
  | **H** | hub: `apps/hub/src/modules/delivery/**`, migration |
  | **U** | web và desktop |
  | **X** | luồng khác sở hữu: `worker/internal/channel/**`, `secretstore/**`, `localipc/**`. Chỉ ghi vào SUMMARY |

- **Mỗi task kèm test trong cùng commit.**
- **Kiểm theo loại**:
  - Go, trong `worker/`: `gofmt -l .`, `go vet ./...`, `GOOS=windows go vet ./...`, `go test ./internal/delivery/...`.
    Máy dev Windows hiện không có Go; CI kiểm.
  - Contracts và hub: vitest file liên quan, biome, typecheck, `pnpm deps`.
  - Migration: sinh ở cuối, sau `git merge origin/main`.
- **MVP** = Phase 1 đến Phase 4 (story P1 phần worker và chọn máy). Phần nối `channel` thuộc luồng X.

---

## Phase 1: Contracts

- [x] T001 C — Thêm `delivery-worker.ts`: `credentialRef`, `deliveryCapability`, `deliveryJobSpec`, `deliveryEvent` và test
  zod (hợp lệ, trường lạ, tên credential sai, không có kiểu mang thân log), export ở `index.ts`
  (`packages/contracts/src/delivery-worker.ts`, `delivery-worker.test.ts`)

## Phase 2: Nền worker (US7)

- [x] T002 [P] [US7] W — Kiểu lỗi và `CredentialReader`, `MapCredentials` cho test, `missing_credential`; `Scope`, `ScopedCredentials`, thư mục log và làm việc theo đăng ký (FR-104)
  (`worker/internal/delivery/errors.go`, `creds.go`, `creds_test.go`, `scope.go`, `scope_test.go`)
- [x] T003 [P] [US2] W — Bộ ghi log ra đĩa theo `jobId`, bỏ giá trị bí mật khỏi log
  (`worker/internal/delivery/joblog.go`, `joblog_test.go`)

## Phase 3: Hệ thống ngoài (US3, US4)

- [x] T004 [P] [US3] W — Client Jenkins: trigger, hàng chờ, build, input Proceed/Abort, bằng `httptest`
  (`worker/internal/delivery/jenkins.go`, `jenkins_test.go`)
- [x] T005 [P] [US4] W — Client Argo CD: sync, trạng thái, history, rollback
  (`worker/internal/delivery/argocd.go`, `argocd_test.go`)
- [ ] T006 [P] [US4] W — Client Kubernetes REST — **ngoài phạm vi** (phạm vi rút gọn 2026-10-23; đã gỡ `kube.go`)
- [ ] T007 [P] [US2] W — Health HTTP — **ngoài phạm vi** (phạm vi rút gọn 2026-10-23; đã gỡ `health.go`)

## Phase 4: Bộ chạy và chọn máy (US1)

- [x] T008 [US3] W — `Executor`: nhận `deliveryJobSpec` (chỉ `jenkins-job`, `argocd`), đọc credential, phát `deliveryEvent`, ghi log
  (`worker/internal/delivery/executor.go`, `executor_test.go`)
- [x] T009 [P] [US1] H — `runner-select.ts` thuần: thứ tự, trực tuyến, khả năng, nhãn, lý do chờ
  (`apps/hub/src/modules/delivery/runner-select.ts`, `runner-select.test.ts`)

## Phase 5: Hub giao việc, duyệt và web

- [ ] T010 [US2] W — `ssh-script` từ worker — **ngoài phạm vi** (phạm vi rút gọn 2026-10-23; đã gỡ `ssh.go`)
- [x] T011 [US1] H — Bảng `delivery_jobs`, cột `runner` ở môi trường, cột `ran_on_worker_id`; thêm vào `rls.db.test.ts`
  (`schema.ts`, `delivery-jobs.db.test.ts`)
- [x] T012 [US8] H — Nhận `deliveryEvent` (bỏ trùng `(jobId, seq)`), cập nhật lần triển khai, ngừng ghi `deploy_log_chunks`
- [x] T013 [US5] H — Chỉ tạo việc khi đủ duyệt và môi trường không khoá; giao qua `runner-select`, chờ máy 15 phút rồi
  lỗi `no_runner`; huỷ thì huỷ việc (`dispatch.ts`, `dispatch.test.ts`, `dispatch.db.test.ts`)
- [ ] T013b [US5] H — Chuyển Proceed/Abort của Jenkins input cho máy đã chạy — **ngoài phạm vi**
- [x] T014 [US8] H — Cờ `HIVE_DELIVERY_OUTBOUND` chỉ cho đường `runner=legacy`; đổi `runner` từng môi trường
  (`runners.ts`, `routes/environments.ts`, `deploys/orchestrator.ts`)
- [ ] T014b [US8] U — Trang "Chuyển sang worker" — **ngoài phạm vi** (thay bằng hộp "Máy chạy" ở T021)
- [x] T015 [US6] U — Cột "Máy chạy" ở lịch sử; trang lần triển khai: máy chạy, lý do đang chờ máy, người duyệt, thẻ
  "Log nằm trên máy X" thay khung log (`board-page.tsx`, `deploy-page.tsx`)
- [x] T016 [US7] U — Tab "Credential triển khai" ở màn Bí mật desktop: tên và lúc đổi, thêm, thay giá trị, xoá có xác
  nhận; kho riêng `dev.xdev.hive.delivery`, đọc ngay lúc dùng, Linux thiếu Secret Service báo rõ (`secretstore/delivery.go`,
  `delivery/keyring.go`, `hive-worker secrets delivery`, `delivery-credentials.tsx`, `delivery-credentials.test.tsx`)
- [x] T021 [US1] U — Trang Môi trường: hộp "Máy chạy" (máy theo thứ tự ưu tiên, nhãn `deploy-runner`, đường cũ); đích
  Jenkins và Argo CD có ô "Credential trên máy chạy" (`runner-form.tsx`, `target-form.tsx`, `target-presets.ts`,
  `e2e/delivery-servers.spec.ts`)
- [x] T022 [US5] H — Cổng duyệt: hàng chờ của tôi, duyệt, từ chối kèm lý do, hết hạn, audit (`approvals.ts`,
  `routes/approvals.ts`, `dispatch.db.test.ts`)
- [x] T023 [US5] U — Trang "Duyệt triển khai" `/deploy-approvals` (`approvals-page.tsx`, `e2e/delivery-approvals.spec.ts`)
- [ ] T024 U — Bảng deploy (dự án × môi trường) — **ngoài phạm vi**
- [ ] T025 H — Gọi thẳng Kubernetes, `kubectl`, health từ hub hay worker — **ngoài phạm vi**
- [x] T026 [US5] H+U — Khoá, mở khoá môi trường kèm lý do, cần `servers.manage`, ghi audit; trang Môi trường hiện người
  khoá và lý do (`environments.ts`, `deploys.db.test.ts`, `e2e/delivery-servers.spec.ts`; từ specs/020 T027, T030)
- [x] T027 [US5] U — Tab CI/CD: "Duyệt deployment" và "Từ chối" cho deployment chờ duyệt của GitHub Actions
  (`cicd-run-detail.tsx`, `e2e/delivery-ci.spec.ts`; từ specs/020 T032)
- [x] T028 [US5] H+U — Trang duyệt và lần triển khai so sánh commit giữa bản thành công trước và bản mới
  (`approvals.compare`, GitHub/GitLab, tối đa 100 commit, có trạng thái chưa đủ danh sách)
- [ ] T029 H — Rollback (`deploys.rollback`, `rollbackInfo`) — **ngoài phạm vi** (chạy lệnh; muốn về bản cũ thì triển khai
  lại bản đó qua cổng duyệt; từ specs/020 T028)
- [ ] T030 H — Bộ lọc theo hệ thống ở kênh thông báo — **ngoài phạm vi** (người duyệt đã nhận `deploy.approval_requested`;
  từ specs/020 T029)
- [ ] T020 [US1] X — Mỗi đăng ký một hàng việc, một outbox và một `Scope` truyền vào `delivery.Executor` (thuộc specs/034)
- [ ] T017 [US1] X — Nối `channel`: nhận `deliveryJobSpec` qua lease, gửi `deliveryEvent` qua outbox, báo khả năng ở `hello`
  (thuộc specs/034; hub đã có `worker-jobs.ts` chờ phía worker)
- [x] T018 [US10] X — Test hợp đồng trên ba hệ điều hành trong CI: file mẫu chung `fixtures/delivery-worker.json` cho zod
  và Go; worker chạy thật jenkins-job, argocd với server giả rồi so sự kiện; đường dẫn máy đích giữ nguyên (FR-101)
  (`delivery-worker.test.ts`, `delivery/contract_test.go`)
- [x] T019 H — Sinh migration (`0090_delivery_jobs`, đánh lại số sau khi gộp `main`), `pnpm openapi`
