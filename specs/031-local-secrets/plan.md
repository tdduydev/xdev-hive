# Implementation Plan: Kho bí mật tại máy cho agent AI

**Branch**: `031-local-secrets` · **Date**: 2026-10-23 · **Spec**: [spec.md](spec.md) · **Research**: [research.md](research.md)

- Thiết kế dữ liệu: [data-model.md](data-model.md).
- Giao diện:
  - [contracts/sidecar-cli.md](contracts/sidecar-cli.md);
  - [contracts/tauri-commands.md](contracts/tauri-commands.md);
  - [contracts/policy-protocol.md](contracts/policy-protocol.md);
  - [contracts/agent-context.md](contracts/agent-context.md).
- Kiểm tay: [quickstart.md](quickstart.md).

Nhãn **[Unverified]**, **[Inference]** đánh dấu điều chưa kiểm trên máy thật. T001 kiểm các điểm nền tảng trước khi code
phụ thuộc vào chúng.

## Tóm tắt

**Worker** — thêm hai gói Go vào sidecar `hive-worker`:

- `worker/internal/secretstore`:
  - giữ giá trị trong kho hệ điều hành qua `go-keyring` đã có. Dịch vụ là `dev.xdev.hive.secrets`. Giá trị chia khối
    để đạt 8 KiB;
  - giữ danh mục `secrets.json` (tên, mô tả, ngày, `localId` dự án; không giá trị);
  - giữ nhật ký cấp `secret-grants.jsonl` (90 ngày);
  - có hàm `Grant` dùng chung cho run, terminal và `hive chat`. `Grant` áp chính sách, đọc kho một lần, ghi nhật ký và
    trả env cùng bộ che.
- `worker/internal/secretmask`: che giá trị và các dạng base64, base64url, URL-encode, JSON, shell-quote, nhiều dòng,
  trên luồng. Gói này thay bộ che riêng của `terminal/redact.go`.

**Runner**:

- bọc `Sink` để mọi Event được che trước khi ghi file chờ gửi hay gửi hub;
- đưa biến vào agent, lệnh kiểm và agent con;
- nối khối tên bí mật vào system prompt;
- chặn commit hay push có giá trị;
- báo hub chỉ số lượng (`report.secretsInjected`).

**Desktop**:

- `secrets.rs` gọi `hive-worker secrets …`, giá trị chỉ đi qua stdin (mẫu `ssh_keys.rs`);
- màn **Bí mật** trong nhóm Dự án;
- terminal mở từ desktop chạy qua `hive-worker secrets exec -- <argv>`, để giá trị không bao giờ nằm trong script tạm;
- hộp duyệt khi chính sách là `approve`.

**Hub, web, contracts**:

- trường `secretInjection` (`allow`/`approve`/`deny`) trong chính sách agent, `jobPolicy` và `welcome.policy`;
- mục mới trên `/admin/policies`;
- web hiện "Dùng N bí mật tại máy" trên trang run.

**Không đổi**:

- `checkEnvAllowed` (FR-017);
- `agents.rs` (chỉ đọc `ENV_KEYS`);
- `setup` script của run (research D4);
- phiên điều khiển từ xa (`term_start`), vốn không nhận bí mật (research D6);
- bảng hub: không migration.

## Technical Context

| Mục | Giá trị |
|---|---|
| Ngôn ngữ | Go (sidecar `hive-worker`), Rust (Tauri), TypeScript strict (desktop, hub, web, contracts) |
| Phụ thuộc mới | Go: không (`go-keyring v0.2.8` đã có). Rust: `tauri-plugin-clipboard-manager` cho Sao chép (US8). Xác thực hệ điều hành (crate `windows` WinRT, `objc2-local-authentication`) là task tuỳ chọn T039, chưa vào đường chính |
| Lưu trữ | Kho hệ điều hành: dịch vụ `dev.xdev.hive.secrets`. Máy, cạnh `projects.json`: `secrets.json`, `secret-grants.jsonl`, `secrets-policy.json`, `secret-approvals/`; `projects.json` thêm `localId`. Hub: không bảng, không cột mới (chính sách là JSON có sẵn) |
| Test | `go test` với `keyring.MockInit()`, repo git tạm, fixture chung `packages/contracts/fixtures/local-secrets.json` và `worker-protocol.json`; test tích hợp tag `keyringit` trên CI Windows và macOS; Rust test `secrets.rs` với sidecar giả; Vitest desktop và web; `policies.db.test.ts`; Playwright web cho mục chính sách |
| Hiệu năng | SC-008: `Grant` ≤500 ms với 10 bí mật (đo trong test tích hợp, không tính hộp thoại). Che luồng không làm log chậm quá 5% **[Inference]** (benchmark T005) |
| Nền tảng | Windows, macOS, Linux (Secret Service). Máy dev Windows không có Rust: phần Rust kiểm bằng CI |
| Ràng buộc | 0 byte giá trị trên đĩa, argv, log, hub (SC-004). Giá trị chỉ qua stdin/IPC (FR-009). Thay đổi chỉ áp cho phiên mới (FR-016) |

