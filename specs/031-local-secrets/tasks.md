---
description: "Task list: kho bí mật tại máy cho agent AI"
---

# Tasks: Kho bí mật tại máy cho agent AI

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md)

## Quy ước

**Định dạng**: `- [ ] T### [P?] [USn?] <Luồng>·<Tier> — mô tả (file)`.

- **[P]**: chạy song song được với task khác trong cùng đợt. Hai task [P] không sửa chung file và không chờ task chưa
  xong.
- **Luồng**: mỗi luồng do một agent làm, để hai agent không sửa cùng một file.

  | Luồng | Phạm vi |
  |---|---|
  | **A** | worker Go chính: `secretstore`, `projects`, `runner`, `channel`, `cmd/hive-worker/secrets.go`, `main.go`, `projects.go` |
  | **A2** | worker Go phụ: `secretmask`, `terminal`, `projects`, `cmd/hive-worker/secrets_exec*.go`, và các file riêng `secretstore/context.go`, `secretstore/keyring_{darwin,windows,linux}.go` (cùng gói với A nhưng khác file) |
  | **B** | desktop Rust: `apps/desktop/src-tauri/**` |
  | **C** | desktop UI: `apps/desktop/src/**` |
  | **D** | contracts, hub, web: `packages/contracts/**`, `apps/hub/**`, `apps/web/**`, `openapi.json` |
  | **Điều phối** | người hoặc agent điều phối: kiểm tay trên máy thật (T001, T042), chỉ ghi `specs/031-local-secrets/` |

- **Tier** (CLAUDE.md):

  | Tier | Model |
  |---|---|
  | nặng | Opus `--effort high` |
  | vừa | Sonnet `--effort high` |
  | nhẹ | Sonnet `--effort medium` |

- **File chung có chủ** (nối tiếp theo thứ tự ghi):
  - `worker/internal/runner/runner.go`: T013 → T014 → T016 → T018 → T029. Chỉ luồng A.
  - `worker/internal/secretstore/grant.go`: T012 → T028.
  - `worker/cmd/hive-worker/secrets.go`: T007 → T022 → T030 → T036.
  - `apps/desktop/src-tauri/src/secrets.rs`, `lib.rs`: T008 → T023 → T031 → T037.
  - `apps/desktop/src/screens/secrets-screen.tsx`: T010 → T024 → T034 → T038.
  - `packages/contracts/fixtures/worker-protocol.json`, `openapi.json`: T026, rồi T025.
- **Mỗi task kèm test trong cùng commit.** Viết test trước, thấy test hỏng, rồi mới viết code.
- **Kiểm theo loại**:
  - Go: trong `worker/` chạy `gofmt -l .`, `go vet ./...`, `GOOS=windows go vet ./...`, `GOOS=darwin go vet ./...`,
    `go test ./internal/<gói>/...`.
  - Rust: `cargo test --locked` trong `apps/desktop/src-tauri`. Máy dev Windows không có Rust, CI kiểm.
  - Desktop và web: typecheck và Vitest của package đã sửa; Playwright chỉ chạy spec liên quan.
  - Hub: `policies.db.test.ts`; `pnpm deps`; `pnpm openapi` khi sửa contracts.
  - Biome: chỉ chạy trên file đã sửa.
- **Dữ liệu thật**: test chỉ dùng giá trị giả, `keyring.MockInit()` và repo git tạm. Không dùng khoá thật.
- **Giả định**: các quyết định ở plan.md "Quyết định của người viết" chưa được chủ dự án chốt. Đổi quyết định nào thì sửa
  task tương ứng trước khi giao.

---

## Phase 1: Setup

- [ ] T001 [P] Điều phối·nhẹ — Kiểm nền tảng theo [quickstart.md](quickstart.md) mục 1 trên Windows và macOS, ghi mục
  "Kết quả kiểm" vào `specs/031-local-secrets/research.md`:
  - cỡ khối tối đa của `go-keyring` mỗi hệ điều hành (D2);
  - macOS keychain khoá thì `security` có bật hộp thoại không, và hết giờ sau 5 giây có được không (D4);
  - `tauri-plugin-clipboard-manager` đọc lại clipboard được không (D10);
  - claude nhận `--append-system-prompt` trong terminal; codex và gemini có cờ tương đương không (D8);
  - Linux không có Secret Service thì `go-keyring` trả lỗi gì.

  Kết quả "không đạt" thì sửa plan và task liên quan trước Phase 2.

  Tiến độ: cỡ khối trên Windows đã kiểm (2560 byte mỗi mục, khối 1800 byte đạt). macOS và các điểm còn lại chưa kiểm.
