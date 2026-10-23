# Implementation Plan: Một máy làm việc cho nhiều tổ chức

**Branch**: `ai/SPEC034` (feature `034-multi-org-machine`) · **Date**: 2026-10-23 · **Spec**: [spec.md](spec.md) ·
**Research**: [research.md](research.md) · **Rà soát phân quyền**: [rbac-review.md](rbac-review.md)

- Thiết kế dữ liệu: [data-model.md](data-model.md).
- Giao diện:
  - [contracts/worker-cli.md](contracts/worker-cli.md): lệnh `hive-worker` mới và cờ `--registration`;
  - [contracts/hub-changes.md](contracts/hub-changes.md): phần hub, hợp đồng và chính sách đổi;
  - [contracts/tauri-commands.md](contracts/tauri-commands.md): lệnh Tauri cho màn "Tổ chức trên máy".
- Kiểm tay: [quickstart.md](quickstart.md).

Nhãn **[Unverified]** đánh dấu điều chưa kiểm trên máy thật. T001 đến T003 kiểm các điểm đó trước khi code phụ thuộc.

## Phạm vi bản này (thu hẹp 2026-10-23)

Chỉ làm hai phần: đăng ký riêng theo tổ chức trên máy và sửa lỗ phân quyền. Danh sách phần cắt nằm ở spec.md mục "Phạm
vi bản này". Cách làm:

- Sổ `UserConfigDir/xdev-hive/registrations.json` (`active`, `registrations[]`), gói `worker/internal/registry`. Đăng ký
  mới: cấu hình `…/xdev-hive/orgs/<id>/worker.json`, dữ liệu `UserCacheDir/xdev-hive/orgs/<id>/worker`. Máy cũ là
  `reg_legacy`, giữ đường dẫn cũ và không cần ghi sổ.
- Chọn đăng ký: `--config` > `HIVE_WORKER_CONFIG` (bỏ qua sổ, FR-082) > `--registration`/`HIVE_REGISTRATION` > `active` >
  `reg_legacy`. `run` và `host` ghim id đã chọn vào `HIVE_REGISTRATION` để hook và askpass con dùng cùng đăng ký.
- Khoá máy: tài khoản keychain thêm id đăng ký (`machinekey.Store.Scope`, lưu ở `worker.json` `keyScope`). Đăng ký cũ
  giữ tài khoản cũ.
- Mỗi tiến trình một đăng ký; `instancelock` vẫn chung cả máy. Nhiều kênh trong một tiến trình (phần "Kiến trúc" dưới)
  ngoài phạm vi.
- Ngoài phạm vi: sổ chưa có khoá giữa các tiến trình; hai lệnh `registrations add` chạy cùng lúc có thể mất một dòng.

## Tóm tắt

**Worker** (phần lớn việc):

- gói mới `worker/internal/registry`: đọc, ghi, tạo chỉ mục `registrations.json`; dựng đường dẫn của từng đăng ký; tạo
  đăng ký cũ từ `worker.json` (FR-080);
- `main.go` khởi động một `channel` cho mỗi đăng ký đang bật, mỗi cái có `Config`, `DataDir`, `Accounts` đã lọc,
  `Projects` và hộp thư đi riêng;
- gói mới `worker/internal/scheduler`: bộ đếm chung `M`, bộ đếm theo đăng ký `L(r)`, chia công bằng có trọng số, trả
  `machine_busy` khi phải từ chối;
- `accounts`: trường `registrations`, lọc theo đăng ký, thư mục trạng thái CLI theo (tài khoản, đăng ký);
- `runner`: xoá biến `HIVE_*` thừa kế, kiểm hub trong spec run khớp đăng ký, đặt mã phiên run cho socket cục bộ;
- `localipc`: lệnh ghi mang mã phiên run, worker suy ra đăng ký;
- `memstore`, `ctxsync`, `secretstore` (031): thư mục gốc theo đăng ký;
- sandbox đọc (Linux Landlock, macOS `sandbox-exec`) cho run không toàn quyền (FR-024).

**Hub, contracts** (ít, phần lớn là sửa phân quyền):