## Constitution Check

| Nguyên tắc | Cách tuân |
|---|---|
| I. Contract first | `policies.ts` (`secretInjection` trong `agentPolicyInput`, `jobPolicy`), `worker-protocol.ts` (`welcome.policy.secretInjection`), `local-secrets.ts` (tên dành riêng), fixture chung, `pnpm openapi`. Kiểu Go `JobPolicy`, `WelcomePolicy`, `Result.SecretsInjected` đọc cùng fixture. Mọi trường mới tuỳ chọn: hub cũ, worker cũ không vỡ. Sidecar JSON có kiểu TS ([contracts/sidecar-cli.md](contracts/sidecar-cli.md)) |
| II. Tenant isolation | Hub không lưu dữ liệu bí mật. Chính sách nằm trong `org_policies` đã có RLS. Đổi chính sách ghi `recordAudit` có sẵn. Không bảng mới |
| III. Module boundaries | Hub: `governance` (chính sách), `terminal` (welcome) và `runs` (job, đọc report) chỉ dùng nhau qua `index.ts`, như hiện nay (`jobPolicyOf` đã xuất) |
| IV. Tested | Test bảng cho tên, giá trị, khối kho, che (mọi dạng mã hoá, chia khối luồng, nhiều dòng), `Grant` (mọi nhánh chính sách và lỗi kho), chặn commit; test Go trên ba hệ điều hành; quét SC-004 trong test tích hợp |
| V. Secure by default | Không file thay thế khi kho lỗi (FR-062). Kho lỗi → run dừng (A4). `deny` khi chưa biết chính sách (FR-053). Phiên từ xa không nhận. Che trước khi ghi file chờ gửi |
| VI. Ngôn ngữ | Chữ giao diện, lỗi tiếng Việt (i18n vi/en). Code, commit tiếng Anh. Spec và plan tiếng Việt: **lệch** VI như 025–029, ghi ở Complexity Tracking |
| VII. Simple to self-host | Không thêm dịch vụ, không migration |
| Giao diện | `@xdev-hive/ui`, token màu, sáng/tối, 360 px, bàn phím (ô mật khẩu, hộp xác nhận có focus trap). Desktop dùng Vitest + Testing Library như các màn khác. Web dùng Playwright cho mục chính sách |

Kết quả: **đạt**, một lệch đã biết (VI). Kiểm lại sau thiết kế: không đổi.

## Kiến trúc

```
Desktop UI (màn Bí mật, hộp duyệt)
   │ invoke (giá trị một chiều vào)
   ▼
secrets.rs ── spawn sidecar, giá trị qua stdin ──▶ hive-worker secrets set|list|reveal|log|approve…
                                                     │
profiles.rs / git_groups.rs                          ▼
   └─ script tạm: "<hive-worker>" secrets exec      secretstore ── go-keyring ──▶ Credential Manager / Keychain /
        --project=<localId> -- <argv>  ─────────────▶  │                          Secret Service (dev.xdev.hive.secrets)
        (Grant → env → exec, không giá trị trên đĩa)    ├─ secrets.json (danh mục, không giá trị)
                                                       ├─ secret-grants.jsonl (nhật ký cấp)
Hub ── job_offer.spec.policy.secretInjection ──┐       ├─ secrets-policy.json (chính sách đã biết)
    └─ welcome.policy.secretInjection ─────────┤       └─ secret-approvals/ (hàng chờ duyệt)
                                               ▼
channel.localProject (localId) ─▶ runner: Grant ─▶ env agent + lệnh kiểm + agent con
                                    │             └▶ khối tên → system prompt / prompt
                                    ├─ secretSink(secretmask) bọc Sink ─▶ durableSink (file chờ) ─▶ hub
                                    ├─ chặn commit/push có giá trị
                                    └─ Result.SecretsInjected = N ─▶ run_result.report
terminal/local.go (hive chat, origin local) ─▶ Grant ─▶ cmd.Env + secretmask trong pump
```