- [ ] T002 [P] D·nhẹ — Tên dành riêng và kiểm tên dùng chung Go ↔ TS:
  - fixture mới `packages/contracts/fixtures/local-secrets.json` (reserved exact/prefixes, tên hợp lệ, không hợp lệ);
  - `packages/contracts/src/local-secrets.ts` (`RESERVED_SECRET_NAMES`, `isValidSecretName`, `isReservedSecretName`,
    `normalizeSecretName`);
  - export `./local-secrets` trong `packages/contracts/package.json`;
  - test `packages/contracts/src/local-secrets.test.ts`.

  Danh sách đúng theo FR-004: `HIVE_*`, `PATH`, `HOME`, `USER`, `USERNAME`, `USERPROFILE`, `SHELL`, `COMSPEC`, `TEMP`,
  `TMP`, `TMPDIR`, `PATHEXT`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `GIT_*`, `SSH_*`, `ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_*`,
  `CODEX_*`, `GEMINI_*`.

---

## Phase 2: Foundational (chặn mọi user story)

- [x] T003 A·nặng — Gói `worker/internal/secretstore`, phần tên và kho:
  - `names.go`: `ValidName`, `Reserved`, `ValidValue`, theo FR-003 và FR-005 ("dài 8 ký tự đến 8 KiB, không chứa byte
    NUL, và có thể chứa xuống dòng"). Test đọc `packages/contracts/fixtures/local-secrets.json`.
  - `keyring.go`: interface `backend{Get,Set,Delete}` bọc `go-keyring`; dịch vụ `dev.xdev.hive.secrets`; chia khối
    `v1:<n>:<b64>` và `<NAME>#k` theo [data-model.md](data-model.md) §1 (ghi khối cuối trước, xoá khối thừa); lỗi
    `ErrNotFound`, `ErrLocked`, `ErrUnavailable`, `ErrCorrupt`. Thông báo tiếng Việt không chứa giá trị (FR-036).
  - Test với `keyring.MockInit()`: giá trị 8192 byte nhiều dòng, có `'`, `"`, `$`, Unicode; khớp từng byte (FR-013);
    rút ngắn giá trị xoá khối thừa; khối thiếu trả `ErrCorrupt`.

  Sau T002.
- [x] T004 A·vừa — `worker/internal/secretstore/{catalog.go,grants.go}`:
  - danh mục `secrets.json` (version 1, khoá file, ghi nguyên tử 0600; FR-002: "KHÔNG ĐƯỢC chứa giá trị, băm của giá trị
    hay độ dài giá trị");
  - tối đa 64 gán mỗi `localId`;
  - mô tả ≤500 ký tự, quét bằng `looksSecret`, chép từ `worker/internal/ctxsync/secrets.go` (FR-021), có test dùng chung
    fixture `packages/contracts/fixtures/secret-scan.json`;
  - nhật ký `secret-grants.jsonl`: `Append`, `MarkLeaked` (dòng `kind:"leak"`), `Read(filter)` gộp leaked và nhãn
    `deleted`, cắt tỉa 90 ngày hoặc 10 000 dòng, `Clear` (data-model §4).

  Sau T003.
- [x] T005 [P] A2·nặng — Gói mới `worker/internal/secretmask/{mask.go,stream.go}`:
  - `New(values)` với các dạng: gốc, base64 std/raw/url/rawurl, `url.QueryEscape`/`PathEscape`, JSON escape, shell-quote
    đơn và kép, khối nhiều dòng `\n`/`\r\n`, từng dòng ≥8 byte (FR-031, FR-033);
  - mặt nạ mặc định `[đã che]`, tuỳ chọn `***`;
  - `String(s) (string, []int)` trả chỉ số giá trị bị che;
  - `Writer` che luồng, giữ đuôi giữa hai lần ghi (FR-032).
  - Test bảng gồm giá trị bị cắt đôi qua hai khối, và giá trị ngắn hơn 8 không bị che. Có benchmark 16 KiB/khối.

  Không phụ thuộc task khác.
- [x] T006 [P] A2·vừa — `worker/internal/projects/projects.go`:
  - thêm `LocalID string \`json:"localId"\``, 16 hex ngẫu nhiên, sinh trong `AddFolder`, `Bind`;
  - `Load` gặp dòng thiếu thì sinh trong `WithLock` và ghi lại;
  - `Unbind` và `UnbindFolder` trả `LocalID` đã gỡ;
  - `FindLocal(list, localID)`, `FindFolder(list, dir)` (cwd nằm trong `Folder`).
  - Test: `localId` ổn định qua `Load`, đổi `Folder` vẫn giữ (FR-010).

  Làm song song với T003 được: khác gói.

**Checkpoint**: lõi kho, danh mục, nhật ký, bộ che, `localId` đã xong. Các user story bắt đầu được.

---

## Phase 3: User Story 1 — Thêm, sửa, xoá bí mật trong app desktop (P1) 🎯 MVP

**Goal**: người dùng quản lý bí mật trên màn Bí mật khi chưa đăng nhập Hive. Giá trị chỉ nằm trong kho.

**Independent Test**: [quickstart.md](quickstart.md) mục 2.

- [x] T007 [US1] A·vừa — Lệnh sidecar quản lý trong file mới `worker/cmd/hive-worker/secrets.go`, gồm `status`, `list`,
  `set`, `rename`, `describe`, `assign`, `unassign`, `delete`, theo [contracts/sidecar-cli.md](contracts/sidecar-cli.md).
  - Giá trị đọc từ stdin `{"value"}` (FR-009).
  - Mã lỗi theo bảng của contract.
  - `delete` xoá kho trước rồi mới gỡ danh mục.
  - Đăng ký lệnh trong `worker/cmd/hive-worker/main.go` (một dòng).
  - `projects unbind` trong `worker/cmd/hive-worker/projects.go` gọi `secretstore.DropProject` (FR-063).
  - Fixture JSON ra `worker/internal/secretstore/testdata/cli/*.json`.
  - Test: tham số không bao giờ nhận giá trị; stdout lỗi không chứa giá trị.

  Sau T004, T006.
- [ ] T008 [P] [US1] B·vừa — File mới `apps/desktop/src-tauri/src/secrets.rs` với `secrets_status`, `secrets_list`,
  `secret_save`, `secret_rename`, `secret_assign`, `secret_delete`.
  - Theo mẫu `ssh_keys.rs`: `spawn`, `child.write` giá trị, đóng stdin, `wipe`.
  - Mô tả đi qua file tạm, xoá sau khi chạy.
  - Đăng ký trong `apps/desktop/src-tauri/src/lib.rs`.
  - Test dựng tham số; test giá trị không có trong argv.

  Viết theo contract, chạy song song với T007.
- [ ] T009 [P] [US1] C·vừa — File mới `apps/desktop/src/lib/secrets.ts`:
  - kiểu `StoreStatus`, `SecretItem`, `ReservedNames`, `GrantEntry`, `ApprovalRequest`;
  - hàm gọi lệnh Tauri;
  - kiểm tên phía UI bằng `@xdev-hive/contracts/local-secrets`.
  - Test `apps/desktop/src/lib/secrets.test.ts` khớp fixture `worker/internal/secretstore/testdata/cli/*.json`.
    Nếu T007 chưa xong, dùng mẫu trong contract.
- [ ] T010 [US1] C·vừa — Màn mới `apps/desktop/src/screens/secrets-screen.tsx` và test:
  - bảng tên, mô tả, dự án, ngày đổi;
  - sheet thêm và sửa: ô giá trị `type=password`, `autoComplete="off"`, xoá state sau khi gửi (FR-007);
  - gán dự án từ `local-projects.ts`;
  - xoá có xác nhận; cảnh báo `inUseBy` (FR-016);
  - danh sách tên dành riêng xem được (FR-004);
  - đạt 360 px, sáng/tối, dùng được bằng bàn phím.

  Đăng ký `secrets` trong `apps/desktop/src/screens/index.ts`. Thêm mục "Bí mật" vào nhóm Dự án trong
  `apps/desktop/src/lib/nav.ts`, không đặt `needs` (FR-008). Thêm chữ vi/en vào `apps/desktop/src/lib/i18n.ts`.

  Sau T009.
- [ ] T011 [US1] C·nhẹ — `apps/desktop/src/screens/projects-screen.tsx`: mỗi dự án hiện số bí mật gán và nút tới màn
  Bí mật (lọc theo dự án). Kèm test.

  Sau T010.

**Checkpoint**: US1 chạy độc lập. Bí mật lưu và gán được, nhưng chưa đưa vào phiên.

---

## Phase 4: User Story 2 — Run của worker nhận bí mật qua biến môi trường (P1) 🎯 MVP

**Goal**: run cho dự án có gán thấy đúng biến. Run của dự án khác không thấy. Kho lỗi thì dừng trước spawn.

**Independent Test**: [quickstart.md](quickstart.md) mục 3 bước 1 và 4.

- [x] T012 [US2] A·nặng — File mới `worker/internal/secretstore/grant.go`, hàm `Grant(ctx, GrantRequest)`. Bản này chỉ
  có nhánh `allow`; `approve` và `deny` thêm ở T028.
  - Đọc danh mục theo `localId`, đọc mọi giá trị trong một lần (tối đa 4 song song, 5 giây mỗi mục).
  - Lọc tên dành riêng; kiểm ≤24 KiB trên Windows (`ErrEnvTooLarge`).
  - Ghi dòng nhật ký `outcome`.
  - Trả `Grant{ID, Env map, Values []string, Names []string}`.
  - Lỗi kho trả lỗi có `Names` (FR-060): "dừng trước khi tạo tiến trình agent với lý do và cách sửa bằng tiếng Việt, chỉ
    tên bí mật thiếu, không giá trị".
  - Test: SC-008 (10 bí mật ≤500 ms với backend giả có trễ); dự án không gán thì không ghi nhật ký.

  Sau T004, T006.
- [x] T013 [US2] A·nặng — Nối `Grant` vào runner.
  - `worker/internal/channel/channel.go`: `localProject` gắn `LocalID` vào job (trường mới `runner.Job.LocalID`); job
    sandbox hay runner-host để rỗng (FR-018).
  - `worker/internal/runner/hooks.go`: `JobPolicy.SecretInjection string json:"secretInjection,omitempty"`.
  - `worker/internal/runner/runner.go`:
    - gọi `Grant` trước khi tạo tiến trình agent;
    - ghép `mergeEnv(os.Environ(), mergeMap(savingEnv, job.Env, granted))`, rồi env tài khoản như cũ (FR-014);
    - lỗi → `Result.Error` tiếng Việt, không spawn;
    - `Result.SecretsInjected`.
  - File mới `worker/internal/runner/secrets.go`: ghép env có lọc tên dành riêng.
  - `worker/internal/runner/checks.go`: env lệnh kiểm cộng biến đã cấp, `exact` cộng giá trị. Giữ nguyên
    `checkEnvAllowed` (FR-017).
  - `runSetup` không nhận bí mật (research D4).
  - Test:
    - agent giả in env: có biến của dự án, không có biến của dự án khác (SC-002);
    - kho khoá thì run dừng trước spawn trong 5 giây (SC-006);
    - agent con thừa kế env (FR-018).

  Sau T012.

**Checkpoint**: US1 và US2 đủ để agent dùng bí mật trong run. Che chưa xong, nên chưa phát hành tới khi xong US5.

---

## Phase 5: User Story 5 — Che giá trị khỏi log, transcript, artifact và hub (P1) 🎯 MVP

**Goal**: 0 lần giá trị rời máy hay nằm trong log tại máy, dưới 5 dạng (SC-003).

**Independent Test**: [quickstart.md](quickstart.md) mục 3 bước 1–3.

- [x] T014 [US5] A·nặng — Bọc Sink và che mọi Event.
  - `worker/internal/runner/secrets.go`: `secretSink` bọc `Sink`, che `Data` log (dùng `secretmask.Writer` theo
    `Stream`), `Result.Error`, đuôi `Commands`, `Artifacts`, `Subagent.Description`, `Steer`, báo cáo agent.
  - Khi có che: `MarkLeaked` một lần mỗi tên, và log tại máy `secret masked: NAME`.
  - `runner.go` đặt `secretSink` ngoài cùng, trước `durableSink` (FR-035).
  - `checks.go`: `redactSecrets` dùng thêm `secretmask` cho đuôi output.
  - Artifact (FR-034): file text được che; file nhị phân chứa giá trị gốc bị giữ lại, kèm sự kiện cảnh báo.
  - Test:
    - agent giả in giá trị dưới 5 dạng, cắt qua hai khối 16 KiB;
    - file chờ gửi trong pending dir không chứa giá trị;
    - nhật ký có `leaked`.

  Sau T013 và T005.
- [x] T015 [P] [US5] A2·vừa — `worker/internal/terminal/redact.go` dùng `secretmask` (mặt nạ `***` giữ như cũ). Test cũ
  của terminal phải xanh, thêm test base64 và JSON.

  Sau T005.
- [x] T016 [US5] A·vừa — FR-038, chặn commit và push có giá trị.
  - File `worker/internal/runner/secrets.go` có hàm `scanDiffForSecrets(work, base, masker)`. Hàm quét
    `git diff --cached -z` và `git log -p <base>..HEAD`.
  - `runner.go` gọi hàm trước bước commit của worker và trước `gitRetryLocked(…"push"…)`.
  - Thấy giá trị → `Result.Error` "Thay đổi chứa giá trị của bí mật X; đã chặn commit/đẩy.", và đánh dấu leaked.
  - Test bằng repo git tạm: một commit của agent chứa giá trị, một commit chứa base64 của giá trị.

  Sau T014.

**Checkpoint**: MVP an toàn để phát hành nội bộ (cùng với US4).

---

## Phase 6: User Story 4 — Agent biết có những tên biến nào (P1) 🎯 MVP

**Goal**: agent dùng biến theo tên, không hỏi người dùng. Không file repo nào bị ghi.

**Independent Test**: [quickstart.md](quickstart.md) mục 3 bước 1 (agent không hỏi giá trị, SC-005).

- [x] T017 [P] [US4] A2·vừa — File mới `worker/internal/secretstore/context.go`, hàm `ContextBlock(policy, items)` theo
  [contracts/agent-context.md](contracts/agent-context.md).
  - Mô tả được quét lại; mô tả không đạt thì bỏ, giữ tên.
  - Tối đa 64 mục; mô tả cắt ở 200 ký tự.
  - Test golden cho khối có bí mật và khối "không có bí mật".

  Sau T004. Khác file với T012, nên A2 làm song song được.
- [x] T018 [US4] A·vừa — Đưa khối vào agent.
  - `worker/internal/runner/runner.go`: claude có `packInSystemPrompt` thì nối khối vào file
    `--append-system-prompt-file`; CLI khác thì ghép vào đầu `job.Prompt` sau gói ngữ cảnh.
  - `worker/internal/runner/interactive.go`: nối `InteractiveSpec.SystemPrompt`.
  - Test: khối có trong file gói hay prompt; không file nào trong repo tạm đổi (FR-022: "KHÔNG ĐƯỢC ghi tên bí mật vào
    file của repo (`AGENTS.md`, `CLAUDE.md`, `.mcp.json`)").

  Sau T017 và T016.

**Checkpoint**: MVP đủ (US1, US2, US5, US4). Phát hành được cho run của worker.

---

## Phase 7: User Story 3 — Terminal và phiên agent mở từ desktop nhận bí mật (P1)

**Goal**: terminal claude, codex, gemini và shell mở từ desktop có biến đúng từng byte trên ba hệ điều hành. Script tạm
không chứa giá trị.

**Independent Test**: [quickstart.md](quickstart.md) mục 4.

- [ ] T019 [US3] A2·nặng — Lệnh `secrets exec`.
  - File mới `worker/cmd/hive-worker/secrets_exec.go`, `secrets_exec_unix.go` (`syscall.Exec`),
    `secrets_exec_windows.go` (tiến trình con cùng console, chờ, trả mã thoát).
  - Trình tự: `Grant` kind `terminal`; nếu `--cli claude` thì thêm `--append-system-prompt <khối>`.
  - Truyền callback `Approve` hỏi `Đưa N bí mật (A, B) vào phiên này? [c/K]` trong terminal. Nhánh `approve` của
    `Grant` có ở T028; trước đó callback không được gọi.
  - Kho lỗi: in lý do ra stderr, chờ Enter, thoát mã 78.
  - Dự án không gán thì chạy `argv` ngay.
  - Đăng ký nhánh `exec` từ `secrets.go`: chỉ một dòng gọi `runSecretsExec`. Báo người giữ T007 hoặc làm sau T007.
  - Test: tiến trình con in env khớp byte (giá trị có xuống dòng, nháy, `$`, Unicode); argv con không chứa giá trị.

  Sau T012, T017.
- [ ] T020 [P] [US3] B·vừa — Bọc argv ở desktop.
  - `apps/desktop/src-tauri/src/profiles.rs`: `cli_launch`, `agent_launch` bọc `Launch.argv` bằng
    `[<sidecar>, "secrets", "exec", "--project=<localId>", "--kind=terminal", "--cli=<cli>", "--", …]` khi dự án có gán.
    `localId` tìm theo `folder` qua `secrets list`/`projects --json`.
  - `apps/desktop/src-tauri/src/git_groups.rs`: `open_folder_terminal` bọc cùng cách.
  - `sh_script` và `cmd_script` không thêm dòng `export`/`set` nào cho bí mật (FR-015).
  - Test: script sinh ra không chứa giá trị; trích dẫn argv đúng trên sh và cmd.

  Viết theo contract, chạy song song với T019.
- [ ] T021 [US3] A2·vừa — `worker/internal/terminal/local.go`: phiên `origin=local` (`hive chat`) có
  `CreateParams.ProjectID`, hoặc cwd khớp `FindFolder`, thì gọi `Grant` kind `terminal`.
  - Biến thêm vào `cmd.Env` sau `runner.LocalEnv`; giá trị thêm vào bộ che của `pump`.
  - Phiên `term_start` từ xa không nhận (research D6).
  - Test: phiên local có biến; phiên remote không có; bản ghi gửi hub đã che.

  Sau T015, T012.

---

## Phase 8: User Story 6 — Nhật ký cấp bí mật tại máy (P2)

**Goal**: trả lời "bí mật X đã đưa cho run nào" trong 30 giây (SC-007). Hub chỉ biết số lượng (FR-043).

**Independent Test**: [quickstart.md](quickstart.md) mục 3 bước 2 (nhật ký và "Dùng 1 bí mật tại máy").

- [ ] T022 [US6] A·nhẹ — `worker/cmd/hive-worker/secrets.go`: thêm `secrets log [--name] [--project] [--limit]` và
  `secrets log clear` (FR-042). Fixture `testdata/cli/log.json`.

  Sau T007, T004.
- [ ] T023 [P] [US6] B·nhẹ — `apps/desktop/src-tauri/src/secrets.rs`: `secrets_log`, `secrets_log_clear`. Đăng ký ở
  `lib.rs`.

  Sau T008.
- [ ] T024 [P] [US6] C·vừa — Tab Nhật ký trong `apps/desktop/src/screens/secrets-screen.tsx`:
  - lọc theo bí mật và dự án;
  - nhãn "đã xoá" (FR-044) và "giá trị xuất hiện trong output" (FR-037);
  - nút xoá toàn bộ, có xác nhận.

  Thêm chữ vào `i18n.ts`. Kèm test. Sau T010.
- [ ] T025 [P] [US6] D·vừa — Hub nhận số lượng.
  - `packages/contracts/src/runs.ts`: `secretsInjected?: number` trong kiểu xem kết quả run.
    **[Inference]** Tên kiểu chính xác xem lại khi làm.
  - `apps/hub/src/modules/runs/engine.ts` hoặc `queries.ts`: đọc `report.secretsInjected` (int 0–64).
  - `apps/web/src/pages/run-page.tsx`: "Dùng N bí mật tại máy" khi N > 0.
  - Fixture `packages/contracts/fixtures/worker-protocol.json` có `run_result.report.secretsInjected: 2`.
  - Chạy `pnpm openapi`.
  - Test: hub không lưu trường nào khác về bí mật.

  Sau T026 (fixture chung).

---

## Phase 9: User Story 7 — Chính sách tổ chức về đưa bí mật vào agent (P2)

**Goal**: quản trị chọn `allow`, `approve` hoặc `deny`. Máy làm theo, kể cả khi offline (FR-053).

**Independent Test**: [quickstart.md](quickstart.md) mục 5.

- [ ] T026 [US7] D·vừa — Contracts.
  - `packages/contracts/src/policies.ts`:
    - `secretInjection = z.enum(["allow","approve","deny"])`;
    - `agentPolicyInput.secretInjection.default("allow")`;
    - `DEFAULT_AGENT_POLICY`;
    - `jobPolicy.secretInjection.optional()`.
  - `packages/contracts/src/worker-protocol.ts`: `welcome.policy.secretInjection.optional()`.
  - Fixture `packages/contracts/fixtures/worker-protocol.json`: `welcome` có `secretInjection: "approve"`; `job_offer`
    có `spec.policy.secretInjection: "deny"`.
  - Chạy `pnpm openapi`. Thêm test contracts.

  Không phụ thuộc task khác, nên làm ngay từ Phase 2.
- [ ] T027 [US7] D·vừa — Hub.
  - `apps/hub/src/modules/governance/policies.ts`: `jobPolicyOf` thêm trường.
  - `apps/hub/src/modules/runs/engine.ts`: gửi `policy` khi
    `hooks.length || managedHooksOnly || secretInjection !== "allow"`.
  - `apps/hub/src/modules/terminal/record.ts`: `welcome.policy.secretInjection`.
  - Test `apps/hub/src/modules/governance/policies.db.test.ts`:
    - lưu có ghi `recordAudit`;
    - dòng cũ thiếu trường đọc ra `allow`;
    - `policy_snapshot` có trường.

  Sau T026.
- [ ] T028 [US7] A·nặng — Chính sách và duyệt ở worker.
  - File mới `worker/internal/secretstore/policy.go` (`secrets-policy.json` theo hub) và `approvals.go`
    (`secret-approvals/<id>.json`, hạn 120 giây, dọn file quá hạn).
  - `grant.go`:
    - nhánh `deny`: không đọc kho, `outcome=denied`;
    - nhánh `approve`: gọi `Approve` callback; từ chối → `declined`, hết hạn → `timeout`, chạy không bí mật (FR-051);
    - chưa biết chính sách: dự án liên kết → `deny`, chưa liên kết → `allow` (FR-053).
  - `worker/internal/channel/protocol.go`: `WelcomePolicy.SecretInjection`.
  - `worker/internal/channel/terminal.go`: nhận welcome thì ghi `secrets-policy.json`.
  - Test Go đọc fixture `worker-protocol.json` của T026; test mọi nhánh.

  Sau T012, T026.
- [ ] T029 [US7] A·vừa — `worker/internal/runner/runner.go`: `approve` cho run nền chờ file trả lời. Run ghi sự kiện
  chính sách, và khối ngữ cảnh "không có bí mật" khi `deny`, `declined` hoặc `timeout`. Test.

  Sau T028, T018.
- [ ] T030 [US7] A·nhẹ — `worker/cmd/hive-worker/secrets.go`: `secrets approvals`, `secrets approve --id --allow|--deny`.
  Phần hỏi `[c/K]` trong terminal thuộc T019 (file của A2), không sửa ở đây.

  Sau T028, T022.
- [ ] T031 [P] [US7] B·nhẹ — `apps/desktop/src-tauri/src/secrets.rs`: `secret_approvals`, `secret_approve`. Đăng ký ở
  `lib.rs`.

  Sau T023.
- [ ] T032 [P] [US7] C·vừa — File mới `apps/desktop/src/components/secret-approval-dialog.tsx` và test.
  - Hỏi `secret_approvals` mỗi 2 giây.
  - Hộp thoại liệt kê tên và dự án, không giá trị; nút mặc định là Từ chối.
  - Gắn vào `apps/desktop/src/shell/app-shell.tsx`.
  - Chữ vi/en ở `i18n.ts`.

  Sau T009.
- [ ] T033 [P] [US7] D·vừa — `apps/web/src/pages/admin/policies-page.tsx`: mục "Bí mật tại máy" với nhóm radio "Cho
  phép" / "Hỏi trước" / "Không cho"; chỉ xem khi thiếu quyền `policies.write`. Kèm test Playwright web theo vai trò và
  tên.

  Sau T027.

---

## Phase 10: User Story 9 — Kho bí mật khoá hoặc không có (P2)

**Goal**: kho lỗi thì run dừng với lý do tiếng Việt. Hộp mở khoá hiện nhiều nhất một lần. Không có file thay thế.

**Independent Test**: [quickstart.md](quickstart.md) mục 6.

- [ ] T034 [US9] C·nhẹ — `apps/desktop/src/screens/secrets-screen.tsx`:
  - banner khi `StoreStatus.available=false` hoặc `locked=true`, có cách sửa (FR-062);
  - dòng có `missingInStore` hiện "Kho thiếu giá trị, hãy đặt lại".

  Kèm test. Sau T024.
- [ ] T035 [US9] A2·vừa — Phân loại lỗi kho theo hệ điều hành.
  - File mới `worker/internal/secretstore/keyring_{darwin,windows,linux}.go`.
  - Giới hạn 5 giây. Worker không có phiên người dùng thì không gọi API bật hộp thoại (FR-061).
  - `status` trên Linux thử D-Bus.
  - Test tích hợp tag `keyringit` (`worker/internal/secretstore/keyring_integration_test.go`): giá trị 8 KiB nhiều dòng,
    đo SC-008.
  - Thêm bước `go test -tags keyringit ./internal/secretstore/...` vào job Worker Go macOS và Windows của
    `.github/workflows/ci.yml`.
    **[Unverified]** keychain của runner CI mở khoá sẵn; T001 hoặc lần chạy CI đầu kiểm.

  Sau T003, T001.

---

## Phase 11: User Story 8 — Xem lại giá trị, đổi giá trị, gỡ máy (P3)

**Goal**: Hiện/Sao chép có xác nhận, tự ẩn và tự xoá clipboard. Có vòng đời khi gỡ dự án, đăng xuất và xoá dữ liệu.

**Independent Test**: [quickstart.md](quickstart.md) mục 7.

- [ ] T036 [US8] A·nhẹ — `worker/cmd/hive-worker/secrets.go`:
  - `secrets reveal [--copy]`: ghi dòng `reveal`, `copy` (FR-041);
  - `secrets purge --project|--all`: trả `removed` và `left` (FR-064).

  Test: chỉ `reveal` in giá trị ra stdout. Sau T030.
- [ ] T037 [US8] B·vừa — `apps/desktop/src-tauri/src/secrets.rs`:
  - `secret_reveal`;
  - `secret_copy`: Rust đặt clipboard, giữ bản so sánh, sau 30 giây xoá nếu chưa đổi, rồi `wipe`;
  - `secrets_purge`.

  Thêm `tauri-plugin-clipboard-manager` vào `apps/desktop/src-tauri/Cargo.toml`, quyền vào `capabilities/app.json`,
  đăng ký ở `lib.rs`. Kèm test. Sau T031.
- [ ] T038 [US8] C·vừa — UI.
  - `apps/desktop/src/screens/secrets-screen.tsx`:
    - nút Hiện và Sao chép có hộp xác nhận, nút mặc định là Huỷ;
    - giá trị chỉ ở state của dòng, tự ẩn sau 10 giây hoặc khi rời màn (FR-052);
    - không đưa vào query cache.
  - `apps/desktop/src/screens/settings-screen.tsx`: xoá dữ liệu app thì hỏi xoá mọi bí mật; không chọn thì liệt kê mục
    còn lại (FR-064).
  - Đăng xuất hay gỡ liên kết máy hỏi xoá gán cho dự án của tổ chức, mặc định giữ (FR-063). **[Inference]** Luồng đăng
    xuất nằm trong `settings-screen.tsx` hoặc `apps/desktop/src/lib/account.ts`; xem lại khi làm.
  - Kèm test. Sau T034, T037.
- [ ] T039 [P] [US8] B·nặng — (Tuỳ chọn, có thể để sau) Xác thực lại của hệ điều hành trước Hiện/Sao chép.
  - Windows: `UserConsentVerifier` (crate `windows`).
  - macOS: `LocalAuthentication`.
  - Không có thì dùng hộp xác nhận.
  - File mới `apps/desktop/src-tauri/src/os_auth.rs`.
  - Thêm phụ thuộc mới vào `Cargo.toml`: cần chủ dự án duyệt trước.

  Sau T037.

---

## Phase 12: Polish và việc chung

- [ ] T040 [P] D·nhẹ — Tài liệu:
  - ADR mới `docs/adr/0038-local-secrets-keyring.md` (kho hệ điều hành, worker là chủ, chia khối, `secrets exec`, chỉ
    gửi số lượng);
  - `docs/architecture.md`: gói `secretstore`, `secretmask`;
  - `docs/srs.md`: FR của spec 031.

  Không sửa `docs/decisions.md`.
- [ ] T041 A·vừa — Test quét SC-004 trong `worker/internal/secretstore/sc004_test.go`.
  - Chạy chuỗi set → assign → Grant run giả → reveal → delete với backend giả.
  - Quét mọi file trong thư mục cấu hình tạm và pending dir giả.
  - Mong đợi: 0 byte giá trị, 0 byte base64 của giá trị.

  Sau T014, T036.
- [ ] T042 Người điều phối·nhẹ — Chạy [quickstart.md](quickstart.md) mục 2–7 trên Windows và macOS. Ghi kết quả, và cập
  nhật "Rủi ro đã biết" nếu có gì mới.

  Sau mọi task.

---

## Dependencies & Execution Order

```
Phase 1:  T001 ─────────────────────────────────────────────┐ (kết quả có thể đổi T003, T037, T035)
          T002 ─▶ T003 ─▶ T004 ─┬─▶ T007 ─▶ T022 ─▶ T030 ─▶ T036
Phase 2:  T005 (A2) ─────────┐  ├─▶ T012 ─▶ T013 ─▶ T014 ─▶ T016 ─▶ T018 ─▶ T029
          T006 ──────────────┼──┘        │                                 ▲
                             │           └─▶ T028 ◀── T026 ─▶ T027 ─▶ T033  │
                             │                 └───────────────────────────┘
A2:       T005 ─▶ T015 ─▶ T021;  T004 ─▶ T017 ─▶ T019
B:        T008 ─▶ T023 ─▶ T031 ─▶ T037 ─▶ (T039);  T020 (sau contract, bất kỳ lúc nào)
C:        T009 ─▶ T010 ─▶ T011;  T010 ─▶ T024 ─▶ T034 ─▶ T038;  T009 ─▶ T032
D:        T002;  T026 ─▶ T027 ─▶ T033;  T026 ─▶ T025;  T040
Cuối:     T041, T042
```

- User story phụ thuộc Phase 2. US2, US5 và US4 phải xong cùng nhau mới phát hành, vì đưa biến mà chưa che là không an
  toàn.
- US3 cần T012 (`Grant`) và T017 (khối).
- US7 phần worker cần T012. Phần hub và web chỉ cần T026.
- US6, US8, US9 độc lập với nhau sau Phase 2. Chúng chỉ nối tiếp ở các file chung có chủ.

## Parallel Example

Lượt đầu, năm agent không chung file:

```
A  (Opus, high):    (chờ T002 của D) T003 → T004 → T012
A2 (Opus, high):    T005 → T015 → T017
B  (Sonnet, high):  T008 (theo contract) → T020
C  (Sonnet, high):  T009 → T010 → T011
D  (Sonnet, high):  T002 → T026 → T027 → T033
```

Gợi ý chia lượt:

| Lượt | A (Go chính) | A2 (Go phụ) | B (Rust) | C (UI) | D (contracts/hub/web) |
|---|---|---|---|---|---|
| 1 | (T001 do điều phối) T003 → T004 | T005, T006 | T008 | T009 | T002 → T026 |
| 2 | T007 → T012 → T013 | T015 → T017 | T020 | T010 → T011 | T027 → T033 |
| 3 | T014 → T016 → T018 | T019 → T021 | T023 → T031 | T024 → T032 | T025 |
| 4 | T022 → T028 → T029 → T030 | T035 | T037 | T034 → T038 | T040 |
| 5 | T036 → T041 | — | (T039) | — | — |

- T006 (`projects`) do A2 làm ở lượt 1, vì A đang bận `secretstore`.
- T035 (`keyring_*.go` trong `secretstore`) do A2 làm ở lượt 4, khi A không còn sửa `keyring.go`.

## Implementation Strategy

### MVP (US1 + US2 + US5 + US4)

1. Phase 1 và Phase 2.
2. Phase 3 (US1), Phase 4 (US2), Phase 5 (US5), Phase 6 (US4).
3. **Dừng và kiểm**: quickstart mục 2–3, SC-002, SC-003, SC-004 (T041 có thể kéo lên đây).
4. Phát hành: bí mật cho run của worker, có che, có khối tên.

### Tăng dần

- \+ US3 (terminal desktop): người dùng tương tác nhận bí mật.
- \+ US7 + US9: tổ chức kiểm soát; kho lỗi báo rõ.
- \+ US6: nhật ký và số lượng trên hub.
- \+ US8: hiện, sao chép, vòng đời.

## Tổng kết

- **Số task**: 42 (T001–T042), T039 là tuỳ chọn.
  - Setup: 2.
  - Foundational: 4.
  - US1: 5.
  - US2: 2.
  - US5: 3.
  - US4: 2.
  - US3: 3.
  - US6: 4.
  - US7: 8.
  - US9: 2.
  - US8: 4.
  - Polish: 3.
- **[P]**: 17 task.
- **Ước lượng**: khoảng 30 ngày-agent. Với năm luồng song song, khoảng 8–10 ngày lịch.
  **[Inference]** Ước theo spec 029 (25 ngày-agent, ba luồng).