- kết quả đăng ký có `orgName` (FR-006);
- `job_reject` lý do `machine_busy` không thêm máy vào `rejectedBy` (FR-055);
- chính sách tổ chức thêm `aiAccountSharing`, `machineIsolation` (FR-042, FR-061), gửi xuống trong `welcome.policy`;
- cột `machines.co_tenancy_note` (FR-070, US8);
- sửa phân quyền FR-090 đến FR-098 (rbac-review.md mục 4).

**Desktop**:

- Rust: `registrations.rs` gọi `hive-worker registrations …`; keychain theo (hub, tổ chức); `hub_switch.rs`,
  `register.rs`, `local_projects.rs`, `profiles.rs` nhận id đăng ký;
- UI: màn "Tổ chức trên máy", nhãn tổ chức và bộ lọc trên các màn, hộp gỡ đăng ký, cảnh báo toàn quyền.

**Web**: trường chính sách mới trên `/admin/policies`; trang máy hiện ghi chú đồng thuê khi có.

**Không đổi**: bảng `machines` vẫn một dòng mỗi đăng ký; RLS; giao thức kênh worker ngoài các trường tuỳ chọn mới.

## Technical Context

| Mục | Giá trị |
|---|---|
| Ngôn ngữ | Go (worker), Rust (Tauri), TypeScript strict (desktop UI, hub, web, contracts) |
| Phụ thuộc mới | Go: `github.com/landlock-lsm/go-landlock` cho FR-024 trên Linux **[Unverified]** (T003). macOS dùng `sandbox-exec` có sẵn. Không thêm phụ thuộc Rust hay npm |
| Lưu trữ máy | `UserConfigDir/xdev-hive/registrations.json`; `…/xdev-hive/orgs/<id>/` (cấu hình); `UserCacheDir/xdev-hive/worker/orgs/<id>/` (dữ liệu); `~/.xdev-hive/cli-state/<account>/<id>/` (trạng thái CLI); `~/.xdev-hive/outbox/<identity>` giữ như 027 |
| Lưu trữ hub | Một cột `machines.co_tenancy_note`; hai khoá trong JSON chính sách có sẵn. Một migration |
| Test | Go: test bảng cho registry, scheduler, lọc tài khoản, dựng env; test tích hợp hai kênh với hub giả (`channel` đã có hub giả trong test). Hub: Vitest + `*.db.test.ts` (CI). Desktop: Vitest + Testing Library; `cargo test` |
| Hiệu năng | Mỗi đăng ký thêm một kết nối WSS và một vòng heartbeat; chấp nhận được tới 8 đăng ký (A3) |
| Nền tảng | Windows, macOS, Linux. Mức `tách-người-dùng` cần quyền admin máy để cài |
| Ràng buộc | Hub không biết hai đăng ký là một máy (FR-070). Bản cũ chạy được đăng ký cũ (FR-081) |

## Constitution Check

| Nguyên tắc | Cách tuân |
|---|---|
| I. Contract first | Trường mới trong `packages/contracts`: `registerResult.orgName`, chính sách `aiAccountSharing`, `machineIsolation`, `welcome.policy` hai trường đó, `machine.coTenancyNote`. Lý do `machine_busy` là chuỗi trong `jobReject.reason` đã có, ghi hằng số chung. Mọi trường tuỳ chọn. `pnpm openapi` |
| II. Tenant isolation | Hub không có bảng nối tổ chức. Cột mới nằm trong `machines` đã có RLS. Sửa phân quyền FR-090 đến FR-098 tăng cách ly theo đội |
| III. Module boundaries | Sửa trong `leader`, `fleet`, `tenancy`, `runs`, mỗi module dùng nhau qua `index.ts`. Không đụng `delivery`, `governance`, `mcp` trong đợt này (chính sách ở `governance` chờ đợt sau) |
| IV. Tested | Mỗi sửa phân quyền có test, gồm người thuộc hai tổ chức. Worker có test cách ly SC-002 |
| V. Secure by default | Thêm đăng ký thứ hai không đổi gì ở đăng ký đầu. Socket từ chối khi thiếu mã phiên trên máy có từ hai đăng ký. App cảnh báo giới hạn cách ly |
| VI. Ngôn ngữ | Chữ giao diện, lỗi tiếng Việt. Spec, plan tiếng Việt: lệch VI như 025 đến 031 |
| VII. Simple to self-host | Không thêm dịch vụ. Một migration nhỏ |