## Cấu trúc file

Chia theo **bốn luồng**. Hai luồng không sửa cùng một file. File chung có chủ ghi ở [tasks.md](tasks.md) "Quy ước".

### Luồng A — worker Go

| File | Mới/sửa | Việc |
|---|---|---|
| `worker/internal/secretstore/{names.go,keyring.go,catalog.go,grants.go,policy.go,approvals.go,grant.go,context.go}` + `*_test.go`, `testdata/` | mới | Tên và dành riêng; khối kho; danh mục; nhật ký; chính sách đã biết; hàng duyệt; `Grant`; khối ngữ cảnh |
| `worker/internal/secretmask/{mask.go,stream.go}` + test, benchmark | mới | Bộ mẫu, che chuỗi, che luồng |
| `worker/internal/projects/projects.go` + test | sửa | `LocalID`, sinh khi thêm hay `Load`; `Unbind`/`UnbindFolder` trả `LocalID` đã gỡ |
| `worker/cmd/hive-worker/projects.go` | sửa | `projects unbind` gọi `secretstore.DropProject(localId)` (FR-063). Desktop gỡ dự án qua lệnh này (`local_projects.rs:61`), nên Rust không đổi |
| `worker/internal/runner/runner.go` | sửa | Gọi `Grant`, ghép env, bọc Sink, khối ngữ cảnh, chặn commit/push, `SecretsInjected` |
| `worker/internal/runner/secrets.go` + test | mới | `secretSink`, `scanDiffForSecrets`, ghép env có lọc tên dành riêng |
| `worker/internal/runner/checks.go` | sửa | Env lệnh kiểm cộng bí mật; `exact` cộng giá trị; dùng `secretmask` |
| `worker/internal/runner/hooks.go` | sửa | `JobPolicy.SecretInjection` |
| `worker/internal/runner/interactive.go` | sửa | `InteractiveSpec.SystemPrompt` nối khối |
| `worker/internal/channel/{channel.go,protocol.go,terminal.go}` | sửa | `localProject` gắn `LocalID`; `WelcomePolicy.SecretInjection`; ghi `secrets-policy.json` khi nhận welcome |
| `worker/internal/terminal/{local.go,redact.go}` | sửa | `Grant` cho phiên local; `redact.go` dùng `secretmask` |
| `worker/cmd/hive-worker/secrets.go` + test | mới | Lệnh `secrets …` và `secrets exec` |
| `worker/cmd/hive-worker/main.go` | sửa | Đăng ký lệnh `secrets` (một dòng) |

### Luồng B — desktop Rust

| File | Mới/sửa | Việc |
|---|---|---|
| `apps/desktop/src-tauri/src/secrets.rs` | mới | Lệnh Tauri ([contracts/tauri-commands.md](contracts/tauri-commands.md)), stdin, `wipe`, clipboard 30 giây |
| `apps/desktop/src-tauri/src/profiles.rs` | sửa | Bọc `Launch.argv` bằng `secrets exec` khi dự án có gán |
| `apps/desktop/src-tauri/src/git_groups.rs` | sửa | `open_folder_terminal` bọc cùng cách |
| `apps/desktop/src-tauri/src/lib.rs` | sửa | `mod secrets`, đăng ký lệnh, plugin clipboard |
| `apps/desktop/src-tauri/Cargo.toml`, `capabilities/app.json` | sửa | `tauri-plugin-clipboard-manager` và quyền |

### Luồng C — desktop UI

