---
description: "Task list: một máy làm việc cho nhiều tổ chức, và sửa phân quyền"
---

# Tasks: Một máy làm việc cho nhiều tổ chức

> `- [-]`: bỏ, ngoài phạm vi (lý do ghi trong từng task). Giữ task để ghi lại.

**Input**: [spec.md](spec.md), [rbac-review.md](rbac-review.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

## Quy ước

**Định dạng**: `- [ ] T### [P?] [027?] [USn?] <Luồng>·<Tier> — mô tả (file)`.

- **[P]**: chạy song song được với task khác cùng đợt; không sửa chung file.
- **[027]**: cần spec 027 (outbox, channel nhiều kênh, `worker-protocol.ts`, `localipc`, `runner.go`) merge trước. Không
  làm trong nhánh `ai/SPEC034`.
- **Luồng**:

  | Luồng | Phạm vi |
  |---|---|
  | **W** | worker Go: `worker/**` |
  | **R** | desktop Rust: `apps/desktop/src-tauri/**` |
  | **U** | desktop UI: `apps/desktop/src/**` |
  | **H** | hub và contracts: `apps/hub/**`, `packages/contracts/**`, `openapi.json` |
  | **WEB** | web: `apps/web/**` |
  | **Điều phối** | kiểm tay trên máy thật, chỉ ghi `specs/034-multi-org-machine/` |

- **Tier**: nặng = Opus `--effort high`; vừa = Sonnet `--effort high`; nhẹ = Sonnet `--effort medium`.
- **File chung có chủ** (nối tiếp):
  - `apps/hub/src/modules/leader/service.ts`, `router.ts`: T010 → T011.
  - `apps/hub/src/modules/fleet/router.ts`: T012 → T016.
  - `apps/hub/src/modules/runs/engine.ts`: T015 → T060.
  - `worker/cmd/hive-worker/main.go`: T031 → T040 → T050.
  - `apps/desktop/src-tauri/src/lib.rs`: T070 → T071 → T072.

## Phase 0: Nghiên cứu (Điều phối)

- [-] T001 Điều phối·vừa — Kiểm Claude Code và Codex trên macOS, Windows, Linux: đổi `CLAUDE_CONFIG_DIR`/`CODEX_HOME`
  sang thư mục mới có liên kết tới file đăng nhập thì còn đăng nhập không. Ghi kết quả vào research.md D4, chọn a/b/c.
  **Ngoài phạm vi**: nghiên cứu cho cách ly tài khoản CLI (US5).
- [-] T002 [P] Điều phối·nhẹ — Kiểm Landlock (Linux ≥ 5.13) và `sandbox-exec` (macOS) chặn đọc thư mục đăng ký kia;
  ghi vào research.md D9.
  **Ngoài phạm vi**: nghiên cứu cho mức tách-người-dùng (US3).
- [-] T003 [P] Điều phối·nhẹ — Rà lại mọi đường dẫn dưới `~/.xdev-hive` và `UserConfigDir/xdev-hive` mà worker, desktop
  ghi; bổ sung bảng research.md D3 nếu sót.
  **Ngoài phạm vi**: đã rà đủ cho bản này; memory, context, optimizer, CA hub giữ mức máy.

## Phase 1: Hub, sửa phân quyền (không phụ thuộc 027)

Mục tiêu: đóng các rủi ro R1–R4, R6, R7, R10 trong rbac-review.md. Test db chạy trên CI.

- [x] T010 [US8] H·vừa — FR-090: `leader.threads.list/get/send` và `approvals.list` chỉ trả hội thoại người dùng thấy
  được (dự án thuộc đội thấy được; hội thoại không dự án: người tạo, owner/admin tổ chức). `approvals.reject` cần
  `member` của đội sở hữu dự án. (`apps/hub/src/modules/leader/service.ts`, `router.ts`, `visibility.ts`,
  `visibility.db.test.ts`)
- [x] T011 H·vừa — FR-096: hành động leader chạy theo người duyệt; kiểm lại `executeLeaderAction` cho dự án ngoài đội.
  (`apps/hub/src/modules/leader/actions.ts`) — đã rà: mọi nhánh gọi hàm nghiệp vụ có kiểm vai trò (`createTask`, `updateProjectSettings`, `startRun`, `cancelRun`, `createItem`); không cần sửa
- [x] T012 [P] H·nhẹ — FR-091: router fleet gọi `requireOrgRole(tx, userId, "member")` trong `inOrg`.
  (`apps/hub/src/modules/fleet/router.ts`, `fleet-rbac.db.test.ts`)
- [x] T013 [P] H·vừa — FR-094: token cá nhân chỉ dùng được trong tổ chức của token, kể cả khi tổ chức nằm ở đường dẫn.
  (`apps/hub/src/personal-token-auth.ts`, `apps/hub/src/modules/tenancy/procedures.ts`, test)
- [x] T014 [P] H·vừa — FR-093: đăng ký lại cùng tên máy chỉ khi người tạo mã là chủ cũ hoặc admin đội; giữ
  `registeredBy`; audit có `previousOwner`. (`apps/hub/src/modules/fleet/registration.ts`, test db) — xong; người tạo mã không phải chủ cũ hay admin đội thì bị từ chối.
- [-] T015 [US6] H·vừa — FR-055/095: từ chối lý do `machine_busy` không ghi `rejectedBy`, đánh dấu máy bận tới heartbeat
  kế (tối đa 30 giây), giao máy khác. (`apps/hub/src/modules/runs/engine.ts`, `machine-busy.ts`, test)
  **Ngoài phạm vi**: lập lịch và `machine_busy` cần nhiều đăng ký chạy cùng lúc.
- [x] T016 H·nhẹ — FR-098: chủ máy cá nhân tự pause/resume/revoke máy của mình. (`apps/hub/src/modules/fleet/machines.ts`,
  test db) — xong.
- [x] T017 [P] H·nhẹ — FR-092: `roles.unassign` gọi `requireCanGrant`; gán vai trò cho đội từ chối vai trò phạm vi tổ
  chức. (`apps/hub/src/modules/tenancy/roles.ts`, test db)
- [x] T018 [P] H·nhẹ — FR-006: `registerOutput.orgName` tuỳ chọn; hub trả tên tổ chức. (`packages/contracts/src/fleet.ts`,
  `fleet/registration.ts`, `openapi.json`) — xong.
- [-] T019 H·vừa — FR-097: test ma trận vai trò × procedure cho leader, fleet, roles (viewer, ba, member, admin, ngoài
  đội). (`apps/hub/src/modules/*/rbac-matrix.db.test.ts`)
  **Ngoài phạm vi**: test db từng procedure đã có ở T010–T017; ma trận đầy đủ làm sau.
- [-] T020 [027] H·vừa — R5: `account_set` từ hub chỉ áp lên tài khoản gán cho đăng ký đó; worker từ chối tài khoản do chủ
  máy giữ (FR-044). Cần `worker-protocol.ts`.
  **Ngoài phạm vi**: R5 cần kênh của từng đăng ký chạy cùng lúc.
- [-] T021 H·nhẹ — R12 (mcp): token MCP mang tổ chức; module `mcp` đang khoá trong nhánh này.
  **Ngoài phạm vi**: R12, module `mcp` khoá trong nhánh này.

**Checkpoint**: `pnpm deps`, typecheck hub, vitest các file đổi; db test xanh trên CI.

## Phase 2: Worker, sổ đăng ký (không phụ thuộc 027)

- [x] T030 [US1] W·nặng — Gói `worker/internal/registry`: đọc/ghi `registrations.json` (ghi tạm rồi đổi tên, 0600), sinh
  id `reg_` + 8 ký tự base32, kiểm trùng (hub, tổ chức), đường dẫn cấu hình và dữ liệu theo đăng ký, đăng ký cũ
  `reg_legacy` (FR-001–009, FR-080). Test: tạo, trùng, giới hạn, đăng ký cũ, `HIVE_WORKER_CONFIG` bỏ qua sổ.
  Xong: thêm trùng (hub, tổ chức) thì thay đăng ký cũ tại chỗ (FR-004 đã sửa); giới hạn 8 (A3).
- [x] T031 [US1] W·vừa — `hive-worker registrations list|add|reregister|set|remove|set-limit` theo
  contracts/worker-cli.md; `add` dùng lại luồng `register`. (`worker/cmd/hive-worker/registrations.go`, `main.go`)
  Xong phần `list|add|use|set|remove`; `add` trùng tổ chức thay cho `reregister`. **Ngoài phạm vi**: `set-limit`.
- [-] T032 [P] W·vừa — Cờ `--registration` cho `accounts`, `memory`, `context`, `ssh`, `gitgroups`, `optimize`; lệnh ghi
  báo lỗi khi máy có ≥ 2 đăng ký mà thiếu cờ. (`worker/cmd/hive-worker/*.go`, trừ `projects.go` khoá trong nhánh này)
  **Ngoài phạm vi**: thay bằng cờ chung `hive-worker --registration ID <lệnh>` (biến `HIVE_REGISTRATION`).
- [-] T033 [P] W·vừa — Đường dẫn theo đăng ký cho `memstore` SharedRoot, `ctxsync`, `optimizer`, `gitgroups`, `hubtls`
  theo research D3. Đăng ký cũ giữ đường dẫn cũ.
  **Ngoài phạm vi**: chỉ `gitgroups`, `accounts`, `remote` đi theo đăng ký vì nằm cạnh `worker.json`; memory, context, optimizer, CA hub giữ mức máy.
- [-] T034 [P] W·nhẹ — `accounts.json` thêm `registrations[]`; `accounts assign`. (`worker/internal/accounts`)
  **Ngoài phạm vi**: `accounts.json` đã riêng theo đăng ký vì nằm cạnh `worker.json`; không thêm `registrations[]`.
- [-] T035 W·vừa — `projects.json` theo đăng ký và chặn một thư mục gắn hai đăng ký (FR-032). Gói `projects` khoá trong
  nhánh này: làm sau.
  **Ngoài phạm vi**: gói `projects` khoá trong nhánh này.

## Phase 3: Worker, nhiều kênh và lập lịch [027]

- [-] T040 [027] [US2] W·nặng — Một tiến trình mở N kênh, mỗi kênh một `outbox.Identity`, `instancelock` một lần.
  (`worker/cmd/hive-worker/main.go`, `worker/internal/channel`)
  **Ngoài phạm vi**: nhiều đăng ký chạy cùng lúc trong một tiến trình.
- [-] T041 [027] [US6] W·nặng — Gói `worker/internal/scheduler`: slot máy `M`, giới hạn `L(reg)`, trọng số, chia công bằng
  khi tranh; giữ slot trước `job_accept`; hết slot trả `machine_busy`. Test chia 2×2, 1×N, đói.
  **Ngoài phạm vi**: như T015.
- [-] T042 [027] W·vừa — Heartbeat gửi `capacity` của đăng ký và `policyUnmet`. (`worker-protocol.ts`, `channel`)
  **Ngoài phạm vi**: như T040.
- [-] T043 [027] W·vừa — Gỡ đăng ký: gửi nốt/xuất/bỏ hộp thư đi, chờ/huỷ run, xoá thư mục và token (FR-063).
  **Ngoài phạm vi**: gỡ đăng ký bản này chỉ xoá thư mục, token và khoá; từ chối gỡ khi worker đang chạy.

## Phase 4: Worker, tài khoản và cách ly run [027]

- [-] T050 [027] [US5] W·nặng — Chọn tài khoản theo `registrations[]` và `aiAccountSharing`; thư mục trạng thái CLI
  `cli-state/<acc>/<reg>` theo kết quả T001. (`worker/internal/accounts`, `runner.go`)
  **Ngoài phạm vi**: US5.
- [-] T051 [027] [US2] W·vừa — Env run chỉ của đăng ký sở hữu; `HIVE_RUN_SESSION`, `HIVE_REGISTRATION`; lọc biến của đăng
  ký khác. (`runner.go`)
  **Ngoài phạm vi**: một tiến trình một đăng ký nên env run chỉ có của đăng ký đó.
- [-] T052 [027] [US2] W·nặng — Socket cục bộ: mỗi yêu cầu từ run mang `HIVE_RUN_SESSION`, worker tra đăng ký; không có
  thì chỉ cho chủ máy (FR-024, R11). (`worker/internal/localipc`, `worker/cmd/hive/mcp.go`)
  **Ngoài phạm vi**: R11 cần nhiều đăng ký chạy cùng lúc.
- [-] T053 [027] W·vừa — Kho bí mật (031) theo đăng ký. (`worker/internal/secretstore`)
  **Ngoài phạm vi**: kho bí mật (031) chưa merge.

## Phase 5: Desktop

- [-] T070 [US7] R·vừa — Lệnh Tauri trong contracts/tauri-commands.md, gọi sidecar. (`src-tauri/src/registrations.rs`,
  `lib.rs`). Thêm/gỡ thật cần Phase 3 [027]; list/set làm trước được.
  **Ngoài phạm vi**: UI desktop.
- [-] T071 [P] R·vừa — Keychain khoá `<hub>#<orgId>`, chuyển khoá cũ một lần. (`src-tauri/src/account.rs`, `hub_switch.rs`)
  **Ngoài phạm vi**: UI desktop; token cá nhân trên desktop vẫn theo khoá hub.
- [-] T072 R·nhẹ — Sự kiện `registrations://changed`; tham số `registrationId` cho lệnh có sẵn.
  **Ngoài phạm vi**: UI desktop.
  **Ngoài phạm vi**: UI desktop.
- [-] T073 [US7] U·vừa — Màn "Tổ chức trên máy" trong Cài đặt: danh sách, thêm, đổi nhãn/màu/giới hạn, gỡ có hỏi hộp thư
  đi. (`apps/desktop/src/screens/organizations-screen.tsx`, test)
  **Ngoài phạm vi**: UI desktop.
- [-] T074 [P] [US7] U·vừa — Nhãn màu tổ chức trên run, dự án, terminal, thông báo; bộ lọc theo tổ chức.
  (`runs-screen.tsx`, `projects-screen.tsx`, `home-screen.tsx`)
  **Ngoài phạm vi**: UI desktop.
- [-] T075 [P] [US5] U·nhẹ — Gán tài khoản AI cho đăng ký. (`agents-screen.tsx` hoặc màn tài khoản)
  **Ngoài phạm vi**: UI desktop.

## Phase 6: Chính sách tổ chức và web

- [-] T080 H·vừa — `aiAccountSharing`, `machineIsolation` trong chính sách tổ chức, gửi trong `welcome.policy`.
  (`apps/hub/src/modules/governance` khoá trong nhánh này; `worker-protocol.ts` [027])
  **Ngoài phạm vi**: chính sách tổ chức mới; module `governance` khoá.
- [-] T081 WEB·vừa — Hai mục chính sách trên `/admin/policies`. Cần T080.
  **Ngoài phạm vi**: cần T080.
- [-] T082 [P] WEB·nhẹ — Trang máy hiện `coTenancyNote` khi chủ máy bật (US8). Cần T042 và cột `machines.co_tenancy_note`.
  **Ngoài phạm vi**: cần T042.

## Phase 7: Mức tách-người-dùng [027]

- [-] T090 [027] [US3] W·nặng — Chạy run bằng tài khoản hệ điều hành riêng; nhận spec qua pipe có xác thực. (`runner.go`,
  `procattr`)
  **Ngoài phạm vi**: US3.
- [-] T091 [027] W·nặng — Sandbox đọc (Landlock, `sandbox-exec`) theo kết quả T002.
  **Ngoài phạm vi**: US3.

## Phase 8: Hoàn thiện

- [ ] T100 Điều phối·vừa — Chạy quickstart.md trên Windows, macOS, Linux.
- [-] T101 H·nhẹ — Migration cột `machines.co_tenancy_note` khi làm T082 (sinh sau khi merge `main`).
  **Ngoài phạm vi**: cần T082.

## Thứ tự

Phạm vi bản này (2026-10-23, xem spec.md "Phạm vi bản này"): Phase 1 trừ T015, T019–T021; Phase 2 trừ T032–T035. Các
task còn lại ghi "Ngoài phạm vi" và giữ làm thiết kế đích.

- Phase 1 làm ngay, song song với 027.
- Phase 2 làm ngay trừ T035.
- Phase 3, 4, 7 sau khi 027 merge.
- Phase 5: T071, T073 (chỉ danh sách) làm trước; phần thêm/gỡ sau Phase 3.
- Phase 6 sau khi mở khoá `governance`.
