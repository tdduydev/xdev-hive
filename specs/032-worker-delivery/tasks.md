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

- [x] T002 [P] [US7] W — Kiểu lỗi và `CredentialReader`, `MapCredentials` cho test, `missing_credential`
  (`worker/internal/delivery/errors.go`, `creds.go`, `creds_test.go`)
- [x] T003 [P] [US2] W — Bộ ghi log ra đĩa theo `jobId`, bỏ giá trị bí mật khỏi log
  (`worker/internal/delivery/joblog.go`, `joblog_test.go`)

## Phase 3: Hệ thống ngoài (US3, US4)

- [x] T004 [P] [US3] W — Client Jenkins: trigger, hàng chờ, build, input Proceed/Abort, bằng `httptest`
  (`worker/internal/delivery/jenkins.go`, `jenkins_test.go`)
- [x] T005 [P] [US4] W — Client Argo CD: sync, trạng thái, history, rollback
  (`worker/internal/delivery/argocd.go`, `argocd_test.go`)
- [x] T006 [P] [US4] W — Client Kubernetes REST: lấy workload, patch image, tính rollout
  (`worker/internal/delivery/kube.go`, `kube_test.go`)
- [x] T007 [P] [US2] W — Health HTTP có thử lại và ngưỡng (`worker/internal/delivery/health.go`, `health_test.go`)

## Phase 4: Bộ chạy và chọn máy (US1)

- [x] T008 [US2] W — `Executor`: nhận `deliveryJobSpec`, chọn cách chạy, đọc credential, phát `deliveryEvent`, ghi log
  (`worker/internal/delivery/executor.go`, `executor_test.go`)
- [x] T009 [P] [US1] H — `runner-select.ts` thuần: thứ tự, trực tuyến, khả năng, nhãn, lý do chờ
  (`apps/hub/src/modules/delivery/runner-select.ts`, `runner-select.test.ts`)

## Phase 5: Còn lại (ngoài MVP của lượt này)

- [ ] T010 [US2] W — `ssh-script` bằng `x/crypto/ssh`: host key ghim, chạy script, đọc log, huỷ (`worker/internal/delivery/ssh.go`)
- [ ] T011 [US1] H — Bảng `delivery_jobs`, cột `runner` ở môi trường, cột `ran_on_worker_id`; thêm vào `rls.db.test.ts`
  (`schema.ts`, `delivery-jobs.db.test.ts`)
- [ ] T012 [US8] H — Nhận `deliveryEvent` (bỏ trùng `(jobId, seq)`), cập nhật lần triển khai, ngừng ghi `deploy_log_chunks`
- [ ] T013 [US5] H — Chỉ tạo việc khi đủ duyệt và môi trường không khoá; chuyển Proceed/Abort cho máy đã chạy
- [ ] T014 [US8] H — Cờ `HIVE_DELIVERY_OUTBOUND` và `runner=legacy`; trang "Chuyển sang worker"
- [ ] T015 [US6] U — Cột "Máy chạy", thẻ "Log nằm trên máy X" thay khung log
- [ ] T016 [US7] U — Tab "Credential triển khai" ở màn Bí mật desktop
- [ ] T017 [US1] X — Nối `channel`: nhận `deliveryJobSpec` qua lease, gửi `deliveryEvent` qua outbox, báo khả năng ở `hello`
- [ ] T018 [US10] X — Test hợp đồng trên ba hệ điều hành trong CI
- [ ] T019 H — Sinh migration sau `git merge origin/main`, `pnpm openapi`