| File | Mới/sửa | Việc |
|---|---|---|
| `apps/desktop/src/lib/secrets.ts` + test | mới | Kiểu và hàm gọi lệnh Tauri; kiểm tên phía UI bằng `@xdev-hive/contracts/local-secrets` |
| `apps/desktop/src/screens/secrets-screen.tsx` + test | mới | Danh sách, thêm/sửa, gán dự án, xoá, hiện/sao chép, nhật ký, trạng thái kho |
| `apps/desktop/src/components/secret-approval-dialog.tsx` + test | mới | Hỏi `secret_approvals` mỗi 2 giây, hộp duyệt |
| `apps/desktop/src/shell/app-shell.tsx` | sửa | Gắn hộp duyệt |
| `apps/desktop/src/lib/nav.ts`, `screens/index.ts`, `lib/i18n.ts` | sửa | Mục menu "Bí mật" trong nhóm Dự án, không `needs` (FR-008); chữ vi/en |
| `apps/desktop/src/screens/projects-screen.tsx`, `settings-screen.tsx` | sửa | Số bí mật mỗi dự án và lối tới màn Bí mật; xoá dữ liệu app hỏi xoá bí mật (FR-064) |

### Luồng D — contracts, hub, web

| File | Mới/sửa | Việc |
|---|---|---|
| `packages/contracts/src/policies.ts` | sửa | `secretInjection` |
| `packages/contracts/src/worker-protocol.ts` | sửa | `welcome.policy.secretInjection` |
| `packages/contracts/src/local-secrets.ts`, `package.json` (exports), `fixtures/local-secrets.json` | mới/sửa | Tên dành riêng, kiểm tên, fixture chung |
| `packages/contracts/fixtures/worker-protocol.json`, `openapi.json` | sửa | Mẫu mới; `pnpm openapi` |
| `packages/contracts/src/runs.ts` | sửa | `RunResultView.secretsInjected?` **[Inference]**: tên kiểu xem lại khi làm |
| `apps/hub/src/modules/governance/policies.ts` + `policies.db.test.ts` | sửa | `jobPolicyOf`; test lưu, audit, snapshot |
| `apps/hub/src/modules/runs/engine.ts` | sửa | Điều kiện gửi `policy`; đọc `report.secretsInjected` |
| `apps/hub/src/modules/terminal/record.ts` | sửa | `welcome.policy.secretInjection` |
| `apps/web/src/pages/admin/policies-page.tsx` + Playwright | sửa | Mục "Bí mật tại máy" |
| `apps/web/src/pages/run-page.tsx` | sửa | "Dùng N bí mật tại máy" |

### Tài liệu (cuối, một agent)

- ADR mới `docs/adr/0038-local-secrets-keyring.md`. Nội dung: kho hệ điều hành, worker là chủ, chia khối, `secrets exec`,
  chỉ gửi số lượng.
- `docs/architecture.md`: gói `secretstore`, `secretmask`.
- `docs/srs.md`: FR của spec.

## Thiết kế từng phần

### 1. Kho và danh mục (US1, US9)

- `secretstore` có interface `backend { Get, Set, Delete }` bọc `go-keyring`, để test dùng `MockInit` và để
  `ErrLocked`/`ErrUnavailable` được phân loại theo hệ điều hành.
- Mọi lần ghi danh mục đi qua khoá file, như `projects.WithLock`.
- `set`: kiểm tên, giá trị và mô tả (`looksSecret`, chép từ `ctxsync`) → ghi kho → ghi danh mục.
  - Ghi danh mục lỗi → xoá mục kho vừa tạo nếu là bí mật mới.
- `delete`: xoá mọi khối trong kho trước, rồi mới gỡ danh mục.
  - Kho lỗi → giữ danh mục và báo lỗi, để không có mục mồ côi không ai thấy.
- `status`:
  - Linux: thử `Get` một khoá không tồn tại. `ErrNotFound` nghĩa là kho có; lỗi D-Bus nghĩa là không có.
  - Windows và macOS: luôn `available`.
  - `locked` là `null` khi không biết được.

### 2. Cấp cho phiên (US2, US3, US7)

- `Grant(ctx, GrantRequest{Kind, SessionID, LocalID, Policy, Interactive bool, Approve func(names) (bool, error)})`.
- Đọc giá trị song song tối đa 4 mục, giới hạn 5 giây mỗi mục. **[Inference]** Như vậy đủ cho SC-008.
- Biến trả về đã lọc tên dành riêng.
- Kiểm ≤24 KiB trên Windows (data-model §2).
- `Approve`:
  - run: chờ file trả lời trong `secret-approvals/`;
  - `secrets exec`: hỏi trong terminal;
  - `hive chat`: hỏi qua stdin của client. **[Inference]** Nếu localipc không hỗ trợ tương tác thì coi như `deny`, ghi
    trong task T021.