Kết quả: **đạt**, một lệch đã biết (VI).

## Kiến trúc

```
                 ┌──────────────── hive-worker (một tiến trình, instancelock) ────────────────┐
 registrations ─▶│ registry ──▶ reg A: channel(hub A, token A, DataDir A, accounts∩A, projects A)
     .json       │          └─▶ reg B: channel(hub B, token B, DataDir B, accounts∩B, projects B)
                 │ scheduler (M chung, L(A), L(B), trọng số) ◀── job_offer của mọi channel
                 │ accounts pool (quota chung) ── lease(account, reg) ──▶ CLI state dir (account, reg)
                 │ localipc ── mã phiên run ──▶ reg của run
                 └────────────────────────────────────────────────────────────────────────────┘
 Desktop ── hive-worker registrations … ──▶ registry      Desktop keychain: (hub, org) ──▶ token cá nhân
```

Mức `tách-người-dùng` (FR-026): worker chính giữ kênh; run của đăng ký đó chạy bằng `hive-worker exec-as` dưới tài
khoản hệ điều hành riêng, nhận spec qua pipe có xác thực. Phần này để giai đoạn sau (Phase 7 trong tasks.md).

## Giai đoạn

| Phase | Nội dung | Phụ thuộc 027 |
|---|---|---|
| 0 | Nghiên cứu: trạng thái CLI tách được không; Landlock, sandbox-exec; đường dẫn chung còn sót | Không |
| 1 | Hub: sửa phân quyền, `machine_busy`, `orgName` | Không |
| 2 | Worker: `registry`, đường dẫn theo đăng ký, đăng ký cũ | Không (chỉ đọc `outbox.Identity`) |
| 3 | Worker: nhiều channel, scheduler | **Có**: `channel`, `outbox` |
| 4 | Worker: tài khoản, trạng thái CLI, env run, socket | **Có**: `localipc`, `runner.go` |
| 5 | Desktop Rust và UI | Phần đăng ký thêm/gỡ cần Phase 3 |
| 6 | Chính sách tổ chức (hub `governance`, web) | Không (nhưng `governance` đang khoá trong nhánh này) |
| 7 | Mức `tách-người-dùng`, sandbox đọc | Có (`runner.go`) |

## Rủi ro

| Rủi ro | Giảm |
|---|---|
| Claude Code trên macOS giữ đăng nhập trong Keychain theo băm của thư mục cấu hình, nên thư mục trạng thái riêng mất đăng nhập **[Unverified]** | T001 kiểm. Không tách được thì dùng symlink file trạng thái thay vì đổi thư mục, hoặc FR-041 câu cuối (tài khoản riêng) |
| Hai kênh cùng nhận đề nghị, tranh slot | Scheduler giữ khoá một chỗ trước khi trả `job_accept`; từ chối trả `machine_busy` |
| Đường dẫn chung còn sót (`~/.xdev-hive/memory/claude`, `~/.xdev-hive/context`, `optimizer`, `gitgroups.json`) | T004 liệt kê và gán mỗi đường dẫn một quyết định: theo đăng ký, theo máy, hay theo tài khoản |
| 027 đổi `channel.Config` cùng lúc | Các task phụ thuộc đánh dấu `[027]`; làm sau khi 027 merge |
| Cập nhật worker do một hub đẩy làm ngắt mọi hub | FR-064: hỏi chủ máy |

## Complexity Tracking

| Lệch | Vì sao cần | Cách đơn giản hơn bị loại vì |
|---|---|---|
| Một tiến trình N kênh thay vì N tiến trình | Chia slot và quota tài khoản cần bộ đếm chung (A1) | N tiến trình cần khoá chéo tiến trình cho quota, và `instancelock` hiện chặn |
| Spec, plan tiếng Việt | Quy ước repo | — |