- `Grant` không bao giờ trả lỗi chứa giá trị. Lỗi của `go-keyring` được bọc lại bằng thông báo tiếng Việt, và chuỗi gốc
  bị bỏ. **[Inference]** Chuỗi gốc không chứa giá trị, nhưng bỏ để chắc chắn.

### 3. Che (US5)

- Xem research D7.
- `secretSink` đứng ngoài cùng: `runner` → `secretSink` → `durableSink`.
- Che xong, có thay đổi:
  - gọi `MarkLeaked` một lần mỗi tên mỗi run;
  - log tại máy `secret masked: NAME` (không giá trị).

### 4. Ngữ cảnh agent (US4)

Xem [contracts/agent-context.md](contracts/agent-context.md) và research D8.

### 5. Desktop (US1, US3, US6, US8)

- **Màn Bí mật**:
  - bảng tên, mô tả, dự án, ngày đổi; thêm, sửa ở sheet bên phải; xoá có xác nhận và cảnh báo `inUseBy` (FR-016);
  - tab Nhật ký có lọc;
  - banner khi `StoreStatus.available=false` (FR-062).
- Ô giá trị dùng `type=password`, `autoComplete="off"`. State bị xoá sau khi gửi.
- Lỗi sidecar hiện nguyên `message` tiếng Việt.

### 6. Hub và web (US7, FR-043)

Xem [contracts/policy-protocol.md](contracts/policy-protocol.md).

## Quyết định của người viết

Các quyết định này chưa được chủ dự án chốt. Mỗi mục kèm lý do ở research:

- worker là chủ kho (D1);
- chia khối kho (D2);
- setup script không nhận bí mật (D4);
- phiên từ xa không nhận (D6);
- số lượng đi trong `report`, không thêm `run_event` (D8b);
- duyệt bằng hàng chờ file và desktop hỏi mỗi 2 giây (D9);
- Hiện/Sao chép bản đầu chỉ dùng xác nhận trong app (D10).

## Rủi ro

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Giới hạn kích thước mục kho khác dự đoán **[Unverified]** | vừa | T001 kiểm. Nếu không đạt, hạ giới hạn trong spec (A10) |
| macOS bật hộp thoại keychain khi worker chạy nền | vừa | Giới hạn thời gian 5 giây → `store_locked`; desktop báo |
| Agent in giá trị trước khi che (A6) | cao, đã chấp nhận | Lời dặn trong khối, dấu leaked, chặn commit |
| Tên bí mật lọt vào log qua lệnh agent (A1 một phần) | thấp | Ghi trong quickstart; xử lý khi 027 bỏ `log_chunk` |
| Worker cũ ghi `projects.json` làm mất `localId` | thấp | Desktop và worker cập nhật cùng; gán mồ côi được hiện "dự án không còn" |
| Codex, Gemini terminal không có khối tên | thấp | Ghi rõ; khối vẫn có trong run worker |

## Complexity Tracking

| Lệch | Vì sao cần | Phương án đơn giản hơn bị bỏ vì |
|---|---|---|
| VI: spec, plan viết tiếng Việt | Chủ dự án yêu cầu tài liệu spec tiếng Việt (như 019–029) | Viết tiếng Anh: người duyệt chính đọc tiếng Việt |
| Chia giá trị thành nhiều mục kho | FR-005 yêu cầu 8 KiB, mục kho Windows và macOS có thể nhỏ hơn **[Unverified]** | Một mục: không đạt 8 KiB; file mã hoá: trái FR-001 |

## Phân đợt và ước lượng

Xem [tasks.md](tasks.md). Tóm tắt:

- **Đợt 0**: Setup, gồm T001 kiểm nền tảng.
- **Đợt 1**: Foundational, gồm contracts, `secretstore` lõi, `secretmask`, `localId`, lệnh sidecar.
- **Đợt 2–4**: theo user story, P1 trước.
- **Cuối**: tài liệu và quét SC-004.
